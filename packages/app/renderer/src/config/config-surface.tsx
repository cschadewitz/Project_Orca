/**
 * The Config surface: how the system is wired, in one place
 * (docs/design/10-information-architecture.md).
 *
 * It shows **two documents and one section that is neither**:
 *
 * - `orca.config.yaml`, as a form over the schema `config.get` describes and as the raw
 *   bytes, switched by a segmented control in the object header. They are two spellings of
 *   one document, and the save bar under them is the same bar either way — what differs is
 *   the write it sends: a `patch` from the form, which keeps the file's comments, or the
 *   `text` from the editor, which is the bytes a person typed.
 * - the ADR 0009 permission sidecar (#266), as the effective policy per agent in evaluation
 *   order and as its own raw JSON. It is **read-only here**: editing grants is #176, and a
 *   screen that showed an editable sidecar it could not write would be a promise it cannot
 *   keep.
 * - the app's own preferences, labelled as stored elsewhere, saved immediately and with no
 *   draft (`preferences-section.tsx`).
 *
 * Three surface-level decisions:
 *
 * - **The save bar is absent, not disabled, where there is nothing to send to.** File mode
 *   and a `--read-only` daemon have no `config.set` at all, and the form goes read-only
 *   with it — which is asked of `hello.methods` (`useMethodPresent("config.set")`) rather
 *   than of the `runs.control` capability, because a daemon serving a store outside a
 *   workspace drives runs and still has no configuration to write
 *   (docs/design/40-connection-states.md). Disconnected keeps the bar, dims the values it
 *   is over and says why the buttons will not fire.
 * - **`⌘S` is registered in the `config` scope**, so it means "save this draft" where a
 *   draft is, and the command palette lists it because the palette is a view of the
 *   registry rather than a second table.
 * - **The surface does not decide what is valid.** Every error on a field is the daemon's,
 *   placed by path; an error against a path no field draws is listed above the form rather
 *   than swallowed (`placeErrors`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { ConnectionState } from "@orca/design";
import { CONFIG_SET_METHOD, type ConfigDocument } from "@orca/protocol";
import { useSurfaceDensity } from "../appearance-context.js";
import { useMethodPresent, useWritability } from "../chrome/use-connection.js";
import { SURFACES } from "../chrome/surfaces.js";
import { useKeyboard } from "../keyboard-context.js";
import { scopeProps } from "../keyboard-map.js";
import { ObjectHeader, StateView, Text, textClass } from "../ui/index.js";
import { ConfigForm } from "./config-form.js";
import { DraftBar } from "./draft-bar.js";
import { PermissionsView } from "./permissions-view.js";
import { PreferencesSection } from "./preferences-section.js";
import { RawView } from "./raw-view.js";
import { agentPolicies, buildSections, fieldPaths, patchFrom, placeErrors } from "./config-model.js";
import { useConfig } from "./config-context.js";
import "./config.css";

export interface ConfigSurfaceProps {
  /** Whether the daemon is answering. A screen nobody is updating says so rather than lying. */
  connection: ConnectionState;
  /**
   * Which document a deep link named (`orca://config/permissions`). The document it names
   * is focused rather than scrolled to: focus is where the keyboard already is, a browser
   * brings a focused element into view by itself, and a `scrollIntoView` cannot reach an
   * element that is not in the document yet.
   */
  open?: ConfigDocument;
}

type View = "form" | "raw";

export function ConfigSurface({ connection, open }: ConfigSurfaceProps): JSX.Element {
  useSurfaceDensity();
  const feed = useConfig();
  const writability = useWritability();
  /* The method, not the capability: `runs.control` says the daemon drives runs, and a
     daemon serving a store outside a workspace drives runs and has no `config.set` at all
     (`methodPresent`, packages/daemon/src/methods.ts `methodsFor`). */
  const canSet = useMethodPresent(CONFIG_SET_METHOD);
  const live = connection === "live";

  const [view, setView] = useState<View>(open === "config" ? "raw" : "form");
  /** The path **raw** was pressed on. Only the YAML has a "show raw" on this screen. */
  const [target, setTarget] = useState<string | undefined>(undefined);

  /* A deep link naming the YAML arrives at a surface that may already be mounted — the
     draft model is above the surface switch now, and this screen is not remounted for it. */
  useEffect(() => {
    if (open === "config") setView("raw");
  }, [open]);

  const data = feed.state.phase === "ready" ? feed.state.data : undefined;
  const draft = feed.draftOf("config");
  const save = feed.saveStateOf("config");

  const sections = useMemo(() => (data ? buildSections(data.schema, data.config.parsed) : []), [data]);
  const drawn = useMemo(() => fieldPaths(sections), [sections]);
  const placed = useMemo(() => placeErrors(save.errors, drawn), [save.errors, drawn]);
  const policies = useMemo(() => (data ? agentPolicies(data.effective) : []), [data]);

  const edits = draft?.kind === "form" ? draft.fields : EMPTY_EDITS;
  /* What would be written, not what was typed: a field typed back to the file's own value
     is not a change, and neither is raw text that is character for character the file. */
  const changes =
    draft === undefined || data === undefined
      ? 0
      : draft.kind === "raw"
        ? draft.text === data.config.text
          ? 0
          : 1
        : patchFrom(draft.fields, data.config.parsed).length;

  /* One document has fields with a **raw** button on this screen: the YAML. The sidecar is
     rendered as its rules and its bytes, and nothing here draws a `document="permissions"`
     field — the policy editor does, and it is mounted on the Agents surface with no
     `onShowRaw` at all. So the target is a path, not a path and a document. */
  const showRaw = useCallback((path: string) => {
    setTarget(path);
    setView("raw");
  }, []);

  const onSave = useCallback(() => feed.save("config"), [feed]);
  useSaveKey(changes > 0 && canSet && writability.can, onSave);

  if (feed.state.phase === "loading") {
    return (
      <Surface>
        <StateView kind="loading" title="Loading the configuration" />
      </Surface>
    );
  }

  if (feed.state.phase === "error") {
    const error = feed.state.error;
    return (
      <Surface>
        {live ? (
          <StateView
            kind="error"
            title="Could not read the configuration"
            body={`${error.code}: ${error.message}`}
            action={{ label: "Try again", onClick: feed.reload }}
          />
        ) : (
          <StateView
            kind="disconnected"
            title="No daemon to read the configuration from"
            body="Start one with orca serve, then try again."
            action={{ label: "Try again", onClick: feed.reload }}
          />
        )}
      </Surface>
    );
  }

  const config = feed.state.data.config;
  const permissions = feed.state.data.permissions;
  const rawText = draft?.kind === "raw" ? draft.text : config.text;
  // The bar is there while there is something to write, which is not the same as "somebody
  // typed": an edit undone leaves the screen as it found it, bar included.
  const hasDraft = draft !== undefined && changes > 0;

  return (
    <Surface>
      <ObjectHeader
        crumbs={[{ type: "config", id: config.path, label: fileName(config.path), current: true }]}
        actions={
          <div className="orca-seg" role="group" aria-label="View">
            <button
              type="button"
              className={`orca-seg__btn ${textClass("label")}`}
              aria-pressed={view === "form"}
              onClick={() => setView("form")}
            >
              Form
            </button>
            <button
              type="button"
              className={`orca-seg__btn ${textClass("label")}`}
              aria-pressed={view === "raw"}
              onClick={() => setView("raw")}
            >
              Raw
            </button>
          </div>
        }
      />

      {!live && (
        <div className={`orca-banner ${textClass("caption")} orca-banner--stale`} role="status">
          <Text style="caption">Not connected — this is the last the daemon said about this workspace.</Text>
        </div>
      )}

      {/* Last-known values dim; the labels around them do not (40-connection-states.md). */}
      <div className={`orca-config__body${live ? "" : " orca-stale-value"}`}>
        {/* Visible, and not a live region (RULES.md rule 11). The first error's sentence is
            announced once by `use-config.ts` when the Validate or the Save comes back; a
            second region repeating the list would interrupt with what is already on screen
            and under the person's own cursor. */}
        {placed.unplaced.length > 0 && (
          <div className="orca-config__unplaced">
            <Text style="label-strong">The daemon reported errors that belong to no field on this form:</Text>
            <ul>
              {placed.unplaced.map((error) => (
                <li key={`${error.path}:${error.message}`} className={textClass("caption")}>
                  {error.path === "" ? error.message : `${error.path}: ${error.message}`}
                </li>
              ))}
            </ul>
          </div>
        )}

        {view === "form" ? (
          <ConfigForm
            sections={sections}
            edits={edits}
            errors={placed.byPath}
            {...(canSet ? { onChange: (path, value) => feed.setField("config", path, value) } : {})}
            onShowRaw={showRaw}
          />
        ) : (
          <RawView
            path={config.path}
            text={rawText}
            label="orca.config.yaml"
            /* `orca://config` names this document, and landing on a document means being
               in it — the same promise `orca://config/permissions` keeps below. */
            autoFocus={open === "config"}
            {...(target === undefined ? {} : { target })}
            {...(canSet ? { onChange: (text: string) => feed.setText("config", text) } : {})}
          />
        )}

        <PermissionsView policies={policies} live={live} path={permissions.path} exists={permissions.exists} />
        {/* Read-only in this issue: #176 is where a grant is edited or removed. */}
        <RawView
          path={permissions.path}
          text={permissions.text}
          label="orca.permissions.json"
          autoFocus={open === "permissions"}
        />

        <PreferencesSection surfaces={SURFACES.map((surface) => ({ id: surface.id, label: surface.label }))} />

        {/* Said on the screen that writes the file, because it is the thing a person is
            most likely to assume wrongly: `orca serve` reads the configuration once, at
            boot, and the daemon answering right now is running on what it read then. */}
        <Text style="caption">
          A saved configuration takes effect on the next orca serve — the running daemon keeps the configuration it
          booted with.
        </Text>
      </div>

      {/* Absent where there is nothing to send to — file mode, a `--read-only` daemon, a
          daemon whose `hello.methods` has no `config.set`. Present and *disabled* while
          disconnected or reconnecting, with the reason on the two buttons: those are a
          daemon that would take the write if it were answering, and
          docs/design/40-connection-states.md asks for the reason on the control rather than
          for a bar that vanishes with the draft it was counting. */}
      {canSet && hasDraft && (
        <DraftBar
          changes={changes}
          busy={save.busy}
          {...(save.conflict === undefined ? {} : { conflict: save.conflict })}
          {...(save.message === undefined ? {} : { message: save.message })}
          {...(writability.can ? {} : { disabledReason: writability.reason })}
          note={
            draft.kind === "raw"
              ? "Editing the raw text replaced the form's edits: the last edited wins."
              : "Editing a field replaces any raw text you had typed: the last edited wins."
          }
          onValidate={() => feed.validate("config")}
          onSave={onSave}
          onDiscard={() => feed.discard("config")}
          onReload={feed.reload}
        />
      )}
    </Surface>
  );
}

const EMPTY_EDITS: ReadonlyMap<string, unknown> = new Map();

/** The file's name, for the crumb; the whole path is on the raw view, where it is useful. */
const fileName = (path: string): string => path.split("/").pop() ?? path;

/** The surface root: `data-surface` for density, and the scope `⌘S` is registered in. */
function Surface({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="orca-config" data-surface="config" {...scopeProps("config")}>
      {children}
    </div>
  );
}

/**
 * `⌘S`. Registered only while there is a draft that could be saved and a daemon that would
 * take it, so the palette lists a command that does something rather than one that would
 * silently do nothing (#205's rule, the other way round).
 */
function useSaveKey(enabled: boolean, save: () => void): void {
  const keyboard = useKeyboard();
  const current = useRef(save);
  current.current = save;

  useEffect(() => {
    if (!enabled) return;
    return keyboard.register({
      scope: "config",
      key: "Mod+S",
      label: "Save the configuration",
      detail: "Writes the draft to the file the form is over",
      action: () => current.current(),
    });
  }, [keyboard, enabled]);
}
