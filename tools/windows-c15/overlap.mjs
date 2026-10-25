/** Same-host monotonic interval proof; never substitute campaign duration for CLI work. */
import assert from "node:assert/strict";
import { validateLifecycle } from "./cli-lifecycle.mjs";
export const DEMO_COUNT = 2;
// QPC cross-thread ordering is ambiguous within one tick. Microsoft documents
// <1 us resolution; exclude 2 us at BOTH bounds, also covering ns conversion.
// This only narrows captured-clock overlap; it never proves continuous CPU work.
export const BOUNDARY_EXCLUSION_NS = 2000n;
function tick(value) {
  assert.match(value ?? "", /^[0-9]+$/, "missing monotonic execution evidence");
  return BigInt(value);
}
export function validateOverlap(row) {
  assert.equal(row.executionMembers.length, DEMO_COUNT, "complete fixed workload required");
  let previousEnd;
  const intervals = row.executionMembers.map((member, index) => {
    assert.equal(member.index, index);
    const { start, end } = validateLifecycle(member);
    if (previousEnd !== undefined) assert.ok(previousEnd <= start, "sequential CLI work required");
    previousEnd = end;
    return { start, end };
  });
  if (row.mode === "off") return;
  assert.equal(row.diagnostic.cells.length, 20, "all original cells required");
  for (const cell of row.diagnostic.cells) {
    const entry = tick(cell.faultEnteredNs);
    assert.ok(
      intervals.some(({ start, end }) => start + BOUNDARY_EXCLUSION_NS < entry && entry + BOUNDARY_EXCLUSION_NS < end),
      `fault-outside-cli-execution:${cell.target}`,
    );
  }
}
