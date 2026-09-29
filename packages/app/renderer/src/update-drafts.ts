/** Draft owners register with the app-wide restart guard; no second copy of their data. */
import { useLayoutEffect, useRef } from "react";
const drafts = new Map<symbol, boolean>();
export function hasUpdateDrafts(): boolean {
  return [...drafts.values()].some(Boolean);
}
export function useUpdateDraft(dirty: boolean): void {
  const id = useRef(Symbol("draft"));
  useLayoutEffect(() => {
    const key = id.current;
    drafts.set(key, dirty);
    return () => {
      drafts.delete(key);
    };
  }, [dirty]);
}
