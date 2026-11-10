# Setup, launch and maintenance

The surfaces in `10-information-architecture.md` are about work: what is waiting, what is
running, what is planned. This file covers the parts of the app that prepare that work or look
after the app itself. Most of them live on Config (`⌘6`) and arrived in 0.7.0. Each entry
below is short on purpose. It says what the screen is, where it lives in code, and which
design rules it leans on. The protocol, trust and recovery contracts behind each one are in
the docs it links, not here.

Every rule in `RULES.md` applies to these screens as it does everywhere else. Three of them
matter most here:
- **Rule 12, never invent data.** A disabled capability says it is disabled; it never
  pretends to collect, verify or activate.
- **Rule 17, confirm only what has no way back.** Review comes before any write.
- **A refusal never costs a draft** (`60-implementation.md`, Config surface). Typed text
  survives navigation, refusal and lost acknowledgement.

## Guided launch

**Where:** `guided-launch/` (start at its `README.md`), opened by `orca://launch`, the
**Launch work** button in Config's object header, or the palette (`palette-launch.tsx`).

Guided launch is how a person starts work from the app. It has two modes: **Submit a Request**
creates a Request and admits its workflow, and **Start a workflow** starts a run with no
Request. The flow is **Target and configuration**, then **Workflow** and its typed inputs,
then a **Launch preview**, then a **Permission review**, and only then the send. Each input is
an explicit value or omitted. An invalid typed value is held as typed and blocks the preview
with a reason.

The draft lives in `launch-context.tsx`, above surface navigation. Leaving Config or pressing
`Esc` keeps the session, and an unsent or pending launch counts as an unsaved draft for the
update control. A launch whose acknowledgement was lost keeps its original intent: the screen
says "The launch intent is retained" and offers to restore that exact launch, never a new one
in its place. Only an accepted receipt navigates, and it goes to the run through the route
table.

## First-run project setup

**Where:** `first-run/first-run-section.tsx`, the first section on Config, labelled
**Dedicated project setup**.

First-run setup prepares a workspace before there is a daemon to talk to. It covers:
- choosing directories, then **reviewing** them before any file is created
- creating a reviewed private workspace and sample files
- connecting the selected workspace
- binding the saved configuration for reopening, after a review of it and of the local
  executable checks

When the last session did not close cleanly, the section says so and offers same-boot recovery.
Marking the previous session ended is an act with no way back, so it is confirmed on its own
row with the consequence beside it (rule 17). The screen never adopts or stops a process it
does not own, and it says when writer ownership is unknown. Every refusal tells the person what
was preserved ("Existing files were preserved").

The section is laid out in steps, each with its own heading: the selected directories in one
sunken list (names in sans, paths in mono, never cut), the step's next act as the primary
button, and **Reopening and recovery** grouped below. A refusal sits in its own block on a
`status-failed` rail, never the danger tone: "Setup was refused", then the reason main gave,
then what to do. Main writes those reasons for the screen (`first-run/refusal.ts`); a raw
operating system or Git failure is named by its code and never shown as text.

## Local diagnostics

**Where:** `diagnostics/diagnostics-section.tsx`, the second section on Config.

Local diagnostics is an on/off setting, a lookback (one to fifteen minutes, five by default)
and an explicit local export, with **Choose destination** and Save as separate steps. As of
0.7.0, **production capture is disabled**. The section says that the setting records a choice
and that this build does not collect production diagnostics. It also says when an earlier
export's outcome is unknown, and it never claims to have a complete export history. Report
contents stay in the main process until they are saved. There is no in-app viewer.

## Template studio

**Where:** `template-authoring/` (start at its `README.md`), the **Templates** position of
Config's header control.

The template studio is for authoring prompt templates. It has a catalog of template ids, each
template's declared context, its versions and known uses, and editable Markdown with front
matter. It also has fixture inputs for a rendered preview, validation errors from the daemon,
and a change review. The mounted flow (`template-authoring/surface.tsx`) has three steps, each a
separate act:
1. **Save reviewed source** saves one template source at a time. Other edits are kept until that
   source is saved or explicitly discarded. Saving changes the source only.
2. **Review saved catalog for Apply** validates the saved catalog.
3. **Apply reviewed template catalog** activates it for future launches. It is enabled only for
   the catalog revision that was just reviewed. Admitted runs keep the instructions they
   captured.

The isolated editor's **Publish reviewed template revision** label is not used on the mounted
surface. A change to the source, the target or write authority invalidates the review and any
pending preview, and a response that arrives late never lands on a newer draft. Workflow
instruction assignment (template to workflow node) has its own **Save reviewed template
assignment**.

## Updates

**Where:** `chrome/update-control.tsx` and `chrome/mac-update-control.tsx`, in the title bar.

The update control is described in `10-information-architecture.md` (the window): one button
whose label is the updater's state, and which the palette also lists. The design rules are:
- A restart never discards a draft.
- The window is `inert` while a restart is being prepared.
- An error is announced once, not shown as a stack of alerts.

On macOS, when the general updater is unavailable, the title bar shows `MacUpdateControl`
instead. It offers **Approve** and **Defer** on one exact candidate, and it hides itself when
main owns no candidate. As of 0.7.0, the macOS updater's approval, download and replacement
paths are built but not available in production, so a production build shows no Mac control at
all.
