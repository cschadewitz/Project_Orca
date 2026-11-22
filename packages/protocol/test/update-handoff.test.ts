/** The updater's store handoff and who may claim it (#897). */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FirstRunWriterHold } from "../src/first-run-fence.js";
import {
  claimUpdateHandoff,
  HANDOFF_ATTEMPTS,
  readUpdateHandoff,
  removeUpdateHandoff,
  UPDATE_HANDOFF_FILE,
  writeUpdateHandoff,
  type UpdateHandoff,
} from "../src/update-handoff.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const dir = (path: string, ino: string) => ({ path, dev: "1", ino, uid: String(process.getuid?.() ?? 0) });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orca-handoff-"));
  const storeDir = join(root, ".orca");
  mkdirSync(storeDir, { mode: 0o700 });
  const workspace = dir(root, "10");
  const store = dir(storeDir, "11");
  const stopped = sha("stopped claim");
  const handoff: UpdateHandoff = {
    version: 1,
    kind: "orca-update-handoff",
    reservationId: randomUUID(),
    claimHash: stopped,
    workspace,
    store,
    from: "0.8.0",
    to: "0.9.0",
    drained: true,
    attempts: 0,
    createdAt: "2026-11-22T00:00:00.000Z",
  };
  /** A writer whose claim follows `previous`; `held` flips to model a lost fence. */
  const writer = (previous: string | null, overrides: Partial<FirstRunWriterHold> = {}) => {
    const state = { held: true };
    const claimHash = sha(randomUUID());
    const hold: FirstRunWriterHold = {
      workspace,
      store,
      storeDir,
      reservationId: randomUUID(),
      claimHash,
      previous,
      check: () => state.held,
      ...overrides,
    };
    return { hold, state };
  };
  return { root, storeDir, handoff, stopped, writer };
}

describe("update handoff (#897)", () => {
  it("is claimed only by the next writer of the exact store, at the installed version, holding the fence", () => {
    const f = fixture();
    expect(claimUpdateHandoff(undefined, "0.9.0")).toEqual({ ok: false, reason: "not-first-run" });
    expect(claimUpdateHandoff(f.writer(f.stopped).hold, "0.9.0")).toEqual({ ok: false, reason: "none" });
    writeUpdateHandoff(f.storeDir, f.handoff);
    const lost = f.writer(f.stopped);
    lost.state.held = false;
    expect(claimUpdateHandoff(lost.hold, "0.9.0")).toEqual({ ok: false, reason: "fence-not-held" });
    expect(claimUpdateHandoff(f.writer(f.stopped, { store: dir(f.storeDir, "99") }).hold, "0.9.0")).toEqual({
      ok: false,
      reason: "other-store",
    });
    expect(claimUpdateHandoff(f.writer(f.stopped, { workspace: dir(f.root, "98") }).hold, "0.9.0")).toEqual({
      ok: false,
      reason: "other-store",
    });
    // A reservation in between (any other launch) breaks the chain, as does a first-ever claim.
    expect(claimUpdateHandoff(f.writer(sha("someone else")).hold, "0.9.0")).toEqual({
      ok: false,
      reason: "not-next-reservation",
    });
    expect(claimUpdateHandoff(f.writer(null).hold, "0.9.0")).toEqual({ ok: false, reason: "not-next-reservation" });
    // The version the update did not install (an installer that never ran, then a restart).
    expect(claimUpdateHandoff(f.writer(f.stopped).hold, "0.8.0")).toEqual({ ok: false, reason: "other-version" });
    // None of the refusals changed the record.
    expect(readUpdateHandoff(f.storeDir)).toEqual(f.handoff);
  });

  it("moves onto the claiming writer before any copy, so an interrupted carryover retries a bounded number of times", () => {
    const f = fixture();
    writeUpdateHandoff(f.storeDir, f.handoff);
    let previous = f.stopped;
    for (let attempt = 1; attempt <= HANDOFF_ATTEMPTS; attempt++) {
      const { hold } = f.writer(previous);
      const claimed = claimUpdateHandoff(hold, "0.9.0");
      expect(claimed).toMatchObject({ ok: true, handoff: { attempts: attempt, claimHash: hold.claimHash } });
      expect(readUpdateHandoff(f.storeDir)).toMatchObject({ reservationId: hold.reservationId, attempts: attempt });
      // The writer that was handed the store before can no longer claim it.
      expect(claimUpdateHandoff(f.writer(previous).hold, "0.9.0")).toMatchObject({ reason: "not-next-reservation" });
      previous = hold.claimHash;
    }
    expect(claimUpdateHandoff(f.writer(previous).hold, "0.9.0")).toEqual({ ok: false, reason: "attempts-exhausted" });
  });

  it("refuses when the fence is lost while the handoff moves", () => {
    const f = fixture();
    writeUpdateHandoff(f.storeDir, f.handoff);
    let checks = 0;
    const { hold } = f.writer(f.stopped, { check: () => ++checks === 1 });
    expect(claimUpdateHandoff(hold, "0.9.0")).toEqual({ ok: false, reason: "fence-not-held" });
  });

  it("never trusts a damaged or shared record, and removes it cleanly", () => {
    const f = fixture();
    writeFileSync(join(f.storeDir, UPDATE_HANDOFF_FILE), "{not json", { mode: 0o600 });
    expect(readUpdateHandoff(f.storeDir)).toBeUndefined();
    writeUpdateHandoff(f.storeDir, f.handoff);
    chmodSync(join(f.storeDir, UPDATE_HANDOFF_FILE), 0o644);
    expect(readUpdateHandoff(f.storeDir)).toBeUndefined();
    removeUpdateHandoff(f.storeDir);
    removeUpdateHandoff(f.storeDir);
    expect(readdirSync(f.storeDir)).toEqual([]);
  });
});
