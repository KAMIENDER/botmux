'use strict';
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const {privateJson, discover} = require('./native-client.cjs');

const boot = privateJson('boot.json');
try {
  const running = discover();
  process.stderr.write('Refusing to start a second native database writer (PID ' + running.pid + ')\n');
  process.exit(1);
} catch (error) {
  if (!error.message?.endsWith('found 0')) throw error;
}
const log = fs.openSync(boot.logFile, 'w', 0o600);
const child = spawn(boot.node, boot.args, {cwd:boot.cwd,
  env:{...process.env,...boot.env},stdio:['ignore',log,log]});
fs.closeSync(log);
// The Remote SSH installer reuses these vendor PID/log/token files. Keep the
// same installation identity so desktop reconnects use this process.
fs.writeFileSync(boot.pidFile, String(child.pid) + '\n', {mode:0o600});
child.once('error',() => {process.stderr.write('Native server launch failed\n');process.exitCode=1;});
child.once('exit',code => {
  try {
    if (Number(fs.readFileSync(boot.pidFile,'utf8').trim()) === child.pid) fs.unlinkSync(boot.pidFile);
  } catch {}
  process.exitCode = code || 1;
});
process.on('SIGTERM',() => child.kill('SIGTERM'));
process.on('SIGINT',() => child.kill('SIGTERM'));
