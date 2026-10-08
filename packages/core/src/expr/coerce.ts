/** Legacy JavaScript coercion used by workflow expressions and their executors. */
export function coerceWorkflowString(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  // Expressions historically use JavaScript coercion (including arrays/objects),
  // unlike str()/json() and event display. Changing it changes workflow routing.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Preserve this explicit workflow-language contract; never use for event display.
  return String(value);
}
