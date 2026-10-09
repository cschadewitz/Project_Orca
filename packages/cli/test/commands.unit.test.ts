/** Focused unit contracts separated from the mixed suite. */
import { describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.js";

describe("the command table", () => {
  it("gives every command a help line starting with its own name", () => {
    for (const [name, command] of Object.entries(commands)) expect(command.help.startsWith(name)).toBe(true);
  });
});
