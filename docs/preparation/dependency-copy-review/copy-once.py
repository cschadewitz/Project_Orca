"""Generic reviewable wrapper; all actual bindings are in caller-pinned JSON data.

Authenticated gate reads are supplied by existing MCP tools through a nonce-bound
owner checkpoint. This wrapper never reads credentials, bootstraps ORCA or mutates
run state. No fallback, cleanup, retry, readiness checks or agent start.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import resource
from pathlib import Path
import secrets
import signal
import shutil
import stat
import subprocess
import sys
import time
import types



def require(value, message):
    if not value:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def no_links(path):
    path = Path(path)
    require(path.is_absolute(), 'relative control path')
    for p in [path, *path.parents]:
        require(not stat.S_ISLNK(os.lstat(p).st_mode), 'symlink control parent')


def read_control(path, expected_sha=None, private=False):
    no_links(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
                'nonregular/shared control file')
        if private:
            require(before.st_uid == os.geteuid() and stat.S_IMODE(before.st_mode) == 0o600,
                    'control file is not private to this owner')
        else:
            require(not before.st_mode & 0o022 and before.st_uid == os.geteuid(),
                    'helper ownership/mode mismatch')
        with os.fdopen(os.dup(fd), 'rb') as f:
            data = f.read()
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
                 before.st_ctime_ns, before.st_mode, before.st_nlink) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
                 after.st_ctime_ns, after.st_mode, after.st_nlink), 'control file changed')
        named = os.lstat(path)
        require((named.st_dev, named.st_ino) == (before.st_dev, before.st_ino),
                'control file replaced')
        if expected_sha:
            require(sha(data) == expected_sha, 'pinned file hash mismatch')
        return data
    finally:
        os.close(fd)


def exclusive_json(path, value):
    no_links(Path(path).parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(json.dumps(value, indent=2) + '\n')
        f.flush()
        os.fsync(f.fileno())


def timestamp(value):
    d = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(d.utcoffset() is not None, 'naive gate timestamp')
    return d.timestamp()


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def validate_gate(evidence, policy, nonce, issued_at):
    require(set(evidence) == {'nonce', 'discovery', 'runs', 'steps', 'approvals'},
            'unexpected gate proof fields')
    require(evidence['nonce'] == nonce, 'wrong checkpoint nonce')
    baseline = policy['baseline']
    join_run_gate(evidence, policy.get('receipt', {}).get('content'))
    now = time.time()
    times = []
    for name in ('discovery', 'runs', 'steps', 'approvals'):
        value = evidence[name]
        require(value['target'] == baseline['discovery']['target'], 'deployment target drift')
        at = timestamp(value['asOf'])
        require(issued_at <= at <= now + 2 and now - at <= policy['gate_max_age_seconds'],
                'stale or pre-checkpoint gate evidence')
        times.append(at)
        if name != 'discovery':
            require(value.get('truncated') is False and value.get('restartRequired') is False
                    and not value.get('nextCursor'), 'incomplete gate evidence')
            require(value['items'] == baseline[name]['items'], 'run/step/pending gate drift')
    require(max(times) - min(times) <= 10, 'gate reads are not a bounded fresh group')
    d = evidence['discovery']
    for key in ('authentication', 'principalId', 'scope', 'protocol', 'orcaVersion'):
        require(d[key] == baseline['discovery'][key], 'authenticated identity/scope drift')
    runs, gates = evidence['runs']['items'], evidence['approvals']['items']
    require(len(runs) == 1 and runs[0]['status'] == 'waiting' and runs[0]['workflowVersion'] == baseline['runs']['items'][0]['workflowVersion'],
            'assigned run is not waiting in v4')
    require(len(gates) == 1 and gates[0]['kind'] == 'decision'
            and gates[0]['nodeId'] == baseline['approvals']['items'][0]['nodeId'], 'gate is not pending')
    require(all(x.get('nodeId') in {s.get('nodeId') for s in baseline['steps']['items']}
                for x in evidence['steps']['items']), 'work step appeared')


def git(policy, path, *args):
    result = subprocess.run([policy['git_executable'], '--no-optional-locks', '--no-pager',
        '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.untrackedCache=false', '-C', path, *args],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=20, check=True)
    return result.stdout.decode('utf-8').rstrip('\n')


def join_run_gate(records, receipt=None):
    runs, gates, steps = (records[k]['items'] for k in ('runs', 'approvals', 'steps'))
    require(len(runs) == 1 and len(gates) == 1, 'ambiguous assigned run/gate')
    run, gate = runs[0], gates[0]
    rid = run.get('runId')
    require(isinstance(rid, str) and rid and run.get('id') == rid, 'malformed run identity')
    require(gate.get('runId') == rid and gate.get('id') == gate.get('requestId')
            and isinstance(gate.get('requestId'), str) and gate['requestId']
            and gate.get('kind') == 'decision' and isinstance(gate.get('nodeId'), str)
            and gate['nodeId'] and isinstance(gate.get('stepRunId'), str)
            and gate['stepRunId'], 'approval/run identity mismatch')
    require(steps and len({s.get('id') for s in steps}) == len(steps)
            and all(s.get('runId') == rid and isinstance(s.get('stepRunId'), str)
                    and s['stepRunId'] for s in steps), 'step/run identity mismatch')
    scheduled = [s for s in steps if s.get('kind') == 'step.scheduled'
                 and s['stepRunId'] == gate['stepRunId']]
    gate_steps = [s for s in steps if s['stepRunId'] == gate['stepRunId']]
    require(len(scheduled) == 1 and scheduled[0].get('nodeId') == gate['nodeId']
            and gate_steps[-1].get('kind') == 'step.waiting'
            and all(s.get('kind') in ('step.scheduled', 'step.started', 'step.waiting')
                    for s in gate_steps), 'approval/gate-step identity mismatch')
    if receipt is not None:
        fields = {'version', 'runId', 'repo', 'commonDir', 'baseCommit', 'branch', 'path'}
        require(isinstance(receipt, dict) and set(receipt) == fields
                and type(receipt['version']) is int and receipt['version'] == 1
                and all(isinstance(receipt[k], str) and receipt[k] for k in fields - {'version'})
                and re.fullmatch(r'[a-f0-9]{40,64}', receipt['baseCommit']),
                'unsupported or malformed original receipt v1')
        require(receipt['runId'] == rid == gate['runId'], 'receipt/run/gate mismatch')


def git_safety(policy, path):
    # Config and index inspection do not run clean/process drivers. Reject even
    # currently inapplicable drivers: untracked attributes may change applicability.
    config = git(policy, path, 'config', '--null', '--list')
    require(not any(re.fullmatch(r'filter\..+\.(clean|process|smudge)',
                    record.split('\n', 1)[0].lower()) for record in config.split('\x00')),
            'configured clean/process/smudge filter is unsupported')
    index = git(policy, path, 'ls-files', '--stage', '-z')
    require(not any(row.startswith('160000 ') for row in index.split('\x00'))
            and not os.path.lexists(Path(path) / '.gitmodules'), 'submodules are unsupported')


def workspace_inventory(policy):
    """Derive the package allowlist from the already pinned HEAD, without filters."""
    link_policy = policy['link_policy']
    require(set(link_policy) == {'workspace_packages', 'workspace_entries'}, 'invalid link policy')
    packages = link_policy['workspace_packages']
    require(isinstance(packages, list) and len(packages) == len(set(packages)),
            'invalid workspace package list')
    source = policy['source']['path']
    recorded = {}
    for package in packages:
        require(isinstance(package, str) and package and not package.startswith('/')
                and all(c not in ('', '.', '..', '.git', '.orca') for c in package.split('/'))
                and not package.startswith('-'), 'unsafe workspace package')
        require(git(policy, source, 'cat-file', '-t', policy['head'] + ':' + package) == 'tree',
                'workspace package is not a pinned tree')
        rows = git(policy, source, 'ls-tree', '-r', '-z', '--long', policy['head'],
                   '--', package).split('\x00')
        for row in filter(None, rows):
            fields, path = row.split('\t', 1)
            mode, kind, blob, size = fields.split()
            require(path.startswith(package + '/') and kind == 'blob'
                    and mode in ('100644', '100755', '120000'), 'unsupported workspace tree entry')
            if mode == '120000':
                # cat-file returns exact bytes; git() strips LF for command output,
                # so reject newline-bearing symlink blobs instead of normalizing them.
                target = git(policy, source, 'cat-file', 'blob', blob)
                require(len(target.encode()) == int(size), 'unsupported workspace link text')
                item = {'path': path, 'kind': 'symlink', 'target': target}
            else:
                item = {'path': path, 'kind': 'file', 'bytes': int(size)}
            recorded[path] = item
            parent = str(Path(path).parent)
            while parent == package or parent.startswith(package + '/'):
                recorded[parent] = {'path': parent, 'kind': 'directory'}
                parent = str(Path(parent).parent)
        require(recorded.get(package + '/package.json', {}).get('kind') == 'file',
                'workspace package lacks pinned manifest')
    return [recorded[p] for p in sorted(recorded)]


def memory_snapshot():
    """Current Linux process limits and every visible cgroup-v2 ancestor.

    No host-only proxy for an execution profile. Missing/ambiguous data refuses.
    Swap is excluded. memory.high is conservatively treated as a budget limit.
    """
    def kb_table(path):
        result = {}
        for line in Path(path).read_text().splitlines():
            key, _, value = line.partition(':')
            if value.strip().endswith(' kB'):
                result[key] = int(value.split()[0]) * 1024
        return result
    status = kb_table('/proc/self/status')
    available = kb_table('/proc/meminfo')['MemAvailable']
    membership = [s.split(':', 2)[2] for s in Path('/proc/self/cgroup').read_text().splitlines()
                  if s.startswith('0::')]
    require(len(membership) == 1, 'unsupported cgroup memory profile')
    cg = membership[0]
    def unescape(value):
        return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), value)
    mounts = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ', 1)
        if right.split()[0] == 'cgroup2':
            fields = left.split()
            base, mount = unescape(fields[3]), unescape(fields[4])
            if cg == base or cg.startswith(base.rstrip('/') + '/'):
                mounts.append((base, mount))
    require(len(mounts) == 1, 'ambiguous/missing cgroup-v2 mount')
    base, mount = mounts[0]
    current_path = Path(mount) / cg[len(base):].lstrip('/')
    cg_budgets = []
    while True:
        # The cgroup-v2 hierarchy root has no memory controller interface files;
        # its budget is host MemAvailable. Only that exact root may omit them.
        if current_path == Path(mount) and all(not (current_path / name).exists()
                for name in ('memory.current', 'memory.max', 'memory.high')):
            break
        current = int((current_path / 'memory.current').read_text())
        for name in ('memory.max', 'memory.high'):
            raw = (current_path / name).read_text().strip()
            if raw != 'max':
                cg_budgets.append(max(0, int(raw) - current))
        if current_path == Path(mount):
            break
        require(Path(mount) in current_path.parents, 'invalid cgroup ancestry')
        current_path = current_path.parent
    limits = []
    for kind in (resource.RLIMIT_AS, resource.RLIMIT_DATA):
        soft, hard = resource.getrlimit(kind)
        for limit in (soft, hard):
            if limit != resource.RLIM_INFINITY:
                # VmSize is conservative for the data limit too.
                limits.append(max(0, limit - status['VmSize']))
    return {'available_bytes': min([available, *cg_budgets, *limits]),
            'host_available_bytes': available, 'rss_bytes': status['VmRSS'],
            'virtual_bytes': status['VmSize'], 'cgroup_headrooms': cg_budgets,
            'rlimit_headrooms': limits, 'at': utc()}


def memory_guard(policy):
    m = policy['memory']
    require(set(m) == {'largest_file_bytes', 'retained_shim_bytes', 'manifest_bytes',
                       'minimum_available_bytes'}
            and all(type(v) is int and v >= 0 for v in m.values()), 'invalid memory budget')
    # Four payload buffers cover chunk join + retained previous payload, including
    # copies during rewriting. Extra manifest factor covers JSON objects/dicts,
    # interpreter/bookkeeping overhead; reserve is never spent on swap.
    required = max(m['minimum_available_bytes'], 4 * m['largest_file_bytes']
        + 4 * m['retained_shim_bytes'] + 8 * m['manifest_bytes'] + 192 * 1024 * 1024)
    snapshot = memory_snapshot()
    require(snapshot['available_bytes'] >= required, 'execution-profile memory headroom missing')
    return {**snapshot, 'required_additional_bytes': required}


def check_bindings(policy):
    require(os.geteuid() == policy['owner_uid'], 'wrong owner uid')
    join_run_gate(policy['baseline'], policy['receipt']['content'])
    for label in ('source', 'destination'):
        identity = policy[label]
        path = identity['path']
        no_links(path)
        st = os.lstat(path)
        require(stat.S_ISDIR(st.st_mode) and (st.st_dev, st.st_ino, st.st_uid) ==
                (identity['dev'], identity['ino'], identity['uid']), 'root identity drift')
        require(git(policy, path, 'rev-parse', '--show-toplevel') == path, 'root registration drift')
        require(git(policy, path, 'rev-parse', 'HEAD') == policy['head'], 'HEAD drift')
        require(git(policy, path, 'symbolic-ref', 'HEAD') == policy[label + '_branch'], 'branch drift')
        require(git(policy, path, 'rev-parse', '--absolute-git-dir') == policy[label + '_git_dir'],
                'Git directory drift')
        require(git(policy, path, 'rev-parse', 'HEAD:pnpm-lock.yaml') == policy['lock_blob'], 'lock drift')
        git_safety(policy, path)
        require(not git(policy, path, '-c', 'status.submoduleSummary=false', 'status',
                        '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=all'),
                'tracked/index state changed')
    for label in ('receipt', 'ready'):
        r = policy[label]
        data = read_control(r['path'], r['sha256'], private=True)
        require(json.loads(data) == r['content'], 'original provisioning record drift')
    require(sorted(policy['link_policy']['workspace_entries'], key=lambda e: e['path']) ==
            workspace_inventory(policy), 'workspace allowlist is not the pinned Git package data')
    r = policy['receipt']['content']
    require(r['path'] == policy['destination']['path'] and r['baseCommit'] == policy['head']
            and 'refs/heads/' + r['branch'] == policy['destination_branch']
            and r['commonDir'] == policy['common_dir'], 'receipt binding mismatch')
    require(policy['ready']['content'] == {'gitDir': policy['destination_git_dir']},
            'ready record mismatch')
    no_links(policy['common_dir'])
    no_links(policy['destination_git_dir'])
    dest = policy['destination']['path']
    require(git(policy, dest, 'rev-parse', '--path-format=absolute', '--git-common-dir') ==
            policy['common_dir'], 'common Git directory drift')
    require(stat.S_ISREG(os.lstat(Path(dest) / '.git').st_mode), 'not a registered Git worktree')
    rows = git(policy, r['repo'], 'worktree', 'list', '--porcelain', '-z').split('\x00\x00')
    selected = [row.split('\x00') for row in rows if 'worktree ' + dest in row.split('\x00')]
    require(len(selected) == 1 and 'HEAD ' + policy['head'] in selected[0]
            and 'branch ' + policy['destination_branch'] in selected[0], 'Git registration mismatch')


def load_helpers(policy):
    pinned = {p: read_control(p, h, private=(p == policy['contract']))
              for p, h in policy['files'].items()}
    inventory, proposal, contract = (json.loads(pinned[policy[k]])
                                     for k in ('inventory', 'proposal', 'contract'))
    require(contract['entries'] == inventory['entries'] and contract['shims'] == proposal['mappings'],
            'private contract differs from original inventory/proposal')
    require(contract['trees'] == [x['source_relative'] for x in inventory['summary']['copy_map']]
            and all(x['source_relative'] == x['future_destination_relative']
                    for x in inventory['summary']['copy_map']), 'output tree map drift')
    require(len(contract['trees']) == policy['counts']['trees']
            and len(contract['entries']) == policy['counts']['entries']
            and contract['shim_count'] == policy['counts']['shims']
            and contract['prefix_count'] == policy['counts']['prefixes'],
            'copy count drift')
    meta = {e['path']: e['sha256'] for e in inventory['entries']
            if e['path'] in ('node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json')}
    require(contract['metadata'] == meta and sorted(meta.values()) == sorted(proposal['metadata_sha256']),
            'historical metadata drift')
    for name in ('relocation', 'copier'):
        module = types.ModuleType(name)
        module.__file__ = policy[name]
        sys.modules[name] = module
        exec(compile(pinned[policy[name]], policy[name], 'exec'), module.__dict__)
    require(max([e.get('bytes', 0) for e in contract['entries']] +
                [e.get('bytes', 0) for e in policy['link_policy']['workspace_entries']])
            <= policy['memory']['largest_file_bytes'], 'payload exceeds memory pin')
    require(sum(e['bytes'] for e in contract['entries'] if e['path'] in
                {s['path'] for s in contract['shims']}) +
            contract['prefix_count'] * max(0, len(policy['destination']['path'].encode()) -
                len(policy['source']['path'].encode())) <= policy['memory']['retained_shim_bytes'],
            'shim buffers exceed memory pin')
    return sys.modules['copier'], {**contract, 'link_policy': policy['link_policy']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binding-file', required=True)
    parser.add_argument('--binding-sha256', required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--execute-once', action='store_true')
    mode.add_argument('--validate-only', action='store_true')
    parser.add_argument('--owner-holds-roots-and-gate', action='store_true')
    args = parser.parse_args(argv)
    execute = args.execute_once
    require(not execute or args.owner_holds_roots_and_gate,
            'explicit owner-hold acknowledgement required')
    require(re.fullmatch(r'[0-9a-f]{64}', args.binding_sha256), 'invalid binding hash')
    policy_sha256 = args.binding_sha256
    policy = json.loads(read_control(args.binding_file, policy_sha256, private=True))
    stage = Path(policy['stage'])
    require('NODE_PATH' not in os.environ and os.environ.get('NODE_DISABLE_COMPILE_CACHE') == '1',
            'clean invocation environment required')
    def terminate(signum, frame):
        raise TimeoutError('bounded invocation interrupted; preserve partial outputs')
    signal.signal(signal.SIGTERM, terminate)
    os.umask(0o077)
    no_links(stage)
    require(os.lstat(stage).st_uid == os.geteuid() and stat.S_IMODE(os.lstat(stage).st_mode) == 0o700,
            'stage is not private/task-owned')
    if execute:
        exclusive_json(stage / 'attempt-once.json', {'at': utc(), 'copy_completed': False})
    journal = stage / ('execution-journal.jsonl' if execute else 'review-journal-' + str(time.time_ns()) + '.jsonl')
    fd = os.open(journal, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as log:
        def record(kind, **data):
            log.write(json.dumps({'at': utc(), 'kind': kind, **data}) + '\n')
            log.flush()
            os.fsync(log.fileno())
        try:
            record('begin', execute=execute, policy_sha256=policy_sha256)
            check_bindings(policy)
            record('memory-preflight', **memory_guard(policy))
            require(sum(os.lstat(p).st_size for p in policy['files']) <=
                    policy['memory']['manifest_bytes'], 'control bytes exceed memory pin')
            copier, contract = load_helpers(policy)
            source, destination = (policy[k]['path'] for k in ('source', 'destination'))
            trees, expected, rewritten = copier.plan(source, destination, contract)
            require(len(trees) == policy['counts']['trees']
                    and len(expected) == policy['counts']['entries']
                    and len(rewritten) == policy['counts']['shims'], 'plan count mismatch')
            require(shutil.disk_usage(destination).free >= policy['minimum_free_bytes'], 'disk headroom missing')
            record('copy-preconditions-pass', trees=len(trees), entries=len(expected), shims=len(rewritten))
            if not execute:
                # Preparation mode never creates a request/attempt/probe or calls copy_exclusive.
                proof = json.loads(read_control(stage / 'review-gate-evidence.json', private=True))
                validate_gate(proof, policy, 'review-only', 0)
                record('review-validation-pass', copy_called=False)
                return
            nonce, issued = secrets.token_hex(32), time.time()
            request = {'nonce': nonce, 'issuedAt': utc(), 'issued_epoch': issued,
                       'target': policy['baseline']['discovery']['target'],
                       'runId': policy['baseline']['runs']['items'][0]['runId'],
                       'responsePath': str(stage / 'gate-response.json'),
                       'required': ['discover_orca', 'list_runs', 'list_steps', 'list_approvals'],
                       'maxAgeSeconds': policy['gate_max_age_seconds']}
            exclusive_json(stage / 'gate-request.json', request)
            record('waiting-for-supported-authenticated-checkpoint', nonce=nonce)
            deadline = time.monotonic() + policy['checkpoint_timeout_seconds']
            response = stage / 'gate-response.json'
            while not os.path.lexists(response):
                require(time.monotonic() < deadline, 'authenticated checkpoint unavailable; no copy')
                time.sleep(0.2)
            proof = json.loads(read_control(response, private=True))
            validate_gate(proof, policy, nonce, issued)
            check_bindings(policy)
            record('memory-before-copy', **memory_guard(policy))
            # O_EXCL/no-follow access probe: no chmod/access escalation or worker sandbox edits.
            probe = Path(destination) / '.dependency-copy-owner-write-probe'
            probe_fd = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            probe_identity = os.fstat(probe_fd)
            os.close(probe_fd)
            current = os.lstat(probe)
            require((current.st_dev, current.st_ino) == (probe_identity.st_dev, probe_identity.st_ino),
                    'probe replaced; preserve evidence')
            os.unlink(probe)
            validate_gate(proof, policy, nonce, issued)
            record('before-copy', profile='supported owner invocation; not future worker')
            result = copier.copy_exclusive(source, destination, contract)  # single call; no retry
            check_bindings(policy)
            record('copy-completed', result=result, gate_answered=False, agent_started=False,
                   readiness_checks_run=False, independent_postcopy_verification_pending=True)
            exclusive_json(stage / 'copy-result.json', {'completedAt': utc(), 'result': result,
                'gateAnswered': False, 'agentStarted': False, 'rootReadinessEstablished': False,
                'independentVerificationPending': True})
        except BaseException as error:
            record('stopped', error_type=type(error).__name__, error=str(error),
                   no_retry=True, partial_outputs_retained=True)
            raise


if __name__ == '__main__':
    main()
