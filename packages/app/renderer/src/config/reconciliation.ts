/** Three-way operation checks never replay array positions across changed collections. */
import type { DocumentPath, EditIntent } from "./structured-form/contracts.js";
import { atPath, projectEdits } from "./structured-form/collection-model.js";
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function reconcileConfigurationEdits(
  base: unknown,
  current: unknown,
  edits: readonly EditIntent[],
): { conflicts: DocumentPath[]; edits: readonly EditIntent[] } {
  const conflicts: DocumentPath[] = [];
  let oldProjection = base,
    newProjection = current;
  for (const edit of edits) {
    // Structural paths are compared at their owning collection, including numeric removal.
    const numeric = edit.path.findIndex((part) => typeof part === "number");
    const path = numeric >= 0 ? edit.path.slice(0, numeric) : edit.path;
    try {
      if (!equal(atPath(oldProjection, path), atPath(newProjection, path))) conflicts.push(path);
      // Matching missing descendants can still have a different parent; projectEdits refuses unsafe shape changes.
      newProjection = projectEdits(newProjection, [edit]);
      oldProjection = projectEdits(oldProjection, [edit]);
    } catch {
      conflicts.push(path);
    }
  }
  return { conflicts, edits: structuredClone(edits) };
}
