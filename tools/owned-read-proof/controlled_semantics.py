"""Authenticate actual replayed bootstrap records; no report/JSON capability intake."""
import base64
import hashlib
import json
import math
import os
import re
from pathlib import Path
from urllib.parse import unquote

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from controlled_contract import require
from controlled_timestamps import iso_ns, resource_entry, expiry_bound


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate authenticated JSON key')
        result[key] = value
    return result


def invalid_constant(value):
    raise RuntimeError('non-finite JSON constant: ' + value)


def finite_float(value):
    result = float(value)
    require(math.isfinite(result), 'non-finite JSON number')
    return result


def parse(data):
    return json.loads(data, object_pairs_hook=unique_object, parse_constant=invalid_constant, parse_float=finite_float)


def decode(name, data, key):
    envelope = parse(data)
    closed_fields(envelope, 'version algorithm nonce ciphertext tag', 'encrypted envelope')
    require(type(envelope['version']) is int and envelope['version'] == 1 and envelope['algorithm'] == 'aes-256-gcm', 'unknown encrypted envelope')
    nonce, tag, ciphertext = [base64.b64decode(envelope[k], validate=True) for k in ('nonce', 'tag', 'ciphertext')]
    require(len(key) == 32 and len(nonce) == 12 and len(tag) == 16, 'wrong key/nonce/tag bounds')
    return parse(AESGCM(key).decrypt(nonce, ciphertext + tag,
                 f'orca:protected-execution:v1:private-execution:{name}'.encode()))


def designated_credentials(credentials):
    require(type(credentials) is list and len(credentials) == 2, 'expected exactly two credential records')
    require(all(type(v) is dict and type(v.get('principal')) is str and type(v.get('id')) is str
                for v in credentials), 'malformed designated credential identity')
    require(len({v['principal'] for v in credentials}) == 2 and len({v['id'] for v in credentials}) == 2,
            'duplicate credential principal or ID')
    actors = {v['principal']: v for v in credentials}
    require(set(actors) == {'controlled-test-operator', 'controlled-test-reviewer'} and
            all('revokedAt' not in v for v in credentials), 'wrong designated test credentials')
    return actors


# These encodings mirror the reviewed owners' JSON.stringify construction order.
# Inputs here are bounded strings/integers/arrays/objects, never arbitrary JS values.
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
ACTION_FIELDS = ('version actionId bindingRef capturedByBoundaryId invocation authority coverage operation '
                 'profileRef original dispatch transformations rawDuplicateKeyValidation effectiveCwd workspaceRef '
                 'resources executableAndInterpreter stdin environmentAndCredentialRefs relevantStateRefs '
                 'offeredChoices expiresAt')


def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def closed_fields(value, fields, label):
    require(type(value) is dict and set(value) == set(fields.split()), 'noncanonical ' + label + ' fields')


def same_json(value, expected):
    """Exact finite JSON equality, including scalar types (True is not version 1)."""
    if type(value) is not type(expected):
        return False
    if type(expected) is dict:
        return value.keys() == expected.keys() and all(same_json(value[k], v) for k, v in expected.items())
    if type(expected) is list:
        return len(value) == len(expected) and all(same_json(a, b) for a, b in zip(value, expected))
    return value == expected


def node_platform(original):
    # Existing supervisor-retained native runtime bytes, never a child platform flag.
    runtime = original['immutable'][original['node']]
    header = bytes.fromhex(runtime['hex'][:40])
    require(runtime['family'] == 'runtime' and len(header) == 20 and header[:7] == b'\x7fELF\x02\x01\x01',
            'missing supported retained native Node ELF header')
    machine = int.from_bytes(header[18:20], 'little')
    expected = {'x86_64': (62, 'linux-x64'), 'aarch64': (183, 'linux-arm64')}.get(os.uname().machine)
    require(expected is not None and machine == expected[0], 'unsupported/mismatched retained Node platform')
    return expected[1]


def bootstrap_action_schema(action, original, resource_ref):
    """The exact pinned bootstrap fence/service output, not a generic action policy."""
    closed_fields(action, ACTION_FIELDS, 'bootstrap action')
    require(type(action['version']) is int and action['version'] == 1 and
            type(action['actionId']) is str and re.fullmatch(UUID, action['actionId']) is not None,
            'noncanonical bootstrap action version/UUID')
    representation = {'kind': 'parsed-json', 'codecVersion': 'orca-owned-file-read-v1',
                      'privateRef': 'synthetic-read:' + action['actionId'] + ':parameters',
                      'bindingRef': 'synthetic-read:' + action['actionId'] + ':parameters'}
    require(same_json(action['original'], representation) and same_json(action['dispatch'], representation) and
            action['transformations'] == [] and action['offeredChoices'] == [],
            'noncanonical bootstrap representation/transformations/choices')
    require(same_json(action['rawDuplicateKeyValidation'], {'state': 'absent',
                'reason': 'Exact structured own data fields; no raw JSON parser'}) and
            same_json(action['executableAndInterpreter'], {'state': 'absent',
                'reason': 'Injected read has no child executable'}) and
            same_json(action['stdin'], {'state': 'absent', 'reason': 'Injected read has no stdin'}),
            'noncanonical bootstrap parser/executable/stdin facts')
    coverage = {'version': 1, 'coverageId': resource_ref + ':source-v1', 'boundaryId': 'orca-owned-file-read-v1',
                'provider': 'orca-owned-disposable-file-service', 'providerVersion': '1', 'adapterVersion': '1',
                'tool': 'fs.readOwnedBytes', 'toolSchemaVersion': '1', 'hostId': 'controlled-local-linux',
                'platform': node_platform(original), 'level': 'policy-per-ask',
                'evidence': {'sourceRefs': ['packages/engine/src/owned-file-read-service.ts',
                                          'packages/engine/src/synthetic-read-fence.ts'],
                             'installedRefs': [], 'independentlyObservedEffects': False},
                'negotiatedHook': {'state': 'complete', 'value': resource_ref + ':retained-descriptor'},
                'protectedConfiguration': {'state': 'complete', 'value': resource_ref + ':controlled-test-scope'},
                'guaranteedEffects': ['bounded-positional-read-of-retained-detached-inode',
                                      'one-effect-per-original-invocation'],
                'unsupportedPaths': ['arbitrary-path', 'external-writers', 'hostile-same-uid', 'root',
                                     'remote-host', 'macos', 'windows', 'native-shell', 'alternate-mcp',
                                     'production', 'restart-recovery']}
    require(same_json(action['coverage'], coverage), 'noncanonical bootstrap coverage')


def retained_binding(replay, baseline, action):
    """Reconstruct this lane's original roots; markers only corroborate them."""
    original, paths = replay.original, replay.paths
    base = original['base']
    w, store = base + '/workspace', base + '/workspace/.orca'
    ident = store + '/workspace-identity/id'
    retained = original['immutable'][ident]
    raw = bytes.fromhex(retained['hex'])
    require(re.fullmatch(UUID + r'\n', raw.decode(), re.IGNORECASE) is not None,
            'invalid original workspace identity')
    obj = paths[ident]
    dev, ino, mode, uid, gid = retained['identity']
    require(obj.data == raw and obj.physical == (os.major(dev), os.minor(dev), ino) and
            (obj.mode, obj.uid, obj.gid) == (mode, uid, gid), 'workspace identity changed from original')

    def directory(path):
        device, inode, *_ = original['directories'][path]
        actual = paths[path]
        require(actual.physical == (os.major(device), os.minor(device), inode), 'original root physical binding differs')
        return {'path': path, 'device': device, 'inode': inode}

    value = {'control': directory(base + '/control'), 'releases': directory(base + '/releases'),
             'workspaceIdentity': {'path': ident, 'device': dev, 'inode': ino,
                 'digest': hashlib.sha256(raw.hex().encode()).hexdigest(),
                 'directory': directory(store + '/workspace-identity')},
             'roles': [{'role': role, 'path': path, 'directory': directory(parent), 'target': w}
                 for role, path, parent in [('config', w, w), ('sidecar', w + '/orca.permissions.json', w),
                                             ('store', store, store)]],
             'targets': [directory(w)]}
    workspace = hashlib.sha256(raw).hexdigest()
    root = digest(value)
    witness = original['immutable'][base + '/control/never-typed']
    require(witness['family'] == 'enrollment-witness' and
            bytes.fromhex(witness['hex']) == (workspace + '\n' + root + '\n').encode(),
            'original enrollment witness differs from reconstructed roots')
    intent = parse(paths[base + '/control/intent.json'].data)
    enrollment = intent.get('enrollmentRef')
    require(type(enrollment) is str and re.fullmatch(UUID, enrollment) is not None,
            'invalid actual enrollment UUID')
    expected = {'version': 1, 'workspaceRef': workspace, 'sidecarRef': hashlib.sha256(
        (w + '/orca.permissions.json').encode()).hexdigest(), 'format': 'orca-permissions-v2',
        'minimumWriterContract': 'orca-typed-sidecar-v1', 'rootBindingRef': root,
        'enrollmentRef': enrollment, 'state': 'enrollment-pending'}
    require(same_json(intent, expected) and same_json(parse(paths[base + '/control/enrolled.json'].data),
            {**expected, 'state': 'enrolled'}), 'actual intent/enrollment correspondence differs')
    binding = {'workspaceRef': workspace, 'rootBindingRef': root, 'enrollmentRef': enrollment}
    # The protected owner hashes enrollment identity, while the file service
    # separately projects action cwd/workspace to its owned disposable tree.
    require(baseline['binding'] == binding, 'baseline differs from original managed binding')
    sidecar = paths[w + '/orca.permissions.json'].data
    require(same_json(parse(sidecar), {'version': 2, 'agents': {}, 'scopedRules': {'version': 1, 'records': []}}),
            'bootstrap actual sidecar is not empty initial policy')
    revision = hashlib.sha256(sidecar).hexdigest()
    require(baseline['initialRevision'] == revision == action['authority']['currentPolicyRevision'],
            'actual initial sidecar revision differs')
    return binding


def resource_projection(replay, resource, action, parameters):
    """Check the service projection independently of the enrollment authority root."""
    # creation_path belongs to the kernel-validated exclusive original fixture
    # open (resource_entry validates its raw record before this predicate).
    path = resource.creation_path
    require(re.fullmatch(re.escape(replay.original['base']) +
            r'/orca-owned-service-[A-Za-z0-9]{6}/fixture', path) is not None,
            'noncanonical original owned resource path')
    projected = {'effectiveCwd': {'state': 'complete', 'value': str(Path(path).parent)},
                 'workspaceRef': {'state': 'complete', 'value': parameters[1] + ':temporary-tree'},
                 'resources': {'state': 'complete', 'value': [
                     {'operation': 'fs.readOwnedBytes', 'physicalTargetRef': parameters[2]}]},
                 'relevantStateRefs': {'state': 'complete', 'value': [parameters[2]]},
                 'environmentAndCredentialRefs': {'state': 'complete', 'value': []}}
    require(all(action.get(k) == v for k, v in projected.items()) and
            action['coverage']['coverageId'] == parameters[1] + ':source-v1',
            'action differs from original owned resource projection')
    return projected


def original_authority(replay, baseline, action, binding, actors, lease, times):
    """Existing protected owner's credential/lease/identity digests, no new policy."""
    original = replay.original
    start, finish = original['startedWallNs'], original['finishedWallNs']
    require(times and all(type(t) is int and start <= t <= finish for t in times),
            'missing/out-of-run independent semantic times')
    for principal, permissions in [('controlled-test-operator', {'permissions.grant', 'inputs.answer'}),
                                    ('controlled-test-reviewer', {'permissions.grant'})]:
        credential = actors[principal]
        require(re.fullmatch(r'[A-Za-z0-9_-]{12}', credential['id']) is not None and
                re.fullmatch(r'[0-9a-f]{64}', credential['secretSha256']) is not None and
                type(credential['permissions']) is list and len(credential['permissions']) == len(permissions) and
                set(credential['permissions']) == permissions and credential['scope'] == {'workflows': '*', 'runs': 'all'},
                'credential permissions/scope/identity differ from designation')
        require(start <= iso_ns(credential['createdAt']) <= min(times), 'credential creation outside original live interval')
        if 'expiresAt' in credential:
            require(iso_ns(credential['expiresAt']) > finish, 'credential expired during original execution')
    require(lease['resource'] == 'run:controlled' and
            all(type(lease[k]) is str and re.fullmatch(UUID, lease[k]) is not None for k in ('holder', 'guardedId')) and
            lease['guardedHost'] == os.uname().nodename and
            lease['host'] == '\0orca-guarded-lease' and type(lease['pid']) is int and lease['pid'] == original['leaderPid'] and
            type(lease['ttlMs']) is int and lease['ttlMs'] == 9007199254740991 and
            type(lease['guardedTtlMs']) is int and lease['guardedTtlMs'] == 60000,
            'invalid original lease resource/holder/incarnation/host')
    acquired, renewed = iso_ns(lease['acquiredAt']), iso_ns(lease['renewedAt'])
    require(start <= acquired <= renewed <= min(times) and finish < renewed + 60_000_000_000,
            'original lease acquisition/renewal/live interval differs')
    logical = {**lease, 'host': lease['guardedHost'], 'ttlMs': lease['guardedTtlMs']}
    require(same_json(baseline['lease'], logical), 'authenticated lease differs from actual guarded lease')
    credential = actors['controlled-test-operator']
    actor = {'principalId': credential['principal'], 'credentialId': credential['id']}
    require(baseline['operator'] == {'actor': actor, 'credential': {k: v for k, v in credential.items()
            if k != 'secretSha256'}}, 'baseline actor/public credential differs')
    facts = {**actor, 'permissions': sorted(credential['permissions']),
             'scope': {'workflows': credential['scope']['workflows'], 'runs': credential['scope']['runs']},
             'expiresAt': credential.get('expiresAt'), 'createdAt': credential['createdAt']}
    revocation = digest(facts)
    epoch = digest([lease[k] for k in ('resource', 'holder', 'guardedId', 'acquiredAt', 'pid', 'guardedHost')])
    require(action['authority'] == {'capturedGeneration': 'controlled-original-ceiling',
            'currentPolicyRevision': baseline['initialRevision'], 'revocationEpoch': revocation,
            'leaseEpoch': epoch, 'authorityRevision': digest([binding, revocation, epoch])},
            'original credential/lease/authority epoch differs')


def causal_records(replay, records, resource, rule):
    # Source order: baseline settles before evaluate records capture; dispatch records authorization.
    ordered = [records[k][2] for k in ('controlled-baseline-v1', 'controlled-capture-v1',
                                      'controlled-authorization-v1')]
    times = []
    previous = None
    for obj in ordered:
        durable = getattr(obj, 'durable_publication_completion', None)
        require(type(durable) is int and type(obj.creation_entry) is int and obj.creation_entry <= durable,
                'missing valid durable_publication_completion')
        require(previous is None or previous < obj.creation_entry, 'semantic durable publication order differs')
        require(obj.creation_entry in replay.entry_times and durable in replay.entry_times,
                'missing independently observed semantic raw-line timestamp')
        # A normal completed syscall prefix is ENTRY only. Use the later pread
        # entry/finish to bound currency; never call this an exact completion time.
        times.extend([replay.entry_times[obj.creation_entry], replay.entry_times[durable]])
        previous = durable
    effects = resource.effect_entries
    require(effects and previous < min(effects) and
            records['controlled-producer-observation-v1'][2].creation_entry > max(effects),
            'authorization/effect/observation durable publication order differs')
    require(all(e in replay.entry_times for e in effects), 'missing independently observed service pread time')
    times.extend(replay.entry_times[e] for e in effects)
    require(all(type(t) is int and replay.original['startedWallNs'] <= t <= replay.original['finishedWallNs']
                for t in times) and times == sorted(times),
            'invalid/backward independent semantic timestamps')
    not_before, expiry = iso_ns(rule['notBefore']), iso_ns(rule['expiresAt'])
    require(not_before <= min(times) <= max(times) <= replay.original['finishedWallNs'] < expiry,
            'bootstrap rule notBefore/expiry outside independently observed interval')
    return times


def authenticate_bootstrap(replay):
    original, paths = replay.original, replay.paths
    base = original['base']
    directory = base + '/workspace/.orca/private-execution/'
    key = paths[directory + '.execution-key'].data
    records = {}
    for path, obj in paths.items():
        if path.startswith(directory) and path.endswith('.payload.json'):
            require(obj.physical is not None and obj.published and obj.directory_synced, 'payload lacks kernel publication')
            payload = decode(Path(path).name, obj.data, key)
            closed_fields(payload, 'runId type sensitivityRefs payload', 'protected semantic envelope')
            require(payload['runId'] == 'controlled' and payload['type'] == 'agent.update' and
                    payload['sensitivityRefs'] == [], 'wrong authenticated payload identity')
            update = payload['payload']
            closed_fields(update, 'stepRunId sessionId update', 'semantic payload')
            closed_fields(update['update'], 'kind text', 'semantic update')
            require(update['stepRunId'] == 'controlled-step' and update['sessionId'] == 'controlled-session', 'wrong semantic principal scope')
            require(type(update['update']['text']) is str, 'semantic text is not a string')
            semantic = parse(update['update']['text'])
            closed_fields(semantic, 'kind value', 'semantic text')
            require(type(semantic['kind']) is str and update['update']['kind'] == semantic['kind'],
                    'outer update kind differs from authenticated semantic kind')
            require(semantic['kind'] not in records, 'duplicate bootstrap semantic kind')
            records[semantic['kind']] = (unquote(Path(path).name[:-13]), semantic['value'], obj)
    require(set(records) == {'controlled-baseline-v1', 'controlled-capture-v1',
            'controlled-authorization-v1', 'controlled-producer-observation-v1'}, 'missing/unknown bootstrap semantics')
    baseline = records['controlled-baseline-v1'][1]
    capture = records['controlled-capture-v1'][1]
    authorization_ref, authorization, _ = records['controlled-authorization-v1']
    closed_fields(baseline, 'version originalAction capturedCeiling binding operator lease initialRevision profileRef '
                  'installedEvidenceRef interval expiresAt rules', 'bootstrap baseline')
    closed_fields(capture, 'action bytes', 'bootstrap capture')
    closed_fields(authorization, 'action verdict protectedEvidenceRef', 'bootstrap authorization')
    closed_fields(records['controlled-producer-observation-v1'][1], 'actionId authorizationRef', 'bootstrap observation')
    action = capture['action']
    closed_fields(action, ACTION_FIELDS, 'bootstrap action')
    require(same_json(baseline['originalAction'], action) and same_json(authorization['action'], action), 'original action/authentication binding differs')
    require(action['profileRef'] == action['capturedByBoundaryId'] == 'orca-owned-file-read-v1' and
            action['operation'] == 'fs.readOwnedBytes', 'noncanonical operation/profile')
    invocation = action['invocation']
    require(invocation == {'instanceId': 'controlled-test-boot', 'sessionId': 'controlled-session',
            'turnId': 'controlled-human-turn', 'invocationId': 'controlled-human-invocation',
            'runId': 'controlled', 'rootRunId': 'controlled', 'stepRunId': 'controlled-step',
            'attemptId': 'controlled-attempt', 'agentId': 'controlled-agent', 'hostId': 'controlled-local-linux',
            'runnerId': 'controlled-runner', 'principalRef': 'controlled-test-operator'}, 'wrong designated invocation')
    resource = replay.resources[0]
    require(type(capture['bytes']) is str, 'captured parameters are not a string')
    parameters = parse(capture['bytes'])
    require(type(parameters) is list and len(parameters) == 5 and
            type(parameters[3]) is int and type(parameters[4]) is int and
            capture['bytes'] == encoded(parameters) and parameters[0] == 'orca-owned-file-read-v1' and
            parameters[3:] == [original['offset'], original['length']], 'captured canonical parameter bytes differ')
    require(type(parameters[1]) is str and re.fullmatch('owned-file:' + UUID, parameters[1]) and
            type(parameters[2]) is str and parameters[2].startswith(parameters[1] + ':'), 'missing original resource prefix')
    bootstrap_action_schema(action, original, parameters[1])
    physical = parameters[2].removeprefix(parameters[1] + ':').split(':')
    require(len(physical) == 9 and all(re.fullmatch(r'0|[1-9][0-9]*', part) for part in physical) and
            tuple(map(int, physical)) in resource.resource_stamps and list(map(int, physical[:7])) ==
            [os.makedev(*resource.physical[:2]), resource.physical[2], resource.mode,
             resource.uid, resource.gid, 0, len(resource.data)], 'captured resource physical identity differs')
    creation_ns = resource_entry(replay, resource)
    projected = resource_projection(replay, resource, action, parameters)
    require(same_json(baseline['interval'], {'offset': original['offset'], 'length': original['length']}) and
            baseline['installedEvidenceRef'] is None and type(baseline['version']) is int and baseline['version'] == 1 and
            baseline['profileRef'] == 'orca-owned-file-read-v1', 'wrong bootstrap designation')
    require(action['coverage']['level'] == 'policy-per-ask' and
            action['coverage']['evidence']['installedRefs'] == [] and
            action['coverage']['evidence']['independentlyObservedEffects'] is False, 'bootstrap relabeled coverage')
    rules = baseline['rules']
    require(len(rules) == 1, 'bootstrap baseline rule count')
    rule = rules[0]
    require(set(rule) == {'ruleId', 'ruleRevision', 'status', 'notBefore', 'expiresAt', 'decision', 'match'},
            'noncanonical bootstrap rule fields')
    expected_match = {key: invocation[key] for key in ('principalRef', 'agentId', 'hostId', 'runnerId')}
    expected_match.update(operation='fs.readOwnedBytes', profileRef='orca-owned-file-read-v1',
        coverageId=action['coverage']['coverageId'], effectiveCwd=action['effectiveCwd']['value'],
        workspaceRef=action['workspaceRef']['value'], resources=action['resources']['value'], environmentAndCredentialRefs=[])
    require(rule['match'] == expected_match and rule['expiresAt'] == action['expiresAt'] == baseline['expiresAt'],
            'bootstrap rule applicability/expiry differs')
    require(same_json(baseline['capturedCeiling'], {'operation': 'fs.readOwnedBytes', 'profileRef': 'orca-owned-file-read-v1',
            'resourceRef': parameters[1], 'maximumInvocations': 2}), 'wrong original bootstrap ceiling')
    require(action['bindingRef'] == 'synthetic-read:' + action['actionId'] + ':action' and
            records['controlled-capture-v1'][0] == 'capture:' + action['bindingRef'] and
            authorization_ref == 'synthetic-read:' + action['actionId'] + ':evidence', 'wrong original capture/authorization references')
    rule_bytes = encoded({k: v for k, v in rule.items() if k != 'ruleRevision'})
    require(rule['ruleId'] == 'controlled-bootstrap-only' and rule['decision'] == 'allow' and
            rule['status'] == 'approved' and rule['ruleRevision'] == hashlib.sha256(rule_bytes.encode()).hexdigest(), 'bootstrap rule binding')
    verdict = authorization['verdict']
    expected_verdict = {'version': 1, 'actionBindingRef': action['bindingRef'], 'authority': action['authority'],
                        'coverageId': action['coverage']['coverageId'], 'outcome': 'allow',
                        'authorizedBy': {'kind': 'rule', 'ruleId': rule['ruleId'], 'ruleRevision': rule['ruleRevision']}}
    require(same_json(verdict, expected_verdict), 'noncanonical bootstrap authorization (judge provenance forbidden)')
    require(authorization_ref == authorization['protectedEvidenceRef'] and
            records['controlled-producer-observation-v1'][1] == {'actionId': action['actionId'],
            'authorizationRef': authorization_ref}, 'authorization/effect correlation differs')
    credential_file = parse(paths[base + '/credentials.json'].data)
    actors = designated_credentials(credential_file['credentials'])
    require(type(credential_file['version']) is int and credential_file['version'] == 1, 'wrong actual credential file version')
    binding = retained_binding(replay, baseline, action)
    times = causal_records(replay, records, resource, rule)
    lease = parse(paths[base + '/workspace/.orca/leases/run%3Acontrolled.json'].data)
    original_authority(replay, baseline, action, binding, actors, lease, times + [creation_ns])
    require(not any(path.endswith('controlled.jsonl') for path in paths), 'bootstrap produced live-answer journal')
    expiry = iso_ns(action['expiresAt'])
    expiry_bound(original, creation_ns, expiry)
    return {'record': 'authenticated-bootstrap-correlations', 'authority': 'none',
            'authorizationRef': authorization_ref, 'actionId': action['actionId'], 'semanticRecords': len(records),
            'enrollmentBinding': binding, 'resourceProjection': projected,
            'resourceCreateEntryNs': creation_ns, 'authenticatedExpiryNs': expiry,
            'resourceCreateEntryRawLine': resource.creation_entry + 1,
            'ownerOrigin': 'unmeasured-source-precedes-create-entry', 'maximumOwnerDurationNs': 55000000000}
