/**
 * `ConfigField` — the shell every row of the config form sits in: label, the dotted path,
 * the control, and help or an error under it.
 *
 * The path is not optional and is not a tooltip. The config form is a view of a file that
 * a person also edits by hand, and a form field that does not say which key it writes is a
 * form field you cannot reconcile with the file. `onShowRaw` is the other half of that:
 * from any field, the raw document, scrolled to this path.
 *
 * **There are two documents, so a path is not enough to name a place (#266).** Config
 * shows `orca.config.yaml` and the ADR 0009 permission sidecar beside it, and
 * `agents.claude.rules` means one thing in each. `document` says which file the path is
 * in — it is what makes "show raw" open the right one, and it defaults to `config` because
 * that is the document most of the form is about.
 *
 * It owns no control. The input, select or toggle is `children` — a render function, so
 * that the field can hand it the ids that wire the label, the help and the error to it
 * without knowing what kind of control it is.
 */
import { useId, type JSX, type ReactNode } from "react";
import { textClass } from "./text.js";

/** What the field wires up for whatever control it wraps. Spread onto the control. */
export interface ConfigFieldControl {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/** Which of the workspace's two configuration documents a field's path is in (#266). */
export type ConfigFieldDocument = "config" | "permissions";

/** What the raw button says it will open, per document. */
const RAW_DOCUMENT: Record<ConfigFieldDocument, string> = {
  config: "the raw YAML",
  permissions: "the raw permission sidecar",
};

export interface ConfigFieldProps {
  label: string;
  /** Dotted path into `document` — always shown, it is how the form maps to the file. */
  path: string;
  /** Which document that path is in. Defaults to `config`, the YAML. */
  document?: ConfigFieldDocument;
  children: (control: ConfigFieldControl) => ReactNode;
  help?: string;
  error?: string;
  /**
   * Opens that document's raw view, scrolled to and highlighting this path.
   *
   * Optional, because one section of the Config surface is fields of a document ORCA does
   * not own: the app's own preferences have a key and no raw view anywhere in this app to
   * show it in. Those fields still show their path — it is what is written — and draw no
   * **raw** button, rather than a button that does nothing.
   */
  onShowRaw?: (path: string, document: ConfigFieldDocument) => void;
}

export function ConfigField({
  label,
  path,
  document = "config",
  children,
  help,
  error,
  onShowRaw,
}: ConfigFieldProps): JSX.Element {
  const base = useId();
  const controlId = `${base}-control`;
  const helpId = `${base}-help`;
  const errorId = `${base}-error`;

  const described = [help !== undefined ? helpId : "", error !== undefined ? errorId : ""].filter(Boolean).join(" ");
  const control: ConfigFieldControl = {
    id: controlId,
    ...(described === "" ? {} : { "aria-describedby": described }),
    ...(error === undefined ? {} : { "aria-invalid": true as const }),
  };

  return (
    <div className="orca-field">
      <label className={`orca-field__label ${textClass("label-strong")}`} htmlFor={controlId}>
        {label}
        <span className={`orca-field__path ${textClass("mono-id")}`}>{path}</span>
      </label>
      <div className="orca-field__control">
        {children(control)}
        {help !== undefined && (
          <span className={`orca-field__help ${textClass("caption")}`} id={helpId}>
            {help}
          </span>
        )}
        {/* An error does not replace the help: "what this key means" is still the thing
            you need in order to fix it. */}
        {error !== undefined && (
          <span className={`orca-field__error ${textClass("caption")}`} id={errorId} role="alert">
            {error}
          </span>
        )}
      </div>
      {onShowRaw !== undefined && (
        <button
          type="button"
          className={`orca-field__raw ${textClass("mono-id")}`}
          onClick={() => onShowRaw(path, document)}
          aria-label={`show ${path} in ${RAW_DOCUMENT[document]}`}
        >
          raw
        </button>
      )}
    </div>
  );
}
