/**
 * The Plan surface's writes, in the palette and nowhere else (#178).
 *
 * Five commands, all about the selected work item, all keyless: waive a dependency that is
 * holding it, decide a decision that gates it, reopen one that was decided, move a risk
 * along its lifecycle, and release the claim a run is holding it under. The inspector next
 * to them draws none of these — "it does not write" is the first thing its header says, and
 * the reason is the information architecture's: the palette is the only place a phase-2
 * write has to be discoverable, which is what keeps the panel a reading surface.
 *
 * Four decisions worth knowing before changing anything here:
 *
 * - **The rows come from the inspector's own data.** `useItemDetail`'s dependencies and
 *   risks are what the panel is already showing, so a row exists exactly when the thing it
 *   is about is on screen. Nothing is read twice to draw a command.
 * - **A decision's options are read when the picker opens.** `DependencyView` names the
 *   decision it points at and carries no options, and `decisions.list` is a plan-wide read;
 *   making it to *draw* a row would read the whole decision log every time an item was
 *   selected. So the row is "Decide <key>" and the options arrive when somebody asks for
 *   them.
 * - **Waiving and releasing are armed before they run.** Waiving is irreversible from the
 *   app — "the way back is to add the dependency again, which the journal then shows as two
 *   acts and not one" (`plan-control.ts`) — and releasing takes an item away from a run.
 *   Deciding and reopening are not: `decisions.reopen` is itself the way back from a
 *   decision, and a decision re-decided is journalled rather than lost (#104).
 * - **Nothing polls after a write.** Every one of these journals, the daemon pushes
 *   `plan.changed` with the areas that moved, and `usePlan` re-reads those. The only read
 *   this file makes for itself is the claim's, because a release journals nothing at all
 *   (see `use-agents.ts`) — and `PlanItemView.claim` carries a `runId` and no `releasable`,
 *   so whether the daemon would refuse the release has to come from `claims.list`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClaimView, DependencyView, PlanItemView, RisksUpdateParams, RiskView } from "@orca/protocol";
import { useAnnounce } from "../a11y/announce-context.js";
import type { PaletteChoice } from "../keyboard-map.js";
import { usePaletteWrites, type PaletteWrite } from "../palette/use-write-actions.js";

/**
 * A risk's lifecycle, in the order `plan-control.ts` writes it: `open -> mitigating ->
 * mitigated | accepted | realized -> closed`. The words are `RiskStatusSchema`'s, which
 * lives in `@orca/core` — a package the renderer may not import (AGENTS.md: packages/app
 * imports only `@orca/protocol` and `@orca/design`) — so they are written out here and the
 * type keeps them honest: a status added to the enum fails this file to compile.
 */
const RISK_STATUSES: readonly RisksUpdateParams["status"][] = [
  "open",
  "mitigating",
  "mitigated",
  "accepted",
  "realized",
  "closed",
];

/** What a dependency points at, in the words the three target kinds are written in. */
function targetName(dependency: DependencyView): string {
  const target = dependency.target;
  switch (target.kind) {
    case "work-item":
      return target.slug ?? target.workItemId;
    case "decision":
      return target.key ?? target.decisionId;
    case "external":
      return target.key;
  }
}

/**
 * Whether this dependency is still holding the item back. `evaluation` is what the
 * scheduler decided against the plan as it stands now, which is the one of the two states
 * that says whether there is anything to waive — a dependency recorded `open` that the
 * scheduler now sees satisfied needs no act from anybody.
 */
const isUnmet = (dependency: DependencyView): boolean => dependency.evaluation.state !== "satisfied";

export interface PlanWriteTargets {
  planId: string | undefined;
  item: PlanItemView | undefined;
  dependencies: readonly DependencyView[];
  risks: readonly RiskView[];
}

export function usePlanWrites({ planId, item, dependencies, risks }: PlanWriteTargets): void {
  const announce = useAnnounce();
  const claim = useItemClaim(item);

  /* One place for "what the daemon said", so five commands phrase a refusal the same way.
     Through a ref so that the rows below do not depend on the callback's identity. */
  const say = useRef(announce);
  say.current = announce;
  const settle = useCallback((ok: boolean, sentence: string): void => {
    say.current(ok ? sentence : `That did not go through: ${sentence}`);
  }, []);

  /* The rows are about the item, its unmet dependencies, its open risks and its claim, so
     that is what they are memoised on: the views are rebuilt by every push. */
  const signature = [
    planId ?? "",
    item?.id ?? "",
    item?.slug ?? "",
    ...dependencies.map((d) => `${d.id}:${d.target.kind}:${d.evaluation.state}`),
    ...risks.map((r) => `${r.id}:${r.status}`),
    claim?.owner.releasable === true ? `claim:${claim.workItemId}` : "",
  ].join("|");

  const held = useRef({ planId, item, dependencies, risks, claim });
  held.current = { planId, item, dependencies, risks, claim };

  const rows = useMemo((): readonly PaletteWrite[] => {
    const { planId: plan, item: subject, dependencies: deps, risks: open, claim: claimed } = held.current;
    if (plan === undefined || subject === undefined || signature === "") return [];
    const rows: PaletteWrite[] = [];

    for (const dependency of deps) {
      const name = targetName(dependency);
      const unmet = isUnmet(dependency);
      if (dependency.target.kind === "decision") {
        const key = dependency.target.key ?? dependency.target.decisionId;
        /* Undecided, so the command is to decide it. A dependency on a decision is
           satisfied by the choice, so which of these two rows is offered *is* the
           decision's state as the scheduler sees it — read from the same evaluation the
           inspector draws rather than from a second call asking the decision itself. */
        if (unmet) {
          rows.push({
            scope: "list",
            label: `Decide ${key}`,
            detail: `The decision blocking ${subject.slug}`,
            picker: {
              label: `Which option for ${key}?`,
              empty: "This decision offers no options; it is decided in the plan document.",
              load: async () => {
                const result = await window.orca.plan.decisions({ planId: plan });
                if (!result.ok) return [];
                const decision = result.result.decisions.find((d) => d.key === key || d.id === key);
                return (decision?.options ?? []).map(
                  (option): PaletteChoice => ({
                    id: option.key,
                    label: option.name,
                    /* What the matrix would have chosen, said rather than acted on: a
                       person is entitled to decide against it (`plan-control.ts`). */
                    ...(decision?.result?.recommended === option.key ? { hint: "the matrix's recommendation" } : {}),
                  }),
                );
              },
              choose: (option) => {
                void window.orca.plan.decide({ planId: plan, key, option }).then((result) => {
                  settle(result.ok, result.ok ? `${key} is decided: ${result.result.choice}.` : result.error.message);
                });
              },
            },
            action: () => {},
          });
        } else {
          rows.push({
            scope: "list",
            label: `Reopen decision ${key}`,
            detail: "Clears the choice and reopens every dependency it satisfied",
            action: () => {
              void window.orca.plan.reopen({ planId: plan, key }).then((result) => {
                settle(
                  result.ok,
                  result.ok
                    ? `${key} is open again; ${countOf(result.result.reopenedDependencyIds.length)} reopened with it.`
                    : result.error.message,
                );
              });
            },
          });
        }
      }
      // Only what is actually holding the item: a dependency the scheduler already sees
      // satisfied has nothing to waive, and a row for it would be a command that no-ops.
      if (unmet) {
        rows.push({
          scope: "list",
          label: `Waive dependency on ${name}`,
          detail: `${dependency.type}, now ${dependency.evaluation.state}: ${dependency.evaluation.detail}`,
          tone: "danger",
          confirm: `Waive ${name} — confirm; the way back is to add it again`,
          action: () => {
            void window.orca.plan.waive({ planId: plan, dependencyId: dependency.id }).then((result) => {
              settle(result.ok, result.ok ? `The dependency on ${name} is waived.` : result.error.message);
            });
          },
        });
      }
    }

    // A closed risk is finished with; the lifecycle has no step after it, so there is
    // nothing to move it to and no row for it.
    for (const risk of open.filter((r) => r.status !== "closed")) {
      rows.push({
        scope: "list",
        label: `Update risk ${risk.key}`,
        detail: `${risk.level}, ${risk.status} (L${risk.likelihood} × I${risk.impact})`,
        picker: {
          label: `Which status for ${risk.key}?`,
          empty: "No status to move this risk to.",
          /* The lifecycle, minus where it already is: a row that set a risk to the status
             it holds would write a journal entry saying nothing happened. */
          load: () =>
            Promise.resolve(
              RISK_STATUSES.filter((status) => status !== risk.status).map(
                (status): PaletteChoice => ({ id: status, label: status }),
              ),
            ),
          choose: (status) => {
            void window.orca.plan
              .updateRisk({ planId: plan, key: risk.key, status: status as RisksUpdateParams["status"] })
              .then((result) => {
                settle(result.ok, result.ok ? `${risk.key} is ${result.result.risk.status}.` : result.error.message);
              });
          },
        },
        action: () => {},
      });
    }

    /* The same act the Agents surface offers on the same claim, with the same confirmation
       and the same refusal: a claim whose owner could still resume gets no row at all,
       because `owner.releasable` predicts that refusal exactly and forcing one is
       `orca claims release --force` (#176). */
    if (claimed?.owner.releasable === true) {
      rows.push({
        scope: "list",
        label: `Release claim on ${claimed.workItemId}`,
        detail: `Takes it back from ${claimed.owner.name ?? claimed.owner.runId}; the item goes back to the scheduler`,
        tone: "danger",
        confirm: `Release ${claimed.workItemId} — confirm`,
        action: () => {
          void window.orca.claims.release({ workItemId: claimed.workItemId }).then((result) => {
            settle(
              result.ok,
              result.ok
                ? (result.result.note ?? `${claimed.workItemId} is released and back with the scheduler.`)
                : result.error.message,
            );
          });
        },
      });
    }

    return rows;
  }, [signature, settle]);

  usePaletteWrites(rows);
}

/** "3 dependencies", "1 dependency", "nothing" — a count said rather than a bare number. */
function countOf(n: number): string {
  if (n === 0) return "nothing";
  return n === 1 ? "1 dependency" : `${n} dependencies`;
}

/**
 * The selected item's claim as `claims.list` has it, read only when the item says there is
 * one. `PlanItemView.claim` is `{ runId }` and nothing else, and what the release row needs
 * is `owner.releasable` — the field that says whether the daemon would refuse. One read per
 * claimed item selected, and none at all for an item nobody is holding.
 */
function useItemClaim(item: PlanItemView | undefined): ClaimView | undefined {
  const [claim, setClaim] = useState<ClaimView | undefined>(undefined);
  const workItemId = item?.claim === undefined ? undefined : item.id;

  useEffect(() => {
    if (workItemId === undefined) {
      setClaim(undefined);
      return;
    }
    let live = true;
    void window.orca.claims.list({ workItemId }).then((result) => {
      if (!live) return;
      setClaim(result.ok ? result.result.claims.find((c) => c.workItemId === workItemId) : undefined);
    });
    return () => {
      live = false;
    };
  }, [workItemId]);

  return claim;
}
