import { z } from "zod";

/**
 * The request body, validated before anything else happens.
 *
 * Zod rather than `class-validator`, because the schema is shared in spirit
 * with the rest of this codebase's validation and because `class-validator`
 * infers its rules from property types — the same `emitDecoratorMetadata` this
 * package cannot have (ADR-017).
 */
export const askSchema = z.object({
  question: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .max(20)
    .optional(),
});
