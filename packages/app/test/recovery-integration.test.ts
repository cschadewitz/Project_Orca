import { frozenReportText } from "./recovery-preparation/frozen-report-text.js";
/** Real encrypted fs/coordinator schedules on disposable Linux profiles; not native acceptance. */
import { access, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { RECOVERY_LIMITS, type ExportState } from "../src/main/diagnostics/recovery-contract.js";
import { DIAGNOSTIC_LIMITS } from "../src/main/diagnostics/profile.js";
import { withSyntheticProfile } from "./recovery-preparation/crash-harness.js";
import { barrier, inspectPrivateRoot } from "./recovery-preparation/filesystem-evidence.js";
import {
  implementationFixture,
  enableAndExport,
  value,
  SyntheticKeys,
  ControlledNative,
  compiledFixtureHelper,
  cleanupFixtureHelper,
} from "./recovery-preparation/implementation-fixture.js";
import { crashImplementationAt } from "./recovery-preparation/process-fixture.js";

const linux = process.platform === "linux";
afterAll(cleanupFixtureHelper);

describe.runIf(linux)("real export adapter conformance (Linux disposable filesystem)", () => {
  it.each(["before-optout-summary-removal", "after-optout-summary-removal"] as const)(
    "process crash %s respects durable summary removal and preserves earlier exports",
    async (boundary) => {
      await withSyntheticProfile(async (profile) => {
        const crashed = await crashImplementationAt(profile, boundary);
        expect(crashed.signal).toBe("SIGKILL");
        const evidence = crashed.evidence;
        if (!evidence) throw new Error("Actual opt-out crash omitted its bounded observation evidence");
        const root = join(profile, "private");
        const metadata = join(root, "export.json");
        const expectedSummary = {
          id: evidence.acknowledgedId,
          outcome: "unknown",
          acknowledged: true,
          olderUnknowns: false,
        };
        const keys = new SyntheticKeys();
        keys.usable = false;
        const wrapped = vi.spyOn(keys, "wrap");
        const unwrapped = vi.spyOn(keys, "unwrap");
        const native = new ControlledNative(await compiledFixtureHelper());
        let retainedMetadata: Buffer | undefined;
        if (boundary === "before-optout-summary-removal") {
          retainedMetadata = await readFile(metadata);
          expect((JSON.parse(retainedMetadata.toString("utf8")) as ExportState).summary).toEqual(expectedSummary);
          native.beforeRemove = async (path) => {
            if (path === metadata) throw new Error("Synthetic summary-removal cleanup failure");
          };
        } else await expect(access(metadata)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(join(profile, "report.json"))).toEqual(Buffer.from(evidence.publishedText));

        const fixture = await implementationFixture(profile, { keys, native });
        expect((await fixture.disk.readSetting()).enabled).toBe(false);
        expect(fixture.controller.status().enabled).toBe(false);
        expect(fixture.controller.status().previous).toBe(false);
        expect(fixture.controller.record("run", "run_failed")).toBe(false);
        expect((await fixture.controller.prepareExport("current")).ok).toBe(false);
        expect(fixture.native.publishCalls).toBe(0);
        expect(fixture.picker.calls).toBe(0);
        expect(wrapped).not.toHaveBeenCalled();
        expect(unwrapped).not.toHaveBeenCalled();
        if (boundary === "before-optout-summary-removal") {
          expect(fixture.controller.status().acknowledgedUnknown).toBe(true);
          expect(fixture.controller.status().cleanupPending).toBe(true);
          expect((await fixture.disk.readExportState()).summary).toEqual(expectedSummary);
          expect((await fixture.controller.retryCleanup()).ok).toBe(false);
          expect(await readFile(metadata)).toEqual(retainedMetadata);
          native.beforeRemove = undefined;
          value(await fixture.controller.retryCleanup());
        } else {
          expect(fixture.controller.status().acknowledgedUnknown).toBe(false);
          await expect(access(metadata)).rejects.toMatchObject({ code: "ENOENT" });
          value(await fixture.controller.retryCleanup());
          await expect(access(metadata)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect((await fixture.disk.readExportState()).summary).toBeUndefined();
        expect((await fixture.disk.readExportState()).current).toBeUndefined();
        expect(fixture.controller.status().cleanupPending).toBe(false);
        const bounded = await inspectPrivateRoot(root);
        expect(bounded.entries).toBeLessThanOrEqual(RECOVERY_LIMITS.entries);
        expect(bounded.exportMetadataBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.cleanupBytes);
        expect([...bounded.files.keys()].some((name) => /^slot-|^session-/.test(name))).toBe(false);
        await expect(access(join(root, "export-stage.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(join(profile, "report.json"))).toEqual(Buffer.from(evidence.publishedText));
        expect(fixture.native.publishCalls).toBe(0);
        expect(fixture.picker.calls).toBe(0);
        expect(wrapped).not.toHaveBeenCalled();
        expect(unwrapped).not.toHaveBeenCalled();
        await fixture.controller.cleanExit();
      });
    },
  );

  it("an opt-out process crash cannot erase a newer unresolved Save behind an older acknowledgement", async () => {
    await withSyntheticProfile(async (profile) => {
      const crashed = await crashImplementationAt(profile, "optout-unresolved");
      expect(crashed.signal).toBe("SIGKILL");
      const evidence = crashed.evidence;
      if (!evidence?.unresolvedId) throw new Error("Actual crash omitted its newer unresolved-operation evidence");
      const keys = new SyntheticKeys();
      keys.usable = false;
      const fixture = await implementationFixture(profile, { keys });
      expect(fixture.controller.status().enabled).toBe(false);
      expect(fixture.controller.status().cleanupPending).toBe(true);
      expect(fixture.controller.status().unknownOperation).toBe(evidence.unresolvedId);
      expect(fixture.controller.record("run", "run_failed")).toBe(false);
      expect((await fixture.controller.prepareExport("current")).ok).toBe(false);
      expect((await fixture.disk.readExportState()).current?.id).toBe(evidence.unresolvedId);
      expect((await fixture.disk.readExportState()).summary?.id).toBe(evidence.acknowledgedId);
      value(await fixture.controller.retryCleanup());
      value(await fixture.controller.acknowledgeUnknown(evidence.acknowledgedId));
      expect((await fixture.disk.readExportState()).current?.id).toBe(evidence.unresolvedId);
      expect(fixture.controller.status().unknownOperation).toBe(evidence.unresolvedId);
      expect(fixture.controller.status().cleanupPending).toBe(true);
      const bounded = await inspectPrivateRoot(fixture.root);
      expect(bounded.entries).toBeLessThanOrEqual(RECOVERY_LIMITS.entries);
      expect(bounded.exportMetadataBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.cleanupBytes);
      expect([...bounded.files.keys()].some((name) => /^slot-|^session-/.test(name))).toBe(false);
      await expect(access(join(fixture.root, "export-stage.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(profile, "report.json"))).toEqual(Buffer.from(evidence.publishedText));
      value(await fixture.controller.acknowledgeUnknown(evidence.unresolvedId));
      expect((await fixture.disk.readExportState()).current).toBeUndefined();
      expect((await fixture.disk.readExportState()).summary).toBeUndefined();
      expect(fixture.controller.status().cleanupPending).toBe(false);
      expect(fixture.native.publishCalls).toBe(0);
      expect(fixture.picker.calls).toBe(0);
      expect(await readFile(join(profile, "report.json"))).toEqual(Buffer.from(evidence.publishedText));
      await expect(access(join(profile, "unknown-report.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(profile, "unresolved-report.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await fixture.controller.cleanExit();
    });
  });

  it.each(["retry-cleanup", "opt-in"] as const)(
    "restart inspection failure cannot hide durable unresolved authority from %s",
    async (attempt) => {
      await withSyntheticProfile(async (profile) => {
        const crashed = await crashImplementationAt(profile, "optout-unresolved");
        expect(crashed.signal).toBe("SIGKILL");
        const evidence = crashed.evidence;
        if (!evidence?.unresolvedId) throw new Error("Actual crash omitted its durable unresolved authority");
        const root = join(profile, "private");
        const journal = join(root, "export.json");
        const stage = join(root, "export-stage.tmp");
        const priorExport = join(profile, "report.json");
        const durableJournal = await readFile(journal);
        expect((JSON.parse(durableJournal.toString("utf8")) as ExportState).current?.id).toBe(evidence.unresolvedId);
        // Replace only the owned staging entry; the link's user-export target
        // must survive both strict inspection and later external link removal.
        await unlink(stage);
        await symlink(priorExport, stage);
        const keys = new SyntheticKeys();
        keys.usable = false;
        const fixture = await implementationFixture(profile, { keys });
        expect(fixture.controller.status().enabled).toBe(false);
        expect((await fixture.disk.readSetting()).enabled).toBe(false);
        expect(fixture.controller.status().cleanupPending).toBe(true);
        expect(fixture.controller.status().unknownOperation).toBeUndefined();
        await expect(fixture.disk.readExportState()).rejects.toThrow();
        expect(await readFile(journal)).toEqual(durableJournal);
        expect(await readFile(priorExport)).toEqual(Buffer.from(evidence.publishedText));
        await unlink(stage);

        const result =
          attempt === "retry-cleanup"
            ? await fixture.controller.retryCleanup()
            : await fixture.controller.setEnabled(true, 1);
        expect(fixture.controller.status().unknownOperation).toBe(evidence.unresolvedId);
        expect(fixture.controller.status().cleanupPending).toBe(true);
        expect(fixture.controller.status().enabled).toBe(false);
        expect((await fixture.disk.readSetting()).enabled).toBe(false);
        if (attempt === "opt-in") expect(result.ok).toBe(false);
        expect(await readFile(journal)).toEqual(durableJournal);
        expect((await fixture.disk.readExportState()).current?.id).toBe(evidence.unresolvedId);
        expect((await fixture.controller.prepareExport("current")).ok).toBe(false);
        expect(fixture.controller.record("run", "run_failed")).toBe(false);
        expect(fixture.native.publishCalls).toBe(0);
        expect(fixture.picker.calls).toBe(0);
        expect((await fixture.controller.setEnabled(true, 1)).ok).toBe(false);
        expect((await fixture.disk.readExportState()).current?.id).toBe(evidence.unresolvedId);
        expect(await readFile(priorExport)).toEqual(Buffer.from(evidence.publishedText));

        // Proven old-writer cessation and owned-slot cleanup permit ACK alone;
        // capture and a new picker still require a later explicit opt-in.
        value(await fixture.controller.acknowledgeUnknown(evidence.unresolvedId));
        expect((await fixture.disk.readExportState()).current).toBeUndefined();
        expect(fixture.controller.status().enabled).toBe(false);
        expect(fixture.picker.calls).toBe(0);
        expect(fixture.native.publishCalls).toBe(0);
        keys.usable = true;
        value(await fixture.controller.setEnabled(true, 1));
        expect(fixture.controller.record("run", "run_failed")).toBe(true);
        const preview = await frozenReportText(
          fixture.controller,
          value(await fixture.controller.prepareExport("current")),
        );
        fixture.picker.destination = join(profile, "fresh-after-ack.json");
        value(await fixture.controller.chooseDestination(preview.handle));
        expect(fixture.picker.calls).toBe(1);
        expect(fixture.native.publishCalls).toBe(0);
        expect(await readFile(priorExport)).toEqual(Buffer.from(evidence.publishedText));
        await expect(access(fixture.picker.destination)).rejects.toMatchObject({ code: "ENOENT" });
        value(await fixture.controller.cancelExport(preview.handle));
        await fixture.controller.cleanExit();
      });
    },
  );

  it.each(["before-stage-identity", "before-stage-write"])(
    "crash %s requires recorded identity before cleanup can release staging",
    async (boundary) => {
      await withSyntheticProfile(async (profile) => {
        await crashImplementationAt(profile, boundary);
        const fixture = await implementationFixture(profile);
        const state = await fixture.disk.readExportState();
        expect(state.current).toBeDefined();
        const id = state.current!.id;
        const retry = await fixture.controller.retryCleanup();
        if (boundary === "before-stage-identity") {
          expect(retry.ok).toBe(false);
          expect((await fixture.controller.acknowledgeUnknown(id)).ok).toBe(false);
          expect(await readFile(join(fixture.root, "export-stage.tmp"))).toHaveLength(0);
        } else {
          value(retry);
          value(await fixture.controller.acknowledgeUnknown(id));
          await expect(access(join(fixture.root, "export-stage.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(fixture.native.publishCalls).toBe(0);
        await fixture.controller.cleanExit();
      });
    },
  );
  it.each(["before-ack", "after-ack", "during-fresh-intent"])(
    "interruption at %s recovers bounded authority without automatic dispatch",
    async (boundary) => {
      await withSyntheticProfile(async (profile) => {
        const outcome = await crashImplementationAt(profile, boundary);
        expect(outcome.signal).toBe("SIGKILL");
        const fixture = await implementationFixture(profile);
        const state = await fixture.disk.readExportState();
        expect(fixture.native.publishCalls).toBe(0);
        expect(fixture.picker.calls).toBe(0);
        if (boundary === "before-ack") {
          expect(state.summary).toBeUndefined();
          expect(state.current).toBeDefined();
        } else {
          expect(state.summary?.outcome).toBe("unknown");
          expect(state.summary?.acknowledged).toBe(true);
        }
        const evidence = await inspectPrivateRoot(fixture.root);
        expect(evidence.exportMetadataBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.cleanupBytes);
        expect(evidence.entries).toBeLessThanOrEqual(RECOVERY_LIMITS.entries);
        await fixture.controller.cleanExit();
      });
    },
  );

  it("a Save timeout before admission revokes preview authority while retaining the live worker reservation", async () => {
    await withSyntheticProfile(async (profile) => {
      const fixture = await implementationFixture(profile, { timeoutMs: 500 });
      const preview = await enableAndExport(fixture);
      const destination = value(await fixture.controller.chooseDestination(preview.handle));
      const pending = barrier();
      let admittedPublications = 0;
      fixture.native.beforePublish = () => pending.wait();
      fixture.native.publication = async (stage, path) => {
        admittedPublications += 1;
        const { moveNoReplace } = await import("./recovery-preparation/implementation-fixture.js");
        return moveNoReplace(stage, path);
      };
      const saving = fixture.controller.save(preview.handle, destination.token);
      try {
        await enteredWithin(pending.entered);
        expect(await saving).toEqual({ ok: false, code: "publication_pending" });
        expect(fixture.controller.status().activeExportHandle).toBeUndefined();
        expect(fixture.controller.status().payloadReservedBytes).toBe(2 * RECOVERY_LIMITS.exportBytes);
        expect(fixture.controller.status().cleanupPending).toBe(true);
        expect(fixture.controller.status().saveAdmittedBeforeRevocation).toBe(false);
        expect(admittedPublications).toBe(0);
        expect(await readFile(join(fixture.root, "export-stage.tmp"))).toEqual(Buffer.from(preview.text));
        expect(await fixture.controller.chooseDestination(preview.handle)).toEqual({
          ok: false,
          code: "stale_export",
        });
        expect(await fixture.controller.retryCleanup()).toEqual({ ok: false, code: "publication_pending" });
        expect((await fixture.controller.prepareExport("current")).ok).toBe(false);
        expect(fixture.picker.calls).toBe(1);
      } catch (error) {
        // A red regression must still settle its own real disk worker before
        // removing the disposable profile or starting another test.
        pending.release();
        value(await fixture.controller.cancelExport(preview.handle));
        await waitFor(() => fixture.controller.status().payloadReservedBytes === 0);
        await fixture.controller.cleanExit();
        throw error;
      } finally {
        pending.release();
      }
      // Releasing the adapter alone must refuse admission; no renderer disposal
      // or explicit revocation is allowed to rescue this timed-out operation.
      await waitFor(() => fixture.controller.status().payloadReservedBytes === 0);
      expect(admittedPublications).toBe(0);
      expect(fixture.native.publishCalls).toBe(1);
      expect(fixture.controller.status().lastSaveOutcome).toBe("refused");
      expect(fixture.controller.status().saveAdmittedBeforeRevocation).toBe(false);
      expect(fixture.controller.status().cleanupPending).toBe(false);
      expect((await fixture.disk.readExportState()).current).toBeUndefined();
      await expect(access(join(fixture.root, "export-stage.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(fixture.picker.destination)).rejects.toMatchObject({ code: "ENOENT" });
      value(await fixture.controller.cancelExport(preview.handle));
      expect(fixture.controller.status().payloadReservedBytes).toBe(0);
      expect(await fixture.controller.save(preview.handle, destination.token)).toEqual({
        ok: false,
        code: "publication_pending",
      });
      expect((await fixture.controller.save(preview.handle, "new-token")).ok).toBe(false);
      expect(fixture.native.publishCalls).toBe(1);
      value(await fixture.controller.retryCleanup());
      await fixture.controller.cleanExit();
    });
  });

  it.each(["saved", "refused"] as const)(
    "live timeout blocks acknowledgement and late %s survives opt-out honestly",
    async (lateResult) => {
      await withSyntheticProfile(async (profile) => {
        const fixture = await implementationFixture(profile, { timeoutMs: 500 });
        const preview = await enableAndExport(fixture);
        const destination = value(await fixture.controller.chooseDestination(preview.handle));
        const pending = barrier();
        fixture.native.publication = async (stage, path) => {
          fixture.native.writerAlive = true;
          await pending.wait();
          fixture.native.writerAlive = false;
          if (lateResult === "saved") {
            const { moveNoReplace } = await import("./recovery-preparation/implementation-fixture.js");
            return moveNoReplace(stage, path);
          }
          return "refused";
        };
        const save = fixture.controller.save(preview.handle, destination.token);
        await enteredWithin(pending.entered);
        await save;
        const id = fixture.controller.status().unknownOperation;
        expect(id).toBeDefined();
        expect(fixture.controller.status().code).toBe("unknown_blocked");
        expect((await fixture.controller.acknowledgeUnknown(id!)).ok).toBe(false);
        const off = await fixture.controller.setEnabled(false, 1);
        expect(fixture.controller.status().enabled).toBe(false);
        expect(off.ok ? off.value.cleanupPending : true).toBe(true);
        value(await fixture.controller.cancelExport(preview.handle));
        pending.release();
        await waitFor(() => fixture.controller.status().payloadReservedBytes === 0);
        expect((await fixture.disk.readSetting()).enabled).toBe(false);
        value(await fixture.controller.retryCleanup());
        if (lateResult === "saved") expect(await readFile(fixture.picker.destination, "utf8")).toBe(preview.text);
        else await expect(access(fixture.picker.destination)).rejects.toMatchObject({ code: "ENOENT" });
        expect(fixture.controller.status().enabled).toBe(false);
        expect(fixture.native.publishCalls).toBe(1);
        await fixture.controller.cleanExit();
      });
    },
  );

  it("confirmed cessation and safe cleanup permit durable acknowledgement then a separate fresh Save", async () => {
    await withSyntheticProfile(async (profile) => {
      const fixture = await implementationFixture(profile);
      const first = await enableAndExport(fixture);
      const oldDestination = value(await fixture.controller.chooseDestination(first.handle));
      fixture.native.publication = () => Promise.resolve("unknown");
      await fixture.controller.save(first.handle, oldDestination.token);
      const id = fixture.controller.status().unknownOperation!;
      await fixture.controller.retryCleanup();
      const pickerCalls = fixture.picker.calls;
      value(await fixture.controller.acknowledgeUnknown(id));
      const state = await fixture.disk.readExportState();
      expect(state.current).toBeUndefined();
      expect(state.summary).toEqual({ id, outcome: "unknown", acknowledged: true, olderUnknowns: false });
      expect(fixture.picker.calls).toBe(pickerCalls);
      expect(fixture.native.publishCalls).toBe(1);
      fixture.native.publication = undefined;
      fixture.picker.destination = join(profile, "second-report.json");
      value(await fixture.controller.cancelExport(first.handle));
      const preview = await frozenReportText(
        fixture.controller,
        value(await fixture.controller.prepareExport("current")),
      );
      const destination = value(await fixture.controller.chooseDestination(preview.handle));
      expect(destination.token).not.toBe(oldDestination.token);
      value(await fixture.controller.save(preview.handle, destination.token));
      expect(await readFile(fixture.picker.destination, "utf8")).toBe(preview.text);
      expect((await fixture.disk.readExportState()).summary).toEqual(state.summary);
      value(await fixture.controller.setEnabled(false, 1));
      expect((await fixture.disk.readExportState()).summary).toBeUndefined();
      expect(await readFile(fixture.picker.destination, "utf8")).toBe(preview.text);
      await fixture.controller.cleanExit();
    });
  });

  it.each(["close", "expiry"] as const)(
    "known native refusal permits a fresh preview and picker after %s without resetting consent or history",
    async (disposal) => {
      await withSyntheticProfile(async (profile) => {
        const fixture = await implementationFixture(profile);
        const first = await enableAndExport(fixture);
        const priorPath = fixture.picker.destination;
        const firstDestination = value(await fixture.controller.chooseDestination(first.handle));
        value(await fixture.controller.save(first.handle, firstDestination.token));
        value(await fixture.controller.cancelExport(first.handle));
        await fixture.controller.checkpoint();
        const consent = await fixture.disk.readSetting();
        const setEnabled = vi.spyOn(fixture.controller, "setEnabled");
        const discardPrevious = vi.spyOn(fixture.controller, "discardPrevious");
        const refused = await frozenReportText(
          fixture.controller,
          value(await fixture.controller.prepareExport("current")),
        );
        const refusedPath = join(profile, "refused-report.json");
        fixture.picker.destination = refusedPath;
        const destination = value(await fixture.controller.chooseDestination(refused.handle));
        const priorUserContent = "Synthetic user file created after the picker, before native admission";
        fixture.native.beforePublish = () => writeFile(refusedPath, priorUserContent, { flag: "wx" });
        // The real Linux adapter must refuse this destination collision; it has
        // no modeled publication result and must not overwrite the user file.
        value(await fixture.controller.save(refused.handle, destination.token));
        fixture.native.beforePublish = undefined;
        expect(fixture.controller.status().lastSaveOutcome).toBe("refused");
        expect(fixture.controller.status().code).toBe("refused");
        expect(fixture.controller.status().cleanupPending).toBe(false);
        expect((await fixture.disk.readExportState()).current).toBeUndefined();
        expect(fixture.native.publishCalls).toBe(2);
        expect(await readFile(refusedPath, "utf8")).toBe(priorUserContent);
        if (disposal === "expiry") {
          fixture.clock.reading.elapsedMs += RECOVERY_LIMITS.exportMs;
          expect(fixture.controller.status().activeExportHandle).toBeUndefined();
          expect(fixture.controller.status().payloadReservedBytes).toBe(0);
          expect((await fixture.controller.chooseDestination(refused.handle)).ok).toBe(false);
        }
        value(await fixture.controller.cancelExport(refused.handle));
        expect(fixture.controller.status().payloadReservedBytes).toBe(0);
        expect(fixture.controller.record("run", "run_failed")).toBe(true);
        const maintain = vi.spyOn(fixture.disk, "maintain");
        const checkpoint = vi.spyOn(fixture.disk, "checkpoint");
        await fixture.controller.checkpoint();
        expect(maintain).toHaveBeenCalledTimes(1);
        expect(checkpoint).toHaveBeenCalledTimes(1);
        expect(fixture.controller.status().lastSaveOutcome).toBe("refused");
        expect(fixture.controller.status().code).toBe("refused");
        expect(await fixture.disk.readSetting()).toEqual(consent);
        const history = await inspectPrivateRoot(fixture.root);
        expect([...history.files.keys()].some((name) => /^slot-[012]\.bin$/.test(name))).toBe(true);
        const fresh = await frozenReportText(
          fixture.controller,
          value(await fixture.controller.prepareExport("current")),
        );
        expect(fresh.handle).not.toBe(refused.handle);
        expect(fresh.text).toContain("run_failed");
        fixture.picker.destination = join(profile, "fresh-report.json");
        const selected = value(await fixture.controller.chooseDestination(fresh.handle));
        expect(selected.token).not.toBe(destination.token);
        expect(fixture.picker.calls).toBe(3);
        expect(fixture.native.publishCalls).toBe(2);
        expect(fixture.controller.status().lastSaveOutcome).toBe("refused");
        expect(setEnabled).not.toHaveBeenCalled();
        expect(discardPrevious).not.toHaveBeenCalled();
        expect(await readFile(priorPath)).toEqual(Buffer.from(first.text));
        expect(await readFile(refusedPath, "utf8")).toBe(priorUserContent);
        await expect(access(fixture.picker.destination)).rejects.toMatchObject({ code: "ENOENT" });
        value(await fixture.controller.cancelExport(fresh.handle));
        await fixture.controller.cleanExit();
      });
    },
  );

  it("failed cleanup, unsafe identity and key loss never bypass acknowledgement", async () => {
    await withSyntheticProfile(async (profile) => {
      const fixture = await implementationFixture(profile);
      const preview = await enableAndExport(fixture);
      const destination = value(await fixture.controller.chooseDestination(preview.handle));
      fixture.native.publication = () => Promise.resolve("unknown");
      fixture.native.beforeRemove = async (path) => {
        if (path.endsWith("export-stage.tmp")) throw new Error("synthetic unlink failure");
      };
      await fixture.controller.save(preview.handle, destination.token);
      const id = fixture.controller.status().unknownOperation!;
      fixture.keys.usable = false;
      expect((await fixture.controller.acknowledgeUnknown(id)).ok).toBe(false);
      expect(fixture.controller.status().cleanupPending).toBe(true);
      const stage = join(fixture.root, "export-stage.tmp");
      fixture.native.beforeRemove = undefined;
      await unlink(stage);
      const unrelated = join(profile, "unrelated.txt");
      await writeFile(unrelated, "synthetic unrelated file");
      await symlink(unrelated, stage);
      expect((await fixture.controller.retryCleanup()).ok).toBe(false);
      expect((await fixture.controller.acknowledgeUnknown(id)).ok).toBe(false);
      expect(await readFile(unrelated, "utf8")).toBe("synthetic unrelated file");
      await unlink(stage);
      await fixture.controller.retryCleanup();
      value(await fixture.controller.acknowledgeUnknown(id));
      expect((await fixture.disk.readExportState()).summary?.outcome).toBe("unknown");
      await fixture.controller.cleanExit();
    });
  });

  it("malformed real operation metadata refuses new Save and cannot be erased by acknowledgement", async () => {
    await withSyntheticProfile(async (profile) => {
      const fixture = await implementationFixture(profile);
      const preview = await enableAndExport(fixture);
      const destination = value(await fixture.controller.chooseDestination(preview.handle));
      fixture.native.publication = () => Promise.resolve("unknown");
      await fixture.controller.save(preview.handle, destination.token);
      const id = fixture.controller.status().unknownOperation;
      expect(id).toBeDefined();
      await fixture.controller.cleanExit();
      const metadata = join(fixture.root, "export.json");
      const genuine = await readFile(metadata);
      const malformed = genuine.subarray(0, Math.floor(genuine.length / 2));
      await writeFile(metadata, malformed);
      const restarted = await implementationFixture(profile);
      expect(restarted.controller.status().cleanupPending).toBe(true);
      expect((await restarted.controller.acknowledgeUnknown(id!)).ok).toBe(false);
      expect((await restarted.controller.retryCleanup()).ok).toBe(false);
      expect(restarted.native.publishCalls).toBe(0);
      expect(await readFile(metadata)).toEqual(malformed);
      await restarted.controller.cleanExit();
    });
  });

  it("repeated Save joins one operation and revoked/stale handles cannot mutate later work", async () => {
    await withSyntheticProfile(async (profile) => {
      const fixture = await implementationFixture(profile);
      const preview = await enableAndExport(fixture);
      const destination = value(await fixture.controller.chooseDestination(preview.handle));
      const pending = barrier();
      fixture.native.beforePublish = () => pending.wait();
      const first = fixture.controller.save(preview.handle, destination.token);
      await enteredWithin(pending.entered);
      const second = fixture.controller.save(preview.handle, destination.token);
      fixture.controller.revokeExportAuthority();
      pending.release();
      await Promise.all([first, second]);
      expect(fixture.native.publishCalls).toBe(1);
      await expect(access(fixture.picker.destination)).rejects.toMatchObject({ code: "ENOENT" });
      fixture.native.beforePublish = undefined;
      expect((await fixture.controller.prepareExport("current")).ok).toBe(false);
      value(await fixture.controller.cancelExport(preview.handle));
      const fresh = await frozenReportText(
        fixture.controller,
        value(await fixture.controller.prepareExport("current")),
      );
      await fixture.controller.save(preview.handle, destination.token);
      expect(fixture.native.publishCalls).toBe(1);
      expect(fixture.controller.status().activeExportHandle).toBe(fresh.handle);
      await fixture.controller.cancelExport(preview.handle);
      expect(fixture.controller.status().activeExportHandle).toBe(fresh.handle);
      const chosen = value(await fixture.controller.chooseDestination(fresh.handle));
      value(await fixture.controller.save(fresh.handle, chosen.token));
      expect(fixture.native.publishCalls).toBe(2);
      expect(await readFile(fixture.picker.destination, "utf8")).toBe(fresh.text);
      await fixture.controller.cleanExit();
    });
  });

  it("fresh picker and native no-replace preserve existing files and exact committed export bytes", async () => {
    await withSyntheticProfile(async (profile) => {
      const fixture = await implementationFixture(profile);
      const preview = await enableAndExport(fixture);
      const destination = value(await fixture.controller.chooseDestination(preview.handle));
      await writeFile(fixture.picker.destination, "synthetic previous user export\n");
      const result = await fixture.controller.save(preview.handle, destination.token);
      expect(result.ok ? result.value.code : result.code).not.toBe("saved");
      expect(await readFile(fixture.picker.destination, "utf8")).toBe("synthetic previous user export\n");
      expect((await inspectPrivateRoot(fixture.root)).stagingBytes).toBe(0);
      fixture.picker.destination = join(profile, "new.json");
      value(await fixture.controller.cancelExport(preview.handle));
      const fresh = await frozenReportText(
        fixture.controller,
        value(await fixture.controller.prepareExport("current")),
      );
      const chosen = value(await fixture.controller.chooseDestination(fresh.handle));
      value(await fixture.controller.save(fresh.handle, chosen.token));
      expect(await readFile(fixture.picker.destination)).toEqual(Buffer.from(fresh.text, "utf8"));
      value(await fixture.controller.setEnabled(false, 1));
      expect(await readFile(fixture.picker.destination)).toEqual(Buffer.from(fresh.text, "utf8"));
      await fixture.controller.cleanExit();
    });
  });

  it.each(["failure", "hang"])("known committed Save stays saved during completion-record %s", async (fault) => {
    await withSyntheticProfile(async (profile) => {
      const fixture = await implementationFixture(profile, { timeoutMs: 500 });
      const preview = await enableAndExport(fixture);
      const destination = value(await fixture.controller.chooseDestination(preview.handle));
      const pending = barrier();
      fixture.native.beforeReplace = async (source, destination) => {
        if (!destination.endsWith("export.json") || (await readFile(source, "utf8")) !== "{}") return;
        if (fault === "failure") throw new Error("Synthetic completion-record failure");
        await pending.wait();
      };
      const saving = fixture.controller.save(preview.handle, destination.token);
      if (fault === "hang") await enteredWithin(pending.entered);
      await saving;
      expect(await readFile(fixture.picker.destination)).toEqual(Buffer.from(preview.text));
      expect(fixture.controller.status().lastSaveOutcome).toBe("saved");
      expect(fixture.controller.status().cleanupPending).toBe(true);
      expect(fixture.controller.status().code).toBe("cleanup_pending");
      if (fault === "failure") {
        value(await fixture.controller.setEnabled(false, 1));
        expect(fixture.controller.status().lastSaveOutcome).toBe("saved");
        expect(fixture.controller.status().code).toBe("cleanup_pending");
      }
      fixture.native.beforeReplace = undefined;
      if (fault === "hang") {
        expect((await fixture.controller.retryCleanup()).ok).toBe(false);
        pending.release();
        await waitFor(() => fixture.controller.status().code === "saved");
      }
      value(await fixture.controller.retryCleanup());
      expect(fixture.controller.status().lastSaveOutcome).toBe("saved");
      expect(fixture.controller.status().cleanupPending).toBe(false);
      expect((await fixture.disk.readExportState()).current).toBeUndefined();
      expect(fixture.native.publishCalls).toBe(1);
      expect(await readFile(fixture.picker.destination)).toEqual(Buffer.from(preview.text));
      await fixture.controller.cleanExit();
    });
  });

  it.each(["saved", "refused"] as const)(
    "a new admitted rejection after earlier %s remains unknown until explicit acknowledgement",
    async (earlierOutcome) => {
      await withSyntheticProfile(async (profile) => {
        const fixture = await implementationFixture(profile);
        const first = await enableAndExport(fixture);
        const firstPath = fixture.picker.destination;
        const firstDestination = value(await fixture.controller.chooseDestination(first.handle));
        if (earlierOutcome === "refused") fixture.native.publication = () => Promise.resolve("refused");
        value(await fixture.controller.save(first.handle, firstDestination.token));
        expect(fixture.controller.status().lastSaveOutcome).toBe(earlierOutcome);
        if (earlierOutcome === "saved") expect(await readFile(firstPath)).toEqual(Buffer.from(first.text));
        else await expect(access(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fixture.disk.readExportState()).current).toBeUndefined();
        value(await fixture.controller.cancelExport(first.handle));

        const second = await frozenReportText(
          fixture.controller,
          value(await fixture.controller.prepareExport("current")),
        );
        fixture.picker.destination = join(profile, "new-unknown-report.json");
        const secondDestination = value(await fixture.controller.chooseDestination(second.handle));
        fixture.native.publication = () => Promise.reject(new Error("Synthetic admitted adapter rejection"));
        // ControlledNative invokes the real controller admission callback before this rejection.
        await fixture.controller.save(second.handle, secondDestination.token);
        const id = fixture.controller.status().unknownOperation;
        expect(id).toBeDefined();
        expect(fixture.controller.status().lastSaveOutcome).toBe("unknown");
        expect(fixture.controller.status().code).toBe("unknown_blocked");
        expect((await fixture.disk.readExportState()).current?.id).toBe(id);

        value(await fixture.controller.retryCleanup());
        expect(fixture.controller.status().lastSaveOutcome).toBe("unknown");
        expect(fixture.controller.status().code).toBe("unknown_ready");
        expect((await fixture.disk.readExportState()).current?.id).toBe(id);
        expect((await fixture.controller.chooseDestination(second.handle)).ok).toBe(false);
        expect((await fixture.disk.readExportState()).summary).toBeUndefined();
        expect(fixture.native.publishCalls).toBe(2);

        value(await fixture.controller.acknowledgeUnknown(id!));
        const state = await fixture.disk.readExportState();
        expect(state.current).toBeUndefined();
        expect(state.summary).toEqual({ id, outcome: "unknown", acknowledged: true, olderUnknowns: false });
        expect(fixture.native.publishCalls).toBe(2);
        if (earlierOutcome === "saved") expect(await readFile(firstPath)).toEqual(Buffer.from(first.text));
        else await expect(access(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
        await fixture.controller.cleanExit();
      });
    },
  );

  it("all real metadata replacement copies remain bounded and unknown history saturates in one summary", async () => {
    await withSyntheticProfile(async (profile) => {
      const fixture = await implementationFixture(profile);
      value(await fixture.controller.setEnabled(true, 1));
      fixture.controller.record("connection", "connection_lost");
      let latest = "";
      let replacements = 0;
      fixture.native.beforeReplace = async (_source, destination) => {
        if (destination.endsWith("export.json")) {
          replacements += 1;
          const evidence = await inspectPrivateRoot(fixture.root);
          expect(evidence.exportMetadataBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.cleanupBytes);
          expect(evidence.controlBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.controlBytes);
          expect(evidence.entries).toBeLessThanOrEqual(RECOVERY_LIMITS.entries);
        }
      };
      fixture.native.publication = () => Promise.resolve("unknown");
      for (let index = 0; index < 4; index += 1) {
        const preview = await frozenReportText(
          fixture.controller,
          value(await fixture.controller.prepareExport("current")),
        );
        fixture.picker.destination = join(profile, `report-${index}.json`);
        const destination = value(await fixture.controller.chooseDestination(preview.handle));
        await fixture.controller.save(preview.handle, destination.token);
        latest = fixture.controller.status().unknownOperation!;
        await fixture.controller.retryCleanup();
        value(await fixture.controller.acknowledgeUnknown(latest));
        const state = await fixture.disk.readExportState();
        expect(state.summary).toEqual({ id: latest, outcome: "unknown", acknowledged: true, olderUnknowns: index > 0 });
        expect(Object.keys(state)).toEqual(["summary"]);
        value(await fixture.controller.cancelExport(preview.handle));
      }
      expect(replacements).toBeGreaterThanOrEqual(12);
      expect((await fixture.disk.readExportState()).summary?.id).toBe(latest);
      await fixture.controller.cleanExit();
    });
  });
});

describe.runIf(linux)("real recovery lifecycle and bounded maximum workload", () => {
  it("an unresolved export after restart expires crashed history without creating capture authority", async () => {
    await withSyntheticProfile(async (profile) => {
      expect((await crashImplementationAt(profile, "checkpoint-and-unknown")).signal).toBe("SIGKILL");
      const root = join(profile, "private");
      const originalManifest = await readFile(join(root, "manifest.json"));
      const committed = JSON.parse(originalManifest.toString("utf8")) as {
        payload: { current: { slot: number } };
      };
      const oldSlot = committed.payload.current.slot;
      const keys = new SyntheticKeys();
      const wrapped = vi.spyOn(keys, "wrap");
      const intervals = vi.spyOn(globalThis, "setInterval");
      let fixture: Awaited<ReturnType<typeof implementationFixture>>;
      let tick: (() => void) | undefined;
      try {
        fixture = await implementationFixture(profile, {
          keys,
          reading: { bootId: "synthetic-boot", elapsedMs: 2000 },
        });
        const scheduled = intervals.mock.calls.find((call) => call[1] === RECOVERY_LIMITS.checkpointMs);
        if (scheduled && typeof scheduled[0] === "function") tick = scheduled[0];
      } finally {
        intervals.mockRestore();
      }
      if (!tick) throw new Error("Actual unresolved-restart expiry timer was not installed");
      const id = fixture.controller.status().unknownOperation;
      expect(id).toBeDefined();
      expect(fixture.controller.status().enabled).toBe(true);
      expect(fixture.controller.status().previous).toBe(false);
      expect(fixture.controller.record("run", "run_failed")).toBe(false);
      expect((await fixture.controller.prepareExport("current")).ok).toBe(false);
      expect(await readFile(join(root, "manifest.json"))).toEqual(originalManifest);
      expect(wrapped).not.toHaveBeenCalled();
      expect(fixture.picker.calls).toBe(0);
      expect(fixture.native.publishCalls).toBe(0);

      const maintain = fixture.disk.maintain.bind(fixture.disk);
      let maintenanceFinished = false;
      const maintenance = vi.spyOn(fixture.disk, "maintain").mockImplementation(async (reading) => {
        const result = await maintain(reading);
        maintenanceFinished = true;
        return result;
      });
      fixture.clock.reading.elapsedMs = 1100 + RECOVERY_LIMITS.retentionMs;
      tick();
      await waitFor(() => maintenanceFinished);
      expect(maintenance).toHaveBeenCalledTimes(1);
      await expect(access(join(root, `slot-${oldSlot}.bin`))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(root, `session-${oldSlot}.key`))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fixture.disk.readExportState()).current?.id).toBe(id);
      expect(wrapped).not.toHaveBeenCalled();
      expect(fixture.controller.record("run", "run_failed")).toBe(false);
      expect((await fixture.controller.prepareExport("current")).ok).toBe(false);
      expect(fixture.picker.calls).toBe(0);
      expect(fixture.native.publishCalls).toBe(0);
      maintenance.mockRestore();
      await fixture.controller.cleanExit();
    });
  });
  it("the installed five-second timer expires old history while an unresolved export blocks checkpoints", async () => {
    await withSyntheticProfile(async (profile) => {
      await crashImplementationAt(profile, "checkpoint-committed");
      const intervals = vi.spyOn(globalThis, "setInterval");
      let fixture: Awaited<ReturnType<typeof implementationFixture>>;
      let tick: (() => void) | undefined;
      try {
        fixture = await implementationFixture(profile, { reading: { bootId: "synthetic-boot", elapsedMs: 2000 } });
        const scheduled = intervals.mock.calls.find((call) => call[1] === RECOVERY_LIMITS.checkpointMs);
        if (scheduled && typeof scheduled[0] === "function") tick = scheduled[0];
      } finally {
        intervals.mockRestore();
      }
      if (!tick) throw new Error("Actual recovery timer was not installed");
      expect(fixture.controller.status().previous).toBe(true);
      const committed = JSON.parse(await readFile(join(fixture.root, "manifest.json"), "utf8")) as {
        payload: { previous: { slot: number } };
      };
      const oldSlot = committed.payload.previous.slot;
      const preview = await frozenReportText(
        fixture.controller,
        value(await fixture.controller.prepareExport("current")),
      );
      const destination = value(await fixture.controller.chooseDestination(preview.handle));
      fixture.native.publication = () => Promise.resolve("unknown");
      await fixture.controller.save(preview.handle, destination.token);
      const id = fixture.controller.status().unknownOperation;
      expect(id).toBeDefined();
      value(await fixture.controller.cancelExport(preview.handle));
      fixture.clock.reading.elapsedMs = 1100 + RECOVERY_LIMITS.retentionMs;
      tick();
      await waitFor(() => !fixture.controller.status().previous);
      await expect(access(join(fixture.root, `slot-${oldSlot}.bin`))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(fixture.root, `session-${oldSlot}.key`))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fixture.disk.readExportState()).current?.id).toBe(id);
      expect(fixture.native.publishCalls).toBe(1);
      expect(fixture.controller.record("run", "run_failed")).toBe(true);
      value(await fixture.controller.retryCleanup());
      value(await fixture.controller.acknowledgeUnknown(id!));
      await fixture.controller.cleanExit();
    });
  });
  it.each(["boot-change", "rollback"])(
    "timer revokes stored roles and capture on uncertain clock: %s",
    async (fault) => {
      await withSyntheticProfile(async (profile) => {
        await crashImplementationAt(profile, "checkpoint-committed");
        const intervals = vi.spyOn(globalThis, "setInterval");
        let fixture: Awaited<ReturnType<typeof implementationFixture>>;
        let tick: (() => void) | undefined;
        try {
          fixture = await implementationFixture(profile, { reading: { bootId: "synthetic-boot", elapsedMs: 2000 } });
          const scheduled = intervals.mock.calls.find((call) => call[1] === RECOVERY_LIMITS.checkpointMs);
          if (scheduled && typeof scheduled[0] === "function") tick = scheduled[0];
        } finally {
          intervals.mockRestore();
        }
        if (!tick) throw new Error("Actual recovery timer was not installed");
        fixture.controller.record("run", "run_failed");
        await fixture.controller.checkpoint();
        const preview = await frozenReportText(
          fixture.controller,
          value(await fixture.controller.prepareExport("current")),
        );
        const wrapped = vi.spyOn(fixture.keys, "wrap");
        const maintain = fixture.disk.maintain.bind(fixture.disk);
        let finished = false;
        const maintenance = vi.spyOn(fixture.disk, "maintain").mockImplementation(async (reading) => {
          try {
            return await maintain(reading);
          } finally {
            finished = true;
          }
        });
        // The adapter deliberately reuses its object; mutation must not change
        // the controller's previous reading or immutable snapshot anchors.
        if (fault === "boot-change") fixture.clock.reading.bootId = "different-boot";
        else fixture.clock.reading.elapsedMs = 1999;
        tick();
        await waitFor(() => finished && fixture.controller.status().code === "age_uncertain");
        expect(maintenance).toHaveBeenCalledWith(undefined);
        const evidence = await inspectPrivateRoot(fixture.root);
        expect([...evidence.files.keys()].some((name) => /^slot-|^session-/.test(name))).toBe(false);
        expect(fixture.controller.status().enabled).toBe(true);
        expect((await fixture.disk.readSetting()).enabled).toBe(true);
        expect(fixture.controller.record("run", "run_failed")).toBe(false);
        expect((await fixture.controller.chooseDestination(preview.handle)).ok).toBe(false);
        value(await fixture.controller.cancelExport(preview.handle));
        fixture.clock.reading = { bootId: "synthetic-boot", elapsedMs: 3000 };
        value(await fixture.controller.retryCleanup());
        expect(fixture.controller.status().code).toBe("unavailable");
        expect(fixture.controller.record("run", "run_failed")).toBe(false);
        expect(wrapped).not.toHaveBeenCalled();
        maintenance.mockRestore();
        wrapped.mockRestore();
        await fixture.controller.cleanExit();
      });
    },
  );
  it.each(["failure", "hang"])(
    "durable opt-out %s stays visible and repeated requests do not allocate new writers",
    async (fault) => {
      await withSyntheticProfile(async (profile) => {
        const fixture = await implementationFixture(profile, { timeoutMs: 500 });
        value(await fixture.controller.setEnabled(true, 1));
        const pending = barrier();
        let disabledAttempts = 0;
        fixture.native.beforeReplace = async (source, destination) => {
          if (!destination.endsWith("setting.json") || !(await readFile(source, "utf8")).includes('"enabled":false'))
            return;
          disabledAttempts += 1;
          if (fault === "failure") throw new Error("Synthetic durable setting failure");
          await pending.wait();
        };
        const first = fixture.controller.setEnabled(false, 1);
        if (fault === "hang") await enteredWithin(pending.entered);
        expect((await first).ok).toBe(false);
        expect(fixture.controller.status().enabled).toBe(false);
        expect(fixture.controller.status().cleanupPending).toBe(true);
        expect(fixture.controller.record("run", "run_failed")).toBe(false);
        if (fault === "hang") {
          expect((await fixture.controller.setEnabled(false, 1)).ok).toBe(false);
          expect(disabledAttempts).toBe(1);
          pending.release();
          expect((await fixture.disk.readSetting()).enabled).toBe(false);
        }
        fixture.native.beforeReplace = undefined;
        value(await fixture.controller.retryCleanup());
        expect((await fixture.disk.readSetting()).enabled).toBe(false);
        expect(fixture.controller.status().cleanupPending).toBe(false);
        await fixture.controller.cleanExit();
      });
    },
  );
  it.each(["before-checkpoint-manifest", "after-checkpoint-manifest"])(
    "crash %s recovers only the actual committed generation",
    async (boundary) => {
      await withSyntheticProfile(async (profile) => {
        await crashImplementationAt(profile, boundary);
        const fixture = await implementationFixture(profile, {
          reading: { bootId: "synthetic-boot", elapsedMs: 2000 },
        });
        expect(fixture.controller.status().previous).toBe(true);
        const preview = await frozenReportText(
          fixture.controller,
          value(await fixture.controller.prepareExport("previous")),
        );
        expect(preview.text.includes("run_failed")).toBe(boundary === "after-checkpoint-manifest");
        expect(preview.text).toContain("connection_lost");
        await fixture.controller.cleanExit();
      });
    },
  );
  it.each(["opt-in-setting", "opt-in-open", "minutes"])(
    "opt-out races %s without restoring consent or capture",
    async (boundary) => {
      await withSyntheticProfile(async (profile) => {
        const fixture = await implementationFixture(profile);
        if (boundary === "minutes") value(await fixture.controller.setEnabled(true, 1));
        const pending = barrier();
        let paused = false;
        fixture.native.beforeReplace = async (source, destination) => {
          if (paused) return;
          const matches =
            boundary === "opt-in-open" ? destination.endsWith("manifest.json") : destination.endsWith("setting.json");
          if (!matches) return;
          const content = await readFile(source, "utf8");
          if (boundary !== "opt-in-open" && !content.includes('"enabled":true')) return;
          paused = true;
          await pending.wait();
        };
        const change =
          boundary === "minutes" ? fixture.controller.setMinutes(10) : fixture.controller.setEnabled(true, 1);
        await enteredWithin(pending.entered);
        const off = fixture.controller.setEnabled(false, 1);
        expect(fixture.controller.status().enabled).toBe(false);
        expect(fixture.controller.record("run", "run_failed")).toBe(false);
        pending.release();
        await Promise.all([change, off]);
        expect(fixture.controller.status().enabled).toBe(false);
        expect((await fixture.disk.readSetting()).enabled).toBe(false);
        if (boundary === "minutes") {
          expect(fixture.controller.status().minutes).toBe(10);
          expect((await fixture.disk.readSetting()).minutes).toBe(10);
        }
        expect(fixture.controller.record("run", "run_failed")).toBe(false);
        await fixture.controller.retryCleanup();
        expect(
          [...(await inspectPrivateRoot(fixture.root)).files.keys()].some((name) =>
            /^slot-|^session-|^control\.key$/.test(name),
          ),
        ).toBe(false);
        await fixture.controller.cleanExit();
      });
    },
  );

  it("production default-off preserves actual persistent opt-in while creating no capture keys or bytes", async () => {
    await withSyntheticProfile(async (profile) => {
      const fixture = await implementationFixture(profile, { productionEnabled: false });
      expect(fixture.controller.status().enabled).toBe(false);
      expect(fixture.controller.status().minutes).toBe(5);
      expect(fixture.controller.record("run", "run_failed")).toBe(false);
      value(await fixture.controller.setEnabled(true, 1));
      expect((await fixture.disk.readSetting()).enabled).toBe(true);
      expect(fixture.controller.record("run", "run_failed")).toBe(false);
      await fixture.controller.checkpoint();
      const evidence = await inspectPrivateRoot(fixture.root);
      expect([...evidence.files.keys()].some((name) => /^slot-|^session-|^control\.key$/.test(name))).toBe(false);
      await fixture.controller.cleanExit();
      const restarted = await implementationFixture(profile, { productionEnabled: false });
      expect(restarted.controller.status().enabled).toBe(true);
      expect(restarted.controller.status().productionEnabled).toBe(false);
      await restarted.controller.cleanExit();
    });
  });

  it("real checkpoint survives process crash, remains encrypted and expires at its original boot anchor", async () => {
    await withSyntheticProfile(async (profile) => {
      expect((await crashImplementationAt(profile, "checkpoint-committed")).signal).toBe("SIGKILL");
      const fixture = await implementationFixture(profile, { reading: { bootId: "synthetic-boot", elapsedMs: 2000 } });
      expect(fixture.controller.status().previous).toBe(true);
      const preview = await frozenReportText(
        fixture.controller,
        value(await fixture.controller.prepareExport("previous")),
      );
      expect(preview.tailLossPossible).toBe(true);
      expect(preview.text).toContain("connection_lost");
      const evidence = await inspectPrivateRoot(fixture.root);
      const ciphertext = [...evidence.files].filter(([name]) => /^slot-[012]\.bin$/.test(name));
      expect(ciphertext.length).toBeGreaterThan(0);
      expect(ciphertext.every(([, bytes]) => !bytes.includes(Buffer.from("connection_lost")))).toBe(true);
      value(await fixture.controller.cancelExport(preview.handle));
      fixture.clock.reading.elapsedMs = 1100 + RECOVERY_LIMITS.retentionMs;
      const result = await fixture.controller.prepareExport("previous");
      expect(result.ok).toBe(false);
      expect(fixture.controller.status().previous).toBe(false);
      await fixture.controller.cleanExit();
    });
  });

  it.each(["reboot", "key-loss", "manifest-corruption"])(
    "%s refuses genuine recovery without falling back to stray slots",
    async (fault) => {
      await withSyntheticProfile(async (profile) => {
        await crashImplementationAt(profile, "checkpoint-committed");
        const keys = new SyntheticKeys();
        if (fault === "key-loss") keys.usable = false;
        if (fault === "manifest-corruption") {
          const manifest = join(profile, "private", "manifest.json");
          const bytes = await readFile(manifest);
          bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 1;
          await writeFile(manifest, bytes);
        }
        const fixture = await implementationFixture(profile, {
          keys,
          reading: { bootId: fault === "reboot" ? "different-boot" : "synthetic-boot", elapsedMs: 2000 },
        });
        expect(fixture.controller.status().previous).toBe(false);
        expect((await fixture.controller.prepareExport("previous")).ok).toBe(false);
        expect(fixture.native.publishCalls).toBe(0);
        await fixture.controller.cleanExit();
      });
    },
  );

  it("8,192 offered events, concurrent checkpoint/preview/save and replacement pressure stay bounded", async () => {
    await withSyntheticProfile(async (profile) => {
      await crashImplementationAt(profile, "maximum-checkpoint-committed");
      const fixture = await implementationFixture(profile, {
        reading: { bootId: "synthetic-boot", elapsedMs: 10_000 },
      });
      expect(fixture.controller.status().previous).toBe(true);
      value(await fixture.controller.setEnabled(true, 1));
      for (let index = 0; index < DIAGNOSTIC_LIMITS.maxEvents; index += 1) {
        fixture.clock.reading.elapsedMs += 1;
        expect(fixture.controller.record("unknown", "unknown")).toBe(true);
      }
      const checkpoint = fixture.controller.checkpoint();
      expect((await fixture.controller.prepareExport("current")).ok).toBe(false);
      await checkpoint;
      const preview = await frozenReportText(
        fixture.controller,
        value(await fixture.controller.prepareExport("current")),
      );
      expect(preview.byteLength).toBe(Buffer.byteLength(preview.text));
      expect(preview.byteLength).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxReportBytes);
      const report = JSON.parse(preview.text) as { events: unknown[]; omissions: { budget: number } };
      expect(report.events.length).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxEvents);
      expect(report.events.length + report.omissions.budget).toBe(DIAGNOSTIC_LIMITS.maxEvents);
      fixture.native.beforeReplace = async () => {
        const evidence = await inspectPrivateRoot(fixture.root);
        expect(evidence.retainedBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.retainedBytes);
        expect(evidence.controlBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.controlBytes);
        expect(evidence.entries).toBeLessThanOrEqual(RECOVERY_LIMITS.entries);
        expect(fixture.controller.status().payloadReservedBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.payloadBytes);
      };
      await fixture.controller.checkpoint();
      const destination = value(await fixture.controller.chooseDestination(preview.handle));
      fixture.native.beforePublish = async () => {
        const evidence = await inspectPrivateRoot(fixture.root);
        expect(evidence.stagingBytes).toBe(preview.byteLength);
        expect(evidence.stagingBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.exportBytes);
        expect(evidence.retainedBytes + evidence.stagingBytes).toBeLessThanOrEqual(
          RECOVERY_LIMITS.retainedBytes + RECOVERY_LIMITS.exportBytes,
        );
        expect(fixture.controller.status().payloadReservedBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.payloadBytes);
      };
      value(await fixture.controller.save(preview.handle, destination.token));
      expect(await readFile(fixture.picker.destination)).toEqual(Buffer.from(preview.text));
      await fixture.controller.cleanExit();
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Actual operation did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function enteredWithin(entered: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Actual adapter boundary not reached")), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
