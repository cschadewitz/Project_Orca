"""Finite connected kernel/journal preparation. No connected launcher or gate.

Designation is explicit trusted-supervisor source authority, held in memory. It
cannot be reconstructed from report JSON, a digest, child success, or this class's
output. Kernel grammar is necessary evidence only: authenticated Save/current
authority, original callback and settled final ownership ack remain separate.
"""
from pathlib import Path
import os
import re
import stat

from controlled_contract import PHASES, TOKEN, require
from controlled_replay import Handle, Object, Replay, UUID, fd, identity, sha, string
from controlled_semantics import parse, same_json
from controlled_timestamps import iso_ns

SOURCE = 'fa25390e8a88e23a33640f40404b6da58938bdb4'
PROFILE = 'orca-owned-file-read-v1'
IMAGE_NAMES = {'controlled-build.json', 'controlled-child.mjs', 'controlled-producer.mjs'}
HUMAN = {'instanceId': 'controlled-test-boot', 'sessionId': 'controlled-session',
         'turnId': 'controlled-human-turn', 'invocationId': 'controlled-human-invocation'}
JOURNAL_TYPES = ('human.requested', 'step.waiting', 'agent.permission', 'human.answered')


def snapshot(path):
    """Retain full physical stamp and bytes; later digest equality alone is insufficient."""
    p = Path(path)
    info = p.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'designation needs an unaliased regular file')
    require(info.st_size <= 16 * 1024 * 1024, 'designation file exceeds bound')
    stamp = (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
             info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    data = p.read_bytes()
    require(len(data) == info.st_size, 'designation file changed during retention')
    after = p.lstat()
    require(stamp == (after.st_dev, after.st_ino, after.st_mode, after.st_uid, after.st_gid,
                     after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
            'designation file changed during retention')
    return stamp, data


class ConnectedDesignation:
    """An explicit designation by the trusted parent, never an acceptance constructor.

    assert_bootstrap_closed is the original supervisor's callable assertion of
    permanent bootstrap/service closure and its exact reviewed bootstrap decision.
    Its correctness is a source trust assumption, not independently measured here.
    There is deliberately no deserialize/from-report/CLI constructor or launcher.
    """
    def __init__(self, *, bootstrap_base, evidence_path, evidence_ref, image, assert_bootstrap_closed):
        require(callable(assert_bootstrap_closed), 'missing original bootstrap closure assertion')
        require(type(evidence_ref) is str and 0 < len(evidence_ref) <= 512, 'missing bootstrap evidence reference')
        self._closed = assert_bootstrap_closed
        require(self._closed() is None, 'bootstrap closure assertion must raise on failure, never return a success flag')
        self.bootstrap_base = str(Path(bootstrap_base).resolve(strict=True))
        self.bootstrap_lifetime = identity(Path(self.bootstrap_base) / 'lifetime.lock')
        self.image = str(Path(image).resolve(strict=True))
        self.image_identity = identity(self.image)
        self.evidence_path = str(Path(evidence_path).absolute())
        self.evidence_ref = evidence_ref
        require({p.name for p in Path(self.image).iterdir()} == IMAGE_NAMES, 'designation requires exact three-file image')
        self.files = {str(p): snapshot(p) for p in sorted(Path(self.image).iterdir())}
        self.proof = snapshot(self.evidence_path)
        require(not set(v[0][:2] for v in self.files.values()) & {self.proof[0][:2]}, 'evidence aliases image')
        build = parse(self.files[str(Path(self.image) / 'controlled-build.json')][1])
        require(build['entry'] == 'controlled-child.mjs' and build['profileRef'] == PROFILE and
                build['producerSha256'] == sha(self.files[str(Path(self.image) / 'controlled-producer.mjs')][1]) and
                build['childSha256'] == sha(self.files[str(Path(self.image) / 'controlled-child.mjs')][1]),
                'designation image correspondence differs')
        # This checks all repository inputs against SOURCE, not just build metadata
        # or a producer-provided sourceHead. Dependency bytes remain build inputs.
        from controlled_supervisor import assert_image_sources
        self.build = assert_image_sources(Path(self.image))
        self.check()

    def check(self):
        require(self._closed() is None, 'bootstrap closure assertion returned a flag')
        require(identity(self.image) == self.image_identity, 'changed designated image directory')
        require({p.name for p in Path(self.image).iterdir()} == IMAGE_NAMES, 'changed designated inventory')
        for path, retained in self.files.items():
            require(snapshot(path) == retained, 'changed designated image')
        require(snapshot(self.evidence_path) == self.proof, 'changed designated bootstrap evidence')

    def bind(self, original):
        self.check()
        base = Path(original['base'])
        bootstrap = Path(self.bootstrap_base)
        require(base.is_absolute() and str(base) != self.bootstrap_base and
                bootstrap not in base.parents and base not in bootstrap.parents,
                'connected base reuses bootstrap lifetime/root')
        lifetimes = [v['identity'] for v in original['immutable'].values() if v['family'] == 'lifetime']
        require(len(lifetimes) == 1 and lifetimes[0][:2] != self.bootstrap_lifetime[:2],
                'connected lifetime aliases original bootstrap')
        require(original['lane'] == 'connected' and original['sourceHead'] == SOURCE and
                same_json(original['controlledBuild'], self.build), 'wrong connected source/profile designation')
        expected = set(self.files)
        require({p for p, v in original['immutable'].items() if v['family'] == 'image'} == expected,
                'connected inventory differs from original image')
        for path, (stamp, data) in {**self.files, self.evidence_path: self.proof}.items():
            entry = original['immutable'].get(path)
            require(entry is not None and entry['identity'] == list(stamp[:5]) and
                    entry['hex'] == data.hex() and entry['sha256'] == sha(data),
                    'connected originals differ from designated physical bytes')
        plan = parse(bytes.fromhex(original['immutable'][str(base / 'controlled-plan.json')]['hex']))
        require(plan['bootstrap'] == self.association(plan['inventory']), 'wrong bootstrap evidence association')

    def association(self, inventory):
        require(set(inventory) == set(self.files), 'wrong original inventory association')
        for path, (stamp, data) in self.files.items():
            require(inventory[path] == {'identity': list(stamp[:5]), 'sha256': sha(data),
                    'stamp': list(map(str, stamp))}, 'wrong original inventory physical association')
        # Preserve source JSON construction order: inventory was retained by prepare.
        import json
        return {'evidenceRef': self.evidence_ref, 'proofPath': self.evidence_path,
                'proofSha256': sha(self.proof[1]),
                'installedInventoryDigest': sha(json.dumps(inventory, separators=(',', ':'), ensure_ascii=False).encode())}


class ConnectedKernelReplay(Replay):
    """Offline extension only. Full base replay still sees every event/interval.

    It adds the exact journal family and finite sidecar publication lineage.
    No root exemption, passive-wait rule,
    notification proof, namespace/physical/clock/byte bound is replaced. This
    does not authenticate Save or make the final-ack diagnostic delivery authority.
    """
    def __init__(self, original, designation):
        require(type(designation) is ConnectedDesignation, 'missing explicit connected designation')
        designation.bind(original)
        self.designation = designation
        self.journal_records, self.journal_closes, self.journal_tokens = [], [], set()
        self.journal_entries = []
        super().__init__(original)

    @property
    def journal_path(self):
        return self.base + '/workspace/.orca/runs/controlled.jsonl'

    def validate_lane(self):
        o = self.original
        require(o['lane'] == 'connected' and type(o['phases']) is list and
                len(o['phases']) == 3, 'wrong connected phase plan')
        require([p['name'] for p in o['phases']] == PHASES['connected'], 'reordered connected phase plan')
        tokens = []
        for p in o['phases']:
            require(set(p) == {'name', 'token'} and type(p['token']) is str and TOKEN.fullmatch(p['token']),
                    'bad connected phase token')
            tokens.append(p['token'])
        require(len(set(tokens)) == 3 and not set(tokens) & set(o['usedTokens']), 'replayed connected token')
        require(self.journal_path not in self.paths, 'connected journal is not initially absent')

    def required_marks(self):
        return 6

    def control_phase(self):
        require(len(self.marks) < 6, 'extra connected command/ack')
        return self.original['phases'][len(self.marks) // 2], bool(len(self.marks) % 2)

    def active_phase(self):
        require(len(self.marks) in {1, 3, 5}, 'connected operation outside phase')
        return self.original['phases'][len(self.marks) // 2]['name']

    def read_phase(self, record):
        phase = self.active_phase()
        require(phase in {'human-read', 'rule-read'}, 'Save cannot read service resource')
        require(len(self.journal_records) == 4, 'service read before original answer journal')
        require(self.journal_closes and self.journal_closes[-1] < record[4], 'answer append not closed before read')
        previous = getattr(self.resources[0], 'read_phases', [])
        require(previous == ([] if phase == 'human-read' else ['human-read']), 'duplicate/reordered connected read')
        self.resources[0].read_phases = previous + [phase]

    def validate_reads(self, obj):
        require(len(getattr(obj, 'reads', [])) == 2 and obj.read_phases == ['human-read', 'rule-read'],
                'connected requires one human and one fresh rule read')
        require(len(self.journal_records) == 4 and len(self.journal_closes) == 4,
                'incomplete connected journal append history')
        require(self.journal_path in self.paths and self.paths[self.journal_path].physical is not None,
                'journal lacks independent physical observation')

    def evidence_record(self):
        return 'controlled-connected-kernel-grammar-only'

    def run(self, text):
        self.designation.check()
        result = super().run(text)
        self.designation.check()
        result['qualification'] = 'unavailable-connected-semantics-and-effect-audit-pending'
        result['journalAppends'] = len(self.journal_records)
        result['serviceReadsByPhase'] = {'save': 0, 'human-read': 1, 'rule-read': 1}
        return result

    def family(self, path):
        # Exact journal and its own lock only. No generic runs/* exemption.
        if path == self.journal_path:
            return 'connected-journal'
        if path == self.journal_path + '.lock':
            return 'lock-directory'
        if re.fullmatch(re.escape(self.journal_path) + r'\.lock/owner\.' + str(self.leader) + r'\.' + UUID + r'\.json', path):
            return 'lock-token'
        return super().family(path)

    def fresh_writer(self, path, family, entered):
        if family != 'sidecar-temp':
            return super().fresh_writer(path, family, entered)
        require(path == self.base + '/workspace/orca.permissions.json.' + str(self.leader) + '.tmp' and
                self.active_phase() == 'save' and path not in self.paths, 'sidecar temporary outside exact Save lineage')
        final = self.base + '/workspace/orca.permissions.json'
        previous = [o for o in self.objects if o.publication_path == final]
        if not previous:
            return super().fresh_writer(path, family, entered)
        require(len(previous) == 1, 'more than initial and saved sidecar publications')
        obj = previous[0]
        require(obj.physical is not None and obj.names == {final} and self.paths.get(final) is obj and
                obj.publication_temporary_path == path and obj.publication_method == 'rename' and
                type(obj.writer_close_completion) is int and type(obj.publication_entry) is int and
                type(obj.publication_completion) is int and
                obj.writer_close_completion < obj.publication_entry <= obj.publication_completion < entered,
                'sidecar temporary reuse before original physical publication settles')
        # Source uses the same PID temporary basename for initial enrollment and
        # Save. O_EXCL and base alias checks still create a separate physical inode.
        return True

    def lock_owner(self, before_entry):
        root = self.journal_path + '.lock'
        require(root in self.paths, 'journal append without original lock directory')
        members = [(p, obj) for p, obj in self.paths.items() if str(Path(p).parent) == root]
        require(len(members) == 1, 'journal lock lacks unique original token')
        path, token = members[0]
        require(self.family(path) == token.family == 'lock-token' and token.writer_closed and
                token.names == {path} and token.writes == 1,
                'journal lock token lacks exclusive settled lineage')
        # Base replay visits the close at its entry position and immediately sets
        # writer_closed, even for a paired unfinished/resumed syscall. Only its
        # retained raw completion index can establish publication before another
        # thread's journal operation. These are causal indices, not wall times.
        require(type(token.writer_close_entry) is int and type(token.writer_close_completion) is int and
                0 <= token.writer_close_entry <= token.writer_close_completion < before_entry,
                'token close completion must precede journal operation')
        value = parse(token.data)
        require(type(value) is dict and set(value) == {'pid', 'at', 'host'} and
                type(value['pid']) is int and value['pid'] == self.leader and
                type(value['at']) is int and self.original['startedWallNs'] // 1000000 <= value['at'] <=
                self.original['finishedWallNs'] // 1000000 and value['host'] == os.uname().nodename,
                'journal lock token owner/clock/host differs')
        return token

    def journal_record(self, data):
        require(data.endswith(b'\n') and data.count(b'\n') == 1 and len(data) <= 65536,
                'partial/multiple/oversize journal record')
        value = parse(data)
        require(type(value) is dict and set(value) == {'type', 'runId', 'payload', 'executionPayloadRef', 'id', 'seq', 'at'},
                'unknown journal record fields')
        seq = len(self.journal_records)
        require(type(value['seq']) is int and value['seq'] == seq and seq < 4 and
                value['type'] == JOURNAL_TYPES[seq] and value['runId'] == 'controlled', 'journal sequence/type/run differs')
        require(type(value['id']) is str and re.fullmatch(r'evt_[0-9A-HJKMNP-TV-Z]{26}', value['id']) and
                value['id'] not in {v['id'] for v in self.journal_records}, 'journal event identity differs')
        require(type(value['executionPayloadRef']) is str and re.fullmatch(UUID, value['executionPayloadRef']) and
                value['executionPayloadRef'] not in {v['executionPayloadRef'] for v in self.journal_records},
                'journal payload reference reused/invalid')
        require(type(value['at']) is str, 'journal timestamp is not a string')
        ns = iso_ns(value['at'])
        require(self.original['startedWallNs'] <= ns <= self.original['finishedWallNs'], 'journal timestamp outside run')
        payload = value['payload']
        require(type(payload) is dict, 'journal payload not an object')
        fields = ({'stepRunId', 'requestId', 'kind', 'question', 'options', 'context', 'liveDecision'},
                  {'stepRunId', 'on', 'detail'},
                  {'stepRunId', 'sessionId', 'title', 'decision', 'scopedApprovalRef'},
                  {'stepRunId', 'requestId', 'answer', 'actor'})[seq]
        require(set(payload) == fields and payload['stepRunId'] == 'controlled-step', 'journal payload shape/step differs')
        if seq == 0:
            require(type(payload['requestId']) is str and re.fullmatch(r'hi_[0-9A-HJKMNP-TV-Z]{26}', payload['requestId']) and
                    payload['kind'] == 'permission' and payload['question'] == 'Allow this bounded disposable test read?' and
                    payload['options'] == [{'id': 'once', 'label': 'once'}, {'id': 'deny', 'label': 'deny'}] and
                    payload['context'] == {} and payload['liveDecision'] == HUMAN, 'wrong original live ask projection')
        elif seq == 1:
            require(payload['on'] == 'human-input' and payload['detail'] == self.journal_records[0]['payload']['requestId'],
                    'waiting event not original ask')
        elif seq == 2:
            require(payload['sessionId'] == HUMAN['sessionId'] and payload['title'] == 'create a scoped rule' and
                    payload['decision'] == 'scoped-rule-save-accepted' and type(payload['scopedApprovalRef']) is str and
                    re.fullmatch(UUID, payload['scopedApprovalRef']), 'wrong Save marker projection')
        else:
            require(payload['requestId'] == self.journal_records[0]['payload']['requestId'] and payload['answer'] == 'once' and
                    type(payload['actor']) is dict and set(payload['actor']) == {'principalId', 'credentialId'} and
                    payload['actor']['principalId'] == 'controlled-test-operator' and
                    type(payload['actor']['credentialId']) is str and re.fullmatch(r'[A-Za-z0-9_-]{12}', payload['actor']['credentialId']),
                    'answer not original once/operator projection')
        return value

    def event(self, record):
        pid, call, args, result, entered, completed = record
        handle = self.handles.get(fd(args[0])) if args and re.fullmatch(r'\d+', args[0]) else None
        if call == 'write' and args and args[0] == str(self.ack):
            phase = self.active_phase()
            require(self.journal_path + '.lock' not in self.paths and not any(
                h.obj.family == 'connected-journal' for h in self.handles.values()),
                'journal lock/open survives phase acknowledgement')
            reads = len(getattr(self.resources[0], 'reads', [])) if self.resources else 0
            expected = {'save': (3, 0), 'human-read': (4, 1), 'rule-read': (4, 2)}[phase]
            require((len(self.journal_records), reads) == expected, 'phase acknowledgement before required journal/read count')
        if call == 'openat' and len(args) >= 3 and string(args[1]).decode() == self.journal_path and 'O_APPEND' in args[2]:
            require(pid in self.threads and pid not in self.settled and self.execs == 1, 'journal from unknown/settled process')
            phase = self.active_phase()
            require(phase == ('save' if len(self.journal_records) < 3 else 'human-read'), 'journal append in wrong phase')
            token = self.lock_owner(entered)
            require(token not in self.journal_tokens, 'journal append reused a prior lock acquisition')
            require(args == ['AT_FDCWD', args[1], 'O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC', '0666'] and
                    result.isdigit() and fd(result) not in self.handles, 'journal append open flags/result differ')
            require(not self.resources or not self.resources[0].names, 'journal open during named-resource lifetime')
            if entered != completed:
                self.open_intervals.append((entered, completed))
            require(not any(h.obj.family == 'connected-journal' for h in self.handles.values()), 'journal append overlaps another open')
            obj = self.paths.get(self.journal_path)
            if obj is None:
                require(self.journal_path not in self.used_paths and self.journal_path.rsplit('/', 1)[0] in self.paths,
                        'journal creation lacks fresh parent lineage')
                obj = Object('connected-journal', stat.S_IFREG | (0o666 & ~self.umask), {self.journal_path})
                obj.creation_entry, obj.creation_completion = entered, completed
                self.paths[self.journal_path] = obj
                self.objects.append(obj)
                self.used_paths.add(self.journal_path)
            obj.writer_closed = False
            h = Handle(obj, {'O_WRONLY', 'O_CREAT', 'O_APPEND', 'O_CLOEXEC'})
            h.journal_token, h.journal_writes, h.journal_phase = token, 0, phase
            self.handles[fd(result)] = h
            self.journal_tokens.add(token)
            self.counts[call] += 1
            return
        if (handle is not None and handle.obj.family == 'connected-journal' and
                'O_WRONLY' in handle.flags and call in {'write', 'close'}):
            require(getattr(handle, 'journal_token', None) is self.lock_owner(entered), 'journal token changed during append')
            require(self.active_phase() == handle.journal_phase, 'journal writer crosses phase')
            if call == 'write':
                require(handle.journal_writes == 0 and self.active_phase() ==
                        ('save' if len(self.journal_records) < 3 else 'human-read'), 'duplicate/cross-phase journal write')
                value = self.journal_record(string(args[1]))
                super().event(record)
                self.journal_records.append(value)
                self.journal_entries.append(entered)
                handle.journal_writes += 1
                return
            require(handle.journal_writes == 1, 'journal append closed without complete record')
            super().event(record)
            self.journal_closes.append(completed)
            return
        # The base parser handles all reads/stats/syncs, path/descriptor aliases,
        # lock namespace effects and immutable publications. Unknown effects refuse.
        super().event(record)
