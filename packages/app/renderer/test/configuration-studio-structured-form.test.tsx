// @vitest-environment happy-dom
/** #333 controls in both themes with injected authoritative fixtures; shared routes and YAML lowering are not mocked as shipped. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type JSX } from "react";
import { THEMES } from "@orca/design";
import { StructuredForm, type StructuredFormProps } from "../src/config/structured-form/structured-form.js";
import { ChangePreview } from "../src/config/structured-form/change-preview.js";
import { projectEdits } from "../src/config/structured-form/collection-model.js";
import type { EditIntent, FieldShape, FieldMetadata } from "../src/config/structured-form/contracts.js";
import { harness, type Harness } from "./harness.js";
import { useEscapeClosesTopLayer } from "../src/layers-context.js";
import { expectedToken, installDesignSystem, resolved, setTheme } from "./themes.js";

const meta: FieldMetadata = {
  acceptsAbsent: true,
  acceptsNull: false,
  visibility: "non-secret",
  default: { state: "none" },
};
const scalar = (type: "string" | "number" | "boolean" = "string"): Extract<FieldShape, { kind: "scalar" }> => ({
  ...meta,
  kind: "scalar",
  field: { path: "fixture", type, required: false },
});
const object = (fields: Record<string, FieldShape>): FieldShape => ({ ...meta, kind: "object", fields });
const union: FieldShape = {
  ...meta,
  kind: "union",
  discriminator: "type",
  branches: {
    local: object({ type: scalar(), id: scalar(), command: scalar() }),
    ssh: object({ type: scalar(), id: scalar(), hostname: scalar() }),
  },
};
let h: Harness | undefined;
afterEach(() => {
  cleanup();
  h?.dispose();
  h = undefined;
});
function renderForm(shape: FieldShape, initial: unknown, additions: Partial<StructuredFormProps> = {}) {
  h = harness();
  const Providers = h.Providers;
  const onEdit = vi.fn<(edits: readonly EditIntent[]) => void>();
  let current = initial;
  function Subject(): JSX.Element {
    useEscapeClosesTopLayer();
    const [value, setValue] = useState(initial);
    return (
      <StructuredForm
        shape={shape}
        value={value}
        path={["fixture"]}
        label="Fixture"
        errors={[]}
        access={() => ({ allowed: true })}
        rowKey={(_path, index) => {
          // Explicit fixture identity: unlike an index key, it follows the original item.
          const item = Array.isArray(value) ? (value[index] as { id?: string }) : undefined;
          return item?.id ?? `new-${index}`;
        }}
        onEdit={(edits) => {
          onEdit(edits);
          current = (projectEdits(value === undefined ? {} : { fixture: value }, edits) as { fixture?: unknown })
            .fixture;
          setValue(current);
        }}
        {...additions}
      />
    );
  }
  const result = render(
    <Providers>
      <Subject />
    </Providers>,
  );
  return { ...result, onEdit, current: () => current };
}
/** Keep the same mounted Union while copied values, schema and paths arrive from its parent. */
function renderVariantReview() {
  h = harness();
  const Providers = h.Providers;
  const onEdit = vi.fn<(edits: readonly EditIntent[]) => void>();
  const access = vi.fn<StructuredFormProps["access"]>(() => ({ allowed: true }));
  const value = { type: "local", id: "h", command: "tool", extension: { nested: [false, 0, "", null] } };
  let props: StructuredFormProps = {
    shape: union,
    value,
    path: ["fixture"],
    label: "Fixture",
    errors: [],
    access,
    onEdit,
    rowKey: (_path, index) => String(index),
  };
  const view = () => (
    <Providers>
      <StructuredForm {...props} />
    </Providers>
  );
  const result = render(view());
  return {
    value,
    onEdit,
    access,
    rerender: (changes: Partial<StructuredFormProps>) => {
      props = { ...props, ...changes };
      result.rerender(view());
    },
  };
}
function chooseVariant() {
  fireEvent.click(screen.getByRole("button", { name: "Fixture variant" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "ssh" }));
}
const input = (label: string): HTMLInputElement =>
  screen.getByLabelText<HTMLInputElement>(new RegExp(`^${label}fixture`));

describe.each(THEMES)("structured forms in %s", (theme) => {
  it.each([{}, ["PRIVATE_SCALAR_CONTENT"]])("does not coerce malformed scalar %j into display text", (value) => {
    const form = renderForm(scalar(), value);
    expect(input("Fixture").value).toBe("");
    expect(form.current()).toBe(value);
    expect(form.onEdit).not.toHaveBeenCalled();
    expect(form.container.textContent).not.toContain("PRIVATE_SCALAR_CONTENT");
  });

  it("creates empty host/agent collections and role bindings without unused defaults", () => {
    installDesignSystem();
    setTheme(theme);
    const root = object({
      hosts: {
        ...meta,
        kind: "array",
        item: union,
        default: { state: "available", value: [{ id: "local", type: "local" }] },
      },
      agents: {
        ...meta,
        kind: "array",
        item: object({
          id: scalar(),
          host: scalar(),
          unused: { ...scalar(), default: { state: "available", value: "unused default" } },
        }),
      },
      roles: { ...meta, kind: "record", value: scalar() },
    });
    const form = renderForm(root, {});
    setTheme(theme);
    fireEvent.click(screen.getByRole("button", { name: "Create hosts" }));
    fireEvent.click(screen.getByRole("button", { name: "Add hosts entry" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "local" }));
    const hosts = screen.getByRole("group", { name: "hosts" });
    fireEvent.change(within(hosts).getByLabelText(/^idfixture/), { target: { value: "local" } });
    expect(resolved(within(hosts).getByLabelText(/^idfixture/), "border-top-color")).toBe(
      expectedToken(theme, "border-control"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Add agents entry" }));
    const agents = screen.getByRole("group", { name: "agents" });
    fireEvent.change(within(agents).getByLabelText(/^idfixture/), { target: { value: "worker" } });
    fireEvent.change(within(agents).getByLabelText(/^hostfixture/), { target: { value: "local" } });
    fireEvent.click(screen.getByRole("button", { name: "Create roles" }));
    fireEvent.change(screen.getByLabelText(/^New roles key/), { target: { value: "developer" } });
    fireEvent.click(screen.getByRole("button", { name: "Add roles key" }));
    fireEvent.change(screen.getByLabelText(/^developerfixture/), { target: { value: "worker" } });
    expect(form.current()).toEqual({
      hosts: [{ type: "local", id: "local" }],
      agents: [{ id: "worker", host: "local" }],
      roles: { developer: "worker" },
    });
    expect(form.container.querySelectorAll("[aria-live]")).toHaveLength(0);
  });
  it("distinguishes null from absence, empty strings, false and zero", () => {
    const shape = object({
      text: { ...scalar(), acceptsNull: true, default: { state: "available", value: "fallback" } },
      flag: scalar("boolean"),
      count: scalar("number"),
    });
    const form = renderForm(shape, { text: "hello", flag: true, count: 1 });
    fireEvent.change(input("text"), { target: { value: "" } });
    expect(form.current()).toEqual({ text: "", flag: true, count: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Set fixture.text to null" }));
    expect(form.current()).toEqual({ text: null, flag: true, count: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Remove fixture.text" }));
    fireEvent.click(screen.getByRole("button", { name: "flag fixture.flag" }));
    fireEvent.change(input("count"), { target: { value: "0" } });
    expect(form.current()).toEqual({ flag: false, count: 0 });
    expect(screen.getByText(/Default when absent: "fallback"/)).toBeTruthy();
  });
  it("uses independently authoritative requiredness, including required nullable fields", () => {
    renderForm(
      {
        ...scalar(),
        acceptsAbsent: false,
        acceptsNull: true,
        field: { path: "fixture", type: "string", required: false },
      },
      null,
    );
    expect(screen.queryByRole("button", { name: "Remove fixture" })).toBeNull();
    fireEvent.change(input("Fixture"), { target: { value: "explicit" } });
    expect(screen.getByRole("button", { name: "Set fixture to null" })).toBeTruthy();
  });
  it("requires review before union removal, preserves extensions and cancels without mutation", () => {
    const form = renderForm(union, { type: "local", id: "h", command: "tool", extension: true });
    fireEvent.click(screen.getByRole("button", { name: "Fixture variant" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "ssh" }));
    expect(form.onEdit).not.toHaveBeenCalled();
    expect(screen.getAllByText("fixture.command").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel variant change" }));
    expect(form.onEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fixture variant" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "ssh" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm variant change" }));
    expect(form.current()).toEqual({ type: "ssh", id: "h", extension: true });
    expect(input("hostname").value).toBe("");
  });
});

describe("pending variant review identity", () => {
  it("confirms the exact reviewed batch after copied/reordered input, preserving common fields and nested extensions", () => {
    const form = renderVariantReview();
    chooseVariant();
    const proposed = form.access.mock.calls
      .map(([edits]) => edits)
      .filter((edits) => edits.some((edit) => edit.kind === "remove" && edit.path.at(-1) === "command"));
    expect(proposed.length).toBeGreaterThan(0);
    form.rerender({
      shape: structuredClone(union),
      path: ["fixture"],
      value: {
        extension: structuredClone(form.value.extension),
        command: "tool",
        id: "h",
        type: "local",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm variant change" }));
    expect(form.onEdit).toHaveBeenCalledOnce();
    const confirmed = form.onEdit.mock.calls[0]![0];
    expect(proposed).toContain(confirmed);
    expect(confirmed).toEqual([
      { kind: "remove", path: ["fixture", "command"] },
      { kind: "set", path: ["fixture", "type"], value: "ssh" },
    ]);
    expect(projectEdits({ fixture: form.value }, confirmed)).toEqual({
      fixture: { type: "ssh", id: "h", extension: { nested: [false, 0, "", null] } },
    });
    // A delayed parent update cannot leave the already-consumed confirmation available.
    expect(screen.queryByRole("button", { name: "Confirm variant change" })).toBeNull();
  });
  it.each(["draft", "extension", "path", "schema"])(
    "invalidates %s changes permanently, including after a revert",
    (change) => {
      const form = renderVariantReview();
      chooseVariant();
      const changes: Partial<StructuredFormProps> =
        change === "path"
          ? { path: ["other"] }
          : change === "schema"
            ? {
                shape: {
                  ...union,
                  branches: {
                    ...union.branches,
                    ssh: object({ type: scalar(), id: scalar(), hostname: scalar(), command: scalar() }),
                  },
                },
              }
            : {
                value: {
                  ...form.value,
                  ...(change === "draft" ? { command: "new" } : { extension: { nested: [true, 0, "", null] } }),
                },
              };
      form.rerender(changes);
      expect(screen.queryByRole("button", { name: "Confirm variant change" })).toBeNull();
      form.rerender({ value: structuredClone(form.value), shape: structuredClone(union), path: ["fixture"] });
      expect(screen.queryByRole("button", { name: "Confirm variant change" })).toBeNull();
      expect(form.onEdit).not.toHaveBeenCalled();
    },
  );
  it("invalidates a moved row review instead of applying its old paths to a different row", () => {
    const form = renderForm({ ...meta, kind: "array", item: union }, [
      { type: "local", id: "a", command: "first" },
      { type: "local", id: "b", command: "second" },
    ]);
    fireEvent.click(screen.getAllByRole("button", { name: "Fixture entry variant" })[0]!);
    fireEvent.click(screen.getByRole("menuitem", { name: "ssh" }));
    expect(screen.getByRole("button", { name: "Confirm variant change" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move fixture[1] up" }));
    expect(screen.queryByRole("button", { name: "Confirm variant change" })).toBeNull();
    expect(form.current()).toEqual([
      { type: "local", id: "b", command: "second" },
      { type: "local", id: "a", command: "first" },
    ]);
    expect(form.onEdit).toHaveBeenCalledExactlyOnceWith([{ kind: "move", path: ["fixture"], from: 1, to: 0 }]);
  });
  it("rechecks access at the click even without an intervening render", () => {
    const form = renderVariantReview();
    chooseVariant();
    const confirm = screen.getByRole("button", { name: "Confirm variant change" });
    form.access.mockReturnValue({ allowed: false, reason: "Synthetic authority revoked." });
    fireEvent.click(confirm);
    expect(form.onEdit).not.toHaveBeenCalled();
  });
  it("keeps cancellation final through copied rerenders", () => {
    const form = renderVariantReview();
    chooseVariant();
    fireEvent.click(screen.getByRole("button", { name: "Cancel variant change" }));
    form.rerender({ value: structuredClone(form.value), shape: structuredClone(union) });
    expect(screen.queryByRole("button", { name: "Confirm variant change" })).toBeNull();
    expect(form.onEdit).not.toHaveBeenCalled();
  });
});

describe("environment maps with secret references (#335)", () => {
  const opaque: FieldShape = {
    ...meta,
    acceptsAbsent: "metadata-unavailable",
    acceptsNull: "metadata-unavailable",
    visibility: "metadata-unavailable",
    kind: "unsupported",
    reason: "opaque",
  };
  const env: FieldShape = { ...meta, kind: "record", value: opaque, valueKind: "env" };
  const choices = { referenceChoices: () => ["db-password", "gh-token"] };
  it("never draws a literal and replaces it with a picked reference", () => {
    const form = renderForm(env, { TOKEN: "SYNTHETIC_LITERAL_VALUE", DB: { secret: "db-password" } }, choices);
    expect(form.container.textContent).not.toContain("SYNTHETIC_LITERAL_VALUE");
    expect(form.container.textContent).toContain("Literal value withheld");
    const db = screen.getByLabelText<HTMLSelectElement>(/^DB secret/);
    expect(db.value).toBe("db-password");
    const token = screen.getByLabelText<HTMLSelectElement>(/^TOKEN secret/);
    expect(token.value).toBe("");
    fireEvent.change(token, { target: { value: "gh-token" } });
    expect(form.current()).toEqual({ TOKEN: { secret: "gh-token" }, DB: { secret: "db-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete fixture.DB" }));
    expect(form.current()).toEqual({ TOKEN: { secret: "gh-token" } });
  });
  it("adds variables only as references to known secrets", () => {
    const form = renderForm(env, {}, choices);
    const add = () => screen.getByRole("button", { name: "Add Fixture variable" });
    fireEvent.change(screen.getByLabelText(/^New Fixture variable$|^New Fixture variablefixture/), {
      target: { value: "GITHUB_TOKEN" },
    });
    expect(add().getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(screen.getByLabelText(/^New Fixture variable secret/), { target: { value: "gh-token" } });
    fireEvent.click(add());
    expect(form.current()).toEqual({ GITHUB_TOKEN: { secret: "gh-token" } });
    expect(form.container.querySelectorAll("input[type=password]")).toHaveLength(0);
  });
  it("marks a reference to a secret the draft no longer defines", () => {
    renderForm(env, { TOKEN: { secret: "removed" } }, choices);
    expect(screen.getByRole("option", { name: "removed (unavailable reference)" })).toBeTruthy();
  });
  it("asks for a secret definition when the draft has none", () => {
    renderForm(env, {}, { referenceChoices: () => [] });
    expect(screen.getByText(/Define a secret under secrets first/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Fixture variable" }).getAttribute("aria-disabled")).toBe("true");
  });
  it("leaves an environment map opaque to a form without the hint", () => {
    const form = renderForm({ ...env, valueKind: undefined }, { TOKEN: "SYNTHETIC_LITERAL_VALUE" }, choices);
    expect(form.container.textContent).not.toContain("SYNTHETIC_LITERAL_VALUE");
    expect(form.container.querySelector("select")).toBeNull();
  });
});
describe("authority, redaction, validation and keyboard boundaries", () => {
  it.each([
    { visibility: "withheld" as const },
    { visibility: "metadata-unavailable" as const },
    { acceptsAbsent: "metadata-unavailable" as const },
    { acceptsNull: "metadata-unavailable" as const },
  ])("gates the active union branch before reading its descendants: %j", (gate) => {
    // Original review #545 repro: a safe child must not bypass its ancestor's gate.
    const form = renderForm(
      {
        ...meta,
        kind: "union",
        discriminator: "type",
        branches: {
          private: { ...meta, ...gate, kind: "object", fields: { payload: scalar() } },
        },
      },
      { type: "private", payload: "SYNTHETIC_PRIVATE_VALUE" },
    );
    expect(form.container.querySelector("input")).toBeNull();
    expect(form.container.textContent).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    expect(form.onEdit).not.toHaveBeenCalled();
  });
  it("returns focus to a remaining record entry and then the new-key flow after deletion", () => {
    const form = renderForm({ ...meta, kind: "record", value: scalar() }, { first: "a", second: "b" });
    const first = screen.getByRole("button", { name: "Delete fixture.first" });
    first.focus();
    fireEvent.click(first);
    expect(document.activeElement).toBe(input("second"));
    const second = screen.getByRole("button", { name: "Delete fixture.second" });
    second.focus();
    fireEvent.click(second);
    expect(form.current()).toEqual({});
    expect(document.activeElement).toBe(screen.getByLabelText(/^New Fixture key/));
  });
  it("restores array focus to reference selectors after reorder and deletion", () => {
    const form = renderForm(
      { ...meta, kind: "array", item: { ...scalar(), acceptsAbsent: false } },
      ["first", "second"],
      { referenceChoices: () => ["first", "second"] },
    );
    const move = screen.getByRole("button", { name: "Move fixture[1] up" });
    move.focus();
    fireEvent.click(move);
    expect(form.current()).toEqual(["second", "first"]);
    expect(document.activeElement).toBe(screen.getAllByRole("combobox")[0]);
    const remove = screen.getByRole("button", { name: "Delete fixture[0]" });
    remove.focus();
    fireEvent.click(remove);
    expect(form.current()).toEqual(["first"]);
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });
  it("restores record focus to a remaining reference selector after deletion", () => {
    renderForm(
      { ...meta, kind: "record", value: { ...scalar(), acceptsAbsent: false } },
      { first: "worker-a", second: "worker-b" },
      { referenceChoices: () => ["worker-a", "worker-b"] },
    );
    const remove = screen.getByRole("button", { name: "Delete fixture.first" });
    remove.focus();
    fireEvent.click(remove);
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });
  it("places authorized field errors using ConfigField accessibility wiring", () => {
    const form = renderForm(
      object({ host: scalar() }),
      { host: "local" },
      { errors: [{ path: ["fixture", "host"], message: "Host is used by agents[0].host." }] },
    );
    const host = input("host");
    expect(host.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(host.getAttribute("aria-describedby")!)?.textContent).toContain("agents[0].host");
    expect(form.container.querySelectorAll('[role="alert"], [aria-live]')).toHaveLength(0);
  });
  it("withholds values/defaults/enums/help for sensitive and unknown metadata", () => {
    const form = renderForm(
      object({
        secret: {
          ...scalar(),
          visibility: "withheld",
          default: { state: "available", value: "secret-default" },
          field: { type: "enum", path: "secret", required: false, enum: ["secret-choice"], help: "secret-help" },
        },
        unsupported: { ...scalar(), visibility: "metadata-unavailable" },
      }),
      { secret: "secret-current", unsupported: "secret-unknown" },
    );
    expect(form.container.textContent).not.toMatch(
      /secret-default|secret-choice|secret-help|secret-current|secret-unknown/,
    );
    expect(form.container.querySelectorAll("input")).toHaveLength(0);
    render(<ChangePreview changes={[{ path: ["secret"], kind: "set" }]} />);
    expect(screen.getByRole("region", { name: "Configuration change preview" }).textContent).toContain(
      "Values are withheld",
    );
  });
  it("explains missing permission on focusable controls and swallows edits", () => {
    const form = renderForm({ ...meta, kind: "array", item: scalar() }, ["value"], {
      access: () => ({ allowed: false, reason: "Current daemon is read-only." }),
    });
    const button = screen.getByRole("button", { name: "Delete fixture[0]" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.title).toBe("Current daemon is read-only.");
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.change(screen.getByLabelText(/^Fixture entryfixture/), { target: { value: "changed" } });
    expect(form.onEdit).not.toHaveBeenCalled();
  });
  it("blocks duplicate and ambiguous record keys and keeps original extension entries", () => {
    const form = renderForm(
      { ...meta, kind: "record", value: scalar() },
      { existing: "value", "legacy.key": "preserve" },
    );
    const key = screen.getByLabelText(/^New Fixture key/);
    fireEvent.change(key, { target: { value: "existing" } });
    expect(key.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    fireEvent.change(key, { target: { value: "__proto__" } });
    expect(screen.getByRole("button", { name: "Add key" }).getAttribute("aria-disabled")).toBe("true");
    expect(form.current()).toEqual({ existing: "value", "legacy.key": "preserve" });
    expect(screen.queryByRole("button", { name: 'Delete fixture["legacy.key"]' })).toBeNull();
  });
  it("refuses structured key edits for a key rule this app does not know (#335)", () => {
    const form = renderForm({ ...meta, kind: "record", value: scalar(), keyFormat: "^(a+)+$" }, { existing: "value" });
    expect(form.container.textContent).toContain("This key requires authorized raw editing.");
    expect(screen.queryByRole("button", { name: "Delete fixture.existing" })).toBeNull();
    fireEvent.change(screen.getByLabelText(/^New Fixture key/), { target: { value: "aaaa" } });
    expect(screen.getByRole("button", { name: "Add key" }).getAttribute("aria-disabled")).toBe("true");
    expect(form.current()).toEqual({ existing: "value" });
  });
  it("retains row focus through reorder when integration supplies stable identity", () => {
    const form = renderForm({ ...meta, kind: "array", item: object({ id: scalar() }) }, [
      { id: "first" },
      { id: "second" },
    ]);
    const move = screen.getByRole("button", { name: "Move fixture[1] up" });
    const secondField = screen.getAllByLabelText<HTMLInputElement>(/^idfixture/)[1]!;
    secondField.focus();
    fireEvent.click(move);
    expect(document.activeElement).toBe(secondField);
    expect(form.current()).toEqual([{ id: "second" }, { id: "first" }]);
    fireEvent.click(screen.getByRole("button", { name: "Delete fixture[1]" }));
    expect(form.current()).toEqual([{ id: "second" }]);
    expect(document.activeElement).toBe(secondField);
    fireEvent.click(screen.getByRole("button", { name: "Delete fixture[0]" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add Fixture entry" }));
  });
  it("uses the existing Menu keyboard contract for variant selection and Escape restoration", () => {
    const form = renderForm(union, undefined);
    const trigger = screen.getByRole("button", { name: "Fixture variant" });
    fireEvent.click(trigger);
    const local = screen.getByRole("menuitem", { name: "local" });
    expect(document.activeElement).toBe(local);
    fireEvent.keyDown(local, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "ssh" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(form.onEdit).not.toHaveBeenCalled();
  });
  it("blocks unavailable metadata and opaque unions instead of flattening or replacing them", () => {
    const raw = vi.fn();
    renderForm(
      { ...meta, kind: "unsupported", reason: "metadata-unavailable" },
      { future: "extension" },
      { onShowRaw: raw },
    );
    fireEvent.click(screen.getByRole("button", { name: "Open authorized raw view" }));
    expect(raw).toHaveBeenCalledWith(["fixture"]);
    expect(screen.queryByRole("button", { name: "Remove fixture" })).toBeNull();
  });
});

describe("agent policy fields say what absence means (#1109)", () => {
  it("says the native hook is off when absent and how to opt in", () => {
    renderForm(scalar(), undefined, { path: ["agents", 0, "nativeToolHook"], label: "nativeToolHook" });
    expect(screen.getByText(/Off when absent: no native pre-tool hook\. experimental opts this agent in/)).toBeTruthy();
  });

  it("explains tool-call records under an agent, and nothing on other fields", () => {
    renderForm(scalar(), undefined, { path: ["agents", 2, "diagnostics", "toolCalls"], label: "toolCalls" });
    expect(screen.getByText(/keep needs nativeToolHook: experimental/)).toBeTruthy();
    cleanup();
    h?.dispose();
    renderForm(scalar(), undefined, { path: ["hosts", 0, "nativeToolHook"], label: "nativeToolHook" });
    expect(screen.queryByText(/Off when absent/)).toBeNull();
  });
});
