/** Refresh ordering only. Reuses #734's explicit synthetic source/approval assumptions;
 * real live delivery/lease/event algorithms, unchanged unqualified service, no protected Save proof.
 */
import fs from "node:fs";
import { expect, it, vi, type MockInstance } from "vitest";
import type { OrcaEventInput, PolicyPortV1 } from "@orca/core";
import { memoryStores } from "@orca/store";
import { askHumanInput, type HumanInputQuery } from "../src/human-input.js";
import { assertOriginalDelivery, LiveHumanInput, readOriginalDelivery } from "../src/live-input.js";
import { ownedServiceFixture } from "./fixtures/owned-file-service.js";

it.skipIf(process.platform !== "linux").each(["success", "lost"] as const)(
  "refreshed completion waits for the original outer lease acknowledgement (%s)",
  async (acknowledgement) => {
    const f = await ownedServiceFixture();
    const binding = await f.binding();
    const identity = binding.snapshot.invocation;
    const live = new LiveHumanInput(identity.instanceId),
      events = memoryStores().events;
    let releaseAck!: () => void, ackEntered!: () => void;
    const ack = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      ackEntered = resolve;
    });
    let query!: HumanInputQuery;
    const asked = askHumanInput({
      port: live,
      clock: f.base.clock,
      runId: identity.runId,
      stepRunId: identity.stepRunId,
      kind: "permission",
      question: "Read the original owned bytes once?",
      options: ["once", "deny"],
      emit: (event) => events.append({ ...event, runId: identity.runId } as OrcaEventInput),
      live: {
        identity: {
          instanceId: identity.instanceId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          invocationId: identity.invocationId,
        },
        signal: binding.owner.signal,
        withOwnership: async (work) => {
          const result = await binding.owner.withOwnership(work);
          ackEntered();
          await ack; // Original callback resolved; final outer lease acknowledgement is still pending.
          if (acknowledgement === "lost") throw new Error("outer lease acknowledgement lost");
          return result;
        },
        emitOwned: (event) => events.append({ ...event, runId: identity.runId } as OrcaEventInput),
      },
      onRequested: (value) => {
        query = value;
      },
    });
    void asked.catch(() => undefined);
    let answering: ReturnType<LiveHumanInput["answer"]> | undefined;
    let reads: MockInstance<typeof fs.readSync> | undefined;
    try {
      await expect.poll(() => Boolean(query)).toBe(true);
      const delivery = live.retainOriginalDelivery(query);
      let originalActionId = "",
        freshEvaluations = 0;
      const policy: PolicyPortV1 = {
        ...binding.policy,
        evaluate: async (action, signal) => {
          if (action.actionId !== originalActionId) {
            freshEvaluations++;
            // Same synchronous settled-delivery requirement as the real protected producer's current(entry).
            assertOriginalDelivery(delivery, query);
          }
          return binding.policy.evaluate(action, signal);
        },
      };
      const original = f.service.capture(binding.owner, f.parameters, policy, f.base.evidence);
      originalActionId = original.action.actionId;
      const actor = { principalId: identity.principalRef, credentialId: "synthetic-original-credential" };
      original.bindHumanInput(delivery, query, actor, "once");
      expect(await original.evaluate(f.base.caller.signal)).toMatchObject({
        phase: "final",
        verdict: { outcome: "require-human" },
      });
      await f.save(original.action); // Existing lower-level helper; no installed/protected qualification is claimed.
      binding.snapshot.authority.currentPolicyRevision = (await f.store.read()).revision;
      const fresh = f.service.refreshPolicyRevision(original);
      expect(fresh.action.coverage).toMatchObject({
        level: "policy-per-ask",
        evidence: { installedRefs: [], independentlyObservedEffects: false },
      });
      expect(fresh.action.offeredChoices).toEqual([]);
      reads = vi.spyOn(fs, "readSync");
      answering = live.answer(
        {
          target: {
            ...query.live!.identity,
            runId: query.runId,
            stepRunId: query.stepRunId,
            requestId: query.requestId,
          },
          optionId: "once",
        },
        {
          actor,
          authorize: async () => {
            binding.owner.assertCurrent(fresh.action);
          },
        },
      );
      void answering.catch(() => undefined);
      await entered;
      expect(await asked).toBe("once");
      const completion = fresh.completeHumanDelivery(f.base.caller.signal);
      let settled = false;
      void completion.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve)); // Drain real in-memory ownership/store continuations.
      expect(freshEvaluations).toBe(0);
      expect(settled).toBe(false);
      releaseAck();
      if (acknowledgement === "lost") {
        await expect(answering).rejects.toThrow("outer lease acknowledgement lost");
        await expect(readOriginalDelivery(delivery, query, actor, "once")).rejects.toThrow();
      } else {
        expect(await answering).toMatchObject({ delivered: true });
        expect((await readOriginalDelivery(delivery, query, actor, "once")).acceptedAnswerRef).toBeTruthy();
      }
      // Successful acknowledgement reaches the existing unqualified gate, not positive Save/read acceptance.
      await expect(completion).rejects.toThrow();
      await expect(fresh.completeHumanDelivery(f.base.caller.signal)).rejects.toThrow();
      expect(freshEvaluations).toBe(0);
      expect(f.base.state.authWrites).toBe(0);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      releaseAck();
      live.close();
      f.dispose();
      await asked.catch(() => undefined);
      await answering?.catch(() => undefined);
      reads?.mockRestore();
    }
  },
);
