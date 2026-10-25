/** Same-host monotonic interval proof; never substitute campaign duration for CLI work. */
import assert from "node:assert/strict";
export const DEMO_COUNT = 2;
function tick(value) {
  assert.match(value ?? "", /^[0-9]+$/, "missing monotonic execution evidence");
  return BigInt(value);
}
export function validateOverlap(row) {
  assert.equal(row.executionMembers.length, DEMO_COUNT, "complete fixed workload required");
  let previousEnd;
  const intervals = row.executionMembers.map((member, index) => {
    assert.equal(member.index, index);
    assert.equal(member.exitCode, 0, "fixed CLI workload member failed");
    const start = tick(member.startedNs),
      end = tick(member.endedNs);
    assert.ok(start < end, "positive CLI execution interval required");
    if (previousEnd !== undefined) assert.ok(previousEnd <= start, "sequential CLI work required");
    previousEnd = end;
    return { start, end };
  });
  if (row.mode === "off") return;
  assert.equal(row.diagnostic.cells.length, 20, "all original cells required");
  for (const cell of row.diagnostic.cells) {
    const entry = tick(cell.faultEnteredNs);
    assert.ok(
      intervals.some(({ start, end }) => start <= entry && entry < end),
      `fault-outside-cli-execution:${cell.target}`,
    );
  }
}
