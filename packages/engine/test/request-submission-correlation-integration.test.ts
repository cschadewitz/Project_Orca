/** Strict Request input validation through the actual reserved orchestrator correlation wiring. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fileStores } from "@orca/store";
import { FileAdmissionStore } from "../src/program/submission-store.js";
import { submissionFixture } from "./request-submission-fixture.js";

it.each(["initial", "before-root", "after-root"])(
  "uses native correlation for strict %s admission",
  async (boundary) => {
    const dir = await mkdtemp(join(tmpdir(), "orca-native-correlation-"));
    try {
      const options = {
        nativeCorrelation: true,
        strictInputs: true,
        sensitiveInputs: false,
      };
      const f = submissionFixture(fileStores(dir), new FileAdmissionStore(dir), options);
      const start = f.orc.startRun.bind(f.orc);
      let rootId: string | undefined;
      if (boundary !== "initial") {
        vi.spyOn(f.orc, "startRun").mockImplementationOnce(async (launch) => {
          if (boundary === "after-root") rootId = await start(launch);
          throw new Error("crash at root publication");
        });
      }
      const result = await f.service.submit(
        { title: "Strict", body: "Request", vars: { token: "valid" } },
        f.authority,
      );
      expect(result.state).toBe(boundary === "initial" ? "accepted" : "recoverable-failure");
      const peer = submissionFixture(fileStores(dir), new FileAdmissionStore(dir), options);
      const recovered = await peer.service.reconcile(result.admissionId, peer.authority);
      expect(recovered.state).toBe("accepted");
      if (recovered.state !== "accepted") throw new Error("not accepted");
      if (rootId) expect(recovered.runId).toBe(rootId);
      expect(await peer.orc.listRuns()).toEqual([recovered.runId]);
      const [created] = await peer.orc.stores.events.read(recovered.runId);
      expect(created).toMatchObject({
        payload: { requestAdmissionId: result.admissionId },
      });
      expect(created?.executionPayloadRef).toBeDefined();
      expect((await peer.stores.execution.getInputs(recovered.runId))?.vars).not.toHaveProperty("__orcaAdmissionId");
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
