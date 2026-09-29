/** Artifact field lookup shared by decision sources and deliverable validation. */
import { pathGet } from "@orca/core";

/** An exact top-level key wins when both it and a nested path exist. */
export function artifactFieldGet(data: Record<string, unknown>, field: string): unknown {
  return Object.hasOwn(data, field) ? data[field] : pathGet(data, field);
}
