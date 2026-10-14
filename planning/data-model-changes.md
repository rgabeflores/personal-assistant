# Data Model Changes

Oct 9, 2026 · @Gabe

Schema deltas against ARCH §6 needed to serve the mockups and the [API spec](api/openapi.yaml). Write these as forward migrations after the base schema. ARCH §6 conventions still hold: UUID ids, `timestamptz` in UTC, and `user_id` on every top-level table.

## 1. Activities and habits (D-4, D-5, D-6)

```sql
CREATE TABLE activities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id),
  category              text NOT NULL CHECK (category IN ('habit','training','study','other')),
  slug                  text NOT NULL,                 -- 'muay_thai'; stable key used by tools
  name                  text NOT NULL,                 -- 'Muay Thai' as displayed and spoken
  aliases               text[] NOT NULL DEFAULT '{}',  -- 'kali','escrima' for matching and vocabulary
  icon                  text,                          -- icon key from the app's icon set
  is_favorite           boolean NOT NULL DEFAULT false,
  sort_order            integer NOT NULL DEFAULT 0,
  default_duration_min  integer,
  metric_fields         jsonb NOT NULL DEFAULT '[]',   -- [{key,label,type,unit,min,max}] drives the log sheet
  habit_target          jsonb,                         -- {"per":"day","times":1}; non-NULL marks a habit, any category (D-5)
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

ALTER TABLE log_entries
  ADD COLUMN activity_id uuid REFERENCES activities(id),
  ADD COLUMN variant     text,                         -- 'sparring', 'pads'
  ADD COLUMN source      text NOT NULL DEFAULT 'chat'
                         CHECK (source IN ('chat','quick_log','habit_chip','shortcut'));
-- Backfill activity_id from (user_id, activity) and then make it NOT NULL.
-- Keep log_entries.activity as the slug for MCP tool compatibility, or drop it after backfill.
CREATE INDEX ON log_entries (user_id, activity_id, started_at DESC) WHERE deleted_at IS NULL;
```

`metric_fields` example for Muay Thai: `[{"key":"rounds","label":"Rounds","type":"integer","min":0},{"key":"rpe","label":"Effort (RPE)","type":"scale","min":1,"max":10}]`.

## 2. Users and settings (D-24, D-29, Q-8)

```sql
ALTER TABLE users
  ADD COLUMN channels_enabled    jsonb  NOT NULL DEFAULT '{"push":true,"email":true,"sms":false}',
  ADD COLUMN custom_vocabulary   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN phone_verified_at   timestamptz,
  ADD COLUMN checkin_schedule    text;                 -- 'checkin-<user_id>' (D-19)

-- Proposed with the in-app model picker (Q-25, model-providers.md §11); not in the Phase 1 migration.
ALTER TABLE users
  ADD COLUMN model_settings      jsonb  NOT NULL DEFAULT '{}';  -- {"chat": "openai/<model>", "background": null}
```

## 3. Conversations, history, and action cards (D-12, D-13, D-16, D-40 – D-46)

```sql
CREATE TABLE conversations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id),
  kind                  text NOT NULL DEFAULT 'chat'
                        CHECK (kind IN ('chat','checkin','review','shortcut')),
  title                 text,
  title_source          text NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto','user','fixed')),
  checkin_id            uuid REFERENCES checkins(id),
  summary               text,                          -- rolling summary for model context (ARCH §11)
  -- Denormalized for the History list (D-41); updated on message persist and card state change
  last_message_at       timestamptz,
  last_user_message_at  timestamptz,                   -- "current" = max of this (D-40)
  last_message_preview  text,                          -- <= 140 chars, display text only
  last_message_role     text CHECK (last_message_role IN ('user','assistant')),
  change_summary        jsonb NOT NULL DEFAULT '[]',   -- [{"kind":"log_entry","outcome":"saved","count":1,"label":"1 logged"}]
  pending_count         integer NOT NULL DEFAULT 0,    -- cards awaiting confirmation
  has_changes           boolean NOT NULL DEFAULT false,
  deleted_at            timestamptz,                   -- soft delete, purged after 30 days (Q-15)
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON conversations (user_id, last_message_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON conversations (user_id, kind, last_message_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON conversations (user_id, last_user_message_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE messages
  ADD CONSTRAINT messages_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  ADD COLUMN client_message_id uuid,                   -- idempotency for sends (D-16)
  ADD COLUMN display_text      text,                   -- projection for the app
  ADD COLUMN spoken_text       text,
  ADD COLUMN suggestions       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN status            text NOT NULL DEFAULT 'complete'
                               CHECK (status IN ('complete','failed')),
  ADD COLUMN model             text,                   -- 'anthropic/claude-sonnet-5-5'; assistant messages only (D-49)
  ADD COLUMN usage             jsonb;                  -- {"input_tokens":…,"output_tokens":…,"cached_tokens":…}
-- messages.content holds canonical blocks (text, tool_call, tool_result), not one provider's format (D-49).
CREATE UNIQUE INDEX ON messages (user_id, client_message_id) WHERE client_message_id IS NOT NULL;

CREATE TABLE action_cards (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  message_id          uuid NOT NULL REFERENCES messages(id),
  kind                text NOT NULL CHECK (kind IN ('event','log_entry','reminder','note','list_change','chore')),
  state               text NOT NULL CHECK (state IN
                        ('saved','pending_confirmation','confirmed','cancelled','expired','undone','failed')),
  data                jsonb NOT NULL,                  -- typed payload returned to the app
  entity_id           text,                            -- uuid, or Google event id for events
  request_id          uuid,                            -- original write; used by undo_entry
  tool_name           text NOT NULL,
  tool_input          jsonb,                           -- stored for deterministic confirm (D-13)
  confirmation_token  text,
  confirm_expires_at  timestamptz,
  undo_expires_at     timestamptz,
  spoken_caption      text,
  entity_status       text,                            -- last known state for events (D-45); others resolved on read
  renew_count         integer NOT NULL DEFAULT 0,      -- "Add now" renewals (D-46)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON action_cards (message_id);
CREATE INDEX ON action_cards (user_id, state) WHERE state = 'pending_confirmation';

-- History search (D-43): keyword + semantic over user text and assistant display text only
ALTER TABLE messages
  ADD COLUMN search_text text,                         -- user text or display_text; never tool blocks
  ADD COLUMN search_tsv  tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_text, ''))) STORED;
CREATE INDEX ON messages USING gin (search_tsv);

CREATE TABLE message_embeddings (
  message_id  uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  embedding   vector(1024) NOT NULL,                   -- same model as notes (Q-11)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON message_embeddings USING hnsw (embedding vector_cosine_ops);
```

Embedding runs asynchronously after each turn is persisted: the chat Lambda enqueues the message IDs to SQS, and a small Lambda embeds them. Messages shorter than 3 words ("ok", "Looks good") are keyword-indexed only.

## 4. Reminders and deliveries (D-10, D-21, D-22, D-23)

```sql
ALTER TABLE reminders
  ADD COLUMN completed_at  timestamptz,
  ADD COLUMN snooze_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN updated_at    timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT reminders_chore_fk FOREIGN KEY (chore_id) REFERENCES chores(id);
CREATE INDEX ON reminders (user_id, fire_at) WHERE status <> 'cancelled';

CREATE TABLE deliveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  source_type    text NOT NULL CHECK (source_type IN ('reminder','checkin','test','review')),
  source_id      uuid,
  channel        text NOT NULL CHECK (channel IN ('push','email','sms')),
  status         text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error_code     text,                                 -- 'DeviceNotRegistered', 'sms_undeliverable'
  attempt        integer NOT NULL DEFAULT 1,
  attempted_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON deliveries (source_type, source_id);
CREATE INDEX ON deliveries (user_id, attempted_at DESC);
```

## 5. Lists, chores, and notes (D-32, D-33, D-34)

```sql
ALTER TABLE lists
  ADD COLUMN sort_order  integer NOT NULL DEFAULT 0,
  ADD COLUMN created_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deleted_at  timestamptz;

ALTER TABLE list_items
  ADD COLUMN request_id  uuid UNIQUE,
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();

ALTER TABLE chores
  ADD COLUMN request_id   uuid UNIQUE,
  ADD COLUMN remind_time  time,                        -- local time for the due-day reminder
  ADD COLUMN created_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deleted_at   timestamptz;

CREATE TABLE chore_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chore_id     uuid NOT NULL REFERENCES chores(id),
  kind         text NOT NULL CHECK (kind IN ('done','skipped')),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  prev_due_at  timestamptz NOT NULL,                   -- restored on undo
  prev_done_at timestamptz,
  request_id   uuid UNIQUE,
  undone_at    timestamptz
);

ALTER TABLE notes
  ADD COLUMN search_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || body)) STORED;
CREATE INDEX ON notes USING gin (search_tsv);
CREATE INDEX ON notes USING hnsw (embedding vector_cosine_ops);
```

## 6. Integrations and shortcut tokens (D-27, D-28)

```sql
ALTER TABLE integrations
  ADD COLUMN status           text NOT NULL DEFAULT 'connected'
                              CHECK (status IN ('connected','expired','disconnected')),
  ADD COLUMN account_email    text,
  ADD COLUMN calendar_ids     text[] NOT NULL DEFAULT '{primary}',   -- Q-10
  ADD COLUMN connected_at     timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_synced_at   timestamptz,
  ADD COLUMN last_error_at    timestamptz,
  ADD COLUMN last_error_code  text;

ALTER TABLE shortcut_tokens
  ADD COLUMN prefix        text NOT NULL DEFAULT 'pa_',
  ADD COLUMN last4         text NOT NULL,
  ADD COLUMN created_at    timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_used_at  timestamptz;

ALTER TABLE push_tokens
  ADD COLUMN app_version  text,
  ADD COLUMN created_at   timestamptz NOT NULL DEFAULT now();
```

## 7. Idempotency for REST writes (D-16)

Most write tables already have a `request_id UNIQUE` column, which the REST `Idempotency-Key` header maps onto. Some operations have no single row to carry it: list create, clear-checked, settings updates, and card confirm. For those, add a small response cache:

```sql
CREATE TABLE idempotency_keys (
  user_id      uuid NOT NULL REFERENCES users(id),
  key          uuid NOT NULL,
  route        text NOT NULL,                          -- 'POST /lists/{id}/clear-checked'
  status_code  integer NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
-- Purge rows older than 24 hours.
```
