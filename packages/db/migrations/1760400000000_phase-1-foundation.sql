-- Up Migration
-- Phase 1 tables: ARCH §6 plus the planning/data-model-changes.md deltas they need.
-- Later phases add notes, reminders, lists, chores, checkins, and search columns.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub        text UNIQUE NOT NULL,
  display_name       text,
  timezone           text NOT NULL DEFAULT 'America/Los_Angeles',
  phone_e164         text,
  email              text,
  profile            jsonb NOT NULL DEFAULT '{}',
  channels_enabled   jsonb NOT NULL DEFAULT '{"push":true,"email":true,"sms":false}',
  custom_vocabulary  text[] NOT NULL DEFAULT '{}',
  phone_verified_at  timestamptz,
  checkin_schedule   text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id),
  category              text NOT NULL CHECK (category IN ('habit','training','study','other')),
  slug                  text NOT NULL,
  name                  text NOT NULL,
  aliases               text[] NOT NULL DEFAULT '{}',
  icon                  text,
  is_favorite           boolean NOT NULL DEFAULT false,
  sort_order            integer NOT NULL DEFAULT 0,
  default_duration_min  integer,
  metric_fields         jsonb NOT NULL DEFAULT '[]',
  habit_target          jsonb,                         -- non-NULL marks a habit, any category (D-5)
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

CREATE TABLE log_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  activity_id   uuid NOT NULL REFERENCES activities(id),
  category      text NOT NULL CHECK (category IN ('habit','training','study','other')),
  activity      text NOT NULL,                         -- activity slug, kept for MCP tool compatibility
  variant       text,
  started_at    timestamptz NOT NULL,
  duration_min  integer,
  metrics       jsonb NOT NULL DEFAULT '{}',
  tags          text[] NOT NULL DEFAULT '{}',
  note          text,
  source        text NOT NULL DEFAULT 'chat' CHECK (source IN ('chat','quick_log','habit_chip','shortcut')),
  request_id    uuid UNIQUE,                           -- idempotency (INV-4)
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON log_entries (user_id, category, started_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON log_entries (user_id, activity_id, started_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE conversations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id),
  kind                  text NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','checkin','review','shortcut')),
  title                 text,
  title_source          text NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto','user','fixed')),
  checkin_id            uuid,                          -- FK added with the checkins table (Phase 4)
  summary               text,
  last_message_at       timestamptz,
  last_user_message_at  timestamptz,
  last_message_preview  text,
  last_message_role     text CHECK (last_message_role IN ('user','assistant')),
  change_summary        jsonb NOT NULL DEFAULT '[]',
  pending_count         integer NOT NULL DEFAULT 0,
  has_changes           boolean NOT NULL DEFAULT false,
  request_id            uuid UNIQUE,                   -- Idempotency-Key on create (D-16)
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON conversations (user_id, last_message_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON conversations (user_id, kind, last_message_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON conversations (user_id, last_user_message_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  conversation_id    uuid NOT NULL REFERENCES conversations(id),
  role               text NOT NULL CHECK (role IN ('user','assistant')),
  content            jsonb NOT NULL,                   -- canonical blocks: text, tool_call, tool_result (D-49)
  client_message_id  uuid,
  input_mode         text NOT NULL DEFAULT 'text' CHECK (input_mode IN ('text','voice')),
  display_text       text,
  spoken_text        text,
  suggestions        text[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','failed')),
  model              text,                             -- assistant messages only (D-49)
  usage              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON messages (conversation_id, created_at);
CREATE UNIQUE INDEX ON messages (user_id, client_message_id) WHERE client_message_id IS NOT NULL;

CREATE TABLE action_cards (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  message_id          uuid NOT NULL REFERENCES messages(id),
  kind                text NOT NULL CHECK (kind IN ('event','log_entry','reminder','note','list_change','chore')),
  state               text NOT NULL CHECK (state IN
                        ('saved','pending_confirmation','confirmed','cancelled','expired','undone','failed')),
  data                jsonb NOT NULL,
  entity_id           text,
  request_id          uuid,
  tool_name           text NOT NULL,
  tool_input          jsonb,
  confirmation_token  text,
  confirm_expires_at  timestamptz,
  undo_expires_at     timestamptz,
  spoken_caption      text,
  entity_status       text,
  renew_count         integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON action_cards (message_id);
CREATE INDEX ON action_cards (user_id, state) WHERE state = 'pending_confirmation';

-- Down Migration
DROP TABLE action_cards;
DROP TABLE messages;
DROP TABLE conversations;
DROP TABLE log_entries;
DROP TABLE activities;
DROP TABLE users;
