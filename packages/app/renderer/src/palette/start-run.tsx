/**
 * **Start a run** — the one palette write that is not about the object in focus (#178).
 *
 * It is registered beside the palette rather than inside a surface for the reason the
 * object sources are (`object-sources.tsx`): starting a run is a read of the daemon's
 * workflow registry and an act against the store, wanted from wherever a person happens to
 * be standing. It is `global`, so it sorts after nothing and before every object action.
 *
 * **The workflow is chosen, the vars are not asked for.** The picker lists `workflows.list`
 * — name, id, version and node count, which is everything a row of that method carries —
 * and the choice calls `runs.start { workflowId }` with no vars at all, so the run takes the
 * workflow's own. A vars form is specified nowhere: `orca run --var` takes arbitrary keys,
 * `WorkflowSummaryView` does not carry the workflow's `inputs`, and a form that guessed at
 * the keys would be inventing them (docs/design/RULES.md rule 12). The row says which vars
 * it starts with rather than leaving a person to find out from the run.
 *
 * **The run is opened, not announced and left.** `runs.start` answers as soon as the run
 * exists, so the palette navigates to `orca://run/<id>` through the route table — the same
 * resolver every link, crumb and palette row goes through — and the sentence goes in the
 * app's one live region for anybody who did not see the screen change.
 */
import { newAdmissionIntent } from "@orca/protocol";
import { useRef, useMemo, type JSX } from "react";
import { useAnnounce } from "../a11y/announce-context.js";
import { runUrl } from "../route-table.js";
import { usePaletteWrites, type PaletteWrite } from "./use-write-actions.js";

export interface PaletteStartRunProps {
  /** Open an `orca://` URL — `App`'s `navigate`, which is the route table. */
  onOpen: (url: string) => void;
}

/** Nothing to render: this component *is* one registration. */
export function PaletteStartRun({ onOpen }: PaletteStartRunProps): JSX.Element | null {
  const announce = useAnnounce();
  const intents = useRef(new Map<string, ReturnType<typeof newAdmissionIntent>>());

  const rows = useMemo(
    (): readonly PaletteWrite[] => [
      {
        scope: "global",
        method: "runs.start",
        label: "Start a run",
        detail: "Starts with the workflow's default vars",
        picker: {
          label: "Which workflow?",
          empty: "This daemon has no workflows registered.",
          // Read when the row is chosen. A palette that listed the workflows to draw one
          // row would read them on every ⌘K, for everybody who wanted something else.
          load: async () => {
            const result = await window.orca.workflows.list();
            if (!result.ok) return [];
            return result.result.workflows.map((workflow) => ({
              id: workflow.id,
              label: workflow.name,
              // The id as well as the name: two workflows may be called the same thing and
              // only one of them is the one about to run.
              hint: `${workflow.id} · v${workflow.version} · ${workflow.nodeCount} nodes`,
            }));
          },
          choose: (workflowId) => {
            const intent = intents.current.get(workflowId) ?? newAdmissionIntent();
            intents.current.set(workflowId, intent);
            void window.orca.runs.start({ workflowId, ...intent }).then((result) => {
              if (!result.ok) {
                announce(`The run did not start: ${result.error.message}`);
                return;
              }
              if (intents.current.get(workflowId) === intent) intents.current.delete(workflowId);
              announce(`${result.result.run.name} is running.`);
              onOpen(runUrl(result.result.runId));
            });
          },
        },
        /* Unreachable: a row with a picker opens the picker instead of running, and a
           keyless command has no key to dispatch to. It is here because a command is a
           thing with an action, and the alternative is a special case in the registry. */
        action: () => {},
      },
    ],
    [announce, onOpen],
  );

  usePaletteWrites(rows);
  return null;
}
