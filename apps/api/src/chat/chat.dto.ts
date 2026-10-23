import { z } from "zod";

/**
 * The request body, validated before anything else happens.
 *
 * Zod rather than `class-validator`, because the schema is shared in spirit
 * with the rest of this codebase's validation and because `class-validator`
 * infers its rules from property types — the same `emitDecoratorMetadata` this
 * package cannot have.
 */
export const askSchema = z.object({
  question: z.string().min(1).max(2000),
  /**
   * The only way to continue a conversation. History is never accepted from
   * the client: a client-supplied transcript lets a user put words in the
   * assistant's mouth, which the agent then treats as its own earlier answers.
   */
  conversationId: z.string().uuid().optional(),
});
