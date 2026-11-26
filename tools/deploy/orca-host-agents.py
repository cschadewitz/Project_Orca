#!/usr/bin/env python3
"""Install and sign in agents on a managed ORCA server, from the client (#1236).

The client (`orca-cli remote agent`, the desktop app) sends this program over the profile's
pinned ssh as `python3 - COMMAND ...`, with the reviewed package lock embedded ahead of it
(`EMBEDDED_LOCK`, the `host-agents.lock.json` shipped beside this file), so nothing is installed
on the server to run it. It works only under the server root the setup made,
`~/.local/share/orca-server`, whose path must have no link in it.

  install --scratch DIR   Install the agent the client carried into DIR (a courier directory,
                          `~/.cache/orca-courier/<random>`). `agent.json` names the agent, its
                          version and each npm tarball; it must list exactly the lock's packages
                          for that agent and version, at exactly the lock's integrities, and
                          every tarball must hash to its sha512 there. Only then is each one
                          unpacked, member by member: one top directory, regular files and
                          directories only, canonical relative paths, no path twice, bounded
                          in entries and bytes. Into a staging directory that becomes
                          `agents/<agent>/<version>` in one rename, with a record of every file
                          (path, mode, size, sha256) beside it in `agents/<agent>/<version>.json`.
                          An install already there is accepted only if it is exactly this lock
                          entry and its tree is exactly its record; nothing else is replaced.
  status                  One line: each known agent's verified installed versions, any that
                          are not what was installed, and whether its profile is signed in.
  login --agent ID        Run the agent's own sign-in on its profile, with no terminal, so it
                          uses a device code: its link and code are printed for the client to
                          show the person, who approves it in their own browser. The credential
                          is written by the agent, on this server, in `agents/<agent>/home`.

Nothing installed is run (status, sign-in) unless its tree is exactly its record, every
directory from the root down is this account's own and closed to other writers, and the
profile is closed to everyone else (0700). npm never runs here, and no install script of any
package runs. Each agent's profile (`CODEX_HOME`, `COPILOT_HOME`) is its own directory under the
server root, never the account's everyday one. It prints `orca-agents: {json}` lines; anything
else is the agent's own output. No third-party modules.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

ROOT_FROM_HOME = ".local/share/orca-server"
COURIER = re.compile(r"^\.cache/orca-courier/[0-9a-f]{32}$")
VERSION = re.compile(r"^\d+\.\d+\.\d+$")
PACKAGE_PATH = re.compile(r"^node_modules/(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*"
                          r"(?:/node_modules/(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*)*$")
FILE = re.compile(r"^[0-9]{3}\.tgz$")
INTEGRITY = re.compile(r"^sha512-[A-Za-z0-9+/]{86}==$")
# A member's path inside a package: relative, no control character or backslash (with no empty,
# `.` or `..` component and already in normal form, checked beside it).
MEMBER = re.compile(r"^[^/\x00-\x1f\x7f\\][^\x00-\x1f\x7f\\]*$")
TARBALL_LIMIT = 1 << 30
UNPACKED_LIMIT = 4 << 30
try:
    ENTRY_LIMIT  # noqa: F821  (the client may set a lower one ahead of the program, for tests)
except NameError:
    ENTRY_LIMIT = 100_000

# What this program knows how to run, by agent id: the executable inside an install, the
# environment variable that names the agent's profile, its sign-in and its status check.
AGENTS = {
    "codex": {
        "binary": "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
        "home": "CODEX_HOME",
        "login": ["login", "--device-auth"],
        "status": ["login", "status"],
    },
    "copilot": {
        "binary": "node_modules/@github/copilot-linux-x64/copilot",
        "home": "COPILOT_HOME",
        "login": ["login", "--device-code"],
        "status": None,
    },
}


class Refused(Exception):
    """Nothing was changed for it."""


def emit(value):
    try:
        print("orca-agents: " + json.dumps(value, sort_keys=True), flush=True)
    except (BrokenPipeError, OSError):
        pass


def load_lock():
    """The reviewed lock: embedded by the client, or the file shipped beside this one."""
    try:
        text = base64.b64decode(EMBEDDED_LOCK).decode()  # noqa: F821
    except NameError:
        try:
            text = (Path(__file__).resolve().parent / "host-agents.lock.json").read_text()
        except (NameError, OSError):
            raise Refused("This program came without its package lock.")
    try:
        lock = json.loads(text)
    except ValueError:
        raise Refused("This program's package lock is unreadable.")
    if not isinstance(lock, dict) or lock.get("schema") != "orca-host-agents-lock/1" \
            or lock.get("platform") != "linux-x64" or not isinstance(lock.get("agents"), dict):
        raise Refused("This program's package lock is not one it understands.")
    entries = {}
    for agent, entry in lock["agents"].items():
        if agent not in AGENTS:
            continue
        if not isinstance(entry, dict) or not isinstance(entry.get("version"), str) \
                or not VERSION.match(entry["version"]) or not isinstance(entry.get("packages"), list):
            raise Refused(f"This program's package lock has an unusable entry for {agent}.")
        packages = {}
        for package in entry["packages"]:
            path = package.get("path") if isinstance(package, dict) else None
            integrity = package.get("integrity") if isinstance(package, dict) else None
            if not (isinstance(path, str) and PACKAGE_PATH.match(path)) or path in packages \
                    or not (isinstance(integrity, str) and INTEGRITY.match(integrity)):
                raise Refused(f"This program's package lock has an unusable package for {agent}.")
            packages[path] = integrity
        if not packages:
            raise Refused(f"This program's package lock has no packages for {agent}.")
        entries[agent] = {"version": entry["version"], "packages": packages}
    return entries


def server_root():
    home = Path(os.path.expanduser("~"))
    root = home / ROOT_FROM_HOME
    if not root.is_dir() or root.is_symlink():
        raise Refused("This machine is not an ORCA server yet: set it up first.")
    # No link anywhere on the way: the resolved path is the path.
    resolved = root.resolve(strict=True)
    if resolved != root or resolved.stat().st_uid != os.geteuid():
        raise Refused(f"{root} is not the ORCA server's own directory.")
    return root


def own_directory(path, create, mode=0o700):
    """`path` as a real directory of this account, closed to other writers; made when `create`."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        if not create:
            return False
        os.mkdir(path, mode)
        os.chmod(path, mode)
        info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise Refused(f"{path} is not a directory of the ORCA server's own.")
    return True


def private_profile(path, create):
    """The agent's profile: this account's own directory, closed to everyone else (0700)."""
    if not own_directory(path, create):
        return False
    if os.lstat(path).st_mode & 0o077:
        raise Refused(f"{path} is open to other accounts: it holds the agent's sign-in.")
    return True


def digest(path, algorithm):
    hasher = hashlib.new(algorithm)
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            hasher.update(block)
    return hasher


def integrity_of(path):
    return "sha512-" + base64.b64encode(digest(path, "sha512").digest()).decode()


def read_manifest(scratch, lock):
    """`agent.json` in the courier directory: exactly the lock's entry for that agent."""
    try:
        manifest = json.loads((scratch / "agent.json").read_text())
    except (OSError, ValueError):
        raise Refused("The carried agent has no readable agent.json.")
    if not isinstance(manifest, dict):
        raise Refused("The carried agent.json is malformed.")
    agent, version, packages = manifest.get("agent"), manifest.get("version"), manifest.get("packages")
    if agent not in AGENTS or agent not in lock:
        raise Refused("The carried agent is not one this server can install.")
    if version != lock[agent]["version"]:
        raise Refused(f"The carried {agent} is not the version this ORCA pins ({lock[agent]['version']}).")
    if not isinstance(packages, list):
        raise Refused("The carried agent lists no packages.")
    listed, files = {}, set()
    for package in packages:
        if not isinstance(package, dict):
            raise Refused("The carried agent's package list is malformed.")
        path, name, integrity = package.get("path"), package.get("file"), package.get("integrity")
        if not (isinstance(name, str) and FILE.match(name)) or name in files or path in listed:
            raise Refused("The carried agent's package list is malformed.")
        files.add(name)
        listed[path] = (name, integrity)
    if {path: integrity for path, (_, integrity) in listed.items()} != lock[agent]["packages"]:
        raise Refused(f"The carried {agent} is not exactly the packages this ORCA pins. Nothing was changed.")
    return agent, version, [{"path": path, "file": name, "integrity": integrity}
                            for path, (name, integrity) in sorted(listed.items())]


def unpack(tarball, destination, prefix, seen, budget):
    """One npm tarball into `destination`, without its top directory, checked member by member
    before anything is written. `seen` holds every output path of the install so far (relative to
    the install, under `prefix`); `budget` is [entries left, bytes left]."""
    members, top = [], None
    with tarfile.open(tarball, "r:gz") as archive:
        for member in archive:
            budget[0] -= 1
            if budget[0] < 0:
                raise Refused(f"The carried agent has more than {ENTRY_LIMIT} entries.")
            head, _, rest = member.name.partition("/")
            if top is None:
                top = head
            if head != top:
                raise Refused(f"{tarball.name} is not one package directory.")
            if not rest and member.isdir():
                continue
            if not (member.isfile() or member.isdir()):
                raise Refused(f"{tarball.name} holds a link or special file ({member.name}).")
            rest = rest.rstrip("/") if member.isdir() else rest
            if not MEMBER.match(rest) or posixpath.normpath(rest) != rest or len(rest) > 1000 \
                    or any(part in (".", "..") for part in rest.split("/")):
                raise Refused(f"{tarball.name} holds a path that is not plain ({member.name!r}).")
            output = f"{prefix}/{rest}"
            if output in seen:
                raise Refused(f"{tarball.name} writes {output} twice.")
            seen.add(output)
            budget[1] -= max(member.size, 0)
            if budget[1] < 0:
                raise Refused("The carried agent unpacks to more than 4 GiB.")
            member.name = rest
            member.mode = 0o755 if member.isdir() or member.mode & 0o111 else 0o644
            members.append(member)
        archive.extractall(destination, members=members, filter="data")


def tree_record(top):
    """Every directory and file under `top`: path, kind, mode, and for a file its size and sha256.
    Refuses anything that is not a plain directory or file of this account, closed to other writers."""
    record = []
    for dirpath, dirnames, filenames in os.walk(top, followlinks=False):
        dirnames.sort()
        for name in sorted(dirnames) + sorted(filenames):
            path = os.path.join(dirpath, name)
            info = os.lstat(path)
            relative = os.path.relpath(path, top)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise Refused(f"{path} is open to other writers or not this account's own.")
            mode = stat.S_IMODE(info.st_mode)
            if stat.S_ISDIR(info.st_mode):
                record.append([relative, "dir", mode])
            elif stat.S_ISREG(info.st_mode):
                record.append([relative, "file", mode, info.st_size, digest(path, "sha256").hexdigest()])
            else:
                raise Refused(f"{path} is a link or special file.")
    return sorted(record)


def evidence_text(agent, version, packages, tree):
    return json.dumps({"agent": agent, "version": version, "packages": packages, "tree": tree},
                      sort_keys=True, indent=1) + "\n"


def verified_install(root, lock, agent, version):
    """The install of `agent` `version` as recorded, or a Refused saying why it cannot be used."""
    agent_dir = root / "agents" / agent
    target, evidence = agent_dir / version, agent_dir / f"{version}.json"
    own_directory(root / "agents", create=False)
    own_directory(agent_dir, create=False)
    if not own_directory(target, create=False):
        raise Refused(f"{agent} {version} is not installed.")
    info = os.lstat(evidence) if os.path.lexists(evidence) else None
    if info is None or not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise Refused(f"{target} has no install record of its own.")
    entry = lock.get(agent)
    if entry is None or entry["version"] != version:
        raise Refused(f"{target} is not the version this ORCA pins.")
    try:
        recorded = json.loads(evidence.read_text())
    except (OSError, ValueError):
        raise Refused(f"{evidence} is unreadable.")
    packages = sorted(entry["packages"].items())
    if not isinstance(recorded, dict) or recorded.get("agent") != agent or recorded.get("version") != version \
            or recorded.get("packages") != [list(p) for p in packages]:
        raise Refused(f"{target} was installed from other packages than this ORCA pins.")
    if recorded.get("tree") != tree_record(target):
        raise Refused(f"{target} has changed since it was installed.")
    binary = target / AGENTS[agent]["binary"]
    if binary.is_symlink() or not binary.is_file() or not os.access(binary, os.X_OK):
        raise Refused(f"{target} has no executable {agent}.")
    return target, binary


def install(scratch_arg):
    lock = load_lock()
    root = server_root()
    home = Path(os.path.expanduser("~")).resolve(strict=True)
    scratch = Path(scratch_arg)
    try:
        relative = scratch.resolve(strict=True).relative_to(home).as_posix()
    except (OSError, ValueError):
        raise Refused("The carried agent is not in a courier directory.")
    if not COURIER.match(relative) or scratch.resolve() != scratch:
        raise Refused("The carried agent is not in a courier directory.")
    agent, version, packages = read_manifest(scratch, lock)
    for package in packages:
        file = scratch / package["file"]
        if file.is_symlink() or not file.is_file() or file.stat().st_size > TARBALL_LIMIT:
            raise Refused(f"{package['file']} did not arrive as a file.")
        if integrity_of(file) != package["integrity"]:
            raise Refused(f"{package['path']} does not match its pinned integrity.")
    agents_dir = root / "agents"
    own_directory(agents_dir, create=True, mode=0o755)
    agent_dir = agents_dir / agent
    own_directory(agent_dir, create=True, mode=0o755)
    profile = agent_dir / "home"
    private_profile(profile, create=True)
    target = agent_dir / version
    done = {"step": "install", "agent": agent, "version": version, "dir": str(target), "home": str(profile),
            "binary": str(target / AGENTS[agent]["binary"])}
    if os.path.lexists(target) or os.path.lexists(agent_dir / f"{version}.json"):
        try:
            verified_install(root, lock, agent, version)
        except Refused as why:
            raise Refused(f"{target} holds another install of {agent} {version}: {why} Nothing was changed.")
        emit({**done, "result": "ok"})
        return
    if not hasattr(tarfile, "data_filter"):
        raise Refused("This server's Python cannot unpack archives safely (it needs 3.8.17, 3.9.17, 3.10.12, "
                      "3.11.4 or later).")
    staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=agent_dir))
    evidence = agent_dir / f"{version}.json"
    published = False
    try:
        seen, budget = set(), [ENTRY_LIMIT, UNPACKED_LIMIT]
        for package in sorted(packages, key=lambda p: p["path"].count("/")):
            destination = staging / package["path"]
            if package["path"] in seen:
                raise Refused(f"{package['path']} is written twice.")
            destination.mkdir(parents=True, exist_ok=True)
            unpack(scratch / package["file"], destination, package["path"], seen, budget)
        staged_binary = staging / AGENTS[agent]["binary"]
        if staged_binary.is_symlink() or not staged_binary.is_file():
            raise Refused(f"The carried {agent} has no executable at {AGENTS[agent]['binary']}.")
        staged_binary.chmod(0o755)
        for dirpath, _, _ in os.walk(staging):
            os.chmod(dirpath, 0o755)
        text = evidence_text(agent, version, [[p["path"], p["integrity"]] for p in packages], tree_record(staging))
        partial = agent_dir / f".{version}.json.{os.getpid()}"
        fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
        os.rename(staging, target)
        published = True
        os.rename(partial, evidence)
    except BaseException:
        if not published:
            shutil.rmtree(staging, ignore_errors=True)
        for leftover in agent_dir.glob(f".{version}.json.*"):
            leftover.unlink()
        raise
    emit({**done, "result": "changed"})


def installed(root, lock, agent):
    """The verified install of `agent` this ORCA pins, if any, and what else is there."""
    agent_dir = root / "agents" / agent
    entry = lock.get(agent)
    try:
        names = os.listdir(agent_dir) if own_directory(root / "agents", create=False) and \
            own_directory(agent_dir, create=False) else []
    except Refused as why:
        return None, [], str(why)
    except OSError:
        names = []
    others = sorted(name for name in names if VERSION.match(name) and (entry is None or name != entry["version"]))
    if entry is None or entry["version"] not in names:
        return None, others, None
    try:
        return verified_install(root, lock, agent, entry["version"]), others, None
    except Refused as why:
        return None, others, str(why)


def agent_env(root, agent):
    return {"HOME": os.path.expanduser("~"), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
            "TERM": "dumb", AGENTS[agent]["home"]: str(root / "agents" / agent / "home")}


def signed_in(root, agent, binary):
    spec, profile = AGENTS[agent], root / "agents" / agent / "home"
    try:
        if not private_profile(profile, create=False):
            return "no"
    except Refused:
        return "unknown"
    if agent == "copilot":
        config = profile / "config.json"
        if not os.path.lexists(config):
            return "no"
        try:
            if config.is_symlink():
                return "unknown"
            value = json.loads(config.read_text())
        except (OSError, ValueError):
            return "unknown"
        users = value.get("loggedInUsers") if isinstance(value, dict) else None
        return "yes" if isinstance(users, list) and users else "no"
    try:
        result = subprocess.run([str(binary), *spec["status"]], env=agent_env(root, agent), stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    return {0: "yes", 1: "no"}.get(result.returncode, "unknown")


def status():
    lock = load_lock()
    root = server_root()
    agents = []
    for agent in sorted(AGENTS):
        if agent not in lock:
            continue
        found, others, problem = installed(root, lock, agent)
        item = {"agent": agent, "versions": [lock[agent]["version"]] if found else [], "others": others,
                "signedIn": signed_in(root, agent, found[1]) if found else "no"}
        if problem:
            item["problem"] = problem
        agents.append(item)
    emit({"status": agents})


def login(agent):
    if agent not in AGENTS:
        raise Refused(f"No agent called {agent!r} can be signed in here.")
    lock = load_lock()
    root = server_root()
    found, _, problem = installed(root, lock, agent)
    if problem:
        raise Refused(f"{problem} Install it again from ORCA.")
    if not found:
        raise Refused(f"{agent} is not installed on this server yet.")
    if not private_profile(root / "agents" / agent / "home", create=False):
        raise Refused(f"{agent} has no profile on this server. Install it again from ORCA.")
    binary = found[1]
    emit({"step": "login", "result": "started", "agent": agent, "version": lock[agent]["version"]})
    sys.stdout.flush()
    # No terminal and no browser here: the agent prints a link and a one-time code instead.
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.execve(str(binary), [str(binary), *AGENTS[agent]["login"]], agent_env(root, agent))


def main(argv):
    parser = argparse.ArgumentParser(prog="orca-host-agents")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("install").add_argument("--scratch", required=True)
    commands.add_parser("status")
    commands.add_parser("login").add_argument("--agent", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "install":
            install(args.scratch)
        elif args.command == "status":
            status()
        else:
            login(args.agent)
    except Refused as refused:
        emit({"step": args.command, "result": "refused", "detail": str(refused)})
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
