#!/usr/bin/env python3
"""Install the TRAE auth renewal helper and Linux user-systemd timer."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def systemd_quote(value):
    # ExecStart and Environment are systemd syntax, never shell commands.
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'


def install_file(path, body, mode):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + "-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trae-home", default=os.environ.get("TRAE_HOME") or "~/.trae")
    parser.add_argument("--traex-bin", default="~/.local/bin/traex")
    parser.add_argument("--renew-before-hours", type=int, default=48)
    args = parser.parse_args()
    if sys.platform != "linux" or args.renew_before_hours <= 0:
        parser.error("Linux user systemd and a positive renewal window are required")
    os.umask(0o077)
    subprocess.run(["systemctl", "--user", "show-environment"],
                   stdout=subprocess.DEVNULL, check=True)
    home = Path.home()
    source = Path(__file__).resolve().with_name("traex-auth-renew.py")
    helper = home / ".local/lib/botmux/traex-auth-renew.py"
    state = home / ".local/state/botmux/traex-auth-renew"
    units = home / ".config/systemd/user"
    command = [
        str(Path(sys.executable).absolute()), str(helper),
        "--trae-home", str(Path(args.trae_home).expanduser().absolute()),
        "--traex-bin", str(Path(args.traex_bin).expanduser().absolute()),
        "--state-dir", str(state), "--renew-before-hours", str(args.renew_before_hours),
    ]
    path = ":".join([str(home / ".local/bin"), str(home / "bin"),
                     "/usr/local/bin", "/usr/bin", "/bin"])
    service = """[Unit]
Description=Botmux TRAE Codebase Git credential renewal

[Service]
Type=oneshot
WorkingDirectory=%h
UMask=0077
Environment={environment}
ExecStart={command}
TimeoutStartSec=90
LimitCORE=0
""".format(environment=systemd_quote("PATH=" + path),
           command=" ".join(systemd_quote(part) for part in command))
    timer = """[Unit]
Description=Check TRAE login expiry every six hours

[Timer]
OnActiveSec=1min
OnCalendar=*-*-* 00,06,12,18:15:00 UTC
RandomizedDelaySec=5min
Persistent=true
Unit=botmux-traex-auth-renew.service

[Install]
WantedBy=timers.target
"""
    # Install an independent copy so editing/deleting the checkout cannot
    # change or strand an already-enabled renewal service.
    install_file(helper, source.read_bytes(), 0o700)
    install_file(units / "botmux-traex-auth-renew.service", service.encode(), 0o600)
    install_file(units / "botmux-traex-auth-renew.timer", timer.encode(), 0o600)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now",
                    "botmux-traex-auth-renew.timer"], check=True)
    # Exercise the installed service with its real unattended environment.
    # A healthy credential only records its expiry; it does not log in again.
    subprocess.run(["systemctl", "--user", "start",
                    "botmux-traex-auth-renew.service"], check=True)
    print("Enabled botmux-traex-auth-renew.timer; status: " + str(state / "status.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
