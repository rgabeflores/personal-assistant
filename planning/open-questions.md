# Open Questions

Oct 9, 2026 · @Gabe

Questions that need an owner's decision. Each has a **recommended default**; the API spec and data model deltas already assume it, so work can start now and change later if the answer differs. "Blocks" says what is affected if the answer differs from the default. Answered questions move to [Resolved](#resolved) with the decision they became.

Status key: **Open**, waiting on a decision. **Proposed**, the mockups or docs already imply an answer that needs a quick sign-off.

## Product and UX

### Q-1 Confirm brief questions the mockups already answer · Proposed

BRIEF §10 left these open; the mockups imply answers:

| Question | Mockups imply |
| --- | --- |
| Launch screen | Today (p.1) |
| Accent color | Teal `#0F766E` / `#2DD4BF` is used throughout |
| Mic gesture | Press-and-hold with "Slide to cancel" (p.13); tap-to-talk as a setting |
| Habits configured where? | A flag on any activity (D-5); see Q-4 |

Still open: **app name and logo**. The mockups show `[APP NAME]` (p.49). This blocks the Cognito hosted UI branding, the app-store listing, the email sender name, and the push title.

### Q-2 Chat tab resume window · Open

With multiple conversations (D-40), tapping the Chat tab either reopens the current conversation (p.2) or shows New chat (p.15).

- **Default:** reopen the current conversation if its last message is under **4 hours** old; otherwise show New chat. The window is a server-side setting returned by `GET /chat/home`, so it can be tuned without an app release.
- **Alternative:** always reopen the current conversation, and start fresh only via the New chat button.
- **Blocks:** nothing structural; client navigation only.

### Q-3 Check-in ranking: are Heads-up items excluded from the numbered list? · Open

ARCH §7 scores an overdue chore at 60, which puts it above a chore due today (30). In S10 (p.47), "Clean bathroom 2 days overdue" appears only in Heads-up, not in the numbered list.

- **Default:** the Heads-up line picks one item (back-to-back gap, then overdue chore, then at-risk streak), and that item is removed from the numbered list. Today's card shows numbered items 1–3.
- **Blocks:** `get_daily_digest` ranking code and the check-in template.

### Q-4 Habit cadence beyond daily? · Open

Streaks and "at risk" are only well defined for daily habits. Some habits are naturally weekly ("stretch 3× a week").

- **Default:** V1 supports daily only. `activities.habit_target` is jsonb, so `{ "per": "week", "times": 3 }` can be added later.
- **Blocks:** the streak SQL, the habit grid, and the habit completion % definition.

### Q-5 Insights definitions and the month view · Open

The populated week view (p.4) and the comparison rule (D-39) are settled. Remaining:

- **a. Habit completion %:** **Default:** completed habit-days ÷ (active habits × days in range up to today). On p.4, "18 of 21 done" is 85.7%, but the tile shows 85%. The server returns the unrounded value, and the client rounds to the nearest whole number (86%), so the sample data needs a fix.
- **b. Sessions:** **Default:** training sessions only (the tile uses the training color on p.4).
- **c. Time per activity:** p.4 lists only training activities; the rows sum to the training total. **Default:** training only, with an optional `breakdown_category` parameter. Should study and habit time appear too, perhaps in a category switcher?
- **d. Month view:** still not mocked. The stacked bar chart becomes 28–31 thin bars, and the habit grid has 28–31 columns. **Default:** daily bars without total labels, and a habit grid that scrolls horizontally. Request a month mockup before building it.
- **e. Custom range picker:** not mocked (only the "Custom" segment with a calendar icon). **Default:** a native date-range sheet, capped at 366 days.

### Q-10 Calendar: which calendars, and how to classify events? · Open

- **a. Calendars:** read only the primary Google calendar, or let the user pick several (for example "Work", which may be where the 9:00–5:30 block on p.1 comes from)? **Default:** primary calendar plus any calendars selected in Settings. This needs a small "Calendars" row under Integrations, which is not in the mockup.
- **b. Category matching:** D-9 classifies events by matching titles against activity names. Is that acceptable? Should the user be able to tag an event's category instead?

### Q-18 "Add an event" on the empty Today screen · Proposed

PDF p.9 shows an "Add an event" button. Calendar writes must go through preview and confirm (INV-3).

- **Default:** the button opens Chat prefilled with "Add an event ", so creation goes through the confirm card. Alternative: a native form that calls a preview endpoint.

### Q-19 "Add now" on an expired card: one tap or two? · Open

p.61 shows an expired calendar card with "Add now".

- **Default (D-46):** Add now refreshes the preview and shows Confirm and Cancel again, so it takes two taps. This is the safest reading of INV-3, because the user confirms a preview checked against today's calendar.
- **Alternative:** one tap, executing immediately when the refreshed preview is identical to the card already on screen, and falling back to two taps if anything changed.

## Platform and infrastructure

### Q-8 SMS provider and phone verification · Open

- **a. Provider:** Twilio or AWS End User Messaging SMS? **Default:** AWS End User Messaging. It keeps credentials and billing in AWS, and the 10DLC or toll-free registration effort is the same either way.
- **b. Verification:** should the phone number entered in Settings (p.41) be verified with a one-time code before SMS is enabled? **Default:** yes, with `POST /me/phone` (sends the code) and `POST /me/phone/verify`. Both are in the spec. It is cheap and prevents sending critical reminders to a mistyped number.

### Q-9 Timezone when traveling · Open

- **Default:** `users.timezone` stays authoritative. The app compares it with the device timezone (D-37) and offers "Switch to Eastern Time?". Switching reschedules the check-in and keeps reminders at their absolute instant.
- **Alternative:** reminders keep their local wall-clock time across a switch, so 9:00 AM stays 9:00 AM. That would mean rescheduling every future reminder.

### Q-11 Embedding provider and dimension · Open

ARCH §6 uses `vector(1024)` as a placeholder. Embeddings now back both note search and chat history search (D-43).

- **Default:** Voyage AI `voyage-3.5` at 1024 dimensions. It is Anthropic's recommended embeddings partner and matches the placeholder.
- **Blocks:** the `notes.embedding` and `message_embeddings` migrations.

### Q-13 Confirmation token lifetime · Open

- **Default:** a pending calendar card expires 15 minutes after creation and then shows "Not added · expired" with Add now (p.61, D-46). Confirming after the underlying event changed returns `409 stale_preview`.

### Q-14 Offline write queue scope · Open

BRIEF §7 says "write actions queue and show a clock icon until synced".

- **Default:** queue chat messages, log entries, list item adds and checks, and chore and reminder completions. Do not queue confirmations, settings, integration changes, renames, or deletes; those show "Needs connection". Conflicts resolve last-write-wins, which is safe in a single-user app.

### Q-16 Model selection · Proposed

- **Default:** `claude-sonnet-5-5` for chat; `claude-haiku-4-5` for check-ins, the weekly review, conversation titles, and simple logging (ARCH §9). Keep both as config, not code.

### Q-20 Chat Lambda cold starts · Proposed

- **Default:** no provisioned concurrency. The app sends `GET /warm` when the Chat tab gains focus, the mic is pressed, or the composer is focused, throttled to once every 2 minutes. Measure first-token latency in the first weeks of use.
- **Upgrade:** if cold turns still feel slow on push-to-talk, set provisioned concurrency to 1 (about $9 a month, 1 GB ARM).
- **Also open:** add CloudFront for a stable custom domain? It is needed only if the Function URL ever has to change, which would break the configured Siri Shortcut.

## Data and lifecycle

### Q-7 Shortcut token copy behavior · Proposed

Tokens are hashed at rest (ARCH §6), so the Copy button on an existing token (p.41) cannot work. The updated mockups still show it.

- **Default:** show and copy the token only once, at creation. Update the mockup so an existing token shows only "Create new" and "Revoke".
- **Related mockup gap:** the Siri Shortcut also needs the endpoint URL (`Me.endpoints.shortcut_url`, D-38). Add a "Shortcut URL · Copy" row under the token.

### Q-15 Data export and deletion · Open

Chat history is now kept indefinitely (D-42).

- Is there an "Export my data" or "Delete all data" control? It is not in the mockups. **Default:** none in V1; deletion is an admin script.
- Are deleted conversations purged? **Default:** a soft delete hides a conversation immediately, and a nightly job purges it after 30 days.

### Q-17 Weekly review delivery · Proposed

The weekly review shows up in History as a `review` conversation ("Training this week", p.57).

- **Default:** send it by email, plus a push that opens that conversation, the same pattern as the check-in (S10).

## Resolved

| ID | Question | Resolution |
| --- | --- | --- |
| Q-2 (old) | One rolling chat thread or multiple conversations? | Multiple conversations with a History list and search (D-40 to D-44). Replaced by the resume-window question above. |
| Q-5a (old) | Compare to the elapsed span or the full previous period? | The full previous period (D-39) |
| Q-5e (old) | Populated Insights mockup | Added (p.4); payload updated (D-35) |
| Q-6 | Transport for streaming chat | A Lambda Function URL with response streaming (D-38, [chat-service.md](chat-service.md)). A Fargate container behind an ALB was considered and rejected on cost (~$30–35/mo vs ~$0–1/mo). |
| Q-12 | Speaker button in the Chat header | Removed from the updated mockups (p.2). Read-back is set only in Settings. |
