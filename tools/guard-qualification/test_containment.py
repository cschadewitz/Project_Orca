"""Preventive containment tests: real namespaces, synthetic candidates only.

Each scenario runs in a dedicated child supervisor (subreaper ledger). A refusal
must happen before the candidate executes; candidates leave a marker file in
the workspace when they run, so 'marker absent' proves non-execution.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.realpath(sys.executable)
NODE_DIR = os.path.dirname(os.path.dirname(os.path.realpath(shutil.which('node') or '/missing/bin/node')))
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/workspace', 'LANG': 'C.UTF-8'}
PROBE = textwrap.dedent('''
    import json, os, socket
    open('/workspace/ran', 'w').close()
    out = {'root': sorted(os.listdir('/')), 'env': dict(os.environ), 'fds': sorted(os.listdir('/proc/self/fd'))}
    caps = {l.split(':')[0]: l.split()[1] for l in open('/proc/self/status') if l.startswith('Cap')}
    out['caps'] = caps
    try:
        s = socket.socket(); s.settimeout(1); s.connect(('1.1.1.1', 443)); out['net'] = 'open'
    except OSError as e:
        out['net'] = e.errno
    for path in ('/etc/passwd', '/root', '/home', '/tmp', '/proc/1/root/root', '/run'):
        out.setdefault('visible', []).append(path) if os.path.exists(path) else None
    try:
        open('/usr/orca-write', 'w')
        out['usrWritable'] = True
    except OSError:
        out['usrWritable'] = False
    print(json.dumps(out))
''')


def scenario(body, base, prelude=''):
    code = textwrap.dedent('''
        import json, os, subprocess, sys
        sys.path.insert(0, %r)
        import containment
        from ledger import AcquisitionLedger
        from reasons import Refusal, code_of
        BASE, PY, ENV, PROBE, NODE_DIR = %r, %r, %r, %r, %r
        out = {}
    ''' % (HERE, base, PY, ENV, PROBE, NODE_DIR)) + textwrap.dedent(prelude) + textwrap.dedent(body) + \
        '\nprint(json.dumps(out))\n'
    result = subprocess.run([sys.executable, '-I', '-c', code], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AssertionError('scenario failed: ' + result.stderr[-2000:])
    return json.loads(result.stdout.strip().splitlines()[-1])


RUN = '''
ledger = AcquisitionLedger(subreaper=True)
try:
    with ledger:
        ws = ledger.private_dir(BASE, 'ws')
        spec = containment.make_spec(workspace=ws, snapshot=SNAP, runtime_dirs=RUNTIME, argv=ARGV, env=ENV_)
        out['specSha256'] = containment.spec_digest(spec)
        owned = containment.launch_contained(ledger, spec, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out['stdout'] = owned.popen.stdout.read().decode()
        out['stderr'] = owned.popen.stderr.read().decode()[-400:]
        out['ran'] = os.path.exists(os.path.join(ws, 'ran'))
except Refusal as error:
    out['refusal'] = error.code
    out['ran'] = os.path.exists(os.path.join(BASE, 'ws', 'ran'))
out['settlement'] = ledger.close().report()
'''


class ContainmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.base = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def run_probe(self, prelude='', snap=None, runtime=('/usr',), argv=None, env=None):
        setup = 'SNAP, RUNTIME, ARGV, ENV_ = %r, %r, %r, %r\n' % (
            snap, list(runtime), argv or [PY, '-I', '-S', '-c', PROBE], env or ENV)
        return scenario(RUN, self.base, prelude + setup)

    def test_candidate_runs_only_inside_verified_boundary(self):
        out = self.run_probe()
        self.assertNotIn('refusal', out, out)
        probe = json.loads(out['stdout'])
        self.assertTrue(out['ran'])
        self.assertEqual(probe['root'], ['bin', 'dev', 'lib', 'lib64', 'proc', 'sbin', 'usr', 'workspace'])
        self.assertEqual(probe['env'], ENV)
        self.assertEqual(probe['net'], 101)  # ENETUNREACH: only an unconfigured loopback exists
        self.assertEqual(probe.get('visible', []), [])
        self.assertFalse(probe['usrWritable'])
        self.assertTrue(all(int(v, 16) == 0 for v in probe['caps'].values()), probe['caps'])
        self.assertEqual(out['settlement']['status'], 'settled')
        self.assertRegex(out['specSha256'], '^[0-9a-f]{64}$')

    def test_bound_loader_inside_containment(self):
        sys.path.insert(0, HERE)
        from loader import node_argv
        snap = os.path.join(self.base, 'snap')
        os.mkdir(snap)
        with open(os.path.join(snap, 'entry.mjs'), 'w') as handle:
            handle.write('import { readdirSync } from "node:fs";\nlet denied = null;\n'
                         'try { readdirSync("/"); } catch (e) { denied = e.code; }\n'
                         'console.log(JSON.stringify({ cwd: process.cwd(), denied }));\n')
        # The manifest names the in-container root (/snapshot), where snap is bound read-only.
        digest = self._manifest_for_container(snap)
        argv = node_argv(os.path.join(NODE_DIR, 'bin', 'node'), '/snapshot', digest, 'entry.mjs')
        out = self.run_probe(snap=snap, runtime=('/usr', NODE_DIR), argv=argv)
        self.assertNotIn('refusal', out, out)
        self.assertEqual(json.loads(out['stdout']), {'cwd': '/workspace', 'denied': 'ERR_ACCESS_DENIED'}, out)
        self.assertIn('orca-bound-loader loaded', out['stderr'])

    def _manifest_for_container(self, snap):
        import hashlib
        import json as js
        from loader import LOADER
        shutil.copyfile(LOADER, os.path.join(snap, 'bound-loader.mjs'))
        with open(os.path.join(snap, 'entry.mjs'), 'rb') as handle:
            data = handle.read()
        manifest = js.dumps({'version': 1, 'root': '/snapshot', 'builtins': ['node:fs'], 'modules': [
            {'path': 'entry.mjs', 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
             'format': 'module'}]}, sort_keys=True).encode()
        with open(os.path.join(snap, 'manifest.json'), 'wb') as handle:
            handle.write(manifest)
        return hashlib.sha256(manifest).hexdigest()

    def test_shared_network_namespace_refuses_before_candidate(self):
        out = self.run_probe(
            "containment.UNSHARE_FLAGS = tuple(f for f in containment.UNSHARE_FLAGS if f != '--net')\n")
        self.assertEqual(out['refusal'], 'containment_namespace_shared')
        self.assertFalse(out['ran'])
        self.assertEqual(out['settlement']['status'], 'settled')

    def test_inherited_descriptor_refuses_before_candidate(self):
        prelude = '''
import ledger as L
original = L.AcquisitionLedger.spawn
leak = os.open('/etc/hostname', os.O_RDONLY)
def leaky(self, argv, **kw):
    kw['pass_fds'] = tuple(kw.get('pass_fds', ())) + (leak,)
    return original(self, argv, **kw)
L.AcquisitionLedger.spawn = leaky
'''
        out = self.run_probe(prelude)
        self.assertEqual(out['refusal'], 'containment_fd_inherited')
        self.assertFalse(out['ran'])

    def test_environment_and_spec_violations_refuse(self):
        out = self.run_probe(env=dict(ENV, AWS_SECRET_ACCESS_KEY='x'))
        self.assertEqual(out['refusal'], 'containment_env')
        out = self.run_probe(runtime=('/',))
        self.assertEqual(out['refusal'], 'containment_spec_invalid')
        out = self.run_probe(runtime=('/root',))
        self.assertEqual(out['refusal'], 'containment_spec_invalid')
        out = self.run_probe(argv=['relative-binary'])
        self.assertEqual(out['refusal'], 'containment_spec_invalid')

    def test_startup_failure_refuses_and_settles(self):
        out = self.run_probe(runtime=('/usr', '/nonexistent-runtime'))
        self.assertEqual(out['refusal'], 'containment_startup_failed')
        self.assertFalse(out['ran'])
        self.assertEqual(out['settlement']['status'], 'settled')

    def test_supervisor_refusal_after_report_never_releases_candidate(self):
        prelude = '''
containment._contained_init_pid = lambda owned: (_ for _ in ()).throw(Refusal('containment_startup_failed'))
'''
        out = self.run_probe(prelude)
        self.assertEqual(out['refusal'], 'containment_startup_failed')
        self.assertFalse(out['ran'])
        self.assertEqual(out['settlement']['status'], 'settled')

    def test_deny_path_overlapping_runtime_refuses(self):
        out = self.run_probe("containment.DEFAULT_DENY = containment.DEFAULT_DENY + ('/usr/lib',)\n")
        self.assertEqual(out['refusal'], 'containment_spec_invalid')
        self.assertFalse(out['ran'])


if __name__ == '__main__':
    unittest.main()
