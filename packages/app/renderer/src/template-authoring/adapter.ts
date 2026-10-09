/** Bind the merged editor to typed daemon contracts, exact source receipts and separate guarded Apply. */
import {
  TemplateCatalogSchema,
  TemplateReviewSchema,
  TemplatePreviewSchema,
  TemplateSaveResultSchema,
  TemplateVariantResultSchema,
  TemplateHistoryResultSchema,
  ConfigApplyResultSchema,
  type TemplateCatalog,
  type TemplateSourceCandidate,
  type TemplatePublicationParams,
} from "@orca/protocol";
import type { OrcaBridge } from "../../../src/bridge.js";
import type { TemplateBridge } from "../../../src/template-bridge.js";
import { currentEditorTarget, sameEditorTarget } from "../config/configuration-adapter.js";
import type { AuthoringPorts, AuthoringSnapshot, AuthoringCandidate } from "./model.js";
const emptyRevision = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export class TemplateAdapter implements AuthoringPorts {
  onAuthorityRefusal?: () => void;
  private authorityRefusal(error: { code: string }): void {
    if (error.code.startsWith("AUTH_")) this.onAuthorityRefusal?.();
  }
  private catalog: TemplateCatalog | undefined;
  private readSequence = 0;
  private review: { candidate: AuthoringCandidate; revision: string } | undefined;
  private publication: TemplatePublicationParams | undefined;
  constructor(
    readonly target: AuthoringSnapshot["target"],
    private readonly bridge: OrcaBridge,
    private readonly transport: TemplateBridge,
  ) {}
  private assert(method: string): void {
    if (!sameEditorTarget(this.target, currentEditorTarget(this.bridge))) throw new Error("Template target changed.");
    const connection = this.bridge.connection.read();
    if (connection.state !== "live" || !connection.methods?.includes(method))
      throw new Error("Template operation unavailable.");
  }
  private snapshot(catalog: TemplateCatalog): AuthoringSnapshot {
    if (!sameEditorTarget(this.target, { ...catalog.target, epoch: this.target.epoch }))
      throw new Error("Template response target changed.");
    this.catalog = catalog;
    return {
      target: this.target,
      revision: catalog.catalogRevision,
      generation: catalog.generation,
      contextRevision: catalog.contextRevision,
      assets: catalog.assets,
      ...(!this.bridge.connection.read().methods?.includes("templates.save")
        ? { writeReason: "This daemon does not offer template source saves." }
        : {}),
    };
  }
  get current(): TemplateCatalog | undefined {
    return this.catalog;
  }
  async history(key: string) {
    this.assert("templates.history");
    const catalog = this.catalog!;
    const response = await this.transport.call("templates.history", { target: catalog.target, key });
    this.assert("templates.history");
    if (!response.ok) {
      this.authorityRefusal(response.error);
      throw new Error("Revision history unavailable.");
    }
    if (!this.catalog?.assets.some((asset) => asset.key === key)) throw new Error("Revision history unavailable.");
    return TemplateHistoryResultSchema.parse(response.result);
  }
  async read(): Promise<AuthoringSnapshot> {
    this.assert("templates.get");
    const operation = ++this.readSequence;
    const response = await this.transport.call("templates.get", {});
    this.assert("templates.get");
    if (operation !== this.readSequence) throw new Error("A newer catalog read superseded this response.");
    if (!response.ok) {
      this.authorityRefusal(response.error);
      throw new Error("Template catalog unavailable.");
    }
    return this.snapshot(TemplateCatalogSchema.parse(response.result));
  }
  private candidate(candidate: AuthoringCandidate, allowEmpty = false): TemplateSourceCandidate | undefined {
    const catalog = this.catalog;
    if (
      !catalog ||
      !sameEditorTarget(candidate.target, this.target) ||
      candidate.expectedRevision !== catalog.catalogRevision ||
      candidate.expectedGeneration !== catalog.generation
    )
      throw new Error("Template base changed.");
    if (candidate.edits.length === 0 && allowEmpty) return undefined;
    if (candidate.edits.length !== 1)
      throw new Error("Review and save one source at a time; no sequential batch writes.");
    const edit = candidate.edits[0]!;
    return {
      target: catalog.target,
      key: edit.key,
      expectedSourceRevision: catalog.assets.find((asset) => asset.key === edit.key)?.revision ?? emptyRevision,
      expectedCatalogRevision: catalog.catalogRevision,
      expectedConfigGeneration: catalog.generation,
      draftSequence: candidate.sequence,
      text: edit.text,
    };
  }
  async validate(candidate: AuthoringCandidate) {
    this.assert("templates.validate");
    const command = this.candidate(candidate);
    if (!command) throw new Error("Choose a changed source.");
    const response = await this.transport.call("templates.validate", command);
    this.assert("templates.validate");
    if (!response.ok) {
      this.authorityRefusal(response.error);
      throw new Error("Template validation refused.");
    }
    const review = TemplateReviewSchema.parse(response.result);
    this.review = { candidate: structuredClone(candidate), revision: review.candidateRevision };
    return {
      ...review,
      errors: review.errors.map(({ key, ...error }) => ({ ...error, ...(key === undefined ? {} : { key }) })),
    };
  }
  async preview(
    candidate: AuthoringCandidate,
    id: string,
    pack: string | undefined,
    fixtures: Parameters<AuthoringPorts["preview"]>[3],
  ) {
    this.assert("templates.preview");
    const command = this.candidate(candidate, true);
    const catalog = this.catalog!;
    const response = await this.transport.call("templates.preview", {
      target: catalog.target,
      expectedCatalogRevision: catalog.catalogRevision,
      expectedConfigGeneration: catalog.generation,
      ...(command ? { candidate: command } : {}),
      id,
      ...(pack ? { pack } : {}),
      fixtures,
    });
    this.assert("templates.preview");
    if (!response.ok) {
      this.authorityRefusal(response.error);
      throw new Error("Fixture preview refused.");
    }
    return TemplatePreviewSchema.parse(response.result);
  }
  /** The isolated controller's publish port acknowledges source Save only; UI names it explicitly. */
  publish: NonNullable<AuthoringPorts["publish"]> = async (candidate, revision) => {
    this.assert("templates.save");
    const command = this.candidate(candidate);
    if (
      !command ||
      !this.review ||
      this.review.revision !== revision ||
      JSON.stringify(this.review.candidate) !== JSON.stringify(candidate)
    )
      throw new Error("Template review changed.");
    const response = await this.transport.call("templates.save", { candidate: command, candidateRevision: revision });
    this.assert("templates.save");
    if (!response.ok) {
      this.authorityRefusal(response.error);
      return {
        status:
          response.error.code === "CONFIG_STALE"
            ? "conflict"
            : response.error.code === "CONFIG_INVALID"
              ? "invalid"
              : "denied",
        errors: [],
      };
    }
    const result = TemplateSaveResultSchema.parse(response.result);
    const savedAsset = result.snapshot.assets.find((asset) => asset.key === command.key);
    if (
      result.candidateRevision !== revision ||
      result.snapshot.generation !== candidate.expectedGeneration ||
      savedAsset?.source.state !== "available" ||
      savedAsset.source.text !== command.text
    )
      throw new Error("Template Save acknowledgement changed content.");
    this.publication = undefined;
    this.review = undefined;
    return { status: "saved", candidateRevision: revision, snapshot: this.snapshot(result.snapshot) };
  };
  variant: NonNullable<AuthoringPorts["variant"]> = async (asset, pack) => {
    this.assert("templates.variant");
    const catalog = this.catalog!;
    const source = catalog.assets.find((item) => item.key === asset.key);
    if (!source) throw new Error("Variant source unavailable.");
    const response = await this.transport.call("templates.variant", {
      target: catalog.target,
      key: source.key,
      expectedSourceRevision: source.revision,
      expectedCatalogRevision: catalog.catalogRevision,
      expectedConfigGeneration: catalog.generation,
      pack,
    });
    this.assert("templates.variant");
    if (!response.ok) {
      this.authorityRefusal(response.error);
      throw new Error("Variant derivation refused.");
    }
    return TemplateVariantResultSchema.parse(response.result);
  };
  async reviewPublication() {
    this.assert("templates.publish");
    const catalog = this.catalog!;
    const command = {
      target: catalog.target,
      expectedCatalogRevision: catalog.catalogRevision,
      expectedConfigRevision: catalog.configRevision,
      expectedConfigGeneration: catalog.generation,
    };
    const response = await this.transport.call("templates.publish", { ...command, validateOnly: true });
    this.assert("templates.publish");
    if (!response.ok) {
      this.authorityRefusal(response.error);
      throw new Error("Template Apply review refused.");
    }
    const result = ConfigApplyResultSchema.parse(response.result);
    if (
      result.outcome !== "validated" ||
      result.validation.errors.length ||
      result.status.activeGeneration !== command.expectedConfigGeneration ||
      result.status.savedRevision !== command.expectedConfigRevision
    )
      throw new Error("Template Apply review is unavailable.");
    this.publication = command;
    return result;
  }
  async applyPublication() {
    this.assert("templates.publish");
    const command = this.publication;
    if (
      !command ||
      command.expectedCatalogRevision !== this.catalog?.catalogRevision ||
      command.expectedConfigGeneration !== this.catalog?.generation
    )
      throw new Error("Review saved catalog before Apply.");
    this.publication = undefined;
    const response = await this.transport.call("templates.publish", command);
    this.assert("templates.publish");
    if (!response.ok) {
      this.authorityRefusal(response.error);
      throw new Error("Template Apply was not acknowledged. Refresh and review.");
    }
    const result = ConfigApplyResultSchema.parse(response.result);
    if (
      result.status.savedRevision !== command.expectedConfigRevision ||
      result.outcome === "validated" ||
      (result.outcome === "applied" && result.status.activeGeneration === command.expectedConfigGeneration) ||
      ((result.outcome === "invalid" || result.outcome === "restart-required") &&
        result.status.activeGeneration !== command.expectedConfigGeneration)
    )
      throw new Error("Unexpected template activation receipt.");
    if (
      (result.outcome === "applied" || result.outcome === "unchanged") &&
      (result.status.state !== "active" ||
        result.status.activeRevision !== command.expectedConfigRevision ||
        result.validation.errors.length)
    )
      throw new Error("Unexpected template activation receipt.");
    return result;
  }
}
