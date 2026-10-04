/** The MCP CLI helper requires an explicit authenticated daemon connection. */
import { expect, it } from "vitest";
import { mcpCommand } from "../src/commands/mcp.js";
it("requires explicit endpoint and credential rather than discovering an owner credential", async () => {
  await expect(mcpCommand({}, {})).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  await expect(mcpCommand({ endpoint: "http://localhost:6722" }, {})).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  await expect(mcpCommand({ endpoint: "http://remote:6722" }, { ORCA_MCP_TOKEN: "explicit" })).rejects.toMatchObject({
    code: "CONFIG_INVALID",
  });
});
