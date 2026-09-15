/**
 * Minimal plugin: adds a `custom:echo` node and a template. Load with
 *   plugins: ["./examples/plugin-example.ts"]   (use tsx) or the compiled .js
 */
import { completed, definePlugin } from "@orca/engine";

export default definePlugin({
  name: "example",
  register(api) {
    api.executors.register({
      type: "custom:echo",
      async execute(ctx) {
        const message = await ctx.render(String((ctx.node as unknown as { message?: string }).message ?? "hello from {{ run.id }}"));
        ctx.logger.info(message);
        return completed({ data: { message } });
      },
    });
    api.templates.registerSource("---\nid: example/greeting\n---\nSay hello to {{ workItem.title }}.");
  },
});
