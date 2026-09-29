/**
 * The risk mode's two reads (#172): the plan's risks with its matrix and appetite, and the
 * journal entries about the one selected.
 *
 * Both are read only while the mode is on screen — `planId` is handed in as `undefined`
 * otherwise — and neither polls. `revision` is `PlanFeed.itemsRevision`, which a `risks`
 * frame bumps; `journalSeq` is the journal's `lastSeq`, which moves only when the journal
 * does, so a risk's history is re-read when something was written to it and not before.
 */
import { useCallback, useEffect, useState } from "react";
import type { PlanJournalEntryView, ProtocolError, RiskMatrixView, RiskView } from "@orca/protocol";
import type { RiskLevel } from "../ui/index.js";
import { journalAbout } from "./risk-model.js";

export type RisksState =
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  | { phase: "ready"; risks: readonly RiskView[]; matrix: RiskMatrixView; appetite: RiskLevel };

export function usePlanRisks(planId: string | undefined, revision: number): { state: RisksState; reload: () => void } {
  const [state, setState] = useState<RisksState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (planId === undefined) return;
    let live = true;
    void window.orca.plan.risks({ planId }).then((result) => {
      if (!live) return;
      setState(
        result.ok
          ? {
              phase: "ready",
              risks: result.result.risks,
              matrix: result.result.matrix,
              appetite: result.result.appetite,
            }
          : { phase: "error", error: result.error },
      );
    });
    return () => {
      live = false;
    };
  }, [planId, revision, attempt]);

  return { state, reload };
}

/** The most a single read of the journal answers, which is the schema's `limit` ceiling. */
const JOURNAL_WINDOW = 500;

/**
 * The newest entries of the plan's journal that name the risk. One read per selection, taken
 * backwards from the end so a long journal still yields the most recent history.
 */
export function useRiskJournal(
  planId: string | undefined,
  risk: Pick<RiskView, "id" | "key"> | undefined,
  journalSeq: number,
): readonly PlanJournalEntryView[] {
  const [entries, setEntries] = useState<readonly PlanJournalEntryView[]>([]);
  const id = risk?.id;
  const key = risk?.key;

  useEffect(() => {
    if (planId === undefined || id === undefined || key === undefined) {
      setEntries([]);
      return;
    }
    let live = true;
    void window.orca.plan.journal({ planId, before: journalSeq + 1, limit: JOURNAL_WINDOW }).then((result) => {
      if (!live) return;
      setEntries(result.ok ? journalAbout(result.result.entries, { id, key }) : []);
    });
    return () => {
      live = false;
    };
  }, [planId, id, key, journalSeq]);

  return entries;
}
