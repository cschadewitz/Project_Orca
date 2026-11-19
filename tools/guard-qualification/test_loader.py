"""Loaded-code binding tests: real Node, synthetic candidate modules only."""
import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest

from loader import make_snapshot, node_argv

NODE = shutil.which('node')
ENTRY = '''import { value } from "./lib/dep.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const cjs = require("./lib/c.cjs");
%s
const dyn = await import("./lib/dyn.mjs");
console.log(JSON.stringify({ value, cjs: cjs.x, dyn: dyn.d }));
'''
MODULES = [('entry.mjs', 'module'), ('lib/dep.mjs', 'module'), ('lib/c.cjs', 'commonjs'), ('lib/dyn.mjs', 'module')]


class LoaderTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(NODE, 'node is required; absence is a failure, not a skip')
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.tmp.name)
        os.mkdir(os.path.join(self.root, 'lib'))

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, text):
        with open(os.path.join(self.root, path), 'w') as handle:
            handle.write(text)

    def graph(self, prefix=''):
        self.write('entry.mjs', ENTRY % prefix)
        self.write('lib/dep.mjs', 'export const value = 1;\n')
        self.write('lib/c.cjs', 'module.exports = { x: 2 };\n')
        self.write('lib/dyn.mjs', 'export const d = 3;\n')

    def run_node(self, digest, flags=(), entry='entry.mjs'):
        return subprocess.run(node_argv(NODE, self.root, digest, entry, flags), capture_output=True, text=True,
                              timeout=30, env={'PATH': '/usr/bin:/bin'}, cwd=self.root)

    def refused(self, result, code):
        self.assertEqual(result.returncode, 96, result.stderr[-500:])
        self.assertIn('orca-bound-loader refused ' + code, result.stderr)
        self.assertNotIn('"value"', result.stdout)

    def test_static_create_require_and_dynamic_imports_are_served_from_reviewed_bytes(self):
        self.graph()
        result = self.run_node(make_snapshot(self.root, MODULES, ['node:module']))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '{"value":1,"cjs":2,"dyn":3}')
        self.assertIn('orca-bound-loader loaded', result.stderr)

    def test_disk_mutation_after_verification_is_not_loaded(self):
        # The host rewrites not-yet-loaded modules after the loader verified them.
        self.graph('''console.log("ready");
await new Promise((resolve) => process.stdin.once("data", resolve));
const late = require("./lib/c2.cjs");
console.log(JSON.stringify({ late }));''')
        self.write('lib/c2.cjs', 'module.exports = 0;\n')
        digest = make_snapshot(self.root, MODULES + [('lib/c2.cjs', 'commonjs')], ['node:module'])
        proc = subprocess.Popen(node_argv(NODE, self.root, digest, 'entry.mjs'), stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                env={'PATH': '/usr/bin:/bin'}, cwd=self.root)
        try:
            self.assertEqual(proc.stdout.readline().strip(), 'ready')
            self.write('lib/dyn.mjs', 'export const d = 666;\n')
            self.write('lib/c2.cjs', 'module.exports = 666;\n')
            out, err = proc.communicate('go\n', timeout=30)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        self.assertEqual(proc.returncode, 0, err)
        self.assertEqual(out.split(), ['{"late":0}', '{"value":1,"cjs":2,"dyn":3}'])

    def test_h3_module_compile_cannot_run_unreviewed_strings(self):
        # Reviewer H3: a served CommonJS module ran any string through module._compile.
        self.graph('require("./lib/evil.cjs");')
        self.write('lib/evil.cjs', 'module["_com" + "pile"]("console.log(\'PWNED\')", __filename + ".x.js");\n')
        result = self.run_node(make_snapshot(self.root, MODULES + [('lib/evil.cjs', 'commonjs')], ['node:module']))
        self.assertNotIn('PWNED', result.stdout)
        self.refused(result, 'loader_compile_denied')
        # Each attempt to replace a compile/load path must be refused or have no effect
        # on how the next reviewed module is loaded.
        self.write('lib/dep2.cjs', 'module.exports = { real: true };\n')
        for attempt in ('M["_ext" + "ensions"][".cjs"] = (m) => { m.exports = {}; };',
                        'M["wr" + "ap"] = () => "(function (exports, require, module) { module.exports = {}; })";',
                        'M["_lo" + "ad"] = () => ({});',
                        'M.prototype["_com" + "pile"] = function () { this.exports = {}; };',
                        'M.prototype["req" + "uire"] = () => ({});',
                        'M["_resolve" + "Filename"] = () => "/etc/passwd";'):
            with self.subTest(attempt=attempt):
                self.graph('require("./lib/evil.cjs");')
                self.write('lib/evil.cjs', 'const M = require("node:module");\ntry { ' + attempt +
                           ' } catch {}\nconst r = require("./dep2.cjs");\n'
                           'if (!r || r.real !== true) console.log("PWNED");\n')
                result = self.run_node(make_snapshot(self.root, MODULES + [('lib/evil.cjs', 'commonjs'),
                                                                           ('lib/dep2.cjs', 'commonjs')],
                                                     ['node:module']))
                self.assertNotIn('PWNED', result.stdout, result.stderr)

    def test_h3_reviewed_bytes_referencing_loader_internals_refuse(self):
        self.graph('require("./lib/evil.cjs");')
        self.write('lib/evil.cjs', 'module._compile("1", __filename);\n')
        self.refused(self.run_node(make_snapshot(self.root, MODULES + [('lib/evil.cjs', 'commonjs')],
                                                 ['node:module'])), 'loader_compile_reference')

    def test_m1_required_node_flags_are_enforced(self):
        # Reviewer M1: the loader never checked how node was started.
        self.graph()
        digest = make_snapshot(self.root, MODULES, ['node:module'])
        base = node_argv(NODE, self.root, digest, 'entry.mjs')
        for drop in ('--permission', '--no-addons', '--disallow-code-generation-from-strings'):
            with self.subTest(drop=drop):
                # Without --permission node itself rejects --allow-fs-read, so drop both.
                argv = [a for a in base if a != drop and not (drop == '--permission' and
                                                              a.startswith('--allow-fs-read='))]
                self.refused(subprocess.run(argv, capture_output=True, text=True, timeout=30,
                                            env={'PATH': '/usr/bin:/bin'}), 'loader_flags')
        for extra in ('--allow-fs-write=' + self.root, '--allow-child-process', '--allow-worker',
                      '--allow-addons', '--inspect=127.0.0.1:0', '--import=data:text/javascript,'):
            with self.subTest(extra=extra):
                argv = base[:1] + [extra] + base[1:]
                self.refused(subprocess.run(argv, capture_output=True, text=True, timeout=30,
                                            env={'PATH': '/usr/bin:/bin'}), 'loader_flags')
        result = subprocess.run(base, capture_output=True, text=True, timeout=30,
                                env={'PATH': '/usr/bin:/bin', 'NODE_OPTIONS': '--allow-child-process'})
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('"value"', result.stdout)

    def test_tamper_before_launch_refuses_before_any_evaluation(self):
        self.graph('import { writeFileSync } from "node:fs"; writeFileSync("/tmp/x", "y");')
        digest = make_snapshot(self.root, MODULES, ['node:module', 'node:fs'])
        self.assertTrue(digest)
        self.write('lib/dep.mjs', 'export const value = 9;\n')
        self.refused(self.run_node(digest), 'loader_digest_mismatch')
        self.write('lib/dep.mjs', 'export const value = 1;\n')
        self.refused(self.run_node('0' * 64), 'loader_digest_mismatch')
        with open(os.path.join(self.root, 'manifest.json'), 'ab') as handle:
            handle.write(b' ')
        self.refused(self.run_node(digest), 'loader_digest_mismatch')

    def test_unlisted_modules_and_denied_builtins_refuse(self):
        self.graph('await import("./lib/extra.mjs");')
        self.write('lib/extra.mjs', 'export {};\n')
        self.refused(self.run_node(make_snapshot(self.root, MODULES, ['node:module'])), 'loader_module_unlisted')
        for builtin in ('child_process', 'node:vm', 'node:worker_threads', 'node:net', 'node:inspector'):
            with self.subTest(builtin=builtin):
                self.graph('await import("%s");' % builtin)
                self.refused(self.run_node(make_snapshot(self.root, MODULES, ['node:module'])),
                             'loader_builtin_denied')
        self.graph('const fs = require("fs");')
        self.refused(self.run_node(make_snapshot(self.root, MODULES, ['node:module'])), 'loader_builtin_denied')
        self.graph()
        with open(os.path.join(self.root, 'manifest.json'), 'w'):
            pass
        digest = make_snapshot(self.root, MODULES, ['node:module', 'node:vm'])
        self.refused(self.run_node(digest), 'loader_manifest_invalid')

    def test_native_addon_and_unknown_formats_refuse(self):
        self.graph('require("./lib/native.node");')
        self.write('lib/native.node', 'not really an addon')
        self.refused(self.run_node(make_snapshot(self.root, MODULES, ['node:module'])), 'loader_module_unlisted')
        self.graph()
        digest = make_snapshot(self.root, MODULES, ['node:module'])
        with open(os.path.join(self.root, 'manifest.json')) as handle:
            manifest = handle.read().replace('"commonjs"', '"addon"')
        self.write('manifest.json', manifest)
        self.refused(self.run_node(hashlib.sha256(manifest.encode()).hexdigest()), 'loader_format_unknown')
        self.assertNotEqual(digest, hashlib.sha256(manifest.encode()).hexdigest())

    def test_code_generation_wasm_and_hook_reregistration_refuse(self):
        self.graph('eval("1 + 1");')
        result = self.run_node(make_snapshot(self.root, MODULES, ['node:module']))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('EvalError', result.stderr)
        self.graph('if (typeof WebAssembly !== "undefined") throw Error("wasm present");')
        self.assertEqual(self.run_node(make_snapshot(self.root, MODULES, ['node:module'])).returncode, 0)
        self.graph('import { registerHooks } from "node:module"; registerHooks({});')
        self.refused(self.run_node(make_snapshot(self.root, MODULES, ['node:module'])), 'loader_builtin_denied')
        self.graph('const m = require("node:module"); m.register("data:text/javascript,");')
        self.refused(self.run_node(make_snapshot(self.root, MODULES, ['node:module'])), 'loader_builtin_denied')

    def test_symlinked_module_or_directory_refuses(self):
        self.graph()
        digest = make_snapshot(self.root, MODULES, ['node:module'])
        os.rename(os.path.join(self.root, 'lib'), os.path.join(self.root, 'real-lib'))
        os.symlink('real-lib', os.path.join(self.root, 'lib'))
        self.refused(self.run_node(digest), 'loader_symlink')
        os.unlink(os.path.join(self.root, 'lib'))
        os.rename(os.path.join(self.root, 'real-lib'), os.path.join(self.root, 'lib'))
        os.rename(os.path.join(self.root, 'lib/dep.mjs'), os.path.join(self.root, 'dep-real.mjs'))
        os.symlink(os.path.join(self.root, 'dep-real.mjs'), os.path.join(self.root, 'lib/dep.mjs'))
        self.refused(self.run_node(digest), 'loader_symlink')


if __name__ == '__main__':
    unittest.main()
