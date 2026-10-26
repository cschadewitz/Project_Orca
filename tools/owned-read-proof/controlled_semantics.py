"""Authenticate actual replayed bootstrap records; no report/JSON capability intake."""
import base64
import hashlib
import json
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


def parse(data):
    return json.loads(data, object_pairs_hook=unique_object)


def decode(name, data, key):
    envelope = parse(data)
    require(set(envelope) == {'version', 'algorithm', 'nonce', 'ciphertext', 'tag'} and
            envelope['version'] == 1 and envelope['algorithm'] == 'aes-256-gcm', 'unknown encrypted envelope')
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
            require(payload['runId'] == 'controlled' and payload['type'] == 'agent.update' and
                    payload['sensitivityRefs'] == [], 'wrong authenticated payload identity')
            update = payload['payload']
            require(update['stepRunId'] == 'controlled-step' and update['sessionId'] == 'controlled-session', 'wrong semantic principal scope')
            semantic = parse(update['update']['text'])
            require(semantic['kind'] not in records, 'duplicate bootstrap semantic kind')
            records[semantic['kind']] = (unquote(Path(path).name[:-13]), semantic['value'], obj)
    require(set(records) == {'controlled-baseline-v1', 'controlled-capture-v1',
            'controlled-authorization-v1', 'controlled-producer-observation-v1'}, 'missing/unknown bootstrap semantics')
    baseline = records['controlled-baseline-v1'][1]
    capture = records['controlled-capture-v1'][1]
    authorization_ref, authorization, authorization_object = records['controlled-authorization-v1']
    action = capture['action']
    require(baseline['originalAction'] == action == authorization['action'], 'original action/authentication binding differs')
    require(action['profileRef'] == action['capturedByBoundaryId'] == 'orca-owned-file-read-v1' and
            action['operation'] == 'fs.readOwnedBytes', 'noncanonical operation/profile')
    invocation = action['invocation']
    require(invocation == {'instanceId': 'controlled-test-boot', 'sessionId': 'controlled-session',
            'turnId': 'controlled-human-turn', 'invocationId': 'controlled-human-invocation',
            'runId': 'controlled', 'rootRunId': 'controlled', 'stepRunId': 'controlled-step',
            'attemptId': 'controlled-attempt', 'agentId': 'controlled-agent', 'hostId': 'controlled-local-linux',
            'runnerId': 'controlled-runner', 'principalRef': 'controlled-test-operator'}, 'wrong designated invocation')
    resource = replay.resources[0]
    parameters = parse(capture['bytes'])
    require(len(parameters) == 5 and parameters[0] == 'orca-owned-file-read-v1' and
            parameters[3:] == [original['offset'], original['length']], 'captured original interval differs')
    uuid = r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
    require(type(parameters[1]) is str and re.fullmatch('owned-file:' + uuid, parameters[1]) and
            type(parameters[2]) is str and parameters[2].startswith(parameters[1] + ':'), 'missing original resource prefix')
    physical = parameters[2].removeprefix(parameters[1] + ':').split(':')
    require(len(physical) == 9 and all(re.fullmatch(r'0|[1-9][0-9]*', part) for part in physical) and
            tuple(map(int, physical)) in resource.resource_stamps and list(map(int, physical[:7])) ==
            [os.makedev(*resource.physical[:2]), resource.physical[2], resource.mode,
             resource.uid, resource.gid, 0, len(resource.data)], 'captured resource physical identity differs')
    require(action['resources'] == {'state': 'complete', 'value': [
        {'operation': 'fs.readOwnedBytes', 'physicalTargetRef': parameters[2]}]}, 'action resource projection differs')
    require(baseline['interval'] == {'offset': original['offset'], 'length': original['length']} and
            baseline['installedEvidenceRef'] is None and baseline['version'] == 1, 'wrong bootstrap designation')
    require(action['coverage']['level'] == 'policy-per-ask' and
            action['coverage']['evidence']['installedRefs'] == [] and
            action['coverage']['evidence']['independentlyObservedEffects'] is False, 'bootstrap relabeled coverage')
    rules = baseline['rules']
    require(len(rules) == 1, 'bootstrap baseline rule count')
    rule = rules[0]
    expected_match = {key: invocation[key] for key in ('principalRef', 'agentId', 'hostId', 'runnerId')}
    expected_match.update(operation='fs.readOwnedBytes', profileRef='orca-owned-file-read-v1',
        coverageId=action['coverage']['coverageId'], effectiveCwd=action['effectiveCwd']['value'],
        workspaceRef=action['workspaceRef']['value'], resources=action['resources']['value'], environmentAndCredentialRefs=[])
    require(rule['match'] == expected_match and rule['expiresAt'] == action['expiresAt'] == baseline['expiresAt'],
            'bootstrap rule applicability/expiry differs')
    require(baseline['capturedCeiling'] == {'operation': 'fs.readOwnedBytes', 'profileRef': 'orca-owned-file-read-v1',
            'resourceRef': parameters[1], 'maximumInvocations': 2}, 'wrong original bootstrap ceiling')
    require(action['bindingRef'] == 'synthetic-read:' + action['actionId'] + ':action' and
            records['controlled-capture-v1'][0] == 'capture:' + action['bindingRef'] and
            authorization_ref == 'synthetic-read:' + action['actionId'] + ':evidence', 'wrong original capture/authorization references')
    encoded = json.dumps({k: v for k, v in rule.items() if k != 'ruleRevision'}, separators=(',', ':'), ensure_ascii=False)
    require(rule['ruleId'] == 'controlled-bootstrap-only' and rule['decision'] == 'allow' and
            rule['status'] == 'approved' and rule['ruleRevision'] == hashlib.sha256(encoded.encode()).hexdigest(), 'bootstrap rule binding')
    verdict = authorization['verdict']
    require(verdict['outcome'] == 'allow' and verdict['authorizedBy'] == {'kind': 'rule',
            'ruleId': rule['ruleId'], 'ruleRevision': rule['ruleRevision']} and
            verdict['actionBindingRef'] == action['bindingRef'] and verdict['authority'] == action['authority'] and
            verdict['coverageId'] == action['coverage']['coverageId'], 'noncanonical bootstrap authorization')
    require(authorization_ref == authorization['protectedEvidenceRef'] and
            records['controlled-producer-observation-v1'][1] == {'actionId': action['actionId'],
            'authorizationRef': authorization_ref}, 'authorization/effect correlation differs')
    credentials = parse(paths[base + '/credentials.json'].data)['credentials']
    actors = designated_credentials(credentials)
    actor = baseline['operator']['actor']
    require(actor == {'principalId': 'controlled-test-operator',
            'credentialId': actors['controlled-test-operator']['id']}, 'baseline actor/credential differs')
    for principal, permissions in [('controlled-test-operator', {'permissions.grant', 'inputs.answer'}),
                                    ('controlled-test-reviewer', {'permissions.grant'})]:
        credential = actors[principal]
        require(type(credential['permissions']) is list and len(credential['permissions']) == len(permissions) and
                set(credential['permissions']) == permissions and credential['scope'] == {'workflows': '*', 'runs': 'all'},
                'credential permissions/scope differ from designation')
        created = iso_ns(credential['createdAt'])
        require(created <= resource.birth_ns, 'credential created after original resource')
        if 'expiresAt' in credential:
            require(iso_ns(credential['expiresAt']) > original['finishedWallNs'],
                    'credential expired during original execution')
    require(baseline['operator']['credential'] == {k: v for k, v in actors['controlled-test-operator'].items()
            if k != 'secretSha256'}, 'authenticated public credential snapshot differs')
    lease = parse(paths[base + '/workspace/.orca/leases/run%3Acontrolled.json'].data)
    require(lease['host'] == '\0orca-guarded-lease' and lease['ttlMs'] == 9007199254740991 and
            lease['guardedTtlMs'] == 60000 and lease['pid'] == original['leaderPid'],
            'invalid guarded lease representation')
    logical_lease = {**lease, 'host': lease['guardedHost'], 'ttlMs': lease['guardedTtlMs']}
    require(baseline['lease'] == logical_lease, 'authenticated lease differs from actual guarded lease')
    require(not any(path.endswith('controlled.jsonl') for path in paths), 'bootstrap produced live-answer journal')
    expiry = iso_ns(action['expiresAt'])
    creation_ns = resource_entry(replay, resource)
    expiry_bound(original, creation_ns, expiry)
    require(authorization_object.publication_completion < min(resource.effect_entries) and
            records['controlled-producer-observation-v1'][2].creation_entry > max(resource.effect_entries),
            'authorization/effect/observation publication order differs')
    return {'record': 'authenticated-bootstrap-correlations', 'authority': 'none',
            'authorizationRef': authorization_ref, 'actionId': action['actionId'], 'semanticRecords': len(records),
            'resourceCreateEntryNs': creation_ns, 'authenticatedExpiryNs': expiry,
            'resourceCreateEntryRawLine': resource.creation_entry + 1,
            'ownerOrigin': 'unmeasured-source-precedes-create-entry', 'maximumOwnerDurationNs': 55000000000}
