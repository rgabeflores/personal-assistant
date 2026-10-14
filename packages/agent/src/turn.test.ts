import { closePool, getPool } from "@pa/db";
import { ModelRouter, ScriptedAdapter, type ModelEvent, type ModelRequest } from "@pa/models";
import { createConversation, ensureUser } from "@pa/services";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "./events.js";
import { runTurn } from "./turn.js";

const dbUrl = process.env.DATABASE_URL;
const NOW = new Date("2026-10-07T03:00:00Z"); // Oct 6, 8 PM Pacific

const done = (stopReason: "end" | "tool_use") =>
  ({ type: "done", stopReason, usage: { inputTokens: 10, outputTokens: 5 }, model: "anthropic/claude-sonnet-5-5" }) as ModelEvent;

/** Model script for "log 60 minutes of muay thai at 6": a tool call, then a confirmation. */
function logScript(): (ModelEvent[] | ((req: ModelRequest) => ModelEvent[]))[] {
  return [
    [
      { type: "tool_call", id: "call_1", name: "log_entry", input: { category: "training", activity: "Muay Thai", duration_min: 60, started_at: "2026-10-06T18:00:00-07:00" } },
      done("tool_use"),
    ],
    (req) => {
      const last = req.messages.at(-1)!;
      const result = last.content[0]!.type === "tool_result" ? JSON.parse(last.content[0]!.content) : {};
      return [{ type: "text.delta", text: result.summary ?? "?" }, done("end")];
    },
    [{ type: "text.delta", text: "Muay Thai log" }, done("end")], // chat.title
  ];
}

describe.skipIf(!dbUrl)("runTurn (Postgres)", () => {
  const pool = getPool(dbUrl);
  afterAll(closePool);

  async function setup() {
    const user = await ensureUser(pool, `test-${randomUUID()}`);
    const conversation = await createConversation(pool, user);
    return { user, conversation };
  }

  it("logs an entry, streams events, and stores the turn", async () => {
    const { user, conversation } = await setup();
    const adapter = new ScriptedAdapter(logScript());
    const events: ChatStreamEvent[] = [];
    const clientMessageId = randomUUID();

    await runTurn(
      { pool, models: new ModelRouter({ anthropic: adapter }), now: () => NOW },
      { user, conversationId: conversation.id, clientMessageId, text: "log 60 minutes of muay thai at 6", inputMode: "text", source: "chat" },
      (e) => events.push(e),
    );

    expect(events.map((e) => e.type)).toEqual(["turn.started", "status", "card", "text.delta", "turn.completed"]);
    const completed = events.at(-1) as Extract<ChatStreamEvent, { type: "turn.completed" }>;
    expect(completed.message.blocks[0]).toEqual({ type: "text", text: "Logged 60 minutes of Muay Thai, training, today at 6 PM." });
    expect(completed.message.blocks[1]).toMatchObject({ type: "action_card", card: { kind: "log_entry", state: "saved", actions: ["undo"] } });
    expect(completed.conversation).toMatchObject({ title: "Muay Thai log", is_current: true, change_summary: [{ label: "1 logged" }] });

    const rows = await pool.query(`SELECT started_at, duration_min, source FROM log_entries WHERE user_id = $1`, [user.id]);
    expect(rows.rows).toEqual([{ started_at: new Date("2026-10-07T01:00:00Z"), duration_min: 60, source: "chat" }]);

    // The system prompt carries local time and zone (INV-6).
    expect(adapter.requests[0]!.req.system).toContain("2026-10-06T20:00:00-07:00 (America/Los_Angeles)");
  });

  it("replays a finished turn for a repeated client_message_id without writing again", async () => {
    const { user, conversation } = await setup();
    const clientMessageId = randomUUID();
    const input = { user, conversationId: conversation.id, clientMessageId, text: "log 60 minutes of muay thai at 6", inputMode: "text" as const, source: "chat" as const };

    await runTurn({ pool, models: new ModelRouter({ anthropic: new ScriptedAdapter(logScript()) }), now: () => NOW }, input, () => {});
    const replayAdapter = new ScriptedAdapter([]);
    const events: ChatStreamEvent[] = [];
    await runTurn({ pool, models: new ModelRouter({ anthropic: replayAdapter }), now: () => NOW }, input, (e) => events.push(e));

    expect(replayAdapter.requests).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["turn.started", "turn.completed"]);
    const count = await pool.query(`SELECT count(*)::int AS n FROM log_entries WHERE user_id = $1`, [user.id]);
    expect(count.rows[0].n).toBe(1);
  });

  it("re-running a failed turn reuses tool request ids (INV-4)", async () => {
    const { user, conversation } = await setup();
    const clientMessageId = randomUUID();
    const input = { user, conversationId: conversation.id, clientMessageId, text: "log 60 minutes of muay thai at 6", inputMode: "text" as const, source: "chat" as const };

    // First attempt: the tool runs, then the model fails before replying.
    const failing = new ScriptedAdapter([logScript()[0] as ModelEvent[]]);
    const events: ChatStreamEvent[] = [];
    await expect(runTurn({ pool, models: new ModelRouter({ anthropic: failing }), now: () => NOW }, input, (e) => events.push(e))).rejects.toThrow();

    await runTurn({ pool, models: new ModelRouter({ anthropic: new ScriptedAdapter(logScript()) }), now: () => NOW }, input, () => {});
    const count = await pool.query(`SELECT count(*)::int AS n FROM log_entries WHERE user_id = $1`, [user.id]);
    expect(count.rows[0].n).toBe(1);
    const msgs = await pool.query(`SELECT role FROM messages WHERE conversation_id = $1 ORDER BY created_at`, [conversation.id]);
    expect(msgs.rows.map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("replays stored history to the model as alternating canonical turns", async () => {
    const { user, conversation } = await setup();
    const deps = (adapter: ScriptedAdapter) => ({ pool, models: new ModelRouter({ anthropic: adapter }), now: () => NOW });
    await runTurn(deps(new ScriptedAdapter(logScript())), { user, conversationId: conversation.id, clientMessageId: randomUUID(), text: "log 60 minutes of muay thai at 6", inputMode: "text", source: "chat" }, () => {});

    const second = new ScriptedAdapter([[{ type: "text.delta", text: "You trained an hour." }, done("end")]]);
    await runTurn(deps(second), { user, conversationId: conversation.id, clientMessageId: randomUUID(), text: "what did I just log?", inputMode: "text", source: "chat" }, () => {});

    const roles = second.requests[0]!.req.messages.map((m) => `${m.role}:${m.content.map((b) => b.type).join("+")}`);
    expect(roles).toEqual(["user:text", "assistant:tool_call", "user:tool_result", "assistant:text", "user:text"]);
  });

  it("rejects a second turn while one is running", async () => {
    const { user, conversation } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = {
      async *stream() {
        await gate;
        yield { type: "text.delta" as const, text: "ok" };
        yield done("end");
      },
    };
    const deps = { pool, models: new ModelRouter({ anthropic: slow }), now: () => NOW };
    const first = runTurn(deps, { user, conversationId: conversation.id, clientMessageId: randomUUID(), text: "hi", inputMode: "text", source: "chat" }, () => {});
    await new Promise((r) => setTimeout(r, 200));
    await expect(
      runTurn(deps, { user, conversationId: conversation.id, clientMessageId: randomUUID(), text: "hi again", inputMode: "text", source: "chat" }, () => {}),
    ).rejects.toMatchObject({ code: "turn_in_progress", status: 409 });
    release();
    await first;
  });
});
