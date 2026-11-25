#!/usr/bin/env python3
"""Turn a reachable Linux machine into a managed ORCA server, in one step (#881).

Every step is idempotent: on a machine this set up before it verifies, and repairs what is
missing or stopped, instead of installing again. It installs exactly what the bootstrap in
docs/UPDATING.md describes, with the managed adapter (`orca-release.py`) doing the staging:

0. account     With `--expect-account`, refuses to run as any other effective account than
               the one the person confirmed.
   confirmed   Under the fence, before any change: with `--expect-root` and
               `--expect-current`, refuses unless the canonical setup directory, and whether
               this is a first install (`none`) or a repair of VERSION, are still exactly what
               the inspection showed and the person confirmed.
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
               against its pinned signer before a byte of it is unpacked (#876), staged into
               this run's own scratch (`<root>/.setup-stage-*`, named in the journal) and,
               holding the update lock, published into `releases/` with its receipt. Recovery
               only ever removes that scratch, never a shared release. The receipt, `<root>/receipts/vVERSION.json`: a digest of the whole release (every
               path, kind, mode and content: runtime, entry, helpers, assets, workflows,
               templates), which a later run checks before it trusts the release.
6. select      `current` -> `releases/vVERSION`, only when there is none yet.
7. unit        The systemd user unit, enabled; lingering, so it runs without a login.
8. start       The unit started, and the daemon's hello checked against the release.

Each run holds the deployment's admission lock exclusively from its first change to its end
(and refuses while an update holds the update lock, or an interrupted activation is pending),
so a second setup, an update, a recovery or a CLI launch cannot run inside it. Before its
first change it records the state it found, the unit file, whether the unit was enabled and
active, `current` and lingering, in `<root>/.setup-journal.json`. A run that fails puts all of
that back, checks that it is back, and reports a `cleanup` step: `ok`, or `failed` with what it
could not confirm. A run that never got to (the session was cut, say) leaves the journal, and
the next run puts that state back first (`recover`), before anything else.

It prints one `orca-setup: {json}` line per step, `{"step", "result", "detail"}` with result
`ok` (already as it should be), `changed`, `repaired`, `warning`, `refused` or `failed`, and
one last `{"done": ...}` line. Nothing else it prints is meant to be read. A failed first
setup leaves no half-written link and no enabled unit. Output to a session that went away is
dropped, never fatal: the run still finishes, or puts things back.

`--inspect` changes nothing: it runs the platform, inventory and existing checks and prints
one `{"inspected": true, "account", "root", "current"}` line, which the app and CLI show the
person, with the server's host keys, before they confirm the setup (#881 review).

Run here: `python3 orca-server-setup.py --version X.Y.Z --adapter orca-release.py`. The app
sends it over ssh as `python3 - ...` with the adapter embedded (`EMBEDDED_ADAPTER`). No
third-party modules.
"""
import argparse
import fcntl
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

SETUP_MARKER = "orca-server-setup"

# A new server's operator config, after the marker line. The daemon refuses to start while a
# listed workflow names an agent it cannot resolve, and a new server has no agents yet, so it
# lists no workflows: the release's own (ai-sdlc, program) need agents for their roles. The
# operator adds agents and the workflows parents delegate to (docs/MULTI-MACHINE.md).
SERVER_CONFIG = (
    "# Add the agents this server runs, and the workflows other machines delegate to\n"
    "# (docs/MULTI-MACHINE.md). The release's own workflows need agents for their roles;\n"
    "# once those agents are declared, they can be listed with:\n"
    "#   workflows: ['${ORCA_RELEASE}/workflows/**/*.yaml']\n"
    "workflows: []\n"
    "templates: ['${ORCA_RELEASE}/templates/**/*.md']\n"
)
SERVICE = "orca.service"
HEALTH_SECONDS = 60
VERSION_RE = r"\d+\.\d+\.\d+(?:-(?:rc|beta|alpha)\.\d+)?"
RECONCILE = ("Reconcile it separately with orca-release.py (docs/UPDATING.md): this setup starts only a "
             "release it staged and verified itself, for exactly the version asked for.")
# deployment.json keys this setup owns: checked on every run, never left to drift.
OWNED_KEYS = ("root", "service", "userService", "setup", "url")
# This setup's staging scratch, a direct child of the root: the only thing recovery removes.
SCRATCH_PREFIX = ".setup-stage-"
# The files this setup writes in its directory, and their modes: journaled, so a failed run
# puts each back as it found it (or removes it, if this run created it).
OWNED_FILES = (("orca-release.py", 0o755), ("deployment.json", 0o600), ("orca", 0o755), ("orca-acp", 0o755),
               ("orca.config.yaml", 0o600), ("orca-kepler.config.yaml", 0o600), ("daemon.env", 0o600))
GUIDANCE = ("Migrate it by hand first (docs/UPDATING.md, \"Debian: inventory before migration\"); "
            "this setup never takes over an installation it did not make.")
# What an ORCA process or launcher looks like, as orca-release.py's own inventory reads it.
ORCA_PROCESS = re.compile(r"(?:orca-daemon|packages/cli/(?:dist|src)/main\.|orca\s+(?:acp|run|program|serve))")
ORCA_LAUNCHER = re.compile(rb"orca-release\.py|orca-daemon\.mjs|packages/cli/dist/main\.js|@orca/cli")


class Refused(Exception):
    """Something only the person can resolve: nothing was changed for it."""


def emit(value):
    """One line for the client. A session that went away loses the line, not the run."""
    try:
        print("orca-setup: " + json.dumps(value, sort_keys=True), flush=True)
    except (BrokenPipeError, OSError):
        try:
            sys.stdout = open(os.devnull, "w")
        except OSError:
            pass


def report(step, result, detail=""):
    emit({"step": step, "result": result, "detail": detail})


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


def snapshot(path):
    """A file as rollback restores it: its text and mode, or None when absent. Links and
    other kinds are refused before any change (`existing`), so they never get here."""
    path = Path(path)
    if not path.is_file() or path.is_symlink():
        return None
    return {"text": path.read_text(), "mode": path.stat().st_mode & 0o7777}


class Setup:
    def __init__(self, root, version, port, adapter_source, bundle=None, home=None, systemctl=None,
                 expect_account=None, expect_root=None, expect_current=None):
        # The effective account's own home, not $HOME: what the confirmation names is canonical.
        self.home = Path(home or pwd.getpwuid(os.geteuid()).pw_dir)
        self.root = Path(os.path.realpath(root if root else self.home / ".local" / "share" / "orca-server"))
        self.version = version
        self.port = port
        self.adapter_source = adapter_source
        self.bundle = bundle
        self.unit_dir = self.home / ".config" / "systemd" / "user"
        self.unit = self.unit_dir / SERVICE
        self.systemctl_bin = systemctl or "systemctl"
        self.proc = Path("/proc")
        self.expect_account = expect_account
        self.expect_root = expect_root
        # "none" (a first install) or the version a repair expects to find selected.
        self.expect_current = expect_current
        self.loginctl_bin = "loginctl"
        self.fence = None
        self.before = None
        self.staging = None
        self.writer = None
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
    def journal(self):
        return self.root / ".setup-journal.json"

    @property
    def user(self):
        """The effective account, canonically: what runs every step, owns every file and lingers."""
        try:
            return pwd.getpwuid(os.geteuid()).pw_name
        except KeyError:
            return str(os.geteuid())

    def pending_journal(self):
        """What an interrupted run recorded before its first change, or None. Read only."""
        if not os.path.lexists(self.journal):
            return None
        try:
            journal = json.loads(self.journal.read_text())
            if journal.get("by") != SETUP_MARKER or not isinstance(journal.get("before"), dict):
                raise ValueError
        except (OSError, ValueError, AttributeError):
            raise Refused(f"{self.journal} is unreadable: inspect the server and remove it by hand.") from None
        # Recovery belongs to that transaction: the same operation, version and directory.
        if (journal.get("operation"), journal.get("version"), journal.get("root")) != ("setup", self.version, str(self.root)):
            raise Refused(f"An interrupted setup of v{journal.get('version')} is pending here. Run that setup again "
                          "to finish it, or reconcile by hand; this run changes nothing.")
        return journal

    def lifecycle(self):
        """What this run would be: a first install (`none`), or a repair of the selected version.
        With an interrupted run's journal, as it will be once that is put back: a link only that
        run made does not make this a repair."""
        journal = self.pending_journal()
        if journal is not None:
            return self.version if journal["before"].get("current") is not None else "none"
        return self.version if os.path.lexists(self.root / "current") else "none"

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
                # Its pid only: a command line can hold anything, secrets included.
                found.append(f"process {directory.name}")
        if found:
            raise Refused("Found an ORCA installation this setup did not make: " + "; ".join(found) + ". " + GUIDANCE)
        report("inventory", "ok", "no unmanaged ORCA installation")

    def check_account(self):
        account = self.user
        if self.expect_account is not None and account != self.expect_account:
            raise Refused(f"This connection runs as {account}, not {self.expect_account} as confirmed. Nothing was changed.")
        report("account", "ok", account)

    def release_digests(self, release):
        """What a receipt vouches for: the whole release, every file the service may consume
        (runtime, entry, helpers, assets, workflows, templates), by path, kind, mode and
        content, and the record naming its runtime inside it."""
        record = json.loads((release / ".orca-release.json").read_text())
        if record.get("source") != "bundle" or record.get("version") != self.version:
            raise Refused(f"{release} is not the server bundle for v{self.version}. " + RECONCILE)
        node, entry = release / record.get("node", ""), release / record.get("entry", "")
        for path in (node, entry):
            if path.is_symlink() or not path.is_file() or path.resolve().parent != path.parent.resolve() \
                    or not str(path.resolve()).startswith(str(release.resolve()) + os.sep):
                raise Refused(f"{release} names a runtime outside itself. " + RECONCILE)
        manifest = []
        for directory, dirs, files in os.walk(release):
            dirs.sort()
            for name in sorted(dirs + files):
                path = Path(directory) / name
                relative = str(path.relative_to(release))
                if path.is_symlink():
                    manifest.append([relative, "link", os.readlink(path)])
                elif path.is_dir():
                    manifest.append([relative, "dir", path.stat().st_mode & 0o7777])
                elif path.is_file():
                    manifest.append([relative, "file", path.stat().st_mode & 0o7777, file_digest(path)])
                else:
                    raise Refused(f"{release} holds {relative}, which is not a file, link or directory. " + RECONCILE)
        tree = hashlib.sha256(json.dumps(manifest, separators=(",", ":")).encode()).hexdigest()
        return {"tree": tree, "entries": len(manifest)}

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

    def write_receipt(self, staged):
        """For `releases/vVERSION`, from what this run staged (digests are path-independent),
        before it is published there."""
        receipt = {"by": SETUP_MARKER, "version": self.version, "release": str(self.release),
                   **self.release_digests(staged)}
        self.receipt.parent.mkdir(mode=0o700, exist_ok=True)
        write_file(self.receipt, json.dumps(receipt, sort_keys=True) + "\n", 0o600)

    def wanted_manifest(self):
        root = self.root
        return {
            "root": str(root), "repository": "cschadewitz/Project_Orca", "cwd": str(root),
            "cliConfig": str(root / "orca.config.yaml"), "daemonConfig": str(root / "orca.config.yaml"),
            "acpConfig": str(root / "orca-kepler.config.yaml"), "url": f"http://127.0.0.1:{self.port}",
            "service": SERVICE, "userService": True,
            # This setup made every launcher there is (it refused any other): the inventory holds.
            "launchAudit": "all-cli-acp-and-daemon-launches-migrated",
            "setup": SETUP_MARKER,
        }

    def existing_manifest(self):
        """Read only: the deployment.json there is, if any, checked to be this setup's with the
        keys it owns as they must be. Refused before anything is written otherwise."""
        if not os.path.lexists(self.manifest):
            return None
        wanted = self.wanted_manifest()
        try:
            existing = json.loads(self.manifest.read_text())
        except (OSError, ValueError):
            raise Refused(f"{self.manifest} is not readable JSON. Repair it by hand.") from None
        if self.manifest.is_symlink() or not isinstance(existing, dict) or existing.get("setup") != SETUP_MARKER:
            raise Refused(f"{self.manifest} was not written by this setup. " + GUIDANCE)
        if existing.get("url") != wanted["url"]:
            raise Refused(f"This server already listens on {existing.get('url')}; set up with that port.")
        for key in OWNED_KEYS:
            if key in existing and existing[key] != wanted[key]:
                raise Refused(f"{self.manifest} sets {key} to {existing[key]!r}, not {wanted[key]!r}. "
                              "Repair it by hand; setup does not rewrite it.")
        return existing

    def check_existing(self):
        """Read only. What an earlier run left is accepted only as exactly this setup's."""
        self.pending_journal()  # an interrupted transaction of another version refuses first
        current = self.root / "current"
        # Rollback restores text and mode of regular files only: anything else is refused here,
        # before any change, rather than replaced by a plain file later.
        for path in [self.root / name for name, _mode in OWNED_FILES] + [self.unit]:
            if path.is_symlink() or (os.path.lexists(path) and not path.is_file()):
                raise Refused(f"{path} is not a plain file this setup wrote. Repair it by hand.")
        self.existing_manifest()
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

    def take_fence(self):
        """Hold the admission lock exclusively for the rest of the run: no second setup, no
        update activation or recovery, no CLI or ACP launch inside it. An update that holds the
        update lock (staging, say), or an interrupted activation, refuses instead."""
        # Checked before the fence creates anything, and again under it (`confirmed`).
        self.check_confirmed(quiet=True)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not self.marker.is_file():
            write_file(self.marker, json.dumps({"by": SETUP_MARKER, "version": 1}) + "\n", 0o600)
        fd = os.open(self.root / "admission.lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise Refused("Another setup, an update or an ORCA command is running on this server. "
                          "Run the setup again once it has finished.") from None
        self.fence = fd
        # The update lock too, held to the end: the adapter's own writers (stage, update, the
        # update timer) cannot publish a release, or anything else, inside this setup.
        writer = os.open(self.root / "update.lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(writer)
            raise Refused("An update is running on this server. Run the setup again once it has finished.") from None
        self.writer = writer
        if os.path.lexists(self.root / "activation.json"):
            raise Refused("An interrupted update is pending on this server: run orca-release.py recover first "
                          "(docs/UPDATING.md).")
        report("fence", "ok", "no setup or update is running")

    def release_fence(self):
        for name in ("writer", "fence"):
            fd = getattr(self, name, None)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)

    def state(self):
        """The service, link and lingering state this setup may change, as it is now."""
        def query(*args):
            return self.systemctl(*args, check=False).stdout.strip()
        linger = subprocess.run([self.loginctl_bin, "show-user", self.user, "--property=Linger", "--value"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        current = self.root / "current"
        return {
            "unit": snapshot(self.unit),
            "enabled": query("is-enabled", SERVICE) == "enabled",
            "active": query("is-active", SERVICE) == "active",
            "current": os.readlink(current) if os.path.islink(current) else None,
            "linger": (linger.stdout.strip() == "yes") if linger.returncode == 0 else None,
            "files": {name: snapshot(self.root / name) for name, _mode in OWNED_FILES},
        }

    def check_confirmed(self, quiet=False):
        """Under the fence, before any change: still the directory, account and kind of run
        (install or repair) the person confirmed from the inspection."""
        if self.expect_root is not None and str(self.root) != self.expect_root:
            raise Refused(f"The setup directory is {self.root}, not {self.expect_root} as confirmed. Nothing was changed.")
        if self.expect_current is not None and self.lifecycle() != self.expect_current:
            found = "a first install" if self.lifecycle() == "none" else f"a repair of v{self.version}"
            raise Refused(f"This is now {found}, not what was confirmed. Check the server again. Nothing was changed.")
        if not quiet:
            report("confirmed", "ok", f"{self.user}, {self.root}")

    def recover(self):
        """A run that ended before it could finish or put things back: back to what it found."""
        journal = self.pending_journal()
        if journal is None:
            report("recover", "ok", "no interrupted setup")
            return
        # Idempotent: cut off again, the journal stays and the next run does this again.
        problems = self.restore(journal["before"], journal.get("staging"))
        if problems:
            raise RuntimeError("Could not put back what an interrupted setup changed: " + "; ".join(problems))
        self.journal.unlink()
        report("recover", "repaired", "put back what an interrupted setup had changed")

    def begin(self):
        """The state found, recorded before the first change, so a failure can put it back."""
        self.before = self.state()
        self.staging = None
        self.write_journal()

    def write_journal(self):
        journal = {"by": SETUP_MARKER, "operation": "setup", "version": self.version, "root": str(self.root),
                   "before": self.before, **({"staging": self.staging} if self.staging else {})}
        write_file(self.journal, json.dumps(journal, sort_keys=True) + "\n", 0o600)

    def restore(self, before, staging=None):
        """Put the unit, link, lingering and setup's own files back as `before`, and remove
        the run's own staging scratch (`staging`), then check. Returns what could not be put
        back or confirmed (empty: all of it was). Shared artifacts, such as a release in
        `releases/`, are never removed here: their ownership is not this transaction's."""
        problems = []

        def attempt(what, action):
            try:
                action()
            except Exception as error:  # noqa: BLE001 - collected, reported
                problems.append(f"{what}: {str(error)[:200]}")

        now = self.state()
        # The link: only ever created by setup, so put back means removed or re-pointed.
        if now["current"] != before["current"]:
            def link():
                current = self.root / "current"
                if os.path.lexists(current):
                    current.unlink()
                if before["current"] is not None:
                    current.symlink_to(before["current"], target_is_directory=True)
            attempt("current", link)
        if now["active"] and not before["active"]:
            attempt("stop", lambda: self.systemctl("stop", SERVICE))
        if now["enabled"] != before["enabled"]:
            attempt("enable" if before["enabled"] else "disable",
                    lambda: self.systemctl("enable" if before["enabled"] else "disable", SERVICE))
        if now["unit"] != before["unit"]:
            def unit():
                if before["unit"] is None:
                    self.unit.unlink(missing_ok=True)
                else:
                    write_file(self.unit, before["unit"]["text"], before["unit"]["mode"])
                self.systemctl("daemon-reload")
            attempt("unit file", unit)
        if before["active"] and not now["active"]:
            attempt("start", lambda: self.systemctl("start", SERVICE))
        if before["linger"] is False and now["linger"] is True:
            def linger():
                if subprocess.run([self.loginctl_bin, "disable-linger", self.user], stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL).returncode != 0:
                    raise RuntimeError("loginctl disable-linger failed")
            attempt("lingering", linger)
        for name, mode in OWNED_FILES:
            if now["files"].get(name) != before.get("files", {}).get(name, now["files"].get(name)):
                def put(name=name):
                    prior = before["files"][name]
                    if prior is None:
                        (self.root / name).unlink(missing_ok=True)
                    else:
                        write_file(self.root / name, prior["text"], prior["mode"])
                attempt(name, put)
        scratch = self.owned_scratch(staging)
        if scratch is not None and os.path.lexists(scratch):
            attempt("staging scratch", lambda: shutil.rmtree(scratch))
        after = self.state()
        if scratch is not None and os.path.lexists(scratch):
            problems.append("the staging scratch is still there")
        for name, _mode in OWNED_FILES:
            if name in before.get("files", {}) and after["files"][name] != before["files"][name]:
                problems.append(f"{name} is not back as it was")
        for key in ("unit", "enabled", "active", "current", "linger"):
            if key == "linger" and before[key] is None:
                continue  # Unknown before: nothing to compare with, and setup leaves it be.
            if after[key] != before[key]:
                problems.append(f"{key} is not back as it was")
        return problems

    def install_adapter(self):
        changed = write_file(self.adapter, self.adapter_source, 0o755)
        digest = hashlib.sha256(self.adapter_source.encode()).hexdigest()[:12]
        report("adapter", "changed" if changed else "ok", f"orca-release.py sha256:{digest}")

    def install_files(self):
        root, adapter = self.root, self.adapter
        manifest = self.wanted_manifest()
        changed, repaired = [], []
        # Written once. After that the operator's: a re-run checks the keys this setup owns
        # (already, before any write: `existing`), adds what is missing, and keeps every other
        # setting as the operator left it.
        existing = self.existing_manifest()
        if existing is not None:
            missing = [key for key in manifest if key not in existing]
            if missing:
                write_file(self.manifest, json.dumps({**existing, **{key: manifest[key] for key in missing}},
                                                     indent=2) + "\n", 0o600)
                repaired.append("deployment.json (" + ", ".join(missing) + ")")
        else:
            write_file(self.manifest, json.dumps(manifest, indent=2) + "\n", 0o600)
            changed.append("deployment.json")
        config = f"# Written by {SETUP_MARKER} (#881). Yours to edit: setup never rewrites it.\n" + SERVER_CONFIG
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
        # Staged into this transaction's own scratch, named in the journal first: a run cut off
        # mid-stage leaves only that, which recovery removes. Then, still holding the update
        # lock, the receipt and the publication into `releases/`: no other writer can publish
        # there meanwhile, and nothing this run did not stage is ever receipted or removed.
        scratch = Path(tempfile.mkdtemp(prefix=SCRATCH_PREFIX, dir=self.root))
        self.staging = str(scratch)
        self.write_journal()
        result = self.run_stage(str(self.bundle) if self.bundle else self.version, scratch)
        if result.returncode != 0:
            reason = [line for line in result.stderr.splitlines() if line.startswith("orca-release: ")]
            raise RuntimeError("Staging the signed server bundle failed: "
                               + (reason[-1][len("orca-release: "):] if reason else "see orca-release.py"))
        staged = scratch / "releases" / release.name
        if staged.is_symlink() or not staged.is_dir():
            raise RuntimeError("Staging reported success but left no release")
        adapter.metadata(staged)
        self.write_receipt(staged)
        (self.root / "releases").mkdir(mode=0o700, exist_ok=True)
        if os.path.lexists(release):
            raise RuntimeError(f"{release} appeared while this setup staged it; nothing was published")
        os.rename(staged, release)
        adapter.sync_dir(release.parent)
        self.verify_release()
        shutil.rmtree(scratch)
        self.staging = None
        self.write_journal()
        report("stage", "changed", f"v{self.version} staged from the signed bundle")

    def run_stage(self, source, scratch):
        """The adapter's own `stage --bundle`, the signed bundle verified before it is unpacked,
        into `scratch`: a deployment rooted there, with the real one's configs, so the release
        it publishes is this transaction's and nobody else's until setup moves it in."""
        manifest = scratch / "deployment.json"
        write_file(manifest, json.dumps({**json.loads(self.manifest.read_text()), "root": str(scratch)}) + "\n", 0o600)
        return subprocess.run([sys.executable, str(self.adapter), "--deployment", str(manifest),
                               "stage", "--bundle", source], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def owned_scratch(self, staging):
        """A journal's staging scratch, only if it is one this setup makes: a direct child of
        the root with the scratch prefix. Anything else is never removed."""
        if not staging:
            return None
        path = Path(staging)
        if path.parent != self.root or not path.name.startswith(SCRATCH_PREFIX) or path.is_symlink():
            return None
        return path

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
        user = self.user
        # The journaled baseline decides: unknown when the run began means never touched,
        # even if a later query would answer, since rollback could not put it back.
        baseline = self.before["linger"] if self.before is not None else None
        if baseline is None:
            # Unknown: left exactly as it is, never changed blind.
            report("linger", "warning", "could not read lingering, so it was left as it is: if it is off, the "
                   "daemon stops when this user logs out (an administrator can run: loginctl enable-linger "
                   + user + ")")
        elif baseline is True:
            report("linger", "ok", "the daemon runs without a login")
        elif subprocess.run([self.loginctl_bin, "enable-linger", user], stdout=subprocess.DEVNULL,
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
        """After a failure: everything back as this run found it, checked, and reported as
        the `cleanup` step. Unconfirmed, the journal stays for the next run to finish it."""
        if self.before is None:
            return
        problems = self.restore(self.before, self.staging)
        if problems:
            report("cleanup", "failed", "Could not confirm everything is back as it was: " + "; ".join(problems)
                   + ". The next setup run puts it back first.")
            return
        self.journal.unlink(missing_ok=True)
        report("cleanup", "ok", "everything this run changed is back as it was")

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
        # As it will be once an interrupted run is put back: what a confirmation is for.
        emit({"inspected": True, "account": self.user, "root": str(self.root),
              "current": None if self.lifecycle() == "none" else self.version})
        return 0

    def run(self):
        # The session can end mid-run: finish, or put back, regardless.
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        step = "account"
        try:
            for step, action in (("account", self.check_account), ("platform", self.check_platform),
                                 ("inventory", self.check_inventory), ("fence", self.take_fence),
                                 ("confirmed", self.check_confirmed), ("recover", self.recover), ("existing", self.check_existing),
                                 ("journal", self.begin), ("adapter", self.install_adapter),
                                 ("files", self.install_files), ("stage", self.stage), ("select", self.select),
                                 ("unit", self.install_unit), ("start", self.start)):
                action()
            # Finished under the same fence: the journal is retired and the result read
            # before any other setup or update can start.
            step = "finish"
            done = {"done": True, "root": str(self.root), "command": str(self.root / "orca"), "account": self.user,
                    "version": (self.root / "current").resolve().name[1:], "port": self.port}
            self.journal.unlink(missing_ok=True)
        except Refused as error:
            report(step, "refused", str(error))
            self.take_back()
            return 2
        except Exception as error:  # noqa: BLE001 - every failure is a typed result
            report(step, "failed", str(error)[:2000])
            self.take_back()
            return 1
        finally:
            self.release_fence()
        emit(done)
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
    parser.add_argument("--expect-root", help="refuse unless the setup directory is exactly this")
    parser.add_argument("--expect-current", help="'none' for a first install, or the version a repair expects")
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
                  expect_account=options.expect_account, expect_root=options.expect_root,
                  expect_current=options.expect_current)
    return setup.inspect() if options.inspect else setup.run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], globals().get("EMBEDDED_ADAPTER")))
