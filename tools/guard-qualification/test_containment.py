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


def outer_mount_namespace():
    """Run a scenario in its own private mount namespace so its fixture mounts never touch the host."""
    unshare = shutil.which('unshare', path='/usr/bin:/bin')
    if os.geteuid() == 0:
        return [unshare, '--mount', '--propagation', 'private']
    return [unshare, '--user', '--map-root-user', '--mount', '--propagation', 'private']


def scenario(body, base, prelude='', outer=False):
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
    argv = (outer_mount_namespace() if outer else []) + [sys.executable, '-I', '-c', code]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AssertionError('scenario failed: ' + result.stderr[-2000:])
    return json.loads(result.stdout.strip().splitlines()[-1])


RUN = '''
ledger = AcquisitionLedger(subreaper=True)
try:
    with ledger:
        ws = ledger.private_dir(BASE, 'ws')
        spec = containment.make_spec(workspace=ws, snapshot=SNAP, snapshot_digests=DIGESTS, runtime_dirs=RUNTIME,
                                     argv=ARGV, env=ENV_)
        out['specSha256'] = containment.spec_digest(spec)
        owned = containment.launch_contained(ledger, spec, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                             stderr=subprocess.PIPE)
        INTERACT(owned)
        out['stdout'] = owned.popen.stdout.read().decode()
        out['stderr'] = owned.popen.stderr.read().decode()[-400:]
        out['ran'] = os.path.exists(os.path.join(ws, 'ran'))
except Refusal as error:
    out['refusal'] = error.code
    out['ran'] = os.path.exists(os.path.join(BASE, 'ws', 'ran'))
out['settlement'] = ledger.close().report()
'''


def snapshot_digests(root):
    import hashlib
    out = {}
    for directory, _, files in os.walk(root):
        for name in files:
            path = os.path.join(directory, name)
            with open(path, 'rb') as handle:
                out[os.path.relpath(path, root)] = hashlib.sha256(handle.read()).hexdigest()
    return out


class ContainmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.base = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def run_probe(self, prelude='', snap=None, runtime=('/usr',), argv=None, env=None, digests=None, outer=False,
                  interact='lambda owned: owned.popen.stdin.close()'):
        if snap is not None and digests is None:
            digests = snapshot_digests(snap)
        setup = 'SNAP, RUNTIME, ARGV, ENV_, DIGESTS = %r, %r, %r, %r, %r\nINTERACT = %s\n' % (
            snap, list(runtime), argv or [PY, '-I', '-S', '-c', PROBE], env or ENV, digests, interact)
        return scenario(RUN, self.base, setup + prelude, outer=outer)

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

    def test_h1_nested_writable_mount_under_runtime_dir_is_read_only(self):
        # Reviewer H1 / Cal 2: a writable mount nested under a runtime directory stayed
        # writable inside, and the write landed on the host. Privileged fixture: the
        # nested tmpfs exists only in this scenario's private mount namespace.
        prelude = '''
for cmd in (['mount', '-t', 'tmpfs', 'none', '/opt'], ['mkdir', '-p', '/opt/rt/sub'],
            ['mount', '-t', 'tmpfs', 'none', '/opt/rt/sub']):
    subprocess.run(cmd, check=True)
'''
        probe = ("import json\nres = {}\nfor p in ('/opt/rt/sub/pwned', '/opt/rt/top'):\n"
                 "    try:\n        open(p, 'w').write('x'); res[p] = 'written'\n"
                 "    except OSError as e:\n        res[p] = e.errno\nprint(json.dumps(res))\n")
        body_check = "\nout['hostSees'] = os.path.exists('/opt/rt/sub/pwned')\n"
        setup = 'SNAP, RUNTIME, ARGV, ENV_, DIGESTS = %r, %r, %r, %r, %r\nINTERACT = %s\n' % (
            None, ['/usr', '/opt/rt'], [PY, '-I', '-S', '-c', probe], ENV, None,
            'lambda owned: owned.popen.stdin.close()')
        out = scenario(RUN + body_check, self.base, setup + prelude, outer=True)
        self.assertNotIn('refusal', out, out)
        result = json.loads(out['stdout'])
        self.assertEqual(result, {'/opt/rt/sub/pwned': 30, '/opt/rt/top': 30})  # EROFS
        self.assertFalse(out['hostSees'])

    def test_h1_mountinfo_check_refuses_if_recursive_setattr_is_missing(self):
        # The independent mountinfo check must catch a preflight whose read-only step is not
        # recursive (the reviewer's original bug), before the candidate runs.
        weakened = os.path.join(self.base, 'weak_preflight.py')
        with open(os.path.join(HERE, 'contained_preflight.py')) as handle:
            text = handle.read()
        self.assertEqual(text.count('setattr_mount(target, attrs, recursive=True)'), 1)
        with open(weakened, 'w') as handle:
            handle.write(text.replace('setattr_mount(target, attrs, recursive=True)',
                                      'setattr_mount(target, attrs, recursive=False)'))
        prelude = '''
containment.PREFLIGHT = %r
for cmd in (['mount', '-t', 'tmpfs', 'none', '/opt'], ['mkdir', '-p', '/opt/rt/sub'],
            ['mount', '-t', 'tmpfs', 'none', '/opt/rt/sub']):
    subprocess.run(cmd, check=True)
''' % weakened
        out = self.run_probe(prelude, runtime=('/usr', '/opt/rt'), outer=True)
        self.assertEqual(out['refusal'], 'containment_root_writable')
        self.assertFalse(out['ran'])
        self.assertEqual(out['settlement']['status'], 'settled')

    def test_m9_host_changes_to_snapshot_after_launch_are_not_visible(self):
        # Reviewer M9: host writes to the snapshot showed through the read-only bind.
        snap = os.path.join(self.base, 'snap')
        os.mkdir(snap)
        with open(os.path.join(snap, 'data.txt'), 'w') as handle:
            handle.write('reviewed')
        probe = ("import sys\nprint('ready', flush=True)\nsys.stdin.readline()\n"
                 "print(open('/snapshot/data.txt').read())\n")
        interact = ('lambda owned: (owned.popen.stdout.readline(), open(%r, "w").write("tampered"), '
                    'owned.popen.stdin.write(b"go\\n"), owned.popen.stdin.close())' % os.path.join(snap, 'data.txt'))
        out = self.run_probe(snap=snap, argv=[PY, '-I', '-S', '-c', probe], interact=interact)
        self.assertNotIn('refusal', out, out)
        self.assertEqual(out['stdout'].strip(), 'reviewed')
        with open(os.path.join(snap, 'data.txt')) as handle:
            self.assertEqual(handle.read(), 'tampered')

    def test_m9_snapshot_must_match_reviewed_digests(self):
        snap = os.path.join(self.base, 'snap')
        os.mkdir(snap)
        with open(os.path.join(snap, 'data.txt'), 'w') as handle:
            handle.write('reviewed')
        digests = snapshot_digests(snap)
        with open(os.path.join(snap, 'data.txt'), 'w') as handle:
            handle.write('changed before launch')
        out = self.run_probe(snap=snap, digests=digests)
        self.assertEqual(out['refusal'], 'containment_snapshot_mismatch')
        self.assertFalse(out['ran'])
        with open(os.path.join(snap, 'extra'), 'w') as handle:
            handle.write('x')
        out = self.run_probe(snap=snap, digests=dict(digests, **{'data.txt': snapshot_digests(snap)['data.txt']}))
        self.assertEqual(out['refusal'], 'containment_snapshot_mismatch')

    def test_l4_no_shared_host_side_root_directory(self):
        # Reviewer L4: a fixed /tmp/.orca-contained-root was created on the host and left behind.
        if os.path.isdir('/tmp/.orca-contained-root') and os.geteuid() == 0:
            os.rmdir('/tmp/.orca-contained-root')
        out = self.run_probe()
        self.assertNotIn('refusal', out, out)
        self.assertFalse(os.path.exists('/tmp/.orca-contained-root'))

    def test_l7_launch_errors_are_allowlisted_refusals(self):
        # Reviewer L7: launch_contained could raise raw exceptions.
        out = self.run_probe("import ledger as L\n"
                             "L.os.pipe2 = lambda flags: (_ for _ in ()).throw(OSError(24, 'raw'))\n")
        self.assertEqual(out['refusal'], 'containment_startup_failed')
        # Replace only containment's view of select, so the ledger's own settlement is unaffected.
        out = self.run_probe("import types\ncontainment.select = types.SimpleNamespace(\n"
                             "    select=lambda *a: (_ for _ in ()).throw(OSError(4, 'raw')))\n")
        self.assertEqual(out['refusal'], 'containment_startup_failed')
        self.assertEqual(out['settlement']['status'], 'settled')

    def test_cal6_no_proc_children_interface_needed(self):
        # Cal: on a host without CONFIG_PROC_CHILDREN the offline selector failed. Simulate the
        # interface being absent for every reader in the supervisor process.
        prelude = """
import builtins
_open = builtins.open
def no_children(path, *args, **kwargs):
    if isinstance(path, (str, bytes)) and os.fsdecode(path).endswith('/children'):
        raise FileNotFoundError(2, 'CONFIG_PROC_CHILDREN absent')
    return _open(path, *args, **kwargs)
builtins.open = no_children
"""
        out = self.run_probe(prelude)
        self.assertNotIn('refusal', out, out)
        self.assertTrue(out['ran'])
        self.assertEqual(out['settlement']['status'], 'settled')

    def test_cal6_unreadable_proc_refuses_with_allowlisted_reason(self):
        prelude = """
import types
class OsView(types.ModuleType):
    def __getattr__(self, name):
        return getattr(os, name)
view = OsView('os_view')
def listdir(path='.'):
    if path == '/proc':
        raise PermissionError(13, 'procfs hidden')
    return os.listdir(path)
view.listdir = listdir
containment.os = view
"""
        out = self.run_probe(prelude)
        self.assertEqual(out['refusal'], 'procfs_unavailable')
        self.assertFalse(out['ran'])
        self.assertEqual(out['settlement']['status'], 'settled')


if __name__ == '__main__':
    unittest.main()
