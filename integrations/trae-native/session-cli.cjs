#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {NativeClient,privateJson,discover} = require('./native-client.cjs');
const directory = path.join(os.homedir(),'.botmux','trae-native');

function botmux(args) {
  const executable=path.join(os.homedir(),'.botmux','bin','botmux');
  return new Promise((resolve,reject) => {
    execFile(executable,args,{timeout:180000,maxBuffer:1024*1024},(error,stdout) => {
      let result;
      try {result=JSON.parse(stdout);} catch {reject(new Error('Botmux did not return a structured result'));return;}
      // Keep structured failures and IDs for inspection; never replay an
      // uncertain request or print raw CLI stderr.
      if (error && result.ok !== false) {reject(new Error('Botmux request outcome could not be verified'));return;}
      resolve(result);
    });
  });
}

async function main() {
  const [operation,id,...args] = process.argv.slice(2);
  if (operation === 'doctor') {
    const native=discover(),runtime=privateJson('runtime.json'),auth=privateJson('auth.json');
    console.log(JSON.stringify({nativePid:native.pid,installation:native.root,
      initializedWorkspaces:runtime.workspaceFolders,expiresAt:auth.expiresAt},null,2));
    return;
  }
  const client = new NativeClient();
  try {
    if (operation === 'sessions') {
      const data = await client.request('lite','list_chat_sessions',{page_size:100});
      console.log(JSON.stringify((data.items || []).map(item => ({id:item.chat_session_id,title:item.title,
        cwd:item.source?.local_folder,origin:item.origin,remote:item.extra?.workspace_kind === 'ssh'})),null,2));
      return;
    }
    if (operation !== 'adopt' || !id || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) {
      throw new Error('Usage: botmux-trae-native sessions | doctor | adopt <native-id> --bot <app-id>');
    }
    const botAt=args.indexOf('--bot'),appId=botAt >= 0 ? args[botAt+1] : undefined;
    const targetBot=privateJson('../bots.json').find(bot => bot.larkAppId === appId);
    if (targetBot?.cliId !== 'remote-runner' || targetBot.backendType !== 'remote-runner'
        || targetBot.remoteRunner?.expectedProvider !== 'trae-native') {
      throw new Error('Specify the exact native TRAE bot app ID with --bot');
    }
    const native = await client.request('lite','get_chat_session',{chat_session_id:id},id);
    if (native.user_id !== privateJson('auth.json').userInfo.user_id
        || !privateJson('runtime.json').workspaceFolders?.includes(native.main_folder)) {
      throw new Error('Native session is outside the initialized account/workspace');
    }
    client.close();
    // The existing create API only registers metadata. Bind its generated ID
    // before the first send so provider start adopts the original native ID.
    const created=await botmux(['session','create','--bot',appId,'--working-dir',native.main_folder,
      '--title',native.title || 'TRAE 原生会话','--json']);
    if (!created.ok || !created.sessionId || !/^[0-9a-f-]{36}$/.test(created.sessionId)) {
      console.log(JSON.stringify(created,null,2));process.exitCode=1;return;
    }
    const bindings=path.join(directory,'bindings');
    fs.mkdirSync(bindings,{recursive:true,mode:0o700});
    const stat=fs.lstatSync(bindings);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      throw new Error('Native binding directory must be owner-only');
    }
    fs.writeFileSync(path.join(bindings,created.sessionId+'.json'),JSON.stringify({
      version:1,nativeSessionId:id,cwd:native.main_folder,
    }),{flag:'wx',mode:0o600});
    const promptFile=path.join(directory,crypto.randomUUID()+'.prompt');
    fs.writeFileSync(promptFile,
      '这是接入已有 TRAE 原生会话。请仅回复“原生会话接入成功”，不要调用工具或修改文件。',
      {flag:'wx',mode:0o600});
    try {
      const result=await botmux(['session','send',created.sessionId,'--prompt-file',promptFile,
        '--wait','--timeout','120','--json']);
      console.log(JSON.stringify({ok:result.ok,botmuxSessionId:created.sessionId,
        headlessId:created.headlessId,nativeSessionId:id,result},null,2));
      if (!result.ok) process.exitCode=1;
    } finally {try {fs.unlinkSync(promptFile);} catch {}}
  } finally {client.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
