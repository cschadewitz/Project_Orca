/** The Linux runner choice for app-smoke and desktop: Tyler's runners only when one is idle. */
import { describe, expect, it } from "vitest";
import { chooseLinuxRunner, HOSTED, isLinuxRunner, pickLinuxRunner, TYLER } from "../linux-runner.js";

describe("chooseLinuxRunner", () => {
  it.each([1, 2, 7])("uses Tyler's runners with %i idle", (idle) => {
    expect(chooseLinuxRunner({ body: { Project_Orca: idle } }).runner).toEqual(TYLER);
  });

  it.each([
    ["zero idle", { Project_Orca: 0 }],
    ["a negative count", { Project_Orca: -1 }],
    ["a fractional count", { Project_Orca: 1.5 }],
    ["a string count", { Project_Orca: "3" }],
    ["no count", { machines: { m1: 2 } }],
    ["no body", undefined],
    ["a non-object body", "3"],
  ])("falls back to hosted on %s", (_label, body) => {
    expect(chooseLinuxRunner({ body }).runner).toBe(HOSTED);
  });

  it("CI_FORCE_HOSTED wins over idle runners", () => {
    expect(chooseLinuxRunner({ forceHosted: true, body: { Project_Orca: 5 } }).runner).toBe(HOSTED);
  });
});

describe("pickLinuxRunner", () => {
  const ok = (body) => async () => ({ ok: true, json: async () => body });

  it("reads the health service when it has a URL", async () => {
    expect((await pickLinuxRunner({ HEALTH_URL: "https://health" }, ok({ Project_Orca: 1 }))).runner).toEqual(TYLER);
  });

  it("does not ask without a URL or when forced hosted", async () => {
    let asked = 0;
    const fetchImpl = async () => {
      asked += 1;
      return { ok: true, json: async () => ({ Project_Orca: 4 }) };
    };
    expect((await pickLinuxRunner({}, fetchImpl)).runner).toBe(HOSTED);
    expect((await pickLinuxRunner({ HEALTH_URL: "https://h", FORCE_HOSTED: "true" }, fetchImpl)).runner).toBe(HOSTED);
    expect(asked).toBe(0);
  });

  it.each([
    ["a non-200 answer", async () => ({ ok: false, json: async () => ({ Project_Orca: 4 }) })],
    ["bad JSON", async () => ({ ok: true, json: async () => JSON.parse("{") })],
    [
      "a network error",
      async () => {
        throw new Error("timeout");
      },
    ],
  ])("treats %s as zero idle", async (_label, fetchImpl) => {
    expect((await pickLinuxRunner({ HEALTH_URL: "https://health" }, fetchImpl)).runner).toBe(HOSTED);
  });
});

it("accepts only the two runner choices", () => {
  expect(isLinuxRunner(TYLER)).toBe(true);
  expect(isLinuxRunner([...TYLER])).toBe(true);
  expect(isLinuxRunner(HOSTED)).toBe(true);
  for (const other of ["ubuntu-latest", ["self-hosted", "linux", "x64", "homelab"], ["self-hosted"], "", undefined])
    expect(isLinuxRunner(other)).toBe(false);
});
