# Compact receipt: fresh original observation, incomplete

Refs #699 / #706 / #769. One fresh bootstrap and gated connected observation used
the exact independently reviewed, published observer head
`434d29987f41e4b3b3d8ea550c58ea32af8de1b5`. This is preparation evidence only.
The unchanged producer source is `557f62fbe86fc8371d48f11ec37bf9db71cac436`.
No accepting token or production eligibility was issued. No subsequent attempt
or source change was made after the connected refusal.

## Preflight and source pins

The preserved successful bootstrap originals packet remains 268635981 bytes,
with SHA-256 `a4324484316505f0405c54e9eb2d59ff42c89d4a1e19b85cc70e6bbb49d25443`.
Its metadata is 81337 bytes and its exact asset-size-derived allowance is
269603220 bytes. All 19 still-live image/runtime/original assets matched their
retained bytes, digests and physical identities. The consumed 130-byte witness
was checked only as historical packet data in this diagnostic preflight; no
old `ObservedRun` or replay capability was reconstructed from JSON. The new
original run supplied its own actual closed graph and consumed-witness lineage.

The first process diagnostic used substring matching and matched its own shell
script arguments. An exact argument check resolved that false positive; complete
preflight then passed with no owned child or tracer remaining before launch.

Six focused unittest controls passed in 18.220 seconds:

```
python3 -B -m unittest \
  test_controlled_connected.DesignationControls.test_valid_originals_packet_just_over_trace_cap_uses_pinned_asset_bound \
  test_controlled_connected.DesignationControls.test_consumed_witness_uses_original_replay_object_without_path_read \
  test_controlled_connected.DesignationControls.test_consumed_witness_resurrection_refuses_at_creation_and_later_boundary \
  test_controlled_connected.DesignationControls.test_consumed_witness_wrong_packet_original_cannot_repin_retained_bytes \
  test_controlled_connected.DesignationControls.test_absent_witness_without_original_successful_unlink_cannot_designate \
  test_controlled_connected.DesignationControls.test_consumed_witness_requires_same_original_unique_bounded_replay_object
```

The command ran from `tools/owned-read-proof`. These controls are synthetic and
grant no original execution authority.

| Image member | SHA-256 |
| --- | --- |
| Producer | `c81477f96d56bdc89e56d96aaf35fa8c62c418080406c07c63db9f75b56585fd` |
| Child | `a58036e5343fe07dac8625f7d5dfc2a7e0c6bfe660ddb1e96711b5b8d002e35c` |
| Build manifest | `d1fcc114c726ef11d77c31d9a862e7b407d03bf82b5c195a2270add15b0d0ad0` |

## Single original outcome

The fixed `observe_new(diagnostic=True)` launcher ran once. The existing sparse
one-second diagnostics read pinned process/resource counters and trace size;
there was no concurrent raw-trace inspection. The 55-second owner, 60-second
process and 268435456-byte trace bounds remained unchanged. The independently
derived originals allowance is separate from the trace bound.

| Lane | Outcome | Trace bytes | Phase timing from original start |
| --- | --- | ---: | --- |
| Bootstrap | Original checks completed, child exit 0 | 113342841 | Command write completed 2.661680708 s; ack read completed 56.510653300 s; process elapsed 56.979212164 s |
| Connected | `TimeoutExpired` at the unchanged 60-second process bound | 138497110 | Save write completed 7.296825055 s; no Save ack; human/rule commands not released |

Bootstrap independently settled 12 threads, one service read and 57 final named
observations. Its notification proof has 904 unit writes, 893 counter drains,
final counter zero, two counter-I/O overlap pairs and no registration-write
overlap. These are checks of this original bootstrap, with the existing
trusted-supervisor, exact-source and in-memory capability assumptions.

Receipt construction and original association checks completed. The exclusive
mode-0400 receipt is 1294 bytes. The fresh bootstrap originals are 268636071
bytes. Its complete report, originals and raw trace remain preserved intact.

Connected released Save only. Its available post-release budget was about
52.703 seconds, within the total original 60-second window. No connected kernel
or aggregate semantic success was produced. The timeout prevents qualification;
child progress or persisted records cannot substitute for independent replay.

## Post-settlement diagnostic accounting

Read-only accounting of the preserved, incomplete connected trace found:

- 3473 completed positive receipt reads, 4494062 decoded bytes and 4901411 raw
  trace bytes for those read calls. Reads and currentness checks remain present.
- 140378 completed `statx` calls, contributing 127121072 raw bytes, 91.7861% of
  the trace. These counts do not establish a syscall or scheduling cause.
- The last completed call is a successful leader `statx` at 60.004777182 seconds.
  The final trace prefix is at 60.004880873 seconds; its record is truncated and
  lacks a terminating newline. Worker waits remain unfinished at the cut.
- Persisted protected record kinds include one each of baseline, capture,
  `human.requested`, `step.waiting` and persistence review. The last observed
  protected link completed at 46.668077727 seconds, followed by temporary unlink
  at 46.671658945 seconds. Persisted kinds and diagnostic syscall counts grant
  no semantic/effect authority.
- All 24 observed thread IDs are absent after cleanup. Bootstrap diagnostics
  have 53 samples, connected diagnostics 57, with no sampler errors.

The cgroup CPU counters increased by 45.979643 seconds during bootstrap samples
and 47.354199 seconds during connected samples. Their throttling deltas were
24 periods / 1230431 microseconds and one period / 121720 microseconds,
respectively. Memory event counters did not increase. These cgroup-wide counters
are not exclusive attribution to this attempt and do not explain earlier
timeouts. The historical failed attempts remain failures; none is superseded.

At this new read count, substituting the historical 5906-byte report would
arithmetically require 20511538 decoded bytes, versus 4494062 actual receipt
bytes, a difference of 16017476 bytes. This is a same-count size comparison,
not a timing comparison or evidence of completed Save.

## Exact retained evidence hashes

Raw traces, original packets, protected state and secrets remain local and are
not published. The sanitized original checkpoint has SHA-256
`ecd4554990c496817dc590148d681b337fce38a908f5b9f25e2e767ec2922c84`;
the separate post-settlement diagnostic has SHA-256
`1759c340b2afcbff16635d866c44e457135d43584802ce6d46c4f72cbcacfa11`.

| Artifact | SHA-256 |
| --- | --- |
| Receipt | `e22a8e23e66f7ddbab6b809bc2575af1cea070820f06850c81f7bb4d213db2a9` |
| Bootstrap trace | `956aab14d9e41d05b80b536554b6245dcf286dd12d1631ca81e59b322c9e774d` |
| Bootstrap report | `ef30e401c0953523f44ca3b720cd84d7720696a449f55062f85bcfa5442c2c73` |
| Bootstrap originals | `5aad2a681753f6cc0f932ff12658d4cf6e75dbe5854bf6849fe925f73c780d87` |
| Bootstrap diagnostics | `eae0d23309bc5f1a572aeea876ff6c0ec85302c498ac9c093b7b69a2626e3303` |
| Connected trace | `9d398155e7f8576fe528b3698492d71cdc8ab34daad70e48e2d5c113bc9df04f` |
| Connected report | `9ef37aa73de3d2da22f81274b47acb55654f5a4ad39f4c20866b7335940e412a` |
| Connected originals | `3f27d2934bcdb4ac309930f82dba5736552f323b2ad2c23c23a450e9de42817f` |
| Connected diagnostics | `4071937f244947144d1c6a1cd1ed25aaee2f79636aef2a6fc404fc27d2cdf107` |

Connected Save completion, human delivery/final settled acknowledgement, the
fresh rule invocation, aggregate effect proof and independent review of fresh
end-to-end evidence remain outstanding. No new original is authorized by this
checkpoint. The next investigation can analyze this preserved Save trace and
source without widening bounds or omitting currentness checks.
