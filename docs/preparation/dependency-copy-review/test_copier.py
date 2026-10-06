"""Synthetic fixtures only. Runs with Python's standard library on local Linux."""
import copy
import os
import posixpath
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import copier
import relocation


def shim(root, relative, components=3):
    value = ':'.join(root + '/node_modules/fixture-' + str(i)
                     for i in range(components))
    target = '../payload/bin/tool.js'
    body = relocation.BODY_TEMPLATE.format(
        sh_long_prog_exe='"$basedir/node.exe"', sh_long_prog='"$basedir/node"',
        exec_args='', quoted_target_win='"$basedir_win/' + target + '"',
        quoted_target='"$basedir/' + target + '"', prog='node', prog_exe='node.exe')
    marker = posixpath.normpath(root + '/' + str(Path(relative).parent) + '/' + target)
    return relocation.HEADER + (relocation.NODE_TEMPLATE.format(sh_node_path=value)
        + '\n' + body + '\n# cmd-shim-target=' + marker + '\n').encode()


class CopierFixtures(unittest.TestCase):
    def setUp(self):
        # No existing fixture is deleted, including failed or partial copies.
        self.area = Path(tempfile.mkdtemp(prefix='copier-fixture-'))
        self.source = self.area / 'source'
        self.dest = self.area / 'destination'
        self.source.mkdir()
        self.dest.mkdir()
        self.trees = ['node_modules'] + [f'packages/fixture-{i}/node_modules'
                                         for i in range(13)]
        self.shims = []
        for i, t in enumerate(self.trees):
            (self.source / t / '.bin').mkdir(parents=True)
            (self.dest / t).parent.mkdir(parents=True, exist_ok=True)
            payload = self.source / t / 'payload/bin/tool.js'
            payload.parent.mkdir(parents=True)
            payload.write_bytes(b'fixture only\x00\xff\n')
            payload.chmod(0o640)
            (self.source / t / 'alias').symlink_to('payload')
        for i in range(192):
            p = self.trees[i % 14] + '/.bin/tool-' + str(i)
            data = shim(str(self.source), p, 2 if i < 2 else 3)
            (self.source / p).write_bytes(data)
            (self.source / p).chmod(0o755)
            _, mapping = relocation.propose(data, copier.digest(data), 0o755,
                str(self.source), str(self.dest), p)
            self.shims.append({'path': p, **mapping})
        self.metadata = {}
        for name in ('.modules.yaml', '.pnpm-workspace-state-v1.json'):
            p = 'node_modules/' + name
            data = b'historical fixture path: ' + str(self.source).encode() + b'\n'
            (self.source / p).write_bytes(data)
            (self.source / p).chmod(0o600)
            self.metadata[p] = copier.digest(data)
        with copier.root(str(self.source)) as fd:
            self.entries = copier.scan(fd, self.trees)
        self.contract = {'trees': self.trees, 'entries': list(self.entries.values()),
                         'shims': self.shims, 'shim_count': 192,
                         'prefix_count': 1340, 'metadata': self.metadata}

    def plan(self):
        return copier.plan(str(self.source), str(self.dest), self.contract)

    def run_copy(self):
        return copier.copy_exclusive(str(self.source), str(self.dest), self.contract)

    def rejected(self):
        with self.assertRaises((copier.Refusal, relocation.Refusal, OSError)):
            self.run_copy()
        self.assertFalse(any((self.dest / t).exists() for t in self.trees))

    def test_full_copy_modes_metadata_independence_and_exact_edits(self):
        before = self.source / self.shims[0]['path']
        original = before.read_bytes()
        trees, expected, rewritten = self.plan()
        self.assertFalse(any((self.dest / t).exists() for t in trees))
        result = self.run_copy()
        self.assertEqual((result['trees'], result['shims'], result['prefixes']), (14, 192, 1340))
        for p, item in expected.items():
            a, b = self.source / p, self.dest / p
            if item['kind'] == 'file':
                self.assertNotEqual((a.stat().st_dev, a.stat().st_ino),
                                    (b.stat().st_dev, b.stat().st_ino))
                self.assertEqual(b.stat().st_nlink, 1)
                self.assertEqual(b.read_bytes(), rewritten.get(p, a.read_bytes()))
                self.assertEqual(a.stat().st_mode, b.stat().st_mode)
            elif item['kind'] == 'symlink':
                self.assertEqual(os.readlink(a), os.readlink(b))
        before.write_bytes(b'fixture source changed AFTER verification')
        self.assertNotEqual((self.dest / self.shims[0]['path']).read_bytes(), before.read_bytes())
        self.assertEqual(copier.digest(original), self.shims[0]['before_sha256'])
        for p, value in self.metadata.items():
            self.assertEqual(copier.digest((self.dest / p).read_bytes()), value)

    def test_existing_output_refused_without_changes(self):
        p = self.dest / 'node_modules'
        p.mkdir()
        (p / 'partial').write_bytes(b'keep')
        with self.assertRaises(copier.Refusal): self.run_copy()
        self.assertEqual((p / 'partial').read_bytes(), b'keep')

    def test_dangling_existing_output_refused(self):
        (self.dest / 'node_modules').symlink_to('missing')
        with self.assertRaises(copier.Refusal): self.run_copy()
        self.assertEqual(os.readlink(self.dest / 'node_modules'), 'missing')

    def test_changed_source_hash(self):
        (self.source / 'node_modules/payload/bin/tool.js').write_bytes(b'changed')
        self.rejected()

    def test_changed_source_mode(self):
        (self.source / 'node_modules/payload/bin/tool.js').chmod(0o600)
        self.rejected()

    def test_added_source_file(self):
        (self.source / 'node_modules/unrecorded').write_bytes(b'extra')
        self.rejected()

    def test_missing_source_file(self):
        (self.source / 'node_modules/payload/bin/tool.js').unlink()
        self.rejected()

    def test_source_shared_hardlink(self):
        os.link(self.source / 'node_modules/payload/bin/tool.js', self.area / 'shared')
        self.rejected()

    def test_absolute_symlink(self):
        p = self.source / 'node_modules/alias'
        p.unlink(); p.symlink_to(str(self.source / 'node_modules/payload'))
        self.rejected()

    def test_escaping_relative_symlink(self):
        p = self.source / 'node_modules/alias'
        p.unlink(); p.symlink_to('../../outside')
        self.rejected()

    def test_symlink_chain_escape(self):
        (self.source / 'node_modules/alias').unlink()
        (self.source / 'node_modules/alias').symlink_to('payload/foreign')
        (self.source / 'node_modules/payload/foreign').symlink_to('../../../outside')
        self.area.joinpath('outside').mkdir()
        self.rejected()

    def workspace_link(self):
        (self.source / 'workspace-target').mkdir()
        (self.source / 'workspace-target/file').write_bytes(b'tracked fixture source')
        (self.source / 'node_modules/workspace').symlink_to('../workspace-target')
        with copier.root(str(self.source)) as fd:
            self.contract['entries'] = list(copier.scan(fd, self.trees).values())

    def test_future_destination_workspace_link_escape(self):
        self.workspace_link()
        (self.area / 'outside').mkdir()
        (self.dest / 'workspace-target').symlink_to('../outside')
        self.rejected()

    def test_workspace_link_to_existing_destination_source(self):
        self.workspace_link()
        (self.dest / 'workspace-target').mkdir()
        (self.dest / 'workspace-target/file').write_bytes(b'tracked fixture source')
        self.run_copy()
        self.assertEqual((self.dest / 'node_modules/workspace/file').read_bytes(),
                         b'tracked fixture source')

    def test_source_change_during_read(self):
        original = copier.os.read
        changed = False
        def mutate(fd, amount):
            nonlocal changed
            data = original(fd, amount)
            if not changed and data:
                changed = True
                os.fchmod(fd, 0o600)
            return data
        with patch.object(copier.os, 'read', mutate):
            self.rejected()

    def test_symlink_cycle(self):
        p = self.source / 'node_modules/alias'
        p.unlink(); p.symlink_to('alias')
        self.rejected()

    def test_source_tree_symlink(self):
        self.source.rename(self.area / 'moved')
        self.source.symlink_to(self.area / 'moved', target_is_directory=True)
        self.rejected()

    def test_destination_parent_symlink(self):
        (self.dest / 'packages').rename(self.dest / 'moved')
        (self.dest / 'packages').symlink_to('moved', target_is_directory=True)
        self.rejected()

    def test_special_file(self):
        os.mkfifo(self.source / 'node_modules/pipe')
        self.rejected()

    def test_unknown_shim_with_updated_inventory_hash(self):
        p = self.shims[0]['path']; f = self.source / p
        f.write_bytes(f.read_bytes().replace(b'"$@"', b'"changed-arguments"'))
        for e in self.contract['entries']:
            if e['path'] == p:
                e['sha256'] = copier.digest(f.read_bytes()); e['bytes'] = f.stat().st_size
                self.shims[0]['before_sha256'] = e['sha256']
        self.rejected()

    def test_wrong_recorded_spans(self):
        self.shims[0]['spans'][0]['start'] += 1
        self.rejected()

    def test_wrong_relocation_count(self):
        self.contract['prefix_count'] += 1
        self.rejected()

    def test_duplicate_shim(self):
        self.shims.append(copy.deepcopy(self.shims[0]))
        self.rejected()

    def test_missing_shim(self):
        self.shims.pop()
        self.rejected()

    def test_metadata_edit_refused(self):
        self.contract['metadata']['node_modules/.modules.yaml'] = '0' * 64
        self.rejected()

    def test_overlapping_roots(self):
        with self.assertRaises(copier.Refusal):
            copier.plan(str(self.source), str(self.source / 'nested'), self.contract)

    def test_out_of_scope_entry(self):
        self.contract['entries'].append({'path': '../foreign', 'kind': 'file', 'mode': '0o600'})
        self.rejected()

    def test_exclusive_creation_race_retains_existing_bytes(self):
        original = copier.read_file
        first = self.source / 'node_modules/.bin/tool-0'
        def race(fd, name):
            data, st = original(fd, name)
            target = self.dest / 'node_modules/.bin/tool-0'
            if name == first.name and target.parent.exists() and not target.exists():
                target.write_bytes(b'concurrent fixture evidence')
            return data, st
        with patch.object(copier, 'read_file', race):
            with self.assertRaises(FileExistsError): self.run_copy()
        self.assertEqual((self.dest / 'node_modules/.bin/tool-0').read_bytes(),
                         b'concurrent fixture evidence')

    def test_write_failure_retains_partial_no_retry(self):
        with patch.object(copier.os, 'write', side_effect=OSError('synthetic failure')):
            with self.assertRaises(OSError): self.run_copy()
        self.assertTrue((self.dest / 'node_modules').is_dir())
        with self.assertRaises(copier.Refusal): self.run_copy()


if __name__ == '__main__':
    unittest.main(verbosity=2)
