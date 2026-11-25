# Optional beta report

> **Superseded diagnostics wording, 27 October 2026**
> ([#786](https://github.com/cschadewitz/Project_Orca/issues/786)): mentions of a #416
> *preview* below predate the owner's 9 October Save/export-only decision. There is no
> in-app report viewer, and current source keeps production capture disabled
> (`DIAGNOSTICS_PRODUCTION_ENABLED = false`). Do not ask testers to preview, enable or
> export diagnostics. For Windows/Linux private candidates use
> [private-candidate-windows-linux](../private-candidate-windows-linux/README.md).
> The content below is otherwise unchanged.

Copy the block below for a success, bug, confusing step or feature idea. Use one
report per experience. Every field is optional: `unknown`, `not tested` and
`prefer not to share` are valid. Do not fetch missing details from logs or private
files. Use only a safe candidate identity supplied by the coordinator or displayed
by the approved candidate; never substitute a source checkout for a tested build.
Follow the [tester guide](tester-guide.md) for stop conditions and the private route.

Describe behavior in your own words without copying prompts, code/diffs, agent/tool
output, artifacts, screenshots, raw errors/logs, full paths, credentials, personal
identity or workplace data. Do not attach files automatically. Generic task descriptions
must also omit confidential subject matter. A separately identified safe code is
enough; use `unknown` if it cannot be safely separated from its message.

```text
Report alias (random, not your name/account/device name):
Experience: success / stuck / failure / confusing guidance / idea / wrong intent

Intended task and result, in your own non-sensitive words:
Did the result meet that intent? yes / partly / no / unknown / not tested
Why (safe summary only):

Optional candidate identity:
  App version:
  Exact candidate/build ID and source commit, if supplied:
  Package/architecture and artifact checksum, if supplied:
  Actual OS version/build and architecture:
  Actual hardware model/chip (no serial number, hostname or account name):
  Agent/version, if used (or scripted fixture / not used / unknown):

Step reached or stuck at (checklist S1-S8):
Steps taken, using generic labels instead of private names or paths:
Expected behavior:
Observed behavior (paraphrase; no copied error text):
Repeatability: once / N of N safe attempts / intermittent / not retried / unknown
Safe error code only, if available (otherwise unknown):
Impact and reason for stopping, if any:

Did an agent help? not used / yes / no / partly / unknown
How did it help or fail to help? (no transcript):
Did a person give hints? none / yes / unknown; which stage and kind of hint:
Evidence reviewed locally: result / diff / tests / none; what remains unverified:
Checklist states S1-S8 (pass / fail / blocked / not tested), with short reasons:

Diagnostics: not offered / declined / unavailable / preview cancelled /
             exported locally but not shared / separately chosen sharing
If shared voluntarily: random report alias and agreed recipient only;
  no destination paths, raw bundle contents or automatic attachment here.
Optional next step or improvement you would like:
```

Repeatability is an observation, not a request to try again. Diagnostic sharing is
independent of sending this report. No response authorizes machine access, replay,
recovery, installation or further data collection. See the
[synthetic examples](synthetic-examples.md) for the level of detail expected.
