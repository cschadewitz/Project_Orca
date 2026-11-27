/** Recursive #333 controls over injected rich metadata, with explicit absence and ordered edit batches. */
import { useLayoutEffect, useRef, useState, type JSX } from "react";
import { Button, Card, ConfigField, Menu, Text, textClass } from "../../ui/index.js";
import type { DocumentPath, EditAccess, EditIntent, FieldError, FieldShape } from "./contracts.js";
import {
  initialValue,
  isObject,
  pathLabel,
  recordKeyError,
  samePath,
  sameValue,
  switchVariant,
} from "./collection-model.js";

export interface StructuredFormProps {
  shape: FieldShape;
  /** A read/projection for drawing only. Never a whole-document persistence payload. */
  value: unknown;
  path: DocumentPath;
  label: string;
  errors: readonly FieldError[];
  /** Denies unsupported lowering, frozen targets, revoked authority and policy edits. */
  access: (edits: readonly EditIntent[]) => EditAccess;
  onEdit: (edits: readonly EditIntent[]) => void;
  /** Integration owns stable row identity across ordered insert/remove/move operations. */
  rowKey: (path: DocumentPath, index: number) => string;
  onShowRaw?: (path: DocumentPath) => void;
  referenceChoices?: (path: DocumentPath) => readonly string[] | undefined;
}

function Action({
  edits,
  children,
  form,
  ...rest
}: { edits: readonly EditIntent[]; children: string; form: StructuredFormProps } & Pick<
  React.ComponentProps<typeof Button>,
  "aria-label" | "tone"
>): JSX.Element {
  const access = form.access(edits);
  return (
    <Button
      {...rest}
      disabled={!access.allowed}
      {...(!access.allowed ? { disabledReason: access.reason } : {})}
      onClick={() => {
        if (form.access(edits).allowed) form.onEdit(edits);
      }}
    >
      {children}
    </Button>
  );
}

function creationOptions(shape: FieldShape): readonly { id: string; value: unknown }[] {
  if (shape.acceptsAbsent === "metadata-unavailable" || shape.acceptsNull === "metadata-unavailable") return [];
  const initial = initialValue(shape);
  if (initial.available) return [{ id: "entry", value: initial.value }];
  if (shape.kind === "scalar" && shape.visibility === "non-secret" && shape.field.type === "enum")
    return (shape.field.enum ?? []).map((id) => ({ id, value: id }));
  if (
    shape.kind === "union" &&
    shape.visibility === "non-secret" &&
    recordKeyError(shape.discriminator, {}) === undefined
  )
    return Object.entries(shape.branches)
      .filter(([, branch]) => branch.kind === "object" && initialValue(branch).available)
      .map(([id]) => ({ id, value: { [shape.discriminator]: id } }));
  return [];
}

function Create({
  shape,
  label,
  editsFor,
  form,
}: {
  shape: FieldShape;
  label: string;
  editsFor: (value: unknown) => readonly EditIntent[];
  form: StructuredFormProps;
}): JSX.Element {
  const options = creationOptions(shape);
  if (options.length === 0) return <Text style="caption">Creation requires supported metadata.</Text>;
  if (options.length === 1 && options[0]?.id === "entry")
    return (
      <Action edits={editsFor(options[0].value)} form={form}>
        {label}
      </Action>
    );
  return (
    <Menu
      label={label}
      items={options.map((option) => ({
        id: option.id,
        label: option.id,
        disabled: !form.access(editsFor(option.value)).allowed,
      }))}
      onChoose={(item) => {
        const selected = options.find((option) => option.id === item.id);
        if (selected) {
          const edits = editsFor(selected.value);
          if (form.access(edits).allowed) form.onEdit(edits);
        }
      }}
    >
      {label}
    </Menu>
  );
}

/**
 * What leaving an agent's policy field out means, for the fields whose default the metadata
 * cannot show: the native hook read as "Absent" and "Default withheld", and never said that
 * absence is off or how to opt in (#1109). Keyed on the field under `agents[n]`.
 */
const AGENT_FIELD_NOTES: Record<string, string> = {
  nativeToolHook:
    "Off when absent: no native pre-tool hook. experimental opts this agent in (docs/agent-hook-coverage.md).",
  codexExecGate: "Off when absent. experimental is refused for now.",
  "diagnostics.toolCalls": "off when absent: nothing is recorded. keep needs nativeToolHook: experimental.",
};

function fieldNote(path: DocumentPath): string | undefined {
  if (path[0] !== "agents" || typeof path[1] !== "number") return undefined;
  return AGENT_FIELD_NOTES[path.slice(2).join(".")];
}

function defaultHelp(shape: FieldShape): string {
  if (shape.default.state === "withheld") return "Default not shown.";
  if (shape.default.state === "metadata-unavailable") return "Default metadata unavailable.";
  if (shape.default.state === "available")
    return `Default when absent: ${JSON.stringify(shape.default.value)}. Explicit values are saved only when edited.`;
  return "No default.";
}

/** Ancestors and descendants obey the same gate; unavailable metadata cannot authorize a read. */
function unavailable(shape: FieldShape): boolean {
  return (
    shape.visibility !== "non-secret" ||
    shape.kind === "unsupported" ||
    typeof shape.acceptsAbsent !== "boolean" ||
    typeof shape.acceptsNull !== "boolean"
  );
}

function UnavailableField({ form }: { form: StructuredFormProps }): JSX.Element {
  const { shape, path, label } = form;
  if (shape.visibility !== "non-secret")
    return (
      <div>
        <Text style="label-strong">{label}</Text>
        <Text style="caption">Value withheld. Authorized raw editing is separate.</Text>
      </div>
    );
  return (
    <div>
      <Text style="label-strong">{label}</Text>
      <Text style="caption">Structured editing unavailable for this metadata.</Text>
      {form.onShowRaw && <Button onClick={() => form.onShowRaw?.(path)}>Open authorized raw view</Button>}
    </div>
  );
}

export function StructuredForm(form: StructuredFormProps): JSX.Element {
  const { shape, path, label, value } = form;
  const displayPath = pathLabel(path);
  if (unavailable(shape)) return <UnavailableField form={form} />;
  const error = form.errors.find((error) => samePath(error.path, path))?.message;
  const child = (
    childShape: FieldShape,
    childValue: unknown,
    childPath: DocumentPath,
    childLabel: string,
    key: string,
  ): JSX.Element => (
    <StructuredForm {...form} key={key} shape={childShape} value={childValue} path={childPath} label={childLabel} />
  );
  return (
    <div className="orca-config__section" role="group" aria-label={label}>
      <Text style="label-strong">{label}</Text>
      <Text style="mono-id">{displayPath}</Text>
      <Text style="caption">
        {value === undefined ? "Absent. " : value === null ? "Explicit null. " : "Explicit value. "}
        {defaultHelp(shape)}
      </Text>
      {fieldNote(path) !== undefined && <Text style="caption">{fieldNote(path)}</Text>}
      {error !== undefined && shape.kind !== "scalar" && <Text style="caption">{error}</Text>}
      {value !== undefined && shape.acceptsAbsent === true && (
        <Action edits={[{ kind: "remove", path }]} form={form} aria-label={`Remove ${displayPath}`}>
          Use absence
        </Action>
      )}
      {value !== null && shape.acceptsNull === true && (
        <Action edits={[{ kind: "set", path, value: null }]} form={form} aria-label={`Set ${displayPath} to null`}>
          Set null
        </Action>
      )}
      {shape.kind === "scalar" ? (
        <Scalar form={form} shape={shape} />
      ) : shape.kind === "union" ? (
        <Union form={form} shape={shape} />
      ) : value === undefined || value === null ? (
        <Create
          shape={shape}
          form={form}
          label={`Create ${label}`}
          editsFor={(value) => [{ kind: "set", path, value }]}
        />
      ) : shape.kind === "object" && isObject(value) ? (
        <>
          {Object.entries(shape.fields).map(([key, field]) =>
            child(field, Object.hasOwn(value, key) ? value[key] : undefined, [...path, key], key, key),
          )}
        </>
      ) : shape.kind === "array" && Array.isArray(value) ? (
        <ArrayEntries form={form} shape={shape} entries={value} />
      ) : shape.kind === "record" && shape.valueKind === "env" && isObject(value) ? (
        <EnvEntries form={form} shape={shape} />
      ) : shape.kind === "record" && isObject(value) ? (
        <RecordEntries form={form} shape={shape} />
      ) : (
        <Text style="caption">The value does not match supported metadata. Use authorized raw editing.</Text>
      )}
    </div>
  );
}

/** After structural edits focus follows the destination row, or the add action when emptied. */
function ArrayEntries({
  form,
  shape,
  entries,
}: {
  form: StructuredFormProps;
  shape: Extract<FieldShape, { kind: "array" }>;
  entries: readonly unknown[];
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | undefined>(undefined);
  const actionForm: StructuredFormProps = {
    ...form,
    onEdit: (edits) => {
      const edit = edits[0];
      if (edit?.kind === "insert") pendingFocus.current = edit.index;
      if (edit?.kind === "move") pendingFocus.current = edit.to;
      if (edit?.kind === "remove" && typeof edit.path.at(-1) === "number")
        pendingFocus.current = Math.min(edit.path.at(-1) as number, entries.length - 2);
      form.onEdit(edits);
    },
  };
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === undefined) return;
    pendingFocus.current = undefined;
    const row =
      index < 0
        ? root.current?.querySelector(":scope > [data-add-entry]")
        : root.current?.querySelectorAll(":scope > [data-entry-row]")[index];
    ((row?.querySelector("input, select") ?? row?.querySelector("button")) as HTMLElement | null)?.focus();
  }, [entries]);
  const displayPath = pathLabel(form.path);
  return (
    <div ref={root}>
      {entries.length === 0 && <Text style="caption">No entries.</Text>}
      {entries.map((entry, index) => (
        <div key={form.rowKey(form.path, index)} data-entry-row>
          <Card eyebrow={`Entry ${index + 1}`}>
            <StructuredForm
              {...form}
              shape={shape.item}
              value={entry}
              path={[...form.path, index]}
              label={`${form.label} entry`}
            />
            <Action
              edits={[{ kind: "remove", path: [...form.path, index] }]}
              form={actionForm}
              aria-label={`Delete ${displayPath}[${index}]`}
            >
              Delete entry
            </Action>
            {index > 0 && (
              <Action
                edits={[{ kind: "move", path: form.path, from: index, to: index - 1 }]}
                form={actionForm}
                aria-label={`Move ${displayPath}[${index}] up`}
              >
                Move up
              </Action>
            )}
            {index < entries.length - 1 && (
              <Action
                edits={[{ kind: "move", path: form.path, from: index, to: index + 1 }]}
                form={actionForm}
                aria-label={`Move ${displayPath}[${index}] down`}
              >
                Move down
              </Action>
            )}
          </Card>
        </div>
      ))}
      <div data-add-entry>
        <Create
          shape={shape.item}
          form={actionForm}
          label={`Add ${form.label} entry`}
          editsFor={(value) => [{ kind: "insert", path: form.path, index: entries.length, value }]}
        />
      </div>
    </div>
  );
}

function Scalar({
  form,
  shape,
}: {
  form: StructuredFormProps;
  shape: Extract<FieldShape, { kind: "scalar" }>;
}): JSX.Element {
  const { value, path, label } = form;
  const error = form.errors.find((error) => samePath(error.path, path))?.message;
  const allowed = (value: unknown): boolean => form.access([{ kind: "set", path, value }]).allowed;
  const change = (value: unknown): void => {
    const edits: EditIntent[] = [{ kind: "set", path, value }];
    if (form.access(edits).allowed) form.onEdit(edits);
  };
  const readable =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  const editAccess = form.access([
    {
      kind: "set",
      path,
      value: shape.field.type === "boolean" ? value !== true : shape.field.type === "number" ? 0 : readable,
    },
  ]);
  const references = form.referenceChoices?.(path);
  return (
    <ConfigField
      label={label}
      path={pathLabel(path)}
      {...(error === undefined ? {} : { error })}
      {...(!editAccess.allowed ? { help: editAccess.reason } : {})}
      {...(form.onShowRaw === undefined ? {} : { onShowRaw: () => form.onShowRaw?.(path) })}
    >
      {(control) =>
        references !== undefined ? (
          <select
            {...control}
            className={`orca-input ${textClass("mono-body")}`}
            value={readable}
            disabled={!editAccess.allowed}
            onChange={(event) => change(event.target.value)}
          >
            <option value="">Choose reference</option>
            {readable && !references.includes(readable) && (
              <option value={readable}>{readable} (unavailable reference)</option>
            )}
            {references.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        ) : shape.field.type === "enum" ? (
          <Menu
            label={label}
            triggerProps={control}
            items={(shape.field.enum ?? []).map((choice) => ({
              id: choice,
              label: choice,
              disabled: !allowed(choice),
            }))}
            onChoose={(item) => change(item.id)}
          >
            {readable === "" ? "Choose" : readable}
          </Menu>
        ) : shape.field.type === "boolean" ? (
          <Button
            {...control}
            aria-pressed={value === true}
            disabled={!allowed(value !== true)}
            {...(!editAccess.allowed ? { disabledReason: editAccess.reason } : {})}
            onClick={() => change(value !== true)}
          >
            {value === true ? "On" : "Off"}
          </Button>
        ) : shape.field.type === "string" || shape.field.type === "number" ? (
          <input
            {...control}
            className={`orca-input ${textClass("mono-body")}`}
            type={shape.field.type === "number" ? "number" : "text"}
            value={readable}
            readOnly={!allowed(shape.field.type === "number" ? 0 : "")}
            onChange={(event) => {
              const text = event.target.value;
              if (shape.field.type === "string") change(text);
              else if (text !== "" && Number.isFinite(Number(text))) change(Number(text));
            }}
          />
        ) : (
          <Text style="caption">Unsupported scalar metadata.</Text>
        )
      }
    </ConfigField>
  );
}

function RecordEntries({
  form,
  shape,
}: {
  form: StructuredFormProps;
  shape: Extract<FieldShape, { kind: "record" }>;
}): JSX.Element {
  const [key, setKey] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<string | null | undefined>(undefined);
  const { value, path, label } = form;
  const issue = recordKeyError(key, value, shape.keyFormat);
  const editableKeys = Object.keys(isObject(value) ? value : {}).filter(
    (entryKey) => recordKeyError(entryKey, {}, shape.keyFormat) === undefined,
  );
  const deletionForm: StructuredFormProps = {
    ...form,
    onEdit: (edits) => {
      const deleted = edits[0]?.path.at(-1);
      const index = typeof deleted === "string" ? editableKeys.indexOf(deleted) : -1;
      pendingFocus.current = editableKeys[index + 1] ?? editableKeys[index - 1] ?? null;
      form.onEdit(edits);
    },
  };
  useLayoutEffect(() => {
    const destination = pendingFocus.current;
    if (destination === undefined) return;
    pendingFocus.current = undefined;
    const row = [...(root.current?.querySelectorAll<HTMLElement>(":scope > [data-record-entry]") ?? [])].find(
      (row) => row.dataset.recordEntry === destination,
    );
    const control =
      row?.querySelector<HTMLInputElement | HTMLSelectElement>("input, select") ??
      row?.querySelector<HTMLButtonElement>("button") ??
      keyInput.current;
    control?.focus();
  }, [value]);
  return (
    <div ref={root}>
      {Object.entries(isObject(value) ? value : {}).map(([entryKey, entry]) => (
        <div key={entryKey} data-record-entry={entryKey}>
          <Card eyebrow={entryKey}>
            {recordKeyError(entryKey, {}, shape.keyFormat) === undefined ? (
              <StructuredForm {...form} shape={shape.value} value={entry} path={[...path, entryKey]} label={entryKey} />
            ) : (
              <Text style="caption">This key requires authorized raw editing.</Text>
            )}
            {recordKeyError(entryKey, {}, shape.keyFormat) === undefined && (
              <Action
                edits={[{ kind: "remove", path: [...path, entryKey] }]}
                form={deletionForm}
                aria-label={`Delete ${pathLabel([...path, entryKey])}`}
              >
                Delete entry
              </Action>
            )}
          </Card>
        </div>
      ))}
      <ConfigField
        label={`New ${label} key`}
        path={pathLabel(path)}
        {...(key === "" || issue === undefined ? {} : { error: issue })}
      >
        {(control) => (
          <input
            {...control}
            ref={keyInput}
            className={`orca-input ${textClass("mono-body")}`}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        )}
      </ConfigField>
      {issue === undefined ? (
        <Create
          shape={shape.value}
          form={form}
          label={`Add ${label} key`}
          editsFor={(value) => [{ kind: "set", path: [...path, key], value }]}
        />
      ) : (
        <Button disabled disabledReason={issue}>
          Add key
        </Button>
      )}
    </div>
  );
}

const isSecretRef = (value: unknown): value is { secret: string } =>
  isObject(value) && Object.keys(value).length === 1 && typeof value.secret === "string";

/**
 * An environment map (#335/#336): each variable is a secret reference picked from the draft's
 * `secrets:` ids, or a literal whose text is never drawn. A literal can be replaced by a
 * reference or deleted; new variables are added as references only.
 */
function EnvEntries({
  form,
  shape,
}: {
  form: StructuredFormProps;
  shape: Extract<FieldShape, { kind: "record" }>;
}): JSX.Element {
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const { value, path, label } = form;
  const entries = Object.entries(isObject(value) ? value : {});
  const choicesFor = (variable: string): readonly string[] =>
    form.referenceChoices?.([...path, variable, "secret"]) ?? [];
  const issue = recordKeyError(name, value, shape.keyFormat);
  const newChoices = choicesFor(name === "" ? "variable" : name);
  const addEdits: readonly EditIntent[] = [{ kind: "set", path: [...path, name], value: { secret } }];
  const pick = (variable: string, id: string): void => {
    const edits: EditIntent[] = [{ kind: "set", path: [...path, variable], value: { secret: id } }];
    if (id !== "" && form.access(edits).allowed) form.onEdit(edits);
  };
  return (
    <div>
      {entries.length === 0 && <Text style="caption">No variables.</Text>}
      {entries.map(([variable, entry]) => {
        const keyIssue = recordKeyError(variable, {}, shape.keyFormat);
        const choices = choicesFor(variable);
        const current = isSecretRef(entry) ? entry.secret : "";
        const access = form.access([{ kind: "set", path: [...path, variable], value: { secret: current } }]);
        return (
          <div key={variable} data-record-entry={variable}>
            <Card eyebrow={variable}>
              {keyIssue !== undefined ? (
                <Text style="caption">This variable requires authorized raw editing.</Text>
              ) : (
                <>
                  <Text style="caption">
                    {isSecretRef(entry)
                      ? "Secret reference: the value is read on the secret's host when the server starts."
                      : typeof entry === "string"
                        ? "Literal value withheld. Replace it with a secret reference to keep it out of config."
                        : "This value requires authorized raw editing."}
                  </Text>
                  {(isSecretRef(entry) || typeof entry === "string") && (
                    <ConfigField
                      label={`${variable} secret`}
                      path={pathLabel([...path, variable])}
                      {...(!access.allowed ? { help: access.reason } : {})}
                    >
                      {(control) => (
                        <select
                          {...control}
                          className={`orca-input ${textClass("mono-body")}`}
                          value={current}
                          disabled={!access.allowed}
                          onChange={(event) => pick(variable, event.target.value)}
                        >
                          <option value="">Choose secret</option>
                          {current !== "" && !choices.includes(current) && (
                            <option value={current}>{current} (unavailable reference)</option>
                          )}
                          {choices.map((choice) => (
                            <option key={choice} value={choice}>
                              {choice}
                            </option>
                          ))}
                        </select>
                      )}
                    </ConfigField>
                  )}
                  <Action
                    edits={[{ kind: "remove", path: [...path, variable] }]}
                    form={form}
                    aria-label={`Delete ${pathLabel([...path, variable])}`}
                  >
                    Delete variable
                  </Action>
                </>
              )}
            </Card>
          </div>
        );
      })}
      <ConfigField
        label={`New ${label} variable`}
        path={pathLabel(path)}
        {...(name === "" || issue === undefined ? {} : { error: issue })}
      >
        {(control) => (
          <input
            {...control}
            className={`orca-input ${textClass("mono-body")}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </ConfigField>
      {newChoices.length === 0 ? (
        <Text style="caption">Define a secret under secrets first, then reference it here.</Text>
      ) : (
        <ConfigField label={`New ${label} variable secret`} path={pathLabel(path)}>
          {(control) => (
            <select
              {...control}
              className={`orca-input ${textClass("mono-body")}`}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            >
              <option value="">Choose secret</option>
              {newChoices.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          )}
        </ConfigField>
      )}
      {issue === undefined && secret !== "" && newChoices.includes(secret) ? (
        <Action
          edits={addEdits}
          form={{
            ...form,
            onEdit: (edits) => {
              setName("");
              setSecret("");
              form.onEdit(edits);
            },
          }}
        >
          {`Add ${label} variable`}
        </Action>
      ) : (
        <Button disabled disabledReason={issue ?? "Choose a secret."}>
          {`Add ${label} variable`}
        </Button>
      )}
    </div>
  );
}

function Union({
  form,
  shape,
}: {
  form: StructuredFormProps;
  shape: Extract<FieldShape, { kind: "union" }>;
}): JSX.Element {
  const [pending, setPending] = useState<{
    value: unknown;
    shape: FieldShape;
    path: DocumentPath;
    edits: readonly EditIntent[];
  }>();
  const current = isObject(form.value) ? form.value[shape.discriminator] : undefined;
  const branch =
    typeof current === "string" && Object.hasOwn(shape.branches, current) ? shape.branches[current] : undefined;
  const edits =
    pending !== undefined &&
    samePath(pending.path, form.path) &&
    sameValue(pending.value, form.value) &&
    sameValue(pending.shape, shape)
      ? pending.edits
      : undefined;
  useLayoutEffect(() => {
    // Once invalidated, a review must not reappear if the draft/path/schema later returns to its old value.
    if (pending && !edits) setPending(undefined);
  }, [pending, edits]);
  return (
    <>
      <Menu
        label={`${form.label} variant`}
        items={Object.keys(shape.branches).map((id) => {
          const edits = switchVariant(shape, form.value, form.path, id);
          return { id, label: id, disabled: edits === undefined || !form.access(edits).allowed };
        })}
        onChoose={(item) => {
          const edits = switchVariant(shape, form.value, form.path, item.id);
          if (item.id !== current && edits && form.access(edits).allowed)
            setPending({ value: form.value, shape, path: [...form.path], edits });
        }}
      >
        {typeof current === "string" ? current : "Choose variant"}
      </Menu>
      {edits && (
        <Card eyebrow="Review variant change">
          <Text style="caption">
            Known fields unique to the old variant will be removed. Common fields and extension fields remain.
          </Text>
          {edits
            .filter((edit) => edit.kind === "remove")
            .map((edit) => (
              <Text key={pathLabel(edit.path)} style="mono-id">
                {pathLabel(edit.path)}
              </Text>
            ))}
          <Action
            form={{
              ...form,
              onEdit: (edits) => {
                setPending(undefined);
                form.onEdit(edits);
              },
            }}
            edits={edits}
          >
            Confirm variant change
          </Action>
          <Button onClick={() => setPending(undefined)}>Cancel variant change</Button>
        </Card>
      )}
      {branch?.kind === "object" && isObject(form.value) ? (
        unavailable(branch) ? (
          <UnavailableField form={{ ...form, shape: branch }} />
        ) : (
          Object.entries(branch.fields)
            .filter(([key]) => key !== shape.discriminator)
            .map(([key, field]) => (
              <StructuredForm
                {...form}
                key={key}
                shape={field}
                value={
                  Object.hasOwn(form.value as Record<string, unknown>, key)
                    ? (form.value as Record<string, unknown>)[key]
                    : undefined
                }
                path={[...form.path, key]}
                label={key}
              />
            ))
        )
      ) : (
        <Text style="caption">Select a supported variant before editing its fields.</Text>
      )}
    </>
  );
}
