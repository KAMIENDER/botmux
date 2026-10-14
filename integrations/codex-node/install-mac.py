#!/usr/bin/env python3
"""Install only the Mac native Codex host/tunnel LaunchAgent (no Botmux)."""
import argparse, json, os, pathlib, plistlib, shutil, subprocess, sys
p=argparse.ArgumentParser()
p.add_argument('--ssh-host',required=True)
p.add_argument('--remote-socket',required=True)
p.add_argument('--workspace',default=str(pathlib.Path.home()/'my_project'))
p.add_argument('--codex',default=shutil.which('codex'))
args=p.parse_args()
workspace=pathlib.Path(args.workspace).resolve()
if not workspace.is_dir() or not args.codex:
    p.error('Codex executable and workspace must exist')
if ':' in args.remote_socket or not args.remote_socket.startswith('/'):
    p.error('remote socket must be an absolute Unix pathname')
home=pathlib.Path.home()
state=home/'.local/state/botmux-codex-node'
state.mkdir(parents=True,exist_ok=True);state.chmod(0o700)
lib=home/'.local/lib/botmux-codex-node'
lib.mkdir(parents=True,exist_ok=True);lib.chmod(0o700)
for name in ('host.py', 'desktop_connection.py'):
    shutil.copy2(str(pathlib.Path(__file__).parent/name), str(lib/name))
version=subprocess.check_output([args.codex,'--version'],text=True).strip()
config={'ssh_host':args.ssh_host,'remote_socket':args.remote_socket,
        'local_socket':str(state/'codex.sock'),'codex_bin':args.codex,
        'remote_workspace':str(workspace),'codex_version':version}
config_path=state/'config.json'
if config_path.exists():
    existing=json.loads(config_path.read_text())
    if 'desktop_connection' in existing:
        config['desktop_connection']=existing['desktop_connection']
config_path.write_text(json.dumps(config,indent=2)+'\n');config_path.chmod(0o600)
label='com.botmux.codex-node.mac'
plist_path=home/'Library/LaunchAgents'/ (label+'.plist')
plist_path.parent.mkdir(parents=True,exist_ok=True)
with plist_path.open('wb') as f:
    plistlib.dump({'Label':label,'ProgramArguments':[sys.executable,str(lib/'host.py'),str(config_path)],
        'WorkingDirectory':str(workspace),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,
        'EnvironmentVariables':{'PATH':os.environ.get('PATH','/usr/bin:/bin')},
        'SoftResourceLimits':{'NumberOfFiles':8192},
        'StandardOutPath':str(state/'launchd.log'),'StandardErrorPath':str(state/'launchd.log')},f)
plist_path.chmod(0o600)
log=state/'launchd.log'
log.touch(exist_ok=True);log.chmod(0o600)
print(json.dumps({'launch_agent':str(plist_path),'label':label,'version':version,'config':str(config_path)}))
