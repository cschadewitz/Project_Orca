#!/usr/bin/env python3
"""Debian release staging/activation and stable launch adapter. No third-party modules.

Install this adapter outside release directories. All work launchers must use it;
its shared flock lives for the entire CLI/ACP child lifetime. The managed daemon
uses the wire admission barrier instead, so an idle service does not block updates.
"""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def capture(args, **kwargs):
    return run(args, stdout=subprocess.PIPE, **kwargs).stdout.strip()


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    sync_dir(path.parent)


def sync_dir(path):
    fd = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextlib.contextmanager
def lock(path, exclusive=True):
    with path.open("a+") as stream:
        try:
            fcntl.flock(stream, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except BlockingIOError:
            holders = []
            try:
                stat = os.fstat(stream.fileno())
                for line in Path("/proc/locks").read_text().splitlines():
                    fields = line.split()
                    if len(fields) < 6 or fields[1] != "FLOCK":
                        continue
                    device = fields[5].split(":")
                    if len(device) == 3 and int(device[2]) == stat.st_ino and int(device[0], 16) == os.major(stat.st_dev) and int(device[1], 16) == os.minor(stat.st_dev):
                        holders.append(fields[4])
            except (OSError, ValueError):
                pass
            detail = " (holder pids: " + ", ".join(holders) + ")" if holders else ""
            raise RuntimeError(f"Busy: {path.name}; active CLI/ACP work or another update{detail}. Retry later.") from None
        yield stream


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise RuntimeError("Daemon RPC redirects are refused")


def rpc(url, method, params, token_file=None, use_environment=True):
    explicit = os.environ.get("ORCA_DAEMON_TOKEN") if use_environment else None
    token_file = (os.environ.get("ORCA_DAEMON_TOKEN_FILE") if use_environment else None) or token_file
    opener = urllib.request.build_opener(NoRedirect())
    for attempt in range(2):
        token = explicit
        if token is None and token_file:
            try:
                token = Path(token_file).read_text().strip()
            except FileNotFoundError:
                token = None  # The explicit loopback compatibility mode needs no token.
            except OSError:
                raise RuntimeError("Cannot read daemon credential file") from None
        parsed = urllib.parse.urlsplit(url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise RuntimeError("Daemon URL must not contain credentials, query parameters or fragments")
        if token and parsed.scheme != "https" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise RuntimeError("Authenticated remote daemon connections require HTTPS")
        headers = {"content-type": "application/json"}
        if token:
            if not re.fullmatch(r"[A-Za-z0-9._~-]+", token):
                raise RuntimeError("Invalid daemon credential")
            headers["authorization"] = "Bearer " + token
        request = urllib.request.Request(url + "/rpc", json.dumps({
            "kind": "request", "id": 1, "method": method, "params": params,
        }).encode(), headers)
        try:
            response = opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            if error.code not in (401, 403):
                raise
            response = error
        with response:
            result = json.load(response)
        if result.get("ok"):
            return result["result"]
        code = result.get("error", {}).get("code")
        if code == "AUTH_INVALID" and attempt == 0 and explicit is None and token_file:
            continue  # A restart rotates the local file. Re-read it once, never loop.
        if code in ("AUTH_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN"):
            raise RuntimeError(f"Daemon refused {method}: {code}")
        raise RuntimeError(f"Daemon refused {method}: {result.get('error')}")


def metadata(release):
    result = json.loads((release / ".orca-release.json").read_text())
    if not Path(result["node"]).is_file():
        raise RuntimeError("Pinned Node executable is missing; restage the release")
    return result


def compatible(previous, candidate):
    a, b = metadata(previous), metadata(candidate)
    if a["compatibility"]["storeEpoch"] != b["compatibility"]["storeEpoch"]:
        raise RuntimeError("Store compatibility changed. Automatic activation/rollback refused; use the documented backup/migration procedure.")


def verify_hello(hello, meta, pid=None):
    if pid is not None and hello.get("processId") != pid:
        raise RuntimeError("Daemon hello does not belong to the managed process")
    contract = meta["compatibility"]
    if hello.get("orcaVersion") != meta["version"] or hello.get("protocol") != contract["protocol"]:
        raise RuntimeError("Unexpected daemon version or protocol")
    if not set(contract["capabilities"]).issubset(hello.get("capabilities", [])):
        raise RuntimeError("Daemon is missing required capabilities")
    if "maintenance" not in hello.get("methods", []):
        raise RuntimeError("Daemon has no admission barrier")


def select(root, release):
    if release.parent != (root / "releases").resolve():
        raise RuntimeError("Release is outside the versioned release directory")
    temporary = root / "current.next"
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(release, target_is_directory=True)
    os.replace(temporary, root / "current")
    sync_dir(root)


class Deployment:
    def __init__(self, manifest):
        self.config = json.loads(Path(manifest).read_text())
        self.root = Path(self.config["root"]).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "releases").mkdir(exist_ok=True)
        self.pending = self.root / "activation.json"
        if self.config.get("launchAudit") != "all-cli-acp-and-daemon-launches-migrated":
            raise RuntimeError("Launch inventory is unverified. Inspect wrappers, globs and service manager before bootstrap.")
        for key in ("cwd", "cliConfig", "acpConfig", "daemonConfig"):
            path = Path(self.config[key])
            if not path.is_absolute() or (self.root / "releases") in path.resolve().parents:
                raise RuntimeError(f"{key} must be absolute and outside replaceable releases")
        if not self.config["url"].startswith("http://127.0.0.1:"):
            raise RuntimeError("Managed daemon must listen on loopback")

    def systemctl(self, *args):
        return capture(["systemctl", *(["--user"] if self.config.get("userService", True) else []), *args])

    def health(self, release, url=None, pid=None, token_file=None):
        meta = metadata(release)
        if url is None:
            pid = int(self.systemctl("show", self.config["service"], "--property=MainPID", "--value"))
        last = None
        for _ in range(20):
            try:
                hello = rpc(url or self.config["url"], "hello",
                            {"client": "orca-release", "protocol": meta["compatibility"]["protocol"]},
                            token_file=token_file or self.token_file(), use_environment=url is None)
                verify_hello(hello, meta, pid)
                return
            except Exception as error:
                last = error
                time.sleep(0.25)
        raise RuntimeError(f"Health check failed: {last}")

    def token_file(self):
        return self.config.get("daemonTokenFile") or str(Path(self.config["daemonConfig"]).parent / "auth" / "local-client.token")

    def barrier(self, action, token):
        result = rpc(self.config["url"], "maintenance", {"action": action, "token": token}, token_file=self.token_file())
        if action == "prepare" and not result["ready"]:
            raise RuntimeError("Daemon busy: " + ", ".join(result["active"]))

    def stage(self, tag):
        if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
            raise RuntimeError("Use an explicit stable published vX.Y.Z release tag")
        release = self.root / "releases" / tag
        if release.exists():
            raise RuntimeError(f"Release directory already exists: {release}; inspect it rather than overwrite")
        published = json.loads(capture(["gh", "release", "view", tag, "--repo", self.config["repository"], "--json", "tagName,isDraft,isPrerelease"]))
        if published["isDraft"] or published["isPrerelease"] or published["tagName"] != tag:
            raise RuntimeError("Target is not a published stable release")
        # Incomplete stages have unique names and are never candidates for activation.
        stage = Path(tempfile.mkdtemp(prefix=tag + ".staging-", dir=self.root / "releases"))
        run(["gh", "repo", "clone", self.config["repository"], str(stage), "--", "--branch", tag, "--single-branch", "--depth", "1"])
        sha = capture(["git", "rev-parse", "HEAD"], cwd=stage)
        manifest = json.loads((stage / "package.json").read_text())
        if manifest["version"] != tag[1:]:
            raise RuntimeError("Published tag and package version disagree")
        contract = json.loads((stage / "release-compatibility.json").read_text())
        run(["mise", "trust"], cwd=stage)
        run(["mise", "install"], cwd=stage)
        env = {**os.environ, "ELECTRON_SKIP_BINARY_DOWNLOAD": "1"}
        for args in (["install", "--frozen-lockfile"], ["run", "typecheck"], ["run", "build"]):
            run(["mise", "exec", "--", "pnpm", *args], cwd=stage, env=env)
        node = capture(["mise", "which", "node"], cwd=stage)
        cli = stage / "packages/cli/dist/main.js"
        if capture([node, str(cli), "--version"], cwd=stage) != tag[1:]:
            raise RuntimeError("Built CLI version mismatch")
        # Exercises shipped workflows/templates and the compiled CLI against temporary stores.
        with tempfile.TemporaryDirectory(prefix="orca-validate-") as scratch:
            run([node, str(cli), "demo", "--dir", scratch], cwd=stage, env=env)
        write_json(stage / ".orca-release.json", {"version": tag[1:], "sha": sha, "node": node, "compatibility": contract})
        for config_key in ("cliConfig", "acpConfig", "daemonConfig"):
            run([node, str(cli), "--config", self.config[config_key], "validate"],
                cwd=self.config["cwd"], env={**env, "ORCA_RELEASE": str(stage)})
        with tempfile.TemporaryDirectory(prefix="orca-health-") as scratch:
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            child = subprocess.Popen([node, str(cli), "--cwd", scratch, "serve", "--port", str(port)],
                                     cwd=stage, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                self.health(stage, f"http://127.0.0.1:{port}", child.pid,
                            token_file=str(Path(scratch) / "auth" / "local-client.token"))
                if child.poll() is not None:
                    raise RuntimeError("Staged daemon exited during health validation")
            finally:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        os.rename(stage, release)
        sync_dir(release.parent)
        return release.resolve()

    def inspect_processes(self):
        """Reject unregistered old launchers too; permission failures are never idle."""
        service_pid = int(self.systemctl("show", self.config["service"], "--property=MainPID", "--value"))
        if service_pid <= 0:
            raise RuntimeError("Managed daemon PID is unknown or service is stopped")
        for directory in Path("/proc").iterdir():
            if not directory.name.isdigit() or int(directory.name) in (os.getpid(), service_pid):
                continue
            try:
                if directory.stat().st_uid != os.getuid():
                    continue
                args = (directory / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            except FileNotFoundError:
                continue
            except PermissionError:
                raise RuntimeError("Cannot inspect process activity reliably") from None
            if re.search(r"(?:orca-daemon|packages/cli/(?:dist|src)/main\.|orca\s+(?:acp|run|program|serve))", args):
                raise RuntimeError(f"Unmanaged ORCA process blocks activation: pid {directory.name}")
        process_dir = Path("/proc") / str(service_pid)
        args = (process_dir / "cmdline").read_bytes().split(b"\0")
        expected = str((self.root / "current").resolve() / "packages/cli/dist/main.js").encode()
        if process_dir.stat().st_uid != os.getuid() or expected not in args or b"serve" not in args:
            raise RuntimeError("Service PID is not the expected managed daemon; inspect the actual launch method")
        environment = (process_dir / "environ").read_bytes().split(b"\0")
        expected_gate = ("ORCA_ADMISSION_FILE=" + str(self.pending)).encode()
        if expected_gate not in environment:
            raise RuntimeError("Managed daemon lacks the persistent admission guard; migrate its launcher first")
        return service_pid

    def activate(self, candidate):
        with lock(self.root / "admission.lock"):
            if self.pending.exists():
                raise RuntimeError("Interrupted activation exists. Run recover before another update.")
            previous = (self.root / "current").resolve(strict=True)
            compatible(previous, candidate)
            old_version = tuple(map(int, metadata(previous)["version"].split(".")))
            new_version = tuple(map(int, metadata(candidate)["version"].split(".")))
            if new_version <= old_version:
                raise RuntimeError("Updates must move forward; use recovery for interrupted activation")
            self.inspect_processes()
            self.health(previous)
            token = str(uuid.uuid4())
            # The daemon checks this durable admission file before every operation,
            # including after a supervisor restart. Write it BEFORE inspecting activity.
            record = {"previous": str(previous), "candidate": str(candidate), "token": token, "opened": True}
            write_json(self.pending, record)
            try:
                self.barrier("prepare", token)
            except Exception as error:
                if str(error).startswith("Daemon busy:"):
                    self.pending.unlink()
                    sync_dir(self.root)
                # An uncertain prepare keeps admission closed for explicit recovery.
                raise
            record["opened"] = False
            write_json(self.pending, record)
            try:
                self.systemctl("stop", self.config["service"])
                select(self.root, candidate)
                self.systemctl("start", self.config["service"])
                self.health(candidate)
                record["opened"] = True
                write_json(self.pending, record)
                self.barrier("resume", token)
                self.pending.unlink()
                sync_dir(self.root)
            except Exception as error:
                self.restore(record)
                raise RuntimeError(f"Activation failed; previous release restored and healthy: {error}") from error

    def restore(self, record):
        previous, candidate = Path(record["previous"]), Path(record["candidate"])
        compatible(previous, candidate)
        # Once resume was attempted its outcome can be uncertain (including a crash after
        # resume but before journal removal). Re-close admission before stopping anything.
        # If activity is unknown or busy, retain the journal and leave the daemon alone.
        if record.get("opened"):
            self.barrier("prepare", record["token"])
        # Otherwise every candidate/previous service started closed under this journal.
        self.systemctl("stop", self.config["service"])
        select(self.root, previous)
        self.systemctl("start", self.config["service"])
        self.health(previous)
        record["opened"] = True
        write_json(self.pending, record)
        self.barrier("resume", record["token"])
        self.pending.unlink()
        sync_dir(self.root)

    def launch(self, kind, args):
        if kind == "daemon":
            self.exec_release(kind, args)
        else:
            with lock(self.root / "admission.lock", exclusive=False) as lease:
                if self.pending.exists():
                    raise RuntimeError("Activation/recovery pending; retry after recovery")
                # exec preserves the shared lock for the whole process and its children.
                os.set_inheritable(lease.fileno(), True)
                self.exec_release(kind, args)

    def exec_release(self, kind, args):
        release = (self.root / "current").resolve(strict=True)
        meta = metadata(release)
        env = {**os.environ, "ORCA_RELEASE": str(release)}
        env.pop("ORCA_MAINTENANCE_TOKEN", None)
        env.pop("ORCA_ADMISSION_FILE", None)
        if kind == "daemon":
            env["ORCA_ADMISSION_FILE"] = str(self.pending)
        config = self.config[{"cli": "cliConfig", "acp": "acpConfig", "daemon": "daemonConfig"}[kind]]
        command = [meta["node"], str(release / "packages/cli/dist/main.js"), "--config", config]
        if kind == "daemon":
            command += ["--cwd", self.config["cwd"], "serve", "--host", "127.0.0.1", "--port", self.config["url"].rsplit(":", 1)[1]]
        elif kind == "acp":
            command += ["acp", *args]
        else:
            if "serve" in args:
                raise RuntimeError("Use the managed daemon service, not the CLI launcher")
            command += args
        os.execve(meta["node"], command, env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deployment", required=True)
    parser.add_argument("action", choices=["stage", "update", "recover", "cli", "acp", "daemon"])
    parser.add_argument("args", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    deploy = Deployment(options.deployment)
    if options.action in ("cli", "acp", "daemon"):
        return deploy.launch(options.action, options.args)
    with lock(deploy.root / "update.lock"):
        if options.action == "recover":
            with lock(deploy.root / "admission.lock"):
                deploy.restore(json.loads(deploy.pending.read_text()))
        else:
            if len(options.args) != 1:
                raise RuntimeError("Supply one published release tag")
            if deploy.pending.exists():
                raise RuntimeError("Recovery pending; run recover first")
            existing = deploy.root / "releases" / options.args[0]
            if options.action == "update" and re.fullmatch(r"v\d+\.\d+\.\d+", options.args[0]) and existing.exists():
                metadata(existing)
                candidate = existing.resolve()
            else:
                candidate = deploy.stage(options.args[0])
            if options.action == "update":
                deploy.activate(candidate)
            print(candidate)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"orca-release: {error}", file=sys.stderr)
        sys.exit(1)
