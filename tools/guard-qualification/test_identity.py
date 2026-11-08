"""Exact identity tuple and drift tests (synthetic tuples; no qualification)."""
import copy
import hashlib
import os
import subprocess
import tempfile
import unittest

import identity as idn
from reasons import Refusal


def h(label):
    return hashlib.sha256(label.encode()).hexdigest()


def sample():
    return {
        'version': 1, 'lane': idn.SUPPORTED_LANE,
        'source': {'commit': 'a' * 40, 'tree': 'b' * 40, 'clean': True},
        'build': {'inputsSha256': h('inputs'), 'inputCount': 386, 'lockfileSha256': h('lock'),
                  'builderSha256': h('builder'),
                  'outputs': {'controlled-build.json': {'bytes': 48027, 'sha256': h('m')},
                              'controlled-producer.mjs': {'bytes': 2248652, 'sha256': h('p')},
                              'controlled-child.mjs': {'bytes': 5713, 'sha256': h('c')}}},
        'provider': {'name': 'orca-owned-io', 'version': '0.7.0-rc.1'},
        'bridge': {'name': 'scoped-permission-bridge', 'version': 'source'},
        'tool': {'name': 'owned-file-read', 'schemaSha256': h('schema'), 'codec': 'orca-owned-read-v1',
                 'codecVersion': 1},
        'executionPath': 'orca-owned-file-read-service',
        'host': {'os': 'linux', 'arch': 'x86_64', 'kernelRelease': '6.1.0', 'hostIdSha256': h('host'),
                 'requirements': list(idn.HOST_REQUIREMENTS)},
        'runtime': {'node': {'version': 'v22.23.4', 'exeSha256': h('node')},
                    'python': {'version': '3.13.18', 'exeSha256': h('python')}},
        'loader': {'manifestSha256': h('manifest'), 'moduleCount': 2, 'loaderSha256': h('loader')},
        'profile': {'id': 'strict-owned-read-v1', 'sha256': h('profile')},
        'containment': {'mechanism': 'unshare-pivot-root-v1', 'specSha256': h('spec'),
                        'namespaces': ['cgroup', 'ipc', 'mnt', 'net', 'pid', 'user', 'uts']},
    }


def leaves(value, path=()):
    if type(value) is dict:
        for key, sub in value.items():
            yield from leaves(sub, path + (key,))
    else:
        yield path


def setp(value, path, new):
    for key in path[:-1]:
        value = value[key]
    value[path[-1]] = new


class IdentityTests(unittest.TestCase):
    def refuses(self, code, fn, *args):
        with self.assertRaises(Refusal) as caught:
            fn(*args)
        self.assertEqual(caught.exception.code, code)

    def test_exact_match_is_correspondence_without_authority(self):
        result = idn.require_exact(sample(), sample())
        self.assertEqual((result['authority'], result['productionEligible'], result['observationAuthorized']),
                         ('none', False, False))

    def test_every_field_drift_invalidates(self):
        paths = list(leaves(sample()))
        self.assertEqual(len(paths), 41)
        for path in paths:
            with self.subTest(path='.'.join(path)):
                measured = sample()
                original = measured
                for key in path[:-1]:
                    original = original[key]
                old = original[path[-1]]
                new = (h('drift') if type(old) is str and len(old) == 64 else 'c' * 40 if type(old) is str and
                       len(old) == 40 else old + 1 if type(old) is int and type(old) is not bool else
                       ['ipc', 'mnt', 'net', 'pid', 'user', 'uts'] if type(old) is list else
                       'drifted-value' if type(old) is str else False)
                setp(measured, path, new)
                with self.assertRaises(Refusal):
                    idn.require_exact(sample(), measured)

    def test_missing_unknown_and_malformed_fields(self):
        incomplete = sample()
        incomplete['runtime']['node']['exeSha256'] = None
        self.refuses('identity_incomplete', idn.require_exact, incomplete, incomplete)
        extra = sample()
        extra['tool']['aliases'] = []
        self.refuses('identity_unknown_field', idn.validate, extra)
        for path, bad in ((('version',), True), (('source', 'clean'), False), (('lane',), 'other-lane'),
                          (('executionPath',), 'acp-native-shell'), (('host', 'os'), 'windows'),
                          (('tool', 'codecVersion'), 1.0), (('build', 'outputs'), {}),
                          (('containment', 'namespaces'), ['net', 'mnt'])):
            with self.subTest(path=path):
                bad_tuple = sample()
                setp(bad_tuple, path, bad)
                with self.assertRaises(Refusal) as caught:
                    idn.validate(bad_tuple)
                self.assertIn(caught.exception.code, ('identity_malformed', 'identity_incomplete'))
        missing_output = sample()
        del missing_output['build']['outputs']['controlled-child.mjs']
        self.refuses('identity_drift', idn.require_exact, sample(), missing_output)

    def test_unsupported_routes_are_explicit(self):
        for route in idn.UNSUPPORTED_ROUTES:
            self.refuses('route_unsupported', idn.require_supported_route, route)
        idn.require_supported_route('orca-owned-file-read-service')
        self.assertTrue(set(idn.UNSUPPORTED_ROUTES).isdisjoint(idn.SUPPORTED_EXECUTION_PATHS))

    def test_measure_source_detects_dirty_tree(self):
        with tempfile.TemporaryDirectory() as repo:
            env = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='t',
                       GIT_COMMITTER_EMAIL='t@t')
            for args in (['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'x']):
                subprocess.run(['git', '-C', repo, *args], check=True, env=env)
            self.assertTrue(idn.measure_source(repo)['clean'])
            with open(os.path.join(repo, 'f'), 'w') as handle:
                handle.write('x')
            self.assertFalse(idn.measure_source(repo)['clean'])
        self.refuses('source_unavailable', idn.measure_source, '/nonexistent-repo')

    def _repo(self, tmp):
        env = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='t',
                   GIT_COMMITTER_EMAIL='t@t')
        with open(os.path.join(tmp, 'f'), 'w') as handle:
            handle.write('reviewed\n')
        for args in (['init', '-q'], ['add', 'f'], ['commit', '-q', '-m', 'x']):
            subprocess.run(['git', '-C', tmp, *args], check=True, env=env)
        self.assertTrue(idn.measure_source(tmp)['clean'])

    def test_m2_skip_worktree_and_assume_unchanged_cannot_hide_changes(self):
        # Reviewer M2: skip-worktree made a modified tree report clean.
        for flag in ('--skip-worktree', '--assume-unchanged'):
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as repo:
                self._repo(repo)
                subprocess.run(['git', '-C', repo, 'update-index', flag, 'f'], check=True)
                with open(os.path.join(repo, 'f'), 'w') as handle:
                    handle.write('changed\n')
                self.assertFalse(idn.measure_source(repo)['clean'])

    def test_m2_repository_configured_commands_are_not_run(self):
        # Reviewer M2: core.fsmonitor (and similar) ran repository-controlled commands.
        with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as out:
            self._repo(repo)
            marker = os.path.join(out, 'ran')
            hook = os.path.join(out, 'monitor.sh')
            with open(hook, 'w') as handle:
                handle.write('#!/bin/sh\ntouch %s\n' % marker)
            os.chmod(hook, 0o755)
            subprocess.run(['git', '-C', repo, 'config', 'core.fsmonitor', hook], check=True)
            with open(os.path.join(repo, '.gitattributes'), 'w') as handle:
                handle.write('f filter=evil\n')
            subprocess.run(['git', '-C', repo, 'config', 'filter.evil.clean', 'touch %s; cat' % marker], check=True)
            idn.measure_source(repo)
            self.assertFalse(os.path.exists(marker))

    def test_l5_missing_machine_id_refuses(self):
        # Reviewer L5: a missing machine id silently became an empty host id.
        from unittest import mock
        real_open = open

        def fake_open(path, *args, **kwargs):
            if path == '/etc/machine-id':
                raise FileNotFoundError(path)
            return real_open(path, *args, **kwargs)
        with mock.patch('builtins.open', fake_open):
            self.refuses('identity_incomplete', idn.measure_host)

    def test_cal6_host_requirements_are_stated_and_probed(self):
        # Cal: the procfs child-enumeration interface was missing on another host. The tuple
        # names what the boundary needs, and a missing /proc refuses with an allowlisted code.
        from unittest import mock
        self.assertNotIn('proc-children', idn.HOST_REQUIREMENTS)
        self.assertEqual(idn.measure_host()['requirements'], list(idn.HOST_REQUIREMENTS))
        real_open = open

        def no_children(path, *args, **kwargs):
            if str(path).endswith('/children'):
                raise FileNotFoundError(path)
            return real_open(path, *args, **kwargs)
        with mock.patch('builtins.open', no_children):
            self.assertEqual(idn.measure_host()['requirements'], list(idn.HOST_REQUIREMENTS))

        def no_proc(path, *args, **kwargs):
            if str(path).startswith('/proc/'):
                raise PermissionError(path)
            return real_open(path, *args, **kwargs)
        with mock.patch('builtins.open', no_proc):
            self.refuses('procfs_unavailable', idn.measure_host)
        with mock.patch.object(idn.platform, 'release', lambda: '5.10.0'):
            self.refuses('containment_unavailable', idn.measure_host)
        missing = sample()
        del missing['host']['requirements']
        self.refuses('identity_incomplete', idn.validate, missing)
        reordered = sample()
        reordered['host']['requirements'] = list(reversed(idn.HOST_REQUIREMENTS))
        self.refuses('identity_malformed', idn.validate, reordered)

    def test_file_digest_refuses_symlink_and_special_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, 'f')
            with open(target, 'wb') as handle:
                handle.write(b'abc')
            self.assertEqual(idn.file_digest(target), {'bytes': 3, 'sha256': hashlib.sha256(b'abc').hexdigest()})
            os.symlink(target, os.path.join(tmp, 'l'))
            self.refuses('identity_malformed', idn.file_digest, os.path.join(tmp, 'l'))
            os.mkfifo(os.path.join(tmp, 'p'))
            self.refuses('identity_malformed', idn.file_digest, os.path.join(tmp, 'p'))

    def test_committed_matrix_is_incomplete_and_cannot_qualify(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docs', 'preparation',
                            'tool-execution-guards', 'guard-proof-identity.json')
        with open(path, 'rb') as handle:
            matrix = __import__('json').loads(handle.read())
        self.assertEqual(matrix['status'], 'incomplete-not-qualified')
        self.refuses('identity_incomplete', idn.validate, matrix['reviewedTuple'])
        self.assertEqual(tuple(matrix['unsupportedRoutes']), idn.UNSUPPORTED_ROUTES)
        self.assertEqual(set(matrix['reviewedTuple']), set(idn.SCHEMA))

    def test_canonical_rejects_floats_and_is_order_independent(self):
        self.refuses('identity_malformed', idn.canonical, {'a': 1.5})
        self.assertEqual(idn.digest({'a': 1, 'b': 2}), idn.digest({'b': 2, 'a': 1}))
        self.assertEqual(copy.deepcopy(sample()), sample())


if __name__ == '__main__':
    unittest.main()
