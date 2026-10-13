# Chat Service (Lambda Function URL)

Oct 9, 2026 · @Gabe

How the streaming chat endpoints are deployed (D-38). Everything else in the API stays on API Gateway and Lambda.

## 1. Why a Function URL

| Option | Streams? | Time limit | Cold start | Fixed cost | Verdict |
| --- | --- | --- | --- | --- | --- |
| API Gateway HTTP API + Lambda (current diagram) | No | 30 s | Yes | None | Does not meet BRIEF S3 or ARCH §11 |
| **Lambda Function URL, `RESPONSE_STREAM`** | **Yes** | 15 min | Yes, mitigated by a warm-up request | **None (~$0–1/mo at this volume)** | **Chosen** |
| Lambda Function URL + provisioned concurrency (1) | Yes | 15 min | None | ~$9/mo | Upgrade path if warm-up is not enough (Q-20) |
| ECS Fargate + ALB | Yes | Configurable | None | ~$30–35/mo, mostly the ALB | Rejected on cost; revisit for WebSockets or multiple users |

A chat turn is billed only for its wall time. At about 15 s per turn, 1 GB on ARM, and 50 turns a day, that is roughly 22,500 GB-seconds a month, about $0.30 and inside the Lambda free tier. Function URLs carry no extra charge.

## 2. Topology

```text
Mobile app ──HTTPS──► API Gateway HTTP API ──► Lambda handlers         (REST: /today, /lists, …)
     │
     └──HTTPS (SSE)──► Lambda Function URL (AuthType NONE, InvokeMode RESPONSE_STREAM)
                          └─► "chat" Lambda (Node.js, ARM64, in VPC private app subnets)
                                 ├─► RDS Proxy ─► Postgres
                                 ├─► Tool layer (in-process package, same code as the MCP server)
                                 ├─► Anthropic, Google, embeddings (via NAT)
                                 └─► Secrets Manager (VPC endpoint)
iOS Shortcut ──HTTPS──► Function URL ─► chat Lambda   (POST /v1/shortcut/message)
```

- **One function** (`apps/chat`) routes the three paths it serves: `POST /v1/conversations/{id}/messages`, `POST /v1/shortcut/message`, and `GET /v1/warm`. It imports `packages/agent` (the agent loop) and `packages/services` (domain logic shared with the REST Lambdas and the MCP server, D-2).
- **Tools run in-process.** The function calls the tool functions directly, not the MCP server over HTTP, which saves a network hop per tool call. The MCP server remains for external clients (the Claude app, Claude Code).
- **Check-in and review jobs** are separate Lambdas that import the same `packages/agent`.
- **Defined in the existing SAM stack** as `AWS::Serverless::Function` with `FunctionUrlConfig: { AuthType: NONE, InvokeMode: RESPONSE_STREAM }`. No new services to operate.

## 3. Function configuration

| Setting | Value | Notes |
| --- | --- | --- |
| Runtime | Node.js (current LTS), `arm64` | Response streaming is native on the Node.js managed runtime (`awslambda.streamifyResponse`) |
| Memory | 1024 MB | Mostly I/O-bound; memory also scales CPU, which speeds up the cold start |
| Timeout | 300 s | Well above the longest expected turn (8 tool iterations, ARCH §4) |
| Reserved concurrency | 5 | Caps cost and blast radius, since the URL is public; a single user rarely needs more than 1–2 |
| Provisioned concurrency | 0 (default) | Set to 1 only if cold starts remain noticeable (Q-20) |
| VPC | Private app subnets, same security group as the REST Lambdas | Reaches RDS Proxy |
| Logs | CloudWatch, same rules as ARCH §10 | No message bodies at INFO |

## 4. Cold starts and warm-up

A cold start (runtime init, secret fetch, database connection) adds roughly 1–2 s to the first turn after the function has sat idle. Mitigations, in order:

1. **Do expensive init outside the handler.** Fetch secrets, create the RDS Proxy connection, create the Anthropic client, and load the JWKS at module load, so a warm invocation reuses them.
2. **The app warms the function before it is needed.** It sends `GET /v1/warm` when the Chat tab gains focus, when the mic is pressed, and when the composer gets focus, at most once every 2 minutes. The endpoint is unauthenticated, does no work beyond the module-level init, and returns `204`. By the time the user finishes speaking or typing, the function is usually warm.
3. **If that is not enough,** set provisioned concurrency to 1 (about $9 a month).

## 5. Auth and abuse protection

The Function URL uses `AuthType NONE`. IAM auth would require the app to sign requests with SigV4. So the function verifies callers itself:

- **Cognito JWT:** verify the access token with `aws-jwt-verify` against the user pool JWKS (cached across invocations), checking `token_use = access` and the client ID. `user_id` is resolved from `sub` (INV-7).
- **Shortcut tokens:** on `POST /v1/shortcut/message` only, hash the token and look it up in `shortcut_tokens`. Update `last_used_at`.
- **Rejected requests still cost an invocation,** a few milliseconds each. Reserved concurrency (5) bounds the damage, and a per-user token bucket in Postgres limits valid callers.
- **Optional:** put CloudFront in front of the Function URL. That adds AWS WAF rate limiting and a custom domain, with streaming passed through. It stays in the free tier at this volume and is not needed for V1. Locking the URL to CloudFront only (Origin Access Control, which switches the URL to `AWS_IAM`) has a catch: POST requests must then carry an `x-amz-content-sha256` payload hash from the client.

## 6. Streaming details

- Wrap the handler with `awslambda.streamifyResponse`. Set `Content-Type: text/event-stream` and `Cache-Control: no-cache` through `awslambda.HttpResponseStream.from(...)`, and write each SSE event as it is produced.
- Send a `: ping` comment line every 15 s, so mobile networks do not drop a quiet stream during long tool calls.
- **Limits:** a streamed response can be up to 20 MB, and bandwidth is throttled after the first 6 MB. A chat turn is a few KB.
- **Client disconnect:** the invocation keeps running when the app disconnects. Finish the turn, persist it, and let the app pick it up by replaying `client_message_id` (D-16). Never abandon a write halfway.
- **One active turn per conversation:** a second send to the same conversation while one is running gets `409 turn_in_progress`. Enforce this with a Postgres advisory lock on the conversation ID.
- **Local development:** the same handler runs under a small Node HTTP adapter for local testing. `sam local` does not emulate response streaming.

## 7. Discovering the URL

Function URLs have the form `https://<url-id>.lambda-url.us-west-2.on.aws/`. The URL is stable for the life of the function, but changes if the function is ever replaced. To avoid hard-coding it:

- The app reads it from `GET /me` → `endpoints.chat_base_url`, which the REST API takes from the stack output. The app caches it for offline startup.
- **Settings → Siri Shortcut** shows the full Shortcut endpoint with Copy, next to the token, because the user pastes it into the Shortcut once. If the URL ever changes, the Shortcut must be updated. Adding CloudFront with a custom domain (section 5) removes this risk.

## 8. Cost (us-west-2, order of magnitude)

| Item | Monthly |
| --- | --- |
| Chat Lambda, ~1,500 turns × 15 s × 1 GB ARM | ~$0.30, usually covered by the free tier |
| Warm-up pings | Negligible |
| Function URL | $0 |
| **Total added** | **~$0–1** |
| *Optional:* provisioned concurrency 1 × 1 GB | *+~$9* |
| *Optional:* CloudFront + WAF | *CloudFront in free tier; WAF ~$6+* |

## 9. Changes to the source docs

- **Done (Oct 9):** ARCH §3 (entry points table), ARCH §11 (timeout, cold start, public URL, and streaming gotchas), and both diagrams in `docs/diagrams/`.
- **Done (Oct 9):** ARCH §12 build order. Phase 1 includes the Chat Lambda and its Function URL, phase 2 the REST API, and phase 6 the warm-up call and the Shortcut on the Function URL.
