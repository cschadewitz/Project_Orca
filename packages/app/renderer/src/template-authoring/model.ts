/** App-local injected seams, not a pack format, RPC, or immutable template-version API. */
export interface AuthoringTarget {
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly epoch: number;
}

export interface TemplateAsset {
  readonly key: string;
  readonly id: string;
  readonly version: string;
  readonly requires: readonly string[];
  readonly partials: readonly string[];
  readonly usedBy: readonly string[];
  /** Only explicitly authorized source is editable/exportable. No protected snapshot reads. */
  readonly source: { readonly state: "available"; readonly text: string } | { readonly state: "withheld" };
}

export interface AuthoringSnapshot {
  readonly target: AuthoringTarget;
  readonly revision: string;
  readonly generation: string;
  readonly contextRevision?: string;
  readonly assets: readonly TemplateAsset[];
  /** Current authoritative catalog diagnostics, including parser and workflow failures. */
  readonly errors?: readonly AuthoringError[];
  readonly writeReason?: string;
}

export interface SourceEdit {
  readonly key: string;
  /** Exact Markdown/front matter text; untouched assets are never reconstructed. */
  readonly text: string;
}

export interface AuthoringCandidate {
  readonly target: AuthoringTarget;
  readonly expectedRevision: string;
  readonly expectedGeneration: string;
  readonly sequence: number;
  readonly edits: readonly SourceEdit[];
}

export interface AuthoringError {
  readonly key?: string;
  readonly code: "duplicate-id" | "missing-id" | "front-matter" | "reference" | "compatibility" | "invalid";
  /** An authorized diagnostic, never rejected source or resolved secret values. */
  readonly message: string;
}

export interface AuthoringReview {
  readonly candidateRevision: string;
  readonly errors: readonly AuthoringError[];
  readonly compatibility: "compatible" | "incompatible" | "unavailable";
  /** Sanitized semantic/upgrade diff, not plaintext history. */
  readonly changes: readonly string[];
}

export interface FixtureInputs {
  /** Explicit synthetic values and artifact bodies only. No path/credential resolution. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly artifacts: Readonly<Record<string, string>>;
}

export interface PromptPreview {
  readonly requestedId: string;
  readonly resolvedId: string;
  readonly fallback: boolean;
  readonly partialIds: readonly string[];
  /** Rendered solely from the supplied fixtures; port must never contact an agent. */
  readonly text: string;
}

export type PublicationResult =
  | { readonly status: "saved"; readonly candidateRevision: string; readonly snapshot: AuthoringSnapshot }
  | { readonly status: "conflict" | "invalid" | "denied"; readonly errors: readonly AuthoringError[] };

export interface AuthoringPorts {
  read: () => Promise<AuthoringSnapshot>;
  /** Authoritative parser/reference/compatibility checks over exact candidate bytes. */
  validate: (candidate: AuthoringCandidate) => Promise<AuthoringReview>;
  preview: (
    candidate: AuthoringCandidate,
    id: string,
    pack: string | undefined,
    fixtures: FixtureInputs,
  ) => Promise<PromptPreview>;
  /** Absent until a reviewed revision/generation-checked local publication adapter exists. */
  publish?: (candidate: AuthoringCandidate, candidateRevision: string) => Promise<PublicationResult>;
  /** Source derivation uses the accepted parser; never infer YAML keys with a regex. */
  variant?: (asset: TemplateAsset, pack: string) => Promise<SourceEdit>;
}

export function sameTarget(a: AuthoringTarget, b: AuthoringTarget): boolean {
  return a.workspaceId === b.workspaceId && a.instanceId === b.instanceId && a.epoch === b.epoch;
}

/** Registry.get semantics. Partial lookup intentionally does not call this function. */
export function resolveTemplate(
  assets: readonly TemplateAsset[],
  id: string,
  pack?: string,
): TemplateAsset | undefined {
  return (
    (pack ? assets.find((asset) => asset.id === `${pack}/${id}`) : undefined) ?? assets.find((asset) => asset.id === id)
  );
}

/** Catalog-level checks supplement, and never replace, authoritative source validation. */
export function catalogErrors(assets: readonly TemplateAsset[]): AuthoringError[] {
  const seen = new Set<string>();
  const ids = new Set(assets.map((asset) => asset.id));
  return assets.flatMap((asset) => {
    const errors: AuthoringError[] = [];
    if (asset.id.trim() === "") errors.push({ key: asset.key, code: "missing-id", message: "Declare a template ID." });
    if (seen.has(asset.id))
      errors.push({ key: asset.key, code: "duplicate-id", message: `Duplicate template ID: ${asset.id}` });
    seen.add(asset.id);
    for (const partial of asset.partials) {
      if (!ids.has(partial))
        errors.push({ key: asset.key, code: "reference", message: `Missing exact-ID partial: ${partial}` });
    }
    return errors;
  });
}

export function exportSource(asset: TemplateAsset, edits: readonly SourceEdit[]): string | undefined {
  if (asset.source.state !== "available") return undefined;
  return edits.find((edit) => edit.key === asset.key)?.text ?? asset.source.text;
}
