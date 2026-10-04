# Synthetic fixture catalog

All values are invented. No packet was captured from a daemon, account, device or
private artifact. `example.invalid` and `orca.invalid` are inert reserved names;
even the malicious artifact example must never be fetched or opened.

- [packets.json](packets.json): complete v1 boundary packets for session, all eight
  run statuses, durable/live approval summaries, inert artifact text, connection
  states, run/live invalidations and read errors.
- [cases.json](cases.json): named variants. Start with a deep copy of `base` from
  packets, apply `changes` in order using JSON Pointer `path`; assign `value` or
  delete the member when `remove: true`. Array indices are zero-based. This is a
  deliberately small fixture patch dialect, not a runtime patch API.
- [scenarios.json](scenarios.json): ordered deliveries and local lifecycle events
  for future Swift/TypeScript/Android conformance harnesses. Each delivery resolves
  either a packet or case ID. `generation` and `ticket` model client-owned request
  ordering, not server authority. Expected UI/recovery outcomes are assertions to
  implement under #472/#473, not tests already passed by this preparation.

`decode: accept` means structural decoding is allowed, **not** that a session may
display the packet. Wrong-host/principal/enrollment/artifact cases deliberately
decode but must fail identity/resource checks. Conversely malformed/version cases
must fail before presentation. Additive unknown fields decode but are discarded;
canonical producer fixtures contain only allowlisted fields. An accepted session
with a write-looking unknown capability can never enable commands.

The validator exercises schema examples and deterministic malformed/boundary probes
(duplicate keys, invalid UTF-8, missing fields, deep/oversized bodies, UTF-8 text cap,
page/nested collection caps, explicit detail completeness, portable version/sequence
integers and nonfinite exponent overflow even in unknown fields). It checks fixture references and canonical
status vocabulary against the repository source. It does not implement a server,
network client, cache, UI state machine or credential policy. Server mutation-denial
and canary projection tests remain mandatory in #472; device evidence belongs to #477.

From the repository root, with Python 3 and `requirements.txt` installed in an
isolated environment, run:

```sh
python3 docs/preparation/swiftui-readonly-pilot/validate.py
git diff --check
```

No daemon, Apple account, endpoint, credential or notification provider is needed.
