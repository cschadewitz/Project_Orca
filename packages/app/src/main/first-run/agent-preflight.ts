/** Local executable availability only: no shell, agent handshake, sign-in, version probe or provider operation. */
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
export type LocalToolCheck = {
  agentId: string;
  state: "missing" | "unavailable" | "architecture" | "handshake-required";
};
export async function inspectLocalTool(agent: {
  id: string;
  command: string;
  env: Record<string, string>;
}): Promise<LocalToolCheck> {
  const candidates = isAbsolute(agent.command)
    ? [agent.command]
    : agent.command.includes("/") || agent.command.includes("\\")
      ? []
      : (agent.env.PATH ?? process.env.PATH ?? "")
          .split(delimiter)
          .filter(isAbsolute)
          .slice(0, 64)
          .map((path) => join(path, agent.command));
  let state: LocalToolCheck["state"] = "missing";
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const path = await realpath(candidate);
      if (!(await lstat(path)).isFile()) {
        state = "unavailable";
        continue;
      }
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile()) {
          state = "unavailable";
          continue;
        }
        const header = Buffer.alloc(8);
        if ((await file.read(header, 0, 8, 0)).bytesRead < 4) {
          state = "unavailable";
          continue;
        }
        const magic = header.readUInt32LE(0);
        if (process.platform === "darwin" && (magic === 0xfeedfacf || magic === 0xfeedface)) {
          const cpu = header.readUInt32LE(4);
          if ((process.arch === "arm64" && cpu !== 0x100000c) || (process.arch === "x64" && cpu !== 0x1000007))
            return { agentId: agent.id, state: "architecture" };
        }
        return { agentId: agent.id, state: "handshake-required" };
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"))
        state = "unavailable";
    }
  }
  return { agentId: agent.id, state };
}
