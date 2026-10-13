#!/usr/bin/env python3
"""Capture the existing owned Remote SSH installation without copying secrets."""
import json, os, sys
from pathlib import Path

pid = int(sys.argv[1])
proc = Path('/proc') / str(pid)
if proc.stat().st_uid != os.getuid():
    raise SystemExit('Remote server owner mismatch')
args = (proc / 'cmdline').read_bytes().decode().split('\0')[:-1]
if len(args) < 2 or Path(args[1]).name != 'index_trae.js' or '--start-server' not in args:
    raise SystemExit('Not a native TRAE Remote SSH server')
if '--connection-token' in args or any(x.startswith('--connection-token=') for x in args):
    raise SystemExit('A token-file installation is required')
token = Path(args[args.index('--connection-token-file') + 1])
if token.stat().st_uid != os.getuid():
    raise SystemExit('Remote token file owner mismatch')
env = dict(x.split('=', 1) for x in (proc / 'environ').read_bytes().decode().split('\0') if '=' in x)
env = {k:v for k,v in env.items() if k in ['HOME','USER','LANG','PATH','ICUBE_USER_DATA_DIR','TRAE_RESOLVE_TYPE','ICUBE_MACHINE_ID','ICUBE_RESOLVE_ID','ICUBE_RUN_IN_REMOTE','ICUBE_PRODUCT_PROVIDER','ICUBE_PRODUCT_QUALITY','ICUBE_PRODUCT_BUILD_VERSION','ICUBE_PRODUCT_DATE','ICUBE_PRODUCT_APP_VERSION','ICUBE_PRODUCT_BRAND_NAME','ICUBE_REMOTE_REGION','ICUBE_ENABLE_SINGLETON_CUE_SERVER','ICUBE_ENABLE_CKG_AHA_REQUEST']}
args = [x for x in args[1:] if x != '--enable-remote-auto-shutdown']
log_dir = str(Path.home() / '.trae-cn-server' / 'manager-logs' / 'botmux-native')
args[args.index('--logsPath') + 1] = log_dir
# Let TRAE's launcher allocate a free loopback port, as its installer does.
directory = Path.home() / '.botmux' / 'trae-native'
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
if directory.is_symlink() or directory.stat().st_uid != os.getuid():
    raise SystemExit('Native configuration owner mismatch')
os.chmod(str(directory), 0o700)
boot = {'node':args and str(Path('/proc') / str(pid) / 'exe'), 'args':args,
        'env':env, 'cwd':str((proc / 'cwd').resolve()),
        'pidFile':str(token.with_suffix('.pid')), 'logFile':str(token.with_suffix('.log'))}
boot['node'] = str((proc / 'exe').resolve())
temporary = directory / 'boot.json.new'
fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd,'w') as handle:
    json.dump(boot, handle)
os.replace(str(temporary), str(directory / 'boot.json'))
print('Captured native server installation; auto-shutdown removed')
