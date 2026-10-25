// @vitest-environment happy-dom
/** Mounted ownership regressions for C7-19; the full chrome first-arming proofs live in
 * plan-graph/plan-decision. These controlled mounts exercise delayed writes and re-reads. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DecisionView, DependencyView } from "@orca/protocol";
import { DecisionMode } from "../src/plan/decision-mode.js";
import { RelationshipInspector } from "../src/plan/relationship-inspector.js";
import { AS_OF } from "./fixtures.js";
import { DECISIONS, DEPENDENCIES, PLAN_ID } from "./fixtures-plan.js";
import { harness, installBridge, stubMatchMedia } from "./harness.js";

const teardown: (() => void)[] = [];
beforeEach(() => stubMatchMedia(1440));
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

const DEPENDENCY = DEPENDENCIES[1]!;
const DECIDED: DecisionView = { ...DECISIONS[0]!, status: "decided", chosen: "redis" };

for (const kind of ["waive", "reopen"] as const) {
  describe(`${kind} confirmation focus`, () => {
    function mount() {
      const fake = installBridge();
      teardown.push(fake.install());
      const h = harness();
      teardown.push(h.dispose);
      const method: "dependencies.waive" | "decisions.reopen" =
        kind === "waive" ? "dependencies.waive" : "decisions.reopen";
      let planId = PLAN_ID;
      let nodeId = "wi-ui";
      let dependency: DependencyView | undefined = DEPENDENCY;
      let decision = DECIDED;
      let show = true;
      let waived = 0;
      const content = () => (
        <h.Providers>
          <button>Elsewhere</button>
          {show &&
            (kind === "waive" ? (
              <RelationshipInspector
                planId={planId}
                node={{
                  id: nodeId,
                  name: "auth-ui",
                  target: "item",
                  state: "open",
                }}
                blockedBy={dependency ? [dependency] : []}
                blocks={[]}
                onWaived={(next) => {
                  waived += 1;
                  dependency = next;
                  view.rerender(content());
                }}
              />
            ) : (
              <DecisionMode
                planId={planId}
                state={{ phase: "ready", decisions: [decision] }}
                decisions={[decision]}
                selectedId={decision.id}
                onSelect={() => {}}
                live
                onRetry={() => {}}
              />
            ))}
        </h.Providers>
      );
      const view = render(content());
      const trigger = () => screen.getByRole("button", { name: kind === "waive" ? "Waive auth-api…" : "Reopen…" });
      const keep = () => screen.getByRole("button", { name: kind === "waive" ? "Keep it" : "Keep the decision" });
      const confirm = () =>
        screen.getByRole("button", { name: kind === "waive" ? "Waive, unblocking auth-ui" : `Reopen ${decision.key}` });
      const region = () =>
        screen.getByLabelText(kind === "waive" ? "Relationships of auth-ui" : `Decision ${decision.key}`);
      return {
        fake,
        h,
        method,
        trigger,
        keep,
        confirm,
        region,
        elsewhere: () => screen.getByRole("button", { name: "Elsewhere" }),
        arm: () => {
          act(() => trigger().focus());
          fireEvent.click(trigger());
        },
        change: (
          change: "plan" | "selection" | "key" | "status" | "remove" | "navigation" | "dependency" | "reset",
        ) => {
          if (change === "plan") planId = "another-plan";
          if (change === "selection") {
            nodeId = "another-node";
            decision = { ...decision, id: "another-decision" };
          }
          if (change === "key") decision = { ...decision, key: "renamed" };
          if (change === "dependency") dependency = { ...DEPENDENCY, id: "another-dependency" };
          if (change === "reset") {
            dependency = DEPENDENCY;
            decision = DECIDED;
          }
          if (change === "status") {
            dependency = { ...DEPENDENCY, status: "waived", evaluation: { state: "waived", detail: "waived" } };
            decision = { ...decision, status: "open", chosen: undefined };
          }
          if (change === "remove") {
            dependency = undefined;
            decision = { ...decision, status: "open", chosen: undefined };
          }
          if (change === "navigation") show = false;
          view.rerender(content());
        },
        waived: () => waived,
        calls: () => fake.calls.filter((call) => call.method === method).map((call) => call.params),
      };
    }

    it("puts Keep first and focuses it once per arming; Escape cancels without writing", async () => {
      const m = mount();
      m.arm();
      const group = m.keep().closest<HTMLElement>('[role="group"]')!;
      expect(within(group).getAllByRole("button")[0]).toBe(m.keep());
      expect(document.activeElement).toBe(m.keep());
      act(() => m.elsewhere().focus());
      await act(async () => m.fake.connect({ ...m.fake.connection }));
      expect(document.activeElement).toBe(m.elsewhere());
      act(() => m.keep().focus());
      await act(async () => m.h.layers.closeTop());
      expect(document.activeElement).toBe(m.trigger());
      expect(m.calls()).toHaveLength(0);
      m.arm();
      expect(document.activeElement).toBe(m.keep());
    });

    it.each([false, true])("restores a refusal only if the question still holds focus (moved=%s)", async (moved) => {
      const m = mount();
      m.fake.fail(m.method, { code: "PLAN_INVALID", message: "refused" });
      const release = m.fake.hold(m.method);
      m.arm();
      act(() => m.confirm().focus());
      fireEvent.click(m.confirm());
      fireEvent.click(m.confirm());
      expect(m.calls()).toEqual([
        kind === "waive" ? { planId: PLAN_ID, dependencyId: DEPENDENCY.id } : { planId: PLAN_ID, key: DECIDED.key },
      ]);
      if (moved) act(() => m.elsewhere().focus());
      await act(async () => release());
      expect(document.activeElement).toBe(moved ? m.elsewhere() : m.trigger());
    });

    it.each([false, true])(
      "keeps successful focus in the inspector, respecting a move elsewhere (moved=%s)",
      async (moved) => {
        const m = mount();
        const release = m.fake.hold(m.method);
        m.arm();
        act(() => m.confirm().focus());
        fireEvent.click(m.confirm());
        if (moved) act(() => m.elsewhere().focus());
        await act(async () => release());
        expect(document.activeElement).toBe(moved ? m.elsewhere() : m.region());
        if (kind === "waive") expect(m.waived()).toBe(1);
        else {
          // Reopen relies on a pushed status read; success itself must not restore its trigger.
          expect(m.trigger()).toBeTruthy();
          await act(async () => m.change("status"));
          expect(document.activeElement).toBe(moved ? m.elsewhere() : m.region());
        }
      },
    );

    it.each(["status", "remove"] as const)(
      "hands focus to the inspector when a re-read withdraws the question (%s)",
      async (change) => {
        const m = mount();
        m.arm();
        await act(async () => m.change(change));
        expect(document.activeElement).toBe(m.region());
        expect(m.calls()).toHaveLength(0);
      },
    );

    it("hands a focused resting trigger to the inspector after a status change", async () => {
      const m = mount();
      act(() => m.trigger().focus());
      await act(async () => m.change("status"));
      expect(document.activeElement).toBe(m.region());
    });

    it("does not let an old refusal close a newly armed question or steal focus", async () => {
      const m = mount();
      m.fake.fail(m.method, { code: "PLAN_INVALID", message: "late refusal" });
      const release = m.fake.hold(m.method);
      m.arm();
      fireEvent.click(m.confirm());
      await act(async () => fireEvent.click(m.keep()));
      m.arm();
      const keep = m.keep();
      act(() => m.elsewhere().focus());
      await act(async () => release());
      expect(m.keep()).toBe(keep);
      expect(document.activeElement).toBe(m.elsewhere());
      expect(m.calls()).toHaveLength(1);
    });

    it("does not let a queued cancellation restore over a newer arming", async () => {
      const m = mount();
      m.arm();
      fireEvent.click(m.keep());
      m.arm();
      act(() => m.elsewhere().focus());
      await act(async () => {});
      expect(document.activeElement).toBe(m.elsewhere());
      expect(m.keep()).toBeTruthy();
    });

    it.each(
      kind === "waive"
        ? (["plan", "selection", "dependency", "navigation"] as const)
        : (["plan", "selection", "key", "navigation"] as const),
    )("ignores a late response after a target change (%s)", async (change) => {
      const m = mount();
      const release = m.fake.hold(m.method);
      m.arm();
      fireEvent.click(m.confirm());
      m.change(change);
      if (change !== "navigation") m.arm();
      act(() => m.elsewhere().focus());
      await act(async () => release());
      expect(document.activeElement).toBe(m.elsewhere());
      if (change !== "navigation") expect(m.keep()).toBeTruthy();
      expect(m.waived()).toBe(0);
      expect(m.calls()).toHaveLength(1);
    });

    it.each([false, true])("leaves a new question alone after a status cycle and a late result (ok=%s)", async (ok) => {
      const m = mount();
      if (!ok) m.fake.fail(m.method, { code: "PLAN_INVALID", message: "old status refused" });
      const release = m.fake.hold(m.method);
      m.arm();
      fireEvent.click(m.confirm());
      await act(async () => m.change("status"));
      await act(async () => m.change("reset"));
      m.arm();
      const keep = m.keep();
      await act(async () => release());
      expect(m.keep()).toBe(keep);
      expect(document.activeElement).toBe(keep);
      expect(m.waived()).toBe(0);
    });

    it("preserves a completed write after Keep without refocusing a person elsewhere", async () => {
      const m = mount();
      const release = m.fake.hold(m.method);
      m.arm();
      fireEvent.click(m.confirm());
      await act(async () => fireEvent.click(m.keep()));
      act(() => m.elsewhere().focus());
      await act(async () => release());
      expect(document.activeElement).toBe(m.elsewhere());
      expect(m.calls()).toHaveLength(1);
      if (kind === "waive") expect(m.waived()).toBe(1);
    });

    it("retains writability and method-presence guards", async () => {
      const m = mount();
      const live = m.fake.connection;
      m.arm();
      await act(async () => m.fake.connect({ ...live, state: "disconnected", since: AS_OF }));
      expect(m.confirm().getAttribute("aria-disabled")).toBe("true");
      expect(m.confirm().title).toBe("no daemon is answering");
      fireEvent.click(m.confirm());
      expect(m.calls()).toHaveLength(0);
      await act(async () =>
        m.fake.connect({ ...live, methods: (live.methods ?? []).filter((name) => name !== m.method) }),
      );
      expect(screen.queryByRole("button", { name: kind === "waive" ? "Keep it" : "Keep the decision" })).toBeNull();
      expect(m.calls()).toHaveLength(0);
      act(() => m.elsewhere().focus());
      await act(async () => m.fake.connect(live));
      expect(screen.queryByRole("button", { name: kind === "waive" ? "Keep it" : "Keep the decision" })).toBeNull();
      expect(document.activeElement).toBe(m.elsewhere());
      expect(m.trigger()).toBeTruthy();
    });
  });
}
