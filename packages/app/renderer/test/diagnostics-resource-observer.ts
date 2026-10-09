/** Measurement polling must not materialize the complete report as a plaintext oracle. */
export function hasCompleteDiagnosticPreview(document: Document): boolean {
  const report = document.querySelector(".orca-diagnostics__exact");
  return report !== null && report.parentElement?.hidden === false;
}
