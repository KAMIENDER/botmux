#!/usr/bin/env python3
"""Install bridge entrypoint and a user service using the captured installation."""
import json, os, shlex
from pathlib import Path

home = Path.home()
root = Path(__file__).resolve().parent
boot = json.loads((home / '.botmux/trae-native/boot.json').read_text())
node = boot['node']
def unit_quote(value):
    return '"' + str(value).replace('\\','\\\\').replace('"','\\"').replace('%','%%') + '"'
unit = ('[Unit]\nDescription=Botmux shared native TRAE backend\n'
        'After=network-online.target\nWants=network-online.target\n'
        'StartLimitIntervalSec=300\nStartLimitBurst=10\n\n'
        '[Service]\nType=simple\nExecStart=' + unit_quote(node) + ' '
        + unit_quote(root / 'runtime.cjs') + '\nRestart=on-failure\nRestartSec=5\n'
        'KillMode=control-group\nTimeoutStopSec=30\nUMask=0077\n\n'
        '[Install]\nWantedBy=default.target\n')
directory = home / '.config/systemd/user'
directory.mkdir(parents=True,exist_ok=True)
(directory / 'botmux-trae-native.service').write_text(unit)
wrapper = ('#!/bin/sh\ncase "$1" in\n'
           '  sessions|doctor|adopt) exec ' + shlex.quote(node) + ' '
           + shlex.quote(str(root / 'session-cli.cjs')) + ' "$@" ;;\n'
           '  --version) echo "botmux-trae-native 0.1.0"; exit 0 ;;\nesac\n'
           '# Existing TraeX tmux sessions retain their old executable behavior.\n'
           'if [ -t 0 ] || [ "$#" -gt 0 ]; then\n'
           '  exec "$HOME/.local/bin/traex" "$@"\nfi\n'
           'exec ' + shlex.quote(node) + ' ' + shlex.quote(str(root / 'provider.cjs')) + '\n')
bin_dir = home / '.local/bin'
bin_dir.mkdir(parents=True,exist_ok=True)
entry = bin_dir / 'botmux-trae-native'
entry.write_text(wrapper)
os.chmod(str(entry),0o755)
print('Installed entrypoint and service definition; reload systemd to apply')
