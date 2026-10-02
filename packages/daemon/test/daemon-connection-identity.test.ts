/** Identity is shared by transports for a boot, with stable workspace identity across boots. */
import { expect, it } from "vitest";
import { createDaemonIdentity } from "../src/daemon-identity.js";
it("allocates a boot identity once without deriving workspace identity from paths or process ids", () => {
  const first = createDaemonIdentity("workspace");
  const second = createDaemonIdentity("workspace");
  expect(first.workspaceId).toBe(second.workspaceId);
  expect(first.instanceId).not.toBe(second.instanceId);
});
