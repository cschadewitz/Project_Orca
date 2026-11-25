// What the demo seed puts into a workspace: agents and their playbooks, extra workflows and
// prompt templates, a capability catalog, secrets, and the work it submits. Plain data, so the
// seeder (seed.mjs) stays a thin loop over it and a reviewer can read the whole demo here.
//
// Titles are deliberately mixed: most read like real work, and a few are long, unbroken or
// non-Latin, because the point of the seed is a visual sweep and those are what break layouts.

/** Every artifact kind the repo's workflows ask for, written so their validation passes. */
export const BASE_KINDS = {
  intent: [
    {
      data: { status: "ready" },
      body: "# Intent\n\nWho this is for, the outcome we want, and what is out of scope for {kind}.",
    },
  ],
  spec: [
    {
      data: { status: "ready", risk: "low" },
      body: "# Spec\n\nRequirements and a design sketch, long enough to pass the design step's minimum body length rule, with the edge cases listed.",
    },
  ],
  plan: [{ data: { status: "ready" }, body: "Plan: small commits, tests first." }],
  implementation: [{ data: { status: "done", branch: "orca/demo" }, body: "Implementation summary." }],
  "test-report": [{ data: { status: "done", passed: true, failures: 0 }, body: "All green." }],
  review: [{ data: { status: "done", verdict: "approve" }, body: "LGTM. Two nits left inline." }],
  "deploy-report": [{ data: { status: "done" }, body: "Opened the pull request and it merged." }],
  generic: [{ data: { status: "done" }, body: "Summary of the program so far." }],
  note: [{ data: { status: "done" }, body: "Step {n}: done." }],
  decomposition: [
    {
      data: {
        items: [
          {
            slug: "only-item",
            title: "Only item",
            kind: "task",
            description: "One thing",
            estimate: "S",
            dependsOn: [],
          },
        ],
        rationale: "Nothing to split.",
      },
      body: "Breakdown.",
    },
  ],
  "risk-register": [{ data: { status: "done", risks: [], summary: "No new risks." }, body: "Risk narrative." }],
  "decision-matrix": [
    {
      data: {
        key: "none",
        title: "No decision",
        scale: 10,
        criteria: [{ key: "c", name: "Criterion", weight: 1 }],
        options: [{ key: "a", name: "A", scores: { c: 5 } }],
        rationale: "Only one option.",
      },
      body: "Matrix.",
    },
  ],
};

/** The agents' shared playbook; each agent's `kinds` override it per kind. */
export const BASE_PLAYBOOK = {
  greeting: "Demo agent: reading the deliverables.",
  delayMs: 200,
  default: { data: { status: "done" }, body: "Delivered {kind} ({n})." },
  kinds: BASE_KINDS,
};

const MODELS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "demo-large",
    options: [
      { value: "demo-large", name: "Demo Large", description: "Slow and careful" },
      { value: "demo-small", name: "Demo Small", description: "Fast and cheap" },
      { value: "demo-reasoning-extended-context-preview", name: "Demo Reasoning Extended Context (preview)" },
    ],
  },
];

/**
 * The agents. `roles` agents take a workflow's role by default; the rest are only reached by a
 * request's role overrides, which is how one run gets a slow builder and the next a flaky tester.
 */
export const AGENTS = [
  { id: "atlas", name: "Atlas", roles: ["planner", "decomposer"], kinds: {} },
  { id: "iris", name: "Iris", roles: ["designer"], kinds: {} },
  { id: "forge", name: "Forge", roles: ["builder"], kinds: {}, configOptions: MODELS },
  { id: "sentry", name: "Sentry", roles: ["tester"], kinds: {} },
  { id: "quill", name: "Quill", roles: ["reviewer"], kinds: {} },
  { id: "harbor", name: "Harbor", roles: ["deployer"], kinds: {} },
  {
    id: "slow-builder",
    name: "Slow builder",
    kinds: {
      implementation: [
        {
          say: "Building the change. This one takes a while.",
          delayMs: 45 * 60 * 1000,
          data: { status: "done", branch: "orca/slow" },
          body: "Slow implementation.",
        },
      ],
      note: [
        {
          say: "Packaging. This one takes a while.",
          delayMs: 45 * 60 * 1000,
          data: { status: "done" },
          body: "Packaged.",
        },
      ],
    },
  },
  {
    id: "flaky-tester",
    name: "Flaky tester",
    kinds: {
      "test-report": [
        {
          say: "Running the suite.",
          data: { status: "done", passed: false, failures: 2 },
          body: "2 failures:\n\n- checkout.spec.ts > applies the discount code\n- checkout.spec.ts > totals a mixed-currency cart",
        },
      ],
    },
  },
  {
    id: "cautious-designer",
    name: "Cautious designer",
    kinds: {
      spec: [
        {
          data: { status: "ready", risk: "high" },
          body: "# Spec\n\nThis touches authentication and every client that pins a key, which is why the risk is high and a person has to approve it.",
        },
      ],
    },
  },
  {
    id: "asking-builder",
    name: "Builder that asks first",
    kinds: {
      implementation: [
        {
          say: "I need to write outside the usual files; asking first.",
          askPermission: true,
          permissionPath: "/etc/demo-seed/production.env",
          data: { status: "done", branch: "orca/asks" },
          body: "Implementation after permission.",
        },
      ],
    },
  },
  {
    id: "forgetful-builder",
    name: "Forgetful builder",
    kinds: { implementation: [{ say: "Done! (It wrote nothing.)", skip: true }] },
  },
  {
    id: "stuck-builder",
    name: "Stuck builder",
    kinds: { implementation: [{ say: "Thinking…", hang: true }] },
  },
  {
    id: "picky-reviewer",
    name: "Picky reviewer",
    stateful: true,
    kinds: {
      review: [
        { data: { status: "done", verdict: "changes-requested" }, body: "Needs a test for the empty cart." },
        { data: { status: "done", verdict: "approve" }, body: "Better. Approved." },
      ],
    },
  },
  {
    id: "refusing-reviewer",
    name: "Refusing reviewer",
    kinds: { review: [{ say: "I can't review this.", stopReason: "refusal", skip: true }] },
  },
  {
    id: "long-name-agent",
    name: "Extremely thorough documentation and release-notes agent with a very long display name that does not fit",
    kinds: {},
  },
];

/** Agents that never start: the Agents surface's unhealthy states. */
export const BROKEN_AGENTS = [
  { id: "offline-agent", name: "Offline agent", command: "/opt/demo-seed/not-installed/agent-acp", args: [] },
];

const item = (slug, title, kind, description, estimate, dependsOn = [], extra = {}) => ({
  slug,
  title,
  kind,
  description,
  estimate,
  dependsOn,
  ...extra,
});

/** One planner per program, so each program's breakdown has its own slugs. */
export const PROGRAMS = [
  {
    plan: "billing",
    planner: "planner-billing",
    plannerName: "Billing planner",
    title: "Billing export",
    body: "Customers need their invoices out of the product: CSV now, PDF after, and an API for both.",
    approve: true,
    decomposition: {
      items: [
        item("invoice-model", "Invoice data model", "task", "Normalise invoices and line items", "M", [], {
          risks: ["pii-in-exports"],
        }),
        item("csv-export", "CSV export", "feature", "Download invoices as CSV", "S", ["invoice-model"], {
          priority: "high",
        }),
        item("pdf-export", "PDF export", "feature", "Render invoices as PDF", "L", [
          "invoice-model",
          "decision:pdf-engine",
        ]),
        item("export-api", "Export API", "feature", "GET /invoices/export?format=", "M", ["csv-export"], {
          risks: ["large-exports-timeout"],
        }),
        item("billing-docs", "Billing export docs", "task", "Document the export formats", "XS", [
          "informs:export-api@spec",
        ]),
      ],
      risks: [
        {
          key: "pii-in-exports",
          title: "Exports carry customer PII off-platform",
          category: "security",
          likelihood: 3,
          impact: 4,
          mitigation: "Redact by default; full export needs an admin role",
          affects: ["invoice-model", "csv-export"],
        },
        {
          key: "large-exports-timeout",
          title: "Large accounts time out exporting a year of invoices",
          category: "operational",
          likelihood: 4,
          impact: 3,
          mitigation: "Stream the response and page by month",
          affects: ["export-api"],
        },
      ],
      decisions: [
        {
          key: "pdf-engine",
          title: "How are PDFs rendered?",
          question: "Headless Chrome or a PDF library?",
          options: [
            { key: "chrome", name: "Headless Chrome" },
            { key: "pdfkit", name: "PDFKit" },
          ],
          blocks: ["pdf-export"],
        },
      ],
      rationale: "The model first, then one slice per format, with the API on the slice that ships first.",
    },
    decide: {
      key: "pdf-engine",
      option: "pdfkit",
      rationale: "Running Chrome in production costs more than the layout is worth.",
    },
    riskUpdates: [{ key: "pii-in-exports", status: "mitigating" }],
  },
  {
    plan: "search",
    planner: "planner-search",
    plannerName: "Search planner",
    title: "Search that understands typos",
    body: "Replace the LIKE queries with a real index, add typo tolerance and facets, and keep p95 under 200 ms.",
    approve: false,
    decomposition: {
      items: [
        item("index-schema", "Index schema", "task", "Pick fields, analyzers and boosts", "M"),
        item("indexer", "Background indexer", "feature", "Keep the index in step with writes", "L", ["index-schema"], {
          risks: ["index-drift"],
        }),
        item("typo-tolerance", "Typo tolerance", "feature", "Fuzzy matching with a distance of 2", "M", ["indexer"]),
        item("facets", "Facets", "feature", "Filter by owner, status and date", "M", ["indexer"]),
        item("search-ui", "Search UI", "feature", "Results page with facets", "L", [
          "typo-tolerance",
          "facets",
          "decision:engine",
        ]),
        item("search-load-test", "Load test", "task", "p95 under 200 ms at 50 rps", "S", ["search-ui"]),
      ],
      risks: [
        {
          key: "index-drift",
          title: "The index drifts from the database after a failed write",
          category: "technical",
          likelihood: 3,
          impact: 3,
          mitigation: "Nightly reconcile job",
          affects: ["indexer"],
        },
        {
          key: "hosted-cost",
          title: "Hosted search costs more than the budget",
          category: "product",
          likelihood: 2,
          impact: 4,
          affects: ["indexer", "search-ui"],
        },
      ],
      decisions: [
        {
          key: "engine",
          title: "Which search engine?",
          question: "Self-hosted or managed?",
          options: [
            { key: "meili", name: "Meilisearch" },
            { key: "opensearch", name: "OpenSearch" },
            { key: "managed", name: "Managed service" },
          ],
          blocks: ["search-ui"],
        },
      ],
      rationale: "Index first; the UI waits on the engine decision.",
    },
    riskUpdates: [{ key: "hosted-cost", status: "accepted" }],
  },
  {
    plan: "mobile",
    planner: "planner-mobile",
    plannerName: "Mobile planner",
    title: "Offline mode for the mobile app",
    body: "Field staff lose signal. Let them read and edit their jobs offline and sync when they are back.",
    approve: false,
    decomposition: {
      items: [
        item("local-db", "Local database", "task", "SQLite on device", "M"),
        item("sync-protocol", "Sync protocol", "feature", "Last-writer-wins with field merges", "XL", ["local-db"], {
          risks: ["sync-conflicts"],
        }),
        item("offline-banner", "Offline banner", "feature", "Say when the app is offline", "XS"),
        item("conflict-ui", "Conflict resolution UI", "feature", "Pick a side per field", "L", ["sync-protocol"]),
      ],
      risks: [
        {
          key: "sync-conflicts",
          title: "Two people edit the same job offline",
          category: "technical",
          likelihood: 4,
          impact: 4,
          mitigation: "Field-level merge and a conflict screen",
          affects: ["sync-protocol", "conflict-ui"],
        },
      ],
      decisions: [],
      rationale: "Storage, then sync, then the screens that explain it.",
    },
    riskUpdates: [{ key: "sync-conflicts", status: "realized" }],
  },
  {
    plan: "platform",
    planner: "planner-platform",
    plannerName: "Platform planner",
    title: "Platform upgrade: Node 24, Postgres 17 and the build cache, all in one quarter without a freeze",
    body: "Three upgrades the team keeps postponing. Do them together so the CI images change once.",
    approve: false,
    decomposition: {
      items: [
        item("node-24", "Move services to Node 24", "task", "Runtime and CI images", "M"),
        item("pg-17", "Postgres 17", "task", "Blue-green upgrade", "L", [], { risks: ["pg-downtime"] }),
        item("build-cache", "Remote build cache", "feature", "Shared cache for CI and laptops", "M", ["node-24"]),
      ],
      risks: [
        {
          key: "pg-downtime",
          title: "The Postgres switchover takes longer than the maintenance window",
          category: "operational",
          likelihood: 2,
          impact: 5,
          mitigation: "Rehearse on a restored snapshot",
          affects: ["pg-17"],
        },
      ],
      decisions: [],
      rationale: "Independent tracks; the cache waits on the runtime.",
    },
    riskUpdates: [],
  },
];

/** Behaviour name -> role overrides, and what it looks like on screen. */
export const BEHAVIOURS = {
  succeeds: { roles: {}, shows: "succeeds" },
  running: { roles: { builder: "slow-builder" }, shows: "is still running (45-minute build)" },
  "waits-gate": { roles: { designer: "cautious-designer" }, shows: "waits at the spec gate" },
  "approved-gate": {
    roles: { designer: "cautious-designer" },
    answer: "approve",
    shows: "is approved at the spec gate",
  },
  "rejected-gate": {
    roles: { designer: "cautious-designer" },
    answer: "reject",
    shows: "is rejected at the spec gate",
  },
  "waits-permission": { roles: { builder: "asking-builder" }, shows: "waits for a permission answer" },
  "fails-tests": { roles: { tester: "flaky-tester" }, shows: "fails after three build attempts" },
  "fails-deliverable": { roles: { builder: "forgetful-builder" }, shows: "fails on a missing deliverable" },
  "fails-refusal": { roles: { reviewer: "refusing-reviewer" }, shows: "fails when the reviewer refuses" },
  "review-loop": { roles: { reviewer: "picky-reviewer" }, shows: "goes round the review loop, then succeeds" },
  stuck: { roles: { builder: "stuck-builder" }, shows: "is stuck in a turn that never ends" },
  cancelled: { roles: { builder: "slow-builder" }, cancelAfterMs: 8000, shows: "is cancelled mid-build" },
  "long-agent": { roles: { deployer: "long-name-agent" }, shows: "succeeds through the long-named agent" },
  "picks-model": { roles: {}, shows: "succeeds; its builder advertises models" },
};

/** The ai-sdlc work items: [title, description, behaviour, labels]. */
export const WORK = [
  ["Export invoices as CSV", "A CSV download on the invoices page", "succeeds", ["billing"]],
  ["Rate-limit the login endpoint", "A token bucket per IP", "running", ["security"]],
  ["Rotate the API signing keys", "Dual-sign, then retire", "waits-gate", ["security"]],
  ["Fix the flaky checkout test", "Two assertions fail", "fails-tests", ["checkout"]],
  ["Move sessions to Redis", "Server-side session store", "cancelled", ["platform"]],
  ["Add dark mode to the settings page", "Follow the OS theme", "succeeds", ["ui"]],
  ["Audit-log every admin action", "Who, what, when", "waits-permission", ["security", "compliance"]],
  ["Upgrade the payment SDK to v5", "Breaking changes in refunds", "fails-deliverable", ["billing"]],
  ["Paginate the activity feed", "Cursor pagination", "review-loop", ["ui"]],
  ["Drop the legacy XML importer", "Nobody has used it since 2023", "approved-gate", ["cleanup"]],
  ["Store passwords with plain SHA-1", "Faster logins", "rejected-gate", ["security"]],
  ["Translate onboarding emails", "German, French and Japanese", "fails-refusal", ["i18n"]],
  ["Warm the CDN after deploys", "Fetch the top 500 URLs", "stuck", ["platform"]],
  ["Write the release notes for 4.2", "From merged PRs", "long-agent", ["docs"]],
  ["Speed up the dashboard query", "It takes 4 s on large accounts", "picks-model", ["performance"]],
  [
    "Make the onboarding checklist remember which steps a person skipped on purpose so it stops nagging them about the same three integrations every single time they sign in",
    "A deliberately long title",
    "succeeds",
    ["ui", "onboarding", "long-title"],
  ],
  [
    "Investigate_ERR_CONNECTION_RESET_on_/api/v2/organisations/{organisationId}/members/bulk-import-from-csv",
    "A deliberately unbroken title",
    "fails-tests",
    ["bug"],
  ],
  ["Ajouter la facturation en euros — TVA incluse", "Accented title", "succeeds", ["billing", "i18n"]],
  ["日本語の請求書テンプレートを追加する", "Non-Latin title", "waits-gate", ["i18n"]],
  ["Retry webhooks with exponential back-off", "Up to 24 hours", "succeeds", ["platform"]],
  ["Show quota usage in the header", "Warn at 80%", "running", ["ui"]],
  ["Remove the unused feature flags", "37 of them", "succeeds", ["cleanup"]],
  ["Encrypt backups at rest", "KMS-managed keys", "waits-permission", ["security"]],
  ["Add SAML single sign-on", "Okta and Entra ID", "review-loop", ["security", "enterprise"]],
];

/** Runs of the extra workflows: [workflowId, title, behaviour or roles]. */
export const WORKFLOW_RUNS = [
  ["release-train", "Release train 4.2", {}],
  ["release-train", "Release train 4.3 (slow packaging)", { roles: { builder: "slow-builder" } }],
  ["parallel-audit", "Quarterly security audit", {}],
  ["approval-chain", "Production access for the on-call rota", {}],
  ["approval-chain", "Delete the 2019 analytics archive", {}],
  ["nested-release", "Hotfix 4.2.1", {}],
  ["wide-graph", "Triage this week's incoming bugs", {}],
  ["a-workflow-with-a-very-long-identifier-that-keeps-going-to-test-truncation", "Long-identifier workflow run", {}],
  ["ai-sdlc-strict", "Harden the password reset flow", { roles: { reviewer: "picky-reviewer" } }],
  ["ai-sdlc-strict", "Pin every GitHub Action to a commit", {}],
];

/** The extra prompt templates, under `demo/`. */
export const TEMPLATES = [
  [
    "demo/step",
    "One generic step",
    "You are doing step **{{ vars.step }}** of {{ vars.topic.title }}. Write a short note.",
  ],
  [
    "demo/audit-area",
    "Audit one area",
    "Audit {{ vars.area }} for {{ vars.topic.title }}. List findings with severity.",
  ],
  ["demo/triage", "Triage one bug", "Triage the bug in bucket {{ vars.bucket }}: reproduce, label, assign."],
  [
    "demo/release-notes",
    "Release notes",
    "Write release notes for {{ vars.topic.title }} from the merged pull requests.",
  ],
  ["demo/package", "Package a release", "Build and sign the artifacts for {{ vars.topic.title }}."],
  ["demo/smoke", "Smoke test", "Install the package on a clean machine and run the smoke checks."],
  ["demo/announce", "Announce", "Draft the announcement for {{ vars.topic.title }}."],
  [
    "demo/long",
    "A template with a long name, many variables and a body long enough to scroll in any editor or preview pane",
    Array.from({ length: 60 }, (_, i) => `${i + 1}. Consider {{ vars.topic.title }} from angle ${i + 1}.`).join("\n"),
  ],
];

/** The capability catalog: MCP servers and skills agents could be given (none are enabled). */
export const CAPABILITIES = {
  mcpServers: {
    "issue-tracker": { command: "demo-issue-tracker-mcp", args: ["--read-only"] },
    "docs-search": { command: "demo-docs-mcp", args: [] },
    "browser.headless": { command: "demo-browser-mcp", args: ["--headless"] },
  },
  skills: {
    "release-checklist": {
      path: "demo-seed/skills/release-checklist",
      version: "1.0.0",
      description: "Steps before a release",
    },
    "code-style": { path: "demo-seed/skills/code-style", description: "House style for reviews" },
  },
};

/** Secrets, by reference only: env names on the local host, no values. */
export const SECRETS = {
  "github-token": { provider: "env", name: "DEMO_GITHUB_TOKEN", host: "local", description: "Opens pull requests" },
  "npm-token": { provider: "env", name: "DEMO_NPM_TOKEN", host: "local", description: "Publishes packages" },
};

export const SKILLS = {
  "release-checklist":
    "---\nname: release-checklist\ndescription: Steps before a release\n---\n\n1. Changelog\n2. Version bump\n3. Tag\n",
  "code-style":
    "---\nname: code-style\ndescription: House style for reviews\n---\n\nPrefer small functions and early returns.\n",
};
