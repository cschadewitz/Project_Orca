/**
 * Message envelope. Three kinds travel over a connection: a client `request` (`id` +
 * `method` + `params`), the daemon's `response` to it (`result` or `error`, never both),
 * and daemon-initiated `notification`s (no `id`; the event stream once subscriptions
 * exist). Each method's `params`/`result` are typed by their own schema in the method's
 * module; the envelope keeps them `unknown` so it can carry methods it does not know.
 */
import { z } from "zod";
import { ProtocolErrorSchema } from "./errors.js";

export const RequestIdSchema = z.union([z.string().min(1), z.number().int()]);
export type RequestId = z.infer<typeof RequestIdSchema>;

export const RequestMessageSchema = z.object({
  kind: z.literal("request"),
  id: RequestIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RequestMessage = z.infer<typeof RequestMessageSchema>;

export const ResponseMessageSchema = z.discriminatedUnion("ok", [
  z.object({ kind: z.literal("response"), id: RequestIdSchema, ok: z.literal(true), result: z.unknown() }),
  z.object({ kind: z.literal("response"), id: RequestIdSchema, ok: z.literal(false), error: ProtocolErrorSchema }),
]);
export type ResponseMessage = z.infer<typeof ResponseMessageSchema>;

export const NotificationMessageSchema = z.object({
  kind: z.literal("notification"),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type NotificationMessage = z.infer<typeof NotificationMessageSchema>;

// A plain union: the two response shapes share `kind`, which a discriminated union on
// `kind` refuses. Three members, so the cost is nil.
export const MessageSchema = z.union([RequestMessageSchema, ResponseMessageSchema, NotificationMessageSchema]);
export type Message = z.infer<typeof MessageSchema>;

/** Parse one JSON text frame into a message, or `undefined` when it is not one. */
export function parseMessage(text: string): Message | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = MessageSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
