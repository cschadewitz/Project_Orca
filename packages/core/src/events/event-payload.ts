/** Read display fields from current or legacy journals without coercing objects to text. */
import { GateOptionSchema } from "../model/run.js";

const INVALID = "[invalid]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rendering is deliberately more tolerant than execution schema validation: old
 * logs can omit fields or carry bare gate-option strings. These accessors never
 * mutate or hydrate the payload. Structured fields are JSON only where the
 * formatter explicitly requests it; invalid display fields reveal no contents.
 */
export class EventPayload {
  constructor(private readonly value: unknown) {}

  field(key: string): unknown {
    return isRecord(this.value) && Object.hasOwn(this.value, key) ? this.value[key] : undefined;
  }

  record(key: string): EventPayload {
    return new EventPayload(this.field(key));
  }

  /** Preserve primitive spellings in old logs, including missing required fields. */
  text(key: string, maxLength?: number): string {
    const value = this.field(key);
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value);
      return maxLength === undefined ? text : text.slice(0, maxLength);
    }
    return INVALID;
  }

  optionalText(key: string): string {
    return this.field(key) ? this.text(key) : "";
  }

  flag(key: string): boolean {
    return this.field(key) === true;
  }

  list(key: string): readonly unknown[] {
    const value: unknown = this.field(key);
    return Array.isArray(value) ? value : [];
  }

  strings(key: string): string[] {
    const value = this.field(key);
    if (value === undefined) return [];
    if (!Array.isArray(value)) return [INVALID];
    return value.map((item: unknown) => (typeof item === "string" ? item : INVALID));
  }

  optionLabels(key: string): string[] {
    return this.list(key).map((option) => {
      const parsed = GateOptionSchema.safeParse(option);
      return parsed.success ? parsed.data.label : INVALID;
    });
  }

  keys(): string[] {
    return isRecord(this.value) ? Object.keys(this.value) : [];
  }
}
