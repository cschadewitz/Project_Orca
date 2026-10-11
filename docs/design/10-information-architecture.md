# Information architecture

## The window

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ title bar   ORCA   ◆ 2 waiting        ● connected            ⌘K              │
├────────────┬───────────────────────────────────────────┬─────────────────────┤
│            │ object header                             │                     │
│  sidebar   │   Request ▸ Work item ▸ Run ▸ Step         │   docked panel      │
│  228px     ├───────────────────────────────────────────┤   420px             │
│            │                                           │   (artifacts)       │
│  Attention │              primary pane                 │                     │
│  Runs      │                                           │                     │
│  Plan      │                                           │                     │
│  Workflows │                                           │                     │
│  Agents    │                                           │                     │
│  Config    │                                           │                     │
│            │                                           │                     │
├────────────┴───────────────────────────────────────────┴─────────────────────┤
│ status bar   orca-daemon 0.9.4 · 3 runs active                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

A custom title bar with `-webkit-app-region: drag`, no OS chrome relied upon, inset for the
macOS traffic lights and for the Windows caption buttons by platform-detected padding only —
nothing else about the layout changes per platform.

Nothing sits between the title bar and the sidebar. The connection bars
(`40-connection-states.md`) and a link's landing notice are the primary pane's: under the
object header, or at the top of the pane on a surface with no header. A notice is a claim
about the pane it sits on, and one stretched across the rail reads as an alert about the
whole window. The landing notice appears only when a link could not be honoured: a URL this
version does not understand, a link that arrived with no daemon answering, an object the
surface does not have, or a counterpart the app cannot follow yet. A link that worked says
nothing, because the object header already names what is open. Dismissing a notice hides
the sentence and leaves the place it landed.

The two widths in that diagram are defaults, not fixtures. Every boundary in the window is
draggable and the size is remembered per boundary (#276) — the sidebar and the docked panel here,
and inside the surfaces the Runs step detail, the run tree over the event timeline, and the Plan
request rail. Each has a floor and a ceiling so neither pane can be dragged to something
unusable, and each gives way to the collapse and overlay rules below their breakpoints;
`50-accessibility-and-keyboard.md` has the keys, `60-implementation.md` has where the size lives.
The splitter is the shell's, so a surface still to be built inherits a resizable edge rather than
inventing one — the dependency graph, the risk matrix and the decision log all want a pane
boundary and none of them has to draw its own.

## Six surfaces

| Surface | Glyph | What it answers | Phase |
| --- | :---: | --- | --- |
| **Attention** | ◆ | What needs me right now | 1 — shipped |
| **Runs** | ☰ | What is happening and what happened | 1 — shipped |
| **Plan** | ⬡ | What is coming, why it is not moving, what it depends on | 2 — shipped in v0.5.0 (#170); the graph, risk and decision modes shipped in v0.6.0 (#171–#173) |
| **Workflows** | ⑂ | What the workflows are, and changing them | Added with the editor (#181): the list, the viewer (#177) and the editor (#180–#182) |
| **Agents** | ◉ | Who is doing the work and are they healthy | 1 read, 2 write — both shipped |
| **Config** | ❋ | How the system is wired | 2 — shipped in v0.5.0 (#175, #266) |

**Workflows is the sixth surface, added with the editor.** The design had five, with the
workflow viewer living under Config, reached only by link, from the palette, or from a run's
"the workflow it executes". That left a workflow nothing had run yet with no way to it from the
rail. With no workflow named, the surface lists every registered workflow, with its version,
size and whether a draft is open; **Open** is the viewer and **Edit** the editor. It sits after
Plan, with the surfaces about work, so Agents and Config moved to `⌘5` and `⌘6`.

Phase 2 is the configuration and monitoring wave, and as of v0.5.0 all five surfaces have
content. Plan is the schedule table, the scheduler's explanations, a requests sidebar and the
journal, and as of v0.6.0 its object header's mode control has five positions — Schedule,
Risks, Decisions, Dependencies, Journal — with the risk matrix (#172), the decision matrix
(#173) and the dependency graph (#171) behind them. **The docked panel is a Plan surface as
well as a Runs surface**: Plan owns what is in it and names it — "Work item" for the schedule
row's inspector, "Risk" for a selected risk's status, held items and journal entries, and
"Relationships" for the graph's inspector (blocked by, blocks, waive). Config is `orca.config.yaml` as a form over the schema the daemon describes, beside
the raw file, with the permission sidecar as its second document. The workflow viewer
(#177), where `orca://workflow/…` lands, moved to the Workflows surface with the editor.

The glyph column is `semantics.json`'s `surface` map, bundled in the symbol face like every
other glyph the app draws — it is never the OS's. It sits beside the label in the sidebar and
becomes the whole of it below 960px, where the rail collapses (`50-accessibility-and-keyboard.md`),
so the six are chosen to be told apart in greyscale at `--icon-md`: a solid diamond, three
bars, a hollow hexagon, a fork, a ring round a dot, a radial burst. Attention carries the same ◆ the
waiting status does, deliberately — the surface for what is waiting on a person is the one
place that shape means the same thing twice. Config is radial rather than a cog because no
OFL face ORCA bundles draws one (U+2699 is in neither Noto subset), and an OS cog would be a
different drawing on each platform.

Attention is a surface, not a notification tray: it is first in the sidebar, it has a
permanent keyboard address (`⌘1`), and it is the app's landing screen. When nothing is waiting
it says so and the runs that failed are still listed below; when nothing has failed either, it
lists the runs that are in flight, and `Enter` opens the selected one. So the top item in the
sidebar is never a dead end: it answers "what needs me" first and "what is happening" when the
answer to the first is nothing. Only a workspace with nothing waiting, nothing failed and
nothing running is an empty screen, and then the screen is honest.

## Dual spine

Runs and Plan are peers, not parent and child. A run is an *execution*; a work item is a
*commitment*. They have different lifetimes — a work item outlives the runs that attempt it,
and a program run spans many work items — so neither can be the other's container.

They are joined by the **object header**, which is present on every screen that has an object
and is the only breadcrumb in the app:

```
❝ 5BNH42  ▸  Database schema ⬡ 5M579G  ▸  Database schema ☰ JH7X8P  ▸  design (attempt 2) ▭ C6SE2Q
 request          work item                     run                         step
```

Every crumb is a link, every crumb has a type label, and the crumb for the object you are
looking at is not a link. A crumb leads with the object's name and follows its type label
with the id's token — the kind's glyph and the last six characters, faint (`ObjectId`) — so
two runs of one name are told apart in the trail; an object with no name on any read model,
which today is a request, is its token in the name's place. From any crumb, a menu offers
**Copy link**, **Copy id** (the whole id, not the six characters on screen) and the
counterpart objects: from a work item, "runs that attempted this" and "dependencies"; from a
run, "the work item it claims" and "the workflow it executes". This is how cross-linking
works — one component, no dead ends, and no surface needs to embed another's navigation.

## Deep links

`orca://` URLs open the app and resolve to exactly one object, so another tool (Kepler, Zed,
a CI comment) can hand a person a place rather than a search.

```
orca://run/7f3a2c                      the run tree, that run selected
orca://run/7f3a2c/step/build.2         step detail, attempt 2, output scrolled to its start
orca://gate/91c4                       attention surface, that gate focused, answer buttons armed
orca://item/auth-sso-epic              plan, that work item, explanation panel open
orca://plan?mode=deps&focus=auth-sso   plan in the dependency graph, that node selected (#171)
orca://artifact/spec.md@v3?run=7f3a2c  the docked panel, that artifact, version 3
orca://launch                          guided launch on Config, including setup/recovery
orca://workflow/ai-sdlc                workflow viewer, no run overlaid
orca://workflow/ai-sdlc?run=7f3a2c     workflow viewer with that run overlaid
orca://agent/claude-local              agents, that agent's card
```

Three of those lines are corrections made when the table was implemented (#165), and each
one is worth keeping in mind before a new form is added:

- **An artifact carries the run that produced it.** Versions are monotonic per (run, name),
  so `orca://artifact/spec.md@v3` alone names as many artifacts as there are runs with a
  `spec.md`. The `?run=` form is canonical and is what **Copy link** emits; a bare name is a
  palette *search*, not a link.
- **`orca://item/…` named a surface that did not exist yet** — Plan (#170) shipped in
  v0.5.0, and the link now lands on the schedule with that work item selected and its
  explanation open, exactly as the table above promises. An id this plan does not have
  leaves the table as it is and says which id it was holding, because a link is never
  dropped and never answered with something that was not asked for. **`orca://plan?mode=…`
  names the surface's own object** (#171): the plan is what the header is about, so the host
  is `plan` and the query says how it is shown (`mode`) and what is selected (`focus`); a
  work item's "dependencies" counterpart, which resolved to nothing in v0.5.0, is now this
  link with `mode=deps` and the item focused.
  **`orca://workflow/…` is built as of #177** and lands on the viewer, now on the Workflows
  surface (#181), with `?run=` overlaying that run's path over the graph and `?edit` opening
  the editor on the workflow's draft. With no workflow named, the surface is the list of
  workflows; Config (`⌘6`) is the configuration form and the raw file.
- **`orca://agent/…` was missing.** The Agents surface shipped in v0.4.0 and the palette lists
  agents, and every palette entry has to hand back a canonical URL.

A deep link to an object the daemon cannot currently produce lands on the object's screen in
its disconnected state with the id shown, never on a blank window or a generic error. A URL
this version of the app does not understand says so, with the URL, rather than being
swallowed — a newer build may know what it means.

**One table resolves all of them.** A URL arriving on a cold start, through macOS's
`open-url`, through a second launch's command line, from **Copy link** in an object header,
or from the palette's jump row is the same object selected the same way
(`renderer/src/route-table.ts`). A second launch focuses the window that is already open
rather than opening a second one onto the same store.

## Command palette

`⌘K` / `Ctrl+K`. Three kinds of entry, in this order: **actions** on the current object
(answer a gate with each option it offers, cancel or resume a run, start a run, waive a
dependency, decide or reopen a decision, update a risk, release a claim, toggle density —
every write the daemon serves, as of #178), **navigation**
(recent runs, work items, agents, config files, workflows), and **search** (step and artifact
names). Typing a bare run id or an `orca://` URL jumps straight to it. The
palette is the only place a phase-2 write action needs to be discoverable, which keeps the
chrome of phase-1 screens empty.

The highlighted row is the palette's one selection, and it belongs to the keys. Hover tints a
row and moves nothing, so a stray mouse cannot change what `Enter` does; a click is a choice,
and takes the selection with it.

Every object row is an `orca://` URL and opens through the route table above, which is what
keeps one resolver rather than three (#206). Two limits are worth writing down rather than
approximating: navigation lists the **ten most recent runs** and the configured agents, since
a person looking for the two-hundredth run types its id and the jump row takes it; and search
covers **step and artifact names** only. Event text and artifact *contents* need a
daemon-side search method — the protocol has none, `runs.events` pages rather than matches —
and scanning every log in the store from the renderer on each keystroke is not a search, it
is a denial of service against your own daemon.

## What the app deliberately does not have

- **No dashboard.** There is no screen of aggregate charts. Every number in the status bar is
  a count you can click into.
- **No global search screen.** Search lives in the palette and in per-surface filter fields.
- **No settings screen separate from Config.** Application preferences (theme, density,
  notifications) are a section of the Config surface, stored separately from the ORCA YAML and
  labelled as such, so there is one place to look. They save immediately and have no draft:
  they are the person's own window, not the workspace's configuration, and a Save button
  would imply a choice had not taken effect while it plainly had.

  **Config shows two documents, and the second is not YAML (#266).** The ADR 0009 permission
  sidecar — `orca.permissions.json`, where an answer of "allow always" is written — is the
  other document `config.get` returns, and Config renders it beside the YAML: each agent's
  effective policy in evaluation order, every rule chipped `config` or `sidecar`, and the
  sidecar's own JSON in a second raw view. So the surface holds three things stored in three
  places, and each one says where it lives.
