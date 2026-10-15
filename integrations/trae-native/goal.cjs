'use strict';

// Goal control is an explicit user operation, never a side effect of ordinary
// chat, polling, reconnection or a model saying that it will continue.
function parseGoalCommand(content) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  if (text.startsWith('<botmux_routing>')) {
    const end = text.indexOf('</botmux_routing>');
    if (end < 0) return null;
    text = text.slice(end + '</botmux_routing>'.length);
  } else if (!text.startsWith('<session_id>')) {
    return parseCommandText(text);
  }
  const blocks = [...text.matchAll(/<user_message>([\s\S]*?)<\/user_message>/g)];
  if (blocks.length !== 1 || (text.match(/<user_message>/g) || []).length !== 1) return null;
  return parseCommandText(blocks[0][1].trim());
}

function parseCommandText(text) {
  const match = /^(?:@[^\s<>]+\s+)*\/goal(?:\s+(status|continue|resume|pause))?\s*$/i.exec(text);
  if (!match) return null;
  return match[1]?.toLowerCase() === 'resume' ? 'continue' : match[1]?.toLowerCase() || 'status';
}

async function readGoal(client, sessionId) {
  const result = await client.request('goal', 'get', {session_id:sessionId}, sessionId);
  if (!result || !Object.hasOwn(result, 'goal')) throw new Error('Native Goal response is invalid');
  if (result.goal === null) return null;
  const goal = result.goal;
  if (typeof goal?.goal_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(goal.goal_id)
      || !['active','paused','blocked'].includes(goal?.status)) {
    throw new Error('Native Goal identity or status is invalid');
  }
  return {id:goal.goal_id,status:goal.status};
}

function formatGoalStatus(goal) {
  if (!goal) return 'TRAE 当前会话没有原生 Goal。';
  const help = goal.status === 'active'
    ? 'Goal 已启用；本轮消息结束不代表目标完成。'
    : '自动续跑未启用；发送 /goal continue 明确恢复。';
  return `TRAE Goal：${goal.status}（${goal.id}）。${help}`;
}

async function controlGoal(client, sessionId, action, beforeUpdate = () => {}) {
  const before = await readGoal(client, sessionId);
  if (action === 'status' || !before) return before;
  if (!['continue','pause'].includes(action)) throw new Error('Unsupported native Goal action');
  const status = action === 'continue' ? 'active' : 'paused';
  beforeUpdate();
  // Updating status alone does not wake an idle Goal. The native handler's
  // start_continuation flag schedules it, or attaches context to a running turn.
  await client.request('goal', 'update', {
    session_id:sessionId,status,start_continuation:action === 'continue',
  }, sessionId);
  const after = await readGoal(client, sessionId);
  if (!after || after.id !== before.id || after.status !== status) {
    throw new Error('Native Goal changed or its requested status could not be verified');
  }
  return after;
}

module.exports = {parseGoalCommand,readGoal,formatGoalStatus,controlGoal};
