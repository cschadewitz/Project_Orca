// @vitest-environment happy-dom
/**
 * The risk mode of Plan (#172): the plan's matrix, sized by its own scale and banded by its
 * own thresholds, the appetite line, the hatched severe band, every risk labelled in place,
 * and the selected risk's detail in the docked panel.
 *
 * The issue's "done when" asks for a greyscale screenshot that still separates the severe
 * band. happy-dom takes no screenshots, so what is asserted is the thing that makes the
 * screenshot true: the severe cells carry the hatch as a `background-image`, which survives
 * the loss of hue, and no other band does.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { THEMES } from "@orca/design";
import { RiskMatrix } from "../src/ui/index.js";
import { journalAbout, mentions, risksForRail } from "../src/plan/risk-model.js";
import { riskRowId } from "../src/plan/index.js";
import { AS_OF } from "./fixtures.js";
import { JOURNAL, PLAN, PLAN_ITEMS, RISKS } from "./fixtures-plan.js";
import { harness, installBridge, renderChrome, stubMatchMedia } from "./harness.js";
import { expectedToken, inBothThemes, resolved } from "./themes.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
const teardown: (() => void)[] = [];

beforeEach(() => {
  stubMatchMedia(1440);
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

async function openRisks(script?: (fake: FakeBridge) => void): Promise<HTMLElement> {
  fake = installBridge();
  teardown.push(fake.install());
  script?.(fake);
  const h = harness();
  teardown.push(h.dispose);
  renderChrome(h);
  fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
  await screen.findByRole("grid", { name: "Schedule" });
  fireEvent.click(screen.getByRole("button", { name: "Risks" }));
  return screen.findByRole("table", { name: /Risk matrix/ });
}

const cells = (matrix: HTMLElement): HTMLElement[] => [...matrix.querySelectorAll<HTMLElement>("tbody td")];

describe("the matrix", () => {
  it("is the plan's scale squared, with every risk placed and labelled in place", async () => {
    const matrix = await openRisks();
    expect(cells(matrix)).toHaveLength(PLAN.riskMatrix.scale ** 2);

    for (const risk of RISKS) {
      const pin = within(matrix).getByRole("button", { name: new RegExp(`^${risk.key},`) });
      // The key in mono and the title in sans, on the pin itself rather than in a tooltip.
      expect(within(pin).getByText(risk.key).className).toContain("orca-text-mono-id");
      expect(pin.textContent).toContain(risk.title);
      // A pin is as wide as its cell and cut at its end (#1112), so its whole text is in its
      // title as well (rule 15).
      expect(pin.getAttribute("title")).toBe(`${risk.key} ${risk.title}`);
      // And its level in words, so the cell's colour is never the only thing saying it.
      expect(pin.getAttribute("aria-label")).toContain(risk.level);
      // Placed by likelihood (row, highest first) and impact (column).
      const row = PLAN.riskMatrix.scale - risk.likelihood;
      const cell = pin.closest("td")!;
      expect(cell.parentElement).toBe(matrix.querySelectorAll("tbody tr")[row]);
      expect([...cell.parentElement!.querySelectorAll("td")].indexOf(cell)).toBe(risk.impact - 1);
    }
  });

  it("follows a plan whose matrix is not 5×5, and bands it by the plan's thresholds", async () => {
    const matrix = await openRisks((f) =>
      f.script({
        "risks.list": () => ({
          ok: true,
          result: {
            risks: [{ ...RISKS[1]!, likelihood: 3, impact: 3, score: 9, level: "critical" }],
            matrix: { scale: 3, thresholds: { medium: 2, high: 4, critical: 6 } },
            appetite: "medium",
            asOf: AS_OF,
          },
        }),
      }),
    );
    expect(cells(matrix)).toHaveLength(9);
    const levels = cells(matrix).map((cell) => cell.getAttribute("data-level"));
    // Top row, likelihood 3: 3, 6, 9 — medium, critical, critical on this plan's cuts.
    expect(levels.slice(0, 3)).toEqual(["medium", "critical", "critical"]);
    // Appetite medium: high and critical cells are outlined, medium and low are not.
    const outlined = cells(matrix).filter((cell) => cell.classList.contains("orca-risk__appetite"));
    expect(outlined.map((cell) => cell.getAttribute("data-level")).sort()).toEqual([
      "critical",
      "critical",
      "critical",
      "high",
    ]);
  });

  it("draws the appetite line in words as well as in outline", async () => {
    const matrix = await openRisks();
    // `high` is the fixture's appetite, so only the critical cells are above it.
    for (const cell of cells(matrix)) {
      expect(cell.classList.contains("orca-risk__appetite")).toBe(cell.getAttribute("data-level") === "critical");
    }
    expect(screen.getByText(/above the plan's risk appetite \(high\)/)).toBeTruthy();
  });
});

describe("both themes, and greyscale", () => {
  const ui = (
    <RiskMatrix
      scale={PLAN.riskMatrix.scale}
      thresholds={PLAN.riskMatrix.thresholds}
      appetite={PLAN.policy.riskAppetite}
      risks={RISKS}
      onSelect={() => {}}
    />
  );

  it("binds each band to its risk token, and hatches only the severe one", () => {
    const seen = new Set<string>();
    inBothThemes(ui, ({ theme, container }) => {
      seen.add(theme);
      const tokenFor = {
        low: "risk-low",
        medium: "risk-moderate",
        high: "risk-high",
        critical: "risk-severe",
      } as const;
      for (const cell of container.querySelectorAll<HTMLElement>("tbody td")) {
        const level = cell.getAttribute("data-level") as keyof typeof tokenFor;
        expect(resolved(cell, "background-color"), `${theme} ${level}`).toBe(expectedToken(theme, tokenFor[level]));
        /* The hatch is what survives greyscale: a pattern, not a hue. Present on every
           severe cell and on no other, so the top band separates with the colour gone. */
        const hatched = resolved(cell, "background-image").includes("repeating-linear-gradient");
        expect(hatched, `${theme} ${level}`).toBe(level === "critical");
      }
    });
    expect([...seen]).toEqual([...THEMES]);
  });
});

describe("the detail, in the docked panel", () => {
  it("names itself, and shows the status, the items the risk holds and the journal about it", async () => {
    const matrix = await openRisks();
    fireEvent.click(within(matrix).getByRole("button", { name: /^key-leak,/ }));

    const detail = await screen.findByLabelText("Risk key-leak");
    expect(document.querySelector(".orca-panel .orca-pane__head")!.textContent).toContain("Risk");
    expect(detail.textContent).toContain("status open");
    expect(within(detail).getByLabelText("Holds").textContent).toContain("auth-crypto");
    // The journal entries that name it — `risk.raised` carries the risk whole — and no other.
    await waitFor(() => expect(within(detail).getByLabelText("Journal").textContent).toContain("risk.raised"));
    expect(within(detail).getByLabelText("Journal").querySelectorAll("li")).toHaveLength(1);

    // The register row is the same selection.
    const register = screen.getByRole("listbox", { name: "Risk register" });
    expect(register.getAttribute("aria-activedescendant")).toBe(riskRowId("risk-key-leak"));
  });

  it("opens a held item on the schedule", async () => {
    const matrix = await openRisks();
    fireEvent.click(within(matrix).getByRole("button", { name: /^key-leak,/ }));
    const detail = await screen.findByLabelText("Risk key-leak");
    fireEvent.click(within(within(detail).getByLabelText("Holds")).getByRole("button", { name: "auth-crypto" }));
    expect(await screen.findByLabelText("Work item auth-crypto")).toBeTruthy();
    expect(document.querySelector(".orca-panel .orca-pane__head")!.textContent).toContain("Work item");
  });
});

describe("the shared filter rail", () => {
  it("narrows the risks to the ones holding an item the rail leaves on screen", async () => {
    await openRisks();
    await screen.findByText("2 risks");
    fireEvent.click(screen.getByRole("button", { name: /^held / }));
    await screen.findByText("1 of 2 risks");
    const matrix = screen.getByRole("table", { name: /Risk matrix/ });
    expect(within(matrix).queryByRole("button", { name: /^vendor-slip,/ })).toBeNull();
    expect(within(matrix).getByRole("button", { name: /^key-leak,/ })).toBeTruthy();
  });
});

describe("the model", () => {
  it("finds a risk named anywhere in a payload, by id or by key", () => {
    expect(mentions({ a: [{ b: "risk-key-leak" }] }, new Set(["risk-key-leak"]))).toBe(true);
    expect(mentions({ a: "unrelated" }, new Set(["key-leak"]))).toBe(false);
    expect(journalAbout(JOURNAL, RISKS[0]!).map((entry) => entry.type)).toEqual(["risk.raised"]);
  });

  it("leaves every risk while the rail is clear, including one that holds nothing", () => {
    const orphan = { ...RISKS[1]!, id: "risk-orphan", affects: [] };
    expect(risksForRail([...RISKS, orphan], false, [])).toHaveLength(3);
    expect(risksForRail([...RISKS, orphan], true, PLAN_ITEMS).map((risk) => risk.key)).toEqual([
      "key-leak",
      "vendor-slip",
    ]);
  });
});
