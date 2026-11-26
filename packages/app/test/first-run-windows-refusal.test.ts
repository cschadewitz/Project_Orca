/** The Windows folder check's specific refusals reach the screen as reasons a person can act on (#1217). */
import { expect, it, vi } from "vitest";
import { refusalMessage } from "../src/main/first-run/ipc.js";
import { windowsSelectionFailure, windowsWorkspaceParent } from "../src/main/first-run/directories.js";
import { untrustedWriterReason } from "../src/first-run-windows-reasons.js";

const native = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock("@orca/protocol/first-run-fence", async (original) => {
  const actual = await original<typeof import("@orca/protocol/first-run-fence")>();
  return {
    ...actual,
    windowsDirectory: () => {
      throw Object.assign(new Error("Windows first-run identity unavailable at Z:\\private\\needle"), {
        code: native.code,
      });
    },
  };
});

const coded = (code: string) => Object.assign(new Error("native text Z:\\private\\needle"), { code });

it("names the folder and the other account when a folder in the chain can be changed by someone else", () => {
  const project = refusalMessage(windowsSelectionFailure(coded("FIRST_RUN_WINDOWS_UNTRUSTED_WRITER"), true));
  expect(project).toBe(untrustedWriterReason(true));
  expect(project).toContain("The project folder, or a folder above it, can be changed or deleted by another account.");
  expect(project).toContain("choose a folder inside your user folder");
  const workspace = refusalMessage(windowsSelectionFailure(coded("FIRST_RUN_WINDOWS_UNTRUSTED_WRITER"), false));
  expect(workspace).toContain("The app workspace folder, or a folder above it");
  for (const message of [project, workspace]) {
    expect(message).not.toContain("could not verify the selected directories");
    expect(message).not.toContain("needle");
  }
});

it("names a folder owned by another account", () => {
  expect(refusalMessage(windowsSelectionFailure(coded("FIRST_RUN_WINDOWS_NOT_OWNER"), true))).toBe(
    "The project folder is owned by another account. Choose a folder your account owns.",
  );
});

it("leaves any other native refusal to setup's generic handling", () => {
  expect(windowsSelectionFailure(coded("FIRST_RUN_WINDOWS_UNAVAILABLE"), true)).toBeUndefined();
  expect(windowsSelectionFailure(new Error("plain"), true)).toBeUndefined();
});

it("maps the workspace parent check's refusal without echoing the native text", () => {
  native.code = "FIRST_RUN_WINDOWS_UNTRUSTED_WRITER";
  let caught: unknown;
  try {
    windowsWorkspaceParent("Z:\\private\\needle");
  } catch (error) {
    caught = error;
  }
  expect(refusalMessage(caught)).toContain("The app workspace folder, or a folder above it, can be changed");
  expect(refusalMessage(caught)).not.toContain("needle");
  native.code = "FIRST_RUN_WINDOWS_UNAVAILABLE";
  expect(() => windowsWorkspaceParent("Z:\\private\\needle")).toThrow("Windows first-run identity unavailable");
});
