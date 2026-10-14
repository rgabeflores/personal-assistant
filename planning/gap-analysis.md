# Gap Analysis and Decisions

Oct 9, 2026 · @Gabe

Each item below is something the mockups or the UI brief need that the architecture doc does not yet define, or a place where the docs disagree. Each item ends with the decision this plan adopts. Decision IDs (`D-1`…) are stable; the API spec and data model deltas cite them. Anything that still needs an owner's call is in [open-questions.md](open-questions.md).

## 1. Mobile API surface

### D-1 The app needs a REST API alongside chat

- **Gap:** ARCH §2 principle 4 says "fast paths skip the LLM", and ARCH §4.1 mentions `GET /vocabulary` and `POST /shortcut/message`, but no other HTTP endpoints are defined. Every non-chat screen (S2, S4–S9) needs read endpoints, and quick-log, checkboxes, swipes, and settings need direct writes.
- **Decision:** add a versioned REST API (`/v1`) behind the existing API Gateway and Cognito JWT authorizer. Specified in [api/openapi.yaml](api/openapi.yaml).

### D-2 REST handlers and MCP tools share one service layer

- **Gap:** ARCH §2 principle 1 ("one tool layer, many clients") predates the REST API. Without a rule, REST handlers could drift from tool behavior on idempotency, timezone handling, and scheduling.
- **Decision:** domain logic lives in a shared service module (`services/*`). MCP tools and REST handlers are thin adapters over it. Both enforce INV-4 (idempotency), INV-5 (UTC storage), and INV-7 (`user_id` from auth only). REST endpoints MUST NOT write the calendar without the confirm flow (INV-3, see D-13).

### D-3 Every tool action needs a REST equivalent, and the reverse

- **Gap:** BRIEF §2 principle 1 says anything on a screen can also be asked in chat. The mockups add actions that have no tool: snooze, edit time, and retry a reminder (PDF p.39); skip a chore once (p.31); create a list and clear checked items (p.29); edit, delete, and remove a reminder on a note (p.37); delete a log entry (BRIEF S4).
- **Decision:** add these tools to ARCH §5: `reminder_update` (covers snooze and edit time), `reminder_complete`, `chore_skip`, `list_create`, `list_clear_checked`, `note_update`, `note_delete`, `entry_delete`. Confirm-first stays limited to calendar writes.

## 2. Logging, activities, and habits (S2, S4, S5)

### D-4 Add an activity catalog

- **Evidence:** PDF p.3 and p.21. Tiles show an icon, a name, and the last-logged date and duration. The log sheet shows per-activity metric fields (Rounds, an RPE 1–10 slider) and a default duration. Tiles are favorites with an order (C7: long-press to edit or remove).
- **Gap:** `log_entries.activity` is free text. Nothing stores icons, favorites, ordering, metric definitions, or default durations.
- **Decision:** add an `activities` table (see [data-model-changes.md](data-model-changes.md)) and an `activity_id` foreign key on `log_entries`. `log_entry` called from chat with an unknown activity creates a non-favorite activity, so chat logging never fails on a new name. The catalog also feeds `GET /vocabulary` (ARCH §4.1).

### D-5 Habits are activities flagged as habits

- **Evidence:** PDF p.1 shows habit chips with a streak count and a done-today state. BRIEF §10 left open whether habits are configured in Settings or created on first log. The Insights habit grid (p.4) colors each habit by its category: Language practice uses the study color, and the Today chip on p.1 uses the same dot. So a habit is not limited to `category = 'habit'`.
- **Decision:** a habit is any `activities` row with a non-null `habit_target` (V1: daily only), regardless of category. Category still drives color, totals, and the Quick log segment; Language practice is a study activity that is also a habit. Habits can be created from Quick log ("+", PDF p.3) or on first log from chat. Streaks are computed in SQL (INV-2) over local dates in the user's timezone. Non-daily cadences are **Q-4**.

### D-6 Log entries carry a variant label

- **Evidence:** PDF p.3, "Muay Thai — sparring"; PDF p.13, "Rounds 6 · pads".
- **Decision:** add `log_entries.variant` (short free text such as "sparring" or "pads"). The UI renders it as `Activity — variant`. Analytics group by activity, not variant.

### D-7 "Last logged" and defaults are computed by the server

- **Decision:** `GET /activities` returns `last_logged_at`, `last_duration_min`, and `default_duration_min`, which falls back to the last duration. The client formats relative labels ("Mon", "Last Wed", "Sep 29").

## 3. Today screen (S2)

### D-8 One aggregate endpoint for Today

- **Evidence:** PDF p.1 combines the check-in, schedule, due items, and habits on one screen. BRIEF §7 requires skeletons and offline cached data.
- **Decision:** `GET /today` returns the whole screen in one payload, so the screen loads in one round trip and caches as one unit for offline use.

### D-9 Calendar events are classified by category

- **Evidence:** PDF p.1 shows a category on each Google event ("Habit · Done", "Training · Downtown gym", "Other · In progress"). PDF p.13 shows a Training tag on the Capoeira event card.
- **Gap:** Google events have no category.
- **Decision:** the calendar service classifies each event:
  1. Events created by the assistant store `pa_activity_id` in Google `extendedProperties.private`, and that wins.
  2. Otherwise, case-insensitive match of the title against activity names and aliases.
  3. Otherwise `other`.

  `done` is true when a non-deleted log entry for that activity exists on the event's local date. `In progress` is derived on the client from the current time. Whether title matching is acceptable is **Q-10**.

### D-10 "Due today" is a union of reminders and chores

- **Evidence:** PDF p.1. Reminder rows ("Car registration · Critical") and chore rows ("2 days overdue") are checkable.
- **Gap:** reminders have no "done" state, only a delivery `status`.
- **Decision:** add `reminders.completed_at`, separate from delivery status. Due today means reminders whose `fire_at` falls on today's local date and are not completed or cancelled, plus chores that are overdue or due today. Overdue day counts are computed by the server in the user's timezone.

### D-11 Today's check-in card before the check-in is sent

- **Gap:** before `checkin_time`, or when the check-in was skipped, no `checkins` row exists for today.
- **Decision:** `GET /today` returns `checkin.status = 'not_sent'` with the top 3 items from a live `get_daily_digest` call. In that state, "Open check-in" calls `POST /checkins/{date}/conversation`, which generates and stores the check-in on demand. It records `status = 'sent'` without delivering a notification.

## 4. Chat, action cards, and confirmations (S3, S10)

### D-12 Add a conversations table and a client-facing message shape

- **Gap:** `messages.conversation_id` has no parent table. Stored `content` is raw Messages API blocks (including `tool_use` and `tool_result`), which the app must not render or parse.
- **Decision:**
  - Add a `conversations` table with `kind` (`chat` | `checkin` | `review` | `shortcut`), a title, and denormalized list fields. Chat history is kept, and users can browse and search it; see section 12.
  - The API returns a projection, `ChatMessage.blocks[]`, of type `text` | `action_card` | `checkin`. Tool blocks are never exposed.

### D-13 Action cards are first-class, stored objects

- **Evidence:** PDF p.13. Cards have states (Logged, Needs confirmation), typed fields (old time struck through, then the new time), and Undo, Confirm, and Cancel buttons. BRIEF C3 adds the undone and failed states. Card state must survive a reload, and Undo turns to "Saved" after 30 s.
- **Decision:**
  - Add an `action_cards` table. The orchestrator creates one card per write-tool result; the card is built from the tool's structured return value, not from model text, which keeps INV-9 intact.
  - **Confirm and Cancel** call `POST /action-cards/{id}/confirm|cancel`. These run the confirm-first tool deterministically with the stored `confirmation_token`, with no LLM round trip, then append a short assistant message to the conversation. This satisfies INV-3 because the tap is the explicit confirmation.
  - **Undo** calls `POST /action-cards/{id}/undo`, which wraps `undo_entry`. The server allows 10 minutes (ARCH §5); the UI shows the button for 30 s (BRIEF §6).
  - **Voice:** during the 5-second voice confirm or undo window, the app matches "yes", "confirm", "no", "cancel", and "undo" locally and calls the same endpoints, so a spoken yes does not need an LLM turn.

### D-14 Chat responses stream over SSE, with tool status events

- **Evidence:** PDF p.17, the "Checking Thursday's calendar…" caption; BRIEF S3 states (thinking, tool running, error with Retry).
- **Gap:** ARCH §11 notes the Lambda timeout risk and suggests response streaming. The diagram, however, shows an API Gateway **HTTP API**, which does not stream responses and caps integrations at 30 s.
- **Decision:** `POST /conversations/{id}/messages` returns `text/event-stream` with these events: `turn.started`, `status` (a human label per tool, from a static map such as `calendar_list_events` → "Checking your calendar…"), `text.delta`, `card`, `turn.completed`, and `error`. When `Accept: application/json` is sent instead, it returns the completed turn as JSON; the iOS Shortcut path uses this. Both endpoints are served by the chat Lambda through its Function URL (D-38).

### D-15 Voice turns do not stream text

- **Gap:** in voice mode the model replies with JSON (`display_text`, `spoken_text`, ARCH §4.1), so partial deltas are not displayable text.
- **Decision:** for `input_mode = 'voice'`, the server sends `status` and `card` events as they happen, but no `text.delta` events. It sends `display_text` and `spoken_text` in `turn.completed`.

### D-16 Chat writes are idempotent per client message

- **Evidence:** PDF p.19, "Waiting to send" while offline; BRIEF §7, write actions queue while offline.
- **Decision:** every send carries a client-generated `client_message_id` (UUID). A replay with the same ID returns the stored turn and does not run the model again (INV-4). REST writes use an `Idempotency-Key` header, which the server stores as the `request_id`.

### D-17 Screen-context prompts

- **Evidence:** "Ask about today" (p.1), "Ask about this" on Insights (p.25), and "Ask about this note" (p.37).
- **Decision:** the message request takes an optional `context` (`{ type: 'today' | 'insights' | 'note', ... }`). The orchestrator resolves it server-side, for example by loading the note body or the insights period, and adds it as data. Per INV-8 it is wrapped as data, not as instructions. The client only prefills text and passes the context reference.

### D-18 Reply chips are server-provided

- **Evidence:** PDF p.47, "Looks good", "Move something", "Mark something done"; PDF p.15, New chat suggestions.
- **Decision:** `ChatMessage.suggestions[]` carries the reply chips. The New chat chips come from `GET /chat/home` (D-40). Static chips are fine for V1.

## 5. Morning check-in (R9, S2, S10)

### D-19 Check-in schedule is per user, not a SAM cron

- **Gap:** ARCH §7 lists `morning-checkin` as a fixed SAM cron (`cron(0 7 * * ? *)`), but also says that changing `checkin_time` updates the schedule.
- **Decision:** the settings service owns a per-user EventBridge schedule named `checkin-<user_id>`, with `ScheduleExpressionTimezone` set to the user's timezone. `PATCH /me/settings` updates it whenever `checkin.time` or `timezone` changes. Extend the IAM rule in ARCH §10 to allow the `checkin-*` prefix for the settings role.

### D-20 SMS check-in rule combines the toggle and criticality

- **Gap:** S9 has an SMS toggle for the check-in (p.41), while ARCH §7 says to send SMS only if an item is critical.
- **Decision:** send the check-in by SMS only when `sms` is in `checkin_channels` **and** at least one item is critical.

### D-21 Check-ins and their deliveries appear in Reminders → Past

- **Evidence:** PDF p.39 lists "Morning check-in · Delivered" under Past.
- **Decision:** `GET /reminders?scope=past` returns a union of reminder and check-in notifications (`kind: reminder | checkin`), using the shared delivery records (D-22).

## 6. Reminders and notifications (R4, S8, S9)

### D-22 Per-channel delivery records

- **Evidence:** PDF p.39, "SMS not delivered. Push went through." with a Retry button.
- **Gap:** ARCH §7 records per-channel results only in CloudWatch logs.
- **Decision:** add a `deliveries` table with one row per channel attempt. `reminders.status` stays a summary: `sent` if any channel succeeded, `failed` if none did. Add a `partial` flag derived from the deliveries. `POST /reminders/{id}/retry` re-sends only the failed channels.

### D-23 Snooze, edit, complete, and notification actions

- **Evidence:** BRIEF §4, the push actions "Done" and "Snooze 10 min"; S8 sheet with Snooze, Edit time, Cancel; PDF p.39 "+" (create directly).
- **Decision:**
  - **Snooze** creates a new schedule `rem-<id>-s<n>` and updates `fire_at`. Snoozed reminders keep their id.
  - **Edit** re-creates the schedule.
  - **Done** sets `completed_at`.
  - Push payloads include `reminder_id`, so `expo-notifications` category actions can call the API from the background.

### D-24 Global channel switches

- **Evidence:** S9 "Notifications" (p.41) has per-channel toggles that are separate from the check-in channels.
- **Decision:** add `users.channels_enabled` (`{push, email, sms}`). The notifier drops disabled channels, with one exception: if every requested channel is disabled for a `critical` reminder, it falls back to push.

### D-25 Test notification

- **Decision:** `POST /notifications/test` sends a fixed message on the requested channels and returns the per-channel result synchronously.

## 7. Settings and integrations (S1, S9)

### D-26 Google OAuth runs server-side

- **Gap:** ARCH §9 lists Google OAuth but no flow for the mobile app. The refresh token must end up in Secrets Manager (ARCH §10), so the code exchange must happen on the server.
- **Decision:** `POST /integrations/google/connect` returns an authorization URL with a signed `state`. The app opens it in an auth session. Google redirects to the backend callback, which exchanges the code, stores the secret, and redirects to `assistant://settings/integrations?provider=google&result=connected|error`.

### D-27 Integration status fields

- **Evidence:** PDF p.41, "Connected · Synced 2 min ago"; PDF p.43, "Disconnected · Access expired today at 8:12 AM. Last synced Oct 5."
- **Decision:** add `status`, `account_email`, `connected_at`, `last_synced_at`, `last_error_at`, and `last_error_code` to `integrations`. The `token-health` job (ARCH §7) and any calendar call that gets `invalid_grant` set `status = 'expired'`. `GET /today` reports `calendar_status` so S2 can render its "not connected" state (p.11).

### D-28 Shortcut token display

- **Evidence:** PDF p.41 shows `pa_•••• 7Q2F`, "Created Sep 30 · last used today", and a **Copy** button on an existing token.
- **Conflict:** ARCH §6 stores only a hash, so an existing token cannot be copied.
- **Decision:** return the plaintext token once, in the `POST /shortcut-tokens` response. Store `prefix`, `last4`, `created_at`, and `last_used_at`. The UI shows Copy only right after creation; afterwards it offers "Create new". This is a mockup change, tracked as **Q-7**.

### D-29 User-managed vocabulary hints

- **Evidence:** PDF p.41, "Vocabulary hints: Capoeira, Kali, Escrima, RPE, +2". RPE is not an activity, so some hints are entered by hand.
- **Decision:** add `users.custom_vocabulary text[]`. `GET /vocabulary` returns the custom terms first, then derived names (activities, lists, chores) ranked by use, capped at 100 (ARCH §11).

### D-30 Device registration

- **Decision:** `PUT /devices/{expo_token}` upserts a `push_tokens` row, refreshing `last_seen_at`, and runs on every app launch. `DELETE` on the same path runs at sign-out and sets `revoked_at`.

### D-31 Single-user sign-up is closed

- **Decision:** disable Cognito self sign-up and create the one user with an admin call. The `users` row is created on first authenticated request, keyed by `cognito_sub`. App Store account-deletion rules apply only to in-app sign-up, which is disabled. Data deletion is still **Q-15**.

## 8. Lists, chores, and notes (S6, S7)

### D-32 List metadata

- **Evidence:** PDF p.29, open counts on list chips ("Groceries 5"), "+ New", "Done (4)", "Clear".
- **Decision:** add `lists.sort_order` and `lists.created_at`, plus `list_items.request_id` and `list_items.updated_at`. `GET /lists` returns `open_count` and `checked_count`. "Clear" soft-deletes checked items.

### D-33 Chore completion history, so skip and done can be undone

- **Evidence:** PDF p.31 and p.33, swipe right for Done and left for Skip once; BRIEF C6, Undo toast.
- **Gap:** undoing a completion needs the previous `next_due_at`, which nothing stores.
- **Decision:** add a `chore_events` table (`done` | `skipped`, with `prev_due_at`, `request_id`, and `undone_at`). Undo restores `next_due_at` and `last_done_at`. Responses include `recurrence_text` ("Every Saturday"), generated by the server from `rrule`, and a `due_group` (`overdue` | `today` | `this_week` | `later`).

### D-34 Notes: list metadata and formatting

- **Evidence:** PDF p.35 shows the next reminder date with a bell ("Sat", "Nov 7"), tags, the date, and a "+" button. PDF p.37 shows a bulleted body, "Edited Oct 4", and an attached reminder card with Edit and Remove.
- **Decision:**
  - The list returns `excerpt` and `next_reminder`. Detail returns all active reminders for the note.
  - Bodies are stored as plain text. The client renders lines that start with `- ` as bullets. This keeps "plain text editing" (BRIEF S7) while matching the mockup.
  - Notes created in the app (via "+") are embedded asynchronously.
  - Search uses `GET /notes?q=` with a hybrid of semantic (pgvector) and keyword (`tsvector`) results.

## 9. Insights (S5)

### D-35 Insights payload

- **Evidence:**
  - **Populated week (p.4):** "Oct 5 – 11 · compared with Sep 28 – Oct 4". Tiles read "+12% vs last week", "+1 vs last week", "−8% vs last week", "+5 pts vs last week".
  - **Minutes per day:** a stacked bar per day with a total label above it (95, 140, …). The legend lists only the categories that have data.
  - **Habits grid:** "18 of 21 done", with cells colored by the habit's category.
  - **Time per activity:** for example "Muay Thai · 3 sessions · 3 h". The rows sum to the 6 h 45 m training total, so the list covers training activities.
  - **Other states:** p.25 shows "No last week yet", "Needs 3 days", and "2 of 3 days"; p.27 shows the loading skeletons. BRIEF §8 requires a text alternative.
- **Decision:** `GET /insights` returns:
  - `range`, plus `comparison_range` and `comparison_label` (`last week`, `last month`, or `previous period`)
  - `sufficiency` (`days_logged`, `days_required = 3`)
  - four metrics, each with `previous` and a typed `change`: `percent` for durations, `absolute` for sessions, `points` for the habit rate
  - `daily[]` with minutes per category and a `total_minutes`, plus `categories_present` for the legend
  - `habit_grid`, with `completed` and `possible` counts and each row's `category` for cell color
  - `breakdown[]` for the `breakdown_category` (default `training`), with minutes, sessions, and `share` (0–1) of the largest row for bar length
  - `summary_text` for accessibility

  Weeks run Monday to Sunday.

### D-39 Insight periods compare against the full previous period

- **Decision:** the comparison is always the whole previous period of the same kind:

  | Period | Compared with |
  | --- | --- |
  | Week | The previous Monday to Sunday |
  | Month | The previous calendar month |
  | Custom | The range of equal length that ends the day before `start` |

  A current, partial week therefore compares against a full previous week. This is accepted for V1 and can be revisited if mid-week drops are confusing. If the user's first log falls after the comparison range ends, `comparison_range` is null, every `previous` is null, the header reads "first week" (p.25), and the tiles read "No last week yet".

## 10. Cross-cutting

### D-36 Response conventions

- **Decision:** the API follows these conventions.
  - **Datetimes:** ISO 8601 with the user's offset (INV-5, ARCH §5).
  - **Local dates:** `YYYY-MM-DD`.
  - **Errors:** the ARCH §5 shape, `{ error: { code, message, retryable } }`.
  - **Pagination:** cursor-based.
  - **Caching:** `ETag` on GETs, for offline caching and cheap revalidation.
  - **Request IDs:** an `X-Request-Id` echo on every response.

### D-37 Timezone source of truth

- **Decision:** `users.timezone` is authoritative (INV-6). The app sends `X-Device-Timezone` on every request. When it differs from the stored timezone, the server returns `timezone_mismatch: true` on `GET /me`, and the app can prompt the user to switch. The server never switches automatically. The travel policy is **Q-9**.

## 11. Chat endpoint deployment

### D-38 Turn-running endpoints run on a Lambda Function URL

- **Gap:** a chat turn can call the model several times, use up to 8 tool iterations, and include Google Calendar round trips (ARCH §4). That regularly exceeds the 30 s limit of an API Gateway HTTP API integration, which also cannot stream.
- **Options considered:**
  - **ECS Fargate container behind an ALB:** about $30–35 a month, mostly the load balancer.
  - **API Gateway REST API with streaming:** would move or split the API.
  - **Polling:** loses streaming.
- **Decision:** serve the turn-running endpoints from a dedicated **chat Lambda** with a **Function URL** in `RESPONSE_STREAM` mode. Details are in [chat-service.md](chat-service.md). Why:
  - **Cost:** pay-per-use comes to about $0–1 a month for one user, with no fixed cost.
  - **Fits the existing stack:** it runs in the same SAM stack and database setup as the REST Lambdas, with no new service to operate.
  - **Long enough:** turns can run up to 15 minutes with native SSE streaming on Node.js.
- **Scope:** only `POST /conversations/{id}/messages`, `POST /shortcut/message`, and `GET /warm`. Everything else stays on API Gateway. The check-in writer and the weekly review are separate Lambdas that share the agent-loop package (`packages/agent`).
- **Trade-offs accepted:**
  - **Cold starts:** mitigated by an app-side warm-up request on Chat focus and mic press, with provisioned concurrency as the fallback (Q-20).
  - **JWT verification in code:** the URL is public (`AuthType NONE`), so reserved concurrency (5) bounds abuse.
  - **No custom domain:** the app reads the URL from `GET /me` (`endpoints.chat_base_url`). CloudFront can add a custom domain and WAF later.

## 12. Chat history (S3, S11)

The updated mockups add multiple conversations: New chat (p.15), History (p.57), history search (p.59), and a past conversation that can be resumed (p.61). The chat header (p.2) shows History and New chat buttons with the conversation title, and no longer shows the read-back speaker toggle.

### D-40 Chat home and the "current" conversation

- **Evidence:** p.15 shows "New chat" with "Continue a recent chat" (2 rows with a time and "1 change waiting"), "See all", and suggestion chips. p.57 marks one conversation as "Current".
- **Decision:**
  - The **current** conversation is the one with the most recent user message.
  - The Chat tab opens the current conversation if its last activity was within the **resume window** (default 4 hours, **Q-2**). Otherwise it shows New chat.
  - `GET /chat/home` returns the resume target (if any), up to 2 recent conversations, and the suggestion chips.
  - A conversation is created lazily: New chat shows an empty composer, and the first send calls `POST /conversations` and then sends the message. Empty conversations never appear in History.

### D-41 Conversation list rows are denormalized

- **Evidence:** each History row (p.57) shows:
  - the title, and a "Current" badge where it applies
  - a time or date
  - a one-line preview, either the assistant's last text or "You: …" when the user spoke last
  - change chips: "1 logged", "1 waiting for you", "5 items added", "1 reminder", "1 not added", "1 note"

  Check-ins have a sun icon. The filters are All, Check-ins, and With changes. Rows are grouped Today, Yesterday, Earlier this week, and Earlier.
- **Decision:** `conversations` stores `last_message_at`, `last_message_preview`, `last_message_role`, and a `change_summary` jsonb. These are maintained when a message is persisted or a card changes state, so the list is one indexed query.
  - `change_summary` counts *entities*, not cards; one list card that adds 5 items reads "5 items added". The server renders the chip labels.
  - `pending_count` drives "1 waiting for you" and "1 change waiting".
  - Filters: `kind=checkin`, and `has_changes=true` (any saved, confirmed, or pending card).
  - The client groups rows by the local date of `last_message_at`.

### D-42 Titles, rename, delete, retention

- **Decision:**
  - **Titles:** a Haiku-class model writes a title of 6 words or fewer after the first assistant reply ("Muay Thai log and capoeira move"). Check-ins are titled "Morning check-in" and reviews "Training this week". Once a user renames a conversation (from the header "…" menu, p.61), its title is never regenerated.
  - **Delete:** the "…" menu can delete a conversation. This is a soft delete that hides it from History and search. Entities created from it (logs, reminders, events) are not touched.
  - **Retention:** chat history is kept indefinitely for browsing and search (this replaces the earlier 180-day default in Q-15). The model's context stays limited to the conversation's last 20 messages plus its rolling summary (ARCH §11).

### D-43 History search spans chats and notes

- **Evidence:** p.59: "2 chats and 1 note · matched by meaning, not only exact words". Chat hits show the conversation title, a date, and the matching message ("You: Shop says **rotors** are fine…"). An "In Notes" section shows note hits. Matched words are highlighted.
- **Decision:** `GET /chat/search?q=` runs a hybrid search over message text (user text and assistant display text, never tool blocks) and over notes, reusing the notes search (D-34). It returns `chats[]` (best message per conversation, with snippet and highlight ranges) and `notes[]`, plus counts. Highlights come from keyword matches; a hit matched only by meaning has no highlight ranges. Messages are embedded asynchronously after each turn.

### D-44 Any conversation can be continued

- **Evidence:** p.61 composer reads "Continue this chat" with "Replying picks this chat back up".
- **Decision:** sending to an older conversation makes it current (D-40). Its context is loaded from that conversation's own history and summary. Profile facts (`users.profile`) carry knowledge across conversations; other conversations' messages are not loaded.

### D-45 Cards show the live state of what they created

- **Evidence:** p.61 shows "Reminder set · upcoming" with an **Edit** button, days after the reminder was created.
- **Decision:** `ActionCard.entity_status` is resolved from the database when a message is read:

  | Card kind | `entity_status` values |
  | --- | --- |
  | Reminder | `upcoming`, `sent`, `completed`, `cancelled` |
  | Log entry, note, list item | `active`, `deleted` |
  | Chore | `active`, `deleted` |
  | Event | Last known state only (`scheduled`, `deleted`); not re-fetched from Google per read |

  **Edit** on a reminder card opens the reminder sheet (`PATCH /reminders/{id}`). Cards in history no longer show Undo once `undo_expires_at` passes.

### D-46 Expired confirmations can be renewed

- **Evidence:** p.61 shows a calendar card with "Not added · expired" and an **Add now** button.
- **Decision:** **Add now** calls `POST /action-cards/{id}/renew`. This re-runs the stored tool call as a preview (`confirm: false`) against the current calendar, issues a fresh confirmation token, and returns the card in `pending_confirmation`, with updated `data` if anything changed. The user then taps Confirm. INV-3 is preserved because nothing is written without a confirm on a current preview. Collapsing Add now and Confirm into one tap is **Q-19**.

### D-47 Shortcut and review messages in a multi-conversation world

- **Decision:**
  - **Shortcut:** `POST /shortcut/message` appends to the current conversation if it is within the resume window. Otherwise it starts a new `shortcut` conversation, titled like any chat.
  - **Weekly review:** creates a `review` conversation, which appears in History. "Training this week" on p.57 is one.

## 13. Model providers

Details are in [model-providers.md](model-providers.md).

### D-48 Models are called through one provider-neutral interface

- **Gap:** ARCH §4 calls the Anthropic SDK directly from the agent loop, so changing or mixing models would mean rewriting the loop.
- **Decision:** `packages/models` exposes `streamModel(task, request)` with adapters for Anthropic, OpenAI, and OpenAI-compatible servers (Ollama, llama.cpp, vLLM, hosted open models). The agent loop, check-in writer, weekly review, and title generator use only this interface. Claude remains the default for every task.
- **Why it is safe:** correctness does not live in the model. INV-1 to INV-4 and INV-7 hold whichever model answers, so a weaker model degrades helpfulness, not data.

### D-49 Stored history uses a canonical block format

- **Gap:** ARCH §6 stores `messages.content` as Anthropic Messages API blocks, which would tie history to one provider.
- **Decision:** store canonical `text`, `tool_call`, and `tool_result` blocks, close to Anthropic's shape; adapters translate on each call. Record the model and token usage on each assistant message (`messages.model`, `messages.usage`).

### D-50 Models are routed per task in config

- **Decision:** a routing file maps each task (`chat.agent`, `chat.title`, `chat.summary`, `checkin.write`, `review.write`, `logging.simple`) to a primary model and an optional fallback, overridable per environment through `MODEL_CONFIG` (D-53). Startup fails if a task is routed to a model that lacks a required capability (tools, streaming, JSON schema).
- **Defaults:** `claude-sonnet-5-5` for `chat.agent`; `claude-haiku-4-5` for everything else (Q-16). Small or local models are tried first on narration tasks (Q-21).

### D-53 Providers and the model catalog are config, not code

- **Gap:** the first scaffold hard-coded one adapter and a two-model catalog, so using another provider needed a code change.
- **Decision:** `MODEL_CONFIG` (JSON, merged over built-in defaults) declares `providers` (`anthropic`, `openai`, `openai_compatible` with `base_url`, optional `auth: "none"`), a `models` capability catalog, and `routes`. One fetch-based adapter serves OpenAI and every OpenAI-compatible server. Keys come from `<PROVIDER>_API_KEY` locally or the secret `pa/<stage>/llm/<provider>` in AWS. Startup validates every route against the providers and the catalog. An in-app picker on top of this is proposed in [model-providers.md §11](model-providers.md#11-in-app-model-picker-proposed-q-25) (Q-25).

### D-51 Fallback happens only before the first streamed token

- **Decision:** a timeout, 5xx, 429, or connection error before any text has streamed retries once, then moves to the task's fallback. After text has streamed, the turn fails with the normal `error` event and can be resent. Two schema-invalid tool calls in a row also escalate to the fallback. Confirm, cancel, undo, and renew involve no model (D-13), so they keep working during a provider outage.

### D-52 Evals gate every routing change

- **Decision:** Phase 1 adds a replay eval suite (about 50 cases with expected tool calls and arguments, fixed `now`, real tools against a test database). A model is routed to a task only after passing that task's evals, and routing changes merge with the results attached.

## 14. Doc inconsistencies to fix in the source docs

| # | Where | Issue | Fix |
| --- | --- | --- | --- |
| 1 | ARCH §1 note | Says "Requirement IDs (R1–R8)", but R9 and R10 exist | Change to R1–R10 |
| 2 | BRIEF header | "Companion to Doc." has a placeholder link | Link the architecture doc |
| 3 | ARCH §7 vs PDF p.1 | Today shows the check-in sent at 6:15 AM, while p.45 and p.47 show 7:00 AM (the default) | Use 7:00 AM in mockups |
| 4 | ARCH §7 ranking vs PDF p.1 | Today's top 3 puts "Clean bathroom overdue" (score 60) third, ahead of "Call with Mom" (event, 80). S10 (p.47) instead moves the overdue chore to Heads-up. | Today's card MUST show digest items 1–3. Whether Heads-up items are excluded from the numbered list is **Q-3**. |
| 5 | PDF p.1 vs p.47 | Breathing is "Done" at 6:30 AM, but the 7:00 AM check-in lists "Breathing streak at 12 days" as at risk | Sample data only; the digest must exclude streaks already logged today |
| 6 | ARCH §6 | `reminders.chore_id` has no foreign key; `chores` has no `request_id`, `created_at`, or `deleted_at` | Covered in [data-model-changes.md](data-model-changes.md) |
| 7 | ARCH §8 vs §9 | SMS provider is "Twilio or AWS End User Messaging" in §8, but Twilio only in §9 and the diagram | **Q-8** |
| 8 | Architecture diagram, ARCH §3 and §11 | The API Gateway HTTP API cannot stream chat responses or run turns longer than 30 s | **Diagrams done (Oct 9):** `architecture.drawio` adds the Function URL, the Chat Lambda, and the REST API Lambdas; `system.drawio` relabels the entry and orchestrator nodes. ARCH §3 (entry points) and §11 (gotchas) are also updated (D-38). |
| 9 | BRIEF §10 | Launch screen, accent color, and mic gesture are still open, but the mockups answer them (Today, teal, press-and-hold with slide to cancel) | Mark resolved, pending confirmation in **Q-1** |
| 10 | BRIEF §4 | The screen inventory has no chat history screen. The updated mockups add New chat (p.15), History (p.57), history search (p.59), and a past conversation (p.61). | Add **S11 Chat history** (`/chat/history`); extend S3 with the New chat state and the header's History and New chat buttons |
| 11 | BRIEF S3, S5 | S3 still describes the "Read-back on" speaker header, which the updated mockups removed. S5 doesn't mention bar total labels, the "18 of 21 done" count, or the training-only breakdown. | Update the brief to match p.2, p.4, and p.15 |
| 12 | BRIEF §5 S2 vs D-5 | The brief treats habits as a category. The mockups show a study activity (Language practice) that is also a habit. | Describe habits as a flag on any activity |
| 13 | ARCH §6 | `messages` holds history with no retention policy; ARCH §11 sends only the last 20 turns plus a summary to the model | History is kept for browsing and search (D-42); the context window stays per conversation |
| 14 | ARCH §4, §6 | §4 step 5 runs tools "through the MCP server" although §3 and D-2 run them in-process; §6 stores provider-specific content blocks | **Done (Oct 13):** §4 now runs tools through the shared tool layer and calls models through the model interface (D-48); §6 stores canonical blocks (D-49) |
