# First-run local-agent preflight (#386)

Setup's **Review saved configuration for reopening** is a read-only observation of
executables named by the selected local workspace's saved Config. It runs no agent,
version command, ACP handshake or sign-in operation; it reads no provider credentials.
**Bind reviewed saved configuration** preserves reopening identity only. The harmless
sample remains agent-free and does not establish provider acceptance.

## Evidence and recovery

| Observation | Meaning and next action |
| --- | --- |
| Missing | No executable found in the bounded absolute app PATH entries or at the configured absolute path. Finder may not inherit a terminal's PATH. Set an approved absolute executable path in Config, Save, then review again. Relative commands/PATH entries do not search the current directory. |
| Unavailable | File access or a minimum readable header was unavailable. Review the path, access and runtime prerequisites with an operator. Setup changes no permissions and installs nothing. |
| Architecture mismatch | A complete recognized thin Mach-O CPU header differs from the app runtime architecture. Select an approved matching build and review again. Physical CPU, translation support and native execution remain unverified; setup installs no replacement. |
| Executable file observed | Executable access and a bounded header read succeeded. Format, interpreter, runtime prerequisites and compatibility remain unverified. Scripts, universal binaries and unknown headers do not establish architecture compatibility. |

The public projection separates these observations from **agent/version support:
unknown**, **installed version: unknown**, **ACP: not checked**, and **sign-in:
unknown**. `claude-code-acp` and `codex-acp` configured basenames are candidate routing
hints only; neither is installed executable/artifact/source correspondence. Other
commands remain unverified, rather than being silently accepted or declared universally
unsupported. No supported installed provider/version pair is certified by this review.
Historical versions in [real-agent testing](../REAL-AGENT-TEST.md) are historical receipts,
not a current support matrix.

For real-agent handoff, an operator must separately review the installed provider and
bridge versions, runtime, ACP route, selected project, transmission, cost, permission
and stop limits, then obtain authorization for bounded checks. A successful ACP
initialization alone would not establish a usable signed-in provider session. If sign-in
is required or expired, use the provider's own sign-in flow, review subscription/quota,
and repeat the separately authorized check. Never paste credentials into setup or
support exports. Setup supplies guidance, not a sign-in or provider execution button.

**Exact-command approval remains unsupported under #594.** Local observation,
configuration binding, generic ACP callbacks and synthetic tests cannot clear that hold.
Reuse the [current evidence contract](594-command-evidence-v1.md) and keep positive
installed-provider/actual-Cal exact-command acceptance disabled until its requirements
are satisfied.

## Review lifetime and validation limits

Cancel configuration review retires its main-owned ephemeral handle without binding,
writing a receipt, connecting a daemon or changing selected directories. Read setup again
also cancels an open review. Failed rereview discards the old handle; the renderer retires
old evidence before retry/binding and on workspace changes. Late responses cannot restore
another target's review. Existing revision, expiry, target and caller checks still guard
binding. A failed binding is reported as unconfirmed because a durable journal write may precede receipt publication; rereview reconciles that existing evidence before retry. Missing, unavailable and unknown provider states do not prevent saving Config
or running the harmless sample; saving is not compatibility acceptance.

Portable tests use synthetic files/headers and existing temporary project/daemon seams.
They cover nonexecution, PATH correction/retry, nonfiles/invalid paths/short reads,
unknown formats, complete versus truncated Mach-O evidence, failed rereview, cancellation,
retired handles, fixed recovery text, focus and stale-target responses. They do not prove
an installed provider pair, expired-session detection, Finder/TCC behavior, packaged or
physical Mac execution. Those remain separate #390/#602 acceptance; diagnostics integration
is owned by #416/#469 and is not activated here.
