#!/usr/bin/env python3
"""Opt in to the installed desktop's WebSocket transport without patching it."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import quote

ENV_KEY = 'CODEX_APP_SERVER_WS_URL'

def desktop_url(config):
    # ws treats the URL pathname as "Unix socket:/HTTP path". The localhost
    # authority keeps the desktop's network routing from selecting a SOCKS proxy.
    socket = Path(config['local_socket'])
    if not socket.is_absolute():
        raise ValueError('the native socket must be an absolute pathname')
    return 'ws+unix://localhost' + quote(str(socket), safe='/') + ':/rpc'

def environment_url():
    return subprocess.run(
        ['/bin/launchctl', 'getenv', ENV_KEY],
        capture_output=True, text=True, check=False,
    ).stdout.rstrip('\n')

def set_environment(value):
    command = ['/bin/launchctl', 'setenv', ENV_KEY, value] if value else [
        '/bin/launchctl', 'unsetenv', ENV_KEY,
    ]
    subprocess.run(command, check=True, capture_output=True)

def publish_desktop_endpoint(config):
    choice = config.get('desktop_connection', {})
    if not choice.get('enabled'):
        return False
    url = desktop_url(config)
    current = environment_url()
    if current not in ('', url, choice.get('previous_url', '')):
        raise RuntimeError('desktop transport changed outside this installation')
    set_environment(url)
    return True

def save_config(config_path, config):
    temporary = config_path.with_suffix('.desktop.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(config, handle, indent=2)
        handle.write('\n')
    temporary.replace(config_path)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path,
                        default=Path.home()/'.local/state/botmux-codex-node/config.json')
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--enable', action='store_true')
    action.add_argument('--disable', action='store_true')
    action.add_argument('--status', action='store_true')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    url = desktop_url(config)
    current = environment_url()
    choice = config.get('desktop_connection', {})
    if args.enable:
        if not Path(config['local_socket']).is_socket():
            parser.error('the installed Mac Codex service must be running first')
        if not choice.get('enabled'):
            if current and current != url:
                parser.error('desktop already has a different explicit endpoint; refusing to replace it')
            config['desktop_connection'] = {'enabled': True, 'previous_url': current if current != url else ''}
        publish_desktop_endpoint(config)
        try:
            save_config(args.config, config)
        except Exception:
            set_environment(current)
            raise
    elif args.disable:
        # Only restore our own value. A later user-selected transport is never
        # overwritten by disabling this integration.
        if current == url:
            set_environment(choice.get('previous_url', ''))
        config.pop('desktop_connection', None)
        try:
            save_config(args.config, config)
        except Exception:
            if current == url:
                set_environment(current)
            raise
    print(json.dumps({
        'enabled': bool(config.get('desktop_connection', {}).get('enabled')),
        'endpoint': url,
        'environment_matches': environment_url() == url,
        # Selecting a future transport is not evidence about the live desktop.
        'scope': 'future_desktop_launches',
    }))

if __name__ == '__main__':
    main()
