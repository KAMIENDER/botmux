#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {NativeClient,privateJson,discover} = require('./native-client.cjs');
const directory = path.join(os.homedir(),'.botmux','trae-native');

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
      throw new Error('Usage: botmux-trae-native sessions | doctor | adopt <native-id> --bot <bot>');
    }
    const botAt=args.indexOf('--bot');
    if (botAt < 0 || !args[botAt+1]) throw new Error('Specify the target native TRAE bot with --bot');
    const native = await client.request('lite','get_chat_session',{chat_session_id:id},id);
    if (native.user_id !== privateJson('auth.json').userInfo.user_id
        || !privateJson('runtime.json').workspaceFolders?.includes(native.main_folder)) {
      throw new Error('Native session is outside the initialized account/workspace');
    }
    const nonce=crypto.randomUUID(), requests=path.join(directory,'adoptions');
    fs.mkdirSync(requests,{recursive:true,mode:0o700});
    const selectionFile=path.join(requests,nonce+'.json');
    fs.writeFileSync(selectionFile,JSON.stringify({nativeSessionId:id,cwd:native.main_folder,
      expiresAt:new Date(Date.now()+5*60*1000).toISOString()}),{flag:'wx',mode:0o600});
    const promptFile=path.join(requests,nonce+'.prompt');
    fs.writeFileSync(promptFile,'[botmux-trae-native-adopt:'+nonce+']\n'
      +'这是接入已有 TRAE 原生会话。请仅回复“原生会话接入成功”，不要调用工具或修改文件。',
      {flag:'wx',mode:0o600});
    client.close();
    const executable=path.join(os.homedir(),'.botmux','bin','botmux');
    const child=spawn(executable,['session','start','--headless','--bot',args[botAt+1],
      '--working-dir',native.main_folder,'--prompt-file',promptFile,
      '--name',native.title || 'TRAE 原生会话','--timeout','120','--json'],{stdio:'inherit'});
    const result=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
    for (const file of [selectionFile,promptFile]) {try {fs.unlinkSync(file);} catch {}}
    if (result) process.exitCode=result;
  } finally {client.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
