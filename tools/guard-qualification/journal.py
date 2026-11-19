"""Reviewed grammar for the connected Save / Allow Once / fresh-rule lane.

replay_and_count() consumes the *entire* producer journal, the *entire*
independent observer stream and the *entire* supervisor stream before any count
exists. The observer and supervisor streams must each start no later than the
session start and end no earlier than settlement, and must name the session's
authorization statement. The observer must also be continuous: no two
consecutive observer records (start, effects, liveness records, end) may be
further apart than OBSERVER_MAX_SILENCE_NS. Every producer boundary-check record
must match, in order, a check the supervisor's own verifier performed no later
than the producer recorded it; every recorded human answer must match an answer
the supervisor sent. A producer record alone never establishes a check or
answer. Counting is not exposed
separately, so no aggregate can be computed from a replay it did not perform
(the aggregate cannot assume its own prerequisite). Unknown kinds or fields,
gaps, duplicates, reordering, unattributed effects, missing authority checks,
oversize input or a missing completeness trailer refuse.

The grammar is a proposal for the future exact run. The existing producer
(packages/cli/test/controlled-owned-read-producer-expanded.ts) does not yet emit
this journal; mapping it is an open obligation. Counts produced from any journal
are facts about that journal only. They are not authority, and a synthetic
journal is simulated evidence.

Clock assumption: producer, observer and supervisor timestamps come from the
same CLOCK_MONOTONIC namespace on the same host.

Open gap (refused, not assumed): no reviewed supervisor-side human answer
channel exists, so require_lane_counts() has no non-simulated success path.
"""
import json
import re

from bounds import (JOURNAL_BYTES_LIMIT, JOURNAL_LINE_LIMIT, JOURNAL_RECORD_LIMIT, OBSERVER_MAX_SILENCE_NS,
                    OWNER_NS, RUN_NS)
from reasons import Refusal, require

PHASES = ('save', 'human-read', 'rule-read')
_ID = re.compile(r'[a-z0-9][a-z0-9-]{0,63}')
_HEX64 = re.compile(r'[0-9a-f]{64}')
INPUT_FIELDS = ('actionSha256', 'resourceSha256', 'argsSha256', 'stdinSha256', 'envSha256', 'cwdSha256',
                'preimageSha256')
CODECS = {('orca-owned-read-v1', 1)}


def _id(v):
    return type(v) is str and _ID.fullmatch(v) is not None


def _hex(v):
    return type(v) is str and _HEX64.fullmatch(v) is not None


def _nid(v):
    return v is None or _id(v)


def _rev(v):
    return type(v) is int and 0 < v < 2 ** 31


PRODUCER = {
    'session.start': {'authorityStatementSha256': _hex, 'identitySha256': _hex, 'planSha256': _hex},
    'authority.checked': {'boundary': lambda v: v in ('pre-dispatch', 'phase', 'final'),
                          'statementSha256': _hex, 'invocationId': _nid, 'result': lambda v: v == 'current'},
    'phase.begin': {}, 'phase.end': {},
    'rule.saved': {'ruleId': _id, 'revision': _rev, 'ruleSha256': _hex, 'reviewerSha256': _hex},
    'invocation.created': dict({k: _hex for k in INPUT_FIELDS}, invocationId=_id, turnId=_id,
                               codec=lambda v: type(v) is str, codecVersion=lambda v: type(v) is int),
    'policy.evaluated': {'invocationId': _id,
                         'verdict': lambda v: v in ('allow', 'deny', 'require-human', 'indeterminate'),
                         'ruleId': _nid, 'revision': lambda v: v is None or _rev(v), 'policyRevision': _rev},
    'callback.requested': {'invocationId': _id, 'callbackId': _id},
    'answer.recorded': {'invocationId': _id, 'callbackId': _id, 'answer': lambda v: type(v) is str,
                        'answerEventId': _id},
    'callback.acknowledged': {'invocationId': _id, 'callbackId': _id},
    'native.delivered': {'invocationId': _id, 'callbackId': _id, 'option': lambda v: type(v) is str},
    'permit.issued': {'invocationId': _id, 'permitId': _id, 'decision': lambda v: v in ('human-once', 'rule'),
                      'ruleId': _nid, 'revision': lambda v: v is None or _rev(v)},
    'permit.consumed': {'invocationId': _id, 'permitId': _id},
    'dispatch.started': {'invocationId': _id, 'permitId': _id, 'actionSha256': _hex},
    'dispatch.completed': {'invocationId': _id, 'permitId': _id, 'resultSha256': _hex},
    'session.settled': {'processes': lambda v: type(v) is int, 'openResources': lambda v: type(v) is int,
                        'cleanup': lambda v: v in ('complete', 'uncertain')},
}
OBSERVER = {
    'observer.start': {'identitySha256': _hex, 'authorityStatementSha256': _hex},
    'effect.observed': {'op': lambda v: v in ('read', 'write', 'exec', 'connect', 'unlink', 'mkdir', 'rename',
                                              'chmod', 'link'),
                        'resourceSha256': _hex, 'contentSha256': _hex},
    # Liveness: the observer emits at least one record per OBSERVER_MAX_SILENCE_NS while tracing.
    'observer.alive': {'tracing': lambda v: v is True},
    'observer.end': {'complete': lambda v: v is True, 'records': lambda v: type(v) is int},
}
SUPERVISOR = {
    'supervisor.start': {'authorityStatementSha256': _hex},
    'authority.checked': {'boundary': lambda v: v in ('pre-dispatch', 'phase', 'final'),
                          'phase': lambda v: v in ('session',) + PHASES, 'invocationId': _nid,
                          'statementSha256': _hex},
    'human.answer.sent': {'callbackId': _id, 'answer': lambda v: type(v) is str},
    'supervisor.end': {'records': lambda v: type(v) is int},
}

# Exact per-invocation order for each phase. Save has no invocation at all.
HUMAN_ORDER = ('invocation.created', 'policy.evaluated', 'callback.requested', 'answer.recorded',
               'callback.acknowledged', 'native.delivered', 'permit.issued', 'authority.checked',
               'permit.consumed', 'dispatch.started', 'dispatch.completed')
RULE_ORDER = ('invocation.created', 'policy.evaluated', 'permit.issued', 'authority.checked',
              'permit.consumed', 'dispatch.started', 'dispatch.completed')
PHASE_KINDS = {'save': frozenset(('rule.saved',)), 'human-read': frozenset(HUMAN_ORDER),
               'rule-read': frozenset(RULE_ORDER)}


def _parse(data, grammar, phase_field):
    require(type(data) is bytes, 'journal_malformed')
    require(len(data) <= JOURNAL_BYTES_LIMIT, 'journal_oversize')
    require(data.endswith(b'\n') or not data, 'journal_incomplete')
    lines = data.split(b'\n')[:-1]
    require(len(lines) <= JOURNAL_RECORD_LIMIT, 'journal_oversize')
    records = []
    for index, line in enumerate(lines):
        require(len(line) <= JOURNAL_LINE_LIMIT, 'journal_oversize')
        try:
            record = json.loads(line.decode('ascii'), object_pairs_hook=_unique, parse_float=_no_float,
                                parse_constant=_no_float)
        except (UnicodeDecodeError, ValueError):
            raise Refusal('journal_malformed') from None
        require(type(record) is dict, 'journal_malformed')
        kind = record.get('kind')
        require(kind in grammar, 'journal_unknown_kind')
        base = {'seq', 't', 'kind'} | ({'phase'} if phase_field else set())
        require(set(record) == base | set(grammar[kind]), 'journal_field')
        require(record['seq'] == index and type(record['seq']) is int, 'journal_order')
        require(type(record['t']) is int and 0 <= record['t'] < 2 ** 63, 'journal_field')
        require(not records or record['t'] >= records[-1]['t'], 'journal_timing')
        if phase_field:
            require(record['phase'] in ('session',) + PHASES, 'journal_field')
        for field, check in grammar[kind].items():
            require(check(record[field]), 'journal_field')
        records.append(record)
    return records


def _unique(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise Refusal('journal_duplicate')
    return dict(pairs)


def _no_float(_value):
    raise Refusal('journal_malformed')


def _validate_expected(expected):
    require(type(expected) is dict and set(expected) == {
        'phases', 'ruleId', 'ruleRevision', 'humanRead', 'ruleRead', 'authorityStatementSha256',
        'identitySha256', 'planSha256', 'codec', 'codecVersion'} and expected['phases'] == list(PHASES) and
        (expected['codec'], expected['codecVersion']) in CODECS, 'journal_field')
    for key in ('humanRead', 'ruleRead'):
        require(type(expected[key]) is dict and set(expected[key]) == set(INPUT_FIELDS) and
                all(_hex(v) for v in expected[key].values()), 'journal_field')


def _framed(stream, first, last):
    require(len(stream) >= 2 and stream[0]['kind'] == first and stream[-1]['kind'] == last, 'journal_incomplete')
    require(stream[-1]['records'] == len(stream) and
            all(r['kind'] not in (first, last) for r in stream[1:-1]), 'journal_incomplete')


def replay_and_count(producer_bytes, observer_bytes, supervisor_bytes, expected):
    """Replay all three complete streams and return separate per-phase facts."""
    _validate_expected(expected)
    producer = _parse(producer_bytes, PRODUCER, True)
    observer = _parse(observer_bytes, OBSERVER, False)
    supervisor = _parse(supervisor_bytes, SUPERVISOR, False)

    # Observer completeness: framed by start/end, end declares the exact count.
    require(len(observer) >= 2 and observer[0]['kind'] == 'observer.start' and
            observer[-1]['kind'] == 'observer.end', 'journal_incomplete')
    require(observer[-1]['records'] == len(observer) and
            all(r['kind'] in ('effect.observed', 'observer.alive') for r in observer[1:-1]), 'journal_incomplete')
    # Continuity: no silence longer than the bound anywhere between observer start and end.
    gaps = [b['t'] - a['t'] for a, b in zip(observer, observer[1:], strict=False)]
    require(all(0 <= gap <= OBSERVER_MAX_SILENCE_NS for gap in gaps), 'journal_observer_window')
    effects = [r for r in observer[1:-1] if r['kind'] == 'effect.observed']
    require(observer[0]['identitySha256'] == expected['identitySha256'], 'journal_attribution')
    _framed(supervisor, 'supervisor.start', 'supervisor.end')

    # Producer framing.
    require(len(producer) >= 2 and producer[0]['kind'] == 'session.start' and
            producer[-1]['kind'] == 'session.settled', 'journal_incomplete')
    start = producer[0]
    require(start['phase'] == 'session' and producer[-1]['phase'] == 'session', 'journal_order')
    for key in ('authorityStatementSha256', 'identitySha256', 'planSha256'):
        require(start[key] == expected[key], 'journal_attribution')
    statement = start['authorityStatementSha256']
    settled = producer[-1]
    for stream in (observer, supervisor):
        require(stream[0]['authorityStatementSha256'] == statement, 'journal_attribution')
        # Independent streams must cover the whole session: from before it starts to after settlement.
        require(stream[0]['t'] <= start['t'] and stream[-1]['t'] >= settled['t'], 'journal_observer_window')
    _corroborate(producer, supervisor)
    # Every boundary check (phase, pre-dispatch and final) must name the session's statement.
    for record in producer:
        if record['kind'] == 'authority.checked':
            require(record['statementSha256'] == statement, 'journal_attribution')
    final_check = producer[-2]
    require(final_check['kind'] == 'authority.checked' and final_check['boundary'] == 'final' and
            final_check['phase'] == 'session' and final_check['invocationId'] is None,
            'journal_authority_check_missing')
    require(settled['processes'] == 0 and settled['openResources'] == 0 and settled['cleanup'] == 'complete',
            'journal_settlement')

    facts = {}
    ids = {'invocationId': set(), 'turnId': set(), 'callbackId': set(), 'permitId': set(), 'answerEventId': set()}
    windows = []
    saved = None
    cursor = 1
    for phase in PHASES:
        body, cursor = _phase_slice(producer, cursor, phase)
        if phase == 'save':
            require([r['kind'] for r in body] == ['rule.saved'], 'journal_count')
            saved = body[0]
            require(saved['ruleId'] == expected['ruleId'] and saved['revision'] == expected['ruleRevision'],
                    'journal_attribution')
            facts['save'] = dict(_phase_window(producer, phase), invocations=0)
            continue
        order = HUMAN_ORDER if phase == 'human-read' else RULE_ORDER
        require(tuple(r['kind'] for r in body) == order, 'journal_count')
        inv = body[0]
        inputs = expected['humanRead' if phase == 'human-read' else 'ruleRead']
        require(all(inv[k] == inputs[k] for k in INPUT_FIELDS), 'journal_input_changed')
        require((inv['codec'], inv['codecVersion']) == (expected['codec'], expected['codecVersion']),
                'journal_input_changed')
        for record in body:
            require(record.get('invocationId', inv['invocationId']) == inv['invocationId'], 'journal_attribution')
            for key in ('callbackId', 'permitId'):
                if key in record and record['kind'] in ('callback.requested', 'permit.issued'):
                    require(record[key] not in ids[key], 'journal_duplicate')
                    ids[key].add(record[key])
        for key in ('invocationId', 'turnId'):
            require(inv[key] not in ids[key], 'journal_duplicate')
            ids[key].add(inv[key])
        by = {r['kind']: r for r in body}
        policy, permit = by['policy.evaluated'], by['permit.issued']
        check = by['authority.checked']
        require(check['boundary'] == 'pre-dispatch' and check['invocationId'] == inv['invocationId'],
                'journal_authority_check_missing')
        require(policy['policyRevision'] == saved['revision'], 'journal_attribution')
        if phase == 'human-read':
            cb = by['callback.requested']['callbackId']
            answer = by['answer.recorded']
            require(all(by[k]['callbackId'] == cb for k in
                        ('answer.recorded', 'callback.acknowledged', 'native.delivered')), 'journal_attribution')
            require(answer['answerEventId'] not in ids['answerEventId'], 'journal_duplicate')
            ids['answerEventId'].add(answer['answerEventId'])
            require(policy['verdict'] == 'require-human' and policy['ruleId'] is None and
                    policy['revision'] is None, 'journal_attribution')
            require(answer['answer'] == 'allow_once' and by['native.delivered']['option'] == 'allow_once',
                    'journal_attribution')
            require(permit['decision'] == 'human-once' and permit['ruleId'] is None and
                    permit['revision'] is None, 'journal_attribution')
        else:
            require(policy['verdict'] == 'allow' and policy['ruleId'] == saved['ruleId'] and
                    policy['revision'] == saved['revision'], 'journal_attribution')
            require(permit['decision'] == 'rule' and permit['ruleId'] == saved['ruleId'] and
                    permit['revision'] == saved['revision'], 'journal_attribution')
        pid = permit['permitId']
        require(by['permit.consumed']['permitId'] == pid and by['dispatch.started']['permitId'] == pid and
                by['dispatch.completed']['permitId'] == pid, 'journal_attribution')
        require(by['dispatch.started']['actionSha256'] == inv['actionSha256'], 'journal_input_changed')
        started, completed = by['dispatch.started'], by['dispatch.completed']
        require(completed['t'] - start['t'] <= OWNER_NS, 'journal_timing')
        windows.append((phase, started['t'], completed['t'], inv))
        facts[phase] = {'invocationId': inv['invocationId'], 'turnId': inv['turnId'],
                        'decision': permit['decision'], 'ruleId': permit['ruleId'], 'revision': permit['revision'],
                        'answersRecorded': int('answer.recorded' in by),
                        'nativeDeliveries': int('native.delivered' in by),
                        'executionsStarted': 1, 'executionsCompleted': 1, 'effectsObserved': 0, 'targetReads': 0}
    require(cursor == len(producer) - 2, 'journal_order')
    require(producer[-1]['t'] - start['t'] <= RUN_NS, 'journal_timing')
    require(facts['human-read']['turnId'] != facts['rule-read']['turnId'], 'journal_attribution')

    # Attribute every observed effect to exactly one dispatch window.
    for effect in effects:
        require(effect['op'] == 'read', 'journal_unexpected_mutation')
        owners = [w for w in windows if w[1] <= effect['t'] <= w[2]]
        require(len(owners) == 1, 'journal_effect_unattributed')
        phase, _, _, inv = owners[0]
        require(effect['resourceSha256'] == inv['resourceSha256'] and
                effect['contentSha256'] == inv['preimageSha256'], 'journal_effect_mismatch')
        facts[phase]['effectsObserved'] += 1
        facts[phase]['targetReads'] += 1
    save_window = facts['save']
    save_effects = [e for e in effects if save_window['begin'] <= e['t'] <= save_window['end']]
    facts['save'].update(answersRecorded=0, nativeDeliveries=0, executionsStarted=0, executionsCompleted=0,
                         effectsObserved=len(save_effects), targetReads=len(save_effects))
    return facts


def _corroborate(producer, supervisor):
    """Producer checks and answers must equal, in order, what the supervisor itself did."""
    prod_checks = [r for r in producer if r['kind'] == 'authority.checked']
    sup_checks = [r for r in supervisor if r['kind'] == 'authority.checked']
    require(len(prod_checks) == len(sup_checks), 'journal_authority_check_missing')
    for p, s in zip(prod_checks, sup_checks, strict=True):
        require((p['boundary'], p['phase'], p['invocationId'], p['statementSha256']) ==
                (s['boundary'], s['phase'], s['invocationId'], s['statementSha256']) and s['t'] <= p['t'],
                'journal_authority_check_missing')
    answers = [r for r in producer if r['kind'] == 'answer.recorded']
    sent = [r for r in supervisor if r['kind'] == 'human.answer.sent']
    require(len(answers) == len(sent), 'journal_attribution')
    for p, s in zip(answers, sent, strict=True):
        require((p['callbackId'], p['answer']) == (s['callbackId'], s['answer']) and s['t'] <= p['t'],
                'journal_attribution')


def _phase_slice(producer, cursor, phase):
    require(cursor < len(producer) and producer[cursor]['kind'] == 'phase.begin' and
            producer[cursor]['phase'] == phase, 'journal_order')
    check = producer[cursor + 1] if cursor + 1 < len(producer) else None
    require(check is not None and check['kind'] == 'authority.checked' and check['boundary'] == 'phase' and
            check['invocationId'] is None and check['phase'] == phase, 'journal_authority_check_missing')
    end = cursor + 2
    while end < len(producer) and producer[end]['kind'] != 'phase.end':
        require(producer[end]['phase'] == phase and producer[end]['kind'] in PHASE_KINDS[phase],
                'journal_order')
        end += 1
    require(end < len(producer) and producer[end]['phase'] == phase, 'journal_incomplete')
    return producer[cursor + 2:end], end + 1


def _phase_window(producer, phase):
    begin = next(r['t'] for r in producer if r['kind'] == 'phase.begin' and r['phase'] == phase)
    end = next(r['t'] for r in producer if r['kind'] == 'phase.end' and r['phase'] == phase)
    return {'begin': begin, 'end': end}


def require_lane_counts(facts, *, simulated=False):
    """The three separate required results, each checked independently.

    Only simulated evaluation exists: an observed result would need a reviewed
    supervisor-side human answer channel and authenticated stream custody, which
    are not implemented, so any other call refuses.
    """
    require(simulated is True, 'prerequisite_missing')
    save, once, fresh = facts['save'], facts['human-read'], facts['rule-read']
    require(save['invocations'] == 0 and save['targetReads'] == 0 and save['executionsStarted'] == 0 and
            save['executionsCompleted'] == 0 and save['answersRecorded'] == 0 and
            save['nativeDeliveries'] == 0 and save['effectsObserved'] == 0, 'journal_count')
    require(once['decision'] == 'human-once' and once['answersRecorded'] == 1 and once['nativeDeliveries'] == 1
            and once['executionsStarted'] == 1 and once['executionsCompleted'] == 1 and
            once['effectsObserved'] == 1 and once['targetReads'] == 1, 'journal_count')
    require(fresh['decision'] == 'rule' and fresh['ruleId'] is not None and fresh['answersRecorded'] == 0 and
            fresh['nativeDeliveries'] == 0 and fresh['executionsStarted'] == 1 and
            fresh['executionsCompleted'] == 1 and fresh['effectsObserved'] == 1 and fresh['targetReads'] == 1 and
            fresh['invocationId'] != once['invocationId'], 'journal_count')
    return {'save': 0, 'allowOnce': 1, 'freshRule': 1, 'evidenceClass': 'simulated', 'authority': 'none',
            'productionEligible': False}
