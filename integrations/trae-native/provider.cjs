#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const {validateDirectory} = require('./workspace.cjs');
const {NativeClient,privateJson} = require('./native-client.cjs');

const protocol = 'botmux.remote-runner';
const version = 1;
const provider = 'trae-native';
const capabilities = ['start','resume','turn','cancel','detach','reattach','status'];
let client, state, status = 'starting', activeTurn;
const emit = event => process.stdout.write(JSON.stringify({protocol,version,...event}) + '\n');
const items = data => data?.items || data?.sessions || data?.projects || [];
const fail = (command, message, ambiguous = false) => emit({type:'failure', requestId:command?.requestId,
  turnId:command?.turnId,code:ambiguous ? 'native_outcome_unknown' : 'native_adapter_error',
  message,status:ambiguous ? 'ambiguous' : 'failed',retryable:false});

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
  if (activeTurn) throw new Error('A native turn is already running');
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
  const model = (state.providerState.model || 'gpt-6.1-sol').toLowerCase();
  return {model_name:model,agent_type:'solo_agent',agent_id:'solo_agent',model_selection_strategy:'manual',
    custom_model:{config_name:model,model_name:model,config_source:1,is_preset:true,
      use_remote_service:true,multimodal:true,reasoning_effort:state.providerState.reasoningEffort || 'high'}};
}

async function runTurn(command) {
  let accepted = false, sendAttempted = false, rejected = false, sent, stream, historyTimer, finished = false;
  let sid = state.agentThreadId;
  activeTurn = command;
  let settleAcceptance;
  command.acceptanceSettled = new Promise(resolve => {settleAcceptance = resolve;});
  status = 'busy';
  command.cancelled = false;
  emit({type:'status',requestId:command.requestId,status,state});
  try {
    // Never replay an accepted request after a timeout: the backend may have
    // executed tools even when the transport lost its acknowledgement.
    const content = command.content;
    sendAttempted = true;
    sent = await client.request('lite','send_message',{
      chat_session_id:sid,content:[{type:'text',text_content:content}],
      ...modelParameters(),workspace_folders:[state.providerState.cwd],
    },sid);
    if (sent?.accepted === false) {
      rejected = true;
      throw new Error('Native backend did not accept the turn');
    }
    if (sent?.accepted !== true || !sent.message_id) throw new Error('Native acceptance could not be verified');
    accepted = true;
    settleAcceptance();
    let finalSummary = '';
    const thoughts = new Map();
    const done = new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('Native turn exceeded adapter deadline')), 60 * 60 * 1000);
      let checking = false;
      historyTimer = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          const history = await client.request('lite','get_messages',{chat_session_id:sid,page_size:100},sid);
          const reply = items(history).findLast(x => x.role === 'assistant' && x.reply_to_message_id === sent.message_id);
          if (reply?.status === 'completed') {clearTimeout(timer);resolve();}
        } catch (error) {clearTimeout(timer);reject(error);}
        finally {checking = false;}
      },10000);
      client.subscribe(sid,event => {
        if (finished) return;
        const payload = event?.payload;
        if (payload?.reply_to_message_id && payload.reply_to_message_id !== sent.message_id) return;
        if (event?.event === 'adapter_error') {clearTimeout(timer);reject(new Error('Native stream disconnected'));return;}
        if (event?.event === 'plan_item') {
          if (payload?.thought) {
            const previous = thoughts.get(payload.id) || '';
            const delta = payload.thought.startsWith(previous) ? payload.thought.slice(previous.length) : payload.thought;
            thoughts.set(payload.id,payload.thought);
            if (delta) emit({type:'progress',turnId:command.turnId,content:delta});
          }
          if (payload?.tool_call_info?.name === 'finish') finalSummary = payload.tool_call_info.params?.summary || '';
        }
        if (event?.event === 'done') {
          clearTimeout(timer);
          if (payload?.status !== 'completed') reject(new Error('Native turn did not complete'));
          else resolve();
        }
        if (event?.event === 'error') {clearTimeout(timer);reject(new Error('Native execution failed'));}
      }).then(value => {
        if (finished) {value.dispose?.();return;}
        stream=value;
        stream.on('end',() => {clearTimeout(timer);reject(new Error('Native stream ended before a verified completion'));});},error => {clearTimeout(timer);reject(error);});
    });
    await done;
    // Both frontends can subscribe to this session. Trust only the persisted
    // assistant reply to our exact message ID, never another client's finish.
    const history = await client.request('lite','get_messages',{chat_session_id:sid,page_size:100},sid);
    const assistant = items(history).findLast(x => x.role === 'assistant' && x.reply_to_message_id === sent.message_id);
    if (assistant?.status !== 'completed') throw new Error('Cannot verify the native reply for this turn');
    const verified = typeof assistant.content === 'string' ? JSON.parse(assistant.content) : assistant.content;
    finalSummary = verified?.messages?.findLast(x => x.plan_item?.tool_call_info?.name === 'finish')
      ?.plan_item.tool_call_info.params?.summary || '';
    if (!finalSummary) throw new Error('Native turn completed without a text summary');
    status = 'ready';
    emit({type:'final',turnId:command.turnId,content:finalSummary,state});
  } catch (error) {
    settleAcceptance();
    if (command.cancelSettled) await command.cancelSettled;
    if (command.cancelled) {
      emit({type:'failure',requestId:command.requestId,turnId:command.turnId,
        code:'native_cancelled',message:'Native turn cancelled',status:'cancelled',retryable:false});
    } else {
      const ambiguous = accepted || (sendAttempted && !rejected && !error.nativeCode)
        || /timed out/.test(error.message);
      status = ambiguous ? 'error' : 'ready';
      fail(command,error.message,ambiguous);
    }
  } finally {
    finished = true;
    clearInterval(historyTimer);
    stream?.dispose?.();
    activeTurn = undefined;
  }
}

async function handle(command) {
  if (command.protocol !== protocol || command.version !== version) throw new Error('Expected botmux.remote-runner v1');
  switch (command.type) {
    case 'hello': emit({type:'hello',requestId:command.requestId,provider,capabilities}); break;
    case 'start': case 'resume': await setup(command); break;
    case 'turn':
      if (!state || status !== 'ready' || activeTurn) throw new Error('Native session is not ready');
      void runTurn(command); break;
    case 'cancel': {
      if (!state) throw new Error('No native session');
      const turn = activeTurn;
      let settleCancel;
      if (turn) {
        // Stop must follow send_message's acknowledgement; otherwise a late
        // accepted message could start after the close acknowledgement.
        turn.cancelSettled = new Promise(resolve => {settleCancel = resolve;});
        await turn.acceptanceSettled;
      }
      try {
        await client.request('lite','stop_chat_session',{chat_session_id:state.agentThreadId},state.agentThreadId);
        if (turn) turn.cancelled = true;
        // Closing admission preserves native history for TRAE and rebuild.
        status = 'closed';
        emit({type:'status',requestId:command.requestId,status,state});
      } finally {settleCancel?.();}
      break;
    }
    case 'detach':
      // Detachment leaves the native conversation and server alive.
      if (!state || activeTurn) throw new Error('Settle the native turn before detaching');
      status = 'detached';emit({type:'status',requestId:command.requestId,status,state});break;
    case 'reattach':
      if (!state || activeTurn) throw new Error('Native session cannot reattach yet');
      status = 'ready';emit({type:'status',requestId:command.requestId,status,state});break;
    case 'status':emit({type:'status',requestId:command.requestId,status,state});break;
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
    if (activeTurn) {setTimeout(close,1000);return;}
    client?.close();setTimeout(() => process.exit(),200);
  };
  void queue.finally(close);
});
