/** Config-mounted production editor with deliberate source reconciliation, assignment and generation Apply. */
import { useRef, useState, useSyncExternalStore, type JSX } from "react";
import { TemplateAssignmentResultSchema, type TemplateAssignmentParams } from "@orca/protocol";
import { Button, ConfigField, StateView, Text, textClass } from "../ui/index.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { useUpdateDraft } from "../update-drafts.js";
import { currentEditorTarget, sameEditorTarget } from "../config/configuration-adapter.js";
import { useTemplateStudio, type TemplateStudio } from "./context.js";
import { TemplateAuthoringEditor } from "./editor.js";
export function TemplateStudioSurface(): JSX.Element {
  const { studio, error } = useTemplateStudio();
  if (!studio)
    return (
      <StateView
        kind="empty"
        title="Template authoring unavailable"
        body={error ?? "This daemon or app bridge does not offer authorized template authoring."}
      />
    );
  return <ConnectedTemplates studio={studio} />;
}
function ConnectedTemplates({ studio }: { studio: TemplateStudio }): JSX.Element {
  const state = useSyncExternalStore(studio.controller.subscribe, studio.controller.getSnapshot);
  const [exported, setExported] = useState<{ key: string; text: string }>();
  const [reviewed, setReviewed] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  useUpdateDraft(busy);
  const announce = useAnnounce();
  const current = studio.adapter.current;
  const live = window.orca.connection.read();
  const available = !state.edits.length && !state.busy && !state.blocked && live.state === "live";
  const publicationAvailable = available && live.methods?.includes("templates.publish");
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch {
      setMessage("Operation refused or not acknowledged. Retain drafts, read current state and review again.");
      announce("Template operation refused. Retained drafts require reconciliation.");
      setReviewed(undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="orca-template-editor" aria-label="Template studio">
      <Text style="caption">
        Review and save one template source at a time. Keep other edits until the current source is saved or explicitly
        discarded.
      </Text>
      <TemplateAuthoringEditor
        controller={studio.controller}
        saveLabel="Save reviewed source"
        onExport={(key, text) => setExported({ key, text })}
        embedded
      />
      {exported && studio.controller.exportSource(exported.key) !== undefined && (
        <ConfigField
          label="Exported template source"
          path="template.export"
          help="Copy these exact bytes to export the source. This does not publish externally."
        >
          {(control) => (
            <textarea {...control} className={`orca-yaml ${textClass("mono-log")}`} readOnly value={exported.text} />
          )}
        </ConfigField>
      )}
      {state.blocked && (
        <section aria-label="Reconcile template sources">
          <Text style="body">
            Review current sources and the retained replacement before saving again. Applying retained text replaces the
            entire selected source.
          </Text>
          <Button
            disabled={busy}
            onClick={() => {
              void run(() => studio.refresh());
            }}
          >
            Read current template sources
          </Button>
          {studio.current.assets.map(
            (asset) =>
              asset.source.state === "available" && (
                <details key={asset.key}>
                  <summary>{asset.id}: current saved source</summary>
                  <pre className={`orca-yaml ${textClass("mono-log")}`}>{asset.source.text}</pre>
                  {studio.controller.exportSource(asset.key) !== undefined && (
                    <pre aria-label="Retained template source" className={`orca-yaml ${textClass("mono-log")}`}>
                      {studio.controller.exportSource(asset.key)}
                    </pre>
                  )}
                </details>
              ),
          )}
          <Button
            disabled={busy || state.busy}
            onClick={() => {
              if (studio.controller.reconcile(studio.current, true)) {
                setReviewed(undefined);
                setExported(undefined);
              }
            }}
          >
            Retain replacement text on current sources
          </Button>
          <Button
            disabled={busy || state.busy}
            onClick={() => {
              studio.controller.reconcile(studio.current, false);
              setReviewed(undefined);
              setExported(undefined);
            }}
          >
            Discard edits and load current sources
          </Button>
        </section>
      )}
      <section aria-label="Template publication">
        <Text style="body">
          Save changes source only. Review the saved catalog, then explicitly Apply it to future launches. Admitted runs
          keep captured instructions.
        </Text>
        <Button
          disabled={!publicationAvailable || busy}
          onClick={() => {
            void run(async () => {
              await studio.adapter.reviewPublication();
              setReviewed(current?.catalogRevision);
              setMessage("Saved catalog validated. Apply explicitly to activate future launches.");
              announce("Template catalog validated for Apply.");
            });
          }}
        >
          Review saved catalog for Apply
        </Button>
        <Button
          disabled={!publicationAvailable || busy || !reviewed || reviewed !== current?.catalogRevision}
          onClick={() => {
            void run(async () => {
              const result = await studio.adapter.applyPublication();
              setReviewed(undefined);
              setMessage(`Apply outcome: ${result.outcome}.`);
              announce(`Template Apply outcome: ${result.outcome}.`);
              await studio.refresh();
            });
          }}
        >
          Apply reviewed template catalog
        </Button>
        {message && <Text style="caption">{message}</Text>}
      </section>
      {current && (
        <TemplateAssignment
          studio={studio}
          available={available && Boolean(live.methods?.includes("templates.assign"))}
        />
      )}
      {current && live.methods?.includes("templates.history") && (
        <TemplateRevisionHistory
          key={`${current.catalogRevision}:${current.generation}`}
          studio={studio}
          available={available}
        />
      )}
    </div>
  );
}
function TemplateAssignment({ studio, available }: { studio: TemplateStudio; available: boolean }): JSX.Element {
  const catalog = studio.adapter.current!;
  const [key, setKey] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [version, setVersion] = useState("");
  const [review, setReview] = useState<{ command: TemplateAssignmentParams; revision: string }>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
  useUpdateDraft(busy);
  const assignment = catalog.assignments.find((choice) => choice.key === key);
  const choose = (change: () => void) => {
    setReview(undefined);
    change();
  };
  const command: TemplateAssignmentParams | undefined =
    assignment && templateId && version
      ? {
          target: catalog.target,
          expectedCatalogRevision: catalog.catalogRevision,
          expectedConfigGeneration: catalog.generation,
          key,
          expectedSourceRevision: assignment.revision,
          templateId,
          version,
        }
      : undefined;
  const send = async (save: boolean) => {
    if (!available || busy || !command || !window.orca.templates) return;
    setBusy(true);
    try {
      const response = await window.orca.templates.call("templates.assign", {
        ...command,
        validateOnly: !save,
        ...(save && review ? { candidateRevision: review.revision } : {}),
      });
      if (!response.ok) throw new Error("Assignment refused");
      const result = TemplateAssignmentResultSchema.parse(response.result);
      if (
        !sameEditorTarget(studio.adapter.target, currentEditorTarget(window.orca)) ||
        result.snapshot.target.workspaceId !== command.target.workspaceId ||
        result.snapshot.target.instanceId !== command.target.instanceId ||
        result.snapshot.generation !== command.expectedConfigGeneration ||
        result.written !== save ||
        (save &&
          (result.candidateRevision !== review?.revision ||
            !result.snapshot.assignments.some(
              (choice) =>
                choice.key === key && choice.revision === result.candidateRevision && choice.templateId === templateId,
            ))) ||
        (!save && result.snapshot.catalogRevision !== command.expectedCatalogRevision)
      )
        throw new Error("Assignment acknowledgement changed");
      if (save) {
        setReview(undefined);
        setMessage("Instruction assignment saved. Review and Apply the catalog separately.");
        announce("Template assignment saved; Apply separately.");
        await studio.refresh();
      } else {
        setReview({ command, revision: result.candidateRevision });
        setMessage("Review changes the node instruction template and workflow version. Agent role stays separate.");
      }
    } catch {
      setReview(undefined);
      setMessage("Assignment refused or not acknowledged. Read current source and review again.");
      announce("Template assignment refused. Read current source and review again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Workflow instruction assignment">
      <Text style="heading" as="h3">
        Assign an instruction template
      </Text>
      <ConfigField label="Workflow node" path="assignment.node">
        {(control) => (
          <select {...control} value={key} onChange={(event) => choose(() => setKey(event.target.value))}>
            <option value="">Choose node</option>
            {catalog.assignments.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.workflowId}: {choice.nodeId}
              </option>
            ))}
          </select>
        )}
      </ConfigField>
      <ConfigField label="Instruction template" path="assignment.template">
        {(control) => (
          <select {...control} value={templateId} onChange={(event) => choose(() => setTemplateId(event.target.value))}>
            <option value="">Choose template</option>
            {catalog.assets
              .filter((asset) => asset.id)
              .map((asset) => (
                <option key={asset.key} value={asset.id}>
                  {asset.id}
                </option>
              ))}
          </select>
        )}
      </ConfigField>
      <ConfigField label="New workflow version" path="assignment.version">
        {(control) => (
          <input {...control} value={version} onChange={(event) => choose(() => setVersion(event.target.value))} />
        )}
      </ConfigField>
      <Button
        disabled={!available || busy || !command}
        onClick={() => {
          void send(false);
        }}
      >
        Review template assignment
      </Button>
      <Button
        disabled={!available || busy || !review || JSON.stringify(command) !== JSON.stringify(review.command)}
        onClick={() => {
          void send(true);
        }}
      >
        Save reviewed template assignment
      </Button>
      {message && <Text style="caption">{message}</Text>}
    </section>
  );
}
function TemplateRevisionHistory({ studio, available }: { studio: TemplateStudio; available: boolean }): JSX.Element {
  const [key, setKey] = useState("");
  const [history, setHistory] = useState<Awaited<ReturnType<TemplateStudio["adapter"]["history"]>>>();
  const [failed, setFailed] = useState(false);
  const operation = useRef(0);
  const catalog = studio.adapter.current!;
  return (
    <section aria-label="Template revision history">
      <Text style="heading" as="h3">
        Revision history
      </Text>
      <Text style="caption">
        Acknowledged local source saves and activations contain content digests only. Historical source lookup is
        unavailable.
      </Text>
      <ConfigField label="History template" path="history.template">
        {(control) => (
          <select
            {...control}
            value={key}
            onChange={(event) => {
              operation.current++;
              setKey(event.target.value);
              setHistory(undefined);
              setFailed(false);
            }}
          >
            <option value="">Choose template</option>
            {catalog.assets.map((asset) => (
              <option key={asset.key} value={asset.key}>
                {asset.id}
              </option>
            ))}
          </select>
        )}
      </ConfigField>
      <Button
        disabled={!available || !key}
        onClick={() => {
          setHistory(undefined);
          setFailed(false);
          const ticket = ++operation.current;
          void studio.adapter
            .history(key)
            .then((result) => {
              if (ticket === operation.current) setHistory(result);
            })
            .catch(() => {
              if (ticket === operation.current) setFailed(true);
            });
        }}
      >
        Read revision history
      </Button>
      {available &&
        history?.entries.map((entry, index) => (
          <Text style="mono-id" key={index}>
            {entry.at}: {entry.revision}
            {entry.generation ? `; active generation ${entry.generation}` : "; source saved"}
          </Text>
        ))}
      {history && !history.entries.length && <Text style="caption">No acknowledged local revisions recorded.</Text>}
      {failed && <Text style="caption">Revision history unavailable. Read current state before trying again.</Text>}
    </section>
  );
}
