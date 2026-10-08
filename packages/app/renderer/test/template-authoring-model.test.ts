import { describe, expect, it, vi } from "vitest";
import { TemplateAuthoringController } from "../src/template-authoring/controller.js";
import {
  catalogErrors,
  exportSource,
  resolveTemplate,
  type AuthoringPorts,
  type AuthoringSnapshot,
  type TemplateAsset,
} from "../src/template-authoring/model.js";

const source =
  "---\r\nid: sdlc/review # keep comment\r\ncustom: {foo: bar}\r\nrequires: [spec]\r\n---\r\nReview {{ artifacts.spec.content }}\r\n";
const asset = (id: string, key = id): TemplateAsset => ({
  key,
  id,
  version: "1",
  requires: ["spec"],
  partials: [],
  usedBy: ["ai-sdlc::review"],
  source: { state: "available", text: source },
});
const snapshot = (): AuthoringSnapshot => ({
  target: { workspaceId: "workspace", instanceId: "boot", epoch: 1 },
  revision: "r1",
  generation: "g1",
  assets: [asset("sdlc/review"), asset("partials/context"), asset("strict/sdlc/review")],
});
const review = {
  candidateRevision: "digest-of-candidate",
  errors: [],
  compatibility: "compatible" as const,
  changes: ["Review instructions changed"],
};

function setup(overrides: Partial<AuthoringPorts> = {}) {
  const base = snapshot();
  const publish = vi.fn<NonNullable<AuthoringPorts["publish"]>>(async () => ({
    status: "saved" as const,
    candidateRevision: review.candidateRevision,
    snapshot: { ...base, revision: "r2" },
  }));
  const ports: AuthoringPorts = {
    read: async () => base,
    validate: async () => review,
    preview: async (_candidate, id, pack) => ({
      requestedId: id,
      resolvedId: pack ? `${pack}/${id}` : id,
      fallback: false,
      partialIds: [],
      text: "Sample fixture prompt",
    }),
    publish,
    ...overrides,
  };
  return { controller: new TemplateAuthoringController(base, ports), ports, publish, base };
}

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("template catalog and source", () => {
  it("resolves pack variants, missing-variant fallback, and exact-ID partial errors", () => {
    const assets = snapshot().assets;
    expect(resolveTemplate(assets, "sdlc/review", "strict")?.id).toBe("strict/sdlc/review");
    expect(resolveTemplate(assets, "sdlc/review", "missing")?.id).toBe("sdlc/review");
    expect(resolveTemplate(assets, "missing", "strict")).toBeUndefined();
    expect(catalogErrors([{ ...asset("sdlc/review"), partials: ["context"] }, asset("strict/context")])).toEqual([
      { key: "sdlc/review", code: "reference", message: "Missing exact-ID partial: context" },
    ]);
  });

  it("reports duplicate and missing IDs without silently overwriting catalog entries", () => {
    expect(catalogErrors([asset(""), asset("x"), asset("x", "other-file")]).map((error) => error.code)).toEqual([
      "missing-id",
      "duplicate-id",
    ]);
  });

  it("imports/exports exact source, comments, key order, unknown metadata and CRLF", () => {
    const { controller } = setup();
    expect(controller.exportSource("sdlc/review")).toBe(source);
    const imported = source.replace("Review", "Review carefully");
    expect(controller.importSource("sdlc/review", imported)).toBe(true);
    expect(controller.exportSource("sdlc/review")).toBe(imported);
    expect(controller.candidate().edits).toEqual([{ key: "sdlc/review", text: imported }]);
    controller.edit("sdlc/review", source);
    expect(controller.candidate().edits).toEqual([]);
  });

  it("never edits or exports withheld data even when given a forged draft", () => {
    const protectedAsset = { ...asset("hidden"), source: { state: "withheld" as const } };
    expect(exportSource(protectedAsset, [{ key: "hidden", text: "forged" }])).toBeUndefined();
    const { ports, base } = setup();
    const controller = new TemplateAuthoringController({ ...base, assets: [protectedAsset] }, ports);
    expect(controller.edit("hidden", "forged")).toBe(false);
    expect(controller.exportSource("hidden")).toBeUndefined();
    expect(controller.edit("unknown", "forged")).toBe(false);
  });
});

describe("reviewed template publication", () => {
  it("sends one publication for double activation and does not discard while pending", async () => {
    const pending = deferred<Awaited<ReturnType<NonNullable<AuthoringPorts["publish"]>>>>();
    const publish = vi.fn(() => pending.promise);
    const { controller, base } = setup({ publish });
    controller.edit("sdlc/review", "reviewed");
    await controller.validate();
    const first = controller.publish();
    await controller.publish();
    controller.discard();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(controller.exportSource("sdlc/review")).toBe("reviewed");
    pending.resolve({
      status: "saved",
      candidateRevision: review.candidateRevision,
      snapshot: { ...base, revision: "r2" },
    });
    await first;
  });

  it("invalidates a pending validation on current write authority loss", async () => {
    const pending = deferred<typeof review>();
    const { controller, base, publish } = setup({ validate: () => pending.promise });
    controller.edit("sdlc/review", "draft");
    const validation = controller.validate();
    controller.observe({ ...base, writeReason: "Read-only connection" });
    pending.resolve(review);
    await validation;
    await controller.publish();
    expect(controller.getSnapshot().review).toBeUndefined();
    expect(controller.exportSource("sdlc/review")).toBe("draft");
    expect(controller.edit("sdlc/review", "forbidden")).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
  it("requires validation and publishes the frozen exact bytes with both guards", async () => {
    const { controller, publish } = setup();
    controller.edit("sdlc/review", "changed source");
    await controller.publish();
    expect(publish).not.toHaveBeenCalled();
    await controller.validate();
    expect(publish).not.toHaveBeenCalled();
    await controller.publish();
    expect(publish).toHaveBeenCalledWith(
      {
        target: { workspaceId: "workspace", instanceId: "boot", epoch: 1 },
        expectedRevision: "r1",
        expectedGeneration: "g1",
        sequence: 1,
        edits: [{ key: "sdlc/review", text: "changed source" }],
      },
      review.candidateRevision,
    );
    expect(Object.isFrozen(publish.mock.calls[0]?.[0])).toBe(true);
    expect(controller.getSnapshot().edits).toEqual([]);
    expect(controller.getSnapshot().message).toContain("Apply is a separate");
  });

  it.each(["front-matter", "reference", "duplicate-id"] as const)(
    "blocks authoritative %s validation errors",
    async (code) => {
      const { controller, publish } = setup({
        validate: async () => ({
          ...review,
          errors: [{ key: "sdlc/review", code, message: "Fix the declared source" }],
        }),
      });
      controller.edit("sdlc/review", "bad source");
      await controller.validate();
      await controller.publish();
      expect(publish).not.toHaveBeenCalled();
      expect(controller.exportSource("sdlc/review")).toBe("bad source");
    },
  );

  it.each(["unavailable", "incompatible"] as const)("blocks %s pack compatibility", async (compatibility) => {
    const { controller, publish } = setup({ validate: async () => ({ ...review, compatibility }) });
    controller.edit("sdlc/review", "changed");
    await controller.validate();
    await controller.publish();
    expect(publish).not.toHaveBeenCalled();
  });

  it("makes publication explicitly unavailable without an injected adapter", async () => {
    const { controller, ports, base } = setup();
    const { publish: _publish, ...readPorts } = ports;
    const readOnly = new TemplateAuthoringController(base, readPorts);
    readOnly.edit("sdlc/review", "changed");
    await readOnly.validate();
    expect(readOnly.publicationReason()).toContain("unavailable");
    expect(controller.getSnapshot().base.revision).toBe("r1");
  });

  it("invalidates review on source edits and ignores stale validation responses", async () => {
    const pending = deferred<typeof review>();
    const { controller } = setup({ validate: () => pending.promise });
    controller.edit("sdlc/review", "first");
    const validation = controller.validate();
    controller.edit("sdlc/review", "newer");
    pending.resolve(review);
    await validation;
    expect(controller.getSnapshot().review).toBeUndefined();
    expect(controller.getSnapshot().busy).toBe(false);
    expect(controller.exportSource("sdlc/review")).toBe("newer");
  });

  it("removes an old successful review when revalidation fails without echoing secrets", async () => {
    const validate = vi.fn().mockResolvedValueOnce(review).mockRejectedValueOnce(new Error("private-token-value"));
    const { controller } = setup({ validate });
    controller.edit("sdlc/review", "changed");
    await controller.validate();
    await controller.validate();
    expect(controller.getSnapshot().review).toBeUndefined();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("private-token-value");
  });

  it.each(["revision", "generation", "target"])(
    "freezes drafts when %s changes and does not rebase on refresh",
    async (field) => {
      const { controller, base, publish } = setup();
      controller.edit("sdlc/review", "changed");
      await controller.validate();
      controller.observe({
        ...base,
        ...(field === "target" ? { target: { ...base.target, epoch: 2 } } : { [field]: "changed" }),
      });
      await controller.refresh();
      await controller.publish();
      expect(controller.getSnapshot().blocked).toContain("Reconcile");
      expect(controller.getSnapshot().base).toEqual(base);
      expect(controller.exportSource("sdlc/review")).toBe("changed");
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("ignores an old-target preview reply and retains the original draft", async () => {
    const pending = deferred<{
      requestedId: string;
      resolvedId: string;
      fallback: boolean;
      partialIds: string[];
      text: string;
    }>();
    const { controller, base } = setup({ preview: () => pending.promise });
    controller.edit("sdlc/review", "changed");
    const preview = controller.preview("sdlc/review", "strict", { values: {}, artifacts: {} });
    controller.observe({ ...base, target: { ...base.target, instanceId: "another-daemon" } });
    pending.resolve({
      requestedId: "sdlc/review",
      resolvedId: "strict/sdlc/review",
      fallback: false,
      partialIds: [],
      text: "obsolete",
    });
    await preview;
    expect(controller.getSnapshot().preview).toBeUndefined();
    expect(controller.getSnapshot().busy).toBe(false);
  });

  it("retains newer edits typed during save and refuses a blind second publication", async () => {
    const { base } = setup();
    const result = {
      status: "saved" as const,
      candidateRevision: review.candidateRevision,
      snapshot: { ...base, revision: "r2" },
    };
    const pending = deferred<typeof result>();
    const { controller } = setup({ publish: () => pending.promise });
    controller.edit("sdlc/review", "reviewed");
    await controller.validate();
    const save = controller.publish();
    controller.edit("sdlc/review", "newer");
    pending.resolve(result);
    await save;
    expect(controller.exportSource("sdlc/review")).toBe("newer");
    expect(controller.getSnapshot().base.revision).toBe("r1");
    expect(controller.getSnapshot().blocked).toContain("newer edits");
  });

  it.each(["conflict", "invalid", "denied"] as const)("retains drafts after %s refusal", async (status) => {
    const { controller } = setup({ publish: async () => ({ status, errors: [] }) });
    controller.edit("sdlc/review", "changed");
    await controller.validate();
    await controller.publish();
    expect(controller.exportSource("sdlc/review")).toBe("changed");
    expect(controller.getSnapshot().blocked).toBeDefined();
    expect(controller.getSnapshot().review).toBeUndefined();
  });

  it("blocks retry on lost acknowledgement without exposing the thrown payload", async () => {
    const publish = vi.fn(async () => {
      throw new Error("secret-in-error");
    });
    const { controller } = setup({ publish });
    controller.edit("sdlc/review", "changed");
    await controller.validate();
    await controller.publish();
    await controller.publish();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(controller.exportSource("sdlc/review")).toBe("changed");
    expect(controller.getSnapshot().blocked).toContain("acknowledgement was lost");
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("secret-in-error");
  });

  it("rejects acknowledgement content/generation mismatch", async () => {
    const { base } = setup();
    const { controller } = setup({
      publish: async () => ({
        status: "saved",
        candidateRevision: "different-content",
        snapshot: { ...base, generation: "g2" },
      }),
    });
    controller.edit("sdlc/review", "changed");
    await controller.validate();
    await controller.publish();
    expect(controller.getSnapshot().blocked).toContain("acknowledgement changed identity");
    expect(controller.exportSource("sdlc/review")).toBe("changed");
  });

  it("creates editable variants only through the injected derivation port", async () => {
    const variant = vi.fn(async () => ({
      key: "new-pack-review",
      text: source.replace("sdlc/review", "house/sdlc/review"),
    }));
    const { controller } = setup({ variant });
    await controller.createVariant("sdlc/review", "../unsafe");
    expect(variant).not.toHaveBeenCalled();
    await controller.createVariant("sdlc/review", "house");
    expect(controller.exportSource("new-pack-review")).toContain("house/sdlc/review # keep comment");
    expect(controller.edit("new-pack-review", "edited variant")).toBe(true);
    expect(controller.exportSource("new-pack-review")).toBe("edited variant");
    controller.discard();
    expect(controller.exportSource("new-pack-review")).toBeUndefined();
  });
});
