#!/usr/bin/env python3
"""Offline v1 proposal checker, not a collector, sanitizer, or runtime trust boundary.

Only reads an explicitly named fixture. Never prints candidate values or exceptions.
JSON Schema checks shape; the remaining checks bind ordering, aliases and observations.
"""

import argparse
import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent
MAX_BYTES = 262144  # Unapproved review profile; see contract.md.
MAX_DEPTH = 12
SCHEMA = json.loads((ROOT / "schema-v1.json").read_text(encoding="utf-8"))
Draft202012Validator.check_schema(SCHEMA)
VALIDATOR = Draft202012Validator(SCHEMA)


class Rejected(ValueError):
    """Fixed local checker reason; contains no candidate content."""


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Rejected("duplicate_key")
        result[key] = value
    return result


def reject_number(_value):
    raise Rejected("non_integer_number")


def export_bytes(bundle):
    """Deterministic fixture serialization, not an export implementation."""
    return (json.dumps(bundle, sort_keys=True, indent=2, ensure_ascii=True, allow_nan=False) + "\n").encode("ascii")


def validate_bytes(raw):
    if len(raw) > MAX_BYTES:
        raise Rejected("byte_limit")
    # Bound nesting before json.loads, independently of Python's recursion limit.
    depth, quoted, escaped = 0, False, False
    for byte in raw:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (91, 123):
            depth += 1
            if depth > MAX_DEPTH:
                raise Rejected("nesting_limit")
        elif byte in (93, 125):
            depth -= 1
    try:
        bundle = json.loads(
            raw.decode("utf-8"), object_pairs_hook=unique_object,
            parse_constant=reject_number, parse_float=reject_number,
        )
    except Rejected:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise Rejected("invalid_json") from None
    # Do not format a ValidationError: it includes rejected values and source paths.
    if next(VALIDATOR.iter_errors(bundle), None) is not None:
        raise Rejected("schema")
    if bundle["reportId"] == bundle["sessionId"]:
        raise Rejected("identifier_reuse")
    aliases = [entity["alias"] for entity in bundle["entities"]]
    if len(aliases) != len(set(aliases)):
        raise Rejected("duplicate_alias")
    previous = 0
    for event in bundle["events"]:
        if not previous <= event["offsetMs"] <= bundle["windowMs"]:
            raise Rejected("event_order_or_window")
        previous = event["offsetMs"]
        if event["entityAlias"] != "unknown" and event["entityAlias"] not in aliases:
            raise Rejected("dangling_alias")
    evidence = bundle["evidence"]
    for field, presence in (
        ("admission", "admissionObservation"),
        ("resume", "resumeObservation"),
        ("protectedState", "protectedStateObservation"),
    ):
        if evidence[presence] is not True and bundle["snapshot"][field] != "unknown":
            raise Rejected("unobserved_claim")
    if evidence["handshake"] is not True:
        versions = bundle["versions"]
        if any(versions[field] != "unknown" for field in ("daemon", "daemonProtocol", "storeFormat")):
            raise Rejected("unobserved_claim")
        if evidence["protectedStateObservation"] is True or bundle["snapshot"]["protectedState"] != "unknown":
            raise Rejected("unobserved_claim")
        if bundle["snapshot"]["authentication"] == "accepted":
            raise Rejected("unobserved_claim")
    if raw != export_bytes(bundle):
        raise Rejected("noncanonical_bytes")
    return bundle


def read_bundle(path):
    with path.open("rb") as stream:
        return validate_bytes(stream.read(MAX_BYTES + 1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    try:
        read_bundle(args.bundle)
    except Rejected as error:
        print("REJECTED:", str(error))
        return 1
    except OSError:
        print("BLOCKED: fixture_unreadable")
        return 2
    print("PASS: proposed contract only; no runtime or privacy provenance proof")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
