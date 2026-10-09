/** Owned Windows fault fixture; injected faults are not physical/native failure proof. */
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron's isolated CommonJS fixture entry. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { createHook } = require("node:async_hooks");
const { setTimeout: delay, setImmediate: turn } = require("node:timers/promises");
const { app, safeStorage } = require("electron");
const request = JSON.parse(fs.readFileSync(process.argv.at(-1), "utf8"));
const r = { schema: 1, mode: request.mode, schedule: request.schedule, cells: [], unhandledRejections: 0 };
let phase = "setup",
  timer,
  hook,
  current,
  sampleFinalMemory,
  activeNative = 0,
  nativePeak = 0;
const nativeTimes = {},
  callbacks = {},
  gaps = {},
  starts = new Map();
const deadline = setTimeout(() => app.exit(9), 90000);
for (const name of ["profile", "logs", "crashes"]) fs.mkdirSync(path.join(request.base, name));
app.setName("ORCA owned C15 fixture");
app.setPath("userData", path.join(request.base, "profile"));
app.setPath("sessionData", path.join(request.base, "profile"));
app.setPath("logs", path.join(request.base, "logs"));
app.setPath("crashDumps", path.join(request.base, "crashes"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
process.on("unhandledRejection", () => {
  r.unhandledRejections++;
});
const load = (name) => import(pathToFileURL(path.join(request.compiled, name + ".js")).href);
const value = (x) => {
  assert.equal(x.ok, true, x.code);
  return x.value;
};
async function bounded(work, ms, code) {
  let timeout;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Error(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
async function until(fn, ms = 3000) {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() >= end) throw Error("settlement-deadline");
    await delay(5);
  }
}
function arm(target, schedule) {
  let entered, release;
  const seen = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    target,
    schedule,
    seen,
    release,
    armed: true,
    hits: 0,
    outstanding: 0,
    peak: 0,
    async inject() {
      this.hits++;
      this.outstanding++;
      this.peak = Math.max(this.peak, this.outstanding);
      entered();
      try {
        if (schedule === "stall") await gate;
        throw Error("synthetic-writer-fault");
      } finally {
        this.outstanding--;
      }
    },
  };
}
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const { loadDiagnosticsAddon } = await load("native-addon");
    const backend = loadDiagnosticsAddon("diagnostics_storage");
    assert.equal(backend.platform, "win32");
    const { createHandleRelativeStorage } = await load("native-storage");
    const { loadNativeDiagnosticsClock } = await load("native-clock");
    const { loadWindowsDiagnosticsKeyAdapter } = await load("windows-key-adapter");
    const { createSafeStorageKeyAdapter } = await load("native-adapter");
    const { NodeRecoveryDisk } = await load("recovery-disk");
    const { RecoveryController } = await load("recovery-controller");
    const { ControlledPayloadMemory } = await load("payload-memory");
    const { RECOVERY_LIMITS } = await load("recovery-contract");
    const { DIAGNOSTICS_PRODUCTION_ENABLED } = await import(
      pathToFileURL(path.resolve(request.compiled, "../../diagnostics-contract.js")).href
    );
    assert.equal(DIAGNOSTICS_PRODUCTION_ENABLED, false);
    let legacyCalls = 0;
    const legacy = createSafeStorageKeyAdapter({
      isAsyncEncryptionAvailable() {
        legacyCalls++;
        return safeStorage.isAsyncEncryptionAvailable();
      },
      encryptStringAsync(x) {
        legacyCalls++;
        return safeStorage.encryptStringAsync(x);
      },
      decryptStringAsync(x) {
        legacyCalls++;
        return safeStorage.decryptStringAsync(x);
      },
    });
    const keys = loadWindowsDiagnosticsKeyAdapter(legacy),
      clock = loadNativeDiagnosticsClock();
    assert.ok(clock.read());
    const baseline = process.memoryUsage();
    let managedPeak = baseline.heapUsed + baseline.external,
      rssPeak = baseline.rss,
      binaryPeak = 0,
      reservationPeak = 0;
    function sample() {
      const m = process.memoryUsage();
      managedPeak = Math.max(managedPeak, m.heapUsed + m.external);
      rssPeak = Math.max(rssPeak, m.rss);
      if (current) {
        binaryPeak = Math.max(binaryPeak, current.payload.stats().peakBytes);
        reservationPeak = Math.max(reservationPeak, current.controller.status().payloadReservedBytes);
      }
    }
    sampleFinalMemory = () => {
      sample();
      r.memory = {
        method:
          "Electron main heapUsed+external sampled every 2ms and boundaries; arrayBuffers not added twice; no renderer in writer fixture; native allocator/RSS separate",
        managedIncrementBytes: managedPeak - baseline.heapUsed - baseline.external,
        managedLimitBytes: 33554432,
        rssIncrementBytes: rssPeak - baseline.rss,
        controlledBinaryPeakBytes: binaryPeak,
        binaryLimitBytes: RECOVERY_LIMITS.payloadBytes,
        reservationPeakBytes: reservationPeak,
        zeroAfterEveryCell: r.cells.every((x) => request.mode === "off" || x.checks.zeroControlledBinary),
      };
      r.memory.managedPass = r.memory.managedIncrementBytes <= r.memory.managedLimitBytes;
      r.memory.binaryPass = binaryPeak <= RECOVERY_LIMITS.payloadBytes;
      r.legacyCalls = legacyCalls;
    };
    hook = createHook({
      before(id) {
        starts.set(id, { at: performance.now(), phase });
      },
      after(id) {
        const start = starts.get(id);
        if (!start) return;
        starts.delete(id);
        const label = start.phase === phase ? phase : start.phase + "->" + phase;
        callbacks[label] = Math.max(callbacks[label] ?? 0, performance.now() - start.at);
      },
    });
    hook.enable();
    let lastBeat = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      gaps[phase] = Math.max(gaps[phase] ?? 0, now - lastBeat);
      lastBeat = now;
      sample();
    }, 2);
    fs.writeFileSync(path.join(request.base, "execution.start"), "start");
    await until(() => fs.existsSync(path.join(request.base, "execution.running")));
    const started = performance.now();
    // Every asynchronous RecoveryDisk operation, picker, and two native writer dispatches.
    const allMethods = [
      "readSetting",
      "readExportState",
      "writeSetting",
      "open",
      "maintain",
      "checkpoint",
      "previous",
      "discardPrevious",
      "cleanExit",
      "cleanup",
      "writeExportState",
      "stageExport",
      "clearStage",
      "validateDestination",
      "publishStage",
      "writersStopped",
      "picker",
      "completionRecord",
      "nativePublish",
      "nativeWrite",
    ];
    const methods = request.regressionTargets ?? allMethods;
    assert.ok(Array.isArray(methods) && methods.length > 0 && methods.length <= allMethods.length);
    assert.ok(methods.every((method) => allMethods.includes(method)));
    r.regressionOnly = request.regressionTargets !== undefined;
    r.expectedCells = methods;
    for (const target of methods) {
      phase = target + ":setup";
      const cell = { target, syntheticFault: true, checks: {}, faultObserved: false };
      r.cells.push(cell);
      if (request.mode === "off") {
        // Default-off controller exercises the same request surface without capture/key access.
        const disk = new Proxy(
          {},
          {
            get(_obj, method) {
              if (method === "revoke") return () => {};
              return async () => {
                if (method === "readSetting") return { enabled: false, scopeVersion: 1, minutes: 5 };
                if (method === "readExportState") return {};
                return undefined;
              };
            },
          },
        );
        const payload = new ControlledPayloadMemory();
        const controller = new RecoveryController({ disk, payload, clock });
        current = { controller, payload };
        await controller.initialize();
        assert.equal(controller.record("run", "run_failed"), false);
        assert.deepEqual(await controller.prepareExport("current"), { ok: false, code: "off" });
        await controller.checkpoint();
        await controller.cleanExit();
        cell.checks.defaultOff = payload.stats().allocatedBytes === 0;
        assert.equal(cell.checks.defaultOff, true);
        current = undefined;
        continue;
      }
      const directory = path.join(request.base, target);
      const payload = new ControlledPayloadMemory();
      const fault = arm(target, request.schedule);
      const timeoutMs = target === "nativeWrite" ? RECOVERY_LIMITS.operationMs : 1000;
      cell.operationTimeoutMs = timeoutMs;
      let diskCalls = 0,
        dispatches = 0,
        activeDisk = 0,
        diskPeak = 0,
        completion = 0;
      const watched = {
        ...backend,
        call: async (...args) => {
          dispatches++;
          activeNative++;
          nativePeak = Math.max(nativePeak, activeNative);
          const at = performance.now();
          try {
            if (
              fault.armed &&
              fault.hits === 0 &&
              ((target === "nativeWrite" && args[0] === "write" && args[5]?.length > 100000) ||
                (target === "nativePublish" && args[0] === "publish"))
            )
              await fault.inject();
            return await backend.call(...args);
          } finally {
            nativeTimes[args[0]] = Math.max(nativeTimes[args[0]] ?? 0, performance.now() - at);
            activeNative--;
          }
        },
      };
      const storage = createHandleRelativeStorage(directory, watched);
      const raw = new NodeRecoveryDisk({
        root: directory,
        payload,
        native: storage.native,
        files: storage.files,
        keys,
      });
      const disk = new Proxy(raw, {
        get(object, method) {
          const fn = object[method];
          if (typeof fn !== "function") return fn;
          if (method === "revoke") return fn.bind(object);
          return async (...args) => {
            diskCalls++;
            activeDisk++;
            diskPeak = Math.max(diskPeak, activeDisk);
            try {
              if (fault.armed && fault.hits === 0 && method === target) await fault.inject();
              if (
                fault.armed &&
                target === "completionRecord" &&
                method === "writeExportState" &&
                !args[0].current &&
                ++completion === 1
              )
                await fault.inject();
              return await fn.apply(object, args);
            } finally {
              activeDisk--;
            }
          };
        },
      });
      // The native validator conservatively refuses the diagnostic-root string prefix.
      const destination = path.join(request.base, "saved-" + target + ".json");
      // Setup always precedes arming, and never injects into another cell/profile.
      fault.armed = false;
      await raw.writeSetting({ enabled: target !== "open", scopeVersion: 1, minutes: 5 });
      if (target === "writersStopped")
        await raw.writeExportState({ current: { id: require("node:crypto").randomUUID(), phase: "unknown" } });
      const controller = new RecoveryController({
        disk,
        payload,
        clock,
        productionEnabled: true,
        operationTimeoutMs: timeoutMs,
        chooseDestination: async () => {
          if (fault.armed && fault.hits === 0 && target === "picker") await fault.inject();
          return destination;
        },
      });
      current = { controller, payload, raw, storage, fault };
      if (request.regressionBadDestinationProbe) {
        assert.equal(await raw.validateDestination(path.join(request.base, target + "-saved.json")), false);
        assert.equal(await raw.validateDestination(destination), true);
        cell.prefixRefusalVerified = true;
      }
      let prepared, token;
      const startup = ["readSetting", "readExportState"];
      if (!startup.includes(target)) await controller.initialize();
      if (
        [
          "stageExport",
          "publishStage",
          "writeExportState",
          "nativePublish",
          "completionRecord",
          "validateDestination",
          "picker",
        ].includes(target)
      ) {
        prepared = value(await controller.prepareExport("current"));
        if (!["validateDestination", "picker"].includes(target))
          token = value(await controller.chooseDestination(prepared.handle)).token;
      }
      if (["checkpoint", "nativeWrite"].includes(target)) {
        for (let i = 0; i < 8192; i++) {
          assert.equal(controller.record("run", "run_failed"), true);
          if (i % 128 === 0) await turn();
        }
      }
      const invoke = () => {
        if (startup.includes(target)) return controller.initialize();
        if (target === "writeSetting") return controller.setMinutes(10);
        if (target === "open") return controller.setEnabled(true, 1);
        if (["maintain", "checkpoint", "nativeWrite"].includes(target)) return controller.checkpoint();
        if (target === "previous") return controller.prepareExport("previous");
        if (target === "discardPrevious") return controller.discardPrevious();
        if (target === "cleanExit") return controller.cleanExit();
        if (target === "cleanup") return controller.setEnabled(false, 1);
        if (["clearStage", "writersStopped"].includes(target)) return controller.retryCleanup();
        if (["validateDestination", "picker"].includes(target)) return controller.chooseDestination(prepared.handle);
        return controller.save(prepared.handle, token);
      };
      phase = target + ":fault";
      fault.armed = true;
      const at = performance.now(),
        pending = invoke();
      await bounded(fault.seen, 3000, "fault-not-reached");
      cell.faultObserved = true;
      cell.enteredMs = performance.now() - started;
      const before = { diskCalls, dispatches, allocations: payload.stats().allocations };
      if (request.schedule === "stall") {
        // All 128 attempts settle without enqueueing another disk mutation or allocating another report.
        const pressure = await bounded(
          Promise.all(Array.from({ length: 128 }, () => controller.prepareExport("current"))),
          timeoutMs + 1000,
          "pressure-deadline",
        );
        cell.pressure = {
          attempts: pressure.length,
          refused: pressure.filter((x) => !x.ok).length,
          diskCallsAdded: diskCalls - before.diskCalls,
          dispatchesAdded: dispatches - before.dispatches,
          payloadAllocationsAdded: payload.stats().allocations - before.allocations,
        };
        assert.equal(cell.pressure.refused, 128);
        assert.equal(cell.pressure.diskCallsAdded, 0);
        assert.equal(cell.pressure.dispatchesAdded, 0);
        assert.equal(cell.pressure.payloadAllocationsAdded, 0);
      }
      const outcome = await bounded(pending, timeoutMs + 1500, "public-operation-deadline");
      cell.publicElapsedMs = performance.now() - at;
      cell.publicOutcome = outcome?.ok === undefined ? "void" : outcome.ok ? "status" : outcome.code;
      cell.pendingBeforeRevocation = controller.status().cleanupPending;
      cell.reservationBeforeRevocation = controller.status().payloadReservedBytes;
      cell.writerOutstandingBeforeRelease = fault.outstanding;
      if (request.schedule === "stall") assert.equal(fault.outstanding, 1);
      if (target === "completionRecord") assert.equal(controller.status().lastSaveOutcome, "saved");
      const cancelAt = performance.now();
      if (prepared) await controller.cancelExport(prepared.handle);
      const disabling = controller.setEnabled(false, 1);
      cell.logicalOffMs = performance.now() - cancelAt;
      assert.equal(controller.status().enabled, false);
      assert.equal(controller.record("run", "run_failed"), false);
      assert.equal(controller.status().activeExportHandle, undefined);
      cell.retainedWhileParked = {
        reservation: controller.status().payloadReservedBytes,
        binary: payload.stats().allocatedBytes,
      };
      if (
        request.schedule === "stall" &&
        ["checkpoint", "nativeWrite", "stageExport", "nativePublish"].includes(target)
      ) {
        assert.ok(cell.retainedWhileParked.reservation > 0);
        assert.ok(cell.retainedWhileParked.binary > 0);
      }
      // Observe Off's public deadline independently while the owned writer remains parked.
      cell.offOutcome = await bounded(disabling, timeoutMs + 1500, "off-deadline");
      cell.offOutcome = cell.offOutcome.ok ? cell.offOutcome.value.code : cell.offOutcome.code;
      phase = target + ":settlement";
      fault.armed = false;
      fault.release();
      await bounded(raw.waitForSettlement(), 3000, "disk-settlement-deadline");
      await until(() => activeDisk === 0 && !controller.busy && fault.outstanding === 0);
      await controller.setEnabled(false, 1);
      if (controller.status().unknownOperation) {
        value(await controller.retryCleanup());
        const unresolved = controller.status().unknownOperation;
        if (unresolved) value(await controller.acknowledgeUnknown(unresolved));
      }
      await controller.retryCleanup();
      await controller.cleanExit();
      await bounded(raw.waitForSettlement(), 3000, "cleanup-settlement-deadline");
      cell.checks.zeroReservation = controller.status().payloadReservedBytes === 0;
      cell.checks.zeroControlledBinary = payload.stats().allocatedBytes === 0;
      cell.checks.noLateDestination =
        target === "completionRecord" ? fs.existsSync(destination) : !fs.existsSync(destination);
      if (target === "completionRecord") {
        const saved = fs.readFileSync(destination);
        cell.checks.exactSavedBytes =
          saved.length === prepared.byteLength &&
          require("node:crypto").createHash("sha256").update(saved).digest("hex") === prepared.sha256;
      }
      cell.checks.writerSettled = fault.outstanding === 0 && activeDisk === 0;
      const files = fs
        .readdirSync(directory)
        .map((name) => ({ name, bytes: fs.statSync(path.join(directory, name)).size }));
      cell.ownedFilesAfterCleanup = files;
      cell.checks.noHistoryOrStage = files.every((x) => !/^(slot-|session-|export-stage)/.test(x.name));
      cell.checks.diskBound =
        files.length <= RECOVERY_LIMITS.entries &&
        files.reduce((sum, f) => sum + f.bytes, 0) <= RECOVERY_LIMITS.retainedBytes;
      cell.faultHits = fault.hits;
      cell.faultPeak = fault.peak;
      cell.diskOutstandingPeak = diskPeak;
      assert.equal(fault.hits, 1);
      assert.equal(fault.peak, 1);
      for (const check of Object.values(cell.checks)) assert.equal(check, true);
      await storage.close();
      sample();
      current = undefined;
      assert.equal(fs.readFileSync(path.join(request.base, "sentinel"), "utf8"), "synthetic unrelated file");
      if (r.regressionOnly && request.regressionStopAfter === r.cells.length) throw Error("synthetic-regression-stop");
      fs.writeFileSync(
        path.join(request.base, "progress.json"),
        JSON.stringify({ mode: request.mode, schedule: request.schedule, completed: r.cells.length, target }),
      );
    }
    phase = "execution-wait";
    r.faultCampaignElapsedMs = performance.now() - started;
    await until(() => fs.existsSync(path.join(request.base, "execution.done")), 50000);
    sampleFinalMemory();
    assert.equal(legacyCalls, 0);
    assert.equal(r.unhandledRejections, 0);
    r.ok = true;
  } catch (error) {
    exitCode = 1;
    r.ok = false;
    r.failureCode = error.message;
  } finally {
    if (current) {
      current.fault?.release();
      if (current.fault) current.fault.armed = false;
      if (current.raw) {
        try {
          await bounded(current.raw.waitForSettlement(), 3000, "failure-settlement");
          await current.storage.close();
          r.failureWriterSettled = true;
        } catch {
          r.failureWriterSettled = false;
        }
      }
    }
    // Preserve the accounting receipt even when a cell stops the campaign.
    sampleFinalMemory?.();
    clearInterval(timer);
    hook?.disable();
    clearTimeout(deadline);
    r.callbacksMs = callbacks;
    r.heartbeatGapsMs = gaps;
    r.timingDisposition =
      "4ms target deferred by owner; all observations retained; no timing pass or Layout attribution claimed";
    r.nativeElapsedMaxMs = nativeTimes;
    r.nativeOutstandingPeak = nativePeak;
    r.electron = process.versions.electron;
    r.node = process.versions.node;
    r.productionEnabled = false;
    fs.writeFileSync(path.join(request.base, "result.json"), JSON.stringify(r, null, 2));
    app.exit(exitCode);
  }
});
