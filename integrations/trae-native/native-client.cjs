'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {NativeWorkspace} = require('./workspace.cjs');

const home = os.homedir();
const configDir = path.join(home, '.botmux', 'trae-native');
const silent = {info(){}, debug(){}, warn(){}, error(){}, trace(){}};

function privateJson(name) {
  const file = path.join(configDir, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Native configuration must be an owner-only regular file');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function discover() {
  const candidates = [];
  for (const pid of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
    try {
      const proc = '/proc/' + pid;
      if (fs.statSync(proc).uid !== process.getuid()) continue;
      const exe = fs.realpathSync(proc + '/exe');
      if (path.basename(exe) !== 'ai-agent' || !exe.includes('/.trae-cn-server/')) continue;
      const inodes = new Set(fs.readdirSync(proc + '/fd').flatMap(fd => {
        try {return fs.readlinkSync(proc + '/fd/' + fd).match(/^socket:\[(\d+)\]$/)?.slice(1) || [];}
        catch {return [];}
      }));
      const socket = fs.readFileSync(proc + '/net/unix', 'utf8').split('\n')
        .map(x => x.trim().split(/\s+/))
        .find(x => inodes.has(x[6]) && x[3] === '00010000' && x[7]?.endsWith('/aha/ai-agent.sock'))?.[7];
      if (socket && fs.statSync(socket).uid === process.getuid()) {
        candidates.push({pid: Number(pid), root: path.resolve(path.dirname(exe), '../..'), socket});
      }
    } catch {}
  }
  // Two native writers against different installations must never be guessed.
  if (candidates.length !== 1) throw new Error('Expected one owned native TRAE backend; found ' + candidates.length);
  return candidates[0];
}

async function bounded(promise, ms = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native request timed out; outcome may be unknown')), ms);
    })]);
  } finally {clearTimeout(timer);}
}

function unwrap(packet) {
  let value = packet?.params ?? packet;
  while (value && typeof value === 'object' && value.code !== undefined) {
    if (value.code !== 0) {
      const error = new Error('Native request failed with code ' + value.code + ': '
        + String(value.message || '').slice(0,200).replace(/eyJ[A-Za-z0-9_.-]+/g, '<redacted>'));
      error.nativeCode = value.code;
      throw error;
    }
    value = value.data;
  }
  return value;
}

function listFolder(args, folders) {
  const base = fs.realpathSync(args.path);
  if (!folders.some(x => base === fs.realpathSync(x) || base.startsWith(fs.realpathSync(x) + '/'))) {
    throw new Error('Folder is outside this session workspace');
  }
  const depth = Math.min(Math.max(Number(args.maxDepth) || 1, 1), 5);
  const limit = Math.min(Math.max(Number(args.maxResults) || 100, 1), 500);
  if (args.excludePattern?.length) throw new Error('Folder exclusion patterns are not supported');
  const result = [];
  let queue = [base];
  for (let level = 0; level < depth && queue.length && result.length < limit; level++) {
    const next = [];
    for (const folder of queue) {
      for (const item of fs.readdirSync(folder, {withFileTypes: true})) {
        if (result.length >= limit) break;
        const file = path.join(folder, item.name);
        const stat = fs.lstatSync(file);
        result.push({name:item.name, path:file, isFile:stat.isFile(), isDirectory:stat.isDirectory(),
          isSymbolicLink:stat.isSymbolicLink(), mtime:stat.mtimeMs, ctime:stat.ctimeMs, size:stat.size});
        if (stat.isDirectory() && !stat.isSymbolicLink() && !['.git', 'node_modules'].includes(item.name)) next.push(file);
      }
    }
    queue = next;
  }
  return {code:0, data:result};
}

class NativeClient {
  constructor({cwd, projectId, onUnsupported} = {}) {
    this.native = discover();
    this.runtime = privateJson('runtime.json');
    this.cwd = cwd;
    this.workspace = cwd ? new NativeWorkspace(cwd,this.native.root) : undefined;
    this.projectId = projectId;
    this.onUnsupported = onUnsupported;
    this.workspaces = new Map();
    const ipc = require(path.join(this.native.root, 'node_modules/@aha-kit/ipc'));
    const {Connection} = require(path.join(this.native.root, 'node_modules/@aha-kit/rpc'));
    ipc.setLogger(silent);
    this.connection = ipc.connect('ai-agent', {runtimeDir:path.dirname(path.dirname(this.native.socket))});
    this.sessionId = crypto.randomUUID();
    this.rpc = new Connection({
      send:data => this.connection.send(data),
      onData:listener => {this.connection.on('message',listener); return {dispose:() => this.connection.off('message',listener)};},
    }, {logger:silent});
    this.ready = bounded(new Promise((resolve, reject) => {
      this.connection.once('connect',resolve);
      this.connection.once('error',() => reject(new Error('Native connection failed')));
    }));
    this.rpc.onRequest('execute_command', packet => this.callback(packet));
  }

  async callback(packet) {
    const params = typeof packet.params === 'string' ? JSON.parse(packet.params) : packet.params;
    let value, error;
    try {
      const args = (params.args || []).map(x => typeof x === 'string' ? JSON.parse(x) : x);
      const runtime = privateJson('runtime.json');
      switch (params.command_id) {
        case 'icube.common.getDynamicConfig': value = runtime.dynamicConfig; break;
        case 'icube.common.commands.tooling.registerSessionWorkspace': {
          const binding = args[0]; const uri = new URL(binding.workspaceUri);
          const folder = decodeURIComponent(uri.pathname);
          if (!binding.sessionId || uri.protocol !== 'vscode-remote:' || !decodeURIComponent(uri.hostname).startsWith('ssh-remote+') || !this.workspace?.matchesFolder(folder)) {
            throw new Error('Uninitialized remote workspace');
          }
          this.workspaces.set(binding.sessionId, binding.workspaceUri);
          value = true; break;
        }
        case 'icube.common.commands.tooling.getConfigurationValue': {
          const key = args[0]?.key;
          // Earlier bootstrap snapshots predate these two globally scoped keys.
          // Their defaults are pinned to the installed TRAE 3.4.2 schema.
          const defaults = {'AI.rules.importAgentsMd':true,'AI.rules.importClaudeMd':false};
          if (Object.hasOwn(runtime.configuration || {}, key)) value = runtime.configuration[key];
          else if (Object.hasOwn(defaults,key)) value = {code:0,data:defaults[key]};
          else throw new Error('Unknown native configuration key');
          break;
        }
        case 'icube.common.commands.tooling.getRulesDetails':
          if (!this.workspace) throw new Error('Native session has no workspace');
          value = this.workspace.rules(args[0],runtime); break;
        case 'icube.common.commands.tooling.listFolder':
          value = listFolder(args[0], this.workspace ? [this.workspace.cwd] : []); break;
        case 'icube.common.commands.tooling.getTerminalContributedEnv':
          value = {code:0,data:{env:Object.fromEntries([
            'PATH','BOTMUX_SESSION_ID','BOTMUX_CHAT_ID','BOTMUX_CHAT_TYPE','BOTMUX_LARK_APP_ID',
            'BOTMUX_ROOT_MESSAGE_ID','BOTMUX_SESSION_SCOPE','SESSION_DATA_DIR','BOTS_CONFIG',
          ].filter(key => process.env[key] !== undefined).map(key => [key,process.env[key]]))}}; break;
        default:
          // File/Shell tools run in the native agent-tool-host. Never execute
          // arbitrary VSCode command IDs or invent a successful tool response.
          this.onUnsupported?.(params.command_id);
          throw new Error('Unsupported desktop callback');
      }
    } catch {
      error = 'Headless adapter cannot handle ' + String(params.command_id);
    }
    return {results:{stream_id:packet.channel_id, msg_type:'execute_command_result',
      ...(error ? {error} : {}), payload:JSON.stringify(value ?? null)},
      base_resp:{status_message:'ok',status_code:0,extra:null}};
  }

  envelope(service, method, data, sessionId) {
    const auth = privateJson('auth.json');
    if (!Number.isFinite(Date.parse(auth.expiresAt)) || Date.parse(auth.expiresAt) <= Date.now()) throw new Error('Native TRAE login expired; initialize again');
    return {packet_type:'request',channel_id:crypto.randomUUID(),session_id:this.sessionId,
      params:{service,method,data,user_info:auth.userInfo,
        client_info:{connect_session_id:this.sessionId,device_id:this.runtime.deviceId,icube_language:'zh-CN',
          client_type:'ide',window_type:'solo-lite',is_solo_mode:true,workspace_folder:this.cwd,
          workspace_folders:this.cwd ? [this.cwd] : [],chat_session_id:sessionId,project_id:this.projectId},
        common_params:{},streamlined_common_params:{}}};
  }

  async request(service, method, data = {}, sessionId) {
    await this.ready;
    return unwrap(await bounded(this.rpc.sendRequest('request',this.envelope(service,method,data,sessionId))));
  }

  async subscribe(sessionId, onEvent) {
    await this.ready;
    const stream = await bounded(this.rpc.sendStreamRequest('request_stream',
      this.envelope('lite','subscribe_events',{chat_session_id:sessionId},sessionId)));
    stream.on('data',packet => {try {onEvent(unwrap(packet));} catch {onEvent({event:'adapter_error'});}});
    stream.on('error',() => onEvent({event:'adapter_error'}));
    return stream;
  }

  close() {if (this.closed) return; this.closed=true; this.rpc.dispose(); this.connection.disconnect();}
}
module.exports = {NativeClient,discover,privateJson,bounded};
