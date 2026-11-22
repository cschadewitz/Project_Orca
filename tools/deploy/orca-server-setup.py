#!/usr/bin/env python3
"""Turn a reachable Linux machine into a managed ORCA server, in one step (#881).

Every step is idempotent: on a machine this set up before it verifies, and repairs what is
missing or stopped, instead of installing again. It installs exactly what the bootstrap in
docs/UPDATING.md describes, with the managed adapter (`orca-release.py`) doing the staging:

0. account     With `--expect-account`, refuses to run as any other account than the one
               the person confirmed.
1. platform    Linux x64, Python 3.8+, /proc, and a systemd user manager.
2. inventory   Refuses a machine with an ORCA installation this setup did not make (a
               launcher, unit, process or directory): those are migrated by hand, never
               taken over (docs/UPDATING.md, "Debian: inventory before migration").
   existing    What an earlier run left must be exactly this setup's: `current`, and any
               `releases/vVERSION`, are accepted only as the release this setup staged
               from the verified bundle for exactly VERSION (its receipt, see `receipt`),
               confined to `<root>/releases`. Anything else (another version, a release
               it did not stage, a changed one) is refused for separate reconciliation
               with orca-release.py; it is never started.
3. adapter     The managed adapter, `<root>/orca-release.py`.
4. files       `deployment.json`: written once; a re-run only checks the keys this setup
               owns and adds missing ones, keeping every operator setting. The operator
               configs and daemon environment (written once, never rewritten), and the
               `orca` and `orca-acp` wrappers.
5. stage       `orca-release.py stage --bundle VERSION`: the signed server bundle, verified
               against its pinned signer before a byte of it is unpacked (#876). Then the
               receipt, `<root>/receipts/vVERSION.json`: the release record's and runtime's
               digests, which a later run checks before it trusts the release.
6. select      `current` -> `releases/vVERSION`, only when there is none yet.
7. unit        The systemd user unit, enabled; lingering, so it runs without a login.
8. start       The unit started, and the daemon's hello checked against the release.

It prints one `orca-setup: {json}` line per step, `{"step", "result", "detail"}` with result
`ok` (already as it should be), `changed`, `repaired`, `warning`, `refused` or `failed`, and
one last `{"done": ...}` line. Nothing else it prints is meant to be read. A run that fails
after it created `current` or the unit takes both back, so a failed first setup leaves no
half-written link and no enabled unit.

`--inspect` changes nothing: it runs the platform, inventory and existing checks and prints
one `{"inspected": true, "account", "root", "current"}` line, which the app and CLI show the
person, with the server's host keys, before they confirm the setup (#881 review).

Run here: `python3 orca-server-setup.py --version X.Y.Z --adapter orca-release.py`. The app
sends it over ssh as `python3 - ...` with the adapter embedded (`EMBEDDED_ADAPTER`). No
third-party modules.
"""
import argparse
import base64
import getpass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time

SETUP_MARKER = "orca-server-setup"
SERVICE = "orca.service"
HEALTH_SECONDS = 60
VERSION_RE = r"\d+\.\d+\.\d+(?:-(?:rc|beta|alpha)\.\d+)?"
RECONCILE = ("Reconcile it separately with orca-release.py (docs/UPDATING.md): this setup starts only a "
             "release it staged and verified itself, for exactly the version asked for.")
# deployment.json keys this setup owns: checked on every run, never left to drift.
OWNED_KEYS = ("root", "service", "userService", "setup", "url")
GUIDANCE = ("Migrate it by hand first (docs/UPDATING.md, \"Debian: inventory before migration\"); "
            "this setup never takes over an installation it did not make.")
# What an ORCA process or launcher looks like, as orca-release.py's own inventory reads it.
ORCA_PROCESS = re.compile(r"(?:orca-daemon|packages/cli/(?:dist|src)/main\.|orca\s+(?:acp|run|program|serve))")
ORCA_LAUNCHER = re.compile(rb"orca-release\.py|orca-daemon\.mjs|packages/cli/dist/main\.js|@orca/cli")


class Refused(Exception):
    """Something only the person can resolve: nothing was changed for it."""


def report(step, result, detail=""):
    print("orca-setup: " + json.dumps({"step": step, "result": result, "detail": detail}, sort_keys=True), flush=True)


def write_file(path, text, mode):
    """Atomically, with `mode`. Returns True when the file changed."""
    path = Path(path)
    if path.is_file() and not path.is_symlink() and path.read_text() == text and (path.stat().st_mode & 0o777) == mode:
        return False
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    os.chmod(temporary, mode)
    os.replace(temporary, path)
    return True


def file_digest(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class Setup:
    def __init__(self, root, version, port, adapter_source, bundle=None, home=None, systemctl=None,
                 expect_account=None):
        self.home = Path(home or os.path.expanduser("~"))
        self.root = Path(root) if root else self.home / ".local" / "share" / "orca-server"
        self.version = version
        self.port = port
        self.adapter_source = adapter_source
        self.bundle = bundle
        self.unit_dir = self.home / ".config" / "systemd" / "user"
        self.unit = self.unit_dir / SERVICE
        self.systemctl_bin = systemctl or "systemctl"
        self.proc = Path("/proc")
        self.expect_account = expect_account
        # What this run created, to take back if a later step fails.
        self.created_current = False
        self.created_unit = False
        self.enabled_unit = False

    # -- helpers ---------------------------------------------------------------------------

    def systemctl(self, *args, check=True):
        result = subprocess.run([self.systemctl_bin, "--user", *args], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        if check and result.returncode != 0:
            raise RuntimeError(f"systemctl --user {' '.join(args)} failed: {result.stderr.strip()[:300]}")
        return result

    def ours(self, path):
        """A file this setup wrote: it carries the marker."""
        try:
            return SETUP_MARKER in Path(path).read_text(errors="replace")
        except OSError:
            return False

    @property
    def marker(self):
        return self.root / ".orca-setup.json"

    @property
    def manifest(self):
        return self.root / "deployment.json"

    @property
    def adapter(self):
        return self.root / "orca-release.py"

    @property
    def release(self):
        return self.root / "releases" / ("v" + self.version)

    @property
    def receipt(self):
        return self.root / "receipts" / ("v" + self.version + ".json")

    def load_adapter(self):
        spec = importlib.util.spec_from_file_location("orca_release_adapter", self.adapter)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    # -- steps -----------------------------------------------------------------------------

    def check_platform(self):
        if platform.system() != "Linux" or platform.machine() != "x86_64":
            raise Refused(f"This machine is {platform.system()} {platform.machine()}; the ORCA server runs on Linux x64.")
        if sys.version_info < (3, 8):
            raise Refused("The ORCA server needs Python 3.8 or newer.")
        if not Path("/proc/self/cmdline").is_file():
            raise Refused("The ORCA server needs /proc to check what runs.")
        if shutil.which(self.systemctl_bin) is None or self.systemctl("show-environment", check=False).returncode != 0:
            raise Refused("No systemd user manager answered (systemctl --user). The ORCA server runs as a user service.")
        report("platform", "ok", f"Linux x64, Python {platform.python_version()}")

    def check_inventory(self):
        found = []
        # Our own directory, or one this setup never made.
        if self.root.exists() and not self.marker.is_file():
            if not self.root.is_dir() or any(self.root.iterdir()):
                found.append(f"{self.root} exists and was not made by this setup")
        # A user unit for ORCA other than ours.
        for unit in sorted(self.unit_dir.glob("*orca*")) if self.unit_dir.is_dir() else []:
            if unit.name != SERVICE or not self.ours(unit):
                found.append(f"systemd user unit {unit.name}")
        # A launcher on PATH that runs ORCA, other than our wrapper.
        for directory in os.environ.get("PATH", "").split(os.pathsep):
            for name in ("orca", "orca-acp"):
                candidate = Path(directory) / name
                try:
                    head = candidate.read_bytes()[:65536] if candidate.is_file() else b""
                except OSError:
                    continue
                if ORCA_LAUNCHER.search(head) and str(self.root) + "/orca-release.py" not in head.decode(errors="replace"):
                    found.append(f"launcher {candidate}")
        # An ORCA process of this user that is not the managed daemon of this root.
        releases = str(self.root / "releases") + "/"
        for directory in self.proc.iterdir():
            if not directory.name.isdigit() or int(directory.name) == os.getpid():
                continue
            try:
                if directory.stat().st_uid != os.getuid():
                    continue
                args = (directory / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError:
                raise Refused("Cannot read this user's processes, so an unmanaged ORCA cannot be ruled out.") from None
            if ORCA_PROCESS.search(args) and releases not in args and SETUP_MARKER not in args:
                found.append(f"process {directory.name} ({args.strip()[:120]})")
        if found:
            raise Refused("Found an ORCA installation this setup did not make: " + "; ".join(found) + ". " + GUIDANCE)
        report("inventory", "ok", "no unmanaged ORCA installation")

    def check_account(self):
        account = getpass.getuser()
        if self.expect_account is not None and account != self.expect_account:
            raise Refused(f"This connection runs as {account}, not {self.expect_account} as confirmed. Nothing was changed.")
        report("account", "ok", account)

    def release_digests(self, release):
        """What a receipt vouches for: the release record and the runtime it names."""
        record = json.loads((release / ".orca-release.json").read_text())
        if record.get("source") != "bundle" or record.get("version") != self.version:
            raise Refused(f"{release} is not the server bundle for v{self.version}. " + RECONCILE)
        node, entry = release / record.get("node", ""), release / record.get("entry", "")
        for path in (node, entry):
            if path.is_symlink() or not path.is_file() or path.resolve().parent != path.parent.resolve() \
                    or not str(path.resolve()).startswith(str(release.resolve()) + os.sep):
                raise Refused(f"{release} names a runtime outside itself. " + RECONCILE)
        return {"record": file_digest(release / ".orca-release.json"), "node": file_digest(node),
                "entry": file_digest(entry)}

    def verify_release(self):
        """`releases/vVERSION` is the release this setup staged from the verified bundle:
        confined to the release directory, not a link, and its receipt still matches."""
        release, releases = self.release, self.root / "releases"
        if releases.is_symlink() or release.is_symlink() or not release.is_dir() \
                or release.resolve().parent != releases.resolve() \
                or releases.resolve().parent != self.root.resolve():
            raise Refused(f"{release} is not a directory of {releases}. " + RECONCILE)
        try:
            receipt = json.loads(self.receipt.read_text())
        except (OSError, ValueError):
            raise Refused(f"{release} has no receipt from this setup. " + RECONCILE) from None
        try:
            digests = self.release_digests(release)
        except (OSError, ValueError):
            raise Refused(f"{release} has no readable release record. " + RECONCILE) from None
        if receipt != {"by": SETUP_MARKER, "version": self.version, "release": str(release), **digests}:
            raise Refused(f"{release} changed since this setup staged and verified it. " + RECONCILE)

    def write_receipt(self):
        receipt = {"by": SETUP_MARKER, "version": self.version, "release": str(self.release),
                   **self.release_digests(self.release)}
        self.receipt.parent.mkdir(mode=0o700, exist_ok=True)
        write_file(self.receipt, json.dumps(receipt, sort_keys=True) + "\n", 0o600)

    def check_existing(self):
        """Read only. What an earlier run left is accepted only as exactly this setup's."""
        current = self.root / "current"
        if os.path.lexists(current):
            target = current.resolve()
            if target != self.release.resolve() or not current.is_symlink():
                name = target.name if target.parent == (self.root / "releases").resolve() else str(target)
                raise Refused(f"{current} is {name}, not v{self.version}. " + RECONCILE)
            self.verify_release()
            report("existing", "ok", f"v{self.version} is selected and verified")
        elif os.path.lexists(self.release):
            self.verify_release()
            report("existing", "ok", f"v{self.version} is staged and verified")
        else:
            report("existing", "ok", "nothing selected yet")

    def install_adapter(self):
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not self.marker.is_file():
            write_file(self.marker, json.dumps({"by": SETUP_MARKER, "version": 1}) + "\n", 0o600)
        changed = write_file(self.adapter, self.adapter_source, 0o755)
        digest = hashlib.sha256(self.adapter_source.encode()).hexdigest()[:12]
        report("adapter", "changed" if changed else "ok", f"orca-release.py sha256:{digest}")

    def install_files(self):
        root, adapter = self.root, self.adapter
        manifest = {
            "root": str(root), "repository": "cschadewitz/Project_Orca", "cwd": str(root),
            "cliConfig": str(root / "orca.config.yaml"), "daemonConfig": str(root / "orca.config.yaml"),
            "acpConfig": str(root / "orca-kepler.config.yaml"), "url": f"http://127.0.0.1:{self.port}",
            "service": SERVICE, "userService": True,
            # This setup made every launcher there is (it refused any other): the inventory holds.
            "launchAudit": "all-cli-acp-and-daemon-launches-migrated",
            "setup": SETUP_MARKER,
        }
        changed, repaired = [], []
        if os.path.lexists(self.manifest):
            # Written once. After that the operator's: a re-run checks the keys this setup
            # owns, adds what is missing, and keeps every other setting as the operator left it.
            try:
                existing = json.loads(self.manifest.read_text())
            except (OSError, ValueError):
                raise Refused(f"{self.manifest} is not readable JSON. Repair it by hand.") from None
            if self.manifest.is_symlink() or not isinstance(existing, dict) or existing.get("setup") != SETUP_MARKER:
                raise Refused(f"{self.manifest} was not written by this setup. " + GUIDANCE)
            if existing.get("url") != manifest["url"]:
                raise Refused(f"This server already listens on {existing.get('url')}; set up with that port.")
            for key in OWNED_KEYS:
                if key in existing and existing[key] != manifest[key]:
                    raise Refused(f"{self.manifest} sets {key} to {existing[key]!r}, not {manifest[key]!r}. "
                                  "Repair it by hand; setup does not rewrite it.")
            missing = [key for key in manifest if key not in existing]
            if missing:
                write_file(self.manifest, json.dumps({**existing, **{key: manifest[key] for key in missing}},
                                                     indent=2) + "\n", 0o600)
                repaired.append("deployment.json (" + ", ".join(missing) + ")")
        else:
            write_file(self.manifest, json.dumps(manifest, indent=2) + "\n", 0o600)
            changed.append("deployment.json")
        config = (f"# Written by {SETUP_MARKER} (#881). Yours to edit: setup never rewrites it.\n"
                  "workflows: ['${ORCA_RELEASE}/workflows/**/*.yaml']\n"
                  "templates: ['${ORCA_RELEASE}/templates/**/*.md']\n")
        for name in ("orca.config.yaml", "orca-kepler.config.yaml"):
            if not (root / name).exists():
                write_file(root / name, config, 0o600)
                changed.append(name)
        if not (root / "daemon.env").exists():
            write_file(root / "daemon.env", f"# {SETUP_MARKER}: the daemon's environment (agent PATH, credentials).\n"
                       "PATH=/usr/local/bin:/usr/bin:/bin\n", 0o600)
            changed.append("daemon.env")
        for name, kind in (("orca", "cli"), ("orca-acp", "acp")):
            wrapper = (f"#!/bin/sh\n# {SETUP_MARKER}: the managed ORCA launcher.\n"
                       f"exec /usr/bin/env python3 '{adapter}' --deployment '{self.manifest}' {kind} \"$@\"\n")
            if write_file(root / name, wrapper, 0o755):
                changed.append(name)
        report("files", "changed" if changed else ("repaired" if repaired else "ok"), ", ".join(changed + repaired))

    def stage(self):
        release = self.release
        adapter = self.load_adapter()
        if os.path.lexists(release):
            self.verify_release()
            adapter.metadata(release)
            report("stage", "ok", f"v{self.version} already staged and verified")
            return
        result = self.run_stage(str(self.bundle) if self.bundle else self.version)
        if result.returncode != 0:
            reason = [line for line in result.stderr.splitlines() if line.startswith("orca-release: ")]
            raise RuntimeError("Staging the signed server bundle failed: "
                               + (reason[-1][len("orca-release: "):] if reason else "see orca-release.py"))
        adapter.metadata(release)
        self.write_receipt()
        report("stage", "changed", f"v{self.version} staged from the signed bundle")

    def run_stage(self, source):
        """The adapter's own `stage --bundle`: the signed bundle, verified before it is unpacked."""
        return subprocess.run([sys.executable, str(self.adapter), "--deployment", str(self.manifest),
                               "stage", "--bundle", source], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def check_health(self):
        """The exact release `current` names, answering as the unit's own process: the
        adapter's health check (version, protocol, capabilities, admission barrier). A first
        start creates its store and credential file, so it gets a minute."""
        deployment = self.load_adapter().Deployment(self.manifest)
        deadline = time.monotonic() + HEALTH_SECONDS
        while True:
            try:
                deployment.health((self.root / "current").resolve())
                return
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)

    def select(self):
        current = self.root / "current"
        if os.path.lexists(current):
            # check_existing accepted it: exactly this version's verified release.
            report("select", "ok", f"current is v{self.version}")
            return
        self.load_adapter().select(self.root, self.release.resolve())
        self.created_current = True
        report("select", "changed", f"current -> v{self.version}")

    def install_unit(self):
        unit = (f"# {SETUP_MARKER}: the managed ORCA daemon (docs/UPDATING.md).\n"
                "[Unit]\nDescription=ORCA managed daemon\nAfter=network.target\n"
                f"[Service]\nType=simple\nWorkingDirectory={self.root}\nEnvironmentFile={self.root}/daemon.env\n"
                f"ExecStart=/usr/bin/env python3 {self.adapter} --deployment {self.manifest} daemon\n"
                "Restart=on-failure\nTimeoutStopSec=20\n[Install]\nWantedBy=default.target\n")
        self.unit_dir.mkdir(parents=True, exist_ok=True)
        existed = self.unit.exists()
        changed = write_file(self.unit, unit, 0o644)
        self.created_unit = not existed
        if changed:
            self.systemctl("daemon-reload")
        enabled = self.systemctl("is-enabled", SERVICE, check=False).stdout.strip() == "enabled"
        if not enabled:
            self.systemctl("enable", SERVICE)
            self.enabled_unit = True
        report("unit", "changed" if changed or not enabled else "ok", SERVICE)
        # Without lingering the user manager, and the daemon, stop at logout.
        user = os.environ.get("USER") or str(os.getuid())
        linger = subprocess.run(["loginctl", "show-user", user, "--property=Linger", "--value"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        if linger.returncode == 0 and linger.stdout.strip() == "yes":
            report("linger", "ok", "the daemon runs without a login")
        elif subprocess.run(["loginctl", "enable-linger", user], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL).returncode == 0:
            report("linger", "changed", "the daemon runs without a login")
        else:
            report("linger", "warning", "could not enable lingering: the daemon stops when this user logs out "
                   "(an administrator can run: loginctl enable-linger " + user + ")")

    def start(self):
        active = self.systemctl("is-active", SERVICE, check=False).stdout.strip() == "active"
        if not active:
            self.systemctl("start", SERVICE)
        self.check_health()
        report("start", "ok" if active else ("changed" if self.enabled_unit or self.created_current else "repaired"),
               f"daemon healthy on 127.0.0.1:{self.port}")

    def take_back(self):
        """After a failure: what this run created goes, so nothing half-made stays enabled."""
        if self.enabled_unit or self.created_unit:
            self.systemctl("disable", "--now", SERVICE, check=False)
        if self.created_unit:
            self.unit.unlink(missing_ok=True)
            self.systemctl("daemon-reload", check=False)
        if self.created_current:
            (self.root / "current").unlink(missing_ok=True)

    def inspect(self):
        """Read only: what the person confirms before anything is changed."""
        step = "platform"
        try:
            for step, action in (("platform", self.check_platform), ("inventory", self.check_inventory),
                                 ("existing", self.check_existing)):
                action()
        except Refused as error:
            report(step, "refused", str(error))
            return 2
        except Exception as error:  # noqa: BLE001 - every failure is a typed result
            report(step, "failed", str(error)[:2000])
            return 1
        current = self.root / "current"
        print("orca-setup: " + json.dumps({"inspected": True, "account": getpass.getuser(), "root": str(self.root),
                                           "current": self.version if os.path.lexists(current) else None},
                                          sort_keys=True), flush=True)
        return 0

    def run(self):
        step = "account"
        try:
            for step, action in (("account", self.check_account), ("platform", self.check_platform),
                                 ("inventory", self.check_inventory), ("existing", self.check_existing),
                                 ("adapter", self.install_adapter), ("files", self.install_files),
                                 ("stage", self.stage), ("select", self.select), ("unit", self.install_unit),
                                 ("start", self.start)):
                action()
        except Refused as error:
            report(step, "refused", str(error))
            return 2
        except Exception as error:  # noqa: BLE001 - every failure is a typed result
            self.take_back()
            report(step, "failed", str(error)[:2000])
            return 1
        print("orca-setup: " + json.dumps({"done": True, "root": str(self.root), "command": str(self.root / "orca"),
                                           "version": (self.root / "current").resolve().name[1:], "port": self.port},
                                          sort_keys=True), flush=True)
        return 0


def main(argv, embedded=None):
    parser = argparse.ArgumentParser(prog="orca-server-setup")
    parser.add_argument("--version", required=True)
    parser.add_argument("--root")
    parser.add_argument("--port", type=int, default=6722)
    parser.add_argument("--bundle", help="a directory holding the three server bundle files")
    parser.add_argument("--adapter", help="orca-release.py to install (default: the embedded one)")
    parser.add_argument("--inspect", action="store_true", help="check only, change nothing")
    parser.add_argument("--expect-account", help="refuse to run as any other account")
    options = parser.parse_args(argv)
    if not re.fullmatch(VERSION_RE, options.version):
        parser.error("--version takes X.Y.Z or X.Y.Z-rc.N")
    if options.root and not os.path.isabs(options.root):
        parser.error("--root must be absolute")
    if not 1024 <= options.port <= 65535:
        parser.error("--port must be 1024-65535")
    if options.adapter:
        source = Path(options.adapter).read_text()
    elif embedded is not None:
        source = base64.b64decode(embedded).decode()
    else:
        parser.error("no adapter: pass --adapter orca-release.py")
    setup = Setup(options.root, options.version, options.port, source, options.bundle,
                  expect_account=options.expect_account)
    return setup.inspect() if options.inspect else setup.run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], globals().get("EMBEDDED_ADAPTER")))
