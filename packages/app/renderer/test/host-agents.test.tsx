// @vitest-environment happy-dom
/**
 * Agents on a managed server in the connection dialog (#1236): state per agent, Install showing
 * the server config, and Sign in showing the code and the page's host while main keeps the URL.
 */
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentSignInView, HostAgentView, RemoteProfilesBridge } from "../../src/daemon-connection.js";
import { HostAgents } from "../src/daemon-connection/profiles.js";

afterEach(cleanup);

function bridge(agents: HostAgentView[]) {
  let prompt: ((view: AgentSignInView) => void) | undefined;
  let finishSignIn: (() => void) | undefined;
  const state = { agents };
  const profiles = {
    list: vi.fn(async () => []),
    hostAgents: vi.fn(async () => ({ ok: true as const, value: state.agents })),
    installHostAgent: vi.fn(async (_id: string, agent: string) => {
      state.agents = state.agents.map((a) => (a.agent === agent ? { ...a, installed: true } : a));
      return { ok: true as const, value: { settings: "agents:\n  - id: codex" } };
    }),
    signInHostAgent: vi.fn(
      () =>
        new Promise<{ ok: true; value: null }>((resolve) => {
          finishSignIn = () => {
            state.agents = state.agents.map((a) => ({ ...a, signedIn: "yes" as const }));
            resolve({ ok: true, value: null });
          };
        }),
    ),
    onAgentSignIn: (listener: (view: AgentSignInView) => void) => {
      prompt = listener;
      return () => {
        prompt = undefined;
      };
    },
    openAgentSignIn: vi.fn(async () => ({ ok: true as const, value: null })),
  } as unknown as RemoteProfilesBridge;
  return { profiles, prompt: (view: AgentSignInView) => prompt?.(view), finish: () => finishSignIn?.() };
}

const codex: HostAgentView = { agent: "codex", name: "Codex", version: "0.171.0", installed: false, signedIn: "no" };

it("installs an agent and shows the server config that runs it", async () => {
  const rig = bridge([codex]);
  render(<HostAgents profiles={rig.profiles} profileId="lab" name="Lab" />);
  expect(await screen.findByText(/Codex 0\.171\.0: not installed/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  expect(await screen.findByLabelText("Server config for codex")).toBeTruthy();
  expect(rig.profiles.installHostAgent).toHaveBeenCalledWith("lab", "codex");
  expect(await screen.findByText(/Codex 0\.171\.0: not signed in/)).toBeTruthy();
});

it("signs an agent in, showing the code and the page's host, and opens the page through main", async () => {
  const rig = bridge([{ ...codex, installed: true }]);
  render(<HostAgents profiles={rig.profiles} profileId="lab" name="Lab" />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  act(() =>
    rig.prompt({ profileId: "lab", agent: "codex", attempt: "a1", host: "auth.openai.com", code: "WXYZ-12345" }),
  );
  expect(screen.getByRole("alert").textContent).toContain("WXYZ-12345");
  expect(screen.getByRole("alert").textContent).toContain("auth.openai.com");
  // A prompt for another profile is not shown here.
  act(() => rig.prompt({ profileId: "other", agent: "codex", attempt: "a2", host: "evil.example", code: "AAAA-BBBB" }));
  expect(screen.getByRole("alert").textContent).not.toContain("AAAA-BBBB");
  fireEvent.click(screen.getByRole("button", { name: "Open sign-in page" }));
  expect(rig.profiles.openAgentSignIn).toHaveBeenCalledWith("lab", "codex", "a1");
  act(() => rig.finish());
  await waitFor(() => expect(screen.getByText(/Codex 0\.171\.0: signed in/)).toBeTruthy());
  expect(screen.queryByRole("alert")).toBeNull();
});

it("says why an install that changed cannot be used, and offers nothing to run it", async () => {
  const rig = bridge([{ ...codex, problem: "It has changed since it was installed." }]);
  render(<HostAgents profiles={rig.profiles} profileId="lab" name="Lab" />);
  expect(await screen.findByText(/not usable \(It has changed since it was installed\.\)/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
});
