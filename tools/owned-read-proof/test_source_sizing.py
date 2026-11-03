"""Synthetic packets and owned temporary files only; no launcher or live proof."""
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import controlled_supervisor as subject


class SourceSizing(unittest.TestCase):
    def test_sparse_oversize_and_remaining_refuse_before_open(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'asset'
            with path.open('wb') as stream:
                stream.truncate(subject.RUNTIME_ASSET_LIMIT + 1)
            with patch.object(subject.os, 'open', side_effect=AssertionError('read')):
                with self.assertRaisesRegex(RuntimeError, 'type/size'):
                    subject.immutable(path, 'runtime')
            path.write_bytes(b'four')
            with patch.object(subject.os, 'open', side_effect=AssertionError('read')):
                with self.assertRaisesRegex(RuntimeError, 'aggregate'):
                    subject.immutable(path, 'runtime', remaining=3)

    def test_regular_capture_preserves_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'asset'
            path.write_bytes(b'\x00\xfforiginal')
            result = subject.immutable(path, 'image')
            self.assertEqual(bytes.fromhex(result['hex']), path.read_bytes())
            self.assertEqual(result['sha256'], subject.digest(path.read_bytes()))

    def test_symlink_and_fifo_refuse_before_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'target').write_bytes(b'private')
            (root / 'link').symlink_to(root / 'target')
            os.mkfifo(root / 'fifo')
            for name in ('link', 'fifo'):
                with self.assertRaisesRegex(RuntimeError, 'type/size'):
                    subject.immutable(root / name, 'image')

    def test_runtime_count_and_aggregate_precede_capture(self):
        with patch.object(subject, 'runtime_paths', return_value=set(map(str, range(33)))), patch.object(subject, 'immutable', side_effect=AssertionError('capture')):
            with self.assertRaisesRegex(RuntimeError, 'count'):
                subject.runtime_originals('unused')
        with patch.object(subject, 'runtime_paths', return_value={'a', 'b', 'c'}), patch.object(subject, 'source_size', return_value=(SimpleNamespace(st_size=subject.RUNTIME_ASSET_LIMIT), 0)), patch.object(subject, 'immutable', side_effect=AssertionError('capture')):
            with self.assertRaisesRegex(RuntimeError, 'aggregate'):
                subject.runtime_originals('unused')

    def test_stream_matches_escaped_canonical_json_with_bounded_tokens(self):
        value = {'hex': 'ab' * 100000, 'escaped': '\n"\\é😀\x00' * 20000,
                 'nested': [None, True, False, 17, -2.5, {'ключ': '值'}]}
        chunks = list(subject.original_chunks(value))
        self.assertLessEqual(max(map(len, chunks)), 12 * 16384)
        self.assertEqual(b''.join(chunks), subject.encoded(value).encode())
        self.assertEqual(json.loads(b''.join(chunks)), value)

    def test_packet_refuses_mutation_truncation_suffix_and_overflow(self):
        value = {'hex': 'ab' * 100000}
        data = subject.encoded(value).encode()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'packet'
            path.write_bytes(data)
            self.assertEqual(subject.original_packet_check(path, value, len(data)), subject.digest(data))
            for changed in (data[:-1], data + b' ', data.replace(b'ab', b'cd', 1)):
                path.write_bytes(changed)
                with self.assertRaises(RuntimeError):
                    subject.original_packet_check(path, value, len(data))
            path.write_bytes(data)
            with self.assertRaisesRegex(RuntimeError, 'bound'):
                subject.original_packet_check(path, value, len(data) - 1)

    def test_growth_beyond_remaining_refuses_without_oversized_read(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'asset'
            path.write_bytes(b'ab')
            with patch.object(subject.os, 'read', return_value=b'abc') as read:
                with self.assertRaisesRegex(RuntimeError, 'grew beyond'):
                    subject.immutable(path, 'image', remaining=2)
                self.assertEqual(read.call_args.args[1], 3)

    def test_source_replacement_during_open_refuses(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'asset'
            path.write_bytes(b'ab')
            real_open = os.open
            def replaced(*args, **kwargs):
                path.unlink()
                path.write_bytes(b'cd')
                return real_open(*args, **kwargs)
            with patch.object(subject.os, 'open', side_effect=replaced):
                with self.assertRaisesRegex(RuntimeError, 'changed before read'):
                    subject.immutable(path, 'image')

    def test_writer_refuses_invalid_metadata_before_truncation(self):
        value = {'immutable': {}, 'unexpected': 'private'}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'packet'
            path.write_bytes(b'prior evidence')
            with self.assertRaisesRegex(RuntimeError, 'unknown originals'):
                subject.write_original_packet(path, value)
            self.assertEqual(path.read_bytes(), b'prior evidence')

    def test_writer_streams_exact_bytes(self):
        data = b'ab' * 100000
        value = {'immutable': {'synthetic': {'identity': [1, 2, 3, 4, 5],
                 'hex': data.hex(), 'sha256': subject.digest(data), 'family': 'image'}},
                 'base': '/synthetic', 'phases': [{'name': 'quote"é', 'token': 'synthetic'}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'packet'
            subject.write_original_packet(path, value)
            self.assertEqual(path.read_bytes(), subject.encoded(value).encode())
