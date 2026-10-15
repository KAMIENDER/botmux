#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const {validateDirectory} = require('./workspace.cjs');
const {NativeClient,privateJson} = require('./native-client.cjs');
const {parseGoalCommand,readGoal,formatGoalStatus,controlGoal} = require('./goal.cjs');

const protocol = 'botmux.remote-runner';
const version = 1;
const provider = 'trae-native';
const capabilities = ['start','resume','turn','cancel','detach','reattach','status','concurrent_turns','session_activity'];
let client, state, status = 'starting', unknownAcceptance = false;
const activeTurns = new Map(), unsettledMessageIds = new Set();
const emit = event => process.stdout.write(JSON.stringify({protocol,version,...event}) + '\n');
const items = data => data?.items || data?.sessions || data?.projects || [];
const fail = (command, message, ambiguous = false) => emit({type:'failure', requestId:command?.requestId,
  turnId:command?.turnId,code:ambiguous ? 'native_outcome_unknown' : 'native_adapter_error',
  message,status:ambiguous ? 'ambiguous' : 'failed',retryable:false});

async function nativeReply(sessionId, messageId) {
  const history = await client.request('lite','get_messages',{chat_session_id:sessionId,page_size:100},sessionId);
  return items(history).findLast(x => x.role === 'assistant' && x.reply_to_message_id === messageId);
}

function terminalReply(reply) {
  return ['completed','canceled','cancelled'].includes(reply?.status);
}

async function publishNativeFinal(command, reply) {
  const content = typeof reply.content === 'string' ? JSON.parse(reply.content) : reply.content;
  const summary = content?.messages?.findLast(x => x.plan_item?.tool_call_info?.name === 'finish')
    ?.plan_item.tool_call_info.params?.summary;
  if (!summary) throw new Error('Native turn completed without a text summary');
  let goalNote;
  try {
    const goal = await readGoal(client,state.agentThreadId);
    if (goal) goalNote = formatGoalStatus(goal);
  } catch {
    goalNote = 'TRAE 原生 Goal 状态未能核验；本轮回复不代表 Goal 已恢复。';
  }
  if (command.cancelSettled) await command.cancelSettled;
  if (command.cancelled || status === 'closed') throw new Error('Native turn was cancelled');
  unsettledMessageIds.delete(reply.reply_to_message_id);
  status = unknownAcceptance || unsettledMessageIds.size ? 'error' : activeTurns.size > 1 ? 'busy' : 'ready';
  emit({type:'final',turnId:command.turnId,content:goalNote ? `${summary}\n\n${goalNote}` : summary,state});
}

async function recoverSettledTurn() {
  if (status !== 'error' || !unsettledMessageIds.size) return;
  // A new user input may proceed after every exact uncertain reply is durably
  // terminal. Never replay the old request or unlock on session-level status.
  for (const id of unsettledMessageIds) {
    if (terminalReply(await nativeReply(state.agentThreadId,id))) unsettledMessageIds.delete(id);
  }
  if (!unknownAcceptance && !unsettledMessageIds.size) status = activeTurns.size ? 'busy' : 'ready';
}

async function pageAll(method, fields = {}) {
  let token;
  const result = [];
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const data = await client.request('lite',method,{...fields,page_size:100,...(token ? {page_token:token} : {})});
    result.push(...items(data));
    const next = data?.next_page_token;
    if (!next) return result;
    if (seen.has(next)) throw new Error('Repeated native page cursor');
    seen.add(next); token = next;
  }
  throw new Error('Native list exceeded page limit');
}

async function setup(command) {
  if (activeTurns.size) throw new Error('A native turn is already running');
  client?.close();
  const previous = command.type === 'resume' ? command.state : undefined;
  if (previous && (previous.provider !== provider || previous.version !== version
      || !previous.agentThreadId || !previous.providerState?.cwd)) {
    throw new Error('Cannot resume foreign or incomplete native state');
  }
  const cwd = previous?.providerState.cwd || command.cwd;
  validateDirectory(cwd);
  client = new NativeClient({cwd,projectId:previous?.providerState.projectId});
  let native;
  if (previous) {
    native = await client.request('lite','get_chat_session',{chat_session_id:previous.agentThreadId},previous.agentThreadId);
  } else {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(command.sessionId || '')) throw new Error('Invalid Botmux session ID');
    let binding;
    try {binding = privateJson('bindings/' + command.sessionId + '.json');}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (binding) {
      if (binding.version !== 1 || binding.cwd !== cwd) throw new Error('Native binding folder mismatch');
      native = await client.request('lite','get_chat_session',{chat_session_id:binding.nativeSessionId},binding.nativeSessionId);
    } else {
      const projects = await pageAll('list_projects_v2');
      const project = projects.find(x => x.single_root_workspace_folder === cwd)
        || await client.request('lite','get_or_create_project_v2',{
          project_kind:'workspace',workspace_type:'single_root',
          single_root_workspace_folder:cwd,workspace_folders:[cwd],
        });
      client.projectId = project.project_id || project.local_project_id;
      const sessions = await pageAll('list_chat_sessions');
      const template = sessions.find(x => (x.main_folder || x.source?.local_folder || x.extra?.folder) === cwd && x.extra?.workspace_kind === 'ssh')
        || sessions.find(x => x.extra?.workspace_kind === 'ssh');
      if (!template?.extra) throw new Error('Create one TRAE Remote SSH task in this folder to establish its SSH project identity');
      const uri = new URL(template.extra.workspace_uri); uri.pathname = cwd;
      const extra = {...template.extra,folder:cwd,workspace_uri:uri.toString()};
      native = await client.request('lite','create_chat_session',{
        local_project_id:project.project_id || project.local_project_id,
        source:{type:'local',repo_url:'',local_folder:cwd,remote_folder:cwd},extra,
      });
      native = await client.request('lite','get_chat_session',{chat_session_id:native.chat_session_id},native.chat_session_id);
    }
  }
  if (native.user_id !== privateJson('auth.json').userInfo.user_id || native.main_folder !== cwd) {
    throw new Error('Native session belongs to another account or folder');
  }
  client.projectId = native.local_project_id;
  state = {version,provider,generation:previous
      ? previous.generation + (command.resumeMode === 'rebuild' ? 1 : 0) : 1,
    remoteSessionId:native.chat_session_id,agentThreadId:native.chat_session_id,
    providerState:{cwd,projectId:native.local_project_id,model:command.model || previous?.providerState.model,
      reasoningEffort:command.reasoningEffort || previous?.providerState.reasoningEffort}};
  status = 'ready';
  emit({type:'lineage_changed',state});
  emit({type:'ready',requestId:command.requestId,state});
}

function modelParameters() {
  const selected = state.providerState.model || 'gpt-6.1-sol';
  // Keep case-sensitive native catalog IDs (e.g. Dola-Seed-2.0-Code). Older
  // dashboard GPT display labels still map to their lowercase native IDs.
  const model = /^gpt-/i.test(selected) ? selected.toLowerCase() : selected;
  return {model_name:model,agent_type:'solo_agent',agent_id:'solo_agent',model_selection_strategy:'manual',
    custom_model:{config_name:model,model_name:model,config_source:1,is_preset:true,
      use_remote_service:true,multimodal:true,reasoning_effort:state.providerState.reasoningEffort || 'high'}};
}

async function runTurn(command) {
  let accepted = false, sendAttempted = false, rejected = false, sent, stream, historyTimer, deadlineTimer, finished = false;
  let verifiedReply;
  let sid = state.agentThreadId;
  const predecessors = [...activeTurns.values()];
  activeTurns.set(command.turnId,command);
  let settleAcceptance;
  command.acceptanceSettled = new Promise(resolve => {settleAcceptance = resolve;});
  status = 'busy';
  command.cancelled = false;
  try {
    await Promise.all(predecessors.map(turn => turn.acceptanceSettled));
    if (status === 'closed' || unknownAcceptance || unsettledMessageIds.size) throw new Error('Prior native input has not settled');
    const goalAction = parseGoalCommand(command.content);
    if (goalAction) {
      // Keep the structured turn ACK/final ledger, but do not send a control
      // command to the model or synthesize a persisted native assistant reply.
      const goal = await controlGoal(client,sid,goalAction,() => {sendAttempted = true;});
      settleAcceptance();
      emit({type:'status',requestId:command.requestId,status:'busy',state});
      emit({type:'final',turnId:command.turnId,content:formatGoalStatus(goal),state});
      return;
    }
    // Never replay an accepted request after a timeout: the backend may have
    // executed tools even when the transport lost its acknowledgement.
    const content = command.content;
    sendAttempted = true;
    sent = await client.request('lite','send_message',{
      chat_session_id:sid,content:[{type:'text',text_content:content}],
      // Native send_message appends into its active inbox unless forced new.
      // Its accepted/message_id/from_append_msg receipt is our delivery proof.
      force_new_turn:false,...modelParameters(),workspace_folders:[state.providerState.cwd],
    },sid);
    if (sent?.accepted === false) {
      rejected = true;
      throw new Error('Native backend did not accept the turn');
    }
    if (sent?.accepted !== true || !sent.message_id) throw new Error('Native acceptance could not be verified');
    accepted = true;
    settleAcceptance();
    emit({type:'status',requestId:command.requestId,status:'busy',state});
    const thoughts = new Map();
    const done = new Promise((resolve,reject) => {
      deadlineTimer = setTimeout(() => reject(new Error('Native turn exceeded adapter deadline')), 60 * 60 * 1000);
      let checking = false;
      const checkHistory = async () => {
        if (checking || finished) return;
        checking = true;
        try {
          const reply = await nativeReply(sid,sent.message_id);
          if (terminalReply(reply)) {
            verifiedReply = reply;
            clearTimeout(deadlineTimer);
            if (reply.status === 'completed') resolve();
            else reject(new Error('Native turn was cancelled'));
          }
        } catch (error) {clearTimeout(deadlineTimer);reject(error);}
        finally {checking = false;}
      };
      historyTimer = setInterval(checkHistory,10000);
      client.subscribe(sid,event => {
        if (finished) return;
        const payload = event?.payload;
        if (payload?.reply_to_message_id && payload.reply_to_message_id !== sent.message_id) return;
        if (event?.event === 'adapter_error') {void checkHistory();return;}
        if (event?.event === 'plan_item') {
          if (payload?.thought) {
            const previous = thoughts.get(payload.id) || '';
            const delta = payload.thought.startsWith(previous) ? payload.thought.slice(previous.length) : payload.thought;
            thoughts.set(payload.id,payload.thought);
            if (delta) emit({type:'progress',turnId:command.turnId,content:delta});
          }
        }
        // done/error can belong to another frontend, arrive before persistence,
        // or describe a normal cancellation. Only our persisted reply settles
        // this turn; polling also survives a lost or closed event subscription.
        if (event?.event === 'done' || event?.event === 'error') void checkHistory();
      }).then(value => {
        if (finished) {value.dispose?.();return;}
        stream=value;
        stream.on('end',() => {void checkHistory();});},() => {void checkHistory();});
    });
    await done;
    // Both frontends can subscribe to this session. Trust only the persisted
    // assistant reply to our exact message ID, never another client's finish.
    verifiedReply ||= await nativeReply(sid,sent.message_id);
    if (verifiedReply?.status !== 'completed') throw new Error('Cannot verify the native reply for this turn');
    await publishNativeFinal(command,verifiedReply);
  } catch (error) {
    settleAcceptance();
    if (command.cancelSettled) await command.cancelSettled;
    if (!command.cancelled && accepted && !terminalReply(verifiedReply)) {
      // A transport failure alone does not establish execution outcome. One
      // final read can recover a completed/cancelled reply without replaying it.
      try {verifiedReply = await nativeReply(sid,sent.message_id);} catch {}
    }
    if (command.cancelled) {
      emit({type:'failure',requestId:command.requestId,turnId:command.turnId,
        code:'native_cancelled',message:'Native turn cancelled',status:'cancelled',retryable:false});
    } else if (terminalReply(verifiedReply)) {
      if (verifiedReply.status === 'completed') {
        try {await publishNativeFinal(command,verifiedReply);return;}
        catch (replyError) {error=replyError;}
      }
      const cancelled = verifiedReply.status !== 'completed';
      unsettledMessageIds.delete(sent.message_id);
      status = unknownAcceptance || unsettledMessageIds.size ? 'error' : activeTurns.size > 1 ? 'busy' : 'ready';
      emit({type:'failure',requestId:command.requestId,turnId:command.turnId,
        code:cancelled ? 'native_cancelled' : 'native_reply_invalid',
        message:cancelled ? 'TRAE 已取消本轮；原会话保留，可以发送新消息继续。' : error.message,
        status:cancelled ? 'cancelled' : 'failed',retryable:false});
    } else {
      const ambiguous = accepted || (sendAttempted && !rejected && !error.nativeCode)
        || /timed out/.test(error.message);
      if (ambiguous && accepted) unsettledMessageIds.add(sent.message_id);
      if (ambiguous && !accepted) unknownAcceptance = true;
      status = ambiguous || unknownAcceptance || unsettledMessageIds.size ? 'error' : activeTurns.size > 1 ? 'busy' : 'ready';
      fail(command,error.message,ambiguous);
    }
  } finally {
    finished = true;
    clearTimeout(deadlineTimer);
    clearInterval(historyTimer);
    stream?.dispose?.();
    activeTurns.delete(command.turnId);
    if (status !== 'closed' && status !== 'detached') {
      status = unknownAcceptance || unsettledMessageIds.size || status === 'error' ? 'error' : activeTurns.size ? 'busy' : 'ready';
    }
  }
}

async function handle(command) {
  if (command.protocol !== protocol || command.version !== version) throw new Error('Expected botmux.remote-runner v1');
  switch (command.type) {
    case 'hello': emit({type:'hello',requestId:command.requestId,provider,capabilities}); break;
    case 'start': case 'resume': await setup(command); break;
    case 'turn':
      if (state) await recoverSettledTurn();
      if (!state || !['ready','busy'].includes(status) || activeTurns.size >= 32) throw new Error('Native session is not ready');
      void runTurn(command); break;
    case 'cancel': {
      if (!state) throw new Error('No native session');
      const turns = [...activeTurns.values()], settleCancels = [];
      // Stop must follow every send_message acknowledgement, including native
      // inbox appends, so no accepted input can start after close is confirmed.
      for (const turn of turns) {
        turn.cancelSettled = new Promise(resolve => {settleCancels.push(resolve);});
      }
      await Promise.all(turns.map(turn => turn.acceptanceSettled));
      try {
        await client.request('lite','stop_chat_session',{chat_session_id:state.agentThreadId},state.agentThreadId);
        for (const turn of turns) turn.cancelled = true;
        // Closing admission preserves native history for TRAE and rebuild.
        status = 'closed';
        emit({type:'status',requestId:command.requestId,status,state});
      } finally {for (const settle of settleCancels) settle();}
      break;
    }
    case 'detach':
      // Detachment leaves the native conversation and server alive.
      if (!state || activeTurns.size) throw new Error('Settle the native turn before detaching');
      status = 'detached';emit({type:'status',requestId:command.requestId,status,state});break;
    case 'reattach':
      if (!state || activeTurns.size) throw new Error('Native session cannot reattach yet');
      await recoverSettledTurn();
      if (unknownAcceptance || unsettledMessageIds.size) throw new Error('Native outcome is still unknown');
      status = 'ready';emit({type:'status',requestId:command.requestId,status,state});break;
    case 'status': {
      let observedStatus = status;
      if (state && ['ready','busy'].includes(status)) {
        const native = await client.request('lite','get_chat_session',{
          chat_session_id:state.agentThreadId,
        },state.agentThreadId);
        // Native status 3 is running, including autonomous Goal turns that
        // have no Botmux-owned input. A final reply is not session-level idle.
        observedStatus = activeTurns.size || native.status === 3 ? 'busy' : 'ready';
      }
      emit({type:'status',requestId:command.requestId,status:observedStatus,state});break;
    }
    default:throw new Error('Unsupported runner command');
  }
}

const input = readline.createInterface({input:process.stdin,crlfDelay:Infinity});
let queue = Promise.resolve();
input.on('line',line => {
  if (line.length > 4 * 1024 * 1024) {fail(undefined,'Runner command exceeds size limit');return;}
  let command;
  try {command=JSON.parse(line);} catch {fail(undefined,'Invalid runner JSON');return;}
  queue = queue.then(() => handle(command)).catch(error => fail(command,error.message));
});
input.on('close',() => {
  // A worker may close stdin while the native turn still needs callbacks.
  // Keep this client alive until that turn terminates.
  const close = () => {
    if (activeTurns.size) {setTimeout(close,1000);return;}
    client?.close();setTimeout(() => process.exit(),200);
  };
  void queue.finally(close);
});
