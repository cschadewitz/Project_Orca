/** Setup's refusals reach the screen with their reason; raw failures never do. */
import type { IpcMainInvokeEvent } from "electron";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { installFirstRunIPC, refusalMessage } from "../src/main/first-run/ipc.js";
import { FirstRunOwnershipRefusal } from "../src/main/first-run/ownership.js";
import { FirstRunRefusal, failureReason } from "../src/main/first-run/refusal.js";
import { FirstRunSetup } from "../src/main/first-run/setup.js";

it("passes setup's own refusals through and replaces anything else", () => {
  expect(refusalMessage(new FirstRunRefusal("The app workspace folder is not empty."))).toBe(
    "The app workspace folder is not empty.",
  );
  expect(refusalMessage(new FirstRunOwnershipRefusal())).toContain("Review same-boot recovery");
  const raw = refusalMessage(new Error("EACCES /home/someone/secret"));
  expect(raw).not.toContain("secret");
  expect(raw).toContain("Existing files were preserved.");
});

it("names operating system and Git failures by their code, never their text", () => {
  const git = Object.assign(new Error("fatal: not a git repository: /private/needle"), {
    code: 128,
    cmd: "git -c core.fsmonitor=false -C /private/needle rev-parse --show-toplevel",
  });
  expect(failureReason(git)).toContain("Git could not read the selected project folder");
  expect(failureReason(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT", cmd: "git -C x" }))).toContain(
    "Git was not found",
  );
  expect(failureReason(Object.assign(new Error("/private/needle"), { code: "EACCES" }))).toContain("permissions");
  expect(failureReason(new Error("anything"))).toBeUndefined();
  for (const error of [git, Object.assign(new Error("/private/needle"), { code: "EPERM" })])
    expect(failureReason(error)).not.toContain("needle");
});

async function route(held: boolean, captured: () => void = () => {}) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown, epoch: number) => unknown>();
  const setup = new FirstRunSetup({
    home: tmpdir(),
    receiptPath: "/unused/receipt.json",
    choose: async () => {
      throw new FirstRunRefusal("The project and the app workspace overlap.");
    },
    current: () => false,
    prepareConnection: async () => {
      throw new Error("unused");
    },
  });
  installFirstRunIPC(setup, {
    ipc: { handle: (channel, listener) => void handlers.set(channel, listener) },
    ready: async () => {},
    held: () => held,
    capture: () => captured,
    connect: (check) => setup.connect(check),
  });
  return handlers.get("orca:workspace.firstRun.choose")!({} as IpcMainInvokeEvent, undefined, 0);
}

it("shows the setup refusal's reason across IPC", async () => {
  expect(await route(false)).toMatchObject({
    ok: false,
    error: { message: "The project and the app workspace overlap." },
  });
});

it("says an update is being prepared instead of a generic refusal", async () => {
  expect(await route(true)).toMatchObject({ ok: false, error: { message: expect.stringContaining("app update") } });
});

it("says the window changed when the caller's capture no longer holds, without its raw text", async () => {
  const result = await route(false, () => {
    throw new Error("Project setup belongs to a previous window document");
  });
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("Read setup again") } });
  expect(JSON.stringify(result)).not.toContain("previous window document");
});
