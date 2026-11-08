"""Synthetic journal builder for tests. Everything it produces is SIMULATED."""
import hashlib
import json

from journal import INPUT_FIELDS


def h(label):
    return hashlib.sha256(label.encode()).hexdigest()


def inputs(prefix):
    return {k: h(prefix + ':' + k) for k in INPUT_FIELDS}


def expected():
    return {'phases': ['save', 'human-read', 'rule-read'], 'ruleId': 'rule-1', 'ruleRevision': 2,
            'humanRead': inputs('human'), 'ruleRead': inputs('rule'), 'authorityStatementSha256': h('statement'),
            'identitySha256': h('identity'), 'planSha256': h('plan'), 'codec': 'orca-owned-read-v1',
            'codecVersion': 1}


def records():
    """Return (producer records, observer records) for a valid simulated run."""
    e = expected()
    st = e['authorityStatementSha256']
    prod = [dict(kind='session.start', phase='session', authorityStatementSha256=st,
                 identitySha256=e['identitySha256'], planSha256=e['planSha256'])]

    def phase_check(phase):
        return dict(kind='authority.checked', phase=phase, boundary='phase', statementSha256=st,
                    invocationId=None, result='current')
    prod += [dict(kind='phase.begin', phase='save'), phase_check('save'),
             dict(kind='rule.saved', phase='save', ruleId='rule-1', revision=2, ruleSha256=h('rule'),
                  reviewerSha256=h('reviewer')),
             dict(kind='phase.end', phase='save')]
    for phase, inv, turn, key in (('human-read', 'inv-a', 'turn-a', 'humanRead'),
                                  ('rule-read', 'inv-b', 'turn-b', 'ruleRead')):
        i = e[key]
        prod += [dict(kind='phase.begin', phase=phase), phase_check(phase),
                 dict(kind='invocation.created', phase=phase, invocationId=inv, turnId=turn,
                      codec='orca-owned-read-v1', codecVersion=1, **i)]
        if phase == 'human-read':
            prod += [dict(kind='policy.evaluated', phase=phase, invocationId=inv, verdict='require-human',
                          ruleId=None, revision=None, policyRevision=2),
                     dict(kind='callback.requested', phase=phase, invocationId=inv, callbackId='cb-a'),
                     dict(kind='answer.recorded', phase=phase, invocationId=inv, callbackId='cb-a',
                          answer='allow_once', answerEventId='evt-a'),
                     dict(kind='callback.acknowledged', phase=phase, invocationId=inv, callbackId='cb-a'),
                     dict(kind='native.delivered', phase=phase, invocationId=inv, callbackId='cb-a',
                          option='allow_once'),
                     dict(kind='permit.issued', phase=phase, invocationId=inv, permitId='permit-a',
                          decision='human-once', ruleId=None, revision=None)]
            permit = 'permit-a'
        else:
            prod += [dict(kind='policy.evaluated', phase=phase, invocationId=inv, verdict='allow',
                          ruleId='rule-1', revision=2, policyRevision=2),
                     dict(kind='permit.issued', phase=phase, invocationId=inv, permitId='permit-b',
                          decision='rule', ruleId='rule-1', revision=2)]
            permit = 'permit-b'
        prod += [dict(kind='authority.checked', phase=phase, boundary='pre-dispatch', statementSha256=st,
                      invocationId=inv, result='current'),
                 dict(kind='permit.consumed', phase=phase, invocationId=inv, permitId=permit),
                 dict(kind='dispatch.started', phase=phase, invocationId=inv, permitId=permit,
                      actionSha256=i['actionSha256']),
                 dict(kind='dispatch.completed', phase=phase, invocationId=inv, permitId=permit,
                      resultSha256=h('result-' + inv)),
                 dict(kind='phase.end', phase=phase)]
    prod += [dict(kind='authority.checked', phase='session', boundary='final', statementSha256=st,
                  invocationId=None, result='current'),
             dict(kind='session.settled', phase='session', processes=0, openResources=0, cleanup='complete')]
    for n, r in enumerate(prod):
        r['seq'], r['t'] = n, 1000 + n * 1000
    obs = [dict(kind='observer.start', identitySha256=e['identitySha256'])]
    for inv, key in (('inv-a', 'humanRead'), ('inv-b', 'ruleRead')):
        started = next(r for r in prod if r['kind'] == 'dispatch.started' and r['invocationId'] == inv)
        obs.append(dict(kind='effect.observed', op='read', resourceSha256=e[key]['resourceSha256'],
                        contentSha256=e[key]['preimageSha256'], t=started['t'] + 10))
    obs.append(dict(kind='observer.end', complete=True, records=len(obs) + 1))
    for n, r in enumerate(obs):
        r['seq'] = n
        r.setdefault('t', 500 if n == 0 else prod[-1]['t'] + 1)
    return prod, obs


def encode(rows):
    return b''.join(json.dumps(r, sort_keys=True).encode() + b'\n' for r in rows)


def renumber(rows):
    for n, r in enumerate(rows):
        r['seq'] = n
    return rows
