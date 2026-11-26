#!/usr/bin/env python3
"""Install and sign in agents on a managed ORCA server, from the client (#1236).

The client (`orca-cli remote agent`, the desktop app) sends this program over the profile's
pinned ssh as `python3 - COMMAND ...`, so nothing is installed on the server to run it. It
works only under the server root the setup made, `~/.local/share/orca-server`:

  install --scratch DIR   Install the agent the client carried into DIR (a courier directory,
                          `~/.cache/orca-courier/<random>`): `agent.json` names the agent, its
                          version and each npm tarball with its sha512 integrity. Every tarball
                          is checked, then unpacked (no links, devices, absolute paths or `..`)
                          into a staging directory that becomes `agents/<agent>/<version>` in one
                          rename. An install already there is accepted only if it is exactly the
                          same packages; nothing else is ever replaced.
  status                  One line: each known agent's installed versions and whether its
                          profile is signed in (`yes`, `no` or `unknown`).
  login --agent ID        Run the agent's own sign-in on its profile, with no terminal, so it
                          uses a device code: its link and code are printed for the client to
                          show the person, who approves it in their own browser. The credential
                          is written by the agent, on this server, in `agents/<agent>/home`.

npm never runs here, and no install script of any package runs. Each agent's profile
(`CODEX_HOME`, `COPILOT_HOME`) is its own directory under the server root, never the account's
everyday one. It prints `orca-agents: {json}` lines; anything else is the agent's own output.
No third-party modules.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
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
STAMP = ".orca-agent.json"
TARBALL_LIMIT = 1 << 30
UNPACKED_LIMIT = 4 << 30

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


def server_root():
    home = Path(os.path.expanduser("~"))
    root = home / ROOT_FROM_HOME
    if not root.is_dir() or root.is_symlink():
        raise Refused("This machine is not an ORCA server yet: set it up first.")
    resolved = root.resolve(strict=True)
    if resolved != root or resolved.stat().st_uid != os.geteuid():
        raise Refused(f"{root} is not the ORCA server's own directory.")
    return root


def own_directory(path, create):
    """`path` as a real directory of this account, closed to others; made when `create`."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        if not create:
            return False
        os.mkdir(path, 0o700)
        info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise Refused(f"{path} is not a directory of the ORCA server's own.")
    return True


def integrity_of(path):
    digest = hashlib.sha512()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return "sha512-" + base64.b64encode(digest.digest()).decode()


def read_manifest(scratch):
    """`agent.json` in the courier directory, checked field by field."""
    try:
        manifest = json.loads((scratch / "agent.json").read_text())
    except (OSError, ValueError):
        raise Refused("The carried agent has no readable agent.json.")
    agent, version, packages = manifest.get("agent"), manifest.get("version"), manifest.get("packages")
    if agent not in AGENTS or not isinstance(version, str) or not VERSION.match(version):
        raise Refused("The carried agent is not one this server can install.")
    if not isinstance(packages, list) or not 0 < len(packages) <= 200:
        raise Refused("The carried agent lists no packages.")
    seen = set()
    for package in packages:
        if not isinstance(package, dict):
            raise Refused("The carried agent's package list is malformed.")
        path, name, integrity = package.get("path"), package.get("file"), package.get("integrity")
        if not (isinstance(path, str) and PACKAGE_PATH.match(path) and ".." not in path.split("/")):
            raise Refused(f"Unusable package path: {path!r}")
        if not (isinstance(name, str) and FILE.match(name)) or not (isinstance(integrity, str)
                                                                     and INTEGRITY.match(integrity)):
            raise Refused(f"Unusable package entry for {path}")
        if path in seen:
            raise Refused(f"{path} is listed twice.")
        seen.add(path)
    return agent, version, packages


def unpack(tarball, destination, budget):
    """One npm tarball into `destination`, without its top directory. Returns the bytes left."""
    with tarfile.open(tarball, "r:gz") as archive:
        members, top = [], None
        for member in archive:
            head, _, rest = member.name.partition("/")
            if top is None:
                top = head
            if head != top or not rest:
                if member.isdir() and not rest and head == top:
                    continue
                raise Refused(f"{tarball.name} is not one package directory.")
            if not (member.isfile() or member.isdir()):
                raise Refused(f"{tarball.name} holds a link or special file ({member.name}).")
            budget -= member.size
            if budget < 0:
                raise Refused("The carried agent unpacks to more than 4 GiB.")
            member.name = rest
            members.append(member)
        archive.extractall(destination, members=members, filter="data")
    return budget


def install(scratch_arg):
    root = server_root()
    home = Path(os.path.expanduser("~")).resolve(strict=True)
    scratch = Path(scratch_arg)
    try:
        relative = scratch.resolve(strict=True).relative_to(home).as_posix()
    except (OSError, ValueError):
        raise Refused("The carried agent is not in a courier directory.")
    if not COURIER.match(relative) or scratch.resolve() != scratch:
        raise Refused("The carried agent is not in a courier directory.")
    agent, version, packages = read_manifest(scratch)
    for package in packages:
        file = scratch / package["file"]
        if file.is_symlink() or not file.is_file() or file.stat().st_size > TARBALL_LIMIT:
            raise Refused(f"{package['file']} did not arrive as a file.")
        if integrity_of(file) != package["integrity"]:
            raise Refused(f"{package['path']} does not match its pinned integrity.")
    stamp = json.dumps({"agent": agent, "version": version,
                        "packages": [{"path": p["path"], "integrity": p["integrity"]} for p in packages]},
                       sort_keys=True, indent=2) + "\n"
    agents_dir = root / "agents"
    own_directory(agents_dir, create=True)
    agent_dir = agents_dir / agent
    own_directory(agent_dir, create=True)
    profile = agent_dir / "home"
    own_directory(profile, create=True)
    target = agent_dir / version
    binary = target / AGENTS[agent]["binary"]
    if os.path.lexists(target):
        own_directory(target, create=False)
        existing = target / STAMP
        if existing.is_symlink() or not existing.is_file() or existing.read_text() != stamp:
            raise Refused(f"{target} holds another install of {agent} {version}. Nothing was changed.")
        emit({"step": "install", "result": "ok", "agent": agent, "version": version, "dir": str(target),
              "home": str(profile), "binary": str(binary)})
        return
    if not hasattr(tarfile, "data_filter"):
        raise Refused("This server's Python cannot unpack archives safely (it needs 3.8.17, 3.9.17, 3.10.12, "
                      "3.11.4 or later).")
    staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=agent_dir))
    try:
        budget = UNPACKED_LIMIT
        for package in sorted(packages, key=lambda p: p["path"].count("/")):
            destination = staging / package["path"]
            destination.mkdir(parents=True, exist_ok=True)
            budget = unpack(scratch / package["file"], destination, budget)
        staged_binary = staging / AGENTS[agent]["binary"]
        if staged_binary.is_symlink() or not staged_binary.is_file():
            raise Refused(f"The carried {agent} has no executable at {AGENTS[agent]['binary']}.")
        staged_binary.chmod(0o755)
        (staging / STAMP).write_text(stamp)
        staging.chmod(0o755)
        os.rename(staging, target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    emit({"step": "install", "result": "changed", "agent": agent, "version": version, "dir": str(target),
          "home": str(profile), "binary": str(binary)})


def installed(root, agent):
    """The versions of `agent` installed by this program, newest last."""
    agent_dir = root / "agents" / agent
    try:
        if not own_directory(agent_dir, create=False):
            return []
        names = os.listdir(agent_dir)
    except (Refused, OSError):
        return []
    versions = [name for name in names if VERSION.match(name) and (agent_dir / name / STAMP).is_file()
                and not (agent_dir / name).is_symlink()]
    return sorted(versions, key=lambda v: tuple(int(part) for part in v.split(".")))


def agent_env(root, agent):
    env = {"HOME": os.path.expanduser("~"), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
           "TERM": "dumb", AGENTS[agent]["home"]: str(root / "agents" / agent / "home")}
    return env


def signed_in(root, agent, version):
    spec = AGENTS[agent]
    if agent == "copilot":
        try:
            config = json.loads((root / "agents" / agent / "home" / "config.json").read_text())
        except FileNotFoundError:
            return "no"
        except (OSError, ValueError):
            return "unknown"
        users = config.get("loggedInUsers") if isinstance(config, dict) else None
        return "yes" if isinstance(users, list) and users else "no"
    binary = root / "agents" / agent / version / spec["binary"]
    try:
        result = subprocess.run([str(binary), *spec["status"]], env=agent_env(root, agent), stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    return {0: "yes", 1: "no"}.get(result.returncode, "unknown")


def status():
    root = server_root()
    agents = []
    for agent in sorted(AGENTS):
        versions = installed(root, agent)
        agents.append({"agent": agent, "versions": versions,
                       "signedIn": signed_in(root, agent, versions[-1]) if versions else "no"})
    emit({"status": agents})


def login(agent):
    if agent not in AGENTS:
        raise Refused(f"No agent called {agent!r} can be signed in here.")
    root = server_root()
    versions = installed(root, agent)
    if not versions:
        raise Refused(f"{agent} is not installed on this server yet.")
    binary = root / "agents" / agent / versions[-1] / AGENTS[agent]["binary"]
    emit({"step": "login", "result": "started", "agent": agent, "version": versions[-1]})
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
