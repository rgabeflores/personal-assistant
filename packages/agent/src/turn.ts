import type { ModelRouter, ModelTask, Block, Turn, Usage, ModelRef } from "@pa/models";
import {
  getConversation,
  findByClientMessageId,
  findMessage,
  inTransaction,
  insertAssistantMessage,
  insertCards,
  insertUserMessage,
  loadHistory,
  refreshConversationSummary,
  setTitle,
  toApiCard,
  toChatMessages,
  toolByName,
  TOOLS,
  uuidV5,
  type InputMode,
  type LogSource,
  type PendingCard,
  type Tool,
  type User,
} from "@pa/services";
import type pg from "pg";
import { AgentError, type ChatStreamEvent } from "./events.js";
import { buildSystemPrompt, TITLE_SYSTEM_PROMPT } from "./prompt.js";

export const MAX_TOOL_ITERATIONS = 8; // ARCH §4

export type TurnDeps = {
  pool: pg.Pool;
  models: ModelRouter;
  tools?: Tool[];
  now?: () => Date;
  task?: ModelTask;
};

export type TurnInput = {
  user: User;
  conversationId: string;
  clientMessageId: string;
  text: string;
  inputMode: InputMode;
  source: LogSource;
  sentAt?: Date;
};

export type Emit = (ev: ChatStreamEvent) => void;

/**
 * Runs one chat turn (ARCH §4): stores the user message, runs the tool loop through the model
 * router, persists the assistant message and its cards, and emits SSE events as it goes.
 *
 * Retrying with the same client_message_id is safe (D-16): a finished turn is replayed, and a
 * re-run derives the same request ids, so tool writes are not duplicated (INV-4).
 */
export async function runTurn(deps: TurnDeps, input: TurnInput, emit: Emit): Promise<void> {
  const { pool, models } = deps;
  const tools = deps.tools ?? TOOLS;
  const now = deps.now?.() ?? new Date();
  const { user } = input;
  const assistantId = uuidV5(`assistant:${input.clientMessageId}`);

  const conversation = await getConversation(pool, user, input.conversationId);
  if (!conversation) throw new AgentError(404, "not_found", "Conversation not found.");

  const existingUser = await findByClientMessageId(pool, user.id, input.clientMessageId);
  if (existingUser) {
    const stored = await pool.query(`SELECT conversation_id FROM messages WHERE id = $1`, [existingUser.id]);
    if (stored.rows[0]?.conversation_id !== input.conversationId)
      throw new AgentError(409, "client_message_id_reused", "This message id was already used in another conversation.");
    const done = await findMessage(pool, user.id, assistantId);
    if (done) {
      emit({ type: "turn.started", user_message_id: existingUser.id, assistant_message_id: assistantId });
      await emitCompleted(pool, user, input.conversationId, assistantId, now, emit);
      return;
    }
  }

  // One running turn per conversation (chat-service.md §6). Session-level lock on a dedicated client.
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [input.conversationId]);
    if (!rows[0]?.ok) throw new AgentError(409, "turn_in_progress", "A reply is still being written for this conversation.", true);
    try {
      const userMessage =
        existingUser ??
        (await insertUserMessage(pool, {
          userId: user.id,
          conversationId: input.conversationId,
          clientMessageId: input.clientMessageId,
          text: input.text,
          inputMode: input.inputMode,
          sentAt: input.sentAt,
        }));
      emit({ type: "turn.started", user_message_id: userMessage.id, assistant_message_id: assistantId });

      const result = await runLoop(deps, tools, input, now, emit);

      const cards = result.cards;
      const displayText = result.text || (cards.length ? "" : "Done.");
      await inTransaction(pool, async (tx) => {
        await insertAssistantMessage(tx, {
          id: assistantId,
          userId: user.id,
          conversationId: input.conversationId,
          content: result.content,
          displayText,
          spokenText: cards.at(-1)?.spokenCaption ?? null,
          inputMode: input.inputMode,
          status: "complete",
          model: result.model,
          usage: result.usage,
        });
        await insertCards(tx, user.id, assistantId, cards);
        await refreshConversationSummary(tx, input.conversationId);
      });

      if (!conversation.title && conversation.title_source === "auto") {
        await generateTitle(deps, input.conversationId, input.text, displayText);
      }
      await emitCompleted(pool, user, input.conversationId, assistantId, now, emit);
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [input.conversationId]);
    }
  } finally {
    lockClient.release();
  }
}

type LoopResult = { content: Block[]; text: string; cards: PendingCard[]; model: ModelRef | null; usage: Usage };

async function runLoop(deps: TurnDeps, tools: Tool[], input: TurnInput, now: Date, emit: Emit): Promise<LoopResult> {
  const { user } = input;
  const history = await loadHistory(deps.pool, input.conversationId);
  const messages: Turn[] = history;
  const content: Block[] = [];
  const cards: PendingCard[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const textParts: string[] = [];
  let model: ModelRef | null = null;
  let toolCallIndex = 0;
  const streamText = input.inputMode === "text"; // voice turns send no text.delta (D-15)

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let segmentStarted = false;
    const res = await deps.models.complete(
      deps.task ?? "chat.agent",
      {
        system: buildSystemPrompt(user, now),
        messages,
        tools: tools.map((t) => t.def),
        maxTokens: 2048,
        cacheHints: { system: true, tools: true },
      },
      {
        onText: (text) => {
          if (!streamText) return;
          if (!segmentStarted && textParts.length) emit({ type: "text.delta", text: "\n\n" });
          segmentStarted = true;
          emit({ type: "text.delta", text });
        },
      },
    );
    model = res.model;
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.cachedTokens = (usage.cachedTokens ?? 0) + (res.usage.cachedTokens ?? 0);

    messages.push({ role: "assistant", content: res.content });
    content.push(...res.content);
    for (const b of res.content) if (b.type === "text" && b.text.trim()) textParts.push(b.text.trim());

    const calls = res.content.filter((b) => b.type === "tool_call");
    if (res.stopReason !== "tool_use" || !calls.length) break;

    const results: Block[] = [];
    for (const call of calls) {
      const n = toolCallIndex++;
      const tool = toolByName(call.name, tools);
      if (!tool) {
        results.push({ type: "tool_result", call_id: call.id, content: JSON.stringify({ error: { code: "unknown_tool", message: `No tool named ${call.name}`, retryable: false } }), is_error: true });
        continue;
      }
      emit({ type: "status", label: tool.statusLabel, tool: tool.def.name });
      let outcome;
      try {
        outcome = await tool.run(
          {
            db: deps.pool,
            user,
            now,
            requestId: uuidV5(`${input.clientMessageId}:tool:${n}`),
            cardId: uuidV5(`${input.clientMessageId}:card:${n}`),
            source: input.source,
          },
          call.input,
        );
      } catch (err) {
        console.error(JSON.stringify({ msg: "tool_failed", tool: call.name, error: err instanceof Error ? err.message : String(err) }));
        outcome = { result: { error: { code: "internal", message: "The tool failed. Tell the user and suggest trying again.", retryable: true } }, isError: true };
      }
      if (outcome.card) {
        cards.push(outcome.card);
        emit({ type: "card", card: toApiCard(outcome.card, user.timezone, now) });
      }
      results.push({ type: "tool_result", call_id: call.id, content: JSON.stringify(outcome.result), is_error: outcome.isError });
    }
    messages.push({ role: "user", content: results });
    content.push(...results);

    if (i === MAX_TOOL_ITERATIONS - 1) {
      const note = "I couldn't finish that in one go. Tell me what's left and I'll pick it up.";
      textParts.push(note);
      content.push({ type: "text", text: note });
      if (streamText) emit({ type: "text.delta", text: `\n\n${note}` });
    }
  }

  return { content, text: textParts.join("\n\n"), cards, model, usage };
}

async function generateTitle(deps: TurnDeps, conversationId: string, userText: string, reply: string): Promise<void> {
  try {
    const res = await deps.models.complete("chat.title", {
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: `User: ${userText}\nAssistant: ${reply}` }] }],
      maxTokens: 30,
    });
    const title = res.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
      .trim()
      .replace(/^["']|["'.]$/g, "")
      .slice(0, 80);
    if (title) await setTitle(deps.pool, conversationId, title);
  } catch (err) {
    // A missing title is cosmetic; the next turn tries again.
    console.warn(JSON.stringify({ msg: "title_failed", error: err instanceof Error ? err.message : String(err) }));
  }
}

async function emitCompleted(
  pool: pg.Pool,
  user: User,
  conversationId: string,
  assistantId: string,
  now: Date,
  emit: Emit,
): Promise<void> {
  const assistant = await findMessage(pool, user.id, assistantId);
  const conversation = await getConversation(pool, user, conversationId);
  if (!assistant || !conversation) throw new AgentError(500, "internal", "Turn was not stored.", true);
  const [message] = await toChatMessages(pool, [assistant], user.timezone, now);
  emit({ type: "turn.completed", message: message!, conversation });
}
