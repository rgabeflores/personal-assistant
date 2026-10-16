# Model Providers

Oct 13, 2026 · @Gabe

How the backend talks to language models so the model can be swapped per task: Claude, an OpenAI model, an open model on Bedrock, or a small self-hosted model. Decisions are D-48 to D-53 in [gap-analysis.md](gap-analysis.md#13-model-providers); open points are Q-21, Q-23, and Q-25 in [open-questions.md](open-questions.md).

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

## 5. Providers, catalog, and routing config

Built-in defaults live in `packages/models/src/routing.ts`. The `MODEL_CONFIG` environment variable (JSON) is merged over them by key, so adding a provider, adding a model, or rerouting a task is a config change, not a code change (D-53). In AWS it is the stack parameter `ModelConfig`; locally it is a line in `.env`.

```json
{
  "providers": {
    "openai": { "kind": "openai" },
    "ollama": { "kind": "openai_compatible", "base_url": "http://localhost:11434/v1", "auth": "none" }
  },
  "models": {
    "openai/<model>":     { "tools": true, "streaming": true, "jsonSchema": true,  "contextWindow": 128000 },
    "ollama/llama3.1:8b": { "tools": true, "streaming": true, "jsonSchema": false, "contextWindow": 128000 }
  },
  "routes": {
    "chat.title":    { "primary": "ollama/llama3.1:8b", "fallback": "anthropic/claude-haiku-4-5" },
    "checkin.write": { "primary": "openai/<model>",     "fallback": "anthropic/claude-haiku-4-5" }
  }
}
```

The defaults are the Anthropic provider, the two Claude models, and the routes from Q-16.

| Section | Meaning |
| --- | --- |
| `providers` | `kind` is `anthropic`, `openai`, or `openai_compatible` (Ollama, llama.cpp, vLLM, hosted open models). `base_url` is required for `openai_compatible`. `auth: "none"` marks a local or self-hosted server that takes no key. |
| `models` | The capability catalog, keyed by `provider/model`: `tools`, `streaming`, `jsonSchema`, `contextWindow`. A route to a model missing from the catalog fails at load. |
| `routes` | Primary and optional fallback model for each task. |

- **Validation at load:** startup fails if a route names an unknown provider, a model missing from the catalog, or a model lacking what the task needs. For example, `chat.agent` needs `tools` and `streaming`.
- **Keys:** a provider with `auth: "key"` (the default) reads `<PROVIDER>_API_KEY` from the environment first (`OPENAI_API_KEY`; `api_key_env` overrides the name). In AWS it then reads the Secrets Manager secret `pa/<stage>/llm/<provider>`, and the Chat Lambda may read any secret under that prefix. Only providers that some route uses are resolved. A key read from Secrets Manager is refreshed every 5 minutes, or every 30 seconds while missing, so warm Lambdas pick up a rotated or newly added key without a redeploy. A missing key is logged, and turns routed to that provider fail until the key is added.
- **Populating secrets:** `scripts/deploy.sh` runs `pnpm keys:sync` after `sam deploy`. It reads the deployed `ModelConfig`, takes each routed provider's `<PROVIDER>_API_KEY` from the shell environment (CI) or `.env`, and creates or updates `pa/<stage>/llm/<provider>`. It never prints a value or clears a secret. Keys are not passed as stack parameters, which would leave them in CloudFormation's records of the stack.
- **Local models and deployed Lambdas:** `http://localhost:11434` works with `pnpm dev` only. A deployed Lambda reaches a self-hosted model through the tunnel in section 7.
- **Evals:** `pnpm eval --model <provider>/<model>` runs a suite against any configured model. The provider and its catalog entry come from `MODEL_CONFIG`.
- **`logging.simple`** is an optional fast path: a turn that a cheap check marks as a single log entry ("log 45 minutes of capoeira") runs on the smaller model with only the logging tools. Any other turn uses `chat.agent`.

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

**Reaching a home machine from Lambda:** expose the model server through Cloudflare Tunnel (or a similar tunnel) as an HTTPS endpoint behind an access token stored in Secrets Manager. Lambda calls it over the internet like any other provider. Do not open a port on the home network. A mesh VPN such as Tailscale is possible, but in Lambda it needs a userspace networking extension, which adds cold-start time.

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

## 11. In-app model picker (proposed, Q-25)

Lets the user choose models in Settings without a deploy. It builds on section 5. Not built yet: it needs the REST API (Phase 2) and a mockup.

**Two levels of control:**

| Level | Set by | Stored in |
| --- | --- | --- |
| Which providers exist, their keys, and the model catalog | The operator (you) | `MODEL_CONFIG` and Secrets Manager |
| Which model each task uses | The user, in Settings | `users.model_settings` (jsonb), falling back to the deployment's routes |

**What the user sees** (Settings → Assistant):

- **Chat model**, which drives `chat.agent` and `logging.simple`.
- **Background model**, which drives `chat.title`, `chat.summary`, `checkin.write`, and `review.write`.
- Each list shows only models that are **usable for that choice**:
  - the provider has a key, or `auth: "none"`;
  - the catalog capabilities meet every task in the group;
  - the model passed those tasks' evals (D-52). The catalog gains an `evals` field per model listing the tasks it passed, so an unevaluated model stays hidden.
- A **Default** option follows the deployment's routes, so a config change still reaches users who never picked anything.

**API (added to `openapi.yaml` when built):**

- `GET /models` → `{ groups: [{ id: "chat" | "background", label, current, default, options: [{ ref, label, provider, local: bool }] }] }`
- `PUT /me/model-settings` with `{ chat: ref | null, background: ref | null }`. `null` means Default. The server re-checks that the ref is usable and returns `422 model_unavailable` if not.

**Resolution per request:** the user's choice for the group becomes the task's primary. The deployment's primary becomes its fallback, unless they are the same model. Fallback rules are unchanged (D-51). `messages.model` records what actually answered.

**Keys stay out of the app in V1.** Adding a provider means setting `MODEL_CONFIG` and creating `pa/<stage>/llm/<provider>` with the CLI. The app never sees or sends a key. A later option is a write-only `PUT /model-providers/{id}/key` that stores the key in Secrets Manager. It suits a single user who is also the operator, but it gives the app a path to write secrets.

**Data model:** `ALTER TABLE users ADD COLUMN model_settings jsonb NOT NULL DEFAULT '{}'`, for example `{"chat": "openai/<model>", "background": null}`.

**Mockup gap:** the Settings screens (p.41, p.43) have no model section. A row "Assistant model · Default (Claude Sonnet)" that opens a two-list picker is enough.

## 12. Changes to the source docs

- **Done (Oct 13):** ARCH §4 (agent loop through the model interface), §6 (`messages.content` comment), §7 (check-in writer task), §9 (LLM row), §10 (provider secrets and egress), §11 (gotchas), and §12 (Phase 1 adds the interface and evals).
- **Done (Oct 14):** providers and the model catalog moved into `MODEL_CONFIG` (section 5, D-53), with the OpenAI and OpenAI-compatible adapter in `packages/models`.
- **Not changed:** the diagrams still show the Anthropic API as the model provider. That remains the default; add other providers to the diagram once one is actually configured.
