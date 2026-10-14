import { AgentError, runTurn, type ChatStreamEvent, type TurnDeps } from "@pa/agent";
import { ModelError } from "@pa/models";
import { createConversation, ensureUser, findByClientMessageId, findMessage, getConversation, toChatMessages, uuidV5 } from "@pa/services";
import type { Authenticate } from "./auth.js";
import { sendError, sendJson, SseWriter, type HttpRequest, type ResponseSink } from "./http.js";

export type AppDeps = TurnDeps & { authenticate: Authenticate };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGES_PATH = /^\/v1\/conversations\/([^/]+)\/messages$/;

/**
 * Routes served by the Chat Lambda's Function URL (chat-service.md §2).
 * POST /v1/conversations is here only until Phase 2 stands up the REST API, which then owns it.
 */
export async function handleRequest(deps: AppDeps, req: HttpRequest, res: ResponseSink): Promise<void> {
  const { method, path } = req;

  if (method === "GET" && path === "/v1/warm") {
    res.start(204, {});
    res.end();
    return;
  }

  const route =
    method === "POST" && path === "/v1/conversations" ? "createConversation"
    : method === "POST" && MESSAGES_PATH.test(path) ? "sendMessage"
    : method === "POST" && path === "/v1/shortcut/message" ? "shortcut"
    : null;
  if (!route) return sendError(res, 404, "not_found", "No such route.");

  if (route === "shortcut") return sendError(res, 501, "not_implemented", "The Shortcut endpoint arrives in Phase 6.");

  const identity = await deps.authenticate(req.headers.authorization);
  if (!identity) return sendError(res, 401, "unauthorized", "Sign in again.");

  const user = await ensureUser(deps.pool, identity.sub);

  if (route === "createConversation") {
    const key = req.headers["idempotency-key"];
    if (key !== undefined && !UUID.test(key)) return sendError(res, 400, "invalid_request", "Idempotency-Key must be a UUID.");
    const conversation = await createConversation(deps.pool, user, { requestId: key });
    return sendJson(res, 201, conversation);
  }

  const conversationId = path.match(MESSAGES_PATH)![1]!;
  if (!UUID.test(conversationId)) return sendError(res, 404, "not_found", "Conversation not found.");

  const body = parseSendMessage(req.body);
  if (typeof body === "string") return sendError(res, 400, "invalid_request", body);

  const turnInput = {
    user,
    conversationId,
    clientMessageId: body.client_message_id,
    text: body.text,
    inputMode: body.input_mode,
    source: "chat" as const,
    sentAt: body.sent_at,
  };

  const wantsJson = (req.headers.accept ?? "").includes("application/json") && !(req.headers.accept ?? "").includes("text/event-stream");
  if (wantsJson) {
    try {
      await runTurn(deps, turnInput, () => {});
    } catch (err) {
      return sendAgentError(res, err);
    }
    const now = new Date();
    const userMsg = await findByClientMessageId(deps.pool, user.id, body.client_message_id);
    const assistantMsg = await findMessage(deps.pool, user.id, uuidV5(`assistant:${body.client_message_id}`));
    const [u, a] = await toChatMessages(deps.pool, [userMsg!, assistantMsg!], user.timezone, now);
    return sendJson(res, 200, {
      conversation: await getConversation(deps.pool, user, conversationId),
      user_message: u,
      assistant_message: a,
      display_text: assistantMsg?.displayText ?? "",
      spoken_text: assistantMsg?.spokenText ?? null,
    });
  }

  const sse = new SseWriter(res);
  try {
    await runTurn(deps, turnInput, (ev: ChatStreamEvent) => sse.send(ev));
    sse.close();
  } catch (err) {
    if (!sse.isStarted) return sendAgentError(res, err);
    logError(err);
    sse.send({ type: "error", error: toApiError(err) });
    sse.close();
  }
}

type SendMessageBody = { client_message_id: string; text: string; input_mode: "text" | "voice"; sent_at?: Date };

function parseSendMessage(raw: string): SendMessageBody | string {
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw || "{}");
  } catch {
    return "Body must be JSON.";
  }
  if (typeof b.client_message_id !== "string" || !UUID.test(b.client_message_id)) return "client_message_id must be a UUID.";
  if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 4000) return "text must be 1–4000 characters.";
  const mode = b.input_mode ?? "text";
  if (mode !== "text" && mode !== "voice") return "input_mode must be text or voice.";
  let sentAt: Date | undefined;
  if (b.sent_at !== undefined) {
    if (typeof b.sent_at !== "string" || Number.isNaN(Date.parse(b.sent_at))) return "sent_at must be an ISO 8601 date-time.";
    sentAt = new Date(b.sent_at);
  }
  return { client_message_id: b.client_message_id, text: b.text, input_mode: mode, sent_at: sentAt };
}

function toApiError(err: unknown) {
  if (err instanceof AgentError) return err.toApi();
  if (err instanceof ModelError) return { code: "model_unavailable", message: "The assistant is unavailable right now. Try again.", retryable: true };
  return { code: "internal", message: "Something went wrong. Try again.", retryable: true };
}

function sendAgentError(res: ResponseSink, err: unknown): void {
  if (err instanceof AgentError) return sendJson(res, err.status, { error: err.toApi() });
  logError(err);
  sendJson(res, 500, { error: toApiError(err) });
}

function logError(err: unknown): void {
  // Error names and messages only; never message bodies (ARCH §10).
  console.error(JSON.stringify({ msg: "turn_failed", name: err instanceof Error ? err.name : "unknown", error: err instanceof Error ? err.message : String(err) }));
}
