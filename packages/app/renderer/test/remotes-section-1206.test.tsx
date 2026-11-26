// @vitest-environment happy-dom
/**
 * Remote daemons on the Config surface (#1206): offered only by a daemon that lists
 * `remotes.list`, it shows each configured remote's enrollment, and Enroll sends the host key the
 * person typed (and a credential only when they paste one) to the daemon that owns the workspace.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  RemotesListResultSchema,
  type RemotesEnrollParams,
  type RemotesListResult,
  type RemoteView,
} from "@orca/protocol";
import { RemotesSection } from "../src/config/remotes-section.js";
import { AS_OF, HELLO } from "./fixtures.js";
import { harness, installBridge } from "./harness.js";

const KEY = `SHA256:${"k".repeat(43)}`;
const remote = (over: Partial<RemoteView> = {}): RemoteView => ({
  id: "build-box",
  name: "Build box",
  destination: "ci@build.example",
  workflows: ["build"],
  pinned: [],
  jumpPinned: [],
  credentialSaved: false,
  enrollment: { state: "none" },
  ...over,
});
const listing = (remotes: RemoteView[], canIssue = true): RemotesListResult =>
  RemotesListResultSchema.parse({ remotes, canIssue });

const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const restore of restores.splice(0)) restore();
});

function show(methods: readonly string[], answer: RemotesListResult, enrolled?: RemoteView) {
  const fake = installBridge({
    connection: {
      state: "live",
      since: AS_OF,
      orcaVersion: HELLO.orcaVersion,
      capabilities: HELLO.capabilities,
      methods: [...methods],
    },
  });
  restores.push(fake.install());
  const sent: RemotesEnrollParams[] = [];
  (fake.bridge as { remotes?: unknown }).remotes = {
    list: async () => ({ ok: true, result: answer }),
    enroll: async (params: RemotesEnrollParams) => {
      sent.push(params);
      return enrolled
        ? { ok: true, result: { remote: enrolled, warnings: [] } }
        : {
            ok: false,
            error: { code: "DELEGATION_REFUSED", message: "The server of remote build-box presented another key." },
          };
    },
  };
  const { Providers } = harness();
  render(
    <Providers>
      <RemotesSection />
    </Providers>,
  );
  return { sent };
}

const BOTH = [...(HELLO.methods ?? []), "remotes.list", "remotes.enroll"];

describe("#1206 Remote daemons on the Config surface", () => {
  it("is absent from a daemon that does not list remotes.list", () => {
    show(HELLO.methods ?? [], listing([remote()]));
    expect(screen.queryByRole("region", { name: "Remote daemons" })).toBeNull();
  });

  it("says how to add one when none is configured", async () => {
    show(BOTH, listing([]));
    await waitFor(() => expect(screen.getByText(/No remotes are configured/)).toBeTruthy());
  });

  it("enrolls with the host key the person typed and shows the record the daemon answers", async () => {
    const after = remote({
      pinned: [KEY],
      enrollment: {
        state: "enrolled",
        workspaceId: "w-remote",
        principalId: "delegate-w-parent",
        credentialId: "abcdefghijkl",
        enrolledAt: "2026-11-26T06:00:00.000Z",
        issued: true,
        routeCurrent: true,
      },
    });
    const { sent } = show(BOTH, listing([remote()]), after);
    const row = await waitFor(() => screen.getByText("Build box").closest("[data-remote]") as HTMLElement);
    expect(row.dataset.enrollment).toBe("none");
    expect(within(row).getByText("not enrolled")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Enroll build-box" }));
    const form = screen.getByRole("form", { name: "Enroll remote build-box" });
    // Nothing is pinned, so the key is required before anything is sent.
    const submit = within(form).getByRole("button", { name: "Enroll remote" });
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(submit);
    expect(sent).toEqual([]);
    fireEvent.change(within(form).getByLabelText(/Host key fingerprint/), { target: { value: ` ${KEY} ` } });
    fireEvent.click(within(form).getByRole("button", { name: "Enroll remote" }));
    await waitFor(() => expect(sent).toEqual([{ id: "build-box", hostKeys: [KEY], jumpHostKeys: [] }]));
    await waitFor(() => expect(screen.getByText("enrolled")).toBeTruthy());
    expect(screen.queryByRole("form", { name: "Enroll remote build-box" })).toBeNull();
    expect(screen.getByText(KEY)).toBeTruthy();
    expect(screen.getByText(/credential abcdefghijkl issued by the remote/)).toBeTruthy();
  });

  it("shows the daemon's refusal on the form and keeps the remote not enrolled", async () => {
    show(BOTH, listing([remote()]));
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Enroll build-box" })));
    const form = screen.getByRole("form", { name: "Enroll remote build-box" });
    fireEvent.change(within(form).getByLabelText(/Host key fingerprint/), { target: { value: KEY } });
    fireEvent.click(within(form).getByRole("button", { name: "Enroll remote" }));
    await waitFor(() => expect(within(form).getByText(/presented another key/)).toBeTruthy());
    expect(screen.getByText("not enrolled")).toBeTruthy();
  });

  it("asks for a pasted credential where the daemon cannot have the remote issue one", async () => {
    const { sent } = show(BOTH, listing([remote()], false), remote({ pinned: [KEY], credentialSaved: true }));
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Enroll build-box" })));
    const form = screen.getByRole("form", { name: "Enroll remote build-box" });
    fireEvent.change(within(form).getByLabelText(/Host key fingerprint/), { target: { value: KEY } });
    const submit = within(form).getByRole("button", { name: "Enroll remote" });
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(submit.getAttribute("title")).toContain("credential");
    const token = `orca1.abcdefghijkl.${"s".repeat(43)}`;
    fireEvent.change(within(form).getByLabelText(/Credential/), { target: { value: token } });
    fireEvent.click(within(form).getByRole("button", { name: "Enroll remote" }));
    await waitFor(() =>
      expect(sent).toEqual([{ id: "build-box", hostKeys: [KEY], jumpHostKeys: [], credential: token }]),
    );
  });

  it("offers no Enroll to a daemon that lists remotes.list without remotes.enroll", async () => {
    show([...(HELLO.methods ?? []), "remotes.list"], listing([remote()]));
    await waitFor(() => expect(screen.getByText("Build box")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Enroll build-box" })).toBeNull();
  });
});
