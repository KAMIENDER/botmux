#!/usr/bin/env python3
"""Install a configured Codex executable on the existing SG Botmux host."""
import argparse, hashlib, json, pathlib, posixpath, shlex, shutil, subprocess
p = argparse.ArgumentParser()
p.add_argument('--name', default='mac')
p.add_argument('--remote-workspace', required=True)
p.add_argument('--codex-version', required=True)
p.add_argument('--remote-root', action='append', default=[],
               help='additional absolute Mac cwd root, e.g. the owner home for desktop /adopt')
args = p.parse_args()
if not args.name or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in args.name):
    p.error('node name must be lowercase letters, digits or hyphens')
if not pathlib.PurePosixPath(args.remote_workspace).is_absolute():
    p.error('remote workspace must be an absolute Mac directory')
for remote_root in args.remote_root:
    if not pathlib.PurePosixPath(remote_root).is_absolute() or posixpath.normpath(remote_root) == '/':
        p.error('remote root must be an absolute non-filesystem-root Mac directory')
home = pathlib.Path.home()
root = home / '.botmux/execution-nodes' / args.name
root.mkdir(parents=True, exist_ok=True)
root.chmod(0o700)
workspace = root / 'workspace'
workspace.mkdir(exist_ok=True)
(workspace / 'REMOTE_WORKSPACE.md').write_text(
    'This SG directory is a control-plane alias only.\n'
    'Actual workspace on the Mac: ' + args.remote_workspace + '\n'
    'Code files and Codex credentials stay on the Mac.\n'
)
module = subprocess.check_output([
    shutil.which('node') or 'node', '-p',
    'require.resolve(' + json.dumps(str(pathlib.Path(__file__).resolve().parents[2] / 'node_modules/ws')) + ')'
], text=True).strip()
source = pathlib.Path(__file__).parent / 'stdio-proxy.cjs'
target = root / 'stdio-proxy.cjs'
shutil.copy2(str(source),str(target))
additional_workspaces = []
for remote_root in dict.fromkeys(posixpath.normpath(r) for r in args.remote_root):
    alias = root / 'paths' / hashlib.sha256(remote_root.encode()).hexdigest()[:12]
    alias.mkdir(parents=True, exist_ok=True)
    alias.chmod(0o700)
    additional_workspaces.append({'localRoot':str(alias),'remoteRoot':remote_root})
config = {
    'socket': str(root / 'codex.sock'),
    'localWorkspace': str(workspace),
    'remoteWorkspace': args.remote_workspace.rstrip('/'),
    'additionalWorkspaces': additional_workspaces,
    'wsModule': module,
    'codexVersion': args.codex_version,
    'attachmentRoot': str(home / '.botmux'),
}
config_path = root / 'proxy.json'
config_path.write_text(json.dumps(config, indent=2) + '\n')
config_path.chmod(0o600)
binary = home / '.local/bin' / ('codex-' + args.name)
if binary.exists() and 'botmux-codex-node' not in binary.read_text():
    raise RuntimeError('refusing to replace an unrelated executable')
binary.parent.mkdir(parents=True, exist_ok=True)
binary.write_text('#!/bin/sh\n# botmux-codex-node installed launcher\nexec ' +
    shlex.quote(shutil.which('node') or 'node') + ' ' + shlex.quote(str(target)) + ' ' +
    shlex.quote(str(config_path)) + ' "$@"\n')
binary.chmod(0o700)
print(json.dumps({'launcher':str(binary),'workspace':str(workspace),'socket':config['socket']}))
