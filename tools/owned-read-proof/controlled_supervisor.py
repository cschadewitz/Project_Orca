"""Bounded disposable original supervisor, with an explicitly designated test lane.

Retains original file bytes/identities before launch, keeps the actual flock and
pipe endpoints through independent replay, and preserves raw traces on failure.
No report, digest or command-line flag constructs a connected capability here.
"""
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import selectors
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass

from run import require_exitkill, run_traced
from verify import identity
from controlled_replay import Replay, LIMIT
from controlled_contract import require
from controlled_semantics import authenticate_bootstrap
from kernel_runtime_queries import KernelRuntimeQueries
from controlled_timestamps import OPTION, NS, RUN_NS, probe_clock, sample_clock, clock_namespaces, sha as clock_sha, validate_clock

REPO = Path(__file__).resolve().parents[2]
SOURCE = '3fce8bcc9afd381cd07c0e06051921307d6322b3'
QUERY_PATHS = ('/proc/self/maps', '/proc/self/cgroup', '/proc/meminfo',
               '/sys/fs/cgroup//memory.max', '/sys/fs/cgroup//memory.high')
OBSERVER_FILES = ('controlled_supervisor.py', 'controlled_observation.py', 'controlled_aggregate.py', 'controlled_diagnostics.py',
    'controlled_connected.py', 'controlled_replay.py', 'controlled_contract.py', 'controlled_notifications.py',
    'controlled_semantics.py', 'controlled_delivery_semantics.py', 'controlled_save_semantics.py',
    'controlled_timestamps.py', 'controlled_v2_model.py', 'kernel_runtime_queries.py', 'run.py', 'verify.py')
REPORT_LIMIT = 1024 * 1024
ORIGINAL_METADATA_LIMIT = 1024 * 1024
RUNTIME_ASSET_LIMIT = 256 * 1024 * 1024
MAX_RUNTIME_ASSETS = 32
ORIGINAL_KEYS = frozenset(('base', 'lane', 'node', 'argv', 'sourceHead', 'controlledBuild', 'traceClock',
    'observerImplementation', 'clockProbePath', 'supervisorPid', 'readlinks', 'inheritedUmask',
    'commandFd', 'ackFd', 'lifetimeFd', 'immutable', 'directories', 'queries', 'absentProbes',
    'queryMetadata', 'phases', 'usedTokens', 'inputHex', 'offset', 'length', 'descriptors',
    'diagnosticConfig', 'startedWallNs', 'clockSamples', 'leaderPid', 'kernelRuntimeQueries',
    'finishedWallNs', 'finalPhysicalObservations'))
REPORT_KEYS = frozenset(('record', 'authority', 'root', 'sourceHead', 'connectedCommandsReleased',
    'acceptingToken', 'productionEligible', 'imageProducerSha256', 'imageChildSha256', 'imageBuildSha256',
    'elapsedNanoseconds', 'elapsedSeconds', 'traceBytes', 'traceSha256', 'returncode', 'producerStderr', 'kernel',
    'semantic', 'qualification', 'refusal', 'diagnostic', 'diagnosticRefusal', 'phaseLog', 'observerImplementation'))


def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_fingerprint(path, maximum=None):
    value = hashlib.sha256()
    count = 0
    with Path(path).open('rb') as stream:
        while True:
            chunk = stream.read(1024 * 1024 if maximum is None else min(1024 * 1024, maximum + 1 - count))
            if not chunk:
                break
            count += len(chunk)
            require(maximum is None or count <= maximum, 'evidence grew beyond artifact byte bound')
            value.update(chunk)
    return value.hexdigest(), count


def file_digest(path, maximum=None):
    return file_fingerprint(path, maximum)[0]


def evidence_seal(path, maximum=LIMIT):
    """Fresh full hash and physical stamp, including for large retained traces."""
    p = Path(path)
    before = stamp(p)
    require(stat.S_ISREG(int(before[2])) and before[5] == '1' and 0 <= int(before[6]) <= maximum,
            'bootstrap receipt needs bounded unaliased original evidence')
    value = file_digest(p, maximum=maximum)
    require(stamp(p) == before, 'bootstrap receipt evidence changed during hash')
    return before, value


def metadata_bytes(value, maximum):
    """Bound source-owned JSON before serializing, excluding separately pinned asset hex.

    Limits are refusal conditions, not permission to add fields to source grammar.
    Kernel mountinfo is the one long metadata string; no retained payload belongs here.
    """
    remaining, nodes = maximum, 16384

    def visit(item, depth=0, key=None):
        nonlocal remaining, nodes
        nodes -= 1
        require(nodes >= 0 and depth <= 16, 'packet metadata nesting/count exceeds bound')
        if type(item) is dict:
            require(len(item) <= 1024, 'packet metadata object exceeds finite count')
            remaining -= 2 + max(0, len(item) - 1)
            for name, child in item.items():
                require(type(name) is str and len(name) <= 4096, 'packet metadata key exceeds bound')
                visit(name, depth + 1)
                remaining -= 1
                visit(child, depth + 1, name)
        elif type(item) is list:
            require(len(item) <= 1024, 'packet metadata array exceeds finite count')
            remaining -= 2 + max(0, len(item) - 1)
            for child in item:
                visit(child, depth + 1)
        else:
            if type(item) is str:
                require(len(item) <= (256 * 1024 if key == 'mountinfo' else 4096),
                        'packet metadata string exceeds bound')
            else:
                require(item is None or type(item) in (bool, int, float), 'unknown packet metadata type')
                require(type(item) is not int or item.bit_length() <= 128, 'packet metadata integer exceeds bound')
                require(type(item) is not float or math.isfinite(item), 'nonfinite packet metadata')
            remaining -= len(encoded(item).encode())
        require(remaining >= 0, 'packet metadata serialization exceeds bound')

    visit(value)
    return encoded(value).encode()


def consumed_witness_pin(original, replay):
    """Use the original replay object, never repin a consumed path or packet hex."""
    require(replay.original is original, 'consumed witness belongs to another original replay')
    path = str(Path(original['base']) / 'control/never-typed')
    witnesses = [obj for obj in replay.objects if obj.family == 'enrollment-witness']
    require(len(witnesses) == 1, 'missing/ambiguous original consumed witness object')
    obj = witnesses[0]
    require(type(obj.data) is bytes and len(obj.data) <= 130 and
            re.fullmatch(b'[0-9a-f]{64}\n[0-9a-f]{64}\n', obj.data) is not None and
            obj.physical is not None and replay.inodes.get(obj.physical) is obj and
            stat.S_ISREG(obj.mode) and obj.names == set() and path not in replay.paths and
            path in replay.used_paths and not any(h.obj is obj for h in replay.handles.values()),
            'original witness lacks settled consumed lineage')
    entered, completed = getattr(obj, 'removal_entry', None), getattr(obj, 'removal_completion', None)
    intent = replay.paths.get(str(Path(original['base']) / 'control/intent.json'))
    require(type(entered) is int and type(completed) is int and 0 <= entered <= completed and
            entered in replay.entry_times and completed in replay.entry_times and
            intent is not None and intent.family == 'control-record' and
            type(intent.creation_entry) is int and completed < intent.creation_entry,
            'original witness lacks successful unlink before intent')
    try:
        Path(path).lstat()
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError('consumed witness pathname resurrected')
    return {'identity': [os.makedev(*obj.physical[:2]), obj.physical[2], obj.mode, obj.uid, obj.gid],
            'size': len(obj.data), 'sha256': digest(obj.data), 'family': 'enrollment-witness'}


def bootstrap_asset_pins(original, files, replay):
    """Finite SOURCE inventory: three image entries, loader-resolved runtime, four originals.

    Live sizes/digests and the independently replayed consumed witness must equal
    the original closed run. No packet JSON supplies pins or a larger allowance.
    """
    base = Path(original['base'])
    paths = runtime_paths(original['node'])
    require(len(paths) <= MAX_RUNTIME_ASSETS, 'runtime asset count exceeds finite bound')
    limits = {p: ('runtime', RUNTIME_ASSET_LIMIT) for p in paths}
    limits.update({str(base / 'workspace/.orca/workspace-identity/id'): ('original-file', 37),
                   str(base / 'controlled-plan.json'): ('original-file', 65536),
                   str(base / 'lifetime.lock'): ('lifetime', 0)})
    require(not set(files) & set(limits), 'bootstrap asset inventory aliases image paths')
    pins = {p: {'identity': list(s[:5]), 'size': len(data), 'sha256': digest(data), 'family': 'image'}
            for p, (s, data) in files.items()}
    pins[str(base / 'control/never-typed')] = consumed_witness_pin(original, replay)
    for path, (family, maximum) in limits.items():
        p = Path(path)
        info = p.stat() if family == 'runtime' else p.lstat()
        before = (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                  info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        regular = stat.S_ISREG(info.st_mode)
        require((regular and 0 <= info.st_size <= maximum) or
                (path == '/dev/null' and stat.S_ISCHR(info.st_mode)), 'bootstrap asset type/size exceeds bound')
        value, size = file_fingerprint(p, maximum=info.st_size) if regular else (digest(b''), 0)
        require(not regular or size == info.st_size or path == '/sys/devices/system/cpu/online',
                'bootstrap asset read size differs from pinned regular file')
        after = p.stat() if family == 'runtime' else p.lstat()
        require(before == (after.st_dev, after.st_ino, after.st_mode, after.st_uid, after.st_gid,
                           after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                'bootstrap asset changed during size/digest pin')
        pins[path] = {'identity': list(before[:5]), 'size': size,
                      'sha256': value, 'family': family}
    return pins


def originals_packet_limit(original, pins):
    require(type(original) is dict and set(original) <= ORIGINAL_KEYS, 'unknown originals packet fields')
    entries = original['immutable']
    require(type(entries) is dict and set(entries) == set(pins), 'originals asset inventory/count differs')
    metadata = {**original, 'immutable': {}}
    hex_size = 0
    for path, entry in entries.items():
        require(type(entry) is dict and set(entry) == {'identity', 'hex', 'sha256', 'family'},
                'unknown originals asset fields')
        pin = pins[path]
        require(entry['identity'] == pin['identity'] and type(entry['identity']) is list and
                all(type(v) is int for v in entry['identity']) and entry['family'] == pin['family'] and
                entry['sha256'] == pin['sha256'] and type(entry['hex']) is str and
                len(entry['hex']) == 2 * pin['size'], 'originals asset size/digest/identity differs')
        value = hashlib.sha256()
        for offset in range(0, len(entry['hex']), 65536):
            chunk = entry['hex'][offset:offset + 65536]
            require(re.fullmatch('[0-9a-f]*', chunk) is not None, 'noncanonical originals asset hex')
            value.update(bytes.fromhex(chunk))
        require(value.hexdigest() == pin['sha256'], 'originals asset digest differs')
        metadata['immutable'][path] = {**entry, 'hex': ''}
        hex_size += 2 * pin['size']
    metadata_bytes(metadata, ORIGINAL_METADATA_LIMIT)
    return hex_size + ORIGINAL_METADATA_LIMIT


def packet_matches(path, expected, maximum):
    """Compare full canonical bytes with bounded reads, without another packet-sized allocation."""
    require(len(expected) <= maximum, 'canonical packet exceeds artifact bound')
    offset = 0
    with Path(path).open('rb') as stream:
        while True:
            chunk = stream.read(min(1024 * 1024, maximum + 1 - offset))
            if not chunk:
                return offset == len(expected)
            require(offset + len(chunk) <= maximum, 'packet grew beyond artifact bound')
            if chunk != expected[offset:offset + len(chunk)]:
                return False
            offset += len(chunk)


def stamp(path):
    s = Path(path).lstat()
    return list(map(str, [s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink,
                         s.st_size, s.st_mtime_ns, s.st_ctime_ns]))


def fd_identity(number):
    s = os.fstat(number)
    return [s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid]


def immutable(path, family, follow=False):
    p = Path(path)
    s = p.stat() if follow else p.lstat()
    data = p.read_bytes() if stat.S_ISREG(s.st_mode) else b''
    return {'identity': [s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid],
            'hex': data.hex(), 'sha256': digest(data), 'family': family}


def directory(path):
    s = path.lstat()
    return {'path': str(path), 'device': s.st_dev, 'inode': s.st_ino}


def prepare(base, image, lifetime, command, ack, phases):
    for name in ('workspace', 'workspace/.orca', 'workspace/.orca/workspace-identity', 'control', 'releases'):
        (base / name).mkdir(mode=0o700)
    ident = base / 'workspace/.orca/workspace-identity/id'
    ident.write_text(str(uuid.uuid4()) + '\n')
    ident.chmod(0o600)
    w, store = base / 'workspace', base / 'workspace/.orca'
    value = {'control': directory(base / 'control'), 'releases': directory(base / 'releases'),
             'workspaceIdentity': {'path': str(ident), 'device': ident.stat().st_dev,
                 'inode': ident.stat().st_ino, 'digest': digest(ident.read_bytes().hex().encode()),
                 'directory': directory(ident.parent)},
             'roles': [{'role': role, 'path': str(p), 'directory': directory(parent), 'target': str(w)}
                 for role, p, parent in [('config', w, w), ('sidecar', w / 'orca.permissions.json', w), ('store', store, store)]],
             'targets': [directory(w)]}
    witness = base / 'control/never-typed'
    witness.write_text(digest(ident.read_bytes()) + '\n' + digest(encoded(value).encode()) + '\n')
    witness.chmod(0o600)
    def association(p):
        return {'identity': identity(p), 'sha256': digest(p.read_bytes())}
    inventory = {str(p): {**association(p), 'stamp': stamp(p)} for p in sorted(image.iterdir())}
    roots = {str(p): identity(p) for p in [base, w, store, ident.parent, base / 'control', base / 'releases']}
    plan = {'version': 1, 'lane': 'bootstrap', 'inputHex': b'disposable candidate bytes'.hex(),
            'offset': 2, 'length': 4, 'phases': phases,
            'lifetime': {'path': str(base / 'lifetime.lock'), 'identity': fd_identity(lifetime)},
            'commandIdentity': fd_identity(command), 'ackIdentity': fd_identity(ack), 'roots': roots,
            'originalFiles': {str(ident): association(ident)},
            'enrollmentWitness': {'path': str(witness), **association(witness)}, 'inventory': inventory}
    p = base / 'controlled-plan.json'
    p.write_text(encoded(plan))
    p.chmod(0o600)
    return plan


def prepare_connected(base, image, lifetime, command, ack, phases, designation):
    """Prepare association bytes only; never send a command or launch a child.

    The parent must explicitly designate original closed bootstrap evidence in
    memory. Source/image checks remain mandatory. Complete connected private-I/O
    replay and authenticated authority/delivery semantics are still pending.
    """
    from controlled_connected import ConnectedDesignation
    require(type(designation) is ConnectedDesignation, 'missing explicit connected designation')
    designation.check()
    require(str(image) == designation.image, 'connected image is not original designated image')
    require(base.is_absolute() and str(base) != designation.bootstrap_base and
            Path(designation.bootstrap_base) not in base.parents and base not in Path(designation.bootstrap_base).parents,
            'connected base reuses bootstrap lifetime/root')
    require(list(base.iterdir()) == [base / 'lifetime.lock'], 'connected base is not fresh')
    require(stat.S_ISDIR(base.lstat().st_mode), 'connected base is not an original directory')
    require(fd_identity(lifetime) == identity(base / 'lifetime.lock') and
            fd_identity(lifetime)[:2] != designation.bootstrap_lifetime[:2],
            'connected lifetime aliases original bootstrap')
    require(re.search(r'FLOCK\s+ADVISORY\s+WRITE\s+' + str(os.getpid()) + r'\s+',
            Path(f'/proc/self/fdinfo/{lifetime}').read_text()), 'connected lifetime has no original supervisor flock')
    other = os.open(base / 'lifetime.lock', os.O_RDWR | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            raise RuntimeError('connected lifetime exclusion missing')
    finally:
        os.close(other)
    require(len({lifetime, command, ack}) == 3 and all(n > 2 for n in (lifetime, command, ack)) and
            stat.S_ISFIFO(os.fstat(command).st_mode) and stat.S_ISFIFO(os.fstat(ack).st_mode) and
            fd_identity(command)[:2] != fd_identity(ack)[:2], 'connected control descriptor aliases')
    require([p['name'] for p in phases] == ['save', 'human-read', 'rule-read'], 'wrong connected phase order')
    require(len({p['token'] for p in phases}) == 3 and all(type(p['token']) is str and
            re.fullmatch(r'[0-9a-f]{64}', p['token']) for p in phases), 'wrong connected phase token')
    assert_image_sources(image)
    plan = prepare(base, image, lifetime, command, ack, phases)
    plan['lane'] = 'connected'
    plan['bootstrap'] = designation.association(plan['inventory'])
    plan['originalFiles'][designation.evidence_path] = {
        'identity': list(designation.proof[0][:5]), 'sha256': digest(designation.proof[1])}
    (base / 'controlled-plan.json').write_text(encoded(plan))
    designation.check()
    return plan


def runtime_paths(node):
    # Fixed loader/config/query paths, plus the exact loader-resolved shared
    # libraries of this retained Node binary. No external package-root exemption.
    result = subprocess.run(['ldd', node], capture_output=True, text=True, check=True, timeout=5)
    paths = set(re.findall(r'(/[^\s()]+)', result.stdout))
    paths |= {node, '/etc/ld.so.cache', '/etc/ssl/openssl.cnf', '/etc/localtime',
              '/sys/devices/system/cpu/online', '/dev/null'}
    return paths


def runtime_originals(node):
    return {p: immutable(p, 'runtime', follow=True) for p in sorted(runtime_paths(node))}


def assert_image_sources(image):
    build = json.loads((image / 'controlled-build.json').read_text())
    require(build['entry'] == 'controlled-child.mjs' and build['profileRef'] == 'orca-owned-file-read-v1', 'supervisor retained-original check failed')
    for name, field in [('controlled-child.mjs', 'childSha256'), ('controlled-producer.mjs', 'producerSha256')]:
        require(digest((image / name).read_bytes()) == build[field], 'supervisor retained-original check failed')
    require((image / 'controlled-child.mjs').read_bytes() == (REPO / 'tools/owned-read-proof/controlled-child.mjs').read_bytes(), 'supervisor retained-original check failed')
    reviewed_child = subprocess.run(['git', 'show', SOURCE + ':tools/owned-read-proof/controlled-child.mjs'],
                                    cwd=REPO, capture_output=True, check=True, timeout=5).stdout
    require((image / 'controlled-child.mjs').read_bytes() == reviewed_child,
            'installed child differs from reviewed producer source')
    for name, expected in build['sources'].items():
        require(digest((REPO / name).read_bytes()) == expected, 'supervisor retained-original check failed')
        # Repository inputs must match the reviewed producer commit. Dependency
        # bytes remain pinned build inputs, not an independent trust designation.
        if not name.startswith('node_modules/'):
            original = subprocess.run(['git', 'show', SOURCE + ':' + name], cwd=REPO,
                                      capture_output=True, check=True, timeout=5).stdout
            require(digest(original) == expected, 'supervisor retained-original check failed')
    return build


def observer_original():
    directory = Path(__file__).parent
    return {'gitHead': subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=REPO, check=True,
        capture_output=True, text=True, timeout=5).stdout.strip(),
        'files': {name: digest((directory / name).read_bytes()) for name in OBSERVER_FILES}}


def assert_observer(original):
    # No subprocess here: while run_traced owns/reaps its process group the
    # supervisor must not launch a concurrent git child that could be adopted.
    directory = Path(__file__).parent
    require({name: digest((directory / name).read_bytes()) for name in OBSERVER_FILES} == original['files'],
            'observer implementation changed during original invocation')


@dataclass
class ObservedRun:
    report: dict
    original: dict
    replay: object
    report_path: Path
    closed: bool = False

    def assert_bootstrap_closed(self):
        # This original supervisor retains actual validated objects, not a child
        # report or a deserialized acceptance flag. Cooperative source trust only.
        require(self.closed and self.original['lane'] == 'bootstrap' and self.replay is not None,
                'missing permanently closed original bootstrap')
        require(self.replay.threads == self.replay.settled and len(self.replay.resources) == 1,
                'original bootstrap process graph is not settled')
        resource = self.replay.resources[0]
        require(resource.names == set() and len(resource.reads) == 1 and not any(
                h.obj is resource for h in self.replay.handles.values()), 'original bootstrap service is not closed')
        # Re-run original authenticated correlations, never reconstruct a live
        # process from current /proc or treat a producer boolean as authority.
        authenticate_bootstrap(self.replay)
        assert_observer(self.original['observerImplementation'])

    def designate_bootstrap(self, image):
        """Designate a small association, retaining every complete original packet.

        The receipt cannot import authority. Its checker closes over THIS original
        run and reexecutes its closed-graph assertion and fresh evidence hashes.
        No receipt/report deserializer or success flag can supply that callable.
        """
        from controlled_connected import ConnectedDesignation, IMAGE_NAMES, snapshot
        require(self.assert_bootstrap_closed() is None, 'original bootstrap closure assertion returned a flag')
        root = self.report_path.parent
        base = root / 'bootstrap'
        image = Path(image)
        require(root.is_absolute() and self.report_path == root / 'bootstrap-attempt.json' and
                self.original['base'] == str(base) and self.replay.original is self.original and
                self.report['root'] == str(root) and
                self.original['sourceHead'] == self.report['sourceHead'] == SOURCE and
                'refusal' not in self.report, 'bootstrap receipt belongs to another original run')
        build = assert_image_sources(image)
        require(build == self.original['controlledBuild'], 'bootstrap receipt image build differs')
        require({p.name for p in image.iterdir()} == IMAGE_NAMES, 'bootstrap receipt image count/paths differ')
        files = {str(p): snapshot(p) for p in sorted(image.iterdir())}
        require(set(files) == {p for p, value in self.original['immutable'].items() if value['family'] == 'image'},
                'bootstrap receipt image is not original inventory')
        for path, (physical, data) in files.items():
            original = self.original['immutable'][path]
            require(original['identity'] == list(physical[:5]) and original['hex'] == data.hex() and
                    original['sha256'] == digest(data), 'bootstrap receipt image differs from original bytes')
        for name, field in [('controlled-producer.mjs', 'imageProducerSha256'),
                            ('controlled-child.mjs', 'imageChildSha256'),
                            ('controlled-build.json', 'imageBuildSha256')]:
            require(self.report[field] == digest(files[str(image / name)][1]), 'bootstrap receipt report image differs')
        originals_path, trace = root / 'bootstrap-originals.json', base / 'trace'
        require(type(self.report) is dict and set(self.report) <= REPORT_KEYS, 'unknown report packet fields')
        pins = bootstrap_asset_pins(self.original, files, self.replay)
        originals_limit = originals_packet_limit(self.original, pins)
        limits = {str(self.report_path): REPORT_LIMIT, str(originals_path): originals_limit, str(trace): LIMIT}
        seals = {p: evidence_seal(p, maximum) for p, maximum in limits.items()}
        report_bytes, original_bytes = metadata_bytes(self.report, REPORT_LIMIT), encoded(self.original).encode()
        require(packet_matches(self.report_path, report_bytes, REPORT_LIMIT) and
                packet_matches(originals_path, original_bytes, originals_limit),
                'bootstrap receipt report/originals differ from original run')
        require(len({tuple(value[0][:2]) for value in seals.values()} |
                    {tuple(map(str, value[0][:2])) for value in files.values()}) == len(seals) + len(files),
                'bootstrap receipt originals alias image/evidence')
        trace_sha = seals[str(trace)][1]
        require(self.report['traceSha256'] == self.report['kernel']['traceSha256'] == trace_sha and
                self.report['traceBytes'] == self.report['kernel']['traceBytes'] == trace.stat().st_size,
                'bootstrap receipt trace differs from original replay')
        evidence_ref = 'controlled-bootstrap-source-preparation:' + trace_sha
        value = {'record': 'controlled-bootstrap-association-v1', 'sourceHead': SOURCE,
                 'evidenceRef': evidence_ref, 'bootstrapBase': str(base),
                 'observerImplementationSha256': digest(encoded(self.original['observerImplementation']).encode()),
                 'image': {path: digest(data) for path, (_, data) in files.items()},
                 'report': {'path': str(self.report_path), 'sha256': seals[str(self.report_path)][1]},
                 'originals': {'path': str(originals_path), 'sha256': seals[str(originals_path)][1]},
                 'trace': {'path': str(trace), 'sha256': trace_sha}}
        path = root / 'bootstrap-association.json'
        data = encoded(value).encode()
        require(len(data) <= 4096, 'bootstrap association exceeds compact receipt bound')
        with path.open('xb') as stream:
            os.fchmod(stream.fileno(), 0o400)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())

            def writer_stamp():
                info = os.fstat(stream.fileno())
                return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                        info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

            before = writer_stamp()
            require(stat.S_ISREG(before[2]) and stat.S_IMODE(before[2]) == 0o400 and
                    before[5] == 1 and before[6] == len(data) <= 4096,
                    'initial bootstrap receipt writer bounds differ')
            proof = snapshot(path)
            require(before == proof[0] == writer_stamp() and proof[1] == data and len(proof[1]) <= 4096,
                    'initial bootstrap receipt differs from original writer/serialized bytes')

        def assert_original_receipt():
            require(self.assert_bootstrap_closed() is None, 'original bootstrap closure assertion returned a flag')
            require(consumed_witness_pin(self.original, self.replay) ==
                    pins[str(base / 'control/never-typed')], 'original consumed witness changed')
            require(type(self.report) is dict and set(self.report) <= REPORT_KEYS, 'unknown report packet fields')
            originals_packet_limit(self.original, pins)
            require(metadata_bytes(self.report, REPORT_LIMIT) == report_bytes and
                    encoded(self.original).encode() == original_bytes,
                    'bootstrap receipt original run changed')
            for original_path, retained in seals.items():
                require(evidence_seal(original_path, limits[original_path]) == retained,
                        'bootstrap receipt original evidence changed')
            for original_path, retained in files.items():
                require(snapshot(original_path) == retained, 'bootstrap receipt original image changed')
            require(snapshot(path) == proof, 'bootstrap association receipt changed')

        return ConnectedDesignation(bootstrap_base=base, evidence_path=path, evidence_ref=evidence_ref,
                                    image=image, assert_bootstrap_closed=assert_original_receipt)


def observe(root, image, lane='bootstrap', designation=None, used_tokens=None, diagnostic=False):
    """Disabled live entry point; historical body retained for source review."""
    raise RuntimeError('non-live preparation: observer launch disabled')

    # Historical implementation retained for review only. No CLI/flag/report can
    # reach it in this preparation branch; changing this refusal needs new authority.
    require(lane in {'bootstrap', 'connected'}, 'unknown controlled observation lane')
    require(type(diagnostic) is bool, 'diagnostic mode must be an explicit supervisor boolean')
    if lane == 'connected':
        from controlled_connected import ConnectedDesignation
        require(type(designation) is ConnectedDesignation, 'missing explicit connected designation')
        designation.check()
    else:
        require(designation is None, 'bootstrap cannot receive connected designation')
    implementation = observer_original()
    build = assert_image_sources(image)
    base = root / lane
    base.mkdir(mode=0o700)
    lock = base / 'lifetime.lock'
    lifetime = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lifetime, fcntl.LOCK_EX | fcntl.LOCK_NB)
    other = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            raise RuntimeError('independent lifetime exclusion missing')
    finally:
        os.close(other)
    command, send = os.pipe()
    receive, ack = os.pipe()
    out_read, out_write = os.pipe()
    err_read, err_write = os.pipe()
    names = ['bootstrap'] if lane == 'bootstrap' else ['save', 'human-read', 'rule-read']
    phases = [{'name': name, 'token': secrets.token_hex(32)} for name in names]
    used_tokens = set() if used_tokens is None else used_tokens
    require(type(used_tokens) is set and not {p['token'] for p in phases} & used_tokens, 'replayed original phase token')
    plan = (prepare(base, image, lifetime, command, ack, phases) if lane == 'bootstrap' else
            prepare_connected(base, image, lifetime, command, ack, phases, designation))
    node, tracer = shutil.which('node'), shutil.which('strace')
    require_exitkill(tracer)
    clock_root = root / (lane + '-clock')
    clock_root.mkdir(mode=0o700)
    trace_clock = probe_clock(tracer, clock_root)
    argv = [node, str(image / 'controlled-child.mjs'), str(base), lane, str(lifetime), str(command), str(ack)]
    originals = {p: immutable(p, 'image') for p in plan['inventory']}
    originals.update(runtime_originals(node))
    originals.update({p: immutable(p, 'original-file') for p in plan['originalFiles']})
    originals[str(base / 'controlled-plan.json')] = immutable(base / 'controlled-plan.json', 'original-file')
    originals[plan['enrollmentWitness']['path']] = immutable(plan['enrollmentWitness']['path'], 'enrollment-witness')
    originals[str(lock)] = immutable(lock, 'lifetime')
    dirs = dict(plan['roots'])
    for path in list(originals) + [str(image), str(root)]:
        p = Path(path)
        for parent in [p] + list(p.parents):
            if parent.is_dir() and not parent.is_symlink():
                dirs[str(parent)] = identity(parent)
    queries = {p: 65536 for p in QUERY_PATHS}
    queries[f'/proc/self/fdinfo/{lifetime}'] = 4096
    query_metadata = {p: [Path(p).stat().st_mode, Path(p).stat().st_uid, Path(p).stat().st_gid]
                      for p in queries}
    probes = ['/etc/ld.so.preload', '/proc/version_signature', '/sys/devices/system/cpu/cpu0/tsc_freq_khz',
              str(image / 'package.json'), str(root / 'package.json'), '/tmp/package.json',
              str(image / 'node_modules'), str(root / 'node_modules'), '/tmp/node_modules', '/node_modules',
              str(base / '.node_modules'), str(base / '.node_libraries'), str(Path(node).parent.parent / 'lib/node')]
    require(all(not Path(p).exists() and not Path(p).is_symlink() for p in probes), 'probe is not originally absent')
    original = {'base': str(base), 'lane': lane, 'node': node, 'argv': argv,
                'sourceHead': SOURCE, 'controlledBuild': build, 'traceClock': trace_clock,
                'observerImplementation': implementation,
                'clockProbePath': str(clock_root / 'clock-probe.trace'),
                'supervisorPid': os.getpid(),
                'readlinks': {p: (os.path.realpath(node) if p == '/proc/self/exe' else
                    os.readlink(p) if Path(p).is_symlink() else None) for p in (
                    '/proc/self/exe', '/etc', '/etc/localtime', '/usr', '/usr/share',
                    '/usr/share/zoneinfo', '/usr/share/zoneinfo/Etc', '/usr/share/zoneinfo/Etc/UTC')},
                'inheritedUmask': int(re.search(r'^Umask:\s+([0-7]+)$',
                    Path('/proc/self/status').read_text(), re.MULTILINE)[1], 8),
                'commandFd': command, 'ackFd': ack, 'lifetimeFd': lifetime,
                'immutable': originals, 'directories': dirs, 'queries': queries, 'absentProbes': probes,
                'queryMetadata': query_metadata,
                'phases': phases, 'usedTokens': list(used_tokens),
                'inputHex': plan['inputHex'], 'offset': 2, 'length': 4,
                'descriptors': {str(n): {'identity': fd_identity(source_fd), 'family': family, 'flags': flags}
                    for n, source_fd, family, flags in [(0, 0, 'stdio', ['O_RDONLY']),
                         (1, out_write, 'stdio', ['O_WRONLY']), (2, err_write, 'stdio', ['O_WRONLY']),
                         (lifetime, lifetime, 'lifetime', ['O_RDWR']),
                         (command, command, 'command', ['O_RDONLY']), (ack, ack, 'ack', ['O_WRONLY'])]}}
    provenance = KernelRuntimeQueries()
    tracer_ready = threading.Event()
    def launched(process):
        provenance.own_tracer(process)
        if diagnostics is not None:
            diagnostics.bind('tracer', provenance.tracer)
            diagnostics.start()
        tracer_ready.set()
    # Original observer/runtime inputs are held outside the child base and are not
    # accepted from any producer report or child-writable plan file.
    retained = root / (lane + '-originals.json')
    retained.write_text(encoded(original))
    retained.chmod(0o600)
    trace = base / 'trace'
    trace.touch(mode=0o600)
    log, errors = [], []
    diagnostics = None
    if diagnostic:
        from controlled_diagnostics import SparseDiagnostics, CONFIG
        diagnostics = SparseDiagnostics(trace, log)
        original['diagnosticConfig'] = CONFIG
    start_clock = sample_clock()
    original['startedWallNs'] = start_clock['wallNs']
    original['clockSamples'] = {'start': start_clock, 'phases': []}
    def control():
        try:
            deadline = start_clock['monotonicBeforeNs'] + RUN_NS
            require(tracer_ready.wait(max(0, deadline - time.monotonic_ns()) / NS), 'owned tracer not observed')
            while True:
                with trace.open() as f:
                    first = f.readline()
                match = re.match(r'(\d+)\s+[1-9][0-9]*\.[0-9]{9}\s+execve\(', first)
                if match:
                    break
                if time.monotonic_ns() > deadline:
                    raise RuntimeError('initial kernel exec not observed')
                time.sleep(.01)
            original['leaderPid'] = int(match[1])
            provenance.bind_leader(original['leaderPid'], node, argv)
            if diagnostics is not None:
                diagnostics.bind('leader', provenance.value['leader'], provenance.procfd, provenance.pidfd)
            # Retain a completed raw line anchor while the independently pinned
            # process is alive. The command may already be waiting unfinished.
            prefix = trace.read_bytes()
            provenance.value['traceAnchorLine'] = prefix.count(b'\n')
            provenance.validate_leader(node, argv)
            provenance.value['verifiedBeforeRelease'] = True
            original['kernelRuntimeQueries'] = provenance.value
            # No child-supplied PID or readiness report establishes ownership.
            retained.write_text(encoded(original))
            for phase in phases:
                assert_observer(implementation)
                if designation is not None:
                    designation.check()
                require(phase['token'] not in used_tokens, 'supervisor retained-original check failed')
                used_tokens.add(phase['token'])
                data = f"orca-phase:{phase['name']}:{phase['token']}\n".encode()
                original['clockSamples']['phases'].append({'event': 'before-command-write', **sample_clock()})
                require(os.write(send, data) == len(data), 'supervisor retained-original check failed')
                original['clockSamples']['phases'].append({'event': 'after-command-write', **sample_clock()})
                log.append({'event': 'sent', **phase})
                expected = f"orca-done:{phase['name']}:{phase['token']}\n".encode()
                with selectors.DefaultSelector() as selector:
                    selector.register(receive, selectors.EVENT_READ)
                    require(selector.select(max(0, deadline - time.monotonic_ns()) / NS), 'ack timeout')
                require(os.read(receive, len(expected)) == expected, 'partial/changed ack')
                original['clockSamples']['phases'].append({'event': 'after-ack-read', **sample_clock()})
                log.append({'event': 'received', **phase})
        except BaseException as error:
            errors.append(repr(error))
        finally:
            os.close(send)
    worker = threading.Thread(target=control, daemon=True)
    worker.start()
    report = {'record': 'controlled-' + lane + '-attempt', 'authority': 'none', 'root': str(root),
              'sourceHead': SOURCE, 'connectedCommandsReleased': False,
              'acceptingToken': None, 'productionEligible': False,
              'imageProducerSha256': build['producerSha256'], 'imageChildSha256': build['childSha256'],
              'imageBuildSha256': digest((image / 'controlled-build.json').read_bytes())}
    replay = None
    run = ObservedRun(report, original, None, root / (lane + '-attempt.json'))
    try:
        try:
            result = run_traced(['prlimit', '--fsize=268435456:268435456', '--core=0:0', tracer,
                        '--kill-on-exit', '--always-show-pid', OPTION, '-f', '-q', '-v', '-x', '-s', '131072', '-o', str(trace), *argv],
                        pass_fds=(lifetime, command, ack), cwd=image,
                        env={'PATH': os.environ['PATH'], 'HOME': str(base), 'TMPDIR': str(base)},
                        stdout=out_write, stderr=err_write, text=True, timeout=60, on_started=launched)
        finally:
            # Stop before any full-packet/kernel replay; sampling never reads
            # those packets or launches another process while run_traced owns one.
            if diagnostics is not None:
                diagnostics.stop()
        worker.join(timeout=1)
        require(not worker.is_alive() and not errors, errors)
        finish_clock = sample_clock()
        original['finishedWallNs'] = finish_clock['wallNs']
        original['clockSamples']['finish'] = finish_clock
        validate_clock(original)
        require(clock_sha(Path(tracer).read_bytes()) == trace_clock['tracerSha256'] and
                Path('/proc/sys/kernel/random/boot_id').read_text().strip() == trace_clock['bootId'] and
                clock_namespaces() == trace_clock['namespaces'], 'changed tracer/kernel clock provenance')
        os.close(out_write)
        os.close(err_write)
        out_write = err_write = None
        producer_out = os.read(out_read, 65537)
        producer_err = os.read(err_read, 65537)
        require(len(producer_out) <= 65536 and len(producer_err) <= 65536, 'bounded producer output exceeded')
        elapsed_ns = finish_clock['monotonicAfterNs'] - start_clock['monotonicBeforeNs']
        report.update(elapsedNanoseconds=elapsed_ns, elapsedSeconds=elapsed_ns / NS, traceBytes=trace.stat().st_size,
                      returncode=result.returncode, producerStderr=producer_err.decode()[-4000:])
        worker.join(timeout=1)
        require(not worker.is_alive() and not errors, errors)
        require(result.returncode == 0 and trace.stat().st_size <= LIMIT, 'supervisor retained-original check failed')
        require(log == [{'event': event, **phase} for phase in phases for event in ('sent', 'received')], 'supervisor retained-original check failed')
        provenance.validate_mounts()
        for p, expected in plan['inventory'].items():
            require(identity(p) == expected['identity'] and stamp(p) == expected['stamp'], 'supervisor retained-original check failed')
            require(digest(Path(p).read_bytes()) == expected['sha256'], 'supervisor retained-original check failed')
        require(fd_identity(lifetime) == plan['lifetime']['identity'] == identity(lock), 'supervisor retained-original check failed')
        require(re.search(r'FLOCK\s+ADVISORY\s+WRITE ', Path(f'/proc/self/fdinfo/{lifetime}').read_text()), 'supervisor retained-original check failed')
        assert_observer(implementation)
        if lane == 'bootstrap':
            replay = Replay(original)
        else:
            from controlled_connected import ConnectedKernelReplay
            replay = ConnectedKernelReplay(original, designation)
        report['kernel'] = replay.run(trace.read_text())
        if lane == 'bootstrap':
            report['semantic'] = authenticate_bootstrap(replay)
        else:
            from controlled_aggregate import compose_connected
            report['semantic'] = compose_connected(replay)
        original['finalPhysicalObservations'] = replay.final_observations
        # Semantic authentication/canonical bootstrap correlation is still required;
        # a kernel-only report cannot authorize any connected command.
        report['qualification'] = 'unavailable-effect-audit-and-source-review-pending'
        run.replay = replay
    except BaseException as error:
        report['refusal'] = type(error).__name__ + ': ' + str(error)
    finally:
        for number in (out_read, err_read, out_write, err_write):
            if number is not None:
                os.close(number)
        os.close(command)
        os.close(ack)
        worker.join(timeout=1)
        if not worker.is_alive():
            os.close(receive)
        os.close(lifetime)
        provenance.close()
        run.closed = not worker.is_alive()
        if diagnostics is not None:
            path = root / (lane + '-diagnostics.json')
            try:
                # The original control worker can still bind diagnostic pins.
                # This is a disposal precondition, never execution authority.
                try:
                    require(worker.ident is not None and worker.is_alive() is False,
                            'diagnostic control-worker ownership uncertain')
                except BaseException:
                    raise RuntimeError('diagnostic control-worker ownership uncertain') from None
                measured = diagnostics.retain_and_close(path)
                report['diagnostic'] = {'config': measured['config'], 'samples': len(measured['samples']),
                                        'errors': measured['errors'], 'sha256': file_digest(path)}
            except BaseException as error:
                run.closed = False
                report['diagnosticRefusal'] = type(error).__name__ + ': ' + str(error)
        report['phaseLog'] = log
        report['connectedCommandsReleased'] = lane == 'connected' and any(row['event'] == 'sent' for row in log)
        if trace.exists():
            report['traceBytes'] = trace.stat().st_size
            report['traceSha256'] = file_digest(trace)
        if replay is not None:
            original['finalPhysicalObservations'] = getattr(replay, 'final_observations', {})
        report['observerImplementation'] = implementation
        retained.write_text(encoded(original))
        run.report_path.write_text(encoded(report))
        run.report_path.chmod(0o600)
    return run


def bootstrap():
    raise RuntimeError('non-live preparation: observer launch disabled')
    # Historical wrapper remains unreachable before build/directory side effects.
    root = Path(tempfile.mkdtemp(prefix='orca-controlled-replay-'))
    image = root / 'image'
    subprocess.run(['node', str(REPO / 'tools/owned-read-proof/build-controlled.mjs'), str(image)],
                   cwd=REPO, capture_output=True, text=True, check=True, timeout=30)
    result = observe(root, image)
    print(encoded(result.report), flush=True)
    return result.report


if __name__ == '__main__':
    result = bootstrap()
    # Exit 2 means partial evidence only; it must never look like a qualified gate.
    sys.exit(1 if 'refusal' in result else 2)
