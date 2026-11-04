"""Source-bound connected Save/persistence correlations, never execution authority.

Requires the full original connected kernel replay and delivery correlation
predicates. Mutable objects are kernel-reconstructed physical histories, not a
caller-selected final JSON snapshot. Source-owned bridge/registry identity and
callback/permit memory remain cooperative exact-source assumptions.
"""
import hashlib
import json
import re
import stat

from controlled_contract import require
from controlled_connected import HUMAN
from controlled_delivery_semantics import authenticate_connected_delivery, in_phase, publication, records
from controlled_semantics import UUID, closed_fields, designated_credentials, digest, encoded, parse, same_json
from controlled_timestamps import iso_ns
from controlled_v2_model import MS

SCOPE = {'principal': 'Designated test operator', 'operation': 'Read', 'resources': 'Disposable detached inode',
         'environment': 'None', 'lifetime': 'Original test lifetime, at most one minute',
         'limits': 'Supervisor enforces original interval', 'authorizer': 'Designated test persistence reviewer',
         'coverage': 'Controlled test only'}
APPROVAL_FIELDS = ('version choice requiredReview persistenceReview acceptedAt credential lease binding actor target '
                   'command action resourceWorkspaceRef scopeEvidenceRef authorityRevision scope projection references reviewSourceRefs')


def pretty(value):
    # This lane uses only bounded fixed ASCII text/refs, physical paths and
    # integer fields; Python's finite encoding equals source JSON.stringify(..., null, 2).
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode()


def raw_span(replay, obj, fields):
    values = [getattr(obj, name, None) for name in fields.split()]
    require(all(type(v) is int and v >= 0 and v in replay.entry_times for v in values),
            'mutable history lacks complete raw causal observations')
    require(all(type(replay.entry_times[v]) is int and replay.original['startedWallNs'] <= replay.entry_times[v] <=
                replay.original['finishedWallNs'] for v in values), 'mutable history clock outside original run')
    require(replay.marks[0][5] < min(values) <= max(values) < replay.marks[1][4],
            'mutable publication outside Save phase')
    return values


def physical(replay, obj, family, mode):
    root = replay.original['directories'][replay.original['base'] + '/workspace']
    require(obj.family == family and type(obj.mode) is int and obj.mode == mode and
            type(obj.uid) is int and type(obj.gid) is int and (obj.uid, obj.gid) == tuple(root[3:5]) and
            type(obj.physical) is tuple and len(obj.physical) == 3 and all(type(n) is int and n >= 0 for n in obj.physical) and
            obj.physical[2] > 0, 'mutable physical family/mode/owner/inode differs')


def writer(replay, obj, final, family, mode, method):
    physical(replay, obj, family, mode)
    require(type(obj.writes) is int and obj.writes == 1 and obj.writer_closed is True and obj.published is True and
            obj.publication_method == method and
            obj.publication_path == final and obj.publication_temporary_path == obj.creation_path and
            obj.publication_parent is replay.paths[final.rsplit('/', 1)[0]],
            'mutable writer is not original complete same-parent publication')
    values = raw_span(replay, obj, 'creation_entry creation_completion last_write_completion writer_close_entry '
                      'writer_close_completion publication_entry publication_completion temporary_cleanup_entry temporary_cleanup_completion')
    a, b, c, d, e, f, g, h, i = values
    require(a <= b < c < d <= e < f <= g, 'mutable creation/write/close/publication order differs')
    if method == 'rename':
        require((h, i) == (f, g), 'mutable rename cleanup does not match original publication')
    else:
        require(g < h <= i, 'mutable exclusive-link temporary cleanup order differs')
    return a, i


def provenance(replay, first_capture):
    """Finite two-credential issuance and one unrenewed guarded lease history."""
    base, objects = replay.original['base'], replay.objects
    credentials_path = base + '/credentials.json'
    credentials = [o for o in objects if getattr(o, 'family', None) == 'credentials-temp']
    require(len(credentials) == 2, 'unexpected credential mutation history')
    credentials.sort(key=lambda o: o.creation_entry)
    final = parse(replay.paths[credentials_path].data)
    closed_fields(final, 'version credentials', 'credential file')
    for credential in final['credentials']:
        closed_fields(credential, 'id principal secretSha256 permissions scope createdAt', 'source-issued credential')
    actors = designated_credentials(final['credentials'])
    expected = [{'version': 1, 'credentials': [actors['controlled-test-operator']]}, final]
    for i, obj in enumerate(credentials):
        require(type(obj.creation_path) is str and re.fullmatch(re.escape(credentials_path) + r'\.' +
                str(replay.leader) + r'\.[0-9a-f]{8}\.tmp', obj.creation_path), 'wrong original credential temporary')
        _, end = writer(replay, obj, credentials_path, 'credentials-temp', stat.S_IFREG | 0o600, 'rename')
        require(end < replay.resources[0].creation_entry < first_capture and same_json(parse(obj.data), expected[i]) and
                obj.names == (set() if i == 0 else {credentials_path}), 'credential issuance bytes/order/lineage differ')
    require(credentials[1] is replay.paths[credentials_path] and
            credentials[0].publication_completion < credentials[1].creation_entry,
            'current credentials do not descend from original operator issuance')
    lease_path = base + '/workspace/.orca/leases/run%3Acontrolled.json'
    leases = [o for o in objects if getattr(o, 'family', None) == 'lease-temp']
    require(len(leases) == 1 and leases[0] is replay.paths[lease_path], 'unexpected lease replacement/renewal history')
    lease = leases[0]
    closed_fields(parse(lease.data), 'resource holder pid host acquiredAt renewedAt ttlMs guardedTtlMs guardedHost guardedId',
                  'source-issued guarded lease')
    require(type(lease.creation_path) is str and re.fullmatch(re.escape(lease_path) + r'\.' + str(replay.leader) +
            r'\.[a-z0-9]{1,32}\.tmp', lease.creation_path) and lease.names == {lease_path}, 'wrong original lease temporary/lineage')
    _, lease_end = writer(replay, lease, lease_path, 'lease-temp', stat.S_IFREG | (0o666 & ~replay.umask), 'link')
    require(lease_end < credentials[0].creation_entry < first_capture,
            'original guarded lease does not precede credential/capture provenance')
    return actors, credentials, lease


def sidecar_cycles(replay):
    """Exact physical strict-policy lock/token/writer histories, with no takeover."""
    path = replay.original['base'] + '/workspace/orca.permissions.json'
    lock = path + '.lock'
    temporary = path + '.' + str(replay.leader) + '.tmp'
    writers = [o for o in replay.objects if getattr(o, 'family', None) == 'sidecar-temp']
    directories = [o for o in replay.objects if getattr(o, 'family', None) == 'lock-directory' and o.creation_path == lock]
    tokens = [o for o in replay.objects if getattr(o, 'family', None) == 'lock-token' and type(o.creation_path) is str and
              o.creation_path.startswith(lock + '/')]
    require(len(writers) == len(directories) == len(tokens) == 2, 'missing/extra strict sidecar mutation cycle')
    for values in (writers, directories, tokens):
        values.sort(key=lambda o: o.creation_entry)
    physicals = []
    for i, (obj, directory, token) in enumerate(zip(writers, directories, tokens)):
        require(obj.creation_path == temporary and obj.names == (set() if i == 0 else {path}),
                'sidecar temporary/final physical lineage differs')
        start, end = writer(replay, obj, path, 'sidecar-temp', stat.S_IFREG | 0o600, 'rename')
        physical(replay, directory, 'lock-directory', stat.S_IFDIR | (0o777 & ~replay.umask))
        physical(replay, token, 'lock-token', stat.S_IFREG | (0o666 & ~replay.umask))
        require(directory.names == token.names == set() and type(token.writes) is int and token.writes == 1 and
                token.writer_closed is True and
                re.fullmatch(re.escape(lock) + r'/owner\.' + str(replay.leader) + r'\.' + UUID + r'\.json', token.creation_path),
                'strict policy ownership token/path/removal differs')
        value = parse(token.data)
        closed_fields(value, 'version pid nonce', 'strict policy ownership token')
        expected_token = {'version': 1, 'pid': replay.leader, 'nonce': value['nonce']}
        require(same_json(value, expected_token) and type(value['nonce']) is str and re.fullmatch(UUID, value['nonce']) and
                token.data == encoded(expected_token).encode(), 'wrong strict policy ownership token schema/bytes')
        dc, dd, dr, ds = raw_span(replay, directory, 'creation_entry creation_completion removal_entry removal_completion')
        tc, td, tw, te, tf, tr, ts = raw_span(replay, token, 'creation_entry creation_completion last_write_completion '
                                            'writer_close_entry writer_close_completion removal_entry removal_completion')
        require(dc <= dd < tc <= td < tw < te <= tf < start <= end < tr <= ts < dr <= ds,
                'strict policy lock/token/publication/removal causal order differs')
        physicals.extend([obj.physical, directory.physical, token.physical])
    require(len(set(physicals)) == 6 and writers[1] is replay.paths[path] and
            directories[0].removal_completion < directories[1].creation_entry,
            'sidecar cycle physical alias/overlap/current lineage differs')
    return writers, directories, physicals


def authenticate_connected_save(replay, *, standing_v2=False):
    """Authenticate source-designated test Save, never issue a permit or release."""
    authenticate_connected_delivery(replay, standing_v2=standing_v2)
    semantic, events = records(replay, standing_v2=standing_v2)
    baseline = semantic['controlled-baseline-v1'][0][1]
    captures = semantic['controlled-capture-v1']
    a, b, _ = [v[1]['action'] for v in captures]
    actors, credentials, lease = provenance(replay, captures[0][2].creation_entry)
    policies, locks, sidecar_physicals = sidecar_cycles(replay)
    physicals = sidecar_physicals + [o.physical for o in credentials] + [lease.physical]
    require(len(set(physicals)) == len(physicals), 'mutable provenance aliases another physical authority object')
    require(locks[0].removal_completion < lease.creation_entry < semantic['controlled-baseline-v1'][0][2].creation_entry,
            'initial managed policy does not settle before lease/baseline')
    marker = replay.journal_records[2]
    kind, payload, obj = events[marker['executionPayloadRef']]
    require(kind == 'agent.permission', 'wrong authenticated Save marker type')
    approval = payload['entry']
    closed_fields(approval, APPROVAL_FIELDS + (' grantMode reviewUntil standingReview' if standing_v2 else ''),
                  'controlled Save approval')
    actor = baseline['operator']['actor']
    operator, reviewer = actors['controlled-test-operator'], actors['controlled-test-reviewer']
    reviewer_actor = {'principalId': reviewer['principal'], 'credentialId': reviewer['id']}
    facts = {**actor, 'permissions': sorted(operator['permissions']),
             'scope': {'workflows': operator['scope']['workflows'], 'runs': operator['scope']['runs']},
             'expiresAt': operator.get('expiresAt'), 'createdAt': operator['createdAt']}
    proofs = semantic['controlled-persistence-review-v1']
    for i, (ref, proof, proof_obj) in enumerate(proofs):
        action = [a, b][i]
        expected = {'version': 1, 'action': action, 'binding': baseline['binding'], 'actor': actor,
                    'reviewer': {'actor': reviewer_actor, 'credential': {k: v for k, v in reviewer.items() if k != 'secretSha256'}},
                    'lease': baseline['lease'], 'revision': action['authority']['currentPolicyRevision'],
                    'expiresAt': action['expiresAt'], 'plannedInterval': baseline['interval'],
                    'executionReview': {'result': 'unavailable', 'sourceRefs': []}}
        require(type(ref) is str and re.fullmatch(UUID, ref) and same_json(proof, expected),
                'persistence attestation action/scope/revision/reviewer/authority differs')
        in_phase(replay, proof_obj, 'save')
    require(proofs[0][0] != proofs[1][0] and reviewer_actor != actor, 'persistence reviewer/attestation identity reused')
    saved_document = parse(policies[1].data)
    saved = saved_document['scopedRules']['records'][0]
    command = {'rule': saved['rule'], 'expectedRevision': baseline['initialRevision'],
               'approvalRecordRef': encoded(['controlled', marker['payload']['scopedApprovalRef']])}
    # The rule revision and persisted bytes use the owner's construction order,
    # not the key order of an arbitrary parsed final snapshot.
    match = {k: a['invocation'][k] for k in ('principalRef', 'agentId', 'hostId', 'runnerId')}
    match.update(operation=a['operation'], profileRef=a['profileRef'], coverageId=a['coverage']['coverageId'],
        effectiveCwd=a['effectiveCwd']['value'], workspaceRef=a['workspaceRef']['value'],
        resources=[{'operation': a['resources']['value'][0]['operation'],
                    'physicalTargetRef': a['resources']['value'][0]['physicalTargetRef']}], environmentAndCredentialRefs=[])
    rule = command['rule']
    source_rule = {**({'version': 2} if standing_v2 else {}),
                   'ruleId': rule['ruleId'], 'ruleRevision': rule['ruleRevision'], 'status': 'approved',
                   'notBefore': rule['notBefore'], 'expiresAt': None if standing_v2 else a['expiresAt'],
                   'match': match, 'decision': 'allow'}
    require(same_json(rule, source_rule) and rule['ruleRevision'] == digest({k: v for k, v in source_rule.items()
            if k != 'ruleRevision'}), 'saved rule revision is not source construction-order digest')
    standing_fields = {}
    if standing_v2:
        ref, proof, standing_obj = semantic['controlled-standing-review-v2'][0]
        require(type(ref) is str and re.fullmatch(UUID, ref) and ref not in [p[0] for p in proofs],
                'standing review reference reused/invalid')
        reviewed = proof['reviewedAt']
        require(type(reviewed) is int and 0 < reviewed <= 9007199254740991,
                'standing reviewedAt is not an exact safe millisecond integer')
        expected_standing = {'version': 2, 'grantMode': 'until-revoked', 'reviewedAt': reviewed,
            'action': a, 'command': command, 'binding': baseline['binding'], 'actor': actor,
            'reviewer': {'actor': reviewer_actor, 'credential': {k: v for k, v in reviewer.items() if k != 'secretSha256'}},
            'lease': baseline['lease'], 'persistenceReview': {'ref': proofs[0][0], 'value': proofs[0][1]}}
        require(same_json(proof, expected_standing), 'standing review original authority/command/prior proof differs')
        in_phase(replay, standing_obj, 'save')
        prior_end = publication(replay, proofs[0][2])[1]
        require(prior_end < standing_obj.creation_entry and publication(replay, standing_obj)[1] < obj.creation_entry,
                'standing review publication does not precede Save approval after prior proof')
        require(replay.entry_times[prior_end] // MS <= reviewed <= replay.entry_times[standing_obj.creation_entry] // MS and
                iso_ns(rule['notBefore']) <= reviewed * MS <= iso_ns(approval['acceptedAt']) < iso_ns(a['expiresAt']) and
                reviewed * MS < iso_ns(baseline['lease']['renewedAt']) + 60_000_000_000,
                'standing review timestamp outside original source authority interval')
        require(type(approval['reviewUntil']) is int and approval['reviewUntil'] == iso_ns(a['expiresAt']) // MS,
                'standing reviewUntil differs from original finite action expiry')
        standing_fields = {'grantMode': 'until-revoked', 'reviewUntil': approval['reviewUntil'],
                           'standingReview': {'version': 2, 'result': 'passed', 'sourceRefs': [ref]}}
    expected = {'version': 2 if standing_v2 else 1, **standing_fields,
                'choice': 'save', 'requiredReview': 'unavailable',
                'persistenceReview': {'result': 'passed', 'sourceRefs': [proofs[0][0]]},
                'acceptedAt': approval['acceptedAt'], 'credential': facts, 'lease': baseline['lease'],
                'binding': baseline['binding'], 'actor': actor,
                'target': {**HUMAN, 'runId': 'controlled', 'stepRunId': 'controlled-step',
                           'requestId': replay.journal_records[0]['payload']['requestId']},
                'command': command, 'action': a, 'resourceWorkspaceRef': a['workspaceRef']['value'],
                'scopeEvidenceRef': saved['scopeEvidenceRef'], 'authorityRevision': a['authority']['authorityRevision'],
                'scope': {**SCOPE, **({'lifetime': 'Until revoked'} if standing_v2 else {})}, 'projection': {'coverage': a['coverage'],
                    'currentAuthority': {'state': 'unknown', 'reason': 'no-execution-decision'},
                    'expiresAt': {'state': 'complete', 'value': None if standing_v2 else a['expiresAt']},
                    'revocation': {'state': 'complete', 'value': 'active'}}, 'references': [], 'reviewSourceRefs': []}
    require(same_json(approval, expected), 'Save approval action/choice/scope/revision/provenance differs')
    require(digest(facts) == a['authority']['revocationEpoch'] and
            digest([baseline['lease'][k] for k in ('resource', 'holder', 'guardedId', 'acquiredAt', 'pid', 'guardedHost')]) ==
            a['authority']['leaseEpoch'] and digest([baseline['binding'], a['authority']['revocationEpoch'],
            a['authority']['leaseEpoch']]) == a['authority']['authorityRevision'], 'Save authority epochs do not reconstruct')
    expected_record = {'rule': source_rule, 'actor': actor, 'approvalRecordRef': command['approvalRecordRef'],
                       'scopeEvidenceRef': approval['scopeEvidenceRef'], 'authorityRevision': approval['authorityRevision']}
    require(policies[0].data == pretty({'version': 2, 'agents': {}, 'scopedRules': {'version': 1, 'records': []}}) and
            policies[1].data == pretty({'version': 2, 'agents': {}, 'scopedRules': {'version': 1, 'records': [expected_record]}}),
            'actual sidecar bytes are not exact initial-to-approved source publication')
    initial_revision = hashlib.sha256(policies[0].data).hexdigest()
    saved_revision = hashlib.sha256(policies[1].data).hexdigest()
    require(initial_revision == baseline['initialRevision'] == command['expectedRevision'] and
            saved_revision == b['authority']['currentPolicyRevision'] != initial_revision,
            'Save original/current policy revision transition differs')
    require(type(approval['acceptedAt']) is str, 'Save acceptance time is not a string')
    accepted = iso_ns(approval['acceptedAt'])
    require(replay.original['startedWallNs'] <= iso_ns(saved['rule']['notBefore']) <= accepted <=
            replay.entry_times[obj.creation_entry] and accepted < iso_ns(a['expiresAt']) and
            accepted < iso_ns(baseline['lease']['renewedAt']) + 60_000_000_000,
            'Save acceptance outside original authority/rule/lease currency')
    require(publication(replay, captures[0][2])[1] < proofs[0][2].creation_entry and
            publication(replay, proofs[0][2])[1] < obj.creation_entry and
            replay.journal_closes[2] < locks[1].creation_entry and
            replay.journal_closes[2] < policies[1].creation_entry and
            locks[1].removal_completion < proofs[1][2].creation_entry and
            publication(replay, proofs[1][2])[1] < replay.marks[1][4],
            'Save attestation/approval/journal/policy/refresh causal order differs')
    require(replay.designation.check() is None, 'original connected designation assertion returned a flag')
    return {'record': 'authenticated-connected-save-correlations-only', 'authority': 'none',
            'persistenceReview': 'distinct-source-designated-reviewer', 'executionReview': 'unavailable',
            'sidecarPublications': 2, 'saveResourceReads': 0, 'saveAnswers': 0,
            'originalRequireHuman': 'exact-source-evaluation-on-empty-initial-policy',
            'liveDeliveryAuthority': 'unmeasured-exact-source-memory',
            'qualification': 'unavailable-full-connected-effect-audit-and-fresh-evidence-pending'}
