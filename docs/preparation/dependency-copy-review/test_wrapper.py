"""Synthetic checkpoint tests; no private files, Git, copy or runtime execution."""
import copy
import importlib.util
from pathlib import Path
import time
import unittest

spec = importlib.util.spec_from_file_location('reviewed_wrapper',
    Path(__file__).with_name('copy-once.py'))
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)


def synthetic_policy():
    target = {'workspaceId': 'workspace-fixture', 'instanceId': 'instance-fixture'}
    def page(items):
        return {'target': copy.deepcopy(target), 'items': items,
                'truncated': False, 'restartRequired': False,
                'revision': 'fixture-revision', 'asOf': wrapper.utc()}
    discovery = {'target': copy.deepcopy(target), 'authentication': 'credential',
        'principalId': 'principal-fixture', 'scope': {'runs': 'owned',
            'workflows': ['workflow-fixture'], 'permissions': ['runs.read']},
        'protocol': {'major': 2, 'minor': 0}, 'orcaVersion': 'fixture-version',
        'asOf': wrapper.utc()}
    runs = page([{'id': 'run-fixture', 'runId': 'run-fixture', 'kind': 'run',
        'status': 'waiting', 'workflowVersion': '4', 'workflowId': 'workflow-fixture',
        'workflowRevision': 'sha256:' + 'a' * 64, 'configGeneration': 'generation-fixture'}])
    steps = page([{'id': 'start-fixture', 'nodeId': 'start', 'kind': 'step.completed',
                  'runId': 'run-fixture', 'stepRunId': 'start-step-fixture'},
        {'id': 'gate-fixture', 'nodeId': 'dependencyReady', 'kind': 'step.scheduled',
         'runId': 'run-fixture', 'stepRunId': 'step-fixture'},
        {'id': 'waiting-fixture', 'runId': 'run-fixture',
         'stepRunId': 'step-fixture', 'kind': 'step.waiting'}])
    approvals = page([{'id': 'request-fixture', 'requestId': 'request-fixture',
        'runId': 'run-fixture', 'stepRunId': 'step-fixture', 'kind': 'decision',
        'nodeId': 'dependencyReady', 'options': [{'id': 'stop'}, {'id': 'ready'}]}])
    return {'gate_max_age_seconds': 30,
        'baseline': {'discovery': discovery, 'runs': runs, 'steps': steps, 'approvals': approvals}}


class GateProofTests(unittest.TestCase):
    def setUp(self):
        self.policy = synthetic_policy()
        self.proof = {'nonce': 'synthetic-checkpoint', **copy.deepcopy(self.policy['baseline'])}
        self.issued = time.time() - 1
        for name in ('discovery', 'runs', 'steps', 'approvals'):
            self.proof[name]['asOf'] = wrapper.utc()

    def valid(self):
        wrapper.validate_gate(self.proof, self.policy, 'synthetic-checkpoint', self.issued)

    def rejected(self):
        with self.assertRaises(RuntimeError): self.valid()

    def test_matching_fresh_pending_checkpoint(self): self.valid()
    def test_wrong_nonce(self):
        self.proof['nonce'] = 'wrong'; self.rejected()
    def test_stale(self):
        self.proof['runs']['asOf'] = '2020-01-01T00:00:00Z'; self.rejected()
    def test_pre_checkpoint(self):
        self.issued = time.time() + 10; self.rejected()
    def test_run_not_waiting(self):
        self.proof['runs']['items'][0]['status'] = 'running'; self.rejected()
    def test_gate_gone(self):
        self.proof['approvals']['items'] = []; self.rejected()
    def test_request_changed(self):
        self.proof['approvals']['items'][0]['requestId'] = 'changed'; self.rejected()
    def test_work_step_added(self):
        self.proof['steps']['items'].append({'kind': 'step.started', 'nodeId': 'work'}); self.rejected()
    def test_instance_changed(self):
        self.proof['runs']['target']['instanceId'] = 'changed'; self.rejected()
    def test_principal_changed(self):
        self.proof['discovery']['principalId'] = 'changed'; self.rejected()
    def test_scope_changed(self):
        self.proof['discovery']['scope']['runs'] = 'all'; self.rejected()
    def test_truncated(self):
        self.proof['steps']['truncated'] = True; self.rejected()
    def test_restart_required(self):
        self.proof['runs']['restartRequired'] = True; self.rejected()
    def test_extra_page(self):
        self.proof['approvals']['nextCursor'] = 'more'; self.rejected()
    def test_unknown_proof_field(self):
        self.proof['answer'] = 'ready'; self.rejected()


if __name__ == '__main__': unittest.main(verbosity=2)
