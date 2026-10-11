// @vitest-environment happy-dom
/**
 * `ObjectId` as a person meets it: a name, then a faint kind glyph and six characters, with
 * the whole id on hover and the kind said in words to a screen reader. Geometry is not
 * asserted — happy-dom has no layout — but the classes that make the token keep its width
 * are, in `componentsCssSource`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { OBJECT_KIND_PRESENTATION } from "@orca/design";
import { MachineText, ObjectId, useIdTails } from "../src/ui/index.js";
import { componentsCssSource } from "./type-notes.js";

afterEach(cleanup);

const ITEM = "wi_01M4M899VKJZRZSBHNDY5M579G";
const RUN = "run_cae154fb-f778-47ba-ae71-bb4df6bb09e1";

describe("ObjectId", () => {
  it("leads with the name and follows it with a faint token carrying the whole id", () => {
    const { container } = render(<ObjectId id={ITEM} name="Database schema" />);
    const named = container.firstElementChild!;
    expect(named.className).toContain("orca-objid-named");
    expect(named.querySelector(".orca-objid-named__name")!.textContent).toBe("Database schema");

    const token = named.querySelector(".orca-objid")!;
    expect(token.className).toContain("orca-objid--faint");
    expect(token.className).toContain("orca-text-mono-id");
    expect(token.getAttribute("title")).toBe(ITEM);
    expect(token.querySelector(".orca-objid__kind")!.textContent).toBe(OBJECT_KIND_PRESENTATION.workItem.glyph);
    expect(token.querySelector(".orca-objid__kind")!.getAttribute("aria-hidden")).toBe("true");
    expect(token.querySelector(".orca-objid__tail")!.textContent).toBe("5M579G");
  });

  it("says the kind in words, so a control holding it is named 'run bb09e1'", () => {
    render(
      <button type="button">
        <ObjectId id={RUN} />
      </button>,
    );
    expect(screen.getByRole("button", { name: "run bb09e1" })).toBeTruthy();
  });

  it("stands alone, and not faint, when there is no name", () => {
    const { container } = render(<ObjectId id="req_01M4M896DER1YQSTMV3G5BNH42" />);
    const token = container.querySelector(".orca-objid")!;
    expect(token.className).not.toContain("--faint");
    expect(token.textContent).toBe(`${OBJECT_KIND_PRESENTATION.request.glyph}request 5BNH42`);
  });

  it("draws a list's longer tail when one is handed in, and a kind for an unprefixed id", () => {
    const { container } = render(<ObjectId id="cae154fb-f778-47ba-ae71-bb4df6bb09e1" kind="run" tail="6bb09e1" />);
    expect(container.querySelector(".orca-objid__tail")!.textContent).toBe("6bb09e1");
    expect(container.querySelector(".orca-objid__kind")!.textContent).toBe(OBJECT_KIND_PRESENTATION.run.glyph);
  });

  it("is always faint in a header, after the crumb's own label", () => {
    const { container } = render(<ObjectId id={ITEM} variant="header" />);
    expect(container.querySelector(".orca-objid")!.className).toContain("orca-objid--faint");
  });

  it("prints the id verbatim in full, with the tail lifted out of it", () => {
    const { container } = render(<ObjectId id={ITEM} variant="full" />);
    const full = container.querySelector(".orca-objid--full")!;
    expect(full.textContent).toBe(ITEM);
    expect(full.querySelector(".orca-objid__head")!.textContent).toBe("wi_01M4M899VKJZRZSBHNDY");
    expect(full.querySelector(".orca-objid__tail")!.textContent).toBe("5M579G");
    // No glyph and no hidden word: the whole id is its own name.
    expect(full.querySelector(".orca-objid__kind")).toBeNull();
  });
});

describe("MachineText", () => {
  it("draws an id token as a token, and anything else as plain mono", () => {
    const { container } = render(
      <>
        <MachineText text="⬡ 5M579G" />
        <MachineText text="auth-store-choice" />
      </>,
    );
    const [token, plain] = [...container.children];
    expect(token!.querySelector(".orca-objid__kind")!.getAttribute("aria-hidden")).toBe("true");
    expect(token!.textContent).toBe("⬡work item 5M579G");
    expect(plain!.className).toContain("orca-mono");
    expect(plain!.textContent).toBe("auth-store-choice");
  });
});

describe("useIdTails", () => {
  it("lengthens only the ids that share a tail, across the whole list it is handed", () => {
    const a = "wi_01M4M899VKJZRZSBHNDA5M579G";
    const b = "wi_01M4M899VKJZRZSBHNDB5M579G";
    const { result } = renderHook(() => useIdTails([a, b, RUN, undefined]));
    expect(result.current(a)).toBe("A5M579G");
    expect(result.current(b)).toBe("B5M579G");
    expect(result.current(RUN)).toBe("bb09e1");
    // An id the list did not hold still gets its six.
    expect(result.current(ITEM)).toBe("5M579G");
  });
});

describe("the token's box", () => {
  it("never truncates and never wraps, and a name before it is the part that gives way", () => {
    const bare = componentsCssSource.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string): string =>
      new RegExp(`(?:^|\\})\\s*${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`).exec(bare)?.[1] ?? "";
    expect(rule(".orca-objid")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".orca-objid")).toMatch(/flex:\s*none/);
    expect(rule(".orca-objid")).not.toMatch(/overflow|text-overflow/);
    expect(rule(".orca-objid-named__name")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".orca-objid-named__name")).toMatch(/min-width:\s*0/);
    expect(rule(".orca-objid--faint")).toMatch(/color:\s*var\(--ink-tertiary\)/);
  });
});
