/** Independent template catalog/editor composed from the app's existing primitives. */
import { useEffect, useState, useSyncExternalStore, type JSX } from "react";
import { useKeyboard } from "../keyboard-context.js";
import { scopeProps } from "../keyboard-map.js";
import { Button, ConfigField, Text, textClass } from "../ui/index.js";
import { TemplateAuthoringController } from "./controller.js";
import { catalogErrors, resolveTemplate, type FixtureInputs } from "./model.js";
import "./editor.css";

export interface TemplateAuthoringEditorProps {
  controller: TemplateAuthoringController;
  /** File-picker/clipboard integrations belong to the host; no automatic external export. */
  onExport?: (key: string, source: string) => void;
}

function parseFixtures(text: string): FixtureInputs | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const values = record.values;
    const artifacts = record.artifacts;
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      !artifacts ||
      typeof artifacts !== "object" ||
      Array.isArray(artifacts)
    )
      return undefined;
    if (Object.values(artifacts).some((body) => typeof body !== "string")) return undefined;
    return { values: values as Record<string, unknown>, artifacts: artifacts as Record<string, string> };
  } catch {
    return undefined;
  }
}

/** Independent surface; the integrator supplies discovery, target feeds and draft retention. */
export function TemplateAuthoringEditor({ controller, onExport }: TemplateAuthoringEditorProps): JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [selected, setSelected] = useState(state.base.assets[0]?.key ?? "");
  const [pack, setPack] = useState("");
  const [fixtureText, setFixtureText] = useState('{"values":{},"artifacts":{}}');
  const [importText, setImportText] = useState("");
  const asset = state.base.assets.find((entry) => entry.key === selected);
  const previewId = asset?.id ?? state.variants?.find((entry) => entry.key === selected)?.id;
  const source = controller.exportSource(selected);
  const fixtures = parseFixtures(fixtureText);
  const resolved = asset ? resolveTemplate(state.base.assets, asset.id, pack || undefined) : undefined;
  const errors = [...catalogErrors(state.base.assets), ...(state.review?.errors ?? []), ...(state.errors ?? [])];
  const writeReason = state.blocked ?? state.base.writeReason;
  const publicationReason = controller.publicationReason();
  const created = state.edits.filter((edit) => !state.base.assets.some((entry) => entry.key === edit.key));
  const keyboard = useKeyboard();
  useEffect(() => {
    const unregister = [
      keyboard.register({
        scope: "config",
        label: "Validate template draft",
        action: () => {
          void controller.validate();
        },
        ...(writeReason === undefined ? {} : { unavailable: writeReason }),
      }),
      keyboard.register({
        scope: "config",
        label: "Cancel template edits",
        action: () => controller.discard(),
        ...(state.busy ? { unavailable: "An authoring operation is pending." } : {}),
      }),
    ];
    if (controller.ports.publish)
      unregister.push(
        keyboard.register({
          scope: "config",
          label: "Publish reviewed template revision",
          action: () => {
            void controller.publish();
          },
          ...(publicationReason === undefined ? {} : { unavailable: publicationReason }),
        }),
      );
    return () => {
      for (const remove of unregister) remove();
    };
  }, [controller, keyboard, publicationReason, state.busy, writeReason]);

  return (
    <section className="orca-template-authoring" aria-label="Template authoring" {...scopeProps("config")}>
      <Text style="heading" as="h2">
        Templates and packs
      </Text>
      <Text style="caption">
        An instruction template is separate from an agent role. Version metadata alone does not provide immutable
        lookup.
      </Text>
      <ConfigField label="Template" path="template.id">
        {(control) => (
          <select {...control} value={selected} onChange={(event) => setSelected(event.target.value)}>
            {state.base.assets.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.id}
              </option>
            ))}
            {created.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.key} (draft variant)
              </option>
            ))}
          </select>
        )}
      </ConfigField>
      {asset && (
        <Text style="caption">
          Version: {asset.version}. Required context: {asset.requires.join(", ") || "None declared"}. Used by:{" "}
          {asset.usedBy.join(", ") || "No known uses"}.
        </Text>
      )}
      <ConfigField
        label="Pack"
        path="templatePack"
        help="Tries pack/template ID, then the base ID. Partials always use exact IDs."
      >
        {(control) => <input {...control} value={pack} onChange={(event) => setPack(event.target.value)} />}
      </ConfigField>
      {resolved && (
        <Text style="caption">
          Selection resolves to {resolved.id}
          {pack && resolved.id === asset?.id ? " (base fallback)" : ""} in the saved catalog. Preview checks the draft.
        </Text>
      )}
      <Button
        onClick={() => {
          void controller.createVariant(selected, pack);
        }}
        disabled={
          !controller.ports.variant ||
          !asset ||
          !/^[A-Za-z0-9_-]+$/.test(pack) ||
          state.edits.length > 0 ||
          state.busy ||
          writeReason !== undefined
        }
        disabledReason={
          writeReason ?? "Variant derivation requires an authorized adapter, a pack name, and a saved source."
        }
      >
        Create pack variant
      </Button>
      <ConfigField
        label="Template source"
        path="template.markdown"
        help="Markdown body and declared metadata. Untouched comments, order and unknown metadata stay in the original source."
      >
        {(control) => (
          <textarea
            {...control}
            className={`orca-yaml ${textClass("mono-log")}`}
            value={source ?? ""}
            readOnly={source === undefined || writeReason !== undefined}
            spellCheck={false}
            onChange={(event) => controller.edit(selected, event.target.value)}
          />
        )}
      </ConfigField>
      {source === undefined && (
        <Text style="caption">Source is unavailable or protected. Editing and export are unavailable.</Text>
      )}
      <ConfigField
        label="Import source"
        path="template.import"
        help="Paste a file's complete source to replace the selected draft, then validate and review."
      >
        {(control) => (
          <textarea {...control} value={importText} onChange={(event) => setImportText(event.target.value)} />
        )}
      </ConfigField>
      <Button
        disabled={source === undefined || state.busy || writeReason !== undefined}
        onClick={() => controller.importSource(selected, importText)}
      >
        Import into draft
      </Button>
      {onExport && (
        <Button
          disabled={source === undefined}
          onClick={() => {
            if (source !== undefined) onExport(selected, source);
          }}
        >
          Export source
        </Button>
      )}
      <ConfigField
        label="Preview fixtures"
        path="fixtures"
        help="Explicit sample values and artifact bodies only. No agent calls or credential resolution."
        {...(fixtures === undefined
          ? { error: "Use JSON with values as an object and artifacts as an object of text bodies." }
          : {})}
      >
        {(control) => (
          <textarea {...control} value={fixtureText} onChange={(event) => setFixtureText(event.target.value)} />
        )}
      </ConfigField>
      <Button
        disabled={!previewId || !fixtures || state.busy || writeReason !== undefined}
        onClick={() => {
          if (previewId && fixtures)
            void controller.preview(previewId, asset ? pack || undefined : undefined, fixtures);
        }}
      >
        Preview prompt
      </Button>
      {state.preview && (
        <div>
          <Text style="caption">
            Rendered {state.preview.resolvedId}
            {state.preview.fallback ? " (base fallback)" : ""}. Exact-ID partials:{" "}
            {state.preview.partialIds.join(", ") || "None"}.
          </Text>
          <pre className={`orca-yaml ${textClass("mono-log")}`} aria-label="Rendered prompt">
            {state.preview.text}
          </pre>
        </div>
      )}
      {errors.length > 0 && (
        <div aria-label="Template validation errors">
          {errors.map((error, index) => (
            <Text key={index} style="caption">
              {error.key ? `${error.key}: ` : ""}
              {error.message}
            </Text>
          ))}
        </div>
      )}
      {state.review && (
        <div aria-label="Template change review">
          <Text style="caption">Compatibility: {state.review.compatibility}</Text>
          {state.review.changes.map((change, index) => (
            <Text key={index} style="caption">
              {change}
            </Text>
          ))}
        </div>
      )}
      <div className={`orca-draftbar ${textClass("caption")}`} role="group" aria-label="Unsaved template changes">
        <Text style="caption">{state.edits.length} changed sources</Text>
        <Button
          disabled={state.busy || writeReason !== undefined}
          {...(writeReason === undefined ? {} : { disabledReason: writeReason })}
          onClick={() => {
            void controller.validate();
          }}
        >
          Validate and review
        </Button>
        <Button
          tone="primary"
          disabled={publicationReason !== undefined}
          {...(publicationReason === undefined ? {} : { disabledReason: publicationReason })}
          onClick={() => {
            void controller.publish();
          }}
        >
          Publish revision
        </Button>
        <Button disabled={state.busy} onClick={() => controller.discard()}>
          Cancel edits
        </Button>
        <Button
          disabled={state.busy}
          onClick={() => {
            void controller.refresh();
          }}
        >
          Refresh saved state
        </Button>
      </div>
      {(state.blocked ?? state.message ?? publicationReason) && (
        <Text style="caption">{state.blocked ?? state.message ?? publicationReason}</Text>
      )}
    </section>
  );
}
