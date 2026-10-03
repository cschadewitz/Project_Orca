"""Exercise the draft schema and fixture oracles, never a running ORCA installation."""

import copy
import json
import subprocess
import sys
import unittest

from validate import MAX_BYTES, ONE_SHOT_MAX_BYTES, ROOT, Rejected, export_bytes, read_bundle, validate_bytes


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.base = read_bundle(ROOT / "fixtures/valid/missing-data.json")

    def assert_rejected(self, raw, reason):
        with self.assertRaises(Rejected) as caught:
            validate_bytes(raw)
        self.assertEqual(str(caught.exception), reason)

    def test_exact_valid_bytes(self):
        for path in sorted((ROOT / "fixtures/valid").glob("*.json")):
            with self.subTest(fixture=path.name):
                raw = path.read_bytes()
                self.assertEqual(raw, export_bytes(validate_bytes(raw)))
                self.assertNotIn(b"SYNTHETIC_CANARY", raw)

    def test_cli_errors_do_not_echo_arguments(self):
        canary = "SYNTHETIC_CANARY_DO_NOT_EXPORT"
        fixture = str(ROOT / "fixtures/valid/startup-unknown.json")
        for arguments in (
            [], [fixture, "--" + canary], [fixture, canary],
            ["--help=" + canary], [canary, "--unexpected"],
        ):
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    [sys.executable, str(ROOT / "validate.py"), *arguments],
                    capture_output=True, text=True, timeout=10, check=False,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr, "BLOCKED: invalid_arguments\n")
        result = subprocess.run(
            [sys.executable, str(ROOT / "validate.py"), "--help"],
            capture_output=True, text=True, timeout=10, check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("usage: validate.py", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_invalid_bundles(self):
        semantic = {
            "dangling-alias": "dangling_alias", "outside-window": "event_order_or_window",
            "duplicate-alias": "duplicate_alias", "unobserved-claim": "unobserved_claim",
            "reused-identifier": "identifier_reuse", "duplicate-key": "duplicate_key",
            "nonfinite": "non_integer_number",
            "store-format-without-handshake": "unobserved_claim",
            "protected-state-without-handshake": "unobserved_claim",
            "protected-observation-without-handshake": "unobserved_claim",
        }
        for path in sorted((ROOT / "fixtures/invalid").iterdir()):
            with self.subTest(fixture=path.name):
                self.assert_rejected(path.read_bytes(), semantic.get(path.stem, "schema"))

    def test_privacy_injections(self):
        cases = json.loads((ROOT / "fixtures/privacy-cases.json").read_text())["cases"]
        for case in cases:
            with self.subTest(fixture=case["id"]):
                candidate = copy.deepcopy(self.base)
                target = candidate
                for key in case["injectAt"][:-1]:
                    target = target[key]
                value = case.get("value")
                if "repeat" in case:
                    value = case["repeat"]["text"] * case["repeat"]["count"]
                target[case["injectAt"][-1]] = value
                self.assert_rejected(export_bytes(candidate), case["expectedValidation"])
                self.assertEqual(case["sourcePolicy"], "exclude_without_read")
                self.assertEqual(case["runtimeStatus"], "not_run")

    def test_byte_ceiling_and_parser(self):
        raw = export_bytes(self.base)
        # The framing ceiling is checked before decoding; noncanonical whitespace
        # at exactly the ceiling reaches the serialization check, one byte more does not.
        self.assert_rejected(raw + b" " * (ONE_SHOT_MAX_BYTES - len(raw)), "noncanonical_bytes")
        self.assert_rejected(raw + b" " * (ONE_SHOT_MAX_BYTES - len(raw) + 1), "byte_limit")
        self.assert_rejected(raw + b" " * (MAX_BYTES - len(raw) + 1), "byte_limit")
        self.assert_rejected(b"\xff", "invalid_json")
        self.assert_rejected(b"[" * 2000 + b"]" * 2000, "nesting_limit")
        self.assert_rejected(b'"' + b"[" * 100 + b'"', "schema")
        self.assert_rejected(b'{"schemaVersion":1.0}', "non_integer_number")
        self.assert_rejected(b'{"schemaVersion":1e0}', "non_integer_number")
        self.assert_rejected(raw + b"{}", "invalid_json")

    def test_event_ceiling_order_and_aliases(self):
        event = {"offsetMs": 0, "phase": "unknown", "code": "unknown", "entityAlias": "unknown"}
        for mode, ceiling in (("one_shot", 32), ("rolling_snapshot", 4096)):
            candidate = copy.deepcopy(self.base)
            candidate.update(mode=mode, events=[event] * ceiling)
            if mode == "rolling_snapshot":
                candidate["coverage"] = dict(requestedWindowMs=300000, observedWindowMs=0,
                                             retainedWindowMs=0, capacityLimited=False)
            validate_bytes(export_bytes(candidate))
            candidate["events"].append(event)
            self.assert_rejected(export_bytes(candidate), "schema")
        candidate = copy.deepcopy(self.base)
        candidate.update(windowMs=2, events=[dict(event, offsetMs=2), dict(event, offsetMs=1)])
        self.assert_rejected(export_bytes(candidate), "event_order_or_window")
        candidate = copy.deepcopy(self.base)
        candidate["entities"] = [{"alias": f"e{i}", "kind": "run"} for i in range(1, 65)]
        validate_bytes(export_bytes(candidate))
        candidate["entities"].append({"alias": "e65", "kind": "run"})
        self.assert_rejected(export_bytes(candidate), "schema")

    def test_rolling_coverage_and_coordinated_profile(self):
        candidate = read_bundle(ROOT / "fixtures/valid/rolling.json")
        candidate["events"] = [dict(candidate["events"][0], code="startup_exited_before_handshake",
                                    phase="startup")] * 3000
        # Above BOTH old limits: every retained event still fits the new complete report.
        raw = export_bytes(candidate)
        self.assertGreater(len(raw), ONE_SHOT_MAX_BYTES)
        validate_bytes(raw)
        self.assert_rejected(raw + b" " * (MAX_BYTES - len(raw)), "noncanonical_bytes")
        self.assert_rejected(raw + b" " * (MAX_BYTES - len(raw) + 1), "byte_limit")
        for field in ("observedWindowMs", "retainedWindowMs"):
            changed = copy.deepcopy(candidate)
            changed["coverage"][field] -= 1
            self.assert_rejected(export_bytes(changed), "coverage")
        candidate["coverage"]["requestedWindowMs"] = 60000
        self.assert_rejected(export_bytes(candidate), "coverage")

    def test_observation_absence(self):
        for value in (False, "unknown"):
            for field in ("daemon", "daemonProtocol"):
                candidate = copy.deepcopy(self.base)
                candidate["evidence"]["handshake"] = value
                candidate["versions"][field] = "0.6.0" if field == "daemon" else {"major": 1, "minor": 10}
                self.assert_rejected(export_bytes(candidate), "unobserved_claim")

    def test_string_patterns_reject_trailing_newlines(self):
        candidate = copy.deepcopy(self.base)
        candidate["versions"]["app"] = "0.6.0\n"
        self.assert_rejected(export_bytes(candidate), "schema")
        candidate = copy.deepcopy(self.base)
        candidate["entities"] = [{"alias": "e1\n", "kind": "run"}]
        self.assert_rejected(export_bytes(candidate), "schema")

    def test_store_claims_require_handshake(self):
        startup = read_bundle(ROOT / "fixtures/valid/startup-unknown.json")
        for handshake in (False, "unknown", True):
            for state in ("available", "unavailable", "unknown"):
                with self.subTest(handshake=handshake, protected_state=state):
                    candidate = copy.deepcopy(startup)
                    candidate["evidence"].update(handshake=handshake, protectedStateObservation=True)
                    candidate["snapshot"]["protectedState"] = state
                    if handshake is True:
                        validate_bytes(export_bytes(candidate))
                    else:
                        self.assert_rejected(export_bytes(candidate), "unobserved_claim")
            candidate = copy.deepcopy(startup)
            candidate["evidence"]["handshake"] = handshake
            candidate["versions"]["storeFormat"] = "config-generations-v3"
            if handshake is True:
                validate_bytes(export_bytes(candidate))
            else:
                self.assert_rejected(export_bytes(candidate), "unobserved_claim")
        # Absence is not an assertion about store health and remains valid before handshake.
        startup["evidence"]["protectedStateObservation"] = False
        validate_bytes(export_bytes(startup))

    def test_all_object_boundaries_are_closed(self):
        # Add a canary to every concrete object, including nested protocol and event objects.
        candidate = copy.deepcopy(self.base)
        candidate["versions"]["appProtocol"] = {"major": 1, "minor": 10}
        candidate["entities"] = [{"alias": "e1", "kind": "run"}]
        candidate["events"] = [{"offsetMs": 0, "phase": "run", "code": "run_failed", "entityAlias": "e1"}]

        def paths(value, path=()):
            if isinstance(value, dict):
                yield path
                for key, child in value.items():
                    yield from paths(child, (*path, key))
            if isinstance(value, list):
                for index, child in enumerate(value):
                    yield from paths(child, (*path, index))

        for path in paths(candidate):
            with self.subTest(object_path=path):
                altered = copy.deepcopy(candidate)
                target = altered
                for key in path:
                    target = target[key]
                target["unexpected"] = "SYNTHETIC_CANARY_DO_NOT_EXPORT"
                self.assert_rejected(export_bytes(altered), "schema")

    def test_oracles_are_explicitly_not_runtime_evidence(self):
        states = json.loads((ROOT / "fixtures/state-cases.json").read_text())["cases"]
        self.assertEqual(len({case["id"] for case in states}), len(states))
        for case in states:
            self.assertTrue(case["trace"])
            self.assertEqual(case["runtimeStatus"], "not_run")
            self.assertEqual(case["expected"]["externalDiagnosticRequests"], 0)
            self.assertEqual(case["expected"]["executionMutations"], 0)
        # Checking these declarations is not executing the traces or observing a network.
        pipeline = json.loads((ROOT / "fixtures/privacy-cases.json").read_text())["pipelineCases"]
        for case in pipeline:
            self.assertEqual(case["runtimeStatus"], "not_run")
            self.assertEqual(case["execution"], "unchanged")


if __name__ == "__main__":
    unittest.main()
