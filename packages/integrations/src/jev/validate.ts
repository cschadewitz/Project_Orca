/**
 * Validation of a System One response against the questions that were asked. The model's
 * output is data that drives routing, so every field is checked before anything downstream
 * reads it: the answer ids must be exactly the question ids, each answer must be of the asked
 * type, a choice must be one of the offered options, and every probability, score and
 * confidence must be a finite number inside its range. A response that fails any of these is
 * rejected whole - there is no partial credit and nothing is inferred to fill a gap.
 */
import type { JevAnswer, JevQuestion, JevResponse } from "./types.js";

export type JevValidation = { ok: true; response: JevResponse } | { ok: false; problems: string[] };

/** Probabilities are reported rounded; this is how far from 1 a distribution may sum. */
const SUM_TOLERANCE = 0.02;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** A distribution over exactly `keys`, every entry in [0, 1], summing to 1 within tolerance. */
function distribution(
  raw: unknown,
  keys: string[],
  at: string,
  problems: string[],
): Record<string, number> | undefined {
  if (!isRecord(raw)) {
    problems.push(`${at}: probabilities must be an object`);
    return undefined;
  }
  const got = Object.keys(raw).sort();
  const want = [...keys].sort();
  if (got.join("\0") !== want.join("\0")) {
    problems.push(`${at}: probabilities cover [${got.join(", ")}], expected [${want.join(", ")}]`);
    return undefined;
  }
  const out: Record<string, number> = {};
  let sum = 0;
  for (const k of keys) {
    const p = raw[k];
    if (!unit(p)) {
      problems.push(`${at}: probability for '${k}' is not a number in [0, 1]`);
      return undefined;
    }
    out[k] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) {
    problems.push(`${at}: probabilities sum to ${sum.toFixed(3)}, expected 1`);
    return undefined;
  }
  return out;
}

function confidence(raw: unknown, at: string, problems: string[]): number | undefined {
  if (!unit(raw)) {
    problems.push(`${at}: confidence is not a number in [0, 1]`);
    return undefined;
  }
  return raw;
}

function answer(id: string, question: JevQuestion, raw: unknown, problems: string[]): JevAnswer | undefined {
  const at = `answers.${id}`;
  if (!isRecord(raw)) {
    problems.push(`${at}: must be an object`);
    return undefined;
  }
  if (raw.type !== undefined && raw.type !== question.type) {
    problems.push(`${at}: type is '${String(raw.type)}', asked for '${question.type}'`);
    return undefined;
  }
  switch (question.type) {
    case "noul": {
      if (!unit(raw.noul)) {
        problems.push(`${at}: noul is not a number in [0, 1]`);
        return undefined;
      }
      return { type: "noul", noul: raw.noul };
    }
    case "choice": {
      const options = Object.keys(question.criteria);
      const choice = raw.choice;
      if (typeof choice !== "string" || !options.includes(choice)) {
        problems.push(`${at}: choice '${String(choice)}' is not one of [${options.join(", ")}]`);
        return undefined;
      }
      const probabilities = distribution(raw.probabilities, options, at, problems);
      const conf = confidence(raw.confidence, at, problems);
      if (!probabilities || conf === undefined) return undefined;
      return { type: "choice", choice, probabilities, confidence: conf };
    }
    case "score": {
      const levels = question.criteria.length;
      const top = levels - 1;
      const score = raw.score;
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > top) {
        problems.push(`${at}: score '${String(score)}' is not a number in [0, ${top}]`);
        return undefined;
      }
      const keys = question.criteria.map((_, i) => String(i));
      const probabilities = distribution(raw.probabilities, keys, at, problems);
      const conf = confidence(raw.confidence, at, problems);
      if (!probabilities || conf === undefined) return undefined;
      const legend = isRecord(raw.legend)
        ? Object.fromEntries(Object.entries(raw.legend).map(([k, v]) => [k, String(v)]))
        : undefined;
      return {
        type: "score",
        score,
        probabilities,
        confidence: conf,
        levels,
        normalized: top === 0 ? 0 : score / top,
        ...(legend ? { legend } : {}),
      };
    }
  }
}

/** Check a raw response body against `questions`. Every problem is reported, not just the first. */
export function validateJevResponse(questions: Record<string, JevQuestion>, raw: unknown): JevValidation {
  const problems: string[] = [];
  if (!isRecord(raw)) return { ok: false, problems: ["response is not an object"] };
  if (!isRecord(raw.answers)) return { ok: false, problems: ["response has no 'answers' object"] };

  const asked = Object.keys(questions);
  const returned = Object.keys(raw.answers);
  for (const id of asked) if (!(id in raw.answers)) problems.push(`answers.${id}: missing`);
  for (const id of returned) if (!(id in questions)) problems.push(`answers.${id}: not a question that was asked`);

  const answers: Record<string, JevAnswer> = {};
  for (const id of asked) {
    if (!(id in raw.answers)) continue;
    const a = answer(id, questions[id]!, raw.answers[id], problems);
    if (a) answers[id] = a;
  }

  const model = typeof raw.model === "string" ? raw.model : undefined;
  if (raw.model !== undefined && model === undefined) problems.push("model is not a string");

  let usage: JevResponse["usage"];
  if (raw.usage !== undefined) {
    const u = raw.usage;
    const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (!isRecord(u) || !count(u.input_tokens) || !count(u.output_tokens)) problems.push("usage is malformed");
    else usage = { inputTokens: u.input_tokens as number, outputTokens: u.output_tokens as number };
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, response: { model, answers, usage } };
}
