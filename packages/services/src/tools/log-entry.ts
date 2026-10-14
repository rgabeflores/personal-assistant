import { CATEGORIES, type Category } from "../activities.js";
import { logEntryCard } from "../cards.js";
import { logEntry } from "../log-entries.js";
import { spokenWhen } from "../time.js";
import { toolError, type Tool } from "./types.js";

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

type Input = {
  category: Category;
  activity: string;
  started_at?: string;
  duration_min?: number;
  variant?: string;
  metrics?: Record<string, unknown>;
  note?: string;
};

function validate(raw: unknown): Input | string {
  if (typeof raw !== "object" || raw === null) return "input must be an object";
  const i = raw as Record<string, unknown>;
  if (!CATEGORIES.includes(i.category as Category)) return `category must be one of ${CATEGORIES.join(", ")}`;
  if (typeof i.activity !== "string" || !i.activity.trim() || i.activity.length > 60) return "activity must be a non-empty string up to 60 characters";
  if (i.started_at !== undefined && (typeof i.started_at !== "string" || !ISO_WITH_OFFSET.test(i.started_at) || Number.isNaN(Date.parse(i.started_at))))
    return "started_at must be ISO 8601 with an explicit offset";
  if (i.duration_min !== undefined && (!Number.isInteger(i.duration_min) || (i.duration_min as number) < 1 || (i.duration_min as number) > 1440))
    return "duration_min must be an integer from 1 to 1440";
  if (i.variant !== undefined && (typeof i.variant !== "string" || i.variant.length > 40)) return "variant must be a string up to 40 characters";
  if (i.metrics !== undefined && (typeof i.metrics !== "object" || i.metrics === null || Array.isArray(i.metrics))) return "metrics must be an object";
  if (i.note !== undefined && (typeof i.note !== "string" || i.note.length > 2000)) return "note must be a string up to 2000 characters";
  return i as Input;
}

export const logEntryTool: Tool = {
  statusLabel: "Logging it…",
  def: {
    name: "log_entry",
    description:
      "Log a habit, training, or study session. Use for anything the user did that they want recorded " +
      "(\"did 45 minutes of capoeira\", \"breathing done\"). Resolve relative times to an absolute started_at " +
      "in the user's timezone; omit started_at for \"just now\".",
    inputSchema: {
      type: "object",
      properties: {
        category: { enum: [...CATEGORIES], description: "habit, training, study, or other" },
        activity: { type: "string", maxLength: 60, description: "Activity name as the user says it, e.g. 'Muay Thai'" },
        started_at: { type: "string", format: "date-time", description: "ISO 8601 with offset; defaults to now" },
        duration_min: { type: "integer", minimum: 1, maximum: 1440 },
        variant: { type: "string", maxLength: 40, description: "e.g. 'sparring', 'pads'" },
        metrics: { type: "object", description: "e.g. {\"rounds\":6,\"rpe\":8} or {\"pages\":20}" },
        note: { type: "string", maxLength: 2000 },
      },
      required: ["category", "activity"],
      additionalProperties: false,
    },
  },

  async run(ctx, raw) {
    const input = validate(raw);
    if (typeof input === "string") return toolError("invalid_input", input);

    const { entry } = await logEntry(
      ctx.db,
      ctx.user,
      {
        activity: input.activity,
        category: input.category,
        variant: input.variant,
        startedAt: input.started_at ? new Date(input.started_at) : undefined,
        durationMin: input.duration_min,
        metrics: input.metrics,
        note: input.note,
      },
      { requestId: ctx.requestId, source: ctx.source, now: ctx.now },
    );

    const what = entry.duration_min ? `${entry.duration_min} minutes of ${entry.activity_name}` : entry.activity_name;
    const summary = `Logged ${what}, ${entry.category}, ${spokenWhen(new Date(entry.started_at), ctx.user.timezone, ctx.now)}.`;

    return {
      result: {
        entry_id: entry.id,
        activity: entry.activity_name,
        category: entry.category,
        started_at: entry.started_at,
        duration_min: entry.duration_min,
        summary,
      },
      card: logEntryCard(ctx.cardId, entry, ctx.requestId, raw, summary, ctx.now),
    };
  },
};
