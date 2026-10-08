"""Synthetic ZIPs only: no extracted files, executable payloads or Apple tools."""

from dataclasses import replace
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import random
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
import zlib


REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "tools/packaged-mac/archive-containment.py"
SOURCE = REPO / "tools/deploy/tests/native-mac/fixtures/valid"
spec = importlib.util.spec_from_file_location("archive_containment", SCRIPT)
containment = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = containment
spec.loader.exec_module(containment)
sha = lambda data: hashlib.sha256(data).hexdigest()


class ContainmentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="orca-zip-β-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "delivery with spaces α"
        self.root.mkdir()
        self.manifest = json.loads((SOURCE / "delivery/native-mac-artifact.json").read_bytes())
        self.build_id = self.manifest["identity"]["buildId"]
        self.source_commit = self.manifest["identity"]["sourceCommit"]
        self.zip_record = next(r for r in self.manifest["artifacts"] if r["format"] == "zip")
        self.zip_path = self.root / self.zip_record["path"]
        self.members = [
            (containment.IDENTITY, (SOURCE / containment.IDENTITY).read_bytes(), "file"),
            (containment.PLIST, (SOURCE / containment.PLIST).read_bytes(), "file"),
            ("ORCA.app/Contents/Resources/daemon/orca-daemon.mjs",
             (SOURCE / "ORCA.app/Contents/Resources/daemon/orca-daemon.mjs.txt").read_bytes(), "file"),
        ]
        self.extras = {}
        self.write_zip()

    def save_manifest(self):
        (self.root / containment.delivery.MANIFEST).write_text(json.dumps(self.manifest) + "\n", encoding="utf-8")

    def bind_zip(self):
        data = self.zip_path.read_bytes()
        self.zip_record.update(sha256=sha(data), bytes=len(data))
        self.save_manifest()

    def write_zip(self, compression=zipfile.ZIP_DEFLATED):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.zip_path, "w") as archive:
                for name, data, kind in self.members:
                    info = zipfile.ZipInfo(name)
                    info.create_system = 3
                    mode = {"file": stat.S_IFREG | 0o644, "directory": stat.S_IFDIR | 0o755,
                            "link": stat.S_IFLNK | 0o777, "fifo": stat.S_IFIFO | 0o644}[kind]
                    info.external_attr = mode << 16
                    info.compress_type = compression
                    info.extra = self.extras.get(name, b"")
                    archive.writestr(info, data)
        self.bind_zip()

    def change_member(self, name, data=None, kind=None):
        self.members = [(n, d if data is None else data, k if kind is None else kind)
                        if n == name else (n, d, k) for n, d, k in self.members]

    def raw_zip(self, records=None, indexed=None, prefix=b"", gaps=None, comment=b""):
        """Independent record writer: permit malicious lengths, streams and gaps.

        Every call rebinds the external digest/size; only the inner framing/payload
        checks can reject the forged records. This never writes extracted members.
        """
        if records is None:
            records = [{"name": n, "data": d} for n, d, _ in self.members]
        body, central = bytearray(prefix), []
        for i, record in enumerate(records):
            body.extend((gaps or {}).get(i, b""))
            offset = len(body)
            name = record["name"].encode("utf-8")
            data = record["data"]
            claimed = record.get("claimed", data)
            method = record.get("method", zipfile.ZIP_STORED)
            if method == zipfile.ZIP_DEFLATED:
                compressor = zlib.compressobj(wbits=-15)
                encoded = compressor.compress(data) + compressor.flush()
            else:
                encoded = data
            encoded = record.get("encoded", encoded)
            descriptor = record.get("descriptor", False)
            flags = 0x800 | (8 if descriptor else 0)
            crc, compressed, uncompressed = zlib.crc32(claimed), len(encoded), len(claimed)
            body.extend(struct.pack("<4s5H3I2H", b"PK\x03\x04", 20, flags, method, 0, 0,
                                    0 if descriptor else crc, 0 if descriptor else compressed,
                                    0 if descriptor else uncompressed, len(name), 0))
            body.extend(name + encoded)
            if descriptor:
                body.extend((b"PK\x07\x08" if descriptor == "signed" else b"")
                            + struct.pack("<3I", crc, compressed, uncompressed))
            header = struct.pack("<4s6H3I5H2I", b"PK\x01\x02", (3 << 8) | 20, 20, flags,
                                 method, 0, 0, crc, compressed, uncompressed, len(name), 0, 0, 0, 0,
                                 (stat.S_IFREG | 0o644) << 16, offset)
            central.append(header + name)
        body.extend((gaps or {}).get(len(records), b""))
        central_offset = len(body)
        selected = list(range(len(records))) if indexed is None else indexed
        directory = b"".join(central[i] for i in selected)
        body.extend(directory)
        body.extend(struct.pack("<4s4H2IH", b"PK\x05\x06", 0, 0, len(selected), len(selected),
                                len(directory), central_offset, len(comment)) + comment)
        self.zip_path.write_bytes(body)
        self.bind_zip()

    def raw_records(self):
        return [{"name": n, "data": d} for n, d, _ in self.members]

    def check(self, **kwargs):
        return containment.validate_archive(self.root, self.build_id, self.source_commit, **kwargs)

    def fails(self, message, **kwargs):
        with self.assertRaisesRegex((containment.InvalidArchive, zipfile.BadZipFile), message):
            self.check(**kwargs)

    def cli(self, *args):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *map(str, args)],
                              capture_output=True, text=True, timeout=10)

    def fixture_args(self):
        return ["--mode", "fixture", "--build-id", self.build_id,
                "--source-commit", self.source_commit, self.root]

    def test_valid_stored_and_deflated_implicit_and_explicit_directories(self):
        for compression in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            for explicit in (False, True):
                with self.subTest(compression=compression, explicit=explicit):
                    self.members = [m for m in self.members if m[2] != "directory"]
                    if explicit:
                        self.members += [("ORCA.app/", b"", "directory"),
                                         ("ORCA.app/Contents/", b"", "directory")]
                    self.write_zip(compression)
                    result = self.check()
                    self.assertEqual(result["archiveSha256"], self.zip_record["sha256"])
                    self.assertEqual(result["appRoot"], "ORCA.app")
                    self.assertEqual(result["members"], len(self.members))

    def test_spaces_unicode_helpers_and_appledouble_metadata(self):
        self.members += [("ORCA.app/Contents/Resources/with spaces/日本語 α.txt", b"synthetic", "file"),
                         ("ORCA.app/Contents/Frameworks/ORCA Helper.app/Contents/fixture", b"stub", "file"),
                         ("__MACOSX/ORCA.app/Contents/._Info.plist", b"synthetic metadata", "file")]
        self.write_zip()
        self.check()

    def test_legitimate_electron_framework_links_resolve_through_current(self):
        framework = "ORCA.app/Contents/Frameworks/Electron Framework.framework/"
        self.members += [(framework + "Versions/A/Electron Framework", b"synthetic", "file"),
                         (framework + "Versions/A/Resources/fixture", b"data", "file"),
                         (framework + "Versions/Current", b"A", "link"),
                         (framework + "Electron Framework", b"Versions/Current/Electron Framework", "link"),
                         (framework + "Resources", b"Versions/Current/Resources", "link"),
                         (framework + "Versions/A/Resources/internal", b"../Electron Framework", "link")]
        self.write_zip()
        self.check()

    def test_cli_reports_only_fixture_containment_and_exact_binding(self):
        before = sorted(p.relative_to(self.root) for p in self.root.rglob("*"))
        result = self.cli(*self.fixture_args())
        self.assertEqual(result.returncode, 0, result.stderr)
        for text in ("PASS (fixture ZIP containment only)", self.build_id, self.source_commit,
                     self.zip_record["sha256"], containment.UNRUN):
            self.assertIn(text, result.stdout)
        self.assertEqual(before, sorted(p.relative_to(self.root) for p in self.root.rglob("*")))

    def test_candidate_mode_refused_before_inputs_and_candidate_kind_refused(self):
        result = self.cli("--mode", "candidate", "/nonexistent/input")
        self.assertEqual(result.returncode, 2)
        self.assertIn(containment.delivery.FIXTURE_ONLY, result.stderr)
        self.manifest["kind"] = "candidate"
        self.save_manifest()
        self.fails("production-candidate verification is unsupported")

    def test_cli_selection_is_mandatory_and_usage_is_closed(self):
        for args in (["--mode", "fixture", self.root], ["--mode", "fixture", "--build", self.build_id],
                     ["--unknown"], []):
            with self.subTest(args=args):
                result = self.cli(*args)
                self.assertEqual(result.returncode, 2)
                self.assertNotIn("PASS", result.stdout)

    def test_selection_identity_and_archive_filename_are_not_inferred(self):
        for field in ("build_id", "source_commit"):
            with self.subTest(field=field):
                original = getattr(self, field)
                setattr(self, field, "wrong")
                self.fails("selected .* mismatch")
                setattr(self, field, original)
        self.zip_record["path"] = "ORCA-wrong-mac-arm64.zip"
        self.save_manifest()
        self.fails("filename/version mismatch")

    def test_exact_identity_bytes_are_hashed_without_reserialization(self):
        original = next(d for n, d, _ in self.members if n == containment.IDENTITY)
        self.change_member(containment.IDENTITY, original + b" \n")
        self.write_zip()
        self.fails("identitySha256: byte digest mismatch")
        self.manifest["identitySha256"] = sha(original + b" \n")
        self.save_manifest()
        self.check()

    def test_identity_object_substitution_and_boolean_protocol(self):
        for field, value in (("sourceCommit", "f" * 40), ("protocol", {"major": True, "minor": 9}),
                             ("arch", "x64"), ("bundleId", "wrong.id")):
            with self.subTest(field=field):
                identity = {**self.manifest["identity"], field: value}
                data = json.dumps(identity).encode()
                self.change_member(containment.IDENTITY, data)
                self.manifest["identitySha256"] = sha(data)
                self.write_zip()
                self.fails("identity mismatch|expected integer|expected arm64|expected com.schadewitz.orca")

    def test_daemon_substitution_is_not_hidden_by_rebinding_zip(self):
        self.change_member("ORCA.app/Contents/Resources/daemon/orca-daemon.mjs", b"changed")
        self.write_zip()
        self.fails("archived daemon: digest mismatch")

    def test_plist_fields_compared_verbatim_and_no_os_policy_inferred(self):
        original = plistlib.loads(next(d for n, d, _ in self.members if n == containment.PLIST))
        for key, value in (("CFBundleIdentifier", "wrong.id"), ("CFBundleShortVersionString", "0.0"),
                           ("CFBundleVersion", "7.2"), ("CFBundleVersion", 7), ("LSMinimumSystemVersion", "99")):
            with self.subTest(key=key, value=value):
                self.change_member(containment.PLIST, plistlib.dumps({**original, key: value}))
                self.write_zip()
                self.fails("verbatim mismatch")
        self.manifest["minimumMacOS"] = "99.42"
        self.change_member(containment.PLIST, plistlib.dumps({**original, "LSMinimumSystemVersion": "99.42"}))
        self.write_zip()
        self.check()  # Equality is not a chosen supported floor.

    def test_protocol_and_opaque_bundle_versions_are_not_pinned(self):
        identity = self.manifest["identity"]
        identity.update(protocol={"major": 17, "minor": 0}, bundleVersion="opaque α 0007")
        data = json.dumps(identity).encode()
        self.manifest["identitySha256"] = sha(data)
        self.change_member(containment.IDENTITY, data)
        plist = plistlib.loads(next(d for n, d, _ in self.members if n == containment.PLIST))
        self.change_member(containment.PLIST, plistlib.dumps({**plist, "CFBundleVersion": identity["bundleVersion"]}))
        self.write_zip()
        self.check()

    def test_missing_resources_and_wrong_app_roots(self):
        original = list(self.members)
        for name in (containment.IDENTITY, containment.PLIST, original[2][0]):
            with self.subTest(name=name):
                self.members = [m for m in original if m[0] != name]
                self.write_zip()
                self.fails("missing/nonregular required member")
        for prefix in ("wrapper/ORCA.app", "Other.app", "orca.app"):
            with self.subTest(prefix=prefix):
                self.members = [(n.replace("ORCA.app", prefix), d, k) for n, d, k in original]
                self.write_zip()
                self.fails("wrong app root")

    def test_duplicate_member_and_case_unicode_ambiguities(self):
        original = list(self.members)
        cases = [(original[0],),
                 (("ORCA.app/contents/extra", b"", "file"),),
                 (("ORCA.app/Contents/Resources/café", b"", "file"),
                  ("ORCA.app/Contents/Resources/cafe\u0301", b"", "file")),
                 (("ORCA.app/Contents/Resources/straße", b"", "file"),
                  ("ORCA.app/Contents/Resources/STRASSE", b"", "file")),
                 (("ORCA.app/Contents/Info.plist/", b"", "directory"),)]
        for extras in cases:
            with self.subTest(extras=extras):
                self.members = original + list(extras)
                self.write_zip()
                self.fails("duplicate member|ambiguity")

    def test_traversal_absolute_backslash_drive_empty_and_control_paths(self):
        original = list(self.members)
        for name in ("../ORCA.app/f", "/ORCA.app/f", "ORCA.app/../f", "ORCA.app//f", "ORCA.app/./f",
                     "C:/ORCA.app/f", "ORCA.app/Contents\\f", "ORCA.app/Contents/f\n"):
            with self.subTest(name=name):
                self.members = original + [(name, b"", "file")]
                self.write_zip()
                self.fails("unsafe path|characters")

    def test_nul_name_in_central_directory_rejected(self):
        self.members.append(("ORCA.app/Contents/Resources/nulX", b"", "file"))
        self.write_zip(zipfile.ZIP_STORED)
        self.zip_path.write_bytes(self.zip_path.read_bytes().replace(b"nulX", b"nul\x00"))
        self.bind_zip()
        self.fails("NUL/truncated")

    def test_file_or_link_ancestor_cannot_substitute_resources(self):
        for kind in ("file", "link"):
            with self.subTest(kind=kind):
                self.members.append(("ORCA.app/Contents/Resources", b"alternate", kind))
                self.write_zip()
                self.fails("ancestor or directory collision")
                self.members.pop()

    def test_required_member_symlink_substitution_is_refused(self):
        for name in (containment.IDENTITY, containment.PLIST, self.members[2][0]):
            with self.subTest(name=name):
                original = list(self.members)
                self.change_member(name, b"fixture", "link")
                self.write_zip()
                self.fails("missing/nonregular required member")
                self.members = original

    def test_symlink_escape_absolute_drive_backslash_and_malformed_targets(self):
        original = list(self.members)
        for target in (b"../../../outside", b"../../__MACOSX/fixture", b"/ORCA.app/Contents", b"C:/outside",
                       b"..\\outside", b"", b"../\x00outside", b"\xff", b"../Contents//Info.plist"):
            with self.subTest(target=target):
                self.members = original + [("ORCA.app/Contents/alias", target, "link")]
                self.write_zip()
                result = self.cli(*self.fixture_args())
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertNotIn("Traceback", result.stderr)
                self.assertNotIn("PASS", result.stdout)

    def test_symlink_cycles_dangling_and_file_ancestor_targets(self):
        original = list(self.members)
        for links in ([("a", b"a"), ("b", b"a")], [("a", b"b"), ("b", b"a")],
                      [("a", b"missing")], [("a", b"Info.plist/child")]):
            with self.subTest(links=links):
                self.members = original + [("ORCA.app/Contents/" + n, d, "link") for n, d in links]
                self.write_zip()
                self.fails("cycle/hop|dangling|non-directory")

    def test_symlink_escape_via_linked_ancestor_is_not_lexically_normalized_away(self):
        self.members += [("ORCA.app/Contents/alias", b"..", "link"),
                         ("ORCA.app/Contents/escape", b"alias/../outside", "link")]
        self.write_zip()
        self.fails("symlink escapes app")

    def test_nonregular_members_and_directory_payloads_refused(self):
        original = list(self.members)
        for extra in (("ORCA.app/Contents/fifo", b"", "fifo"),
                      ("ORCA.app/Contents/payload/", b"payload", "directory"),
                      ("__MACOSX/link", b"ORCA.app", "link")):
            with self.subTest(extra=extra):
                self.members = original + [extra]
                self.write_zip()
                self.fails("unsupported member type|directory has payload|invalid symlink")

    def test_archive_hash_and_size_are_bound_before_parsing(self):
        data = self.zip_path.read_bytes()
        for changed, message in ((data + b"x", "size mismatch"), (b"!" + data[1:], "digest mismatch")):
            with self.subTest(message=message):
                self.zip_path.write_bytes(changed)
                self.fails(message)

    def test_truncated_non_zip_and_trailing_bytes_fail_after_rebinding_hash(self):
        data = self.zip_path.read_bytes()
        for changed in (b"not a ZIP", data[:-1], data[:-22], data + b"trailing"):
            with self.subTest(size=len(changed)):
                self.zip_path.write_bytes(changed)
                self.bind_zip()
                result = self.cli(*self.fixture_args())
                self.assertEqual(result.returncode, 1)
                self.assertNotIn("Traceback", result.stderr)

    def test_crc_invalid_unobserved_resource_is_also_rejected(self):
        self.members.append(("ORCA.app/Contents/Resources/extra", b"CRC synthetic sentinel", "file"))
        self.write_zip(zipfile.ZIP_STORED)
        data = self.zip_path.read_bytes().replace(b"CRC synthetic sentinel", b"BAD synthetic sentinel")
        self.zip_path.write_bytes(data)
        self.bind_zip()
        self.fails("CRC")

    def test_local_header_name_substitution_and_overlap_are_rejected(self):
        self.write_zip(zipfile.ZIP_STORED)
        original = self.zip_path.read_bytes()
        self.zip_path.write_bytes(original.replace(b"orca-build.json", b"other-file.json", 1))
        self.bind_zip()
        self.fails("differ")
        self.zip_path.write_bytes(original)
        central = original.find(b"PK\x01\x02")
        changed = bytearray(original)
        struct.pack_into("<I", changed, central + 20, 100000)
        self.zip_path.write_bytes(changed)
        self.bind_zip()
        self.fails("Overlapped|overlap")

    def test_split_zip_zip64_and_forged_central_counts_are_refused(self):
        original = self.zip_path.read_bytes()
        end = original.rfind(b"PK\x05\x06")
        for offset, value, message in ((4, 1, "split"), (8, 65535, "split|ZIP64"),
                                       (10, 1, "split")):
            with self.subTest(offset=offset):
                data = bytearray(original)
                struct.pack_into("<H", data, end + offset, value)
                self.zip_path.write_bytes(data)
                self.bind_zip()
                self.fails(message)
        data = bytearray(original)
        struct.pack_into("<HH", data, end + 8, 1, 1)
        self.zip_path.write_bytes(data)
        self.bind_zip()
        self.fails("member count")
        struct.pack_into("<HH", data, end + 8, 65535, 65535)
        self.zip_path.write_bytes(data)
        self.bind_zip()
        self.fails("ZIP64")

    def test_unsupported_compression_and_encryption_refused_before_read(self):
        self.write_zip(zipfile.ZIP_BZIP2)
        self.fails("unsupported ZIP compression")
        self.write_zip()
        data = bytearray(self.zip_path.read_bytes())
        central = data.find(b"PK\x01\x02")
        struct.pack_into("<H", data, central + 8, 1)
        self.zip_path.write_bytes(data)
        self.bind_zip()
        self.fails("encrypted")

    def test_unicode_path_extra_fields_cannot_supply_alternate_names(self):
        import zlib

        encoded = containment.IDENTITY.encode()
        payload = b"\x01" + struct.pack("<I", zlib.crc32(encoded)) + encoded
        self.extras[containment.IDENTITY] = struct.pack("<HH", 0x7075, len(payload)) + payload
        self.write_zip()
        self.check()
        original = self.zip_path.read_bytes()
        changed = bytearray(original)
        changed[30 + len(encoded) + 9] = ord("X")  # Local extra only; same-sized Unicode override.
        self.zip_path.write_bytes(changed)
        self.bind_zip()
        self.fails("ambiguous Unicode path")
        self.extras[containment.IDENTITY] = struct.pack("<HH", 0x7075, len(payload)) + payload[:-1] + b"X"
        self.write_zip()
        self.fails("ambiguous Unicode path")

    def test_streaming_data_descriptors_and_malformed_descriptors(self):
        class Unseekable(io.BytesIO):
            def seek(self, *args):
                raise OSError("synthetic streaming writer")

        output = Unseekable()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data, _ in self.members:
                archive.writestr(name, data)
        original = output.getvalue()
        self.zip_path.write_bytes(original)
        self.bind_zip()
        self.check()
        changed = bytearray(original)
        descriptor = original.find(b"PK\x07\x08")
        changed[descriptor + 4] ^= 1
        self.zip_path.write_bytes(changed)
        self.bind_zip()
        self.fails("invalid ZIP data descriptor")

    def test_forged_daemon_prefix_size_and_crc_refused_for_both_methods(self):
        for method in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            with self.subTest(method=method):
                records = self.raw_records()
                original = records[2]["data"]
                records[2].update(data=original + b"synthetic unverified substitution", claimed=original, method=method)
                self.raw_zip(records)
                self.fails("stored payload size mismatch|actual payload size mismatch")
                result = self.cli(*self.fixture_args())
                self.assertEqual(result.returncode, 1)
                self.assertNotIn("PASS", result.stdout)

    def test_forged_identity_prefix_does_not_bypass_metadata_budget(self):
        records = self.raw_records()
        original = records[0]["data"]
        records[0].update(data=original + b" " * 8192, claimed=original, method=zipfile.ZIP_DEFLATED)
        self.raw_zip(records)
        self.fails("actual payload size mismatch", limits=replace(containment.Limits(), metadata_bytes=4000))

    def test_deflate_missing_terminal_block_is_refused_despite_expected_output(self):
        records = self.raw_records()
        compressor = zlib.compressobj(wbits=-15)
        encoded = compressor.compress(records[2]["data"]) + compressor.flush()
        self.assertEqual(encoded[0] & 1, 1)  # Deterministic single final block.
        unterminated = bytes([encoded[0] & ~1]) + encoded[1:]
        decoder = zlib.decompressobj(-15)
        self.assertEqual(decoder.decompress(unterminated), records[2]["data"])
        self.assertFalse(decoder.eof)
        records[2].update(method=zipfile.ZIP_DEFLATED, encoded=unterminated)
        self.raw_zip(records)
        self.fails("unterminated.*DEFLATE")

    def test_deflate_trailing_bytes_concatenation_and_short_output_are_refused(self):
        records = self.raw_records()
        data = records[2]["data"]
        compressor = zlib.compressobj(wbits=-15)
        encoded = compressor.compress(data) + compressor.flush()
        for payload in (encoded + b"hidden synthetic bytes", encoded + encoded, encoded[:-1]):
            with self.subTest(payload_size=len(payload)):
                records[2].update(method=zipfile.ZIP_DEFLATED, encoded=payload)
                self.raw_zip(records)
                self.fails("unused/trailing|unterminated|actual payload size mismatch")

    def test_forged_unused_resource_size_does_not_bypass_full_crc_or_total_checks(self):
        records = self.raw_records() + [{"name": "ORCA.app/Contents/Resources/unused",
                                      "data": b"prefix" + b"x" * 131072, "claimed": b"prefix",
                                      "method": zipfile.ZIP_DEFLATED}]
        self.raw_zip(records)
        limits = replace(containment.Limits(), total_bytes=sum(len(r.get("claimed", r["data"])) for r in records))
        self.fails("actual payload resource byte limit|actual payload size mismatch", limits=limits)

    def test_raw_decoder_enforces_all_actual_budgets_with_bounded_output(self):
        # Exercise resource processing directly as well as early declared-size checks.
        data = b"a" * 131072
        compressor = zlib.compressobj(wbits=-15)
        encoded = compressor.compress(data) + compressor.flush()
        for method, payload in ((zipfile.ZIP_STORED, data), (zipfile.ZIP_DEFLATED, encoded)):
            with self.subTest(method=method):
                info = zipfile.ZipInfo("bounded-fixture")
                info.compress_type, info.compress_size, info.file_size = method, len(payload), len(data)
                info.CRC = zlib.crc32(data)
                for budget in (0, 4096, 65536, len(data) - 1):
                    seen = 0
                    with self.assertRaisesRegex(containment.InvalidArchive, "actual payload resource byte limit"):
                        for chunk in containment.payload_chunks(io.BytesIO(payload), info, 0, budget):
                            self.assertLessEqual(len(chunk), 65536)
                            seen += len(chunk)
                    self.assertLessEqual(seen, budget)

    def test_adjusted_prefix_and_unindexed_records_cannot_bypass_index(self):
        original = self.raw_records()
        for prefix in (b"synthetic prefix", b"PK\x03\x04synthetic padding"):
            with self.subTest(prefix=prefix):
                self.raw_zip(prefix=prefix)
                self.fails("unaccounted ZIP prefix/gap")
        for name in (original[2]["name"], "../outside-synthetic"):
            for position in (0, 1, 3):
                with self.subTest(name=name, position=position):
                    records = original.copy()
                    records.insert(position, {"name": name, "data": b"unindexed synthetic substitution"})
                    self.raw_zip(records, indexed=[i for i in range(4) if i != position])
                    self.fails("unaccounted ZIP prefix/gap")
                    result = self.cli(*self.fixture_args())
                    self.assertEqual(result.returncode, 1)
                    self.assertNotIn("Traceback", result.stderr)

    def test_interior_padding_and_last_gap_are_unsupported(self):
        for position in (1, 3):
            with self.subTest(position=position):
                self.raw_zip(gaps={position: b"synthetic unaccounted padding"})
                self.fails("unaccounted ZIP prefix/gap")

    def test_complete_supported_records_allow_reordered_index_and_descriptors(self):
        generator = random.Random(388)
        incompressible = bytes(generator.getrandbits(8) for _ in range(131072))
        for method in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            for descriptor in (False, "signed", "unsigned"):
                with self.subTest(method=method, descriptor=descriptor):
                    records = self.raw_records() + [
                        {"name": "ORCA.app/Contents/Resources/chunk-boundary", "data": b"a" * 131072},
                        {"name": "ORCA.app/Contents/Resources/empty", "data": b""},
                        {"name": "ORCA.app/Contents/Resources/input-boundary", "data": incompressible}]
                    for record in records:
                        record.update(method=method, descriptor=descriptor)
                    self.raw_zip(records, indexed=[5, 4, 1, 3, 0, 2], comment=b"bounded synthetic comment")
                    result = self.check()
                    self.assertEqual(result["uncompressedBytes"], sum(len(r["data"]) for r in records))

    def test_fixed_limits_cover_archive_central_count_member_total_and_metadata(self):
        with zipfile.ZipFile(self.zip_path) as archive:
            sizes = [info.file_size for info in archive.infolist()]
        cases = (("archive_bytes", self.zip_path.stat().st_size - 1, "archive byte limit"),
                 ("central_bytes", 1, "central directory byte limit"),
                 ("members", 2, "member count limit"),
                 ("member_bytes", max(sizes) - 1, "member decompression byte limit"),
                 ("total_bytes", sum(sizes) - 1, "total decompression byte limit"),
                 ("metadata_bytes", 1, "manifest byte limit"),
                 ("path_bytes", 1, "path byte limit"),
                 ("path_depth", 2, "path depth limit"),
                 ("nodes", 2, "directory/node limit"))
        for field, value, message in cases:
            with self.subTest(field=field):
                self.fails(message, limits=replace(containment.Limits(), **{field: value}))

    def test_member_metadata_cap_is_independent_of_manifest_cap(self):
        original = next(d for n, d, _ in self.members if n == containment.IDENTITY)
        self.change_member(containment.IDENTITY, original + b" " * 8000)
        self.write_zip()
        self.fails("metadata byte limit", limits=replace(containment.Limits(), metadata_bytes=4000))

    def test_decompression_ratio_and_symlink_limits(self):
        self.members.append(("ORCA.app/Contents/Resources/high-ratio", b"a" * 100000, "file"))
        self.write_zip()
        self.fails("compression ratio limit", limits=replace(containment.Limits(), ratio=10))
        self.members.pop()
        self.members.append(("ORCA.app/Contents/alias", b"Info.plist", "link"))
        self.write_zip()
        for limits, message in ((replace(containment.Limits(), symlinks=0), "symlink count limit"),
                                (replace(containment.Limits(), link_bytes=1), "symlink byte limit"),
                                (replace(containment.Limits(), link_hops=0), "cycle/hop limit")):
            with self.subTest(message=message):
                self.fails(message, limits=limits)

    def test_malformed_identity_plist_and_manifest_fail_cleanly(self):
        original = list(self.members)
        for name, data in ((containment.IDENTITY, b'{"schemaVersion":1,"schemaVersion":1}'),
                           (containment.IDENTITY, b"\xff"), (containment.IDENTITY, b"{"),
                           (containment.PLIST, b"bplist00broken"), (containment.PLIST, b"<plist><dict>")):
            with self.subTest(name=name, data=data):
                self.members = original.copy()
                self.change_member(name, data)
                if name == containment.IDENTITY:
                    self.manifest["identitySha256"] = sha(data)
                self.write_zip()
                result = self.cli(*self.fixture_args())
                self.assertEqual(result.returncode, 1)
                self.assertNotIn("Traceback", result.stderr)
        for data in (b'{"kind":"fixture","kind":"fixture"}', b"[]", b"NaN"):
            (self.root / containment.delivery.MANIFEST).write_bytes(data)
            result = self.cli(*self.fixture_args())
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("Traceback", result.stderr)

    def test_binary_plist_passes_and_amplifying_object_table_is_refused(self):
        plist = plistlib.loads(next(d for n, d, _ in self.members if n == containment.PLIST))
        data = plistlib.dumps(plist, fmt=plistlib.FMT_BINARY)
        self.change_member(containment.PLIST, data)
        self.write_zip()
        self.check()
        offset_size, ref_size, count, top, table = struct.unpack(">6xBBQQQ", data[-32:])
        for duplicate in (False, True):
            changed = bytearray(data)
            if duplicate:
                changed[table + offset_size:table + 2 * offset_size] = changed[table:table + offset_size]
            else:
                changed[-32:] = struct.pack(">6xBBQQQ", offset_size, ref_size, 2**63, top, table)
            self.change_member(containment.PLIST, bytes(changed))
            self.write_zip()
            self.fails("binary plist.*table|overlapping binary plist")

    def test_outer_manifest_contract_and_missing_evidence_references(self):
        for field, value in (("schemaVersion", 2), ("identity", None), ("artifacts", []),
                             ("evidence", []), ("identitySha256", "wrong")):
            with self.subTest(field=field):
                original = self.manifest[field]
                self.manifest[field] = value
                self.save_manifest()
                self.fails("unsupported schemaVersion|expected object|exactly one|not listed|invalid value")
                self.manifest[field] = original

    def test_static_filesystem_escape_and_nonregular_archive_refused(self):
        outside = Path(self.temporary.name) / "outside.zip"
        self.zip_path.rename(outside)
        self.zip_path.symlink_to(outside)
        self.fails("path escapes fixture root")
        self.zip_path.unlink()
        self.zip_path.mkdir()
        self.fails("not a regular file")


if __name__ == "__main__":
    unittest.main()
