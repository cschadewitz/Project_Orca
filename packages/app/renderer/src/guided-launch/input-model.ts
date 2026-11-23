/** Parse explicit typed input values without resolving defaults or duplicating runtime validation. */
import type { WorkflowInputDeclarationView } from "@orca/protocol";

export type InputParse = { ok: true; value: unknown } | { ok: false; message: string };
/** Parsing only; authoritative constraints/default resolution belong to daemon preflight. */
export function parseInput(field: WorkflowInputDeclarationView, text: string): InputParse {
  // A `secret` input (#363) names a configured secret by id; the value itself never passes here.
  if (field.type === "string" || field.type === "secret") return { ok: true, value: text };
  if (!["number", "integer", "boolean", "array", "object"].includes(field.type))
    return { ok: false, message: "This input type is unsupported by the guided editor." };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "Enter a valid JSON value of the declared type." };
  }
  if (value === null && field.nullable === true) return { ok: true, value };
  const valid =
    ((field.type === "number" || field.type === "integer") &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      (field.type !== "integer" || Number.isInteger(value))) ||
    (field.type === "boolean" && typeof value === "boolean") ||
    (field.type === "array" && Array.isArray(value)) ||
    (field.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value));
  return valid ? { ok: true, value } : { ok: false, message: "The value must match the declared input type." };
}
export function inputSensitive(field: WorkflowInputDeclarationView): boolean {
  return (
    field.sensitive === true ||
    (field.items !== undefined && inputSensitive(field.items)) ||
    Object.values(field.properties ?? {}).some(inputSensitive)
  );
}
