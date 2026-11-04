"""Authenticated connected delivery correlations only; no Save approval or release.

Call after complete ConnectedKernelReplay. Every physical/publication/phase input
comes from the original supervisor and kernel replay, never producer flags. The
diagnostic ack does not recreate live callback/permit authority: that association
still relies on the exact reviewed producer/registry/fence and cooperative memory.
"""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote
import hashlib
import os
import re

from controlled_contract import require
from controlled_connected import HUMAN, JOURNAL_TYPES
from controlled_semantics import (ACTION_FIELDS, UUID, bootstrap_action_schema, closed_fields,
    decode, designated_credentials, digest, encoded, original_authority, parse,
    resource_projection, retained_binding, same_json)
from controlled_timestamps import expiry_bound, iso_ns, resource_entry
from controlled_v2_model import model, expiry_bound as v2_expiry_bound, MS, OWNER_NS

COUNTS = {'controlled-baseline-v1': 1, 'controlled-capture-v1': 3,
          'controlled-persistence-review-v1': 2, 'controlled-authorization-v1': 2,
          'controlled-producer-observation-v1': 2, 'controlled-final-delivery-ack-v1': 1}
FIELDS = {'controlled-baseline-v1': 'version originalAction capturedCeiling binding operator lease initialRevision '
                                  'profileRef installedEvidenceRef interval expiresAt rules',
          'controlled-capture-v1': 'action bytes', 'controlled-authorization-v1': 'action verdict protectedEvidenceRef',
          'controlled-persistence-review-v1': 'version action binding actor reviewer lease revision expiresAt plannedInterval executionReview',
          'controlled-producer-observation-v1': 'actionId authorizationRef',
          'controlled-final-delivery-ack-v1': 'requestId actor'}


def publication(replay, obj):
    entry, durable = obj.creation_entry, obj.durable_publication_completion
    require(obj.physical is not None and obj.published and obj.directory_synced and
            type(entry) is int and type(durable) is int and 0 <= entry <= durable,
            'connected payload lacks physical durable publication')
    for index in (entry, durable):
        require(index in replay.entry_times and type(replay.entry_times[index]) is int and
                replay.original['startedWallNs'] <= replay.entry_times[index] <= replay.original['finishedWallNs'],
                'connected publication lacks original raw-line clock')
    return entry, durable


def in_phase(replay, obj, phase):
    entry, durable = publication(replay, obj)
    index = ['save', 'human-read', 'rule-read'].index(phase) * 2
    require(replay.marks[index][5] < entry <= durable < replay.marks[index + 1][4],
            'connected semantic publication outside required phase')


def records(replay, *, standing_v2=False):
    model(standing_v2)
    counts, fields = dict(COUNTS), dict(FIELDS)
    if standing_v2:
        counts['controlled-standing-review-v2'] = 1
        fields['controlled-standing-review-v2'] = 'version grantMode reviewedAt action command binding actor reviewer lease persistenceReview'
    directory = replay.original['base'] + '/workspace/.orca/private-execution/'
    key = replay.paths[directory + '.execution-key'].data
    require(len(key) == 32, 'wrong original execution key length')
    semantic = {kind: [] for kind in counts}
    events = {}
    count = 0
    for path, obj in replay.paths.items():
        if not (path.startswith(directory) and path.endswith('.payload.json')):
            continue
        count += 1
        require(count <= 128, 'connected protected payload count exceeds bound')
        publication(replay, obj)
        ref = unquote(Path(path).name[:-13])
        value = decode(Path(path).name, obj.data, key)
        closed_fields(value, 'runId type sensitivityRefs payload', 'connected protected envelope')
        require(value['runId'] == 'controlled' and value['sensitivityRefs'] == [], 'wrong connected protected scope')
        payload = value['payload']
        if value['type'] == 'agent.update':
            closed_fields(payload, 'stepRunId sessionId update', 'connected semantic payload')
            require(payload['stepRunId'] == 'controlled-step' and payload['sessionId'] == 'controlled-session',
                    'wrong connected semantic session')
            update = payload['update']
            closed_fields(update, 'kind text', 'connected semantic update')
            require(type(update['text']) is str, 'connected semantic text is not a string')
            text = parse(update['text'])
            closed_fields(text, 'kind value', 'connected semantic text')
            require(type(text['kind']) is str and text['kind'] in counts and update['kind'] == text['kind'],
                    'unknown/mismatched connected semantic kind')
            closed_fields(text['value'], fields[text['kind']], text['kind'])
            semantic[text['kind']].append((ref, text['value'], obj))
        else:
            require(value['type'] in JOURNAL_TYPES and ref not in events, 'unknown/duplicate protected journal type/ref')
            events[ref] = (value['type'], payload, obj)
    require(all(len(semantic[k]) == v for k, v in counts.items()) and len(events) == 4 and count == sum(counts.values()) + 4,
            'missing/duplicate connected protected record inventory')
    for values in semantic.values():
        values.sort(key=lambda v: v[2].creation_entry)
    return semantic, events


def journal(replay, events):
    require(len(replay.journal_records) == len(replay.journal_entries) == len(replay.journal_closes) == 4,
            'missing complete original journal append lineage')
    for i, public in enumerate(replay.journal_records):
        require(type(public['seq']) is int and public['seq'] == i and public['type'] == JOURNAL_TYPES[i],
                'wrong original journal sequence/type')
        require(public['executionPayloadRef'] in events, 'public journal references missing protected bytes')
        kind, payload, obj = events[public['executionPayloadRef']]
        expected = deepcopy(payload)
        if kind == 'agent.permission':
            # Authentication binds these private bytes to the public Save marker.
            # Approval entry contents and persistence authority are a separate gate.
            require(type(expected.pop('entry', None)) is dict, 'Save marker lacks private approval entry')
        require(kind == public['type'] and same_json(expected, public['payload']), 'public/private journal projection differs')
        require(publication(replay, obj)[1] < replay.journal_entries[i] <= replay.journal_closes[i],
                'protected journal publication does not precede append')
        in_phase(replay, obj, 'save' if i < 3 else 'human-read')
    requested, _, _, answered = [v['payload'] for v in replay.journal_records]
    require(requested['liveDecision'] == HUMAN and answered['requestId'] == requested['requestId'] and
            answered['answer'] == 'once', 'original live target/answer differs')
    return requested, answered


def action_schema(replay, action, parameters, evidence_ref):
    closed_fields(action, ACTION_FIELDS, 'connected action')
    require(type(parameters) is list and len(parameters) == 5 and parameters[0] == 'orca-owned-file-read-v1' and
            type(parameters[1]) is str and re.fullmatch('owned-file:' + UUID, parameters[1]) and
            type(parameters[2]) is str and parameters[2].startswith(parameters[1] + ':') and
            type(parameters[3]) is int and type(parameters[4]) is int and
            parameters[3:] == [replay.original['offset'], replay.original['length']], 'wrong connected canonical interval/resource')
    expected = deepcopy(action)
    coverage = action['coverage']
    require(coverage['level'] == 'verified-per-execution' and
            same_json(coverage['evidence']['installedRefs'], [evidence_ref]) and
            coverage['evidence']['independentlyObservedEffects'] is True, 'connected designated coverage differs')
    # Reuse the closed source service schema, changing only the three source-owned
    # coverage fields that distinguish connected from bootstrap. This does not
    # turn the producer's claimed tier into independent acceptance.
    expected['coverage']['level'] = 'policy-per-ask'
    expected['coverage']['evidence']['installedRefs'] = []
    expected['coverage']['evidence']['independentlyObservedEffects'] = False
    bootstrap_action_schema(expected, replay.original, parameters[1])
    require(action['bindingRef'] == 'synthetic-read:' + action['actionId'] + ':action' and
            action['profileRef'] == action['capturedByBoundaryId'] == 'orca-owned-file-read-v1' and
            action['operation'] == 'fs.readOwnedBytes', 'wrong connected action operation/binding')
    physical = parameters[2].removeprefix(parameters[1] + ':').split(':')
    resource = replay.resources[0]
    require(len(physical) == 9 and all(re.fullmatch(r'0|[1-9][0-9]*', p) for p in physical), 'wrong connected physical stamp syntax')
    stamp = tuple(map(int, physical))
    require(stamp in resource.resource_stamps and list(stamp[:7]) ==
            [os.makedev(*resource.physical[:2]), resource.physical[2], resource.mode, resource.uid,
             resource.gid, 0, len(resource.data)], 'connected capture physical stamp differs')
    resource_projection(replay, resource, action, parameters)


def authenticate_connected_delivery(replay, *, standing_v2=False):
    """Necessary correlations, never a callable qualification or delivery proof."""
    model(standing_v2)
    original = replay.original
    require(replay.designation.check() is None, 'original connected designation assertion returned a flag')
    require(original['lane'] == 'connected' and len(replay.marks) == 6 and len(replay.resources) == 1,
            'missing connected kernel phase/resource observation')
    semantic, events = records(replay, standing_v2=standing_v2)
    requested, answered = journal(replay, events)
    baseline = semantic['controlled-baseline-v1'][0][1]
    captures = semantic['controlled-capture-v1']
    in_phase(replay, semantic['controlled-baseline-v1'][0][2], 'save')
    require(publication(replay, semantic['controlled-baseline-v1'][0][2])[1] < captures[0][2].creation_entry,
            'baseline does not settle before original capture')
    for _, _, obj in semantic['controlled-persistence-review-v1']:
        in_phase(replay, obj, 'save')
    actions = [c[1]['action'] for c in captures]
    a, b, c = actions
    require(same_json(baseline['originalAction'], a) and baseline['rules'] == [] and
            type(baseline['version']) is int and baseline['version'] == 1,
            'wrong original empty-rule connected baseline')
    evidence_ref = replay.designation.evidence_ref
    require(baseline['installedEvidenceRef'] == evidence_ref and
            baseline['profileRef'] == 'orca-owned-file-read-v1' and
            same_json(baseline['interval'], {'offset': original['offset'], 'length': original['length']}),
            'wrong connected baseline designation/interval')
    require(len({v['actionId'] for v in actions}) == 3, 'connected captures reuse an action identity')
    for index, (ref, value, obj) in enumerate(captures):
        require(type(value['bytes']) is str, 'connected capture bytes are not a string')
        parameters = parse(value['bytes'])
        require(value['bytes'] == encoded(parameters), 'noncanonical connected capture encoding')
        action_schema(replay, value['action'], parameters, evidence_ref)
        require(ref == 'capture:' + value['action']['bindingRef'], 'connected capture reference differs')
        in_phase(replay, obj, ['save', 'human-read', 'rule-read'][index])
    require(same_json(baseline['capturedCeiling'], {'operation': 'fs.readOwnedBytes', 'profileRef': baseline['profileRef'],
            'resourceRef': parse(captures[0][1]['bytes'])[1], 'maximumInvocations': 2}), 'wrong connected captured ceiling')
    expected_invocation = {**HUMAN, 'runId': 'controlled', 'rootRunId': 'controlled', 'stepRunId': 'controlled-step',
        'attemptId': 'controlled-attempt', 'agentId': 'controlled-agent', 'hostId': 'controlled-local-linux',
        'runnerId': 'controlled-runner', 'principalRef': 'controlled-test-operator'}
    require(same_json(a['invocation'], expected_invocation) and same_json(b['invocation'], expected_invocation) and
            same_json(c['invocation'], {**expected_invocation, 'turnId': 'controlled-rule-turn',
                                      'invocationId': 'controlled-rule-invocation'}), 'wrong original/fresh connected invocation')
    for action in actions[1:]:
        preserved = deepcopy(action)
        keys = ('actionId', 'bindingRef', 'original', 'dispatch', 'authority', 'invocation')
        if standing_v2 and action is c:
            keys += ('expiresAt',)
        for key in keys:
            preserved[key] = a[key]
        require(same_json(preserved, a), 'connected refresh/fresh action widens original scope')

    sidecar_path = original['base'] + '/workspace/orca.permissions.json'
    history = [obj for obj in replay.objects if obj.publication_path == sidecar_path]
    require(len(history) == 2 and replay.paths[sidecar_path] in history, 'missing exact initial/saved sidecar history')
    history.sort(key=lambda o: o.publication_entry)
    initial, saved = history
    require(saved is replay.paths[sidecar_path] and initial.physical is not None and saved.physical is not None and
            initial.physical != saved.physical and initial.names == set() and saved.names == {sidecar_path},
            'wrong initial/saved sidecar physical lineage')
    for obj in history:
        require(obj.publication_method == 'rename' and type(obj.writer_close_completion) is int and
                obj.writer_close_completion < obj.publication_entry <= obj.publication_completion,
                'sidecar writer close/publication order differs')
    require(initial.publication_completion < captures[0][2].creation_entry and
            saved.publication_completion < captures[1][2].creation_entry, 'policy publication follows connected capture')
    view = SimpleNamespace(original=original, paths={**replay.paths, sidecar_path: initial})
    binding = retained_binding(view, baseline, a)
    revision = hashlib.sha256(saved.data).hexdigest()
    require(revision != baseline['initialRevision'] and
            b['authority']['currentPolicyRevision'] == c['authority']['currentPolicyRevision'] == revision,
            'stale connected current sidecar revision')
    current = parse(saved.data)
    closed_fields(current, 'version agents scopedRules', 'saved sidecar')
    closed_fields(current['scopedRules'], 'version records', 'saved scoped rules')
    require(type(current['version']) is int and current['version'] == 2 and current['agents'] == {} and
            type(current['scopedRules']['version']) is int and current['scopedRules']['version'] == 1 and
            len(current['scopedRules']['records']) == 1, 'wrong saved sidecar envelope/count')
    rule_record = current['scopedRules']['records'][0]
    closed_fields(rule_record, 'rule actor approvalRecordRef scopeEvidenceRef authorityRevision', 'saved rule record')
    rule = rule_record['rule']
    closed_fields(rule, ('version ' if standing_v2 else '') +
                  'ruleId ruleRevision status notBefore expiresAt match decision', 'saved rule')
    if standing_v2:
        require(type(rule['version']) is int and rule['version'] == 2 and rule['expiresAt'] is None,
                'saved standing rule version/lifetime differs')
    require(re.fullmatch(UUID, rule['ruleId']) and rule['status'] == 'approved' and rule['decision'] == 'allow' and
            (standing_v2 or rule['expiresAt'] == baseline['expiresAt']) and
            rule['ruleRevision'] == digest({k: v for k, v in rule.items() if k != 'ruleRevision'}),
            'saved rule revoked/invalid revision')
    require(rule_record['approvalRecordRef'] == encoded(['controlled', replay.journal_records[2]['payload']['scopedApprovalRef']]) and
            type(rule_record['scopeEvidenceRef']) is str and re.fullmatch(UUID, rule_record['scopeEvidenceRef']),
            'saved sidecar does not reference original Save marker/scope')
    match = {k: a['invocation'][k] for k in ('principalRef', 'agentId', 'hostId', 'runnerId')}
    match.update(operation=a['operation'], profileRef=a['profileRef'], coverageId=a['coverage']['coverageId'],
        effectiveCwd=a['effectiveCwd']['value'], workspaceRef=a['workspaceRef']['value'],
        resources=a['resources']['value'], environmentAndCredentialRefs=[])
    require(same_json(rule['match'], match), 'saved rule scope differs from original capture')
    credential_file = parse(replay.paths[original['base'] + '/credentials.json'].data)
    require(type(credential_file['version']) is int and credential_file['version'] == 1, 'wrong credential file version')
    actors = designated_credentials(credential_file['credentials'])
    lease = parse(replay.paths[original['base'] + '/workspace/.orca/leases/run%3Acontrolled.json'].data)
    create_ns = resource_entry(replay, replay.resources[0])
    for action, (_, _, obj) in zip(actions, captures):
        # Reuse the original digest/currency predicates with the independently
        # reconstructed revision for this stage. This expected-values view does
        # not rewrite any authenticated baseline/capture bytes or issue authority.
        expected_revision = baseline['initialRevision'] if action is a else revision
        original_authority(replay, {**baseline, 'initialRevision': expected_revision},
            action, binding, actors, lease, [create_ns, replay.entry_times[obj.creation_entry]])
        if standing_v2 and action is c:
            # Fresh Date.now()+55s is after the original rule-phase command and
            # before capture publication. Floor the lower anchor to Date's exact
            # millisecond representation, never add timing slack or owner lifetime.
            phase_entry = replay.marks[4][4]
            require(type(phase_entry) is int and phase_entry in replay.entry_times,
                    'fresh rule expiry lacks original phase anchor')
            phase_ns = replay.entry_times[phase_entry]
            require(type(phase_ns) is int and original['startedWallNs'] <= phase_ns <=
                    replay.entry_times[obj.creation_entry] and
                    iso_ns(action['expiresAt']) >= max(iso_ns(a['expiresAt']), phase_ns // MS * MS + OWNER_NS),
                    'fresh rule expiry predates source issuance interval')
            v2_expiry_bound(original, replay.entry_times[obj.creation_entry], iso_ns(action['expiresAt']))
        else:
            require(action['expiresAt'] == baseline['expiresAt'], 'connected owner expiry changed')
            (v2_expiry_bound if standing_v2 else expiry_bound)(original, create_ns, iso_ns(action['expiresAt']))
    actor = baseline['operator']['actor']
    require(same_json(answered['actor'], actor) and same_json(rule_record['actor'], actor) and
            rule_record['authorityRevision'] == a['authority']['authorityRevision'], 'original actor/authority attribution differs')

    ack_ref, ack, ack_obj = semantic['controlled-final-delivery-ack-v1'][0]
    require(same_json(ack, {'requestId': requested['requestId'], 'actor': actor}), 'final acknowledgement target/actor differs')
    in_phase(replay, ack_obj, 'human-read')
    require(replay.journal_closes[3] < ack_obj.creation_entry and
            publication(replay, ack_obj)[1] < captures[1][2].creation_entry,
            'final ownership acknowledgement not settled before human capture')
    resource = replay.resources[0]
    require(len(resource.effect_entries) == len(resource.reads) == 2 and resource.read_phases == ['human-read', 'rule-read'],
            'duplicate/missing/wrong-phase actual connected effects')
    authorizations = semantic['controlled-authorization-v1']
    observations = semantic['controlled-producer-observation-v1']
    for i, ((ref, value, obj), (obs_ref, observed, obs_obj)) in enumerate(zip(authorizations, observations)):
        action = actions[i + 1]
        authorizer = ({'kind': 'human', 'acceptedAnswerRef': encoded(['controlled', replay.journal_records[3]['id']])}
                      if i == 0 else {'kind': 'rule', 'ruleId': rule['ruleId'], 'ruleRevision': rule['ruleRevision']})
        verdict = {'version': 1, 'actionBindingRef': action['bindingRef'], 'authority': action['authority'],
                   'coverageId': action['coverage']['coverageId'], 'outcome': 'allow', 'authorizedBy': authorizer}
        require(ref == 'synthetic-read:' + action['actionId'] + ':evidence' and
                same_json(value, {'action': action, 'verdict': verdict, 'protectedEvidenceRef': ref}),
                'noncanonical original human/fresh rule authorization')
        require(same_json(observed, {'actionId': action['actionId'], 'authorizationRef': ref}),
                'producer observation authorization correlation differs')
        phase = ['human-read', 'rule-read'][i]
        in_phase(replay, obj, phase)
        in_phase(replay, obs_obj, phase)
        effect = resource.effect_entries[i]
        require(type(effect) is int and effect in replay.entry_times and type(replay.entry_times[effect]) is int and
                original['startedWallNs'] <= replay.entry_times[effect] <= original['finishedWallNs'],
                'actual service effect lacks original raw-line clock')
        require(publication(replay, captures[i + 1][2])[1] < obj.creation_entry and
                publication(replay, obj)[1] < effect < obs_obj.creation_entry and
                replay.marks[(i + 1) * 2][5] < effect < replay.marks[(i + 1) * 2 + 1][4],
                'capture/authorization/effect/observation causal order differs')
        require(iso_ns(rule['notBefore']) <= replay.entry_times[obj.creation_entry] <= original['finishedWallNs'] <
                iso_ns(action['expiresAt'] if standing_v2 else rule['expiresAt']), 'saved rule currency differs')
    require(publication(replay, observations[0][2])[1] < captures[2][2].creation_entry,
            'fresh rule capture precedes original human completion observation')
    require(replay.designation.check() is None, 'original connected designation assertion returned a flag')
    return {'record': 'authenticated-connected-delivery-correlations-only', 'authority': 'none',
            'protectedRecords': 16 if standing_v2 else 15, 'serviceReads': 2, 'liveDeliveryAuthority': 'unmeasured-exact-source-memory',
            'saveAuthority': 'unvalidated-persistence-approval-and-review',
            'qualification': 'unavailable-save-authority-and-full-connected-effect-audit-pending'}
