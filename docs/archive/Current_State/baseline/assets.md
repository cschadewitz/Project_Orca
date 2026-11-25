# Authoring and generated-asset inventory

Prompt Markdown is an executable input but its natural-language body was not read during independent investigation. This table records frontmatter only. Existing explanatory documentation and diagrams remain excluded until the baseline checkpoint.

| Template file | Frontmatter identifier / declarations |
| --- | --- |
| [templates/partials/upstream-context.md](../../templates/partials/upstream-context.md) | id: partials/upstream-context<br>name: Upstream work items this item depends on |
| [templates/partials/work-item-context.md](../../templates/partials/work-item-context.md) | id: partials/work-item-context<br>name: Work item context block |
| [templates/program/assess-risks.md](../../templates/program/assess-risks.md) | id: program/assess-risks<br>name: Program - risk assessment across the breakdown<br>requires: [decomposition]<br>produces: risk-register |
| [templates/program/decide.md](../../templates/program/decide.md) | id: program/decide<br>name: Program - decision matrix for one open decision<br>produces: decision-matrix |
| [templates/program/decompose.md](../../templates/program/decompose.md) | id: program/decompose<br>name: Program - decompose a request into work items<br>produces: decomposition |
| [templates/program/summary.md](../../templates/program/summary.md) | id: program/summary<br>name: Program - final summary<br>requires: [decomposition] |
| [templates/sdlc/build.md](../../templates/sdlc/build.md) | id: sdlc/build<br>name: Build stage - plan then implement<br>requires: [spec]<br>produces: implementation |
| [templates/sdlc/deploy.md](../../templates/sdlc/deploy.md) | id: sdlc/deploy<br>name: Deploy stage - open the PR and hand to CI/CD<br>requires: [implementation, review]<br>produces: deploy-report |
| [templates/sdlc/design.md](../../templates/sdlc/design.md) | id: sdlc/design<br>name: Design stage - requirements and design spec<br>requires: [intent]<br>produces: spec |
| [templates/sdlc/plan.md](../../templates/sdlc/plan.md) | id: sdlc/plan<br>name: Plan stage - capture intent<br>produces: intent |
| [templates/sdlc/review.md](../../templates/sdlc/review.md) | id: sdlc/review<br>name: Review stage - agentic PR review<br>requires: [spec, implementation, test-report]<br>produces: review |
| [templates/sdlc/test.md](../../templates/sdlc/test.md) | id: sdlc/test<br>name: Test stage - run the feedback loop<br>requires: [spec, implementation]<br>produces: test-report |
| [templates/strict/sdlc/review.md](../../templates/strict/sdlc/review.md) | id: strict/sdlc/review<br>name: Review stage - strict review (template pack "strict")<br>requires: [spec, implementation, test-report]<br>produces: review |

## Binary and rendered assets

Paths only; no prior architecture diagrams were opened and no rendering behavior was assumed. Existing design artwork is excluded from independent evidence; generated font/source relationships are established by their build script, not visual inspection.

- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-dark-type-proof-darwin.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-dark-type-proof-darwin.png) — path inventoried only.
- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-dark-type-proof-linux.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-dark-type-proof-linux.png) — path inventoried only.
- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-dark-type-proof-win32.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-dark-type-proof-win32.png) — path inventoried only.
- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-light-type-proof-darwin.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-light-type-proof-darwin.png) — path inventoried only.
- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-light-type-proof-linux.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-light-type-proof-linux.png) — path inventoried only.
- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-light-type-proof-win32.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-bundled-light-type-proof-win32.png) — path inventoried only.
- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-dark-type-proof-darwin.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-dark-type-proof-darwin.png) — path inventoried only.
- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-dark-type-proof-linux.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-dark-type-proof-linux.png) — path inventoried only.
- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-dark-type-proof-win32.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-dark-type-proof-win32.png) — path inventoried only.
- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-light-type-proof-darwin.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-light-type-proof-darwin.png) — path inventoried only.
- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-light-type-proof-linux.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-light-type-proof-linux.png) — path inventoried only.
- [packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-light-type-proof-win32.png](../../packages/app/test/smoke/type-proof.spec.ts-snapshots/type-fallback-light-type-proof-win32.png) — path inventoried only.
- [packages/design/fonts/IBMPlexMono-Medium.woff2](../../packages/design/fonts/IBMPlexMono-Medium.woff2) — path inventoried only.
- [packages/design/fonts/IBMPlexMono-Regular.woff2](../../packages/design/fonts/IBMPlexMono-Regular.woff2) — path inventoried only.
- [packages/design/fonts/IBMPlexSans-Italic.woff2](../../packages/design/fonts/IBMPlexSans-Italic.woff2) — path inventoried only.
- [packages/design/fonts/IBMPlexSans-Medium.woff2](../../packages/design/fonts/IBMPlexSans-Medium.woff2) — path inventoried only.
- [packages/design/fonts/IBMPlexSans-Regular.woff2](../../packages/design/fonts/IBMPlexSans-Regular.woff2) — path inventoried only.
- [packages/design/fonts/IBMPlexSans-SemiBold.woff2](../../packages/design/fonts/IBMPlexSans-SemiBold.woff2) — path inventoried only.
- [packages/design/fonts/NotoSansMath-Regular.woff2](../../packages/design/fonts/NotoSansMath-Regular.woff2) — path inventoried only.
- [packages/design/fonts/NotoSansSymbols2-Regular.woff2](../../packages/design/fonts/NotoSansSymbols2-Regular.woff2) — path inventoried only.
