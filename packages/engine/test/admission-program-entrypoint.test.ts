/** Program/ACP's production entry point cannot reinterpret a prior first start as a new dispatch. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fileStores } from "@orca/store";
import { OrcaError, type SubmissionAuthority } from "@orca/core";
import { OwnershipStore } from "../../daemon/src/auth/ownership.js";
import { ProgramService } from "../src/program/service.js";
import { FileAdmissionStore } from "../src/program/submission-store.js";
import { actor, admissionRuntime } from "./admission-execution-fixture.js";

it("ProgramService.runSubmitted shares live work, refuses a prior attempt, and preserves explicit resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-program-admission-fence-"));
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const f = await admissionRuntime(fileStores(dir), {
      effect: async () => {
        entered();
        await waiting;
      },
    });
    const ownership = new OwnershipStore(join(dir, "ownership.json"));
    let allowed = true;
    const check = async () => {
      if (!allowed) throw new OrcaError("RUN_STATE", "authority revoked");
    };
    const authority: SubmissionAuthority = {
      workspaceId: "admission-workspace",
      actor,
      authorize: check,
      onRunAdmitted: async (runId) => {
        await check();
        ownership.record(runId, actor.principalId);
        await ownership.flush(runId);
      },
      verifyRunAdmitted: async (runId) => {
        await check();
        await ownership.verify(runId, actor.principalId);
      },
    };
    f.orc.admissionExecution = {
      authorize: async (policy) => {
        expect(policy.binding.actor).toEqual(actor);
        expect(policy.binding.workspaceId).toBe(authority.workspaceId);
        await authority.verifyRunAdmitted!(policy.binding.runId);
      },
    };
    const program = new ProgramService(f.orc, "admission-fence", undefined, {
      admissions: new FileAdmissionStore(dir),
      captureLaunch: (selection) => f.orc.generations!.captureLaunch(selection),
      restoreLaunch: (recorded) => f.orc.generations!.restoreLaunch(recorded),
      authority,
    });
    const admitted = await program.submit({ title: "Work", body: "Work" });
    const first = program.runSubmitted(admitted);
    await entering;
    const replay = program.runSubmitted(admitted);
    release();
    expect((await first).run.status).toBe("paused");
    expect((await replay).run.status).toBe("paused");
    expect(f.effects()).toBe(1);
    await expect(program.runSubmitted(admitted)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(f.effects()).toBe(1);
    allowed = false;
    await expect(program.runSubmitted(admitted)).rejects.toMatchObject({ code: "RUN_STATE" });
    allowed = true;
    const input = (await f.orc.pendingInputs(admitted.runId))[0]!;
    await f.orc.answer(input.id, "go", admitted.runId, undefined, undefined, actor);
    expect((await program.resume(admitted.runId)).run.status).toBe("completed");
    expect((await program.runSubmitted(admitted)).run.status).toBe("completed");
    expect(f.effects()).toBe(1);
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});
