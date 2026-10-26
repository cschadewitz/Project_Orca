"""Crypto negatives and synthetic semantic predicate controls; never bootstrap acceptance."""
import base64
import json
import unittest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from controlled_semantics import decode, parse


class AuthenticationControls(unittest.TestCase):
    def envelope(self):
        key = bytes(range(32))
        nonce = bytes(range(12))
        raw = AESGCM(key).encrypt(nonce, b'{"value":1}', b'orca:protected-execution:v1:private-execution:test.payload.json')
        obj = {'version': 1, 'algorithm': 'aes-256-gcm', 'nonce': base64.b64encode(nonce).decode(),
               'ciphertext': base64.b64encode(raw[:-16]).decode(), 'tag': base64.b64encode(raw[-16:]).decode()}
        return key, obj

    def test_authenticated_json_roundtrip_has_no_authority(self):
        key, obj = self.envelope()
        self.assertEqual(decode('test.payload.json', json.dumps(obj), key), {'value': 1})

    def test_wrong_record_identity_and_key_refuse(self):
        key, obj = self.envelope()
        for name, supplied in [('other.payload.json', key), ('test.payload.json', bytes(32))]:
            with self.assertRaises(InvalidTag):
                decode(name, json.dumps(obj), supplied)

    def test_ciphertext_or_tag_corruption_refuses(self):
        for field in ('ciphertext', 'tag'):
            key, obj = self.envelope()
            data = bytearray(base64.b64decode(obj[field])); data[0] ^= 1
            obj[field] = base64.b64encode(data).decode()
            with self.assertRaises(InvalidTag):
                decode('test.payload.json', json.dumps(obj), key)

    def test_unknown_envelope_fields_or_nonce_bounds_refuse(self):
        for change in ({'extra': True}, {'version': 2}, {'nonce': 'eA=='}, {'algorithm': 'unknown'}):
            key, obj = self.envelope(); obj.update(change)
            with self.assertRaises(RuntimeError):
                decode('test.payload.json', json.dumps(obj), key)

    def test_duplicate_json_keys_refuse(self):
        with self.assertRaisesRegex(RuntimeError, 'duplicate'):
            parse('{"kind":"original","kind":"replacement"}')

class CredentialIdentityControls(unittest.TestCase):
    def test_exact_two_distinct_designated_credentials(self):
        from controlled_semantics import designated_credentials
        original = [{'principal': 'controlled-test-operator', 'id': 'operator'},
                    {'principal': 'controlled-test-reviewer', 'id': 'reviewer'}]
        self.assertEqual(len(designated_credentials(original)), 2)
        for records in [original + [dict(original[0], id='extra')],
                        [original[0], dict(original[0], id='extra')],
                        [original[0], dict(original[1], id='operator')], [], original[:1]]:
            with self.subTest(records=records), self.assertRaises(RuntimeError):
                designated_credentials(records)


# All data below is deliberately synthetic. Passing these predicates is not a
# bootstrap run, source review, kernel-provider proof or connected capability.
from types import SimpleNamespace
from urllib.parse import quote
import hashlib
import os
import stat

from controlled_semantics import authenticate_bootstrap, digest, encoded
from controlled_timestamps import iso_ns
from test_controlled_timestamps import clock_original, START, NS


def synthetic_bootstrap():
    original = clock_original()
    base = '/synthetic'
    w, store = base + '/workspace', base + '/workspace/.orca'
    ident = store + '/workspace-identity/id'
    uid = '12345678-1234-4123-8123-123456789abc'
    raw = (uid + '\n').encode()
    directories = {p: [1, i + 10, stat.S_IFDIR | 0o700, os.getuid(), os.getgid()] for i, p in
                   enumerate([base + '/control', base + '/releases', w, store, store + '/workspace-identity'])}
    def directory(p):
        return {'path': p, 'device': directories[p][0], 'inode': directories[p][1]}
    roots = {'control': directory(base + '/control'), 'releases': directory(base + '/releases'),
             'workspaceIdentity': {'path': ident, 'device': 1, 'inode': 30,
                 'digest': hashlib.sha256(raw.hex().encode()).hexdigest(),
                 'directory': directory(store + '/workspace-identity')},
             'roles': [{'role': role, 'path': p, 'directory': directory(parent), 'target': w}
                 for role, p, parent in [('config', w, w), ('sidecar', w + '/orca.permissions.json', w), ('store', store, store)]],
             'targets': [directory(w)]}
    binding = {'workspaceRef': hashlib.sha256(raw).hexdigest(), 'rootBindingRef': digest(roots), 'enrollmentRef': uid}
    paths = {p: SimpleNamespace(physical=(os.major(v[0]), os.minor(v[0]), v[1])) for p, v in directories.items()}
    paths[ident] = SimpleNamespace(data=raw, physical=(0, 1, 30), mode=stat.S_IFREG | 0o600,
                                  uid=os.getuid(), gid=os.getgid())
    witness = (binding['workspaceRef'] + '\n' + binding['rootBindingRef'] + '\n').encode()
    original.update(base=base, leaderPid=10, offset=2, length=4, directories=directories)
    original['immutable'].update({ident: {'hex': raw.hex(), 'identity': [1, 30, stat.S_IFREG | 0o600, os.getuid(), os.getgid()]},
        base + '/control/never-typed': {'hex': witness.hex(), 'family': 'enrollment-witness'}})
    marker = {'version': 1, 'workspaceRef': binding['workspaceRef'],
              'sidecarRef': hashlib.sha256((w + '/orca.permissions.json').encode()).hexdigest(),
              'format': 'orca-permissions-v2', 'minimumWriterContract': 'orca-typed-sidecar-v1',
              'rootBindingRef': binding['rootBindingRef'], 'enrollmentRef': uid, 'state': 'enrollment-pending'}
    for name, obj in [('intent', marker), ('enrolled', {**marker, 'state': 'enrolled'})]:
        paths[base + '/control/' + name + '.json'] = SimpleNamespace(data=encoded(obj).encode())
    sidecar = encoded({'version': 2, 'agents': {}, 'scopedRules': {'version': 1, 'records': []}}).encode()
    paths[w + '/orca.permissions.json'] = SimpleNamespace(data=sidecar)
    revision = hashlib.sha256(sidecar).hexdigest()
    def iso(seconds):
        from datetime import datetime, timezone
        return datetime.fromtimestamp(START // NS + seconds, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    credentials = [{'principal': p, 'id': i, 'secretSha256': 'a' * 64, 'permissions': perms,
                    'scope': {'workflows': '*', 'runs': 'all'}, 'createdAt': iso(1)} for p, i, perms in
                   [('controlled-test-operator', 'operator1234', ['permissions.grant', 'inputs.answer']),
                    ('controlled-test-reviewer', 'reviewer1234', ['permissions.grant'])]]
    paths[base + '/credentials.json'] = SimpleNamespace(data=encoded({'version': 1, 'credentials': credentials}).encode())
    lease = {'resource': 'run:controlled', 'holder': uid, 'pid': 10, 'host': '\0orca-guarded-lease',
             'acquiredAt': iso(1), 'renewedAt': iso(1), 'ttlMs': 9007199254740991,
             'guardedTtlMs': 60000, 'guardedHost': os.uname().nodename, 'guardedId': uid}
    paths[store + '/leases/run%3Acontrolled.json'] = SimpleNamespace(data=encoded(lease).encode())
    actor = {'principalId': credentials[0]['principal'], 'credentialId': credentials[0]['id']}
    facts = {**actor, 'permissions': ['inputs.answer', 'permissions.grant'], 'scope': credentials[0]['scope'],
             'expiresAt': None, 'createdAt': iso(1)}
    revocation = digest(facts)
    epoch = digest([lease[k] for k in ('resource', 'holder', 'guardedId', 'acquiredAt', 'pid', 'guardedHost')])
    invocation = {'instanceId': 'controlled-test-boot', 'sessionId': 'controlled-session',
                  'turnId': 'controlled-human-turn', 'invocationId': 'controlled-human-invocation',
                  'runId': 'controlled', 'rootRunId': 'controlled', 'stepRunId': 'controlled-step',
                  'attemptId': 'controlled-attempt', 'agentId': 'controlled-agent', 'hostId': 'controlled-local-linux',
                  'runnerId': 'controlled-runner', 'principalRef': 'controlled-test-operator'}
    data = b'disposable candidate bytes'
    stamp = (1, 99, stat.S_IFREG | 0o400, os.getuid(), os.getgid(), 0, len(data), 123, 456)
    resource_ref = 'owned-file:' + uid
    physical = resource_ref + ':' + ':'.join(map(str, stamp))
    resources = [{'operation': 'fs.readOwnedBytes', 'physicalTargetRef': physical}]
    action = {'actionId': uid, 'profileRef': 'orca-owned-file-read-v1', 'capturedByBoundaryId': 'orca-owned-file-read-v1',
              'operation': 'fs.readOwnedBytes', 'invocation': invocation,
              'authority': {'capturedGeneration': 'controlled-original-ceiling', 'currentPolicyRevision': revision,
                  'revocationEpoch': revocation, 'leaseEpoch': epoch, 'authorityRevision': digest([binding, revocation, epoch])},
              'workspaceRef': {'state': 'complete', 'value': binding['workspaceRef']},
              'effectiveCwd': {'state': 'complete', 'value': w},
              'environmentAndCredentialRefs': {'state': 'complete', 'value': []},
              'coverage': {'level': 'policy-per-ask', 'coverageId': 'synthetic-coverage', 'evidence':
                           {'installedRefs': [], 'independentlyObservedEffects': False}},
              'resources': {'state': 'complete', 'value': resources}, 'expiresAt': iso(55),
              'bindingRef': 'synthetic-read:' + uid + ':action'}
    match = {k: invocation[k] for k in ('principalRef', 'agentId', 'hostId', 'runnerId')}
    match.update(operation=action['operation'], profileRef=action['profileRef'], coverageId='synthetic-coverage',
                 effectiveCwd=w, workspaceRef=binding['workspaceRef'], resources=resources, environmentAndCredentialRefs=[])
    rule = {'ruleId': 'controlled-bootstrap-only', 'ruleRevision': '', 'status': 'approved',
            'notBefore': iso(2), 'expiresAt': iso(55), 'decision': 'allow', 'match': match}
    rule['ruleRevision'] = digest({k: v for k, v in rule.items() if k != 'ruleRevision'})
    baseline = {'version': 1, 'originalAction': action, 'capturedCeiling': {'operation': action['operation'],
                'profileRef': action['profileRef'], 'resourceRef': resource_ref, 'maximumInvocations': 2},
                'binding': binding, 'operator': {'actor': actor, 'credential': {k: v for k, v in credentials[0].items() if k != 'secretSha256'}},
                'lease': {**lease, 'host': lease['guardedHost'], 'ttlMs': 60000}, 'initialRevision': revision,
                'profileRef': action['profileRef'], 'installedEvidenceRef': None,
                'interval': {'offset': 2, 'length': 4}, 'expiresAt': iso(55), 'rules': [rule]}
    auth_ref = 'synthetic-read:' + uid + ':evidence'
    authorization = {'action': action, 'protectedEvidenceRef': auth_ref, 'verdict': {'outcome': 'allow',
                     'authorizedBy': {'kind': 'rule', 'ruleId': rule['ruleId'], 'ruleRevision': rule['ruleRevision']},
                     'actionBindingRef': action['bindingRef'], 'authority': action['authority'], 'coverageId': 'synthetic-coverage'}}
    semantics = {'controlled-baseline-v1': (uid, baseline),
                 'controlled-capture-v1': ('capture:' + action['bindingRef'], {'action': action, 'bytes': encoded([action['profileRef'], resource_ref, physical, 2, 4])}),
                 'controlled-authorization-v1': (auth_ref, authorization),
                 'controlled-producer-observation-v1': ('23456789-1234-4123-8123-123456789abc', {'actionId': uid, 'authorizationRef': auth_ref})}
    key = bytes(range(32))
    private = store + '/private-execution/'
    paths[private + '.execution-key'] = SimpleNamespace(data=key)
    record_objects = {}
    for kind, entry, durable in [('controlled-baseline-v1', 30, 35), ('controlled-capture-v1', 40, 45),
                                 ('controlled-authorization-v1', 50, 55), ('controlled-producer-observation-v1', 70, 75)]:
        record_objects[kind] = SimpleNamespace(creation_entry=entry, durable_publication_completion=durable,
            physical=(0, 1, entry), published=True, directory_synced=True)
    resource_path = base + '/orca-owned-service-abcdef/fixture'
    resource = SimpleNamespace(data=data, physical=(0, 1, 99), mode=stamp[2], uid=stamp[3], gid=stamp[4],
        resource_stamps={stamp}, birth_ns=START+2*NS, creation_entry=20, creation_path=resource_path,
        effect_entries=[60], creation_record=(10, 'openat', ['AT_FDCWD', json.dumps(resource_path),
        'O_WRONLY|O_CREAT|O_EXCL|O_TRUNC|O_CLOEXEC', '0400'], '20', 20, 20))
    replay = SimpleNamespace(original=original, paths=paths, resources=[resource], leader=10,
        entry_times={i: START + i * NS // 10 for i in range(20, 76)}, family=lambda p: 'resource')
    return replay, semantics, record_objects, key


def reauthenticate(fixture):
    replay, semantics, objects, key = fixture
    private = replay.original['base'] + '/workspace/.orca/private-execution/'
    for index, (kind, (ref, value)) in enumerate(semantics.items()):
        name = quote(ref, safe='') + '.payload.json'
        payload = {'runId': 'controlled', 'type': 'agent.update', 'sensitivityRefs': [], 'payload':
                   {'stepRunId': 'controlled-step', 'sessionId': 'controlled-session', 'update':
                    {'text': encoded({'kind': kind, 'value': value})}}}
        nonce = index.to_bytes(12, 'big')
        cipher = AESGCM(key).encrypt(nonce, encoded(payload).encode(),
                                    ('orca:protected-execution:v1:private-execution:' + name).encode())
        envelope = {'version': 1, 'algorithm': 'aes-256-gcm', 'nonce': base64.b64encode(nonce).decode(),
                    'ciphertext': base64.b64encode(cipher[:-16]).decode(), 'tag': base64.b64encode(cipher[-16:]).decode()}
        objects[kind].data = encoded(envelope).encode()
        # The roundtrip explicitly establishes valid crypto for each negative control.
        if decode(name, objects[kind].data, key) != payload:
            raise AssertionError('synthetic reauthentication roundtrip differs')
        replay.paths[private + name] = objects[kind]
    return replay


class SyntheticOriginalAuthorityControls(unittest.TestCase):
    def test_synthetic_positive_predicates_return_no_acceptance_authority(self):
        result = authenticate_bootstrap(reauthenticate(synthetic_bootstrap()))
        self.assertEqual(result['authority'], 'none')
        self.assertEqual(result['semanticRecords'], 4)
        self.assertEqual(result['ownerOrigin'], 'unmeasured-source-precedes-create-entry')

    def refuses(self, change, message):
        fixture = synthetic_bootstrap()
        change(*fixture)
        with self.assertRaisesRegex(RuntimeError, message):
            authenticate_bootstrap(reauthenticate(fixture))

    def test_reauthenticated_binding_tampering(self):
        for field in ('workspaceRef', 'rootBindingRef', 'enrollmentRef'):
            self.refuses(lambda r, s, o, k: s['controlled-baseline-v1'][1]['binding'].__setitem__(field, 'wrong'), 'managed binding')
        self.refuses(lambda r, s, o, k: s['controlled-capture-v1'][1]['action']['effectiveCwd'].__setitem__('value', '/elsewhere'), 'applicability|managed binding')

    def test_reauthenticated_revision_tampering_even_when_records_agree(self):
        def change(r, s, o, k):
            s['controlled-baseline-v1'][1]['initialRevision'] = 'f' * 64
            s['controlled-capture-v1'][1]['action']['authority']['currentPolicyRevision'] = 'f' * 64
        self.refuses(change, 'actual initial sidecar revision')
        def nonempty(r, s, o, k):
            r.paths['/synthetic/workspace/orca.permissions.json'].data = encoded(
                {'version': 2, 'agents': {}, 'scopedRules': {'version': 1, 'records': [{}]}}).encode()
        self.refuses(nonempty, 'not empty initial policy')
        self.refuses(lambda r, s, o, k: setattr(r.paths['/synthetic/workspace/orca.permissions.json'], 'data',
            r.paths['/synthetic/workspace/orca.permissions.json'].data + b'\n'), 'actual initial sidecar revision')

    def test_actual_marker_witness_and_identity_correspondence(self):
        for name in ('intent', 'enrolled'):
            def change(r, s, o, k):
                obj = r.paths['/synthetic/control/' + name + '.json']
                value = parse(obj.data); value['rootBindingRef'] = 'wrong'; obj.data = encoded(value).encode()
            self.refuses(change, 'intent/enrollment')
        self.refuses(lambda r, s, o, k: r.original['immutable']['/synthetic/control/never-typed'].__setitem__('hex', b'wrong'.hex()), 'witness')
        self.refuses(lambda r, s, o, k: setattr(r.paths['/synthetic/workspace/.orca/workspace-identity/id'], 'physical', (0, 1, 31)), 'identity changed')
        self.refuses(lambda r, s, o, k: setattr(r.paths['/synthetic/workspace'], 'physical', (0, 1, 999)), 'root physical')

    def test_reauthenticated_epochs_cannot_be_producer_authored_equalities(self):
        for field in ('revocationEpoch', 'leaseEpoch', 'authorityRevision', 'capturedGeneration'):
            self.refuses(lambda r, s, o, k: s['controlled-capture-v1'][1]['action']['authority'].__setitem__(field, 'f' * 64), 'epoch differs')

    def test_actual_lease_and_reauthenticated_logical_lease_tampering(self):
        for field, value, message in [('resource', 'run:other', 'resource/holder'), ('holder', 'invalid', 'resource/holder'),
                ('guardedId', 'invalid', 'resource/holder'),
                ('holder', '23456789-1234-4123-8123-123456789abc', 'epoch differs'),
                ('guardedId', '23456789-1234-4123-8123-123456789abc', 'epoch differs'), ('pid', 11, 'resource/holder'),
                ('guardedHost', 'wrong-host', 'resource/holder'), ('guardedTtlMs', 60001, 'resource/holder'),
                ('acquiredAt', '2026-10-26T23:59:59.000Z', 'live interval'),
                ('renewedAt', '2026-10-26T23:59:59.000Z', 'live interval'),
                ('renewedAt', '2026-10-25T00:00:00.000Z', 'live interval')]:
            def change(r, s, o, k):
                obj = r.paths['/synthetic/workspace/.orca/leases/run%3Acontrolled.json']
                lease = parse(obj.data); lease[field] = value; obj.data = encoded(lease).encode()
                logical = {**lease, 'host': lease['guardedHost'], 'ttlMs': lease['guardedTtlMs']}
                s['controlled-baseline-v1'][1]['lease'] = logical
            self.refuses(change, message)

    def test_actual_credential_currency_and_scope(self):
        for field, value, message in [('scope', {'workflows': '*', 'runs': 'owned'}, 'permissions/scope'),
                ('permissions', ['permissions.grant'], 'permissions/scope'), ('revokedAt', '2026-10-26T00:00:00.000Z', 'designated'),
                ('expiresAt', '2026-10-25T00:00:00.000Z', 'expired'),
                ('createdAt', '2026-10-26T23:59:59.000Z', 'creation outside')]:
            def change(r, s, o, k):
                obj = r.paths['/synthetic/credentials.json']; value_ = parse(obj.data)
                value_['credentials'][0][field] = value; obj.data = encoded(value_).encode()
                s['controlled-baseline-v1'][1]['operator']['credential'][field] = value
            self.refuses(change, message)

    def test_reauthenticated_future_rule_with_recomputed_revision(self):
        def change(r, s, o, k):
            rule = s['controlled-baseline-v1'][1]['rules'][0]
            rule['notBefore'] = '2026-10-26T23:59:59.000Z'
            rule['ruleRevision'] = digest({key: value for key, value in rule.items() if key != 'ruleRevision'})
            s['controlled-authorization-v1'][1]['verdict']['authorizedBy']['ruleRevision'] = rule['ruleRevision']
        self.refuses(change, 'rule notBefore/expiry')

    def test_durable_records_required_without_weak_publication_fallback(self):
        for kind in ('controlled-capture-v1', 'controlled-baseline-v1', 'controlled-authorization-v1'):
            for value in (None, True, '35', -1):
                def change(r, s, o, k):
                    o[kind].publication_completion = o[kind].durable_publication_completion
                    o[kind].durable_publication_completion = value
                self.refuses(change, 'durable_publication_completion')

    def test_reauthenticated_records_with_wrong_causal_order(self):
        for kind, durable in [('controlled-baseline-v1', 40), ('controlled-capture-v1', 50),
                              ('controlled-authorization-v1', 60)]:
            self.refuses(lambda r, s, o, k: setattr(o[kind], 'durable_publication_completion', durable), 'publication order')
        self.refuses(lambda r, s, o, k: setattr(o['controlled-producer-observation-v1'], 'creation_entry', 60), 'publication order')
        self.refuses(lambda r, s, o, k: r.entry_times.pop(50), 'raw-line timestamp')
        self.refuses(lambda r, s, o, k: r.entry_times.pop(60), 'pread time')

    def test_node_json_stringify_golden_owner_encodings(self):
        # Golden bytes/hashes obtained independently with Node createHash(JSON.stringify).
        facts = {'principalId': 'controlled-test-operator', 'credentialId': 'operator1234',
                 'permissions': ['inputs.answer', 'permissions.grant'],
                 'scope': {'workflows': '*', 'runs': 'all'}, 'expiresAt': None,
                 'createdAt': '2026-10-26T15:53:21.000Z'}
        self.assertEqual(digest(facts), '9fe8dfd46a9a7714c3a26c598f24e8e124143898d1c96e58e3247370b96a32f7')
        self.assertEqual(digest(['run:controlled', '12345678-1234-4123-8123-123456789abc',
            '23456789-1234-4123-8123-123456789abc', '2026-10-26T15:53:21.000Z', 10, 'synthetic-host']),
            '597682676440451651588a2b4529a6574b1353f95569a9a14cf5e272d5e77265')

    def test_reauthenticated_expired_rule_with_recomputed_revision(self):
        def change(r, s, o, k):
            baseline = s['controlled-baseline-v1'][1]
            rule = baseline['rules'][0]
            # Exactly finish: the upper endpoint is exclusive, even with valid crypto/revision.
            expiry = '2026-10-26T15:53:30.000Z'
            self.assertEqual(iso_ns(expiry), r.original['finishedWallNs'])
            baseline['expiresAt'] = rule['expiresAt'] = baseline['originalAction']['expiresAt'] = expiry
            rule['ruleRevision'] = digest({key: value for key, value in rule.items() if key != 'ruleRevision'})
            s['controlled-authorization-v1'][1]['verdict']['authorizedBy']['ruleRevision'] = rule['ruleRevision']
        self.refuses(change, 'rule notBefore/expiry')

    def test_synthetic_rule_lower_endpoint_is_inclusive(self):
        fixture = synthetic_bootstrap()
        rule = fixture[1]['controlled-baseline-v1'][1]['rules'][0]
        rule['notBefore'] = '2026-10-26T15:53:23.000Z'
        rule['ruleRevision'] = digest({key: value for key, value in rule.items() if key != 'ruleRevision'})
        fixture[1]['controlled-authorization-v1'][1]['verdict']['authorizedBy']['ruleRevision'] = rule['ruleRevision']
        self.assertEqual(authenticate_bootstrap(reauthenticate(fixture))['authority'], 'none')

    def test_reauthenticated_noncanonical_rule_scope(self):
        for field, value in [('delegation', {}), ('match', {})]:
            def change(r, s, o, k):
                rule = s['controlled-baseline-v1'][1]['rules'][0]
                rule[field] = value
                rule['ruleRevision'] = digest({key: value_ for key, value_ in rule.items() if key != 'ruleRevision'})
                s['controlled-authorization-v1'][1]['verdict']['authorizedBy']['ruleRevision'] = rule['ruleRevision']
            self.refuses(change, 'rule fields|applicability')

    def test_credential_scope_json_key_order_uses_schema_construction_order(self):
        fixture = synthetic_bootstrap()
        r, s, _, _ = fixture
        obj = r.paths['/synthetic/credentials.json']
        value = parse(obj.data)
        value['credentials'][0]['scope'] = {'runs': 'all', 'workflows': '*'}
        obj.data = encoded(value).encode()
        self.assertEqual(authenticate_bootstrap(reauthenticate(fixture))['authority'], 'none')
