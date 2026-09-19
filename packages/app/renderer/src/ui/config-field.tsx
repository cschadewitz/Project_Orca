/**
 * `ConfigField` — the shell every row of the config form sits in: label, the dotted YAML
 * path, the control, and help or an error under it.
 *
 * The path is not optional and is not a tooltip. The config form is a view of a YAML file
 * that a person also edits by hand, and a form field that does not say which key it
 * writes is a form field you cannot reconcile with the file. `onShowRaw` is the other
 * half of that: from any field, the raw YAML, scrolled to this path.
 *
 * It owns no control. The input, select or toggle is `children` — a render function, so
 * that the field can hand it the ids that wire the label, the help and the error to it
 * without knowing what kind of control it is.
 */
import { useId, type JSX, type ReactNode } from "react";

/** What the field wires up for whatever control it wraps. Spread onto the control. */
export interface ConfigFieldControl {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

export interface ConfigFieldProps {
  label: string;
  /** Dotted path into the YAML — always shown, it is how the form maps to the file. */
  path: string;
  children: (control: ConfigFieldControl) => ReactNode;
  help?: string;
  error?: string;
  /** Opens the raw YAML view scrolled to and highlighting this path. */
  onShowRaw: (path: string) => void;
}

export function ConfigField({ label, path, children, help, error, onShowRaw }: ConfigFieldProps): JSX.Element {
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
      <label className="orca-field__label" htmlFor={controlId}>
        {label}
        <span className="orca-field__path">{path}</span>
      </label>
      <div className="orca-field__control">
        {children(control)}
        {help !== undefined && (
          <span className="orca-field__help" id={helpId}>
            {help}
          </span>
        )}
        {/* An error does not replace the help: "what this key means" is still the thing
            you need in order to fix it. */}
        {error !== undefined && (
          <span className="orca-field__error" id={errorId} role="alert">
            {error}
          </span>
        )}
      </div>
      <button
        type="button"
        className="orca-field__raw"
        onClick={() => onShowRaw(path)}
        aria-label={`show ${path} in the raw YAML`}
      >
        raw
      </button>
    </div>
  );
}
