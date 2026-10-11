/**
 * The arithmetic half of `ObjectId`: what an id's kind and tail are, and how a list keeps
 * two rows from showing the same tail. The ids are real ones from the dev demo store, which
 * is the point — three work items minted in one millisecond share their first ten
 * characters, and only the tail tells them apart.
 */
import { describe, expect, it } from "vitest";
import { OBJECT_KIND_PRESENTATION, OBJECT_KINDS } from "@orca/design";
import { TAIL_LENGTH, idText, idWords, parseId, parseIdText, uniqueTails } from "../src/ui/object-id-model.js";

const ITEMS = ["wi_01M4M899VK0SNP2F9P560F9G7S", "wi_01M4M899VKJZRZSBHNDY5M579G", "wi_01M4M899VKZJX9B8P0KQPPBJ84"];
const RUN_UUID = "run_cae154fb-f778-47ba-ae71-bb4df6bb09e1";
const RUN_ULID = "run_01M4M8A1WDAQMMX98Q6KJH7X8P";

describe("parseId", () => {
  it("reads the prefix, the kind it names, the format and a six-character tail", () => {
    const item = parseId(ITEMS[1]!);
    expect(item.prefix).toBe("wi");
    expect(item.kind).toBe("workItem");
    expect(item.format).toBe("ulid");
    expect(item.tail()).toBe("5M579G");
    expect(TAIL_LENGTH).toBe(6);

    // The tail is what differs: the three items share their whole timestamp.
    expect(new Set(ITEMS.map((id) => id.slice(0, 13))).size).toBe(1);
    expect(new Set(ITEMS.map((id) => parseId(id).tail())).size).toBe(3);
  });

  it("takes six characters of a UUID too, and knows it is one", () => {
    const run = parseId(RUN_UUID);
    expect(run.kind).toBe("run");
    expect(run.format).toBe("uuid");
    expect(run.tail()).toBe("bb09e1");
  });

  it("tells a keyed hash from a ULID by whether its head reads as a time", () => {
    expect(parseId(RUN_ULID).format).toBe("ulid");
    // `keyedId`'s output has no time in it; this one's head decodes to a time thirty thousand years out.
    expect(parseId("risk_ZT4K9W2M8Q1N7R3V5X6Y0B2C4D").format).toBe("keyed");
  });

  it("draws an id it does not recognise without failing, tail and all", () => {
    const fixture = parseId("run-metrics");
    expect(fixture.prefix).toBeUndefined();
    expect(fixture.kind).toBeUndefined();
    expect(fixture.format).toBe("opaque");
    expect(fixture.tail()).toBe("etrics");
    // Shorter than a tail: the whole of it.
    expect(parseId("req-1").tail()).toBe("req-1");
    // A prefix that names no kind is still read as a prefix.
    expect(parseId("art_01M4M899VK0SNP2F9P560F9G7S").kind).toBeUndefined();
  });

  it("names a kind for every prefix semantics.json declares", () => {
    for (const kind of OBJECT_KINDS) {
      expect(parseId(`${OBJECT_KIND_PRESENTATION[kind].prefix}_01M4M899VK0SNP2F9P560F9G7S`).kind).toBe(kind);
    }
  });
});

describe("uniqueTails", () => {
  it("gives every id six characters when six already tell them apart", () => {
    const tails = uniqueTails([...ITEMS, RUN_UUID]);
    expect([...tails.values()]).toEqual(["0F9G7S", "5M579G", "PPBJ84", "bb09e1"]);
  });

  it("lengthens just the ids that collide, keeping the shorter tail at the end", () => {
    const a = "wi_01M4M899VKJZRZSBHNDA5M579G";
    const b = "wi_01M4M899VKJZRZSBHNDB5M579G";
    const other = ITEMS[0]!;
    const tails = uniqueTails([a, b, other]);
    expect(tails.get(a)).toBe("A5M579G");
    expect(tails.get(b)).toBe("B5M579G");
    // Lengthened from the front: the six a person may have read are still the last six.
    expect(tails.get(a)!.endsWith(parseId(a).tail())).toBe(true);
    // And nobody else moved.
    expect(tails.get(other)).toBe("0F9G7S");
  });

  it("keeps growing until two ids differ, however far back that is", () => {
    const a = "wi_01M4M899VKXQ000000000000";
    const b = "wi_01M4M899VKYQ000000000000";
    const tails = uniqueTails([a, b]);
    expect(tails.get(a)).toBe("XQ000000000000");
    expect(tails.get(b)).toBe("YQ000000000000");
  });

  it("treats one id twice as one id, and stops when there is nothing left to add", () => {
    expect(uniqueTails([ITEMS[0]!, ITEMS[0]!]).get(ITEMS[0]!)).toBe("0F9G7S");
    // One body under two prefixes cannot be told apart by its tail; the kind glyph does it.
    const tails = uniqueTails(["run_ABCDEFGH", "req_ABCDEFGH"]);
    expect(tails.get("run_ABCDEFGH")).toBe("ABCDEFGH");
    expect(tails.get("req_ABCDEFGH")).toBe("ABCDEFGH");
  });
});

describe("the token as a string", () => {
  it("is the glyph and the tail, and reads back into a kind and a tail", () => {
    const text = idText(ITEMS[1]!);
    expect(text).toBe("⬡ 5M579G");
    expect(parseIdText(text)).toEqual({ kind: "workItem", tail: "5M579G" });
    // A caller's longer tail and an explicit kind for an unprefixed id.
    expect(idText("cae154fb-f778-47ba-ae71-bb4df6bb09e1", { kind: "run", tail: "6bb09e1" })).toBe("☰ 6bb09e1");
  });

  it("is spoken as the kind's word, never the glyph", () => {
    expect(idWords(RUN_ULID)).toBe("run JH7X8P");
    expect(idWords(ITEMS[1]!)).toBe("work item 5M579G");
    // Without a kind there is nothing to say but the tail.
    expect(idWords("run-metrics")).toBe("etrics");
  });

  it("is not mistaken for a decision key, a path or a sentence", () => {
    for (const text of ["auth-store-choice", "src/index.ts", "☰", "☰ two words", "⬡5M579G", "x 5M579G"]) {
      expect(parseIdText(text), text).toBeUndefined();
    }
  });
});
