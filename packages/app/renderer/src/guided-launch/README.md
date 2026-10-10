# Guided launch production integration

The mounted integration starts from main `db579fb7ac9cfce2e4e6901713088a80602311da`,
including #548 (`d014461b0d0b477fe828586a0f0c3dbff3de78be`), #553 and #470.
It consumes the accepted #440 packet and #542 declarations
(`703c422aef6df7b0af008ec53349cab3e711f2f5`), without changing their runtime architecture.

`orca://launch`, the Config header and the palette open the merged `GuidedLaunch` UI.
Existing palette admission/recovery commands remain available for their legacy protected
intents; the shared journal keeps them distinct from guided commands.
`launch-context.tsx` holds its draft/controller above surface navigation and registers
unsent/busy/unresolved work with the existing update/connection draft guard. Accepted
receipts remain accepted across context refresh and do not block updates. Close and
Escape retain this session; accepted receipts navigate through the existing run route.
Typed editor text, including invalid JSON, stays in that session controller so navigation
cannot replace the displayed text with an older parsed value. It is absent from commands,
ordinary preferences and URLs.
The local diagnostics section keeps its component identity when Config switches into
launch. Leaving Config follows its existing diagnostics cleanup lifecycle. No production
capture, provider invocation, publication or permission grant is activated by opening it.

`main/guided-launch-adapter.ts` composes the existing main controller with target-guarded
operator aliases and the **same encrypted journal** used by palette admission. It captures
one credential for discovery, independent review and send; ordinary client credential
refresh cannot change the operation's principal. Main owns the execution key and persists
exact target, checkout, guards and command before submission. Operator failure projections
receive a fixed safe explanation, while operation/admission/Request IDs and retry envelopes
remain intact. Only accepted receipts navigate. Prepared, in-progress, recoverable failure
and lost responses retain the original intent.

`main/guided-checkout.ts` supports the accepted prepared-local track only. It requires an
explicit local root in applied configuration, resolves it relative to the configuration
file as bootstrap does, and observes repository, attached branch, base, status and tracked
changes. The opaque evidence also binds the discovered endpoint/principal, so an across-call
credential switch cannot adopt another principal's preview. These bounded observations are
rechecked in main before admission. They are not an
immutable filesystem snapshot; untracked file contents are not inspected. It creates no
checkout, branch, worktree or directory and performs no per-launch configuration change.
Remote/read-only/other workspace profiles remain unavailable for new launch until their
verified adapter exists. Configuration/catalog read failures do not disable independent
protected-intent restoration/recovery under current authenticated scope and recovery grants.

After acknowledgement loss, `resolveIntent` matches the **complete frozen review** inside
main's journal. It never infers a command from workflow/target-only metadata and never mints
a replacement key. Same-scope reconnect requires target review before recovery. Across app
restart, the user explicitly selects a retained handle and restores its exact protected
command; all restored variables are masked independently of later workflow metadata.
Inspection with no known operation ID refuses to send. Explicit reconciliation can resend
only the protected original command/key. New work requires acknowledged main confirmation
of abandonment; it does not cancel existing work. Another endpoint/workspace/principal
cannot adopt an original intent.

Catalog input declarations come from guarded operator preflight's exact workflow revision;
a separate display read cannot attach an older schema to a newer review. Legacy peers
without this projection cannot supply new launch bindings. A confirmed absent declaration
is distinct from unavailable metadata. Sensitive values remain withheld, including after
protected restoration or changed declarations.

Resolved agent/model/instruction selections and their sources come from the same guarded
preflight and are retained with its exact command. Main independently rechecks that
projection before retention. Provider-selected model provenance can remain unavailable;
the preview says so instead of inventing a model. The workflow revision and active
configuration remain the authoritative admission guards.

The mounted preview requires acknowledgement of configured permission policy for each
exact review. Runtime permission requests still use existing confirmation bindings.
Authorized, generation-bound operator choices supply Request role/agent, declared per-agent
model, item-workflow and template-pack selectors. Request preflight and main's independent
review validate those overrides through captured admission before protected retention.
Missing choice authority, incomplete pagination or stale generations leave the selectors
unavailable while configured launches and separately authorized recovery remain available.
Request title/body are passed as a descriptor; the service-owned `request` input is never
an editable or caller-supplied variable. Direct launch still has no override field.

Recovery uses its own current inspection/reconciliation grants. Losing permission to start
new work does not block permitted inspection of an original intent; inspection never sends
a command when no operation ID is known.

Remaining handoff dependencies are bounded: the delivery owner's reviewed JEV-free beta
workflow ID/version/digest, task/instruction/result assets, a fresh configuration generation
without JEV, and writable dedicated first-run project provisioning. This slice adds no JEV
or TypeSafe requirement and preserves their existing code/history. Unsent drafts are
session-only: optional protected unsent-draft storage remains visibly unavailable. Physical
Mac keychain, Finder/PATH, packaged sample, crash/restart and real-agent proof remain separate
native acceptance. #334/#386 are not closed by synthetic route tests.

Focused source acceptance exercises the real renderer shell/preload and main client/schema/journal
composition against synthetic HTTP and temporary Git repositories. It does not run a daemon,
provider, capture job or native host acceptance job.
Windows ownership verification for first-run sample assets currently refuses because its
directory adapter requires POSIX `getuid`. Windows source tests assert that refusal; the two
sample acceptance cases run only where that owner identity is actually supported. This is
not Windows packaged sample or first-run acceptance.
