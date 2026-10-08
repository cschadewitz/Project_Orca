// Complete dependency-free test plugin. This is the entire executable source closure.
const values = new Set(["old-model", "new-model"]);
const valid = (data) =>
  data !== null &&
  typeof data === "object" &&
  !Array.isArray(data) &&
  Object.keys(data).sort().join() === "schema,value" &&
  data.schema === 1 &&
  values.has(data.value);

const executor = (data) => ({
  type: "custom:m10-owned",
  execute: async (ctx) => {
    const result = { model: data.value, implementation: "m10-owned-v1" };
    // Only ORCA's builtin artifact port writes; no plugin file/network/process access.
    const artifact = await ctx.recordArtifact(
      { kind: "generic", name: "M10 admitted state", path: "m10-result.json", required: true },
      JSON.stringify(result),
    );
    return { kind: "completed", result: { artifactIds: [artifact.id], data: result } };
  },
});

const plugin = {
  name: "m10-owned",
  register(api) {
    // A non-secret moving default solely for #396's old/new admitted-state proof.
    // This environment variable never supplies an identity, trust pin or authority.
    const data = Object.freeze({ schema: 1, value: process.env.ORCA_M10_VALUE ?? "old-model" });
    if (!valid(data) || !api.restorationIdentity) throw new Error("M10 test composition unavailable");
    api.executors.register(executor(data));
    plugin.restoration = {
      identity: api.restorationIdentity,
      capture: () => ({ ...data }),
      validate: valid,
      restore(record, restored) {
        if (!valid(record)) throw new Error("Invalid M10 descriptor");
        restored.executors.register(executor(Object.freeze({ ...record })));
      },
    };
  },
};

export default plugin;
