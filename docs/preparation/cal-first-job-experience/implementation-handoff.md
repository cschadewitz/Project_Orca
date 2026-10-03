# Implementation handoff and remaining decisions

Prepared for #424/#334 at exact main
`e94bf699d9f3000de8822ed3434c1dce92b6ce19` on 2026-10-03 UTC. Read
[README](README.md), [capability map](capability-map.md),
[interaction specification](interaction-spec.md), [fixtures](wireframes-and-transcripts.md)
and [acceptance scenarios](acceptance-scenarios.md) together.

## Smallest remaining product decisions

These decisions do not block a truthful preparation packet. They do block pretending
the specified end-to-end launch is already available. Existing owners should resolve
them in their implementation review, without this task taking their files.

| ID | Decision / proposed first-track default | Owner and condition for completion |
| --- | --- | --- |
| D1 | How to verify the exact repo/checkout before direct launch. Use an existing explicitly prepared disposable checkout, fixed by the target's configuration; no per-launch path picker or implicit worktree creation. | #334 with #327 projection owner/integrator: agree minimum authorized repo/cwd/branch/base observation and freshness. If absent, block launch. No new raw-file/config proxy, grant or schema is proposed by this packet. Any shared-seam change needs their coordinated contract review. |
| D2 | Which reviewed minimal workflow/instruction asset and result evidence contract to ship. Use `start → agent → end`, fixed effective agent/model/template for direct mode, declared task input, and a diff/check/risk result artifact. | #334 with #420; #355 only for reusable authoring/publication. Name/version the actual asset and verify result provenance/omission semantics before making fixtures executable. Broader role/model/template overrides remain disabled where the selected entry point does not accept them. |
| D3 | Whether PR publication belongs in the first usable launch experience. Default to returning the result with publication unavailable. | #334/#327 and, if selected, the existing #350 publication owner. Choose a supported separately authorized publisher and verification contract before enabling it; this is not a request to add shell or publishing tools to the frozen MCP mount. |

Connection account/host/grant choices remain #391–393's existing decisions; do not
reopen them here or infer a positive result. Model pricing and budget enforcement
remain #345/#346. Same-agent persistent chat remains deferred. These are not additional
questions the user must answer to review this documentation PR.

## Ownership and order

| Work | Existing owner / relationship |
| --- | --- |
| Guided selection, preview, draft retention, admission navigation and result UI | #334; consume this packet and existing app primitives. Coordinate shared renderer seams through its implementation owner. |
| Safe target/config/preflight/run/artifact projections, tool inventory, exact approval/control transport | #327; existing #419 A/B/C ownership remains intact. No adapter/projection/test files are edited here. |
| Retry claims and original admission recovery | #331/integrator; consume real receipts, never implement a second client/adapter ledger. |
| Durable continuation and production mutation mounting | Parent integrator under #415/#419; preserve the ten-alias contract, exact target guards and real retry envelopes. |
| Revision semantics | #356; revision-enabled boundaries only, no ordinary-note reinterpretation or hidden mid-turn chat. Not required for minimal one-agent success. |
| Auth, typed validation, config capture, live lifetime and target identity | Existing #328/#330/#332/#237/#318 foundations; source-grounded reuse, not replacement features. |
| Template catalog/editor | #355 with #333; no new template authoring UI in this preparation. |
| Cal feasibility, private connection operations and actual conversation proof | #391 → #392/#393, with separately approved setup; no connection research or provisioning in this task. |
| Synthetic coding bug and runnable first-job evidence | #420/#386; incorporate the F1/F2 result requirements without duplicating its repository fixture. |
| Signed delivery, packaged tests, physical acceptance | #385/#388/#390, reusing completed #402/#403 preparation. No validator or general test-matrix rewrite. |

Implementation order:

1. Re-audit main and active #415/#419 heads. Record immutable accepted revisions and
   actual installed/authorized methods; reconcile this packet before implementation.
2. Resolve D1/D2 with the existing owners. UI/content fixtures can proceed in parallel
   with adapter wiring and the #420 sample. No dependency on template editor completion
   is needed to use an existing supported fixed template.
3. Integrate retry-safe admission, coherent preview, exact approval and continuation
   semantics before claiming full launch/recovery acceptance. Do not expose missing
   operations through detached legacy RPC calls. Direct/Request startup recovery
   limitations of the inspected integration must stay visible.
4. Run A01–A23 against the accepted production composition with synthetic state; exercise
   real crash/restart/current-authority paths. Implement A24 with app keyboard/layout
   tests. Feature fixtures alone cannot close parent acceptance.
5. After #391's positive connection decision and authorized #392 setup, #393 verifies
   actual Cal behavior. Run packaged/physical/real-agent checks separately under their
   existing owners and authority. Publication stays unavailable unless D3 is resolved.

No new hard dependency from #327 back to closure of #391/#393 is introduced; connection
preparation and adapter implementation can proceed independently, while actual-Cal
acceptance needs both. #424 documentation can finish independently of those product
outputs. The order above has no cycle and does not assign a release or milestone.

## Follow-up inventory

Reviewed open issues/PRs and the specified closed foundations on 2026-10-03. Existing
#334/#327/#355/#331/#356/#391–393/#420 cover the implementation gaps. #345/#346 cover
usage/budgets, #350 covers GitHub publication infrastructure, #357 covers broader
recovery, and #394–396 cover plugin restoration. No uncovered independent outcome was
identified that warrants a duplicate new issue. Preserve all existing metadata and
parent acceptance; accepting #424 does not close #334 or #327.

The active implementation references were read remotely at immutable commits, without
importing a peer branch: #415 at `b4bc23c97fba542a1cb3dcff6b0b0d241f430436`, #419 at
`4937f4c083c572d07b840258724ef600368a7a5d`. Later changes need a fresh audit.

## Validation and PR evidence

This is a six-document source/specification change only. Markdown is intentionally
excluded by the repository's `.prettierignore`; do not report Prettier as prose
validation. Appropriate local checks are owned-path/whitespace checks, relative-link
existence, source claim comparison and fixture-to-scenario coverage review.

Reproducible document checks from the repository root:

```sh
git diff --check
python3 - <<'PY'
from pathlib import Path
import re
root = Path('docs/preparation/cal-first-job-experience')
files = sorted(root.glob('*.md'))
assert len(files) == 6, files
links = 0
for file in files:
    text = file.read_text()
    assert len(re.findall(r'^```', text, re.M)) % 2 == 0, file
    for target in re.findall(r'\]\(([^)]+)\)', text):
        if '://' in target or target.startswith('#'):
            continue
        path = target.split('#', 1)[0]
        assert (file.parent / path).exists(), (file, target)
        links += 1
scenarios = (root / 'acceptance-scenarios.md').read_text()
assert re.findall(r'^\| (A\d+) \|', scenarios, re.M) == [f'A{i:02}' for i in range(1, 25)]
fixtures = (root / 'wireframes-and-transcripts.md').read_text()
assert re.findall(r'^## (F\d+) ', fixtures, re.M) == [f'F{i}' for i in range(1, 7)]
print(f'{len(files)} documents, {links} local links, 24 scenario IDs, 6 fixtures: PASS')
PY
```

Evidence status for this preparation:

| Check | Result / scope |
| --- | --- |
| Fetch/sync and baseline comparison | Pass: fetched `origin/main` equals the required `e94bf699…`; no conflicts or later rebase. |
| Source/contract inventory | Pass: main registration/params/provider/selection/lifetime sources and immutable active contracts inspected; classifications distinguish them. |
| Relative links, fences, scenario/fixture IDs and whitespace | Pass: six documents, 56 local links, 24 scenario IDs, six fixtures; staged diff whitespace check passed. |
| Manual scenario review | A01–A24 specify outcomes and evidence limits; F1–F6 are static authored fixtures, not executed jobs. |
| Runtime tests/build/App smoke | Not run: no runtime, UI implementation, workflow or dependency changes. |
| Actual Cal connection and mutation lifecycle | Blocked/unverified here: requires accepted production wiring and proven authorized connection. |
| Packaged/physical/real-agent acceptance | Not run; retain #402/#403 and parent requirements. |

The draft PR must target main, identify the exact documentation commit, list all six
owned artifacts and actual check results, and link #424 plus #334/#327/#355. It must
state the remaining D1–D3 decisions and unavailable cost/percentage/ETA. This packet is
the project documentation update; shared living docs, code, design tokens, manifests,
CI and external services remain with their owners. No main merge is authorized.
