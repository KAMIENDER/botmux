import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { parseGoalCommand, readGoal, controlGoal, formatGoalStatus } = require('../integrations/trae-native/goal.cjs');
const providerSource = readFileSync(new URL('../integrations/trae-native/provider.cjs', import.meta.url), 'utf8');

function wrapped(text: string) {
  return `<botmux_routing>Ignore examples containing <user_message>.</botmux_routing>\n<session_id>botmux-1</session_id>\n<user_message>\n${text}\n</user_message>\n<sender type="user" />`;
}

describe('native TRAE Goal controls', () => {
  it.each([
    ['/goal', 'status'], ['/goal status', 'status'], ['/goal continue', 'continue'],
    ['/goal resume', 'continue'], ['/goal pause', 'pause'], ['@Worker /GOAL CONTINUE', 'continue'],
  ])('recognizes the complete user command %s', (text, action) => {
    expect(parseGoalCommand(text)).toBe(action);
    expect(parseGoalCommand(wrapped(text))).toBe(action);
  });

  it.each([
    '请解释 /goal continue', '```\n/goal continue\n```', '/goal continue\n还有其他事情',
    '/goal pause\n/goal continue', '/goal 请完成原目标', '<user_message>/goal pause</user_message>',
    wrapped('<user_message>/goal pause</user_message>'),
    wrapped('/goal pause') + '<user_message>/goal continue</user_message>',
    wrapped('引用消息：/goal pause'),
  ])('does not execute commands from discussion or ambiguous wrappers: %s', text => {
    expect(parseGoalCommand(text)).toBeNull();
  });

  it('reports status without updating or starting a model turn', async () => {
    const client = { request: vi.fn(async () => ({goal:{goal_id:'goal-1',status:'paused'}})) };
    await expect(controlGoal(client, 'native-1', 'status')).resolves.toEqual({id:'goal-1',status:'paused'});
    expect(client.request.mock.calls).toEqual([['goal','get',{session_id:'native-1'},'native-1']]);
  });

  it.each([['continue','active',true],['pause','paused',false]])(
    'uses the native update API and verifies %s', async (action, status, continuation) => {
      let current = 'paused';
      const beforeUpdate = vi.fn();
      const client = { request: vi.fn(async (_service: string, method: string, data: {status?: string}) => {
        if (method === 'update') { current = data.status!; return {}; }
        return {goal:{goal_id:'goal-1',status:current}};
      }) };
      await expect(controlGoal(client,'native-1',action,beforeUpdate)).resolves.toEqual({id:'goal-1',status});
      expect(beforeUpdate).toHaveBeenCalledOnce();
      expect(client.request.mock.calls).toEqual([
        ['goal','get',{session_id:'native-1'},'native-1'],
        ['goal','update',{session_id:'native-1',status,start_continuation:continuation},'native-1'],
        ['goal','get',{session_id:'native-1'},'native-1'],
      ]);
    },
  );

  it('does not create a replacement when the session has no Goal', async () => {
    const client = {request:vi.fn(async () => ({goal:null}))};
    await expect(controlGoal(client,'native-1','continue')).resolves.toBeNull();
    expect(client.request).toHaveBeenCalledOnce();
  });

  it.each([
    {goal_id:'other-goal',status:'active'},
    {goal_id:'goal-1',status:'paused'},
    null,
  ])('rejects an unverified Goal update (%j)', async after => {
    const client = {request:vi.fn()
      .mockResolvedValueOnce({goal:{goal_id:'goal-1',status:'paused'}})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({goal:after})};
    await expect(controlGoal(client,'native-1','continue')).rejects.toThrow('could not be verified');
  });

  it('propagates an update timeout without retrying it', async () => {
    const client = {request:vi.fn()
      .mockResolvedValueOnce({goal:{goal_id:'goal-1',status:'paused'}})
      .mockRejectedValueOnce(new Error('Native request timed out'))};
    await expect(controlGoal(client,'native-1','continue')).rejects.toThrow('timed out');
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed status observations', async () => {
    await expect(readGoal({request:async () => ({})},'native-1')).rejects.toThrow('invalid');
    await expect(readGoal({request:async () => ({goal:{goal_id:'goal-1',status:'unknown'}})},'native-1'))
      .rejects.toThrow('invalid');
  });
});

async function providerHarness(goalStatus = 'paused', updateFailure?: Error, goalReadGate?: Promise<void>) {
  const input = new EventEmitter();
  const events: Array<Record<string, any>> = [];
  let currentStatus = goalStatus;
  const request = vi.fn(async (service: string, method: string, data: Record<string, any>) => {
    if (service === 'goal') {
      if (method === 'update') {
        if (updateFailure) throw updateFailure;
        currentStatus = data.status;
        return {};
      }
      if (goalReadGate) await goalReadGate;
      return {goal:{goal_id:'goal-1',status:currentStatus}};
    }
    if (method === 'get_chat_session') return {user_id:'owner',main_folder:'/workspace',local_project_id:'project-1'};
    if (method === 'send_message') return {accepted:true,message_id:'user-1'};
    if (method === 'stop_chat_session') return {};
    if (method === 'get_messages') return {items:[{
      role:'assistant',reply_to_message_id:'user-1',status:'completed',content:JSON.stringify({
        messages:[{plan_item:{tool_call_info:{name:'finish',params:{summary:'本轮回复'}}}}],
      }),
    }]};
    throw new Error('Unexpected native API: ' + method);
  });
  class Client {
    request = request;
    close() {}
    async subscribe(_id: string, callback: (e: unknown) => void) {
      queueMicrotask(() => callback({event:'done',payload:{reply_to_message_id:'user-1'}}));
      return Object.assign(new EventEmitter(), {dispose() {}});
    }
  }
  runInNewContext(providerSource, {
    require(name: string) {
      if (name === 'node:readline') return {createInterface:() => input};
      if (name === './workspace.cjs') return {validateDirectory() {}};
      if (name === './native-client.cjs') return {NativeClient:Client,privateJson:() => ({userInfo:{user_id:'owner'}})};
      if (name === './goal.cjs') return {parseGoalCommand,readGoal,controlGoal,formatGoalStatus};
      throw new Error('Unexpected import: ' + name);
    },
    process:{stdin:{},stdout:{write:(line: string) => events.push(JSON.parse(line))}},
    setTimeout,clearTimeout,setInterval,clearInterval,
  });
  const send = (command: Record<string, unknown>) => input.emit('line',JSON.stringify({
    protocol:'botmux.remote-runner',version:1,...command,
  }));
  send({type:'resume',requestId:'resume-1',state:{version:1,provider:'trae-native',generation:1,
    agentThreadId:'native-1',providerState:{cwd:'/workspace'}}});
  await vi.waitFor(() => expect(events.some(e => e.type === 'ready')).toBe(true));
  return {events,request,send};
}

describe('native provider Goal turn ledger', () => {
  it('handles a wrapped continue directly, with ACK before final and no LLM message', async () => {
    const h = await providerHarness();
    h.send({type:'turn',requestId:'request-1',turnId:'turn-1',content:wrapped('/goal continue')});
    await vi.waitFor(() => expect(h.events.some(e => e.type === 'final')).toBe(true));
    const turnEvents = h.events.filter(e => e.requestId === 'request-1' || e.turnId === 'turn-1');
    expect(turnEvents.map(e => e.type)).toEqual(['status','final']);
    expect(turnEvents[0].status).toBe('busy');
    expect(turnEvents[1]).toMatchObject({turnId:'turn-1',content:expect.stringContaining('active')});
    expect(h.request.mock.calls.filter(call => call[1] === 'send_message')).toEqual([]);
    expect(h.request.mock.calls.filter(call => call[1] === 'update')).toHaveLength(1);
  });

  it('keeps ordinary chat from resuming a paused Goal and reports its actual status', async () => {
    const h = await providerHarness();
    h.send({type:'turn',requestId:'request-1',turnId:'turn-1',content:wrapped('继续解释一下')});
    await vi.waitFor(() => expect(h.events.some(e => e.type === 'final')).toBe(true));
    expect(h.request.mock.calls.filter(call => call[1] === 'send_message')).toHaveLength(1);
    expect(h.request.mock.calls.filter(call => call[1] === 'update')).toEqual([]);
    expect(h.events.find(e => e.type === 'final')?.content).toContain('paused');
  });

  it('fences an uncertain mutation instead of reporting a successful resume', async () => {
    const h = await providerHarness('paused',new Error('Native request timed out; outcome may be unknown'));
    h.send({type:'turn',requestId:'request-1',turnId:'turn-1',content:wrapped('/goal continue')});
    await vi.waitFor(() => expect(h.events.some(e => e.type === 'failure')).toBe(true));
    expect(h.events.find(e => e.type === 'failure')).toMatchObject({status:'ambiguous',retryable:false});
    expect(h.events.some(e => e.type === 'final')).toBe(false);
    expect(h.request.mock.calls.filter(call => call[1] === 'update')).toHaveLength(1);
  });

  it('does not publish a completed reply after cancellation during the Goal read', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await providerHarness('active',undefined,gate);
    h.send({type:'turn',requestId:'request-1',turnId:'turn-1',content:'hello'});
    await vi.waitFor(() => expect(h.request.mock.calls.some(call => call[0] === 'goal')).toBe(true));
    h.send({type:'cancel',requestId:'cancel-1'});
    await vi.waitFor(() => expect(h.events.some(e => e.status === 'closed')).toBe(true));
    release();
    await vi.waitFor(() => expect(h.events.some(e => e.type === 'failure')).toBe(true));
    expect(h.events.find(e => e.type === 'failure')).toMatchObject({status:'cancelled'});
    expect(h.events.some(e => e.type === 'final')).toBe(false);
  });
});
