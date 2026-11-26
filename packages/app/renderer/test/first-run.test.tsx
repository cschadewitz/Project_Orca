// @vitest-environment happy-dom
/** Directory review controls and safe refusal handling, with no automatic setup, provider or launch. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FirstRunAgentCheck, FirstRunBridge, FirstRunStatus } from "../../src/first-run-contract.js";
import { FIRST_RUN_SAMPLE } from "../../src/first-run-sample.js";
import { FirstRunSection } from "../src/first-run/first-run-section.js";
import { useEscapeClosesTopLayer } from "../src/layers-context.js";
import { fakeBridge } from "./fake-bridge.js";
import { harness } from "./harness.js";
const teardown: (() => void)[] = [];
/** The one global `Esc`, which the chrome registers in the app and a section test must add. */
function Escape(): null {
  useEscapeClosesTopLayer();
  return null;
}
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});
function setup(overrides: Partial<FirstRunBridge> = {}) {
  const fake = fakeBridge();
  let state: FirstRunStatus = { state: "selection-required", reason: "Explicit owned directories required." };
  const firstRun = {
    status: vi.fn<FirstRunBridge["status"]>(async () => ({ ok: true, result: state })),
    choose: vi.fn<FirstRunBridge["choose"]>(async () => {
      state = {
        state: "review",
        review: {
          id: "main-review",
          project: "/Sample α",
          workspace: "/App β",
          branch: "prepared",
          baseCommit: "base",
          sample: FIRST_RUN_SAMPLE,
        },
      };
      return { ok: true, result: state };
    }),
    prepare: vi.fn<FirstRunBridge["prepare"]>(async () => {
      state = { state: "prepared", project: "/Sample α", workspace: "/App β", sample: FIRST_RUN_SAMPLE };
      return { ok: true, result: state };
    }),
    connect: vi.fn<FirstRunBridge["connect"]>(async () => ({ ok: true, result: state })),
  } satisfies FirstRunBridge;
  Object.assign(firstRun, overrides);
  Object.assign(fake.bridge, { firstRun });
  teardown.push(fake.install());
  const h = harness();
  teardown.push(h.dispose);
  render(
    <h.Providers>
      <Escape />
      <FirstRunSection />
    </h.Providers>,
  );
  return { firstRun, h, fake };
}
it("requires explicit directory review, create and connect actions, and labels the remaining coding/provider gates", async () => {
  const f = setup();
  await screen.findByText("Explicit owned directories required.");
  expect(f.firstRun.choose).not.toHaveBeenCalled();
  expect(f.firstRun.prepare).not.toHaveBeenCalled();
  expect(f.firstRun.connect).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose project and empty workspace" })));
  expect(screen.getByLabelText("Selected directories").textContent).toContain("Project/Sample α");
  expect(screen.getByText(/orca-beta-local-check/)).toBeTruthy();

  expect(f.firstRun.prepare).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create reviewed sample files" })));
  expect(f.firstRun.prepare).toHaveBeenCalledExactlyOnceWith("main-review");
  expect(f.firstRun.connect).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect selected local workspace" })));
  expect(f.firstRun.connect).toHaveBeenCalledTimes(1);
  expect(
    screen.getByText(/The beta-first-job-v1 coding task and a real local-agent run require separate/),
  ).toBeTruthy();
});
it("keeps the selected review after a refused write and shows the reason main gave", async () => {
  const f = setup();
  await screen.findByText("Explicit owned directories required.");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose project and empty workspace" })));
  f.firstRun.prepare.mockResolvedValueOnce({
    ok: false,
    error: { code: "AGENT_TRANSPORT", message: "Main reason needle." },
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create reviewed sample files" })));
  expect(screen.getByText(/Setup was refused/)).toBeTruthy();
  expect(screen.getByText("Main reason needle.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create reviewed sample files" })).toBeTruthy();
  expect(f.firstRun.connect).not.toHaveBeenCalled();
});

it("keeps keyboard focus in the section when choosing directories replaces the Choose button", async () => {
  const f = setup();
  await screen.findByText("Explicit owned directories required.");
  const choose = screen.getByRole("button", { name: "Choose project and empty workspace" });
  choose.focus();
  expect(document.activeElement).toBe(choose);
  await act(async () => fireEvent.click(choose));
  expect(f.firstRun.choose).toHaveBeenCalledOnce();
  // The review step renders its own Choose button; the one that held focus is gone.
  expect(choose.isConnected).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "First-run project setup" }));
  // And from the review step, Create replaces the step again without dropping focus.
  const create = screen.getByRole("button", { name: "Create reviewed sample files" });
  create.focus();
  await act(async () => fireEvent.click(create));
  expect(create.isConnected).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "First-run project setup" }));
});

it("reviews Windows private child creation before passing the exact review to main", async () => {
  const f = setup();
  f.firstRun.choose.mockResolvedValueOnce({
    ok: true,
    result: {
      state: "review",
      review: {
        id: "windows-review",
        project: "C:\\Project",
        workspace: "C:\\Parent\\orca-workspace-new",
        branch: "prepared",
        baseCommit: "base",
        sample: FIRST_RUN_SAMPLE,
        creation: { parent: "C:\\Parent", kind: "private-child" },
      },
    },
  });
  await screen.findByText("Explicit owned directories required.");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose project and empty workspace" })));
  expect(screen.getByText("C:\\Parent")).toBeTruthy();
  expect(screen.getByText(/Existing parent and project permissions stay unchanged/)).toBeTruthy();
  expect(f.firstRun.prepare).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Create reviewed private workspace and sample files" })),
  );
  expect(f.firstRun.prepare).toHaveBeenCalledExactlyOnceWith("windows-review");
  expect(f.firstRun.connect).not.toHaveBeenCalled();
});

it("requires explicit recovery preparation and reconciliation without connecting or resuming work", async () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const prepared: FirstRunStatus = {
    state: "prepared",
    project: "/Sample α",
    workspace: "/App β",
    sample: FIRST_RUN_SAMPLE,
  };
  const prepareRecovery = vi.fn(async () => ({
    ok: true as const,
    result: { state: "recovery" as const, recovery: { state: "ready" as const, requestId } },
  }));
  const reconcileRecovery = vi.fn(async () => ({ ok: true as const, result: prepared }));
  const f = setup({ status: async () => ({ ok: true, result: prepared }), prepareRecovery, reconcileRecovery });
  await screen.findByRole("button", { name: "Review same-boot recovery" });
  expect(prepareRecovery).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Review same-boot recovery" })));
  expect(prepareRecovery).toHaveBeenCalledOnce();
  expect(screen.getByText(/Recovery checks exclusive ownership/)).toBeTruthy();
  expect(reconcileRecovery).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reconcile same-boot ownership" })));
  expect(reconcileRecovery).toHaveBeenCalledExactlyOnceWith(requestId);
  expect(f.firstRun.connect).not.toHaveBeenCalled();
});
it("reviews executable availability and requires explicit saved-config binding without provider execution", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const reviewConfiguration = vi.fn(async () => ({
    ok: true as const,
    result: {
      state: "configuration-review" as const,
      review: {
        id,
        revision: "synthetic revision",
        agentCount: 1,
        checks: [toolCheck("missing")],
      },
    },
  }));
  const bindConfiguration = vi.fn(async () => ({
    ok: true as const,
    result: { state: "prepared" as const, project: "/Sample α", workspace: "/App β", sample: FIRST_RUN_SAMPLE },
  }));
  const f = setup({ reviewConfiguration, bindConfiguration });
  await screen.findByRole("button", { name: "Review saved configuration for reopening" });
  expect(reviewConfiguration).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Review saved configuration for reopening" })),
  );
  expect(screen.getByText(/Executable missing from the app PATH/)).toBeTruthy();
  expect(bindConfiguration).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Bind reviewed saved configuration" })));
  expect(bindConfiguration).toHaveBeenCalledExactlyOnceWith(id);
  expect(f.firstRun.connect).not.toHaveBeenCalled();
});
it("shows fixed recovery instructions while withholding arbitrary native error text", async () => {
  const f = setup();
  await screen.findByText("Explicit owned directories required.");
  f.firstRun.choose.mockResolvedValueOnce({
    ok: false,
    error: {
      code: "AGENT_TRANSPORT",
      message: "Local startup ownership requires reconciliation. private secret needle",
    },
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose project and empty workspace" })));
  expect(screen.getByText(/Review same-boot recovery, then reconcile when the owned writer has exited/)).toBeTruthy();
  expect(screen.queryByText(/private secret needle/)).toBeNull();
});

describe("marking the previous session ended after a restart", () => {
  const attemptId = "33333333-3333-4333-8333-333333333333";
  const prepared: FirstRunStatus = {
    state: "prepared",
    project: "/Sample α",
    workspace: "/App β",
    sample: FIRST_RUN_SAMPLE,
  };
  const previousBoot = (endPreviousSession: NonNullable<FirstRunBridge["endPreviousSession"]>) =>
    setup({
      status: async () => ({
        ok: true,
        result: { state: "recovery", recovery: { state: "previous-boot", attemptId } },
      }),
      endPreviousSession,
    });
  const key = (name: string) => fireEvent.keyDown(document.activeElement ?? window, { key: name, code: name });
  const trigger = () => screen.getByRole("button", { name: "Mark previous session ended" });
  const arm = async () => {
    act(() => trigger().focus());
    await act(async () => fireEvent.click(trigger()));
    return within(screen.getByRole("group", { name: "Mark the previous session ended?" }));
  };

  it("asks on its own row, Keep first and focused, and sends nothing until Confirm", async () => {
    const endPreviousSession = vi.fn(async () => ({ ok: true as const, result: prepared }));
    const f = previousBoot(endPreviousSession);
    await screen.findByText("The last session ended without closing cleanly, before this computer restarted.");
    // The same-boot actions do not apply to it.
    expect(screen.queryByRole("button", { name: "Reconcile same-boot ownership" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review same-boot recovery" })).toBeNull();
    const group = await arm();
    const [keep, confirm] = group.getAllByRole("button");
    expect(keep!.textContent).toBe("Keep");
    expect(document.activeElement).toBe(keep);
    expect(confirm!.textContent).toBe("✕ Confirm previous session ended");
    expect(confirm!.className).toContain("orca-btn--danger");
    expect(screen.getByText(/This cannot be undone/)).toBeTruthy();
    expect(f.h.layers.top()?.name).toBe("previous-session-confirm");
    key("Escape");
    expect(f.h.layers.depth).toBe(0);
    expect(document.activeElement).toBe(trigger());
    await act(async () => fireEvent.click((await arm()).getByRole("button", { name: "Keep" })));
    expect(document.activeElement).toBe(trigger());
    expect(screen.queryByRole("group", { name: "Mark the previous session ended?" })).toBeNull();
    expect(endPreviousSession).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click((await arm()).getByRole("button", { name: "Confirm previous session ended" })),
    );
    expect(endPreviousSession).toHaveBeenCalledExactlyOnceWith(attemptId);
    expect(screen.getByText(/Previous session marked ended/)).toBeTruthy();
    // The row left with focus in it: focus goes to the setup region, never the page body.
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "First-run project setup" }));
    expect(screen.getByRole("button", { name: "Connect selected local workspace" })).toBeTruthy();
    expect(f.firstRun.connect).not.toHaveBeenCalled();
  });

  it("keeps the question after a refusal and shows the reason main gave beside its own guidance", async () => {
    const endPreviousSession = vi.fn(async () => ({
      ok: false as const,
      error: { code: "AGENT_TRANSPORT" as const, message: "Main reason needle." },
    }));
    previousBoot(endPreviousSession);
    await screen.findByRole("button", { name: "Mark previous session ended" });
    await act(async () =>
      fireEvent.click((await arm()).getByRole("button", { name: "Confirm previous session ended" })),
    );
    expect(endPreviousSession).toHaveBeenCalledOnce();
    expect(screen.getByText(/The previous session was not marked ended/)).toBeTruthy();
    expect(screen.getByText("Main reason needle.")).toBeTruthy();
    expect(document.activeElement).toBe(trigger());
  });
});

function toolCheck(state: FirstRunAgentCheck["state"]): FirstRunAgentCheck {
  return {
    agentId: "local",
    state,
    evidence: {
      configuredRoute: "codex-acp-candidate",
      support: "unknown",
      version: "unknown",
      architecture: state === "architecture" ? "mismatch" : "unknown",
      acp: "not-checked",
      signIn: "unknown",
      exactCommand: "unsupported",
    },
  };
}
function configReview(state: FirstRunAgentCheck["state"] = "handshake-required"): FirstRunStatus {
  return {
    state: "configuration-review",
    review: {
      id: "review-handle",
      revision: "saved revision",
      agentCount: 1,
      checks: [toolCheck(state)],
    },
  };
}
function pendingStatus() {
  let resolve!: (result: Awaited<ReturnType<FirstRunBridge["status"]>>) => void;
  const promise = new Promise<Awaited<ReturnType<FirstRunBridge["status"]>>>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
it.each([
  ["missing", /set the approved executable to an absolute path/],
  ["unavailable", /Check the configured path, file access and runtime prerequisites/],
  ["architecture", /Select an approved matching build in Config/],
  ["handshake-required", /Executable file observed/],
] as const)(
  "shows actionable %s recovery while retaining unknown compatibility and the exact-command hold",
  async (state, recovery) => {
    setup({ status: async () => ({ ok: true, result: configReview(state) }), bindConfiguration: vi.fn() });
    await screen.findByText(recovery);
    expect(screen.getByText(/Agent\/version support: unknown. Installed version: unknown/)).toBeTruthy();
    expect(screen.getByText(/ACP: not checked. Sign-in: unknown/)).toBeTruthy();
    expect(screen.getByText(/Exact-command approval: unsupported \(#594\)/)).toBeTruthy();
    expect(screen.getByText(/If sign-in is required or expired, use the provider's own sign-in flow/)).toBeTruthy();
    expect(screen.getByText(/installed identity is unverified/)).toBeTruthy();
  },
);
it.each([
  [{ state: "pinned", version: "0.171.0" } as const, /match Codex 0\.171\.0, a build ORCA pinned/],
  [{ state: "unpinned" } as const, /not a Codex build ORCA pinned for this platform, so ORCA will not start it/],
  [{ state: "unreadable" } as const, /could not be read to the end/],
])("labels the Codex app-server driver experimental and shows its caveats and pin (%o)", async (pin, pinText) => {
  const check = toolCheck("handshake-required");
  const review = configReview();
  if (review.state !== "configuration-review") throw new Error("unreachable");
  review.review.checks = [
    { ...check, evidence: { ...check.evidence, configuredRoute: "codex-app-server-candidate", codexPin: pin } },
  ];
  setup({ status: async () => ({ ok: true, result: review }), bindConfiguration: vi.fn() });
  await screen.findByText(/driver: codex-app-server, which is experimental and not yet available/);
  expect(screen.getByText(/ORCA refuses to open a session on it until the route is qualified/)).toBeTruthy();
  expect(screen.getByText(/sign in with `codex login` yourself/)).toBeTruthy();
  expect(screen.getByText(pinText)).toBeTruthy();
  // the caveats come with the driver, before anyone relies on it
  const caveats = screen.getByText(/^Experimental\./);
  expect(caveats.textContent).toMatch(/a unix socket, a local\s+port or a named pipe/);
  expect(caveats.textContent).toMatch(/lets a call through\s+when the hook fails/);
  expect(caveats.textContent).toMatch(/Cancelling a turn does not prove a running command stopped/);
});
it("shows no Codex app-server caveats for another route", async () => {
  setup({ status: async () => ({ ok: true, result: configReview() }), bindConfiguration: vi.fn() });
  await screen.findByText(/Executable file observed/);
  expect(screen.queryByText(/^Experimental\./)).toBeNull();
  expect(screen.queryByText(/Codex pin:/)).toBeNull();
});
it("cancels a configuration review without binding or connecting and restores section focus", async () => {
  const cancelConfigurationReview = vi.fn(async () => ({
    ok: true as const,
    result: { state: "selection-required" as const, reason: "Saved selection retained." },
  }));
  const bindConfiguration = vi.fn();
  const f = setup({
    status: async () => ({ ok: true, result: configReview() }),
    cancelConfigurationReview,
    bindConfiguration,
  });
  const cancel = await screen.findByRole("button", { name: "Cancel configuration review" });
  cancel.focus();
  await act(async () => fireEvent.click(cancel));
  expect(cancelConfigurationReview).toHaveBeenCalledOnce();
  expect(bindConfiguration).not.toHaveBeenCalled();
  expect(f.firstRun.connect).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Bind reviewed saved configuration" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "First-run project setup" }));
  expect(screen.getByText(/Configuration review cancelled/)).toBeTruthy();
});
it("retires stale evidence on failed rereview, shows the reason and permits explicit retry", async () => {
  const reviewConfiguration = vi
    .fn<NonNullable<FirstRunBridge["reviewConfiguration"]>>()
    .mockResolvedValueOnce({ ok: false, error: { code: "AGENT_TRANSPORT", message: "Main reason needle." } })
    .mockResolvedValueOnce({ ok: true, result: configReview("missing") });
  const bindConfiguration = vi.fn();
  setup({ status: async () => ({ ok: true, result: configReview() }), reviewConfiguration, bindConfiguration });
  const review = await screen.findByRole("button", { name: "Review saved configuration for reopening" });
  await act(async () => fireEvent.click(review));
  expect(screen.getByText(/Configuration review could not complete/)).toBeTruthy();
  expect(screen.getByText("Main reason needle.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Bind reviewed saved configuration" })).toBeNull();
  await act(async () => fireEvent.click(review));
  expect(screen.getByText(/Executable missing from the app PATH/)).toBeTruthy();
  expect(bindConfiguration).not.toHaveBeenCalled();
});
it.each(["initial", "workspace"])("retires a queued %s status review before its render commits", async (read) => {
  const status = pendingStatus();
  const readStatus = vi.fn<FirstRunBridge["status"]>(() => status.promise);
  if (read === "workspace") readStatus.mockResolvedValueOnce({ ok: true, result: configReview() });
  const reviewConfiguration = vi.fn<NonNullable<FirstRunBridge["reviewConfiguration"]>>().mockResolvedValue({
    ok: false,
    error: { code: "AGENT_TRANSPORT", message: "Main reason needle." },
  });
  const bindConfiguration = vi.fn();
  const f = setup({ status: readStatus, reviewConfiguration, bindConfiguration });
  if (read === "workspace") {
    await screen.findByRole("button", { name: "Bind reviewed saved configuration" });
    await act(async () => {
      await f.fake.bridge.workspace.connectLive();
    });
  }
  const review = screen.getByRole("button", { name: "Review saved configuration for reopening" });
  await act(async () => {
    status.resolve({ ok: true, result: configReview() });
    // Run the status continuation, queuing its state update without committing a new handler yet.
    await status.promise;
    expect(screen.queryByRole("button", { name: "Bind reviewed saved configuration" })).toBeNull();
    fireEvent.click(review);
  });
  expect(reviewConfiguration).toHaveBeenCalledOnce();
  expect(screen.getByText(/Configuration review could not complete/)).toBeTruthy();
  expect(screen.getByText("Main reason needle.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Bind reviewed saved configuration" })).toBeNull();
  expect(screen.queryByText(/Executable file observed/)).toBeNull();
  expect(bindConfiguration).not.toHaveBeenCalled();
});
it("ignores a pending status review that completes after a failed rereview", async () => {
  const status = pendingStatus();
  const reviewConfiguration = vi
    .fn<NonNullable<FirstRunBridge["reviewConfiguration"]>>()
    .mockResolvedValueOnce({ ok: false, error: { code: "AGENT_TRANSPORT", message: "Main reason needle." } })
    .mockResolvedValueOnce({ ok: true, result: configReview("missing") });
  const bindConfiguration = vi.fn();
  setup({ status: () => status.promise, reviewConfiguration, bindConfiguration });
  const review = screen.getByRole("button", { name: "Review saved configuration for reopening" });
  await act(async () => fireEvent.click(review));
  await act(async () => status.resolve({ ok: true, result: configReview() }));
  expect(screen.getByText(/Configuration review could not complete/)).toBeTruthy();
  expect(screen.getByText("Main reason needle.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Bind reviewed saved configuration" })).toBeNull();
  expect(screen.queryByText(/Executable file observed/)).toBeNull();
  await act(async () => fireEvent.click(review));
  expect(screen.getByText(/Executable missing from the app PATH/)).toBeTruthy();
  expect(reviewConfiguration).toHaveBeenCalledTimes(2);
  expect(bindConfiguration).not.toHaveBeenCalled();
});
it("ignores a late configuration review after the workspace changes", async () => {
  let finish!: (result: Awaited<ReturnType<NonNullable<FirstRunBridge["reviewConfiguration"]>>>) => void;
  const reviewConfiguration = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<NonNullable<FirstRunBridge["reviewConfiguration"]>>>>((resolve) => {
        finish = resolve;
      }),
  );
  const f = setup({ reviewConfiguration, bindConfiguration: vi.fn() });
  await screen.findByText("Explicit owned directories required.");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Review saved configuration for reopening" })),
  );
  await act(async () => {
    await f.fake.bridge.workspace.connectLive();
  });
  await act(async () => {
    finish({ ok: true, result: configReview() });
  });
  expect(screen.queryByRole("button", { name: "Bind reviewed saved configuration" })).toBeNull();
  expect(screen.queryByText(/Executable file observed/)).toBeNull();
});

it("preserves ownership reconciliation guidance when configuration review is refused", async () => {
  const reviewConfiguration = vi.fn<NonNullable<FirstRunBridge["reviewConfiguration"]>>().mockResolvedValue({
    ok: false,
    error: { code: "AGENT_TRANSPORT", message: "Local startup ownership requires reconciliation. private needle" },
  });
  setup({ reviewConfiguration });
  const review = await screen.findByRole("button", { name: "Review saved configuration for reopening" });
  await act(async () => fireEvent.click(review));
  expect(screen.getByText(/Review same-boot recovery, then reconcile when the owned writer has exited/)).toBeTruthy();
  expect(screen.queryByText(/private needle/)).toBeNull();
});

it("keeps an uncertain binding outcome explicit and requires fresh review before retry", async () => {
  const bindConfiguration = vi.fn<NonNullable<FirstRunBridge["bindConfiguration"]>>().mockResolvedValue({
    ok: false,
    error: { code: "AGENT_TRANSPORT", message: "Main reason needle." },
  });
  setup({ status: async () => ({ ok: true, result: configReview() }), bindConfiguration });
  const bind = await screen.findByRole("button", { name: "Bind reviewed saved configuration" });
  await act(async () => fireEvent.click(bind));
  expect(screen.getByText(/Configuration binding could not be confirmed/)).toBeTruthy();
  expect(screen.getByText("Main reason needle.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Bind reviewed saved configuration" })).toBeNull();
});
