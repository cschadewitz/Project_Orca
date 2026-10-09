# Guided launch production integration

The mounted integration starts from main `db579fb7ac9cfce2e4e6901713088a80602311da`,
including #548 (`d014461b0d0b477fe828586a0f0c3dbff3de78be`), #553 and #470.
It consumes the accepted #440 packet and #542 declarations
(`703c422aef6df7b0af008ec53349cab3e711f2f5`), without changing their runtime architecture.

`orca://launch`, the Config header and the palette open the merged `GuidedLaunch` UI.
Existing palette admission/recovery commands remain available for their legacy protected
intents; the shared journal keeps them distinct from guided commands.
`launch-context.tsx` holds its draft/controller above surface navigation and registers
unsent/busy/unresolved work with the existing update/connection draft guard. Close and
Escape retain this session; accepted receipts navigate through the existing run route.
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

Detailed resolved agent/model/instruction provenance remains unavailable in this adapter;
the workflow revision and active configuration are the authoritative launch guards.

The mounted preview requires acknowledgement of configured permission policy for each
exact review. Runtime permission requests still use existing confirmation bindings. Request
overrides remain unavailable because vars-only preflight supplies no authoritative override
validation; no guessed override controls or grants are introduced.

Remaining handoff dependencies are bounded: the delivery owner's reviewed JEV-free beta
workflow ID/version/digest, task/instruction/result assets, a fresh configuration generation
without JEV, and writable dedicated first-run project provisioning. This slice adds no JEV
or TypeSafe requirement and preserves their existing code/history. Unsent drafts are
session-only: optional protected unsent-draft storage remains visibly unavailable. Physical
Mac keychain, Finder/PATH, packaged sample, crash/restart and real-agent proof remain separate
native acceptance. #334/#386 are not closed by synthetic route tests.

Focused acceptance exercises the real renderer shell/preload and main client/schema/journal
composition against synthetic HTTP and temporary Git repositories. It does not run a daemon,
provider, capture job or native host acceptance job.
