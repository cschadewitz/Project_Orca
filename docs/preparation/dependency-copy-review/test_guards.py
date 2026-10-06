"""Full executable regressions using fresh synthetic Git worktrees only.

No real contract, credentials, host run, provisioning record or MCP operation.
Fixtures and journals are retained, including every failed/partial invocation.
"""
import copy
import hashlib
import json
import os
import resource
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import copier
from test_wrapper import wrapper, synthetic_policy


class ExecutableGuards(unittest.TestCase):
    def setUp(self):
        self.area = Path(tempfile.mkdtemp(prefix='wrapper-guard-fixture-'))
        self.source, self.dest, self.stage = [self.area / x for x in ('source', 'dest', 'stage')]
        self.source.mkdir(); self.stage.mkdir(mode=0o700)
        self.env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C.UTF-8',
            'NODE_DISABLE_COMPILE_CACHE': '1', 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0',
            'GIT_TERMINAL_PROMPT': '0', 'TMPDIR': str(self.area)}
        self.git('init', '-b', 'fixture-source')
        (self.source / 'pnpm-lock.yaml').write_text('synthetic frozen lock\n')
        (self.source / '.gitignore').write_text('node_modules/\n')
        (self.source / 'packages/widget').mkdir(parents=True)
        (self.source / 'packages/widget/package.json').write_text('{"name":"fixture"}\n')
        self.git('add', '.')
        self.git('-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-m', 'synthetic only')
        self.git('worktree', 'add', '-b', 'fixture-destination', str(self.dest))
        self.head = self.git('rev-parse', 'HEAD')
        self.common = self.git('rev-parse', '--path-format=absolute', '--git-common-dir')
        self.dest_git = self.git('rev-parse', '--absolute-git-dir', root=self.dest)
        (self.source / 'node_modules').mkdir()
        (self.source / 'node_modules/payload').write_bytes(b'fixture payload\x00\xff')
        for name in ('.modules.yaml', '.pnpm-workspace-state-v1.json'):
            (self.source / 'node_modules' / name).write_text('synthetic historical metadata\n')
        self.policy = synthetic_policy()
        self.policy.update(stage=str(self.stage), owner_uid=os.geteuid(),
            git_executable='/usr/bin/git', head=self.head,
            lock_blob=self.git('rev-parse', 'HEAD:pnpm-lock.yaml'),
            source_branch='refs/heads/fixture-source', destination_branch='refs/heads/fixture-destination',
            source_git_dir=self.common, destination_git_dir=self.dest_git, common_dir=self.common,
            checkpoint_timeout_seconds=4, minimum_free_bytes=1)
        for name, path in (('source', self.source), ('destination', self.dest)):
            st = path.stat()
            self.policy[name] = {'path': str(path), 'dev': st.st_dev, 'ino': st.st_ino, 'uid': st.st_uid}
        receipt = {'version': 1, 'runId': 'run-fixture', 'repo': str(self.source),
            'commonDir': self.common, 'baseCommit': self.head,
            'branch': 'fixture-destination', 'path': str(self.dest)}
        self.policy['receipt'] = self.record('original-receipt.json', receipt)
        self.policy['ready'] = self.record('original-ready.json', {'gitDir': self.dest_git})
        self.policy['link_policy'] = {'workspace_packages': ['packages/widget'],
            'workspace_entries': [{'path': 'packages/widget', 'kind': 'directory'},
                {'path': 'packages/widget/package.json', 'kind': 'file',
                 'bytes': (self.source / 'packages/widget/package.json').stat().st_size}]}
        self.policy['memory'] = {'largest_file_bytes': 1024 * 1024,
            'retained_shim_bytes': 0, 'manifest_bytes': 1024 * 1024, 'minimum_available_bytes': 0}
        self.rebuild_contract()

    def git(self, *args, root=None):
        return subprocess.check_output(['/usr/bin/git', '-C', str(root or self.source), *args],
            env=self.env, stderr=subprocess.PIPE).decode().rstrip('\n')

    def record(self, name, data):
        p = self.stage / name
        p.write_text(json.dumps(data)); p.chmod(0o600)
        return {'path': str(p), 'sha256': wrapper.sha(p.read_bytes()), 'content': data}

    def rebuild_contract(self):
        with copier.root(str(self.source)) as fd:
            entries = list(copier.scan(fd, ['node_modules']).values())
        metadata = {e['path']: e['sha256'] for e in entries if e['path'] in
            ('node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json')}
        contract = {'trees': ['node_modules'], 'entries': entries, 'shims': [],
            'shim_count': 0, 'prefix_count': 0, 'metadata': metadata}
        inventory = {'entries': entries, 'summary': {'copy_map': [
            {'source_relative': 'node_modules', 'future_destination_relative': 'node_modules'}]}}
        proposal = {'mappings': [], 'metadata_sha256': list(metadata.values())}
        files = {}
        for name, content in [('contract', contract), ('inventory', inventory), ('proposal', proposal)]:
            r = self.record(name + '.json', content)
            self.policy[name] = r['path']; files[r['path']] = r['sha256']
        for name in ('copier', 'relocation'):
            p = Path(__file__).with_name(name + '.py').resolve()
            self.policy[name] = str(p); files[str(p)] = wrapper.sha(p.read_bytes())
        self.policy['files'] = files
        self.policy['counts'] = {'trees': 1, 'entries': len(entries), 'shims': 0, 'prefixes': 0}

    def invoke(self, address_space_limit=None):
        binding = self.record('binding.json', self.policy)
        command = [sys.executable, '-I', '-S', '-B', str(Path(__file__).with_name('copy-once.py')),
            '--binding-file', binding['path'], '--binding-sha256', binding['sha256'],
            '--execute-once', '--owner-holds-roots-and-gate']
        def limit():
            resource.setrlimit(resource.RLIMIT_AS, (address_space_limit, address_space_limit))
        process = subprocess.Popen(command, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            preexec_fn=limit if address_space_limit else None)
        errors = []
        def checkpoint():
            request = self.stage / 'gate-request.json'
            while process.poll() is None:
                try:
                    value = json.loads(request.read_text())
                except (FileNotFoundError, json.JSONDecodeError):
                    time.sleep(0.01); continue
                proof = {'nonce': value['nonce'], **copy.deepcopy(self.policy['baseline'])}
                for name in ('discovery', 'runs', 'steps', 'approvals'):
                    proof[name]['asOf'] = wrapper.utc()
                try:
                    wrapper.exclusive_json(self.stage / 'gate-response.json', proof)
                except BaseException as exc:
                    errors.append(exc)
                return
        thread = threading.Thread(target=checkpoint)
        thread.start()
        out, err = process.communicate(timeout=20)
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive()); self.assertFalse(errors)
        (self.stage / 'synthetic-subprocess.log').write_bytes(out + err)
        return process.returncode, err.decode()

    def refused(self, message):
        code, err = self.invoke()
        self.assertNotEqual(code, 0, err); self.assertIn(message, err)
        self.assertFalse((self.dest / 'node_modules').exists())
        self.assertFalse((self.stage / 'copy-result.json').exists())

    def test_full_executable_valid_copy_and_pending_gate(self):
        code, err = self.invoke(); self.assertEqual(code, 0, err)
        result = json.loads((self.stage / 'copy-result.json').read_text())
        self.assertFalse(result['gateAnswered']); self.assertFalse(result['agentStarted'])
        self.assertEqual((self.dest / 'node_modules/payload').read_bytes(), b'fixture payload\x00\xff')
        self.assertNotEqual((self.source / 'node_modules/payload').stat().st_ino,
                            (self.dest / 'node_modules/payload').stat().st_ino)

    def change_receipt(self, change):
        receipt = copy.deepcopy(self.policy['receipt']['content']); change(receipt)
        self.policy['receipt'] = self.record('original-receipt.json', receipt)

    def test_wrong_receipt_run(self):
        self.change_receipt(lambda r: r.update(runId='different-synthetic-run'))
        self.refused('receipt/run/gate mismatch')

    def test_wrong_receipt_version(self):
        self.change_receipt(lambda r: r.update(version=2)); self.refused('malformed original receipt')

    def test_receipt_extra_field(self):
        self.change_receipt(lambda r: r.update(extra='bad')); self.refused('malformed original receipt')

    def test_receipt_missing_field(self):
        self.change_receipt(lambda r: r.pop('runId')); self.refused('malformed original receipt')

    def test_receipt_bad_type(self):
        self.change_receipt(lambda r: r.update(version=True)); self.refused('malformed original receipt')

    def test_approval_wrong_run(self):
        self.policy['baseline']['approvals']['items'][0]['runId'] = 'different-synthetic-run'
        self.refused('approval/run identity mismatch')

    def test_approval_wrong_step(self):
        self.policy['baseline']['approvals']['items'][0]['stepRunId'] = 'different-synthetic-step'
        self.refused('approval/gate-step identity mismatch')

    def filter_case(self, driver, name='fixture'):
        marker = self.area / 'filter-marker'
        self.git('config', 'filter.' + name + '.' + driver, 'printf marker > ' + shlex.quote(str(marker)))
        (self.source / '.gitattributes').write_text('pnpm-lock.yaml filter=' + name + '\n')
        lock = self.source / 'pnpm-lock.yaml'; s = lock.stat()
        os.utime(lock, ns=(s.st_atime_ns, s.st_mtime_ns + 1000000000))
        self.refused('configured clean/process/smudge filter')
        self.assertFalse(marker.exists(), 'Git filter executed before refusal')

    def test_clean_filter_never_executes(self): self.filter_case('clean')
    def test_process_filter_never_executes(self): self.filter_case('process')
    def test_empty_named_clean_filter_never_executes(self): self.filter_case('clean', '')
    def test_empty_named_process_filter_never_executes(self): self.filter_case('process', '')

    def suppressed_workspace_case(self, root, flag):
        relative = 'packages/widget/package.json'
        manifest = root / relative
        before = manifest.read_bytes()
        self.git('update-index', flag, '--', relative, root=root)
        changed = before.replace(b'fixture', b'changed')
        self.assertNotEqual(changed, before); self.assertEqual(len(changed), len(before))
        manifest.write_bytes(changed)
        (self.source / 'node_modules/workspace').symlink_to('../packages/widget')
        self.rebuild_contract()
        self.refused('index checking is suppressed')
        self.assertEqual(manifest.read_bytes(), changed, 'flagged fixture evidence changed')
        self.assertFalse((self.stage / 'gate-request.json').exists())

    def test_source_assume_unchanged_same_size_workspace_edit(self):
        self.suppressed_workspace_case(self.source, '--assume-unchanged')

    def test_destination_assume_unchanged_same_size_workspace_edit(self):
        self.suppressed_workspace_case(self.dest, '--assume-unchanged')

    def test_source_skip_worktree_same_size_workspace_edit(self):
        self.suppressed_workspace_case(self.source, '--skip-worktree')

    def test_destination_skip_worktree_same_size_workspace_edit(self):
        self.suppressed_workspace_case(self.dest, '--skip-worktree')

    def test_submodule_index_refused(self):
        self.git('update-index', '--add', '--cacheinfo', '160000,' + self.head + ',fixture-submodule')
        self.refused('submodules are unsupported')

    def test_untracked_gitmodules_refused(self):
        (self.source / '.gitmodules').write_text('[submodule "fixture"]\n')
        self.refused('submodules are unsupported')

    def link_case(self, target):
        (self.source / 'node_modules/link').symlink_to(target)
        self.rebuild_contract(); self.refused('unapproved')

    def test_git_target_refused(self): self.link_case('../.git')

    def test_orca_state_target_refused(self):
        (self.source / '.orca').mkdir(); (self.source / '.orca/private-state.json').write_text('synthetic')
        self.link_case('../.orca/private-state.json')

    def test_private_record_target_refused(self):
        (self.source / 'private-record.json').write_text('synthetic')
        self.link_case('../private-record.json')

    def test_link_chain_through_private_state_refused(self):
        (self.source / 'node_modules/intermediate').symlink_to('../.git')
        self.link_case('intermediate/config')

    def test_permitted_workspace_package(self):
        (self.source / 'node_modules/workspace').symlink_to('../packages/widget')
        self.rebuild_contract()
        code, err = self.invoke(); self.assertEqual(code, 0, err)
        self.assertEqual((self.dest / 'node_modules/workspace/package.json').read_bytes(),
                         (self.source / 'packages/widget/package.json').read_bytes())

    def test_workspace_private_child_refused(self):
        (self.source / 'packages/widget/private-record.json').write_text('synthetic')
        (self.source / 'node_modules/link').symlink_to('../packages/widget')
        self.rebuild_contract(); self.refused('unrecorded workspace/private-state child')

    def test_destination_workspace_private_child_refused(self):
        (self.dest / 'packages/widget/private-record.json').write_text('synthetic')
        (self.source / 'node_modules/link').symlink_to('../packages/widget')
        self.rebuild_contract(); self.refused('unrecorded workspace/private-state child')

    def test_allowlist_cannot_grant_untracked_private_file(self):
        p = self.source / 'packages/widget/private-record.json'; p.write_text('synthetic')
        self.policy['link_policy']['workspace_entries'].append(
            {'path': 'packages/widget/private-record.json', 'kind': 'file', 'bytes': p.stat().st_size})
        self.refused('workspace allowlist is not the pinned Git package data')

    def test_allowlist_cannot_grant_wrong_file_size(self):
        self.policy['link_policy']['workspace_entries'][1]['bytes'] += 1
        self.refused('workspace allowlist is not the pinned Git package data')

    def test_dependency_nested_git_state_refused(self):
        (self.source / 'node_modules/.git').mkdir()
        (self.source / 'node_modules/link').symlink_to('.git')
        self.rebuild_contract(); self.refused('Git/ORCA state is excluded')

    def test_permitted_dependency_and_workspace_link_chain(self):
        (self.source / 'node_modules/first').symlink_to('second')
        (self.source / 'node_modules/second').symlink_to('../packages/widget')
        self.rebuild_contract()
        code, err = self.invoke(); self.assertEqual(code, 0, err)
        self.assertEqual((self.dest / 'node_modules/first/package.json').read_bytes(),
                         (self.source / 'packages/widget/package.json').read_bytes())

    def test_insufficient_memory_budget_before_scan(self):
        self.policy['memory']['minimum_available_bytes'] = 2 ** 62
        self.refused('execution-profile memory headroom missing')
        self.assertFalse((self.stage / 'gate-request.json').exists())
        journal = (self.stage / 'execution-journal.jsonl').read_text()
        self.assertNotIn('copy-preconditions-pass', journal)

    def test_payload_exceeds_memory_pin_before_scan(self):
        self.policy['memory']['largest_file_bytes'] = 0
        self.refused('payload exceeds memory pin')
        self.assertFalse((self.stage / 'gate-request.json').exists())

    def test_actual_resource_profile_accounted(self):
        snapshot = wrapper.memory_snapshot()
        self.assertGreater(snapshot['rss_bytes'], 0)
        self.assertLessEqual(snapshot['available_bytes'], snapshot['host_available_bytes'])
        for value in snapshot['cgroup_headrooms'] + snapshot['rlimit_headrooms']:
            self.assertLessEqual(snapshot['available_bytes'], value)

    def test_cgroup_and_rlimit_budget_refusal(self):
        with patch.object(wrapper, 'memory_snapshot', return_value={'available_bytes': 1}):
            with self.assertRaisesRegex(RuntimeError, 'memory headroom missing'):
                wrapper.memory_guard(self.policy)

    def test_actual_address_space_limit_before_scan(self):
        code, err = self.invoke(address_space_limit=160 * 1024 * 1024)
        self.assertNotEqual(code, 0); self.assertIn('execution-profile memory headroom missing', err)
        self.assertFalse((self.stage / 'gate-request.json').exists())
        self.assertFalse((self.dest / 'node_modules').exists())


if __name__ == '__main__': unittest.main(verbosity=2)
