#!/usr/bin/env python3
"""Keep one native Mac Codex service and its outgoing SSH tunnel alive.

There is no IM receiver or Botmux daemon here. SSH credentials and Codex auth
remain in their existing host stores; disconnects never replay task requests.
"""
import fcntl, json, os, pathlib, signal, stat, subprocess, sys, time

config_path = pathlib.Path(sys.argv[1])
config = json.loads(config_path.read_text())
state_dir = config_path.parent
state_dir.mkdir(parents=True, exist_ok=True)
state_dir.chmod(0o700)
lock = open(str(state_dir / 'host.lock'), 'a')
os.chmod(str(state_dir / 'host.lock'), 0o600)
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit('codex-node: host is already running')

stopping = False
children = []
def stop(signum, frame):
    global stopping
    stopping = True
    for child in children:
        if child.poll() is None:
            child.terminate()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

def write_status(**data):
    data['updated_at'] = int(time.time())
    tmp = state_dir / 'status.json.tmp'
    tmp.write_text(json.dumps(data) + '\n')
    tmp.chmod(0o600)
    tmp.replace(state_dir / 'status.json')

def wait_child(child):
    if child.poll() is None:
        child.terminate()
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()

# The remote pathname is installation-owned, never a chat-supplied pathname.
# Only remove a stale socket owned by the SSH account inside the private node dir.
cleanup = '''
from pathlib import Path
import os, stat
p = Path(REMOTE_SOCKET)
parent = p.parent
parent.mkdir(parents=True, exist_ok=True)
parent_stat = parent.stat()
if parent_stat.st_uid != os.getuid():
    raise RuntimeError("unexpected tunnel directory owner")
parent.chmod(0o700)
if p.exists() or p.is_symlink():
    st = p.lstat()
    if st.st_uid != os.getuid() or not stat.S_ISSOCK(st.st_mode):
        raise RuntimeError("refusing to replace a non-owned socket")
    p.unlink()
'''.replace('REMOTE_SOCKET', repr(config['remote_socket']))
cleanup_command = "python3 - <<'PY'\n" + cleanup + "\nPY"
log_path = state_dir / 'transport.log'
if log_path.exists() and log_path.stat().st_size > 8 * 1024 * 1024:
    log_path.replace(state_dir / 'transport.log.1')
log_fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
with os.fdopen(log_fd, 'ab', buffering=0) as log:
    codex = subprocess.Popen([
        config['codex_bin'], 'app-server', '--listen', 'unix://' + config['local_socket']
    ], stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=config['remote_workspace'])
    children.append(codex)
    deadline = time.monotonic() + 30
    local_socket = pathlib.Path(config['local_socket'])
    while not stopping and codex.poll() is None and time.monotonic() < deadline:
        if local_socket.exists() and stat.S_ISSOCK(local_socket.stat().st_mode):
            break
        time.sleep(.2)
    if not local_socket.exists() or codex.poll() is not None:
        write_status(codex_running=False, tunnel_running=False, reason='codex_start_failed')
        wait_child(codex)
        sys.exit(1)
    delay = 2
    while not stopping and codex.poll() is None:
        try:
            result = subprocess.run([
            '/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
            config['ssh_host'], cleanup_command
            ], stdout=subprocess.DEVNULL, stderr=log, timeout=20)
            connected = result.returncode == 0
        except (subprocess.TimeoutExpired, OSError):
            connected = False
        if connected and not stopping:
            tunnel = subprocess.Popen([
                '/usr/bin/ssh', '-NT', '-o', 'BatchMode=yes',
                '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
                '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
                '-R', config['remote_socket'] + ':' + config['local_socket'],
                config['ssh_host']
            ], stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            children.append(tunnel)
            time.sleep(2)
            write_status(codex_running=codex.poll() is None,
                         tunnel_running=tunnel.poll() is None,
                         reason='connected' if tunnel.poll() is None else 'ssh_connect_failed',
                         codex_pid=codex.pid, tunnel_pid=tunnel.pid)
            while not stopping and codex.poll() is None and tunnel.poll() is None:
                time.sleep(1)
            wait_child(tunnel)
            children.remove(tunnel)
        write_status(codex_running=codex.poll() is None, tunnel_running=False,
                     reason='stopped' if stopping else 'disconnected')
        for _ in range(delay):
            if stopping or codex.poll() is not None:
                break
            time.sleep(1)
        delay = min(delay * 2, 30)
    wait_child(codex)
    write_status(codex_running=False, tunnel_running=False,
                 reason='stopped' if stopping else 'codex_exited')
