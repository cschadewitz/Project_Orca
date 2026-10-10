/** Nonsecret candidate-bound desktop approval; no renderer catalog, path or native capability. */
export interface MacUpdateView {
  readonly phase:
    | "unavailable"
    | "idle"
    | "available"
    | "downloading"
    | "waiting"
    | "preparing"
    | "activating"
    | "awaiting-restart"
    | "deferred"
    | "failed"
    | "recovery-required";
  readonly offerId?: string;
  readonly manifestSha256?: string;
  readonly version?: string;
  readonly channel?: string;
  readonly compatibilityPlanId?: string;
  readonly recoveryPlanId?: string;
  readonly blocker?: "drafts" | "window-unavailable" | "activity" | "identity" | "candidate";
}
export interface MacUpdateCommand {
  readonly action: "approve" | "defer";
  readonly offerId: string;
  readonly manifestSha256: string;
}
