// @vitest-environment happy-dom
/** Keep both the Vitest adapter and appearance-style windows on Happy DOM's safe defaults. */
import { get, createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Window as HappyWindow } from "happy-dom";
import { describe, expect, it } from "vitest";

describe.each(["Vitest adapter", "standalone window"])("Happy DOM defaults: %s", (kind) => {
  const page = () => (kind === "Vitest adapter" ? (window as unknown as HappyWindow) : new HappyWindow());

  it("does not evaluate classic scripts, modules or inline event handlers", async () => {
    const win = page();
    const root = win.document.createElement("section");
    try {
      expect(win.happyDOM.settings.enableJavaScriptEvaluation).toBe(false);
      for (const type of ["text/javascript", "module"]) {
        const script = win.document.createElement("script");
        script.type = type;
        script.textContent = 'document.documentElement.setAttribute("data-script-evaluated", "yes")';
        root.appendChild(script);
      }
      const button = win.document.createElement("button");
      button.setAttribute("onclick", 'document.documentElement.setAttribute("data-script-evaluated", "yes")');
      root.appendChild(button);
      win.document.body.appendChild(root);
      button.click();
      await win.happyDOM.waitUntilComplete();
      expect(win.document.documentElement.hasAttribute("data-script-evaluated")).toBe(false);
    } finally {
      root.remove();
      win.document.documentElement.removeAttribute("data-script-evaluated");
      if (kind === "standalone window") await win.happyDOM.close();
    }
  }, 2_000);

  it("does not request external stylesheets, CSS preloads or iframe pages", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.end("fixture");
    });
    const win = page();
    const root = win.document.createElement("section");
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const origin = `http://127.0.0.1:${address.port}`;
      // Prove the recorder is reachable without enabling any Happy DOM loading setting.
      await new Promise<void>((resolve, reject) => {
        get(`${origin}/ready`, (response) => {
          response.resume();
          response.on("end", resolve);
        }).on("error", reject);
      });
      expect(win.happyDOM.settings.enableCSSFileLoading).toBe(false);
      expect(win.happyDOM.settings.enableIframePageLoading).toBe(false);
      root.innerHTML = `<link rel="stylesheet" href="${origin}/style.css">
        <link rel="preload" as="style" href="${origin}/preload.css">
        <iframe src="${origin}/frame"></iframe>`;
      const refused: string[] = [];
      for (const element of root.querySelectorAll("link, iframe")) {
        element.addEventListener("error", (event) => {
          refused.push(element.tagName);
          event.preventDefault();
        });
      }
      win.document.body.appendChild(root);
      await win.happyDOM.waitUntilComplete();
      // Let queued I/O reach the local recorder; the test and cleanup are bounded.
      await delay(50);
      expect(requests).toEqual(["/ready"]);
      expect(refused.sort()).toEqual(["IFRAME", "LINK"]);
      expect(root.querySelector("link")?.sheet).toBeNull();
    } finally {
      root.remove();
      if (kind === "standalone window") await win.happyDOM.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 2_000);
});
