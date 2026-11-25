#!/usr/bin/env python3
"""Debian release staging/activation and stable launch adapter. No third-party modules.

Install this adapter outside release directories. All work launchers must use it;
its shared flock lives for the entire CLI/ACP child lifetime. The managed daemon
uses the wire admission barrier instead, so an idle service does not block updates.
An independent typed lifetime lock includes ALL three launch kinds. It is never
replaced by the admission barrier, process scans, PID checks or lock age.

`stage vX.Y.Z` builds a release from source (gh, git, mise, pnpm). `stage --bundle vX.Y.Z`
(or a directory) stages the signed prebuilt server bundle instead, with Python 3 alone: the
manifest's keyless signature is verified against BUNDLE_SIGNER with a pinned cosign, then the
archive's digest, before anything is unpacked (#876, docs/UPDATING.md).

`auto-update` follows the server's ring on the update feed's server channel (#877, #878),
from a systemd user timer that `install-timer` writes: it stages what the ring offers while
work continues, activates through the same closed-admission path once the server is idle,
rolls back automatically only while admission has stayed closed, and keeps two releases.
"""
import argparse
import contextlib
import fcntl
import functools
import hashlib
import json
import os
from pathlib import Path
import re
import platform
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


# The prebuilt server bundle (#876). Its manifest is signed keylessly (Sigstore/cosign over
# GitHub OIDC) by exactly this workflow, dispatched on main of exactly this repository; a
# signature from anything else, or a manifest or archive that does not match, is refused
# before a single byte of the archive is read. Changing the signer is a reviewed change here.
BUNDLE_REPOSITORY = "cschadewitz/Project_Orca"
BUNDLE_PRODUCT = "orca"
# The Orrery rename bridge (v0.8.1): the repository is renamed, and the releases after it are
# signed there and named after the new product. For one release either repository and either
# name is accepted, each exactly as before; v0.10.0 drops the old ones.
# rename-keep-start: both names, so a server on either side of the rename can update across it
BUNDLE_REPOSITORIES = tuple(dict.fromkeys((BUNDLE_REPOSITORY, "cschadewitz/Project_Orca", "cschadewitz/Orrery")))
BUNDLE_PRODUCTS = tuple(dict.fromkeys((BUNDLE_PRODUCT, "orca", "orrery")))
ENV_PREFIXES = ("ORCA_", "ORRERY_")
VERSION_FIELDS = ("orcaVersion", "orreryVersion")
# rename-keep-end
BUNDLE_SIGNER = f"https://github.com/{BUNDLE_REPOSITORY}/.github/workflows/release-server-bundle.yml@refs/heads/main"
BUNDLE_ISSUER = "https://token.actions.githubusercontent.com"
BUNDLE_TRIGGER = "workflow_dispatch"
BUNDLE_SCHEMA = f"{BUNDLE_PRODUCT}-server-bundle/1"
BUNDLE_PLATFORM = "linux-x64"
BUNDLE_RECORD_RE = (r"<!-- (?:" + "|".join(BUNDLE_PRODUCTS) + r")-server-run: [0-9]+ sha256:([0-9a-f]{64})"
                    r" sha256:([0-9a-f]{64}) sha256:([0-9a-f]{64}) -->")
# What the managed daemon is told about its own installation, and nothing else is (#879).
DEPLOYMENT_ENV = ("ORCA_DEPLOYMENT_ADAPTER", "ORCA_DEPLOYMENT_MANIFEST", "ORCA_DEPLOYMENT_RING")
DEPLOYMENT_RINGS = ("internal", "preview", "stable")
BUNDLE_MAX_BYTES = 512 << 20          # compressed archive
BUNDLE_MAX_UNPACKED = 1536 << 20      # everything it unpacks to
# cosign is fetched once into the deployment root and checked against this digest every time
# it is used, so nothing on PATH or in the cache is trusted by name. The same version
# release-server-bundle.yml signs with (sigstore/cosign-installer's pinned bootstrap).
COSIGN_VERSION = "v3.1.4"
COSIGN_SHA256 = {
    "x86_64": ("cosign-linux-amd64", "424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa"),
    "aarch64": ("cosign-linux-arm64", "ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2"),
}
SOURCE_ENTRY = "packages/cli/dist/main.js"
# A bundle's runtime and entry are fixed, inside the release; nothing from a manifest or a
# record can point them anywhere else.
BUNDLE_NODE = "runtime/bin/node"
BUNDLE_ENTRY = f"{BUNDLE_PRODUCT}-daemon.mjs"
BUNDLE_ENTRIES = tuple(f"{product}-daemon.mjs" for product in BUNDLE_PRODUCTS)
# The update feed's server channel (#877): tools/deploy/feed-server.js writes it; the format is
# flat `key: value` lines in exactly this order, so it is read here with the standard library.
SERVER_CHANNEL_FILE = "latest-linux-x64.yml"
SERVER_CHANNEL_KEYS = ("version", "platform", "sourceSha",
                       "archive", "archiveSha256", "archiveSize",
                       "manifest", "manifestSha256", "manifestSize",
                       "signature", "signatureSha256", "signatureSize")
SERVER_CHANNEL_MAX = 4096
FEED_TOKEN_RE = r"[A-Za-z0-9_-]{43}"
AUTO_UPDATE_KEYS = {"feed", "tokenFile", "interval", "maxDeferralHours", "quietHours", "settleSeconds"}
AUTO_UPDATE_STATUS = "auto-update.json"
AUTO_UPDATE_STOP = "auto-update.stop"     # a local stop: while it exists, nothing is activated
FEED_STOP_HEADER = "x-orca-feed-stop"     # the feed's servers' stop switch (#878)
FEED_STOP_HEADERS = tuple(dict.fromkeys((FEED_STOP_HEADER, "x-orca-feed-stop", "x-orrery-feed-stop")))  # rename-keep: either
AUTO_UPDATE_UNIT = "orca-auto-update"

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


class TypedLifetime:
    """Retained assertion plus the exact descriptor allowed into direct children."""
    def __init__(self, descriptor, assertion):
        self.descriptor = descriptor
        self.assertion = assertion

    def __call__(self):
        return self.assertion()


@contextlib.contextmanager
def typed_lifetime_lock(path, exclusive=False):
    """Stable, no-follow, non-stealable namespace. Descriptor inheritance keeps
    a surviving exec child protected after its Python supervisor exits.
    """
    path = Path(path)
    if path.parent.resolve(strict=True) != path.parent:
        raise RuntimeError("Typed lifetime root alias")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        original = os.fstat(fd)
        def assert_current():
            named, held = path.lstat(), os.fstat(fd)
            if (not stat.S_ISREG(held.st_mode) or held.st_nlink != 1 or held.st_uid != os.getuid()
                    or held.st_mode & 0o077 or (named.st_dev, named.st_ino) != (original.st_dev, original.st_ino)
                    or (held.st_dev, held.st_ino) != (original.st_dev, original.st_ino)):
                raise RuntimeError("Typed lifetime identity/ownership changed")
        assert_current()
        try:
            fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Typed lifetime busy: managed daemon/CLI/ACP ownership retained") from None
        assert_current()
        os.set_inheritable(fd, True)
        yield TypedLifetime(fd, assert_current)
    finally:
        # Close only our reference. LOCK_UN would unlock the shared open-file
        # description in a surviving child on normal OR exceptional unwind.
        os.close(fd)


def typed_operation(action):
    """Updates/recovery participate too: enrollment cannot begin after inspection
    while a stage/build/stop/restore operation is still in progress.
    """
    def decorate(operation):
        @functools.wraps(operation)
        def guarded(self, *args, **kwargs):
            assertion = self.typed_guard(action)
            with typed_lifetime_lock(self.root / "typed-lifetime.lock") as lifetime:
                start = len(self._typed_assertions)
                self._typed_assertions.extend((assertion, lifetime))
                self._typed_lifetimes.append(lifetime)
                try:
                    return operation(self, *args, **kwargs)
                finally:
                    self._typed_lifetimes.pop()
                    del self._typed_assertions[start:]
        return guarded
    return decorate


def environment_value(name, env=None):
    """`name` from the environment, or the same variable under the other prefix of the rename:
    what core's adoptLegacyEnv does for the CLI and the app, so a server whose operator set the
    variable before the rename keeps working through 0.9. The name as written wins."""
    env = os.environ if env is None else env
    if name in env:
        return env[name]
    for prefix in ENV_PREFIXES:
        if name.startswith(prefix):
            for other in ENV_PREFIXES:
                if other + name[len(prefix):] in env:
                    return env[other + name[len(prefix):]]
    return None


def rpc(url, method, params, token_file=None, use_environment=True):
    explicit = environment_value("ORCA_DAEMON_TOKEN") if use_environment else None
    token_file = (environment_value("ORCA_DAEMON_TOKEN_FILE") if use_environment else None) or token_file
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
    """The staged release's record. A source stage records an absolute Node outside the
    release and runs the source layout's entry. A bundle stage runs exactly BUNDLE_NODE and
    its entry (one of BUNDLE_ENTRIES) inside the release (relative, so the record stays true
    after the staging directory is renamed into place); any other value is refused, never
    resolved."""
    result = json.loads((release / ".orca-release.json").read_text())
    if result.get("source") == "bundle":
        if result.get("node") != BUNDLE_NODE or result.get("entry") not in BUNDLE_ENTRIES:
            raise RuntimeError("Bundle release record names an unexpected runtime or entry; restage the release")
        result["node"] = str(Path(release) / BUNDLE_NODE)
        result["entry"] = str(Path(release) / result["entry"])
        for key in ("node", "entry"):
            if Path(result[key]).is_symlink():
                raise RuntimeError(f"Bundle {key} is a link; restage the release")
    else:
        if not Path(result["node"]).is_absolute() or result.get("entry", SOURCE_ENTRY) != SOURCE_ENTRY:
            raise RuntimeError("Source release record names an unexpected runtime or entry; restage the release")
        result["entry"] = str(Path(release) / SOURCE_ENTRY)
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
    version = next((hello[field] for field in VERSION_FIELDS if field in hello), None)
    if version != meta["version"] or hello.get("protocol") != contract["protocol"]:
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


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def bundle_names(version, product=BUNDLE_PRODUCT):
    stem = f"{product}-server-{version}-{BUNDLE_PLATFORM}"
    return stem, stem + ".tar.xz", stem + ".manifest.json", stem + ".manifest.json.sigstore.json"


def bundle_product(version, present):
    """The one product (BUNDLE_PRODUCTS) whose three bundle files for VERSION are all present."""
    found = [product for product in BUNDLE_PRODUCTS if all(present(name) for name in bundle_names(version, product)[1:])]
    if len(found) != 1:
        raise RuntimeError(f"Expected exactly one server bundle for v{version}, found {len(found)}")
    return found[0]


def signer(repository):
    return f"https://github.com/{repository}/.github/workflows/release-server-bundle.yml@refs/heads/main"


def both_env_names(env, names):
    """The daemon environment this adapter sets, under the old and the new prefix (the rename
    bridge): either release reads its own, whichever adapter launched it."""
    for name in names:
        for prefix in ENV_PREFIXES:
            if name in env and name.startswith(prefix):
                for other in ENV_PREFIXES:
                    env.setdefault(other + name[len(prefix):], env[name])
    return env


def download(url, target, limit, accept=None):
    """HTTPS only, every redirect included, bounded, written exclusively."""
    class HttpsOnly(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, response, code, message, headers, new_url):
            if urllib.parse.urlsplit(new_url).scheme != "https":
                raise RuntimeError("Download redirected away from HTTPS")
            return super().redirect_request(request, response, code, message, headers, new_url)
    if urllib.parse.urlsplit(url).scheme != "https":
        raise RuntimeError("Downloads must use HTTPS")
    headers = {"user-agent": "orca-release"}
    if accept:
        headers["accept"] = accept
    opener = urllib.request.build_opener(HttpsOnly())
    with opener.open(urllib.request.Request(url, headers=headers), timeout=60) as response, \
            open(target, "xb") as stream:
        total = 0
        for block in iter(lambda: response.read(1 << 20), b""):
            total += len(block)
            if total > limit:
                raise RuntimeError(f"Download exceeds {limit} bytes: {url}")
            stream.write(block)


def unpack_bundle(archive, root_name, destination):
    """Regular files and directories only, all under the single expected root, no links,
    devices, absolute paths or `..`, and bounded in size. Extracted by hand rather than
    trusting any tarfile extraction filter."""
    unpacked = 0
    with tarfile.open(archive, "r:xz") as tar:
        members = tar.getmembers()
        for member in members:
            parts = Path(member.name).parts
            if (not parts or parts[0] != root_name or member.name.startswith("/") or ".." in parts
                    or "\\" in member.name or not (member.isfile() or member.isdir())):
                raise RuntimeError(f"Bundle entry refused: {member.name!r}")
            unpacked += member.size
            if unpacked > BUNDLE_MAX_UNPACKED:
                raise RuntimeError("Bundle unpacks beyond the size limit")
        for member in members:
            relative = Path(*Path(member.name).parts[1:]) if len(Path(member.name).parts) > 1 else None
            if relative is None:
                continue
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(member)
            with source, open(target, "xb") as stream:
                shutil.copyfileobj(source, stream)
            os.chmod(target, 0o755 if member.mode & 0o100 else 0o644)


VERSION_RE = r"\d+\.\d+\.\d+(?:-(?:rc|beta|alpha)\.\d+)?"


def bundle_version(text):
    """A release version, X.Y.Z or a release candidate X.Y.Z-rc.N. Never a dry run."""
    match = re.fullmatch(r"v?(" + VERSION_RE + r")", text)
    if not match:
        raise RuntimeError("Use an explicit vX.Y.Z (or vX.Y.Z-rc.N) release version")
    return match.group(1)


def version_key(version):
    """Semver order for X.Y.Z[-label.N]: a prerelease sorts before its release."""
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?", version)
    if not match:
        raise RuntimeError(f"Unrecognised release version {version!r}")
    major, minor, patch, label, number = match.groups()
    pre = (0, label, int(number)) if label else (1, "", 0)
    return (int(major), int(minor), int(patch), *pre)

def parse_server_channel(text):
    """The server channel file, exactly as feed-server.js writes it: these keys in this order,
    the file names derived from the version, hex digests and decimal sizes. Raises otherwise.
    It only says where the bundle is; staging still verifies the manifest's signature."""
    if not text.endswith("\n"):
        raise RuntimeError("Server channel file does not end with a newline")
    lines = text[:-1].split("\n")
    if len(lines) != len(SERVER_CHANNEL_KEYS):
        raise RuntimeError(f"Server channel file has {len(lines)} lines, not {len(SERVER_CHANNEL_KEYS)}")
    value = {}
    for index, (line, key) in enumerate(zip(lines, SERVER_CHANNEL_KEYS)):
        match = re.fullmatch(r"([A-Za-z0-9]+): ([0-9A-Za-z.-]+)", line)
        if not match or match.group(1) != key:
            raise RuntimeError(f"Server channel line {index + 1} is not {key}")
        value[key] = match.group(2)
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-rc\.\d+)?", value["version"]):
        raise RuntimeError(f"Server channel offers an unexpected version {value['version']!r}")
    if value["platform"] != BUNDLE_PLATFORM:
        raise RuntimeError(f"Server channel is for {value['platform']}, not {BUNDLE_PLATFORM}")
    if not re.fullmatch(r"[0-9a-f]{40}", value["sourceSha"]):
        raise RuntimeError("Server channel names no source commit")
    product = next((p for p in BUNDLE_PRODUCTS if value["archive"] == bundle_names(value["version"], p)[1]),
                   BUNDLE_PRODUCT)
    names = dict(zip(("archive", "manifest", "signature"), bundle_names(value["version"], product)[1:]))
    for kind, name in names.items():
        if value[kind] != name:
            raise RuntimeError(f"Server channel {kind} is not {name}")
        if not re.fullmatch(r"[0-9a-f]{64}", value[kind + "Sha256"]):
            raise RuntimeError(f"Server channel {kind}Sha256 is not a SHA-256")
        if not re.fullmatch(r"0|[1-9]\d{0,11}", value[kind + "Size"]):
            raise RuntimeError(f"Server channel {kind}Size is not a size")
        value[kind + "Size"] = int(value[kind + "Size"])
    if value["archiveSize"] > BUNDLE_MAX_BYTES or value["manifestSize"] > 1 << 20 or value["signatureSize"] > 1 << 20:
        raise RuntimeError("Server channel lists a file beyond the size limit")
    return value


def auto_update_config(config):
    """deployment.json's `autoUpdate` object, checked: the feed's https origin and the server
    token's file (both required), then optional limits. Its presence is the opt-in."""
    auto = config.get("autoUpdate")
    if not isinstance(auto, dict):
        raise RuntimeError("Automatic updates are off: deployment.json has no autoUpdate object")
    unknown = set(auto) - AUTO_UPDATE_KEYS
    if unknown:
        raise RuntimeError("Unknown autoUpdate settings: " + ", ".join(sorted(unknown)))
    feed = auto.get("feed")
    if not isinstance(feed, str) or not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::\d{1,5})?/?", feed):
        raise RuntimeError("autoUpdate.feed must be the feed's https origin")
    token_file = auto.get("tokenFile")
    if not isinstance(token_file, str) or not Path(token_file).is_absolute():
        raise RuntimeError("autoUpdate.tokenFile must be an absolute path")
    interval = auto.get("interval", "1h")
    if not isinstance(interval, str) or not re.fullmatch(r"(?:[1-9]\d{0,3}(?:min|h|d))", interval):
        raise RuntimeError("autoUpdate.interval must be like 30min, 1h or 1d")
    defer = auto.get("maxDeferralHours", 72)
    if not isinstance(defer, int) or isinstance(defer, bool) or not 1 <= defer <= 720:
        raise RuntimeError("autoUpdate.maxDeferralHours must be a whole number of hours, 1 to 720")
    quiet = auto.get("quietHours")
    if quiet is not None and (not isinstance(quiet, str) or not re.fullmatch(
            r"(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d", quiet) or quiet[:5] == quiet[6:]):
        raise RuntimeError("autoUpdate.quietHours must be HH:MM-HH:MM (local time), or absent")
    settle = auto.get("settleSeconds", 10)
    if not isinstance(settle, int) or isinstance(settle, bool) or not 0 <= settle <= 300:
        raise RuntimeError("autoUpdate.settleSeconds must be 0 to 300")
    return {"feed": feed.rstrip("/"), "tokenFile": Path(token_file), "interval": interval,
            "maxDeferralHours": defer, "quietHours": quiet, "settleSeconds": settle}


def in_quiet_hours(quiet, now):
    """Whether local time `now` falls in HH:MM-HH:MM (which may wrap past midnight)."""
    if not quiet:
        return False
    start, end = (int(part[:2]) * 60 + int(part[3:]) for part in quiet.split("-"))
    minute = now.tm_hour * 60 + now.tm_min
    return start <= minute < end if start < end else minute >= start or minute < end


def read_feed_token(path):
    """The server's feed token: a regular file of this user's, readable by no one else."""
    try:
        held = os.lstat(path)
    except FileNotFoundError:
        raise RuntimeError(f"Feed token file {path} is missing") from None
    if not stat.S_ISREG(held.st_mode) or held.st_uid != os.getuid() or held.st_mode & 0o077:
        raise RuntimeError(f"Feed token file {path} must be a regular file of this user, mode 600")
    token = Path(path).read_text().strip()
    if not re.fullmatch(FEED_TOKEN_RE, token):
        raise RuntimeError(f"Feed token file {path} does not hold a feed token")
    return token


def feed_get(url, token, limit, target=None):
    """GET one feed object with the server's token: HTTPS, no redirects, bounded. Returns the
    bytes (or writes `target`), or None for 404 (nothing offered to this ring)."""
    if urllib.parse.urlsplit(url).scheme != "https":
        raise RuntimeError("The feed must use HTTPS")
    class Refuse(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, response, code, message, headers, new_url):
            raise RuntimeError("The feed redirected; refused")
    opener = urllib.request.build_opener(Refuse())
    request = urllib.request.Request(url, headers={"authorization": "Bearer " + token,
                                                   "user-agent": "orca-release"})
    try:
        response = opener.open(request, timeout=60)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        if error.code == 503 and any((error.headers.get(h) or "").strip() == "servers" for h in FEED_STOP_HEADERS):
            raise FeedStopped("the feed's servers' stop switch is set") from None
        if error.code == 401:
            raise RuntimeError("The feed refused this server's token (401); check autoUpdate.tokenFile") from None
        raise RuntimeError(f"The feed answered {error.code} for {url}") from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"The feed is unreachable: {error.reason}") from None
    with response:
        if target is None:
            body = response.read(limit + 1)
            if len(body) > limit:
                raise RuntimeError(f"Feed object exceeds {limit} bytes: {url}")
            return body
        with open(target, "xb") as stream:
            total = 0
            for block in iter(lambda: response.read(1 << 20), b""):
                total += len(block)
                if total > limit:
                    raise RuntimeError(f"Feed object exceeds {limit} bytes: {url}")
                stream.write(block)
        return True


class FeedStopped(RuntimeError):
    """The feed's servers' stop switch (rings.json serverStop): nothing may be activated."""


class ActivationFinalizeFailed(RuntimeError):
    """Admission reopened on the new release, but removing the activation journal failed."""


class AutoRollbackRefused(RuntimeError):
    """A failure after admission reopened: the candidate may already hold newer work."""


class BundleSource:
    """Fetch and verify a signed server bundle (#876). Needs only ROOT, which holds the pinned
    cosign and its Sigstore trust root under ROOT/tools; Deployment adds staging on top. Used
    alone by `fetch-bundle`, which the update feed's publication runs (#877)."""

    def __init__(self, root):
        self.root = Path(root).resolve()

    def typed_dispatch(self, operation, *args, **kwargs):
        return operation(*args, **kwargs)

    def typed_process(self, operation, *args, **kwargs):
        return operation(*args, **kwargs)

    def cosign(self):
        """The pinned cosign, fetched once and re-hashed before every use."""
        machine = platform.machine()
        if machine not in COSIGN_SHA256:
            raise RuntimeError(f"No pinned cosign for {machine}")
        name, digest = COSIGN_SHA256[machine]
        tools = self.root / "tools"
        tools.mkdir(mode=0o700, exist_ok=True)
        path = tools / f"cosign-{COSIGN_VERSION}-{machine}"
        if not path.exists():
            partial = Path(self.typed_dispatch(tempfile.mkdtemp, prefix="cosign-", dir=tools)) / name
            try:
                self.typed_dispatch(download, f"https://github.com/sigstore/cosign/releases/download/{COSIGN_VERSION}/{name}",
                                    partial, 256 << 20)
                if file_sha256(partial) != digest:
                    raise RuntimeError("Downloaded cosign does not match its pinned digest")
                os.chmod(partial, 0o700)
                os.replace(partial, path)
            finally:
                shutil.rmtree(partial.parent, ignore_errors=True)
        if path.is_symlink() or not path.is_file() or file_sha256(path) != digest:
            raise RuntimeError(f"{path} does not match the pinned cosign digest; remove it to fetch it again")
        return path

    def fetch_bundle(self, version, directory):
        """The three published assets of release vVERSION, by its API record: from the first of
        BUNDLE_REPOSITORIES that has it (the rename bridge; a renamed repository also redirects)."""
        record_file = directory / "release.json"
        for index, repository in enumerate(BUNDLE_REPOSITORIES):
            url = f"https://api.github.com/repos/{repository}/releases/tags/v{version}"
            try:
                self.typed_dispatch(download, url, record_file, 4 << 20, accept="application/vnd.github+json")
                break
            except urllib.error.HTTPError as error:
                record_file.unlink(missing_ok=True)
                if error.code != 404 or index == len(BUNDLE_REPOSITORIES) - 1:
                    raise
        published = json.loads(record_file.read_text())
        record_file.unlink()
        assets = {asset.get("name"): asset for asset in published.get("assets", [])}
        _, *files = bundle_names(version, bundle_product(version, assets.__contains__))
        if (published.get("draft") or published.get("prerelease") is not ("-" in version)
                or published.get("tag_name") != f"v{version}"):
            raise RuntimeError("Target is not a published release of that version")
        # A release candidate is published first and its bundle attached by a later run, which
        # records the three digests in the notes last. That record is the "ready" signal: until
        # it is there (exactly once), the bundle is not complete and is not fetched.
        records = re.findall(BUNDLE_RECORD_RE, published.get("body") or "")
        if len(records) != 1 or sum((published.get("body") or "").count(p + "-server-run") for p in BUNDLE_PRODUCTS) != 1:
            raise RuntimeError(f"Release v{version} has no complete server bundle yet (no single orca-server-run record); retry later")
        recorded = dict(zip(files, records[0]))
        for name in files:
            asset = assets.get(name) or {}
            if not asset.get("browser_download_url") or asset.get("digest") != "sha256:" + recorded[name]:
                raise RuntimeError(f"Release v{version}'s {name} is missing or not the recorded one; retry later")
            limit = BUNDLE_MAX_BYTES if name.endswith(".tar.xz") else 4 << 20
            self.typed_dispatch(download, asset["browser_download_url"], directory / name, limit)
            if file_sha256(directory / name) != recorded[name]:
                raise RuntimeError(f"Downloaded {name} is not the recorded file")

    def verify_bundle(self, directory, version):
        """Signature first (pinned signer), then the manifest, then the archive's digest."""
        product = bundle_product(version, lambda name: (directory / name).exists())
        stem, archive, manifest_name, signature = bundle_names(version, product)
        manifest_path, archive_path = directory / manifest_name, directory / archive
        for path in (manifest_path, archive_path, directory / signature):
            if path.is_symlink() or not path.is_file():
                raise RuntimeError(f"Bundle file missing: {path.name}")
        if manifest_path.stat().st_size > 4 << 20 or archive_path.stat().st_size > BUNDLE_MAX_BYTES:
            raise RuntimeError("Bundle file exceeds its size limit")
        cosign = self.cosign()
        tuf = self.root / "tools" / "sigstore"
        tuf.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Each accepted repository is tried with its own exact identity; none is a pattern.
        for repository in BUNDLE_REPOSITORIES:
            result = self.typed_process(subprocess.run, [
                str(cosign), "verify-blob", str(manifest_path),
                "--bundle", str(directory / signature),
                "--certificate-identity", signer(repository),
                "--certificate-oidc-issuer", BUNDLE_ISSUER,
                "--certificate-github-workflow-repository", repository,
                "--certificate-github-workflow-ref", "refs/heads/main",
                "--certificate-github-workflow-trigger", BUNDLE_TRIGGER,
            ], env={**os.environ, "TUF_ROOT": str(tuf), "HOME": str(tuf)}, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            if result.returncode == 0:
                break
        else:
            detail = result.stdout.strip().splitlines()[-1:] or ["no output"]
            raise RuntimeError(f"Bundle signature refused: {detail[0]}")
        manifest = json.loads(manifest_path.read_text())
        expected = {"schema": f"{product}-server-bundle/1", "name": f"{product}-server", "version": version,
                    "platform": BUNDLE_PLATFORM, "root": stem}
        for key, value in expected.items():
            if manifest.get(key) != value:
                raise RuntimeError(f"Bundle manifest {key} is {manifest.get(key)!r}, expected {value!r}")
        if manifest.get("entry") != f"{product}-daemon.mjs" or (manifest.get("node") or {}).get("path") != BUNDLE_NODE:
            raise RuntimeError("Bundle manifest names an unexpected runtime or entry")
        if not re.fullmatch(r"[0-9a-f]{40}", str(manifest.get("sourceSha"))):
            raise RuntimeError("Bundle manifest has no source commit")
        listed = manifest.get("archive") or {}
        if listed.get("name") != archive or not re.fullmatch(r"[0-9a-f]{64}", str(listed.get("sha256"))):
            raise RuntimeError("Bundle manifest does not describe the archive")
        if listed.get("size") != archive_path.stat().st_size or file_sha256(archive_path) != listed["sha256"]:
            raise RuntimeError("Bundle archive does not match its signed manifest digest")
        return manifest


class Deployment(BundleSource):
    def __init__(self, manifest, *, typed_inspector=None):
        # Trusted composition only: never selected from manifest, args or environment.
        # No production inspector/build map is installed by this default-off change.
        self.typed_inspector = typed_inspector
        self._typed_assertions = []
        self._typed_lifetimes = []
        self.manifest = Path(manifest).resolve()
        self.config = json.loads(Path(manifest).read_text())
        self.root = Path(self.config["root"]).resolve()
        self.pending = self.root / "activation.json"
        if self.config.get("launchAudit") != "all-cli-acp-and-daemon-launches-migrated":
            raise RuntimeError("Launch inventory is unverified. Inspect wrappers, globs and service manager before bootstrap.")
        for key in ("cwd", "cliConfig", "acpConfig", "daemonConfig"):
            path = Path(self.config[key])
            if not path.is_absolute() or (self.root / "releases") in path.resolve().parents:
                raise RuntimeError(f"{key} must be absolute and outside replaceable releases")
        if not self.config["url"].startswith("http://127.0.0.1:"):
            raise RuntimeError("Managed daemon must listen on loopback")
        self.typed_guard("inspect")()
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "releases").mkdir(exist_ok=True)

    def deployment_env(self):
        """What the managed daemon reports about how to update it (#879, `hello.deployment`)."""
        env = {"ORCA_DEPLOYMENT_ADAPTER": str(Path(__file__).resolve()),
               "ORCA_DEPLOYMENT_MANIFEST": str(self.manifest)}
        ring = self.config.get("ring")
        if ring in DEPLOYMENT_RINGS:
            env["ORCA_DEPLOYMENT_RING"] = ring
        return env

    def typed_dispatch(self, operation, *args, **kwargs):
        # Every retained assertion is synchronous. No process/await between the
        # last retained observation and the operation's actual dispatch.
        for assertion in self._typed_assertions:
            if assertion() is not None:
                raise RuntimeError("Typed workspace inspection ownership unavailable")
        return operation(*args, **kwargs)

    def retain_typed_inspection(self, assertion):
        self._typed_assertions.append(assertion)

    def typed_process(self, operation, *args, **kwargs):
        # subprocess.run and Popen default to close_fds=True. An inheritable bit
        # alone does not keep the lifetime descriptor. Pass only retained owners,
        # keeping every unrelated descriptor closed; no blanket FD inheritance.
        kwargs["close_fds"] = True
        kwargs["pass_fds"] = tuple(sorted({owner.descriptor for owner in self._typed_lifetimes}))
        return self.typed_dispatch(operation, *args, **kwargs)

    def typed_guard(self, action, extra_roots=()):
        """Stable pre-producer boundary. The inspector must resolve every original
        role and previous/failed root; Python never parses a typed marker/schema.
        A present claim without the trusted bridge is categorically unavailable.
        The default legacy adapter cannot enroll a workspace or admit typed code.
        """
        roles = tuple((kind, self.config[key]) for kind, key in
                      (("cli", "cliConfig"), ("acp", "acpConfig"), ("daemon", "daemonConfig")))
        if self.typed_inspector is not None:
            assertion = self.typed_inspector(action, roles, tuple(extra_roots))
            # An inspector returns retained synchronous ownership, never a bool/JSON.
            if not callable(assertion) or assertion() is not None:
                raise RuntimeError("Typed workspace inspection ownership unavailable")
            return assertion
        claims = [self.root / "typed-workspace", self.root / "typed-enrollment.intent"]
        for path in (Path(self.config["cwd"]), *(Path(p).parent for _, p in roles), *map(Path, extra_roots)):
            claims.extend(parent / ".orca-typed-workspace" for parent in (path, *path.parents))
        if any(os.path.lexists(path) for path in claims):
            raise RuntimeError("Typed workspace compatibility unavailable: trusted inspection bridge missing; keep enrollment and recovery evidence intact")
        return lambda: None

    @contextlib.contextmanager
    def typed_enrollment_window(self):
        """Internal exclusion mechanism only; not an enrollment command or proof
        of migrated pre-existing launch inventory. A paused daemon retains its lock.
        """
        with typed_lifetime_lock(self.root / "typed-lifetime.lock", exclusive=True) as lifetime:
            assertion = self.typed_guard("enroll")
            lifetime()
            assertion()
            yield

    def systemctl(self, *args):
        return self.typed_process(capture, ["systemctl", *(["--user"] if self.config.get("userService", True) else []), *args])

    def health(self, release, url=None, pid=None, token_file=None):
        meta = metadata(release)
        if url is None and pid is None:
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
        result = self.typed_dispatch(rpc, self.config["url"], "maintenance", {"action": action, "token": token}, token_file=self.token_file())
        if action == "prepare" and not result["ready"]:
            raise RuntimeError("Daemon busy: " + ", ".join(result["active"]))

    @typed_operation("update")
    def stage(self, tag):
        assertion = self.typed_guard("update")
        self.retain_typed_inspection(assertion)
        if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
            raise RuntimeError("Use an explicit stable published vX.Y.Z release tag")
        release = self.root / "releases" / tag
        if release.exists():
            raise RuntimeError(f"Release directory already exists: {release}; inspect it rather than overwrite")
        published = json.loads(self.typed_process(capture, ["gh", "release", "view", tag, "--repo", self.config["repository"], "--json", "tagName,isDraft,isPrerelease"]))
        if published["isDraft"] or published["isPrerelease"] or published["tagName"] != tag:
            raise RuntimeError("Target is not a published stable release")
        # Incomplete stages have unique names and are never candidates for activation.
        stage = Path(self.typed_dispatch(tempfile.mkdtemp, prefix=tag + ".staging-", dir=self.root / "releases"))
        self.typed_process(run, ["gh", "repo", "clone", self.config["repository"], str(stage), "--", "--branch", tag, "--single-branch", "--depth", "1"])
        sha = self.typed_process(capture, ["git", "rev-parse", "HEAD"], cwd=stage)
        manifest = json.loads((stage / "package.json").read_text())
        if manifest["version"] != tag[1:]:
            raise RuntimeError("Published tag and package version disagree")
        contract = json.loads((stage / "release-compatibility.json").read_text())
        self.typed_process(run, ["mise", "trust"], cwd=stage)
        self.typed_process(run, ["mise", "install"], cwd=stage)
        env = {**os.environ, "ELECTRON_SKIP_BINARY_DOWNLOAD": "1"}
        for args in (["install", "--frozen-lockfile"], ["run", "typecheck"], ["run", "build"]):
            self.typed_process(run, ["mise", "exec", "--", "pnpm", *args], cwd=stage, env=env)
        node = self.typed_process(capture, ["mise", "which", "node"], cwd=stage)
        record = {"version": tag[1:], "sha": sha, "node": node, "compatibility": contract}
        return self.validate_stage(stage, release, record, env, demo_env=env)

    def validate_stage(self, stage, release, record, env, demo_env):
        """Shared by source and bundle stages: compiled version, scripted demo, the three
        operator configs, a temporary daemon's exact hello; then the rename into place."""
        self.typed_dispatch(write_json, stage / ".orca-release.json", record)
        meta = metadata(stage)
        node, cli = meta["node"], Path(meta["entry"])
        if self.typed_process(capture, [node, str(cli), "--version"], cwd=stage, env=env) != record["version"]:
            raise RuntimeError("Built CLI version mismatch")
        # Exercises shipped workflows/templates and the compiled CLI against temporary stores.
        with tempfile.TemporaryDirectory(prefix="orca-validate-") as scratch:
            self.typed_process(run, [node, str(cli), "demo", "--dir", scratch], cwd=stage, env=demo_env)
        for config_key in ("cliConfig", "acpConfig", "daemonConfig"):
            self.typed_process(run, [node, str(cli), "--config", self.config[config_key], "validate"],
                cwd=self.config["cwd"], env=both_env_names({**env, "ORCA_RELEASE": str(stage)}, ["ORCA_RELEASE"]))
        with tempfile.TemporaryDirectory(prefix="orca-health-") as scratch:
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            child = self.typed_process(subprocess.Popen, [node, str(cli), "--cwd", scratch, "serve", "--port", str(port)],
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
        self.typed_dispatch(os.rename, stage, release)
        self.typed_dispatch(sync_dir, release.parent)
        return release.resolve()

    @typed_operation("update")
    def stage_bundle(self, source):
        """Stage a prebuilt signed server bundle: a published version (X.Y.Z, or X.Y.Z-rc.N
        for a release candidate) to download from its release page, or a directory holding the
        three release files. Needs Python 3 and
        util-linux only (no gh, git, mise or pnpm); cosign is fetched pinned."""
        assertion = self.typed_guard("update")
        self.retain_typed_inspection(assertion)
        if platform.system() != "Linux" or platform.machine() != "x86_64":
            raise RuntimeError("The server bundle is linux-x64 only")
        local = Path(source) if os.sep in source or source.startswith(".") else None
        if local is not None:
            if local.is_file():
                local = local.parent
            found = [re.fullmatch(r"(?:" + "|".join(BUNDLE_PRODUCTS) + r")-server-(" + VERSION_RE
                                  + r")-linux-x64\.manifest\.json", p.name) for p in local.iterdir()]
            versions = {match.group(1) for match in found if match}
            if len(versions) != 1:
                raise RuntimeError(f"Expected one server bundle in {local}")
            version = versions.pop()
        else:
            version = bundle_version(source)
        tag = "v" + version
        release = self.root / "releases" / tag
        if release.exists():
            raise RuntimeError(f"Release directory already exists: {release}; inspect it rather than overwrite")
        # Incomplete stages have unique names and are never candidates for activation.
        stage = Path(self.typed_dispatch(tempfile.mkdtemp, prefix=tag + ".staging-", dir=self.root / "releases"))
        downloads = Path(self.typed_dispatch(tempfile.mkdtemp, prefix=tag + ".bundle-", dir=self.root / "releases"))
        try:
            if local is None:
                self.fetch_bundle(version, downloads)
            else:
                product = bundle_product(version, lambda name: (local / name).is_file() or (local / name).is_symlink())
                for name in bundle_names(version, product)[1:]:
                    if (local / name).is_symlink() or not (local / name).is_file():
                        raise RuntimeError(f"Bundle file missing: {name}")
                    shutil.copyfile(local / name, downloads / name)
            manifest = self.verify_bundle(downloads, version)
            product = manifest["name"][:-len("-server")]
            # The exact signed bytes this release was verified from, kept as its durable receipt:
            # a later reuse (auto-update) must match all three digests, not just the commit.
            receipt = {}
            for kind, name in zip(("archive", "manifest", "signature"), bundle_names(version, product)[1:]):
                receipt[kind + "Sha256"] = file_sha256(downloads / name)
                receipt[kind + "Size"] = (downloads / name).stat().st_size
            if receipt["archiveSha256"] != manifest["archive"]["sha256"]:
                raise RuntimeError("Verified archive changed before unpacking")
            self.typed_dispatch(unpack_bundle, downloads / manifest["archive"]["name"], manifest["root"], stage)
        finally:
            shutil.rmtree(downloads, ignore_errors=True)
        for relative in (BUNDLE_NODE, manifest["entry"]):
            path = stage / relative
            if path.is_symlink() or not path.is_file():
                raise RuntimeError(f"Bundle has no regular {relative}")
        inside = json.loads((stage / f"{product}-server.json").read_text())
        contract = json.loads((stage / "release-compatibility.json").read_text())
        if (inside.get("version") != version or inside.get("sourceSha") != manifest["sourceSha"]
                or inside.get("entry") != manifest["entry"] or inside.get("node") != manifest["node"]["path"]
                or contract != manifest["compatibility"]):
            raise RuntimeError("Unpacked bundle disagrees with its signed manifest")
        record = {"version": version, "sha": manifest["sourceSha"], "node": BUNDLE_NODE,
                  "entry": manifest["entry"], "source": "bundle", "compatibility": contract,
                  "bundle": receipt}
        # The release's own shipped workflows and templates, also for the demo.
        env = {key: value for key, value in os.environ.items() if key not in (p + "RELEASE" for p in ENV_PREFIXES)}
        demo_env = both_env_names({**env, "ORCA_RELEASE": str(stage)}, ["ORCA_RELEASE"])
        return self.validate_stage(stage, release, record, env, demo_env=demo_env)

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
            if re.search(r"(?:(?:orca|orrery)-daemon|packages/cli/(?:dist|src)/main\.|(?:orca|orrery)\s+(?:acp|run|program|serve))", args):  # rename-keep: both
                raise RuntimeError(f"Unmanaged ORCA process blocks activation: pid {directory.name}")
        process_dir = Path("/proc") / str(service_pid)
        args = (process_dir / "cmdline").read_bytes().split(b"\0")
        expected = metadata((self.root / "current").resolve())["entry"].encode()
        if process_dir.stat().st_uid != os.getuid() or expected not in args or b"serve" not in args:
            raise RuntimeError("Service PID is not the expected managed daemon; inspect the actual launch method")
        environment = (process_dir / "environ").read_bytes().split(b"\0")
        gates = [(prefix + "ADMISSION_FILE=" + str(self.pending)).encode() for prefix in ENV_PREFIXES]
        if not any(gate in environment for gate in gates):
            raise RuntimeError("Managed daemon lacks the persistent admission guard; migrate its launcher first")
        return service_pid

    def expect_current(self, expected):
        """Refuse unless the active release is exactly `expected` (an app's confirmed predecessor)."""
        if expected is None:
            return
        running = metadata((self.root / "current").resolve(strict=True))["version"]
        if running != expected:
            raise RuntimeError(f"Server moved: it runs {running}, not the {expected} this update was confirmed against")

    def service_identity(self):
        """Which service process runs now: its PID, the unit's invocation (new on every start or
        supervisor restart), the process's start time (against PID reuse) and the boot."""
        shown = self.systemctl("show", self.config["service"], "--property=MainPID,InvocationID,NRestarts")
        fields = dict(line.split("=", 1) for line in (shown or "").splitlines() if "=" in line)
        pid = int(fields.get("MainPID") or 0)
        if pid <= 0 or not fields.get("InvocationID"):
            raise RuntimeError("The service has no running main process to hold to")
        stat = Path(f"/proc/{pid}/stat").read_text()
        started = stat[stat.rindex(")") + 2:].split()[19]
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        return {"pid": pid, "invocation": fields["InvocationID"], "restarts": fields.get("NRestarts"),
                "started": started, "boot": boot}

    def smoke(self, candidate):
        """After the first good hello, and before admission reopens: the very same service
        process (PID, invocation, start time, boot) must answer a healthy hello now and again
        after `settle` seconds. A supervisor restart in between is a failure, even if the
        restarted daemon is healthy: a crash loop or a late failure shows here."""
        before = self.service_identity()
        self.health(candidate, pid=before["pid"])
        time.sleep(getattr(self, "settle", 0))
        self.health(candidate, pid=before["pid"])
        after = self.service_identity()
        if after != before:
            changed = ", ".join(key for key in before if before[key] != after.get(key))
            raise RuntimeError(f"The service was restarted while settling ({changed} changed); not the process that passed")

    def finish_activation(self, record):
        """Remove the activation journal once admission reopened. A failure here is its own
        outcome: the journal is written again durably (it blocks launches and updates until
        recover) before that is claimed, and if even that fails, the report says it is unknown."""
        try:
            self.typed_dispatch(self.pending.unlink)
            self.typed_dispatch(sync_dir, self.root)
            return
        except Exception as error:
            failure = error
        version = metadata(Path(record["candidate"]))["version"]
        try:
            self.typed_dispatch(write_json, self.pending, {**record, "finalizeFailed": str(failure)})
        except Exception as keep_error:
            raise ActivationFinalizeFailed(
                f"{version} is active and admission reopened, but removing the activation journal failed ({failure})"
                f" and it could not be written again ({keep_error}): whether {self.pending} survives a restart is"
                " unknown. Check it: while it exists, launches and updates are blocked until recover") from failure
        raise ActivationFinalizeFailed(
            f"{version} is active and admission reopened, but removing the activation journal failed ({failure});"
            f" it was written again durably, so launches and updates are blocked. Inspect it, then run recover") from failure

    @typed_operation("update")
    def activate(self, candidate, expected=None, auto=False):
        assertion = self.typed_guard("update", (str(candidate),))
        self.retain_typed_inspection(assertion)
        with lock(self.root / "admission.lock"):
            if self.pending.exists():
                raise RuntimeError("Interrupted activation exists. Run recover before another update.")
            # Checked where the update commits, under both locks: another operator or the timer
            # may have moved the server since the caller looked.
            self.expect_current(expected)
            previous = (self.root / "current").resolve(strict=True)
            compatible(previous, candidate)
            old_version = version_key(metadata(previous)["version"])
            new_version = version_key(metadata(candidate)["version"])
            if new_version <= old_version:
                raise RuntimeError("Updates must move forward; use recovery for interrupted activation")
            self.inspect_processes()
            self.health(previous)
            token = str(uuid.uuid4())
            # The daemon checks this durable admission file before every operation,
            # including after a supervisor restart. Write it BEFORE inspecting activity.
            record = {"previous": str(previous), "candidate": str(candidate), "token": token, "opened": True}
            self.typed_dispatch(write_json, self.pending, record)
            try:
                self.barrier("prepare", token)
            except Exception as error:
                if str(error).startswith("Daemon busy:"):
                    self.typed_dispatch(self.pending.unlink)
                    self.typed_dispatch(sync_dir, self.root)
                # An uncertain prepare keeps admission closed for explicit recovery.
                raise
            record["opened"] = False
            self.typed_dispatch(write_json, self.pending, record)
            try:
                self.systemctl("stop", self.config["service"])
                self.typed_dispatch(select, self.root, candidate)
                self.systemctl("start", self.config["service"])
                self.health(candidate)
                if auto:
                    self.smoke(candidate)
                record["opened"] = True
                self.typed_dispatch(write_json, self.pending, record)
                self.barrier("resume", token)
            except Exception as error:
                if auto and record["opened"]:
                    # Admission reopened (or its resume is uncertain), so the new release may
                    # already hold work the old one would discard (#566's baseline): never roll
                    # back unattended. Close admission again if the daemon lets us, keep the
                    # journal (it blocks launches and updates), and report.
                    try:
                        self.barrier("prepare", token)
                        closed = "admission closed again"
                    except Exception as close_error:
                        closed = f"admission could not be closed again ({close_error})"
                    raise AutoRollbackRefused(
                        f"{metadata(candidate)['version']} failed after admission reopened, so it was not rolled back"
                        f" automatically; {closed}. Inspect it, then run recover: {error}") from error
                self.restore(record)
                raise RuntimeError(f"Activation failed; previous release restored and healthy: {error}") from error
            # Resume succeeded: the activation is done; only the journal's removal remains.
            self.finish_activation(record)

    @typed_operation("rollback")
    def restore(self, record):
        assertion = self.typed_guard("rollback", tuple(record.get(key, "") for key in ("previous", "candidate")))
        self.retain_typed_inspection(assertion)
        previous, candidate = Path(record["previous"]), Path(record["candidate"])
        compatible(previous, candidate)
        # Once resume was attempted its outcome can be uncertain (including a crash after
        # resume but before journal removal). Re-close admission before stopping anything.
        # If activity is unknown or busy, retain the journal and leave the daemon alone.
        if record.get("opened"):
            self.barrier("prepare", record["token"])
        # Otherwise every candidate/previous service started closed under this journal.
        self.systemctl("stop", self.config["service"])
        self.typed_dispatch(select, self.root, previous)
        self.systemctl("start", self.config["service"])
        self.health(previous)
        record["opened"] = True
        self.typed_dispatch(write_json, self.pending, record)
        self.barrier("resume", record["token"])
        self.typed_dispatch(self.pending.unlink)
        self.typed_dispatch(sync_dir, self.root)

    def launch(self, kind, args):
        # This lock includes the daemon, which must still bypass admission.lock
        # during a legacy closed update. Keep the descriptor inherited across exec.
        with typed_lifetime_lock(self.root / "typed-lifetime.lock") as lifetime:
            lifetime()
            self.typed_guard("launch")()
            if kind == "daemon":
                self.exec_release(kind, args)
            else:
                with lock(self.root / "admission.lock", exclusive=False) as lease:
                    if self.pending.exists():
                        raise RuntimeError("Activation/recovery pending; retry after recovery")
                    os.set_inheritable(lease.fileno(), True)
                    self.exec_release(kind, args)

    def exec_release(self, kind, args):
        # Direct callers get the same lifetime boundary as launch().
        with typed_lifetime_lock(self.root / "typed-lifetime.lock") as lifetime:
            self._exec_release(kind, args, lifetime)

    def _exec_release(self, kind, args, lifetime):
        assertion = self.typed_guard("launch")
        release = (self.root / "current").resolve(strict=True)
        meta = metadata(release)
        env = dict(os.environ)
        for prefix in ENV_PREFIXES:
            for name in ("RELEASE", "MAINTENANCE_TOKEN", "ADMISSION_FILE", *(n[len("ORCA_"):] for n in DEPLOYMENT_ENV)):
                env.pop(prefix + name, None)
        env["ORCA_RELEASE"] = str(release)
        if kind == "daemon":
            env["ORCA_ADMISSION_FILE"] = str(self.pending)
            # Reported in the daemon's hello (#879): the app runs this adapter over SSH to update
            # the server. Paths only; nothing installs through the daemon.
            env.update(self.deployment_env())
        both_env_names(env, ["ORCA_RELEASE", "ORCA_ADMISSION_FILE", *DEPLOYMENT_ENV])
        config = self.config[{"cli": "cliConfig", "acp": "acpConfig", "daemon": "daemonConfig"}[kind]]
        command = [meta["node"], meta["entry"], "--config", config]
        if kind == "daemon":
            command += ["--cwd", self.config["cwd"], "serve", "--host", "127.0.0.1", "--port", self.config["url"].rsplit(":", 1)[1]]
        elif kind == "acp":
            command += ["acp", *args]
        else:
            if "serve" in args:
                raise RuntimeError("Use the managed daemon service, not the CLI launcher")
            command += args
        # No await/process dispatch between the retained assertion and exec.
        if assertion() is not None:
            raise RuntimeError("Typed workspace inspection ownership unavailable")
        lifetime()
        os.execve(meta["node"], command, env)

    def offered_release(self, auto, token, channel):
        """The release for the version the feed offers: an already staged `releases/vX.Y.Z` of
        exactly that bundle, or the three files downloaded from the feed, checked against the
        channel file, then staged exactly as `stage --bundle DIR` (signature, manifest, archive,
        demo, config validation and a temporary daemon's hello) while work continues."""
        version = channel["version"]
        tag = "v" + version
        release = self.root / "releases" / tag
        if release.exists():
            meta = metadata(release)
            receipt = meta.get("bundle") if isinstance(meta.get("bundle"), dict) else {}
            offered = {key: channel[key] for key in channel if key.endswith(("Sha256", "Size"))}
            if (meta.get("source") != "bundle" or meta.get("sha") != channel["sourceSha"]
                    or {key: receipt.get(key) for key in offered} != offered):
                raise RuntimeError(f"{release} exists but was not verified from the exact bundle the feed offers"
                                   " (its receipt differs); inspect it")
            return release.resolve()
        downloads = Path(self.typed_dispatch(tempfile.mkdtemp, prefix=tag + ".feed-", dir=self.root / "releases"))
        try:
            for kind in ("archive", "manifest", "signature"):
                name = channel[kind]
                target = downloads / name
                if feed_get(f"{auto['feed']}/server/{name}", token, channel[kind + "Size"], target) is None:
                    raise RuntimeError(f"The feed offers {version} but does not serve {name}; retry later")
                if target.stat().st_size != channel[kind + "Size"] or file_sha256(target) != channel[kind + "Sha256"]:
                    raise RuntimeError(f"{name} from the feed does not match its channel file")
            release = self.stage_bundle(str(downloads))
        finally:
            shutil.rmtree(downloads, ignore_errors=True)
        if metadata(release).get("sha") != channel["sourceSha"]:
            raise RuntimeError(f"Staged {tag} is not the source commit the feed names")
        return release

    def prune_releases(self, keep):
        """Keep the active release and the one it replaced; remove other complete releases.
        Staging leftovers are left for inspection, and nothing is removed while a journal exists."""
        if self.pending.exists():
            return []
        kept = {Path(path).resolve() for path in keep}
        removed = []
        for path in sorted((self.root / "releases").iterdir()):
            if (re.fullmatch("v" + VERSION_RE, path.name) and not path.is_symlink() and path.is_dir()
                    and path.resolve() not in kept):
                self.typed_dispatch(shutil.rmtree, path)
                removed.append(path.name)
        return removed

    def auto_update(self, clock=time.time):
        """One unattended check (#878). Returns (ok, outcome); also writes auto-update.json."""
        auto = auto_update_config(self.config)
        self.settle = auto["settleSeconds"]
        status_path = self.root / AUTO_UPDATE_STATUS
        try:
            status = json.loads(status_path.read_text())
        except (FileNotFoundError, ValueError):
            status = {}
        now = clock()
        previous = (self.root / "current").resolve(strict=True)
        current = metadata(previous)["version"]
        report = {"checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "current": current}

        def finish(outcome, detail, ok=True):
            report.update(outcome=outcome, detail=detail)
            self.typed_dispatch(write_json, status_path, report)
            print(f"orca-release: auto-update {outcome}: {detail}", file=sys.stdout if ok else sys.stderr)
            return ok, outcome

        if self.pending.exists():
            return finish("blocked", "an interrupted activation is pending; inspect it, then run recover", False)
        if (self.root / AUTO_UPDATE_STOP).exists():
            return finish("stopped", f"{AUTO_UPDATE_STOP} exists in the deployment root; nothing is activated")
        try:
            return self._auto_update(auto, status, now, previous, current, report, finish, clock)
        except FeedStopped as error:
            return finish("stopped", f"{error}; nothing is activated, not even a staged release")
        except RuntimeError as error:
            # Reading the feed or staging failed: nothing was activated.
            return finish("failed", str(error), False)

    def _auto_update(self, auto, status, now, previous, current, report, finish, clock):
        token = read_feed_token(auto["tokenFile"])
        body = feed_get(f"{auto['feed']}/server/{SERVER_CHANNEL_FILE}", token, SERVER_CHANNEL_MAX)
        if body is None:
            return finish("none", f"the feed offers this server's ring no server bundle; {current} stays")
        try:
            channel = parse_server_channel(body.decode("ascii"))
        except UnicodeDecodeError:
            raise RuntimeError("Server channel file is not ASCII") from None
        offered = report["offered"] = channel["version"]
        if version_key(offered) <= version_key(current):
            return finish("current", f"{current} is current (the ring offers {offered})")
        candidate = self.offered_release(auto, token, channel)
        since = (status.get("deferredSince") or {}).get(offered)
        since = since if isinstance(since, (int, float)) and not isinstance(since, bool) and since <= now else now

        def defer(reason):
            report["deferredSince"] = {offered: since}
            hours = (now - since) / 3600
            if hours > auto["maxDeferralHours"]:
                return finish("overdue", f"{offered} is staged but has waited {hours:.0f} h, more than"
                              f" {auto['maxDeferralHours']} h; no work is cancelled: {reason}", False)
            return finish("deferred", f"{offered} is staged; activation waits: {reason}")

        # Staging can take long: the clock and the local stop are read again just before activating.
        if (self.root / AUTO_UPDATE_STOP).exists():
            return finish("stopped", f"{AUTO_UPDATE_STOP} exists in the deployment root; {offered} stays staged")
        if in_quiet_hours(auto["quietHours"], time.localtime(clock())):
            return defer(f"quiet hours {auto['quietHours']}")
        # And the feed is asked again: a stop or a withdrawn offer during staging wins.
        again = feed_get(f"{auto['feed']}/server/{SERVER_CHANNEL_FILE}", token, SERVER_CHANNEL_MAX)
        if again is None or again != body:
            return finish("withdrawn", f"the feed no longer offers exactly {offered}; {offered} stays staged, nothing is activated")
        try:
            self.activate(candidate, auto=True)
        except AutoRollbackRefused as error:
            return finish("failed-not-rolled-back", str(error), False)
        except ActivationFinalizeFailed as error:
            return finish("finalize-failed", str(error), False)
        except RuntimeError as error:
            message = str(error)
            if message.startswith(("Daemon busy:", "Unmanaged ORCA process blocks activation", "Busy: ")):
                return defer(message)
            if message.startswith("Store compatibility changed"):
                return finish("refused", f"{offered} changes the store format; update it by hand with the"
                              " documented backup/migration procedure", False)
            if message.startswith("Activation failed; previous release restored and healthy"):
                return finish("rolled-back", f"{offered} failed before admission reopened; {current} serves"
                              f" again: {message}", False)
            return finish("failed", message, False)
        removed = self.prune_releases((candidate, previous))
        return finish("updated", f"{current} -> {offered}" + (f"; removed {', '.join(removed)}" if removed else ""))

    def install_timer(self):
        """Write and start the systemd user timer that runs `auto-update` (#878)."""
        auto = auto_update_config(self.config)
        if not self.config.get("userService", True):
            raise RuntimeError("install-timer manages user services only; install a system timer by hand")
        adapter = Path(__file__).resolve()
        for path in (adapter, self.manifest, Path(sys.executable)):
            if not re.fullmatch(r"[A-Za-z0-9_./+-]+", str(path)):
                raise RuntimeError(f"Path {path} needs quoting in a unit file; use a plain path")
        units = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "systemd" / "user"
        units.mkdir(parents=True, exist_ok=True)
        (units / f"{AUTO_UPDATE_UNIT}.service").write_text(
            "[Unit]\nDescription=ORCA server automatic update (orca-release.py auto-update)\n\n"
            "[Service]\nType=oneshot\n"
            f"ExecStart={sys.executable} -I {adapter} --deployment {self.manifest} auto-update\n")
        (units / f"{AUTO_UPDATE_UNIT}.timer").write_text(
            "[Unit]\nDescription=Check the update feed for ORCA server releases\n\n"
            f"[Timer]\nOnBootSec=5min\nOnUnitActiveSec={auto['interval']}\nRandomizedDelaySec=5min\n"
            "Persistent=true\n\n[Install]\nWantedBy=timers.target\n")
        self.systemctl("daemon-reload")
        self.systemctl("enable", "--now", f"{AUTO_UPDATE_UNIT}.timer")
        return units / f"{AUTO_UPDATE_UNIT}.timer"


def fetch_only(argv):
    """`fetch-bundle --cache DIR VERSION OUT`: download release vVERSION's recorded server
    bundle into the new directory OUT and verify it exactly as `stage --bundle` does (pinned
    signer, manifest, archive digest), without staging anything. Prints the manifest."""
    parser = argparse.ArgumentParser(prog="orca-release.py fetch-bundle")
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("version")
    parser.add_argument("out", type=Path)
    options = parser.parse_args(argv)
    if not re.fullmatch(VERSION_RE, options.version):
        raise RuntimeError("Supply a version X.Y.Z or X.Y.Z-rc.N")
    options.out.mkdir(mode=0o700)
    source = BundleSource(options.cache)
    source.root.mkdir(mode=0o700, parents=True, exist_ok=True)
    source.fetch_bundle(options.version, options.out)
    print(json.dumps(source.verify_bundle(options.out, options.version), sort_keys=True))


def main():
    if sys.argv[1:2] == ["fetch-bundle"]:
        return fetch_only(sys.argv[2:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deployment", required=True)
    parser.add_argument("action", choices=["stage", "update", "recover", "cli", "acp", "daemon",
                                           "auto-update", "install-timer"])
    parser.add_argument("args", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    deploy = Deployment(options.deployment)
    if options.action in ("cli", "acp", "daemon"):
        return deploy.launch(options.action, options.args)
    if options.action in ("auto-update", "install-timer") and options.args:
        raise RuntimeError(f"{options.action} takes no arguments; it reads autoUpdate in deployment.json")
    if options.action == "install-timer":
        print(deploy.install_timer())
        return
    if options.action == "auto-update":
        deploy.typed_guard("update")()
        with contextlib.ExitStack() as stack:
            try:
                stack.enter_context(lock(deploy.root / "update.lock"))
            except RuntimeError as error:
                # A manual update (or another check) holds the lock: this run defers to it.
                print(f"orca-release: auto-update deferred: {error}")
                return
            ok, _ = deploy.auto_update()
        if not ok:
            sys.exit(1)
        return
    deploy.typed_guard("rollback" if options.action == "recover" else "update")()
    with lock(deploy.root / "update.lock"):
        if options.action == "recover":
            with lock(deploy.root / "admission.lock"):
                deploy.restore(json.loads(deploy.pending.read_text()))
        else:
            args = list(options.args)
            expected = None
            if "--expect-current" in args:
                at = args.index("--expect-current")
                if options.action != "update" or at + 1 >= len(args):
                    raise RuntimeError("--expect-current takes one release version, with update")
                expected = args[at + 1]
                if not re.fullmatch(VERSION_RE, expected):
                    raise RuntimeError("--expect-current takes a release version such as 0.8.0")
                del args[at:at + 2]
                # Fail before staging when the server already moved; activation checks again.
                deploy.expect_current(expected)
            bundle = args[:1] == ["--bundle"]
            if bundle:
                args = args[1:]
            if len(args) != 1:
                raise RuntimeError("Supply one published release tag" + (" or bundle directory" if bundle else ""))
            if deploy.pending.exists():
                raise RuntimeError("Recovery pending; run recover first")
            existing = deploy.root / "releases" / args[0]
            if options.action == "update" and re.fullmatch(r"v" + VERSION_RE, args[0]) and existing.exists():
                metadata(existing)
                candidate = existing.resolve()
            elif bundle:
                candidate = deploy.stage_bundle(args[0])
            else:
                candidate = deploy.stage(args[0])
            if options.action == "update":
                deploy.activate(candidate, expected)
            print(candidate)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"orca-release: {error}", file=sys.stderr)
        sys.exit(1)
