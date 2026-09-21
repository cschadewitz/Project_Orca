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

## Five surfaces

| Surface | What it answers | Phase |
| --- | --- | --- |
| **Attention** | What needs me right now | 1 |
| **Runs** | What is happening and what happened | 1 |
| **Plan** | What is coming, why it is not moving, what it depends on | 2 |
| **Agents** | Who is doing the work and are they healthy | 1 read, 2 write |
| **Config** | How the system is wired, and what the workflows are | 2 |

Attention is a surface, not a notification tray: it is first in the sidebar, it has a
permanent keyboard address (`⌘1`), and it is the app's landing screen. When nothing is waiting
it says so and the runs that failed are still listed below, so the top item in the sidebar is
never a dead end.

## Dual spine

Runs and Plan are peers, not parent and child. A run is an *execution*; a work item is a
*commitment*. They have different lifetimes — a work item outlives the runs that attempt it,
and a program run spans many work items — so neither can be the other's container.

They are joined by the **object header**, which is present on every screen that has an object
and is the only breadcrumb in the app:

```
sso-rollout  ▸  auth-sso-epic  ▸  run 7f3a2c  ▸  build (attempt 2)
  request         work item        run             step
```

Every crumb is a link, every crumb has a type label, and the crumb for the object you are
looking at is not a link. From any crumb, a menu offers the counterpart objects: from a work
item, "runs that attempted this" and "dependencies"; from a run, "the work item it claims"
and "the workflow it executes". This is how cross-linking works — one component, no dead ends,
and no surface needs to embed another's navigation.

## Deep links

`orca://` URLs open the app and resolve to exactly one object, so another tool (Kepler, Zed,
a CI comment) can hand a person a place rather than a search.

```
orca://run/7f3a2c                      the run tree, that run selected
orca://run/7f3a2c/step/build.2         step detail, attempt 2, output scrolled to its start
orca://gate/91c4                       attention surface, that gate focused, answer buttons armed
orca://item/auth-sso-epic              plan, that work item, explanation panel open
orca://artifact/spec.md@v3?run=7f3a2c  the docked panel, that artifact, version 3
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
- **`orca://item/…` and `orca://workflow/…` name surfaces that do not exist yet** — Plan
  (#170) and the workflow viewer (#177) are both v0.5.0; workflow *editing* is v0.6.0. They
  resolve all the same: the surface is selected
  and the id is shown on its unbuilt state. A link is never dropped because the screen behind
  it has not been built.
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
(answer gate, cancel run, resume run, waive dependency, toggle density), **navigation**
(recent runs, work items, agents, config files, workflows), and **search** (step and artifact
names). Typing a bare run id or an `orca://` URL jumps straight to it. The
palette is the only place a phase-2 write action needs to be discoverable, which keeps the
chrome of phase-1 screens empty.

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
  labelled as such, so there is one place to look.
