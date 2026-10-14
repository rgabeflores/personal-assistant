# Personal Assistant

A single-user personal assistant: an Expo mobile app, a chat agent with tools, and a small AWS backend. Product and architecture docs are in [`docs/product/`](docs/product/); pre-build decisions, open questions, and the API spec are in [`planning/`](planning/README.md).

## Layout

| Path | What |
| --- | --- |
| `apps/chat` | Chat Lambda behind a streaming Function URL: chat turns, warm-up, Shortcut (Phase 6). Includes a local HTTP adapter. |
| `apps/mobile` | Expo app (Expo Router). Phase 1: sign-in and one chat screen. |
| `packages/models` | Provider-neutral model interface, adapters, and per-task routing (`planning/model-providers.md`) |
| `packages/agent` | The agent turn loop (ARCH §4) |
| `packages/services` | Domain logic and tools, shared by the Chat Lambda, REST API (Phase 2), and MCP server |
| `packages/db` | Postgres pool, SQL migrations (`node-pg-migrate`), and the migration Lambda |
| `evals` | Replay evals that gate model routing changes |
| `infra` | SAM template |

Tooling: pnpm workspaces, TypeScript, Vitest, esbuild bundles for Lambda, plain SQL migrations, and `pg` without an ORM.

## Local development

Needs Node 22+, pnpm (`corepack enable`), and Docker.

```sh
pnpm install
cp .env.example .env            # add ANTHROPIC_API_KEY
pnpm dev                        # Postgres 16 + pgvector (Docker), migrations, chat API on :8787
pnpm test                       # unit + Postgres integration tests (in another terminal)
```

The dev server treats requests without a token as `DEV_AUTH_SUB`. Try a turn:

```sh
CONV=$(curl -s -X POST localhost:8787/v1/conversations | jq -r .id)
curl -N localhost:8787/v1/conversations/$CONV/messages -H 'accept: text/event-stream' \
  -d "{\"client_message_id\":\"$(uuidgen | tr A-Z a-z)\",\"text\":\"log 45 minutes of capoeira\"}"
```

The app:

```sh
cd apps/mobile
cp .env.example .env            # EXPO_PUBLIC_CHAT_BASE_URL=http://<your LAN IP>:8787 for a device
npx expo start
```

Phase 1 runs in Expo Go. Voice (Phase 6) needs an EAS development build.

### Why not `sam local` or LocalStack for the chat API

Neither can stream a Function URL response: `sam local start-api` emulates only API Gateway routes, and LocalStack's Lambda returns streamed responses in one piece. The chat API therefore runs locally through `apps/chat/src/dev-server.ts`, which calls the same request handler as the Lambda.

- **REST API (Phase 2):** runs on API Gateway, so `sam local start-api` works for it. It joins `pnpm dev` then.
- **Cognito:** local requests act as `DEV_AUTH_SUB`. To test real sign-in, set `USER_POOL_ID` and `USER_POOL_CLIENT_ID` in `.env`, and the dev server verifies real tokens from the deployed dev pool.
- **LocalStack:** worth adding in Phase 4 for EventBridge Scheduler, SQS, and SES (all in its free, non-commercial Hobby plan, which needs a LocalStack account). Phase 1 uses no AWS service that needs emulating locally.

## Evals

```sh
pnpm eval                                        # default routing
pnpm eval --model anthropic/claude-haiku-4-5     # try another model on chat.agent
```

Any model in the catalog can be evaluated. To add one, put its provider, catalog entry, and (if keyed) `<PROVIDER>_API_KEY` in `.env`; see the `MODEL_CONFIG` example in `.env.example` and `planning/model-providers.md` §5.

Runs every case in `evals/cases/` through the real agent loop and tools against the local database. A model is routed to a task only after it clears that suite's pass bar (D-52).

## Deploy

```sh
scripts/deploy.sh CognitoDomainPrefix=<globally-unique-prefix>
```

This builds the bundles, deploys `infra/template.yaml` to `us-west-2`, and runs migrations through the migration Lambda, which also creates the IAM-authenticated `app` database role.

The Lambdas run outside any VPC. Postgres has a public endpoint with forced TLS, and the Lambdas sign in with IAM database authentication. There is no NAT gateway or RDS Proxy (ARCH §10, Q-24). The baseline cost is about $17 a month, mostly the `db.t4g.micro` instance.

After the first deploy:

1. Put the Anthropic key in the `pa/dev/llm/anthropic` secret. Other providers: create `pa/dev/llm/<provider>` and pass the stack parameter `ModelConfig` with that provider, its models, and the routes that use it.
2. Create your user: `aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username <email>` (self sign-up is off, D-31).
3. Set `EXPO_PUBLIC_CHAT_BASE_URL`, `EXPO_PUBLIC_COGNITO_DOMAIN`, and `EXPO_PUBLIC_COGNITO_CLIENT_ID` in `apps/mobile/.env` from the stack outputs, and set `EXPO_PUBLIC_DEV_SKIP_AUTH=false`.
4. To use `psql` from a laptop, sign in as the master user with the password from the RDS-managed secret (`aws secretsmanager get-secret-value --secret-id <MasterUserSecret>`), with `sslmode=verify-full` and `sslrootcert=packages/db/src/rds-ca.pem`.
