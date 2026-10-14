import type { ToolDef } from "@pa/models";
import type { PendingCard } from "../cards.js";
import type { Queryable } from "../db.js";
import type { LogSource } from "../log-entries.js";
import type { User } from "../users.js";

export type ToolContext = {
  db: Queryable;
  user: User; // from the authenticated context only (INV-7)
  now: Date;
  /** Idempotency key for this call (INV-4), derived by the caller so a retried turn reuses it. */
  requestId: string;
  /** Pre-assigned id for any card this call produces, so it can stream before it is stored. */
  cardId: string;
  source: LogSource;
};

/** Tool output. `result` goes to the model as data (INV-8); errors use the ARCH §5 error shape. */
export type ToolOutcome = {
  result: Record<string, unknown>;
  isError?: boolean;
  card?: PendingCard;
};

export type Tool = {
  def: ToolDef;
  /** Caption for the app's status line while the tool runs (PDF p.17). */
  statusLabel: string;
  run(ctx: ToolContext, input: unknown): Promise<ToolOutcome>;
};

export function toolError(code: string, message: string, retryable = false): ToolOutcome {
  return { result: { error: { code, message, retryable } }, isError: true };
}
