#!/usr/bin/env node
'use strict';
// A configured Codex-compatible executable; Botmux still owns the runner on SG.
// Only JSON-RPC and model metadata cross the private SSH Unix-socket tunnel.
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const WebSocket = require(config.wsModule);
const args = process.argv.slice(3);
const metadata = args.length === 1 && args[0] === '--version' ? 'version'
  : args.join(' ') === 'debug models' ? 'models' : null;
if (!metadata && !(args[0] === 'app-server' && args.slice(1).every((a,i,rest) =>
    a === '--listen' || (a === 'stdio://' && rest[i-1] === '--listen')))) {
  console.error('codex-node: only app-server --listen stdio://, --version and debug models are supported');
  process.exit(2);
}
const MAX_BYTES = 16 * 1024 * 1024;
const pending = [];
let pendingBytes = 0, buffer = '', closing = false, opened = false;
const startedAt = Date.now();
function fail(reason) {
  if (closing) return;
  closing = true;
  console.error('codex-node: ' + reason);
  process.exitCode = 1;
  ws.terminate();
  process.stdin.pause();
  clearInterval(watchdog);
}
const parentStat = fs.statSync(path.dirname(config.socket));
if (parentStat.uid !== process.getuid() || (parentStat.mode & 0o077)) {
  console.error('codex-node: tunnel directory must be private and owned by the current user');
  process.exit(2);
}
const ws = new WebSocket('ws+unix://' + config.socket, {maxPayload:MAX_BYTES, handshakeTimeout:8000});
const watchdog = setInterval(() => {
  if ((!opened || metadata) && Date.now() - startedAt > 10000) fail('Mac connection timed out');
}, 1000);
function mappedCwd(cwd, outgoing) {
  if (typeof cwd !== 'string') return cwd;
  const from = path.posix.normalize(outgoing ? config.localWorkspace : config.remoteWorkspace);
  const to = path.posix.normalize(outgoing ? config.remoteWorkspace : config.localWorkspace);
  // Normalize before the boundary check so '..' cannot escape the mapping root.
  const normalized = path.posix.normalize(cwd);
  if (normalized === from || normalized.startsWith(from + '/')) return to + normalized.slice(from.length);
  if (outgoing) throw new Error('workspace is outside the configured Mac node mapping');
  return cwd;
}
function mapCwds(value, outgoing) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v=>mapCwds(v,outgoing));
  const result={};
  for (const [key,v] of Object.entries(value)) {
    result[key]=key === 'cwd' ? mappedCwd(v,outgoing) : mapCwds(v,outgoing);
  }
  return result;
}
const REMOTE_NOTE = [
  'Execution host: Mac. The real working directory is ' + config.remoteWorkspace + '.',
  'Botmux routing and schedules are owned by SG; the assistant final reply is forwarded automatically.',
  'There is no Botmux installation on this Mac. Do not claim local botmux shell helpers are available.',
  'Do not run SG filesystem paths or use a second app-server to steal an active desktop thread.',
].join('\n');
function translateRequest(message) {
  const mapped = mapCwds(message,true);
  // Append a host fact to new threads; leave existing thread developer state alone.
  if (mapped.method === 'thread/start') {
    mapped.params ||= {};
    mapped.params.developerInstructions =
      (mapped.params.developerInstructions || '') + '\n\n' + REMOTE_NOTE;
  }
  // Native remote Codex cannot read image files stored on SG. Transfer bytes in
  // the supported image input instead of sending an unusable SG filename.
  if (Array.isArray(mapped.params?.input)) {
    mapped.params.input=mapped.params.input.map(item=>{
      if (item.type !== 'localImage') return item;
      const imagePath=fs.realpathSync(item.path);
      const allowed=fs.realpathSync(config.attachmentRoot) + '/';
      if (!imagePath.startsWith(allowed)) throw new Error('image is outside the Botmux attachment root');
      const imageStat=fs.statSync(imagePath);
      if (!imageStat.isFile() || imageStat.size > 8*1024*1024) throw new Error('image exceeds the remote transport limit');
      const data=fs.readFileSync(imagePath);
      if (data.length > 8*1024*1024) throw new Error('image exceeds the remote transport limit');
      const ext=path.extname(imagePath).toLowerCase();
      const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'}[ext];
      if (!mime) throw new Error('unsupported remote image format');
      return {type:'image',url:'data:'+mime+';base64,'+data.toString('base64')};
    });
  }
  return mapped;
}
function sendLine(line) {
  if (!line.trim()) return;
  let message;
  try {message=translateRequest(JSON.parse(line));}
  catch {fail('invalid request or unsupported remote path');return;}
  const data=JSON.stringify(message);
  if (Buffer.byteLength(data)>MAX_BYTES) {fail('request exceeds transport limit');return;}
  if (opened) ws.send(data);
  else {
    pending.push(data); pendingBytes+=Buffer.byteLength(data);
    if (pendingBytes>MAX_BYTES) fail('startup request buffer exceeded');
  }
}
ws.on('open',()=>{
  opened=true;
  if (metadata) {
    ws.send(JSON.stringify({id:1,method:'initialize',params:{
      clientInfo:{name:'botmux_codex_node_metadata',version:'1'},
      capabilities:{experimentalApi:true}
    }}));
  } else {
    for (const data of pending) ws.send(data);
    pending.length=0;pendingBytes=0;
  }
});
ws.on('message',raw=>{
  let d;try{d=JSON.parse(raw.toString());}catch{fail('invalid Codex response');return;}
  if (!metadata) {
    // Botmux's cwd checks are local to SG. Its workspace is only an alias;
    // all tool execution and persisted Codex cwd stay on the Mac.
    const line=JSON.stringify(mapCwds(d,false))+'\n';
    if (!process.stdout.write(line)) ws.pause();
    return;
  }
  if (d.id===1) {
    if (!d.result) {fail('Mac Codex initialization rejected');return;}
    ws.send(JSON.stringify({method:'initialized'}));
    if (metadata==='version') {
      console.log(config.codexVersion);
      closing=true;clearInterval(watchdog);ws.terminate();return;
    }
    ws.send(JSON.stringify({id:2,method:'model/list',params:{}}));
  } else if (d.id===2) {
    if (!Array.isArray(d.result?.data)) {fail('Mac model catalog unavailable');return;}
    const models=d.result.data.filter(m=>!m.hidden).map(m=>({
      slug:m.model || m.id,visibility:'list',display_name:m.displayName || m.model || m.id
    })).filter(m=>typeof m.slug==='string'&&m.slug);
    console.log(JSON.stringify({models}));
    closing=true;clearInterval(watchdog);ws.terminate();
  }
});
process.stdout.on('drain',()=>ws.resume());
ws.on('error',()=>fail('Mac is disconnected or its Codex service is unavailable'));
ws.on('close',()=>{clearInterval(watchdog);process.stdin.pause(); if(!closing){console.error('codex-node: Mac connection closed; in-flight requests are not replayed');process.exitCode=1;}});
if (!metadata) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{
    buffer+=chunk;
    while(buffer.includes('\n')&&!closing){const i=buffer.indexOf('\n');const line=buffer.slice(0,i);buffer=buffer.slice(i+1);sendLine(line);}
    if (Buffer.byteLength(buffer)>MAX_BYTES) fail('request line exceeded');
  });
  process.stdin.on('end',()=>{closing=true;clearInterval(watchdog);ws.terminate();});
  process.stdin.on('error',()=>fail('stdin transport closed'));
}
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{closing=true;clearInterval(watchdog);ws.terminate();setTimeout(()=>process.exit(0),300).unref();});
