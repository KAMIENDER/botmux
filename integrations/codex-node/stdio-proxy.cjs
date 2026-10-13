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
  process.stdin.destroy();
  clearInterval(watchdog);
  // A paused pipe may keep Node alive and turn a local rejection into a 90s
  // runner timeout. Close stdio as well so pending requests fail immediately.
  process.stdout.end();
  setTimeout(() => process.exit(1), 1000).unref();
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
const nodeDir = path.posix.normalize(path.dirname(config.socket));
const mappings = [
  {localRoot:config.localWorkspace, remoteRoot:config.remoteWorkspace},
  ...(config.additionalWorkspaces || []),
].map(m => {
  const localRoot = path.posix.normalize(m.localRoot);
  const remoteRoot = path.posix.normalize(m.remoteRoot);
  if (!path.posix.isAbsolute(localRoot) || !path.posix.isAbsolute(remoteRoot)
      || remoteRoot === '/' || !localRoot.startsWith(nodeDir + '/')) {
    throw new Error('codex-node: invalid private workspace mapping');
  }
  return {localRoot, remoteRoot};
});
function ensureAliasDirectory(root, suffix) {
  // These are control-plane directories only, never fabricated git repos or
  // mounts. Reject symlinks before creating each component inside our private
  // node directory; native thread/list cwd then survives SG's exists check.
  const relative = path.posix.relative(nodeDir, root + suffix);
  let current = nodeDir;
  for (const component of relative.split('/').filter(Boolean)) {
    if (component === '..') throw new Error('alias escaped the node directory');
    current = path.posix.join(current, component);
    let st;
    try {st=fs.lstatSync(current);}
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {fs.mkdirSync(current, {mode:0o700});}
      catch (createError) {
        // Concurrent native metadata clients may prepare the same alias.
        if (createError.code !== 'EEXIST') throw createError;
      }
      st=fs.lstatSync(current);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('invalid alias directory');
  }
}
function mappedCwd(cwd, outgoing) {
  if (typeof cwd !== 'string') return cwd;
  const normalized = path.posix.normalize(cwd);
  // Prefer the most specific root, keeping existing my_project session paths
  // stable even when the owner's broader Mac home is added for /adopt.
  const ordered = [...mappings].sort((a,b) => {
    const key = outgoing ? 'localRoot' : 'remoteRoot';
    return b[key].length - a[key].length;
  });
  for (const mapping of ordered) {
    const from = outgoing ? mapping.localRoot : mapping.remoteRoot;
    const to = outgoing ? mapping.remoteRoot : mapping.localRoot;
    if (normalized !== from && !normalized.startsWith(from + '/')) continue;
    const suffix = normalized.slice(from.length);
    if (!outgoing) ensureAliasDirectory(to, suffix);
    return to + suffix;
  }
  if (outgoing) throw new Error('Mac execution directory is outside the configured node mappings; refresh /adopt or choose a mapped directory');
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
const remoteNote = cwd => [
  'Execution host: Mac. The real working directory is ' + (cwd || config.remoteWorkspace) + '.',
  'Botmux routing and schedules are owned by SG; the assistant final reply is forwarded automatically.',
  'There is no Botmux installation on this Mac. Do not claim local botmux shell helpers are available.',
  'Do not run SG filesystem paths or use a second app-server to steal an active desktop thread.',
].join('\n');
function translateRequest(message) {
  const mapped = mapCwds(message,true);
  // Append host facts to new threads, and to developer instructions that
  // the existing runner already supplies on resume. Never resume on our own.
  if (mapped.method === 'thread/start' ||
      (mapped.method === 'thread/resume' && typeof mapped.params?.developerInstructions === 'string')) {
    mapped.params ||= {};
    mapped.params.developerInstructions =
      (mapped.params.developerInstructions || '') + '\n\n' + remoteNote(mapped.params.cwd);
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
  let original, message;
  try { original=JSON.parse(line); }
  catch {fail('invalid JSON request');return;}
  try {message=translateRequest(original);}
  catch (error) {
    // This request was rejected before crossing SSH, so report a definite
    // JSON-RPC rejection. Keeping the client alive lets the runner surface the
    // real path error instead of waiting for its startup deadline.
    if (original && Object.hasOwn(original,'id') && typeof original.method === 'string') {
      const response={id:original.id,error:{code:-32602,message:error.message}};
      if (!process.stdout.write(JSON.stringify(response)+'\n')) ws.pause();
    } else fail('invalid request or unsupported remote path');
    return;
  }
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
    let line;
    try {line=JSON.stringify(mapCwds(d,false))+'\n';}
    catch {fail('could not prepare the private Mac directory alias');return;}
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
ws.on('close',()=>{clearInterval(watchdog);if(!closing) fail('Mac connection closed; in-flight requests are not replayed');});
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
