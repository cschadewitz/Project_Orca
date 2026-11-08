"""Replay grammar tests. All journals here are SIMULATED (journal_fixture.py)."""
import copy
import json
import unittest

import journal_fixture as fx
from bounds import OWNER_NS, RUN_NS
from journal import replay_and_count, require_lane_counts
from reasons import Refusal


def run(prod, obs, expected=None):
    return require_lane_counts(replay_and_count(fx.encode(prod), fx.encode(obs), expected or fx.expected()))


def find(rows, kind, phase=None):
    return next(r for r in rows if r['kind'] == kind and (phase is None or r.get('phase') == phase))


class JournalTests(unittest.TestCase):
    def refuses(self, code, prod=None, obs=None, expected=None, raw=None):
        p, o = fx.records()
        prod = p if prod is None else prod
        obs = o if obs is None else obs
        with self.assertRaises(Refusal) as caught:
            if raw is not None:
                require_lane_counts(replay_and_count(raw[0], raw[1], expected or fx.expected()))
            else:
                run(prod, obs, expected)
        self.assertEqual(caught.exception.code, code)

    def mutate(self, code, change, observer=False):
        prod, obs = fx.records()
        change(obs if observer else prod)
        self.refuses(code, prod, obs)

    def test_simulated_positive_counts_are_separate_facts(self):
        prod, obs = fx.records()
        facts = replay_and_count(fx.encode(prod), fx.encode(obs), fx.expected())
        self.assertEqual(run(prod, obs)['save'], 0)
        self.assertEqual((facts['human-read']['answersRecorded'], facts['human-read']['nativeDeliveries'],
                          facts['human-read']['executionsStarted'], facts['human-read']['executionsCompleted'],
                          facts['human-read']['effectsObserved']), (1, 1, 1, 1, 1))
        self.assertEqual((facts['rule-read']['answersRecorded'], facts['rule-read']['ruleId'],
                          facts['rule-read']['revision']), (0, 'rule-1', 2))
        self.assertEqual(facts['save']['targetReads'] + facts['save']['executionsStarted'], 0)

    def test_changed_execution_inputs_refuse(self):
        for field in ('argsSha256', 'stdinSha256', 'envSha256', 'cwdSha256', 'resourceSha256',
                      'preimageSha256', 'actionSha256'):
            for phase in ('human-read', 'rule-read'):
                with self.subTest(field=field, phase=phase):
                    self.mutate('journal_input_changed', lambda p, f=field, ph=phase:
                                find(p, 'invocation.created', ph).__setitem__(f, fx.h('x')))

    def test_dispatch_of_different_action_refuses(self):
        self.mutate('journal_input_changed',
                    lambda p: find(p, 'dispatch.started', 'rule-read').__setitem__('actionSha256', fx.h('y')))

    def test_unknown_codec_and_ambiguous_inputs_refuse(self):
        self.mutate('journal_input_changed',
                    lambda p: find(p, 'invocation.created', 'human-read').__setitem__('codecVersion', 2))
        exp = fx.expected()
        exp['codec'] = 'shell-text'
        self.refuses('journal_field', expected=exp)
        self.mutate('journal_field',
                    lambda p: find(p, 'invocation.created', 'human-read').__setitem__('argsSha256', None))

    def test_save_side_effects_refuse(self):
        prod, obs = fx.records()
        saved = find(prod, 'rule.saved')
        obs.insert(1, dict(kind='effect.observed', op='read', resourceSha256=fx.h('r'),
                           contentSha256=fx.h('c'), t=saved['t'], seq=0))
        obs[0]['t'] = 0
        obs[-1]['records'] += 1
        self.refuses('journal_effect_unattributed', prod, fx.renumber(obs))
        for kind in ('callback.requested', 'answer.recorded', 'native.delivered', 'dispatch.started',
                     'invocation.created'):
            with self.subTest(kind=kind):
                prod, obs = fx.records()
                extra = copy.deepcopy(find(prod, kind, 'human-read'))
                extra['phase'] = 'save'
                prod.insert(prod.index(saved := find(prod, 'rule.saved')) + 1, extra)
                extra['t'] = saved['t']
                self.refuses('journal_order', fx.renumber(prod), obs)

    def test_allow_once_cannot_be_substituted(self):
        self.mutate('journal_attribution',
                    lambda p: find(p, 'answer.recorded').__setitem__('answer', 'allow_always'))
        self.mutate('journal_attribution',
                    lambda p: find(p, 'native.delivered').__setitem__('option', 'allow_always'))

        def remembered(p):
            find(p, 'policy.evaluated', 'human-read').update(verdict='allow', ruleId='rule-1', revision=2)
        self.mutate('journal_attribution', remembered)

        def rule_permit(p):
            find(p, 'permit.issued', 'human-read').update(decision='rule', ruleId='rule-1', revision=2)
        self.mutate('journal_attribution', rule_permit)

    def test_fresh_rule_requires_current_rule_and_no_human_confirmation(self):
        self.mutate('journal_attribution',
                    lambda p: find(p, 'policy.evaluated', 'rule-read').__setitem__('revision', 1))
        self.mutate('journal_attribution',
                    lambda p: find(p, 'permit.issued', 'rule-read').__setitem__('ruleId', 'rule-other'))
        self.mutate('journal_attribution',
                    lambda p: find(p, 'policy.evaluated', 'rule-read').__setitem__('policyRevision', 3))
        prod, obs = fx.records()
        extra = copy.deepcopy(find(prod, 'callback.requested'))
        extra.update(phase='rule-read', invocationId='inv-b', callbackId='cb-b')
        anchor = find(prod, 'policy.evaluated', 'rule-read')
        extra['t'] = anchor['t']
        prod.insert(prod.index(anchor) + 1, extra)
        self.refuses('journal_order', fx.renumber(prod), obs)

    def test_cross_invocation_and_duplicate_identities_refuse(self):
        self.mutate('journal_duplicate',
                    lambda p: find(p, 'invocation.created', 'rule-read').__setitem__('invocationId', 'inv-a')
                    or [r.__setitem__('invocationId', 'inv-a') for r in p if r.get('invocationId') == 'inv-b'])
        self.mutate('journal_duplicate',
                    lambda p: find(p, 'invocation.created', 'rule-read').__setitem__('turnId', 'turn-a'))
        self.mutate('journal_attribution',
                    lambda p: find(p, 'permit.consumed', 'rule-read').__setitem__('permitId', 'permit-a'))
        self.mutate('journal_attribution',
                    lambda p: find(p, 'dispatch.started', 'rule-read').__setitem__('invocationId', 'inv-a'))
        self.mutate('journal_duplicate',
                    lambda p: [r.__setitem__('permitId', 'permit-a') for r in p if r.get('permitId') == 'permit-b'])

    def test_replay_and_concurrent_duplicates_refuse(self):
        prod, obs = fx.records()
        dup = copy.deepcopy(find(prod, 'dispatch.started', 'human-read'))
        prod.insert(prod.index(find(prod, 'dispatch.completed', 'human-read')), dup)
        self.refuses('journal_count', fx.renumber(prod), obs)
        prod, obs = fx.records()
        extra = copy.deepcopy(obs[1])
        obs.insert(2, extra)
        obs[-1]['records'] += 1
        self.refuses('journal_count', prod, fx.renumber(obs))

    def test_late_and_lost_acknowledgements_refuse(self):
        prod, obs = fx.records()
        ack = find(prod, 'callback.acknowledged')
        prod.remove(ack)
        self.refuses('journal_count', fx.renumber(prod), obs)
        prod, obs = fx.records()
        ack, delivered = find(prod, 'callback.acknowledged'), find(prod, 'native.delivered')
        i, j = prod.index(ack), prod.index(delivered)
        prod[i], prod[j] = prod[j], prod[i]
        prod[i]['t'], prod[j]['t'] = prod[j]['t'], prod[i]['t']
        self.refuses('journal_count', fx.renumber(prod), obs)
        self.mutate('journal_attribution',
                    lambda p: find(p, 'callback.acknowledged').__setitem__('callbackId', 'cb-z'))

    def test_authority_checks_are_required_at_each_boundary(self):
        for kind, boundary, phase in (('authority.checked', 'pre-dispatch', 'rule-read'),
                                      ('authority.checked', 'phase', 'human-read'),
                                      ('authority.checked', 'final', 'session')):
            with self.subTest(boundary=boundary):
                prod, obs = fx.records()
                prod.remove(next(r for r in prod if r['kind'] == kind and r['boundary'] == boundary
                                 and r['phase'] == phase))
                with self.assertRaises(Refusal):
                    run(fx.renumber(prod), obs)
        for boundary in ('phase', 'pre-dispatch', 'final'):
            self.mutate('journal_attribution', lambda p, b=boundary: next(
                r for r in p if r['kind'] == 'authority.checked' and r['boundary'] == b
            ).__setitem__('statementSha256', fx.h('forged')))
        self.mutate('journal_field',
                    lambda p: find(p, 'authority.checked', 'rule-read').__setitem__('result', 'revoked'))
        self.mutate('journal_attribution',
                    lambda p: find(p, 'session.start').__setitem__('authorityStatementSha256', fx.h('copied')))

    def test_trace_incompleteness_and_grammar_refuse(self):
        self.mutate('journal_unknown_kind', lambda p: find(p, 'rule.saved').__setitem__('kind', 'rule.saved.v2'))
        self.mutate('journal_field', lambda p: find(p, 'rule.saved').__setitem__('extra', 1))
        self.mutate('journal_field', lambda p: find(p, 'rule.saved').pop('reviewerSha256'))
        self.mutate('journal_order', lambda p: p[3].__setitem__('seq', 7))
        self.mutate('journal_timing', lambda p: p[5].__setitem__('t', 0))
        self.mutate('journal_incomplete', lambda o: o.pop(), observer=True)
        self.mutate('journal_incomplete', lambda o: o[-1].__setitem__('records', 99), observer=True)
        self.mutate('journal_attribution', lambda o: o[0].__setitem__('identitySha256', fx.h('other')),
                    observer=True)
        prod, obs = fx.records()
        self.refuses('journal_incomplete', prod[:-1], obs)
        raw = fx.encode(prod)
        self.refuses('journal_incomplete', raw=(raw[:-1], fx.encode(obs)))
        self.refuses('journal_malformed', raw=(raw.replace(b'"t": 1000', b'"t": 1000.0', 1), fx.encode(obs)))
        self.refuses('journal_duplicate', raw=(raw.replace(b'{"authority', b'{"seq": 0, "authority', 1),
                                               fx.encode(obs)))
        self.refuses('journal_malformed', raw=(b'\xff\n', fx.encode(obs)))
        self.refuses('journal_oversize', raw=(b'{}' * 3000 + b'\n', fx.encode(obs)))
        self.refuses('journal_oversize', raw=(b'\n' * 5000, fx.encode(obs)))

    def test_unexpected_or_mismatched_effects_refuse(self):
        self.mutate('journal_unexpected_mutation', lambda o: o[1].__setitem__('op', 'write'), observer=True)
        self.mutate('journal_effect_mismatch', lambda o: o[1].__setitem__('resourceSha256', fx.h('other')),
                    observer=True)
        self.mutate('journal_effect_mismatch', lambda o: o[2].__setitem__('contentSha256', fx.h('changed')),
                    observer=True)
        prod, obs = fx.records()
        del obs[2]
        obs[-1]['records'] -= 1
        self.refuses('journal_count', prod, fx.renumber(obs))

    def test_timing_bounds_are_unchanged(self):
        def stretch(p, amount, start_index):
            for r in p[start_index:]:
                r['t'] += amount
        prod, obs = fx.records()
        stretch(prod, OWNER_NS, prod.index(find(prod, 'dispatch.completed', 'rule-read')))
        obs[-1]['t'] = prod[-1]['t'] + 1
        self.refuses('journal_timing', prod, obs)
        prod, obs = fx.records()
        stretch(prod, RUN_NS, len(prod) - 1)
        obs[-1]['t'] = prod[-1]['t'] + 1
        self.refuses('journal_timing', prod, obs)

    def test_uncertain_settlement_refuses(self):
        self.mutate('journal_settlement', lambda p: p[-1].__setitem__('cleanup', 'uncertain'))
        self.mutate('journal_settlement', lambda p: p[-1].__setitem__('processes', 1))
        self.mutate('journal_settlement', lambda p: p[-1].__setitem__('openResources', 2))

    def test_public_result_is_not_authority(self):
        prod, obs = fx.records()
        result = run(prod, obs)
        self.assertEqual((result['authority'], result['productionEligible']), ('none', False))
        self.assertNotIn('qualified', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
