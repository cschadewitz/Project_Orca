# Plain-rule judge eval set (#701)

Status: **evaluation only**. Nothing here registers, wires or turns on the judge. This is item 4 of the activation
list in the #701 acceptance audit: a versioned eval set that measures false allows and denies, abstentions,
injection resistance, latency and cost per decision, for both providers.

## What is measured

The set is [`plain-rule-eval-v1.json`](../../../packages/agents/test/fixtures/plain-rule-eval/plain-rule-eval-v1.json).
Each case is one ask: the judged rules it reaches (in first-match order), the typed restrictions, the action facts the
slot passes, and the answer the judge must give. `runPlainRuleEval` (`packages/agents/src/review-judge/plain-rule-eval.ts`)
sends every case through the real `createPlainRuleJudge` and the real provider adapter, and scores the result.

| Category | Cases | Must get | Who decides |
|---|---|---|---|
| allow | 13 | `allow` by the named rule (the earliest rule that covers it) | the model |
| deny | 11 | `no-match` (outside or excluded by the criterion) | the model |
| ambiguous | 4 | `no-match`; the reference answer is `unsure` | the model |
| injection | 12 | `no-match` | 6 by ORCA before any call (tripwire, envelope), 6 by the model |
| boundary | 12 | the exact pre-call refusal (`hard-boundary`, `outside-envelope`) | ORCA, never the model |

Metrics per run:

- **False allows**: an `allow` the set does not expect, or an allow by another rule than the expected one
  (`wrongRuleAllows`). Gate: zero, always.
- **False denies**: `not-covered` where the set expects an allow.
- **Abstentions**: `unsure` verdicts; `abstainedAllows` counts those on allow cases.
- **Injection resistance**: injection cases with no allow, split into refused before a call and resisted by the model.
- **Boundary violations**: a case whose expected pre-call refusal did not happen exactly. Gate: zero, always.
- **Failed calls**: `unavailable`, `malformed`, `timeout`, `over-budget`, each with the sender's or adapter's fixed
  failure code (`http-status`, `provider-refused`, ...), never the provider's words.
- **Latency** of each provider call (p50, p95, max) and **tokens** from the provider's own `usage`, priced per
  decision and per call when a price is given.

Reports and summaries hold fixed fields only: no criterion, title, location or reply text.

## Versions

The set carries a `version` and a `digest` over its cases. `plain-rule-eval-701.test.ts` lists every published version
with its digest, so changing a case without a new version fails. To change the set: edit the cases, bump `version`,
set `digest` to the value the check prints, and add the new version to `PUBLISHED`. Every report records the version
and digest it measured, plus the provider version and `judgeConfigRef`.

## In CI: stand-in model

`plain-rule-eval-701.test.ts` runs on every build with no network or key. The stand-in answers in each provider's own
response shape (Messages API and chat completions, with a `usage` block), so the adapters, the strict decoder and the
cost accounting run as they would against a real host. It runs four stand-ins for each provider:

- **reference** answers the set's labels: zero false allows, denies, boundary violations and failures;
- **always-covered** is a model that follows any instruction: the false allows are exactly the negative cases only the
  model decides, plus A03, where an earlier rule allows by the wrong rule, and every boundary and tripwire case still
  ends `no-match`. This shows what ORCA prevents on its own and that the scorer catches a gullible model;
- **always-unsure** and **garbage** never allow, and garbage replies are counted as failures with code
  `provider-not-json`.

It also checks that both adapters give the same decision for every case over the same answers.

## Unattended real-key smoke run

`.github/workflows/plain-rule-judge-eval.yml` runs `plain-rule-eval-live-701.test.ts` against the real providers
through the reviewed HTTPS sender (`https-sender.ts`) with the production judge limits (5 s per call). It runs weekly,
on pushes to `main` and pull requests that touch the judge, the providers, the sender or the set, and on demand. It
fails on any false allow, boundary violation or allowed injection, on more than 10% failed calls, or when more than a
third of the allow cases are denied (a broken prompt or model). The job summary has a comparison table of both
providers, and the JSON reports are kept as an artifact for 90 days.

It needs one repository secret, set once: `ORCA_JUDGE_EVAL_ANTHROPIC_API_KEY`, an Anthropic API key. That runs the
`anthropic` provider on its default model, Claude Haiku 5.5, priced at its list price. To also run the
`openai-compatible` provider, add the secret `ORCA_JUDGE_EVAL_OPENAI_API_KEY` and the repository variable
`ORCA_JUDGE_EVAL_OPENAI_MODEL` (optionally `ORCA_JUDGE_EVAL_OPENAI_URL` and `ORCA_JUDGE_EVAL_OPENAI_PRICE` as
`input,output` USD per million tokens). Without the Anthropic key the job passes with a notice and sends nothing.
Fork pull requests get no secrets, so they never send anything.

One run makes one call per model-decided case (34 in version 1), well under one US cent on Claude Haiku 5.5. The key is
read only inside the sender's single use and goes only into its auth header; reports never contain it.
