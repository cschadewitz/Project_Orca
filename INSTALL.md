# Dropping this into the repo

1. Copy `AGENTS.md` to the repo root (merge it into an existing one if you have one).
2. Copy the `design/` folder to the repo root.
3. Merge `.gitattributes` into the repo's, or skip it — it only collapses the two generated
   files in PR diffs.
4. Add the three scripts to `package.json`:

   ```jsonc
   "scripts": {
     "design:build": "node design/build-tokens.mjs",
     "design:check": "node design/build-tokens.mjs --check",
     "design:test":  "node --test \"design/test/*.test.mjs\""
   }
   ```

5. Run `npm run design:build && npm run design:test` once to confirm — the build is
   deterministic, so `design:check` should report the committed files are current.
6. Add `design:check` and `design:test` to CI.
7. Optional, if you use Claude Code: a one-line `CLAUDE.md` at the root saying
   `See AGENTS.md.` keeps a single set of rules rather than two that drift.

No dependencies. The generator and the tests are plain Node (22+), `node:test` and
`node:assert` only.

Then delete this file — it is installation instructions, not part of the system.
