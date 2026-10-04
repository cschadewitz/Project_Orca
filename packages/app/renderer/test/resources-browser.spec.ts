/** Fixture-only accessibility/layout evidence. Opt into screenshot artifacts with ORCA_RESOURCE_SCREENSHOTS=1. */
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { DEFAULT_PREFERENCES } from "../../src/preferences/schema.js";

test.beforeEach(async ({ page }) => {
  // Only the existing preload bootstrap consumed by main.tsx. Any RPC is a test failure.
  await page.addInitScript((preferences) => {
    Object.defineProperty(window, "orca", {
      value: {
        platform: "linux",
        preferences: { read: () => preferences, write: () => Promise.resolve({ ok: true, result: preferences }) },
        notifications: { subscribe: () => () => {} },
        call: () => {
          throw new Error("Resource fixture attempted an RPC");
        },
      },
    });
  }, DEFAULT_PREFERENCES);
  await page.goto("/#resources");
  await expect(page.getByRole("heading", { name: "Daemon resources" })).toBeVisible();
});

async function screenshot(page: Page, name: string) {
  if (process.env.ORCA_RESOURCE_SCREENSHOTS !== "1") return;
  const height = await page.locator(".resource-preview").evaluate((node) => node.scrollHeight);
  await page.setViewportSize({ width: 1280, height });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: fileURLToPath(new URL(`./resource-screenshots/${name}.png`, import.meta.url)),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 960 });
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: all shared fixtures and access states pass axe`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption(theme);
    for (const fixture of [
      "healthy",
      "pressure",
      "partial",
      "stale",
      "tmpfs",
      "cgroup-cpu-unsupported",
      "cgroup-cpu-denied",
      "cgroup-memory-unsupported",
      "cgroup-memory-denied",
    ]) {
      await page.getByRole("combobox", { name: "Shared fixture", exact: true }).selectOption(fixture);
      expect((await new AxeBuilder({ page }).analyze()).violations, `${theme}/${fixture}`).toEqual([]);
      if (
        (theme === "light" && ["healthy", "partial", "tmpfs"].includes(fixture)) ||
        (theme === "dark" && ["pressure", "stale", "cgroup-cpu-denied"].includes(fixture))
      )
        await screenshot(page, `${fixture}-${theme}`);
    }
    for (const access of ["permission-denied", "unsupported", "unconnected"]) {
      await page.getByRole("combobox", { name: "Access gate (simulated)", exact: true }).selectOption(access);
      await expect(page.getByRole("region", { name: "Whole-machine CPU", exact: true })).toHaveCount(0);
      expect((await new AxeBuilder({ page }).analyze()).violations, `${theme}/${access}`).toEqual([]);
      if (access === "permission-denied" && theme === "dark") await screenshot(page, "denied-dark");
    }
    expect(errors).toEqual([]);
  });
}

test("keyboard, reduced motion, short/narrow scrolling, target switching and reconnection", async ({ page }) => {
  await page.getByRole("combobox", { name: "Shared fixture", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("combobox", { name: "Shared fixture", exact: true })).toHaveValue("pressure");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Workstream summary", exact: true })).toBeFocused();
  expect(
    await page
      .getByRole("combobox", { name: "Workstream summary", exact: true })
      .evaluate((el) => getComputedStyle(el).outlineStyle),
  ).not.toBe("none");
  await page.getByRole("combobox", { name: "Workstream summary", exact: true }).selectOption("partial");
  await expect(page.getByRole("region", { name: "Active ORCA workstreams", exact: true })).toContainText(
    "partial coverage",
  );
  await page.getByRole("button", { name: "Simulate disconnect", exact: true }).click();
  for (let n = 0; n < 4; n++) await page.getByRole("button", { name: "Age by 5 seconds" }).click();
  const cpu = page.getByRole("region", { name: "Whole-machine CPU", exact: true });
  await expect(cpu).toContainText("Stale");
  await expect(cpu).toContainText("age 20 s");
  await page.getByRole("button", { name: "Simulate reconnect", exact: true }).click();
  await expect(page.getByText(/Last known readings only/)).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 340 });
    const root = page.getByRole("main");
    expect(await root.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await root.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await root.focus();
    await page.keyboard.press("Control+End");
    const last = page.getByText(/Per-workstream CPU and RAM attribution/);
    await expect(last).toBeInViewport();
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    expect(
      await page
        .locator(".orca-resources *")
        .evaluateAll((els) => els.some((el) => getComputedStyle(el).animationName !== "none")),
    ).toBe(false);
  }
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.getByRole("button", { name: "Switch target", exact: true }).click();
  await expect(cpu).toHaveCount(0);
  await expect(page.getByText("Selected target: Another daemon (no fixture)")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for a resource observation" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await screenshot(page, "target-switch-dark");
  await expect(page.locator("[data-orca-announcer]")).toHaveCount(1);
});
