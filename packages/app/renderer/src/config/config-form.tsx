/**
 * The YAML as a form: the sections `config-model.ts` built, each field a `ConfigField` with
 * the control its schema type asks for.
 *
 * What is decided here and not in the model is only what a control *is*:
 *
 * - an **enum** is a `Menu`, because every popover in this app is (AGENTS.md) — a native
 *   `<select>` would be a second keyboard contract and an OS-drawn list in a themed app;
 * - a **boolean** is a toggle button carrying `aria-pressed` and the word `On` or `Off`,
 *   never a colour alone;
 * - a **string** or a **number** is `.orca-input`;
 * - an **array of objects** is one `Card` per element, headed by the element's own id;
 * - a **record** is a row per key;
 * - and anything the schema could not describe is its JSON in a `Well`, read-only, saying
 *   so — a control invented for a type nobody could name would write a value nobody can
 *   check (RULES.md rule 12).
 *
 * Every field shows its dotted path in mono and offers **raw**, which is `ConfigField`'s
 * contract rather than this file's decision: a form over a file a person also hand-edits
 * has to say which key each row writes.
 */
import { type JSX } from "react";
import { Card, ConfigField, Menu, Text, Well, textClass, type ConfigFieldDocument } from "../ui/index.js";
import type { FieldNode, FormNode, FormSection, RawNode } from "./config-model.js";

export interface ConfigFormProps {
  sections: readonly FormSection[];
  /** The draft's edits by path, so an edited field shows what was typed and not the file. */
  edits: ReadonlyMap<string, unknown>;
  /** Validation errors by path, from the daemon. */
  errors: ReadonlyMap<string, string>;
  /** Absent means the form is read-only: no daemon will take a write (file mode, read-only). */
  onChange?: ((path: string, value: unknown) => void) | undefined;
  onShowRaw: (path: string, document: ConfigFieldDocument) => void;
}

export function ConfigForm({ sections, edits, errors, onChange, onShowRaw }: ConfigFormProps): JSX.Element {
  return (
    <div className="orca-config__form">
      {sections.map((section) => (
        /* Focusable from script and never a Tab stop: the first one is where focus goes when
           Save or Discard empties the draft and the save bar leaves (`DraftBar`). */
        <section
          key={section.id}
          className="orca-config__section"
          aria-label={section.title}
          tabIndex={-1}
          data-config-section=""
        >
          <Text style="heading" as="h2">
            {section.title}
          </Text>
          <Nodes nodes={section.nodes} edits={edits} errors={errors} onChange={onChange} onShowRaw={onShowRaw} />
        </section>
      ))}
    </div>
  );
}

interface NodesProps extends Omit<ConfigFormProps, "sections"> {
  nodes: readonly FormNode[];
}

function Nodes({ nodes, edits, errors, onChange, onShowRaw }: NodesProps): JSX.Element {
  return (
    <>
      {nodes.map((node) => {
        if (node.node === "raw") return <RawValue key={node.path} node={node} />;
        if (node.node === "group") {
          const body = (
            <Nodes nodes={node.children} edits={edits} errors={errors} onChange={onChange} onShowRaw={onShowRaw} />
          );
          return node.children.length === 0 ? (
            <Text key={node.path} style="caption" className="orca-config__none">
              {`Nothing under ${node.path} yet.`}
            </Text>
          ) : (
            /* An array element is a card; a nested object is a sub-heading. The difference
               is that the elements are a list of the same thing and the objects are not. */
            <Card key={node.path} eyebrow={node.label}>
              {body}
            </Card>
          );
        }
        return (
          <Field key={node.path} node={node} edits={edits} errors={errors} onChange={onChange} onShowRaw={onShowRaw} />
        );
      })}
    </>
  );
}

function RawValue({ node }: { node: RawNode }): JSX.Element {
  return (
    <div className="orca-config__raw-node">
      <Text style="label-strong">{node.label}</Text>
      <span className={`orca-config__path ${textClass("mono-id")}`}>{node.path}</span>
      <Text style="caption">{`Read-only here — ${node.reason}. Edit it in the raw view.`}</Text>
      <Well label={`${node.path} as JSON`}>{node.json}</Well>
    </div>
  );
}

interface FieldProps extends Omit<ConfigFormProps, "sections"> {
  node: FieldNode;
}

/** What a value reads as in a text box. `undefined` is an empty box, not the word "undefined". */
const asText = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";

function Field({ node, edits, errors, onChange, onShowRaw }: FieldProps): JSX.Element {
  const edited = edits.has(node.path);
  const value = edited ? edits.get(node.path) : node.value;
  const error = errors.get(node.path);
  const readOnly = onChange === undefined;
  // A required field with no value is the one thing the form can say before the daemon has:
  // the schema said it is required and the document has no key there.
  const help =
    node.help ??
    (node.default === undefined ? undefined : `Defaults to ${JSON.stringify(node.default)} when the key is absent.`);

  return (
    <ConfigField
      label={node.label}
      path={node.path}
      {...(help === undefined ? {} : { help })}
      {...(error === undefined ? {} : { error })}
      onShowRaw={onShowRaw}
    >
      {(control) => {
        if (node.kind === "enum") {
          const choices = node.choices ?? [];
          return readOnly ? (
            <span {...control} className={`orca-config__value ${textClass("mono-body")}`}>
              {asText(value)}
            </span>
          ) : (
            <Menu
              label={node.label}
              items={choices.map((choice) => ({ id: choice, label: choice }))}
              onChoose={(item) => onChange?.(node.path, item.id)}
              triggerClassName={`orca-input ${textClass("mono-body")}`}
              /* The trigger *is* this field's control, so the field's ids go on it: a label
                 pointing at an id nothing carries is a label nobody can follow. */
              triggerProps={control}
            >
              {asText(value) === "" ? "Choose" : asText(value)}
            </Menu>
          );
        }

        if (node.kind === "toggle") {
          const on = value === true;
          return (
            <button
              {...control}
              type="button"
              className={`orca-btn ${textClass("label")}`}
              aria-pressed={on}
              {...(readOnly ? { "aria-disabled": true } : {})}
              onClick={() => onChange?.(node.path, !on)}
            >
              {/* The word, never the colour alone (RULES.md rule 4's reasoning). */}
              {on ? "On" : "Off"}
            </button>
          );
        }

        return (
          <input
            {...control}
            className={`orca-input ${textClass("mono-body")}${error === undefined ? "" : " orca-input--invalid"}`}
            type={node.kind === "number" ? "number" : "text"}
            value={asText(value)}
            readOnly={readOnly}
            placeholder={asText(node.default)}
            onChange={(event) => {
              const text = event.target.value;
              /* An empty box deletes the key rather than writing an empty string: a cleared
                 optional field wants its default back (`ConfigPatchEntry`). */
              if (text === "") onChange?.(node.path, undefined);
              else onChange?.(node.path, node.kind === "number" ? Number(text) : text);
            }}
          />
        );
      }}
    </ConfigField>
  );
}
