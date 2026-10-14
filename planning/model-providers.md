# Model Providers

Oct 13, 2026 · @Gabe

How the backend talks to language models so the model can be swapped per task: Claude, an OpenAI model, an open model on Bedrock, or a small self-hosted model. Decisions are D-48 to D-52 in [gap-analysis.md](gap-analysis.md#13-model-providers); open points are Q-21 to Q-23 in [open-questions.md](open-questions.md).

## 1. Summary

- **One internal model interface** in `packages/models`. The agent loop, the check-in writer, the weekly review, and the title generator call it, and never call a provider SDK directly.
- **Adapters** for Anthropic, OpenAI, and any OpenAI-compatible server (Ollama, llama.cpp, vLLM, and many hosted open models). One adapter covers most local and open models.
- **Per-task routing in config.** Each task (`chat.agent`, `checkin.write`, and so on) names a primary model and an optional fallback. Changing models is a config change, not a code change.
- **Claude stays the default** for the chat agent. Small models are tried first on narration tasks: the check-in writer, titles, and summaries.
- **An eval suite gates every change** to the routing config. A model is not switched in for a task until it passes that task's evals.

## 2. Narrating vs. certifying

The design already keeps correctness out of the model, which is what makes swapping models safe:

| The model may | The system certifies, independent of the model |
| --- | --- |
| Choose tools and fill in their arguments | Tools validate every input; `user_id` comes from the auth context only (INV-7) |
| Phrase replies, summaries, and the check-in | Totals, averages, and streaks are computed in SQL (INV-2); the check-in digest is ranked in code before the model sees it (ARCH §7) |
| Propose calendar changes | Nothing is written without a preview and the user's confirmation (INV-3). Confirm and undo replay stored tool input with no model involved (D-13). |
| Resolve "next Friday" to a date | The resolved absolute date is echoed back in the card and the read-back (INV-6, INV-9) |
| Ask for a reminder | The reminder is a row plus an EventBridge schedule (INV-1) |
| Retry a call | Writes are idempotent on `request_id` (INV-4) |

A weaker model makes the assistant less helpful: wrong tool, awkward phrasing, more clarifying questions. It cannot corrupt data, skip a confirmation, or invent a statistic that the UI then displays as fact. These invariants MUST hold for every provider; adapters MUST NOT add a shortcut around them.

## 3. The model interface

`packages/models` exposes one function. Everything provider-specific stays behind it.

```typescript
type ModelTask =
  | "chat.agent" | "chat.title" | "chat.summary"
  | "checkin.write" | "review.write" | "logging.simple";

interface ModelRequest {
  system: string;
  messages: Turn[];               // canonical format, section 4
  tools?: ToolDef[];              // JSON Schema input, same defs the MCP server publishes
  responseFormat?: "text" | { jsonSchema: object };   // voice contract, ARCH §4.1
  maxTokens: number;
  cacheHints?: { system: boolean; tools: boolean };   // honored where the provider supports it
}

type ModelEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "done"; stopReason: "end" | "tool_use" | "max_tokens"; usage: Usage; model: ModelRef };

function streamModel(task: ModelTask, req: ModelRequest, ctx: { userId: string }): AsyncIterable<ModelEvent>;
```

`models.complete(task, req, ctx)` is a convenience wrapper used by the agent loop (ARCH §4): it consumes `streamModel`, forwards `text.delta` events to the SSE stream, and returns the collected canonical content and stop reason.

- **Adapters** implement `stream(req)` for one provider and translate requests, tool definitions, tool results, stop reasons, and streaming events.
- **The agent loop is unchanged:** stream, collect tool calls, run them through the shared tool layer, append the results, and repeat, with the 8-iteration cap (ARCH §4).
- **Structured output:** the voice contract uses the provider's JSON schema or JSON mode where available. Otherwise it falls back to the existing rule: if parsing fails, use the text as `display_text` and the last tool result's `summary` as `spoken_text`.
- **Build, don't buy (default, Q-22):** a thin in-house interface with three adapters is a few hundred lines. It keeps prompt caching, streaming events, and error handling under our control, and keeps the Lambda bundle small. The Vercel AI SDK is the alternative if the adapter count grows.

## 4. Canonical message format and storage

ARCH §6 stores `messages.content` as "Messages API content blocks", which ties stored history to one provider. Instead:

- `messages.content` holds **canonical blocks**: `text`, `tool_call {id, name, input}`, and `tool_result {call_id, content, is_error}`. The shape is close to Anthropic's, so the Anthropic adapter's translation is nearly free.
- Adapters translate canonical history into each provider's format on every call. A conversation can switch models mid-thread; history written under one provider replays under another.
- Provider-only data such as thinking blocks or signatures is not stored in canonical history. If a provider requires it within a single turn, the adapter keeps it in memory for that turn only.
- Each assistant message records which model produced it and the token usage, for debugging, cost tracking, and evals. See [data-model-changes.md §3](data-model-changes.md#3-conversations-history-and-action-cards-d-12-d-13-d-16-d-40--d-46).

## 5. Routing config

A versioned config file in `packages/models`, overridable per environment through an SSM parameter, so a model can be switched or rolled back without a deploy.

```yaml
providers:
  anthropic: { kind: anthropic, secret: llm/anthropic }
  openai:    { kind: openai, secret: llm/openai }                    # optional
  home:      { kind: openai_compatible, base_url: https://llm.example.net/v1, secret: llm/home }  # optional (Q-21)

tasks:
  chat.agent:     { primary: anthropic/claude-sonnet-5-5 }
  logging.simple: { primary: anthropic/claude-haiku-4-5,  fallback: anthropic/claude-sonnet-5-5 }
  chat.title:     { primary: anthropic/claude-haiku-4-5 }
  chat.summary:   { primary: anthropic/claude-haiku-4-5 }
  checkin.write:  { primary: anthropic/claude-haiku-4-5 }
  review.write:   { primary: anthropic/claude-haiku-4-5 }
```

- **Capability check at load time:** each model entry declares `tools`, `streaming`, `json_schema`, and its context window. Startup fails if a task is routed to a model that lacks something the task needs, for example `chat.agent` to a model without tool calling.
- **`logging.simple`** is an optional fast path: a turn that a cheap check marks as a single log entry ("log 45 minutes of capoeira") runs on the smaller model with only the logging tools. Any other turn uses `chat.agent`.
- **Secrets:** one Secrets Manager entry per provider, loaded at module init like the Anthropic key today.

## 6. Fallback and failure

- **When to fall back:** a timeout, 5xx, 429, or connection error **before any text has streamed** retries once on the same model, then moves to the task's `fallback`. The status event tells the app nothing about which model answered.
- **Mid-stream failures do not fall back.** If text has already reached the app, the turn ends with the existing `error` SSE event and `messages.status = 'failed'`. Tool calls that already ran are idempotent (INV-4), so the user can resend safely.
- **Tool-call failures from weak models:** if a model emits a tool call that fails schema validation, the tool returns a validation error as a `tool_result` (a normal tool error), and the loop continues. Two invalid calls in a row on a small model escalate the turn to the task's fallback.
- **Confirmations never involve a model** (D-13), so a provider outage cannot strand a pending card. Confirm, cancel, undo, and renew keep working.

## 7. Where a local or open model can run

| Option | Cost | Strengths | Limits | Fit |
| --- | --- | --- | --- | --- |
| **AWS Bedrock open models** (Llama, Mistral, Amazon Nova, gpt-oss) | Per token, low | Nothing to run; IAM auth; stays in AWS | Not on your own hardware; tool-calling quality varies by model | **Default for "small model on the server"**, through an OpenAI-compatible endpoint where Bedrock offers one for the model, otherwise a fourth adapter on the Bedrock Converse API |
| **Home machine** (Ollama or llama.cpp on a Mac or PC) | Free per token; electricity | Data stays on your hardware; any open model | Lambda reaches it only through a tunnel; down when the machine sleeps; needs a fallback for every task | Optional, for experiments and privacy-sensitive narration (Q-21) |
| **On the phone** (Apple's on-device Foundation Models on iOS 26+; Gemini Nano on some Android phones) | Free | Instant, offline, private | Needs a native Expo module; runs only while the app is open, so it cannot serve check-ins or reviews; separate from the server agent loop | Later: offline read-back and offline quick-log parsing, after Phase 6 |
| GPU instance in AWS | Hundreds of dollars a month | Full control | Cost | **Rejected** |

**Reaching a home machine from Lambda:** expose the model server through Cloudflare Tunnel (or a similar tunnel) as an HTTPS endpoint behind an access token stored in Secrets Manager. Lambda calls it over the NAT like any other provider. Do not open a port on the home network. A mesh VPN such as Tailscale is possible, but in Lambda it needs a userspace networking extension, which adds cold-start time.

## 8. Which tasks suit a small model

| Task | What the model does | Small model? |
| --- | --- | --- |
| `checkin.write` | Formats a pre-ranked digest into a fixed template; MUST NOT add, drop, or reorder items (ARCH §7) | **Good fit.** The eval checks that items match the digest exactly. |
| `chat.title` | 3–6 word title from the first exchange | Good fit |
| `chat.summary` | Rolling summary of older turns (ARCH §11) | Good fit, if summaries are checked for dropped facts |
| `review.write` | Narrates pre-computed weekly stats | Good fit |
| `logging.simple` | One log entry with one tool | Possible, with fallback on validation failure |
| `chat.agent` | Chooses among 20+ tools, resolves dates, plans multi-step changes, drives confirm cards, follows the voice contract | **Poor fit.** 3–8B models make noticeably more tool-choice and date mistakes. Keep a frontier model here. |

## 9. Evals

Swapping models is only as safe as the evals behind it. Build these in Phase 1, next to the first tool:

- **Replay cases:** about 50 real or realistic requests, each with the expected tool calls and key arguments. Examples: "log 45 minutes of capoeira", "move the dentist to Friday", and "what did I train this week". Dates are pinned with a fixed `now`.
- **Checks:** right tool, right arguments (activity, duration, absolute date), no write tool called when only a read was asked for, voice JSON parses, and for `checkin.write`, output items equal digest items in order.
- **Run** against any model with one eval command that takes a task and a model, for example `eval --task chat.agent --model openai/<model>` (the exact command is set at scaffolding). Each task has a pass bar. A routing change merges only with that task's eval results attached.
- Tool implementations run against a test database, so evals exercise real validation, not mocks.

## 10. Privacy and cost

- **What leaves the system:** each call sends the system prompt (profile facts), recent history, and tool results (calendar events, notes, logs) to whichever provider serves that task. Adding a provider widens who sees personal data. The home-machine option is the only one where it stays on your hardware.
- **Provider settings:** use API accounts that do not train on API data by default (true of Anthropic and OpenAI API terms today; confirm when the accounts are opened).
- **Cost:** at one user's volume, model calls are dollars a month on any hosted provider. Prompt caching matters less for cost than for latency. The main reason to use a small model is speed and privacy, not savings.
- **Prompt caching differs:** Anthropic caches explicitly marked prefixes; OpenAI caches long prefixes automatically; local servers keep their own KV cache. The `cacheHints` field lets each adapter do what its provider supports.

## 11. Changes to the source docs

- **Done (Oct 13):** ARCH §4 (agent loop through the model interface), §6 (`messages.content` comment), §7 (check-in writer task), §9 (LLM row), §10 (provider secrets and egress), §11 (gotchas), and §12 (Phase 1 adds the interface and evals).
- **Not changed:** the diagrams still show the Anthropic API as the model provider. That remains the default; add other providers to the diagram once one is actually configured.
