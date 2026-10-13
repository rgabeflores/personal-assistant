# Mobile API

Oct 9, 2026 · @Gabe

The contract between the Expo app and the backend. The machine-readable spec is [openapi.yaml](openapi.yaml) (OpenAPI 3.1, 80 operations). This page covers what OpenAPI does not express well: auth flow, streaming, idempotency and offline behavior, push payloads, and a coverage matrix showing that every data element in the mockups has a source.

## 1. Shape of the API

| Concern | Rule |
| --- | --- |
| Base URLs | `https://api.{env}.{domain}/v1` for REST (API Gateway HTTP API + Cognito JWT authorizer). `{chat_base_url}/v1` for the turn-running endpoints (`POST /conversations/{id}/messages`, `POST /shortcut/message`) and `GET /warm`. This is the chat Lambda's Function URL (`https://<url-id>.lambda-url.us-west-2.on.aws`), which streams and has no 30 s limit (D-38, [../chat-service.md](../chat-service.md)). Read it from `GET /me` → `endpoints.chat_base_url`; never hard-code it. |
| Auth | `Authorization: Bearer <Cognito access token>`. The Shortcut endpoint takes `Bearer pa_...` instead. `user_id` is never a request field (INV-7). |
| Times | ISO 8601 with offset, in the user's timezone, for example `2026-10-06T18:00:00-07:00` (INV-5). Local dates are `YYYY-MM-DD`. The client never assumes the device timezone matches the account (D-37). |
| Errors | `{ "error": { "code", "message", "retryable", "fields?", "request_id?" } }`. Show `message` (it is human-safe), branch on `code`, and offer Retry when `retryable` (BRIEF §7). |
| Pagination | `?cursor=&limit=` returns `{ items, next_cursor }`; a null `next_cursor` means the end. |
| Caching | GETs for whole screens (`/today`, `/activities`, `/lists/{id}`, `/chores`, `/insights`, `/vocabulary`) return `ETag`. Send `If-None-Match` to get a `304` on revalidation. |
| Idempotency | `Idempotency-Key: <uuid>` on POST writes, stored as `request_id` (INV-4). Chat sends use `client_message_id` in the body. |
| Calendar writes | Never via REST. They go through chat and then `POST /action-cards/{id}/confirm` (INV-3). |

The REST handlers and the MCP tools call the same service layer (D-2), so a quick-log tap and "log 60 minutes of Muay Thai" in chat produce identical rows.

## 2. Auth and session

1. **S1 Continue.** `expo-auth-session` runs PKCE against the Cognito hosted UI. Tokens go in `expo-secure-store`. Self sign-up is disabled (D-31).
2. `GET /me` creates the `users` row on the first call, and returns settings, `timezone_mismatch`, and `endpoints.chat_base_url`. Cache the URL for offline startup.
3. **Onboarding step 1 (Notifications).** After the OS grants permission, `PUT /devices/{expo_token}`. Repeat this on every launch.
4. **Step 2 (Microphone and speech).** Client-only. Then `GET /vocabulary` for recognizer hints.
5. **Step 3 (Google Calendar).** `POST /integrations/google/connect` returns `authorization_url`. Open it with `WebBrowser.openAuthSessionAsync(url, 'assistant://settings/integrations')`, then read `result` from the redirect and refresh `GET /integrations`.
6. **Sign out.** `DELETE /devices/{expo_token}`, then clear the tokens.

## 3. Chat turn protocol

`POST /conversations/{id}/messages` with `Accept: text/event-stream`:

```http
POST /v1/conversations/7c1e.../messages
Accept: text/event-stream
Content-Type: application/json

{ "client_message_id": "3f9a...", "text": "Move Thursday's capoeira to 7.", "input_mode": "text" }
```

The server sends events in this order; the `event:` name equals the payload's `type`:

```text
event: turn.started     data: {"type":"turn.started","user_message_id":"...","assistant_message_id":"..."}
event: status           data: {"type":"status","label":"Checking Thursday's calendar…","tool":"calendar_list_events"}
event: text.delta       data: {"type":"text.delta","text":"Here's the change. "}
event: card             data: {"type":"card","card":{"id":"...","kind":"event","state":"pending_confirmation",...}}
event: text.delta       data: {"type":"text.delta","text":"Confirm?"}
event: turn.completed   data: {"type":"turn.completed","message":{ ...ChatMessage... },"conversation":{ ...Conversation... }}
```

Client rules:

- **Thinking and tool status.** Show the thinking dots from send until the first `status` or `text.delta`. Each `status` event replaces the caption, for example "Checking your calendar…" (PDF p.17).
- **`turn.completed` is authoritative.** Replace the streamed draft with `message`, which carries `blocks`, `spoken_text`, and `suggestions`. Update the header and History cache from `conversation`.
- **Voice turns** (`input_mode: "voice"`) send no `text.delta` events (D-15). Show the dots and status captions, then render and speak on `turn.completed`, subject to `readback_mode`.
- **Errors.** An `error` event or a dropped connection marks the user message failed and shows "Retry". Retry with the **same** `client_message_id`; the server returns the stored turn if it had finished, or `409 turn_in_progress` if it is still running.
- **Offline** (PDF p.19). Queue the message with its `client_message_id` and show "Waiting to send", then replay in order on reconnect.

With `Accept: application/json`, the same request blocks and returns a `TurnResult`.

### Warm-up

The chat Lambda can be cold after sitting idle (D-38). The app calls `GET {chat_base_url}/v1/warm`, unauthenticated, fire-and-forget, at most once every 2 minutes, at three moments:

- when the Chat tab gains focus
- when the mic button is pressed
- when the composer gets focus

That way the runtime is initialized while the user is still speaking or typing. Never block the UI on it.

### Conversations and history

- **Opening the Chat tab:** call `GET /chat/home`. If `resume_conversation` is set, open it. Otherwise show New chat with `recent` and `suggestions` (D-40).
- **New chat creates nothing.** On the first send, call `POST /conversations` with an `Idempotency-Key`, then send the message. The server titles the conversation after the first reply (D-42). `turn.completed` carries the updated `conversation`, including `title`, so the header updates without a refetch.
- **History** (S11) is `GET /conversations` with optional filters. Row fields are denormalized, so this is a single fast query (D-41).
- **Search** is `GET /chat/search?q=`, which returns chats and notes together (D-43).
- **Older conversations:** sending to one makes it current (D-44). Rename and delete use `PATCH` and `DELETE /conversations/{id}`.
- **One running turn per conversation:** a second send while one is running returns `409 turn_in_progress`.

### Action cards

Cards arrive in `card` events and inside `ChatMessage.blocks`. The `actions` array tells the client which buttons to show now.

| User does | Call | Result |
| --- | --- | --- |
| Taps **Confirm**, or says "yes" within 5 s | `POST /action-cards/{id}/confirm` | Card becomes `confirmed`; `message` holds the assistant's follow-up and its `spoken_text` |
| Taps **Cancel**, or says "no" or "cancel" | `POST /action-cards/{id}/cancel` | Card becomes `cancelled` |
| Taps **Undo**, or says "undo", while the button is visible (30 s UI, 10 min server) | `POST /action-cards/{id}/undo` | Card becomes `undone` |
| Taps **Add now** on an expired card | `POST /action-cards/{id}/renew` | Card returns to `pending_confirmation` with a fresh preview; then Confirm (D-46) |
| Taps **Edit** on a saved reminder card | Opens the reminder sheet; `PATCH /reminders/{id}` | The card's `entity_status` reflects the change on the next read |
| Reopens the conversation later | `GET /conversations/{id}/messages` | Cards come back with their current `state` and live `entity_status` (D-45) |

Spoken yes, no, and undo are matched on the device during the 5-second listening window (D-13). Anything else is sent as a normal message.

### Screen context

The "Ask about today", "Ask about this", and "Ask about this note" buttons open Chat with prefilled text and send `context`. The server loads the referenced data itself (D-17):

```json
{ "client_message_id": "...", "text": "Summarize my training this week",
  "context": { "type": "insights", "period": "week" } }
```

## 4. Check-in flow (S2, S10)

1. The morning push carries `url: assistant://checkin/2026-10-06`.
2. The app calls `POST /checkins/2026-10-06/conversation`. This is idempotent and returns `{ conversation, checkin }`; the first message has a `checkin` block (C4) and `suggestions` ("Looks good", "Move something", "Mark something done").
3. Replies are ordinary `POST /conversations/{id}/messages` calls.

Today's check-in card reads `GET /today` → `checkin.top_items` (always digest ranks 1–3). If the check-in has not been sent yet, `status` is `not_sent` and the items come from a live digest (D-11).

## 5. Push notification payloads

These are not HTTP, but the app depends on them. Each push uses an Expo message with this `data`:

| Type | `data` | Tap opens | Category actions |
| --- | --- | --- | --- |
| Check-in | `{ "type": "checkin", "date": "2026-10-06", "url": "assistant://checkin/2026-10-06" }` | S10 | none |
| Reminder | `{ "type": "reminder", "reminder_id": "...", "url": "assistant://more/reminders?highlight=<id>" }` | S8, row highlighted | `done` → `PATCH /reminders/{id}` `{completed:true}`; `snooze` → `POST /reminders/{id}/snooze` `{minutes:10}` |
| Confirmation needed | `{ "type": "confirm", "conversation_id": "...", "card_id": "...", "url": "assistant://chat/<conversation_id>?card=<card_id>" }` | S3, scrolled to the card | none |
| Weekly review | `{ "type": "review", "conversation_id": "...", "url": "assistant://chat/<conversation_id>" }` | S3 | none |

The background action handlers use the stored access token. If it has expired, they refresh it first; if the refresh fails, they open the app.

## 6. Offline and idempotency

Per Q-14, these writes queue offline and replay with their original key:

| Write | Key |
| --- | --- |
| Chat message | `client_message_id` |
| Log entry, habit chip | `Idempotency-Key` |
| List item add | `Idempotency-Key` |
| List item check | none needed (PATCH is idempotent) |
| Chore done / skip | `Idempotency-Key` |
| Reminder done | none needed (PATCH) |

Confirmations, settings, integrations, and token management are online-only and show "Needs connection". Cached GET responses keep the screens readable offline (BRIEF §7).

## 7. Screen coverage matrix

Each data element visible in the mockups, mapped to the field that supplies it. **Gap** marks something the mockups show that the original architecture doc could not supply; the `D-n` decision closes it.

### S1 Sign-in and onboarding (PDF p.49–55)

| UI element | Source |
| --- | --- |
| App name, value statement | Static (app name is **Q-1**) |
| Notifications: Allow | OS prompt, then `PUT /devices/{expo_token}` |
| Microphone and speech: Allow | OS prompt; `GET /vocabulary` |
| Google Calendar: Allow | `POST /integrations/google/connect` (D-26) |

### S2 Today (PDF p.1, p.9, p.11)

| UI element | Source |
| --- | --- |
| "Tuesday, Oct 6", "Good morning, Gabe" | `Today.date`, `Today.greeting` |
| Check-in card: sent time, items 1–3, "Open check-in" | `Today.checkin.sent_at`, `.top_items[]` (`text`, `critical`), then `POST /checkins/{date}/conversation` |
| Timeline: time, end time, title, category, location, "Done" | `Today.schedule.events[]`: `start`, `end`, `title`, `category`, `location`, `done` (D-9) |
| "In progress", "Now" line | Client, from `start`/`end` and the current time |
| "Google Calendar isn't connected" card | `Today.schedule.calendar_status` |
| Due today: "3 open", rows, Critical, "2 days overdue" | `Today.due.open_count`, `.items[]`: `title`, `type`, `critical`, `overdue_days` (D-10) |
| Check a row | Reminder: `PATCH /reminders/{id}` `{completed:true}`. Chore: `POST /chores/{id}/complete`. Undo toast reverses it. |
| Habit chips with done state and streak | `Today.habits[]`: `name`, `done_today`, `streak_current` |
| Tap a habit chip | `POST /log-entries` `{activity_id, source:"habit_chip"}`; a second tap calls `DELETE /log-entries/{today_entry_id}` |
| Event details sheet | `GET /calendar/events/{id}` (or the event already in the payload) |
| Empty day: "Add an event" | Opens Chat prefilled (**Q-18**) |
| "Ask about today" | Chat with `context: {type:"today"}` |

### S3 Chat (PDF p.2, p.13–19)

| UI element | Source |
| --- | --- |
| Header: "Assistant", conversation title, History button, New chat button | `GET /conversations/{id}`: `title`; History opens S11; New chat shows the empty state without creating anything (D-40) |
| Chat tab opens a conversation or New chat | `GET /chat/home`: `resume_conversation` (Q-2) |
| User bubble, "Voice · 7:32 PM" | `ChatMessage.role`, `input_mode`, `created_at` |
| Assistant text | `blocks[type=text]` |
| Log card: Logged, Training, Muay Thai, Duration, Rounds "6 · pads", Note, Undo | `blocks[type=action_card].card`: `state`, `data` (LogEntry: `category`, `activity_name`, `duration_min`, `metrics.rounds`, `variant`, `note`), `actions` includes `undo` |
| Read-back caption | `card.spoken_caption` |
| Pending event card: "Needs confirmation", ~~6:00 PM~~ → 7:00 PM, Confirm, Cancel | `card.state = pending_confirmation`, `data.previous.start` → `data.start`, `actions` |
| "Checking Thursday's calendar…" | SSE `status.label` |
| Offline, "Waiting to send" | Client queue (section 6) |
| Listening state, live transcript, timer | Client-only (`expo-speech-recognition`) |

### S3 New chat (PDF p.15)

| UI element | Source |
| --- | --- |
| "What can I help with?" | Static |
| "Continue a recent chat": title, "Today, 7:34 PM · 1 change waiting", See all | `GET /chat/home`: `recent[]` (`title`, `last_message_at`, `pending_count`); See all opens S11 |
| Suggestion chips | `ChatHome.suggestions` |
| First send | `POST /conversations` (with Idempotency-Key), then `POST /conversations/{id}/messages` |

### S11 Chat history (PDF p.57, p.59, p.61)

| UI element | Source |
| --- | --- |
| Filters All / Check-ins / With changes | `GET /conversations`, `GET /conversations?kind=checkin`, `GET /conversations?has_changes=true` |
| Groups Today, Yesterday, Earlier this week, Earlier | Client, from the local date of `last_message_at` |
| Row: title, "Current", time, preview ("You: Looks good"), sun icon for check-ins | `Conversation.title`, `is_current`, `last_message_at`, `last_message_preview`, `last_message_role`, `kind` |
| Chips "1 logged", "1 waiting for you", "5 items added", "1 not added" | `Conversation.change_summary[]` (`label`, `outcome` for icon and color) |
| New chat | Same as the S3 header |
| Search "rotors": "2 chats and 1 note · matched by meaning" | `GET /chat/search?q=`: `chat_count`, `note_count` |
| Chat hit: title, date, "You: Shop says **rotors** are fine…" | `chats[]`: `conversation.title`, `sent_at`, `snippet`, `snippet_role`, `highlights[]`; opens at `message_id` |
| "In Notes" hit | `notes[]`: `note`, `snippet`, `highlights[]`; opens S7 detail |
| Past conversation header: title, date, "…" menu | `Conversation.title`, `created_at`; `PATCH` (rename) and `DELETE /conversations/{id}` |
| "Reminder set · upcoming", Edit | `card.state = saved`, `card.entity_status = upcoming`, `actions` includes `edit`, which opens the reminder sheet (`PATCH /reminders/{id}`) (D-45) |
| "Not added · expired", Add now | `card.state = expired`, `actions` includes `renew`: `POST /action-cards/{id}/renew`, then Confirm (D-46, Q-19) |
| "Continue this chat", "Replying picks this chat back up" | `POST /conversations/{id}/messages` on the old conversation, which makes it current (D-44) |

### S4 Quick log (PDF p.3, p.21, p.23)

| UI element | Source |
| --- | --- |
| Segmented control | `GET /activities?category=…` |
| Tile icon, name, "Mon · 60 min" | `Activity.icon`, `name`, `last_logged_at`, `last_duration_min` (D-4, D-7) |
| "+" (add activity) | `POST /activities` |
| Long-press: edit or remove favorite | `PATCH /activities/{id}`, `PUT /activities/order` |
| Sheet: duration default, Time, Rounds, RPE slider, Note | `Activity.default_duration_min`, `metric_fields[]` (with `scale_labels` for "7 · Hard"); submit `POST /log-entries` |
| Toast "Logged 60 min Muay Thai", Undo | Response `LogEntry`; Undo calls `DELETE /log-entries/{id}` |
| Recent: "Muay Thai — sparring", "Training · 60 min · 8 rounds", "Mon, 6:00 PM" | `GET /log-entries?limit=5`: `activity_name`, `variant` (D-6), `category`, `duration_min`, `metrics`, `started_at` |
| See all | `GET /log-entries` with a cursor |
| Swipe to delete, then Undo | `DELETE /log-entries/{id}`, then `POST /log-entries/{id}/restore` |

### S5 Insights (PDF p.4, p.25, p.27)

| UI element | Source |
| --- | --- |
| This week / This month / Custom | `GET /insights?period=…` (custom adds `start` and `end`) |
| "Oct 5 – 11 · compared with Sep 28 – Oct 4" or "· first week" | `Insights.range`, `comparison_range` (always the full previous period, D-39; null means first period) |
| Tiles "6 h 45 m", "+12% vs last week", "+1 vs last week", "+5 pts vs last week" | `metrics.*`: `value`, `change.kind` (`percent` / `absolute` / `points`), `change.value`; suffix from `comparison_label` |
| "No last week yet", "Needs 3 days" | `metrics.*.previous = null` with `comparison_label`; `metrics.*.note` |
| Not enough data, "2 of 3 days" | `sufficiency.days_logged`, `days_required`, `sufficient` |
| Minutes per day: stacked bars, total labels, legend | `daily[].minutes`, `daily[].total_minutes`, `categories_present` |
| Habits "18 of 21 done", grid colored by category | `habit_grid.completed`, `possible`, `rows[].category`, `rows[].cells` |
| Time per activity: "Muay Thai · 3 sessions · 3 h", bar | `breakdown[]`: `name`, `sessions`, `minutes`, `share`; scope in `breakdown_category` (Q-5c) |
| Chart text alternative (BRIEF §8) | `summary_text` |
| "Ask about this" | Chat with `context: {type:"insights", period}` |
| Month view, custom range picker | Not mocked yet (Q-5d, Q-5e); same payload |

### S6 Lists and chores (PDF p.29–33)

| UI element | Source |
| --- | --- |
| List chips "Groceries 5", "Hardware store 3", "+ New" | `GET /lists`: `name`, `open_count`; `POST /lists` |
| Items, "× 12", checkbox | `GET /lists/{id}`: `items[]` `text`, `quantity`, `checked`; `PATCH …/items/{item_id}` |
| "Done (4)", "Clear" | `List.checked_count`; `POST /lists/{id}/clear-checked` |
| "Add to Groceries" | `POST /lists/{id}/items` |
| Chore groups "Overdue · 1", "Today · 1", "Later · 1" | `GET /chores`: `due_group` |
| "Every Saturday", "2 days overdue", "Due Nov 2" | `recurrence_text`, `overdue_days`, `next_due_at` |
| Swipe right Done, left Skip once, Undo | `POST /chores/{id}/complete`, `/skip`; `DELETE /chores/{id}/events/{event_id}` (D-33) |
| "Add a chore" | `POST /chores` |

### S7 Notes (PDF p.35, p.37)

| UI element | Source |
| --- | --- |
| Search by meaning | `GET /notes?q=` (hybrid search) |
| Row: title, excerpt, tags, bell + "Sat", date | `NoteSummary`: `title`, `excerpt`, `tags`, `next_reminder.fire_at`, `created_at` |
| "+" | `POST /notes` |
| Detail: title, tags, "Edited Oct 4", bulleted body | `GET /notes/{id}`: `updated_at`, `body` (D-34) |
| Reminder card "Order brake pads · Sat, Oct 10 · 9:00 AM", channel icons, Edit, Remove | `Note.reminders[]`; Edit calls `PATCH /reminders/{id}`, Remove calls `DELETE /reminders/{id}` |
| "…" menu | `PATCH /notes/{id}`, `DELETE /notes/{id}` |
| "Ask about this note" | Chat with `context: {type:"note", note_id}` |

### S8 Reminders (PDF p.39)

| UI element | Source |
| --- | --- |
| Today, Tomorrow, Later groups | `GET /reminders?scope=upcoming`, grouped on the client by the local date of `fire_at` |
| Row: time, message, channel icons, Critical | `Reminder.fire_at`, `message`, `channels`, `priority` |
| Past: "Morning check-in · Delivered" | `GET /reminders?scope=past`, rows with `kind: checkin` (D-21) |
| "SMS not delivered. Push went through.", Retry | `Reminder.deliveries[]`, `partial_failure`; `POST /reminders/{id}/retry` (D-22) |
| "+", sheet with Snooze, Edit time, Cancel | `POST /reminders`, `POST …/snooze`, `PATCH /reminders/{id}`, `DELETE /reminders/{id}` |

### S9 Settings (PDF p.41, p.43)

| UI element | Source |
| --- | --- |
| Check-in time, Push/Email/SMS, Skip when empty | `Me.settings.checkin`; `PATCH /me/settings` (reschedules, D-19) |
| Read-back Off / Voice only / Always, Auto-send | `Me.settings.voice` |
| Vocabulary hints "Capoeira, Kali, Escrima, RPE, +2" | `GET /vocabulary` (`terms`); edit via `PUT /vocabulary` (D-29) |
| Notifications Push/Email/SMS | `Me.settings.channels_enabled` (D-24) |
| Phone "+1 ••• ••• 0142" | `Me.phone.masked`; `POST /me/phone`, `/me/phone/verify` (Q-8) |
| Send test notification | `POST /notifications/test` |
| Google Calendar: Connected, "Synced 2 min ago", Reconnect | `GET /integrations`: `status`, `last_synced_at`; `POST /integrations/google/connect` |
| Disconnected banner, "Access expired today at 8:12 AM. Last synced Oct 5." | `Integration.status = expired`, `last_error.at`, `last_synced_at` (D-27) |
| Shortcut token "pa_•••• 7Q2F", "Created Sep 30 · last used today", Copy, Create new, Revoke | `GET /shortcut-tokens`: `display`, `created_at`, `last_used_at`; `POST` (plaintext once, D-28 / **Q-7**); `DELETE` |
| Shortcut endpoint URL to paste into the Shortcut (not in mockup) | `Me.endpoints.shortcut_url` |
| Timezone | `Me.timezone`; `PATCH /me/settings` |
| Sign out | `DELETE /devices/{expo_token}` |

### S10 Check-in conversation (PDF p.45, p.47)

| UI element | Source |
| --- | --- |
| Lock-screen push text | Notifier (section 5); first line of `Checkin.message` |
| Card header "Tuesday, Oct 6 · Morning check-in · 7:00 AM" | `Checkin.date`, `sent_at` |
| Numbered items with right-aligned detail and Critical | `Checkin.items[]`: `rank`, `text`, `detail`, `critical` |
| Heads-up, Yesterday | `Checkin.heads_up`, `yesterday` |
| Reply chips | `ChatMessage.suggestions` |
| "Reply to your check-in" composer | `POST /conversations/{id}/messages` |
