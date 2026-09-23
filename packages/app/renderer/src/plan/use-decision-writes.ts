/**
 * The decision mode's palette rows (#173): decide the selected decision, or reopen it.
 *
 * The same two acts the matrix offers, registered as keyless commands so the palette can
 * reach them from anywhere in the mode — the palette is where every phase-2 write has to be
 * discoverable (#178). Deciding picks an option, with the matrix's recommendation marked and
 * never pre-chosen; reopening is armed with the same sentence the matrix's confirmation says,
 * naming the items whose dependencies it reopens.
 */
import { useMemo, useRef } from "react";
import type { DecisionView } from "@orca/protocol";
import { useAnnounce } from "../a11y/announce-context.js";
import type { PaletteChoice } from "../keyboard-map.js";
import { usePaletteWrites, type PaletteWrite } from "../palette/use-write-actions.js";
import { decideParams, optionName, reopenQuestion } from "./decision-model.js";

export function useDecisionWrites(planId: string, decision: DecisionView | undefined): void {
  const announce = useAnnounce();
  const say = useRef(announce);
  say.current = announce;

  const held = useRef(decision);
  held.current = decision;
  /* Everything the rows read: the picker lists the options and marks the recommendation, and
     the reopen confirmation names the gated items — so a push that moves any of them, without
     moving the status, is a new set of rows rather than a stale one. */
  const signature =
    decision === undefined
      ? ""
      : JSON.stringify([
          decision.id,
          decision.status,
          decision.chosen ?? "",
          decision.options.map((o) => [o.key, o.name]),
          decision.result?.recommended ?? "",
          decision.blocks.map((b) => b.slug),
        ]);

  const rows = useMemo((): readonly PaletteWrite[] => {
    const d = held.current;
    if (d === undefined || signature === "") return [];
    if (d.status === "decided") {
      return [
        {
          scope: "list",
          method: "decisions.reopen",
          label: `Reopen decision ${d.key}`,
          labelMachine: d.key,
          detail: "Clears the choice and reopens every dependency it satisfied",
          tone: "danger",
          confirm: reopenQuestion(d),
          action: () => {
            void window.orca.plan.reopen({ planId, key: d.key }).then((result) => {
              say.current(
                result.ok
                  ? `${d.key} is open again; ${result.result.reopenedDependencyIds.length} reopened with it.`
                  : `That did not go through: ${result.error.message}`,
              );
            });
          },
        },
      ];
    }
    return [
      {
        scope: "list",
        method: "decisions.decide",
        label: `Decide ${d.key}`,
        labelMachine: d.key,
        detail: d.title,
        picker: {
          label: `Which option for ${d.key}?`,
          empty: "This decision offers no options.",
          load: () =>
            Promise.resolve(
              d.options.map((option): PaletteChoice => ({
                id: option.key,
                label: option.name,
                ...(d.result?.recommended === option.key ? { hint: "the matrix's recommendation" } : {}),
              })),
            ),
          choose: (option) => {
            void window.orca.plan.decide(decideParams(planId, d.key, option, "")).then((result) => {
              say.current(
                result.ok
                  ? `${d.key} is decided: ${optionName(d, result.result.choice)}.`
                  : `That did not go through: ${result.error.message}`,
              );
            });
          },
        },
        action: () => {},
      },
    ];
  }, [planId, signature]);

  usePaletteWrites(rows);
}
