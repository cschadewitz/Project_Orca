# Beta feedback preparation handoff

Preparation for [#422](https://github.com/cschadewitz/Project_Orca/issues/422), a
slice of [#390](https://github.com/cschadewitz/Project_Orca/issues/390). Audited on
2026-10-03 against exact main baseline
`e94bf699d9f3000de8822ed3434c1dce92b6ce19`. Fetch and Kepler sync confirmed this was
still `origin/main`; no later rebase or peer-branch import was needed.

## Artifacts

| Artifact | Reader and purpose |
| --- | --- |
| [Tester guide](tester-guide.md) | One-page draft for semi-technical Mac and technical Windows testers: try, stop, report and optional sharing. |
| [Report template](report-template.md) | Copyable success/bug/confusion/intent report, with optional exact identity and safe observations. |
| [First-success checklist](first-success-checklist.md) | Separate installation, setup, authentication, selection, launch, approval, evidence and intent states. |
| [Triage checklist](triage-checklist.md) | Coordinator intake, severity, minimal evidence, ownership and disposition. |
| [Synthetic examples](synthetic-examples.md) | Four invented completed reports; no participant or candidate evidence. |

Only this new directory is owned. No repository-wide issue forms, runtime, manifests,
CI, Hub content, packaging harness or existing preparation files are changed. This
documentation needs no release note. Parent acceptance remains open.

## Sources and remaining gates

Reuse [#402's artifact contract](../native-mac-delivery/artifact-contract.md) for
candidate identity and [#403's fixture contract](../native-mac-testing/fixture-contracts.md)
and [manual checklist](../native-mac-testing/manual-checklist.md) for the existing
sample and physical test scope. Both preparation issues are closed and their docs
are on this baseline; their proposed contracts are not packaged acceptance proof.
This feedback slice uses the stricter #416 exclusions instead of asking testers
for the logs/screenshots mentioned in older preparation evidence guidance.

[#389](https://github.com/cschadewitz/Project_Orca/issues/389) still owns final Mac
installation/first-job instructions and Hub publication. Its issue is a planning
link, not a usable install guide. The sample remains proposed pending #386. No
Windows-specific installation flow or diagnostic button label is invented here.
The coordinator must supply tested Windows instructions for a Windows session.

[#416](https://github.com/cschadewitz/Project_Orca/issues/416)'s current privacy
contract supplies the exclusions, optional manual preview/export, separate sharing
decision and no-default-capture/no-upload boundary. It remains open; its reviewed
implementation/schema/consent wording and exact candidate controls are **pending**.
This document does not assert privacy approval or successful validation. #416 is
a hard pre-beta blocker, while #417/#418 uploads/remote requests are later work.

Before these drafts are handed to real testers, Casey/coordinator must:

1. Pin the actual candidate/build, available safe identity/code display, approved
   sample/agent and tested hardware/OS combinations. Replace provisional references
   with the matching #389 guide and confirmed Windows instructions without importing
   private download credentials. Unknown fields must remain unknown.
2. Supply the agreed private support contact and confirm recipient access,
   feedback retention/deletion and consent wording. No contact address or retention
   duration has been invented. Agree each person's scope separately; willingness
   to test or share a report is not machine-access or workplace-sharing permission.
3. Consume #416's focused privacy and packaged Mac/Windows evidence, including
   startup-before-handshake failure, preview/export/cancel, no default capture or
   transmission and bounded local retention. Match wording to tested controls.
4. Under #390's separately authorized physical/unassisted exercise, record where
   target-like testers need hints and revise the guide before cohort sign-off.
   Two Mac and two Windows experiences are qualitative observations, not statistics
   or certification. Do not commit real participant records here.

These are existing #386/#389/#390/#416 integration responsibilities, not new duplicate
issues. Windows instructions/support scope must be confirmed by the coordinator;
this preparation neither claims nor establishes Windows certification.

## Validation record

- **PASS:** source/issue review against the baseline and #389/#390/#416, with
  completed #402/#403 reused. Coverage reviewed against #422's acceptance list.
- **PASS:** relative documentation targets/fragments, UTF-8/LF, final newlines,
  absence of trailing whitespace/tabs and one title per artifact, using the command
  below; `git diff --check` also passes.
- **NOT RUN:** runtime tests/typecheck/build/app smoke; no runtime changes. Repository
  Prettier intentionally excludes Markdown in `.prettierignore`; its general check
  is not evidence that these documents were validated.
- **BLOCKED:** candidate-specific wording/sign-off until matching guide, sample,
  support route and validated #416 implementation are supplied.
- **NOT RUN / PENDING:** real-user usability, physical Mac or Windows candidate
  acceptance, real-agent runs, invitation, installation, diagnostic collection/export,
  uploads and Hub publication. No synthetic example is a pass for any of these.

Run from the repository root (standard-library Python only). This checks local
Markdown links and formatting; GitHub issue links were read through `gh issue view`,
not tested as an invited user's access route.

```bash
python3 - <<'PY'
from pathlib import Path
import re
from urllib.parse import unquote

root = Path('docs/preparation/beta-feedback')
files = sorted(root.glob('*.md'))
links = 0
for file in files:
    raw = file.read_bytes()
    text = raw.decode('utf-8')
    assert raw.endswith(b'\n') and b'\r' not in raw, file
    assert all(line == line.rstrip() and '\t' not in line
               for line in text.splitlines()), file
    assert len(re.findall(r'^# ', text, re.M)) == 1, file
    for target in re.findall(r'\[[^\]\n]+\]\(([^)\s]+)\)', text):
        if target.startswith('https://'):
            continue
        path, _, fragment = unquote(target).partition('#')
        dest = (file.parent / path).resolve() if path else file.resolve()
        assert dest.is_file(), (file, target)
        if fragment:
            headings = re.findall(r'^#{1,6} (.+)$', dest.read_text(), re.M)
            slugs = [re.sub(r'[^\w\- ]', '', h.lower()).replace(' ', '-')
                     for h in headings]
            assert fragment in slugs, (file, target)
        links += 1
print(f'PASS: {len(files)} documents; {links} local links; format checks')
PY
git diff --check
```

The draft PR records the exact implementation commit, owned diff and command results.
Merging this preparation does not approve the candidate or close #390/#416.
