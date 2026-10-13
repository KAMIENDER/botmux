#!/usr/bin/env python3
"""Renew a host's existing Codebase Git TRAE login without running an agent.

Python 3.7+ on Linux. Only the native login command handles authentication.
Credential contents and login output never enter status files or the journal.
"""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import tempfile


class RenewalError(Exception):
    """Only fixed, non-secret reason codes may be reported."""


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RenewalError("unsafe_state_directory")
    path.chmod(0o700)


def private_file(path, create=False):
    flags = os.O_RDWR | os.O_NOFOLLOW
    if create:
        flags |= os.O_CREAT
    fd = os.open(str(path), flags, 0o600)
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & 0o077):
        os.close(fd)
        raise RenewalError("unsafe_private_file")
    return os.fdopen(fd, "r+b")


def read_auth(path):
    with private_file(path) as handle:
        raw = handle.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise RenewalError("oversized_auth_file")
    try:
        doc = json.loads(raw)
        auth = doc["trae"]
        expires = dt.datetime.fromisoformat(auth["expires_at"].replace("Z", "+00:00"))
        if expires.tzinfo is None or not auth.get("user_id"):
            raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError):
        raise RenewalError("invalid_auth_metadata")
    if (doc.get("auth_mode") != "trae"
            or auth.get("login_method") != "git_codebase"
            or auth.get("credential_kind") != "cloud_cli_jwt"):
        raise RenewalError("unsupported_login_method")
    return raw, auth, expires


def atomic_write(path, data):
    # Replace only after all checks. A failed login never touches live auth.json.
    fd, name = tempfile.mkstemp(prefix="." + path.name + "-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, str(path))
        directory = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def native_login(binary, staging_home, timeout):
    env = dict(os.environ, TRAE_HOME=str(staging_home))
    # A login may invoke git/ssh children. Bound and reap the entire process
    # group so an unattended timeout cannot leave another auth writer behind.
    proc = subprocess.Popen(
        [str(binary), "login", "--git-code"],
        env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True,
    )
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
        raise RenewalError("native_login_timeout")
    if code != 0:
        raise RenewalError("native_login_failed_exit_" + str(code))


def renew(args, state_dir, result):
    home = Path(args.trae_home).expanduser().absolute()
    auth_path = home / "cli" / "auth.json"
    original, identity, old_expiry = read_auth(auth_path)
    result["expires_at"] = old_expiry.isoformat()
    now = dt.datetime.now(dt.timezone.utc)
    window = dt.timedelta(hours=args.renew_before_hours)
    if args.check or (not args.force and old_expiry - now > window):
        return "healthy" if old_expiry > now else "expired"

    binary = Path(args.traex_bin).expanduser().absolute()
    if not binary.is_file() or not os.access(str(binary), os.X_OK):
        raise RenewalError("traex_binary_unavailable")
    # TRAE_HOME is the CLI's native isolation mechanism. Retain routing/config,
    # but supply no existing token to this temporary login. Existing sessions
    # keep running against the live home; failed login leaves it untouched.
    with tempfile.TemporaryDirectory(prefix="login-", dir=str(state_dir)) as tmp:
        staging_home = Path(tmp)
        config = home / "traecli.toml"
        if config.exists():
            with private_file(config) as handle:
                config_bytes = handle.read(1024 * 1024 + 1)
            if len(config_bytes) > 1024 * 1024:
                raise RenewalError("oversized_cli_config")
            atomic_write(staging_home / "traecli.toml", config_bytes)
        native_login(binary, staging_home, args.timeout_seconds)
        candidate, fresh_identity, fresh_expiry = read_auth(staging_home / "cli" / "auth.json")
        if (fresh_identity["user_id"] != identity["user_id"]
                or fresh_identity.get("region") != identity.get("region")):
            raise RenewalError("native_login_identity_changed")
        if fresh_expiry <= old_expiry or fresh_expiry <= dt.datetime.now(dt.timezone.utc) + window:
            raise RenewalError("native_login_did_not_extend_expiry")

        # Use TRAE's auth-file flock as well as our own run lock. Refuse to
        # replace auth changed by an interactive login while ours was running.
        with private_file(auth_path.with_name("auth.json.lock"), create=True) as auth_lock:
            try:
                fcntl.flock(auth_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                result["reason"] = "native_auth_writer_busy"
                return "skipped"
            current, _, current_expiry = read_auth(auth_path)
            if current != original:
                result["expires_at"] = current_expiry.isoformat()
                result["reason"] = "auth_changed_during_login"
                return "skipped"
            atomic_write(auth_path, candidate)
            result["previous_expires_at"] = old_expiry.isoformat()
            result["expires_at"] = fresh_expiry.isoformat()
    return "renewed"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trae-home", default=os.environ.get("TRAE_HOME") or "~/.trae")
    parser.add_argument("--traex-bin", default="~/.local/bin/traex")
    parser.add_argument("--state-dir", default="~/.local/state/botmux/traex-auth-renew")
    parser.add_argument("--renew-before-hours", type=int, default=48)
    parser.add_argument("--timeout-seconds", type=int, default=60)
    parser.add_argument("--force", action="store_true", help="Renew now using native Codebase Git login")
    parser.add_argument("--check", action="store_true", help="Report expiry without attempting login")
    args = parser.parse_args()
    if args.renew_before_hours <= 0 or args.timeout_seconds <= 0 or (args.force and args.check):
        parser.error("positive limits required; --force and --check are mutually exclusive")
    os.umask(0o077)
    state_dir = Path(args.state_dir).expanduser().absolute()
    result = {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "renew_before_hours": args.renew_before_hours}
    code = 0
    try:
        private_dir(state_dir)
        with private_file(state_dir / "run.lock", create=True) as run_lock:
            try:
                fcntl.flock(run_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print(json.dumps(dict(result, status="skipped", reason="renewal_already_running")))
                return 0
            try:
                result["status"] = renew(args, state_dir, result)
                if result["status"] == "expired":
                    code = 1
            except RenewalError as exc:
                result.update(status="error", reason=str(exc))
                code = 1
            except (OSError, ValueError):
                result.update(status="error", reason="local_io_or_metadata_failure")
                code = 1
            atomic_write(state_dir / "status.json", (json.dumps(result) + "\n").encode())
    except (OSError, RenewalError):
        result.update(status="error", reason="state_storage_unavailable")
        code = 1
    print(json.dumps(result))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
