"""Offline preparation conformance: schema/fixtures only, no runtime state machine."""

import copy
import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
MAX_BYTES = 256 * 1024


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError("nonfinite JSON number")


def load(raw):
    return json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)


def read(name):
    return load((ROOT / name).read_text())


SCHEMA = read("schema-v1.json")
Draft202012Validator.check_schema(SCHEMA)
DECODER = Draft202012Validator(SCHEMA, format_checker=FormatChecker())


def bounds(value, depth=0):
    if depth > 16:
        raise ValueError("maximum JSON depth")
    if isinstance(value, dict):
        for item in value.values():
            bounds(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            bounds(item, depth + 1)


def decode(raw):
    if len(raw) > MAX_BYTES:
        raise ValueError("maximum response bytes")
    packet = load(raw.decode("utf-8"))
    bounds(packet)
    DECODER.validate(packet)
    if packet["kind"] == "artifact" and "text" in packet["data"]:
        if len(packet["data"]["text"].encode("utf-8")) > 16 * 1024:
            raise ValueError("maximum artifact UTF-8 bytes")
    return packet


def encoded(value):
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def strict_producer_schema(value):
    if isinstance(value, dict):
        return {
            key: False if key == "additionalProperties" else strict_producer_schema(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [strict_producer_schema(item) for item in value]
    return value


def materialize(case, packets):
    packet = copy.deepcopy(packets[case["base"]])
    for change in case["changes"]:
        assert change["path"].startswith("/")
        parts = [part.replace("~1", "/").replace("~0", "~") for part in change["path"][1:].split("/")]
        target = packet
        for part in parts[:-1]:
            target = target[int(part)] if isinstance(target, list) else target[part]
        key = int(parts[-1]) if isinstance(target, list) else parts[-1]
        if change.get("remove") is True:
            assert "value" not in change
            del target[key]
        else:
            target[key] = copy.deepcopy(change["value"])
    return packet


def rejected(raw):
    from jsonschema.exceptions import ValidationError

    try:
        decode(raw)
    except (ValueError, UnicodeError, ValidationError):
        return True
    return False


def main():
    packets = read("fixtures/packets.json")
    cases = read("fixtures/cases.json")
    scenarios = read("fixtures/scenarios.json")
    producer = Draft202012Validator(strict_producer_schema(SCHEMA), format_checker=FormatChecker())
    for packet in packets.values():
        decode(encoded(packet))
        producer.validate(packet)

    ids = set(packets)
    for case in cases:
        assert case["id"] not in ids, "duplicate fixture ID"
        ids.add(case["id"])
        assert case["expectation"] and case["decode"] in ("accept", "reject")
        raw = encoded(materialize(case, packets))
        assert rejected(raw) == (case["decode"] == "reject"), case["id"]

    semantics = load((REPO / "packages/design/semantics.json").read_text())
    statuses = set(semantics["runStatus"])
    assert set(SCHEMA["$defs"]["run"]["properties"]["status"]["enum"]) == statuses
    assert set(SCHEMA["$defs"]["step"]["properties"]["status"]["enum"]) == statuses
    assert {row["status"] for row in packets["runs"]["data"]["items"]} == statuses
    runs = {row["id"]: row for row in packets["runs"]["data"]["items"]}
    for approval in packets["approvals"]["data"]["items"]:
        assert approval["stepRunId"] in {step["stepRunId"] for step in runs[approval["runId"]]["steps"]}
        for evidence in approval["artifacts"]:
            assert evidence in runs[approval["runId"]]["artifacts"]
            assert all(packets["artifact"]["data"][key] == value for key, value in evidence.items())
    assert set(SCHEMA["$defs"]["connection"]["properties"]["state"]["enum"]) == set(semantics["connectionState"]) - {"file"}
    assert "major: 2, minor: 0" in (REPO / "packages/protocol/src/version.ts").read_text()
    scenario_ids = set()
    local_events = {"background", "foreground", "begin-read", "advance-monotonic-seconds", "notification-hint", "invalidation-burst"}
    for scenario in scenarios:
        assert scenario["id"] not in scenario_ids
        scenario_ids.add(scenario["id"])
        assert scenario["expected"] and scenario["steps"]
        for step in scenario["steps"]:
            if step["event"] == "deliver":
                assert step["fixture"] in ids, step["fixture"]
                assert isinstance(step["generation"], int) and step["generation"] > 0
                assert step["ticket"]
            else:
                assert step["event"] in local_events

    # Adversarial transport and boundary probes, generated without giant fixture files.
    invalid = [b'{"kind":"runs","kind":"error"}', b'\xff', b'{"seq":NaN}']
    missing = copy.deepcopy(packets["runs"])
    del missing["data"]["items"][0]["id"]
    invalid.append(encoded(missing))
    for size, should_reject in [(100, False), (101, True)]:
        page = copy.deepcopy(packets["runs"])
        page["data"]["items"] = [dict(page["data"]["items"][0], id=f"synthetic-row-{i}") for i in range(size)]
        assert rejected(encoded(page)) == should_reject
    for count, should_reject in [(8192, False), (8193, True)]:
        artifact = copy.deepcopy(packets["artifact"])
        artifact["data"]["text"] = "é" * count
        assert rejected(encoded(artifact)) == should_reject
    oversize = copy.deepcopy(packets["session"])
    oversize["futureField"] = "x" * MAX_BYTES
    invalid.append(encoded(oversize))
    deep = copy.deepcopy(packets["session"])
    nested = "leaf"
    for _ in range(18):
        nested = {"next": nested}
    deep["futureField"] = nested
    invalid.append(encoded(deep))
    for raw in invalid:
        assert rejected(raw), "malformed/bounded decoder probe accepted"
    print(f"PASS: {len(packets)} canonical packets, {len(cases)} decoder cases, "
          f"{len(scenarios)} scenario references, source vocabulary and boundary probes")
    print("Scenario behavior, server authorization and native/device acceptance are not executed.")


if __name__ == "__main__":
    main()
