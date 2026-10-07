# Personal Assistant — UI Requirements & Design Brief

Oct 6, 2026 · @Gabe

Companion to Doc. This brief defines what the mobile app's screens must show and do, so Claude Design can mock them up.

## 1. How to use this brief

Paste one screen's prompt from section 9 into Claude Design, with sections 2, 3, and 7 as shared context; every other section is the reference those prompts point to.

**Notes for Claude Design and other LLM readers:**

- Treat this brief as the spec. Requirement IDs (R1–R10) match the architecture doc; screen IDs (S1–S10) and component IDs (C1…) are stable and can be cited in prompts and code.
- MUST, SHOULD, and MAY follow RFC 2119. MUST items are not negotiable in a mockup; SHOULD items may be traded off with a stated reason.
- Use realistic sample data from section 5, not lorem ipsum. Sample data uses 12-hour times, US dates, and a Pacific timezone.
- Design mobile-first at 393 × 852 pt (iPhone 15/16 class). Show light and dark mode for every screen.
- Prefer platform-native patterns that work on both iOS and Android (bottom tab bar, bottom sheets, swipe actions). Do not design iOS-only or Android-only controls.
- When a requirement is ambiguous, pick the simplest option and list the assumption in a note beside the mockup.

**Deliverables per screen:** the default state, the empty state, and any state listed under that screen's "States" line, in light and dark mode.

## 2. Product context and design principles

The app is a single-user, chat-first personal assistant: the user talks or types to it, and a few supporting screens show the data it manages.

**User:** one busy adult who trains in several sports, studies, keeps daily habits, and runs a household. Uses the app in short bursts: right after a class, in the morning, at the store. Often has sweaty hands or is walking, so voice and large touch targets matter.

**Primary jobs, in priority order:**

1. See what matters today (morning check-in, schedule).
2. Log something in under 5 seconds (training, habit, study session).
3. Ask or tell the assistant anything in natural language, by voice or text.
4. Check progress over a week or month.
5. Manage shopping lists, chores, notes, and reminders.

**Design principles:**

1. **Chat is the hub, screens are views.** Anything the user can do on a screen they can also ask for in chat. Screens exist for scanning and quick taps, not deep editing.
2. **Fast paths beat conversation.** Quick-log, checkboxes, and swipe-to-complete skip the assistant entirely and feel instant.
3. **Show what the assistant understood.** Every action the assistant takes appears as a structured card (event, log entry, reminder), not just prose, so the user can verify it at a glance.
4. **Calm, not chatty.** Short copy, generous whitespace, one accent color, no celebration animations beyond a subtle check.
5. **One-handed by default.** Primary actions sit in the bottom third of the screen.

## 3. Platform, layout, and design system

One React Native (Expo) codebase for iOS and Android, with a small token set so mockups translate directly into a theme file.

**Layout:**

- Base frame 393 × 852 pt; MUST also hold up at 360 pt wide (small Android) and with system text size at 130%.
- Respect safe areas (notch, home indicator, Android nav bar).
- 4 pt spacing grid; screen side padding 16; card padding 16; gap between cards 12.
- Minimum touch target 44 × 44 pt. The mic button is 64 pt.
- Corner radius: cards 16, buttons and inputs 12, chips 999 (pill).

**Color tokens** (starting values; adjust freely, keep the roles):

| Token | Role | Light | Dark |
| --- | --- | --- | --- |
| `bg` | Screen background | #F7F7F5 | #111213 |
| `surface` | Cards, sheets, tab bar | #FFFFFF | #1C1D1F |
| `text` | Primary text | #18181B | #F4F4F5 |
| `textMuted` | Secondary text, timestamps | #6B6B73 | #A1A1AA |
| `border` | Hairlines, input borders | #E4E4E7 | #2E2F33 |
| `accent` | Primary actions, active tab, mic | #0F766E | #2DD4BF |
| `accentSoft` | Selected chips, user chat bubble | #CCFBF1 | #134E4A |
| `danger` | Destructive, errors, critical items | #B91C1C | #F87171 |
| `warning` | At-risk streaks, overdue chores | #B45309 | #FBBF24 |
| `success` | Completed, logged | #15803D | #4ADE80 |

Category colors for logs and charts: training = #7C3AED, habit = #0891B2, study = #CA8A04, other = #6B7280. Category MUST also be shown by label or icon, never by color alone.

**Type scale** (system fonts: SF Pro on iOS, Roboto on Android):

| Token | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| `display` | 28 / 34 | Semibold | Screen titles, today's date |
| `title` | 20 / 26 | Semibold | Card titles, section headers |
| `body` | 16 / 22 | Regular | Chat messages, list items |
| `label` | 14 / 18 | Medium | Buttons, chips, tab labels |
| `caption` | 12 / 16 | Regular | Timestamps, metadata |
| `metric` | 32 / 36 | Semibold, tabular figures | Big numbers on insights |

**Icons:** one outline icon set (Lucide or SF Symbols-style), 24 pt, 1.5 pt stroke.

**Motion:** 150–250 ms ease-out for sheets and cards. Respect the system "reduce motion" setting by replacing motion with fades.

## 4. Navigation and screen inventory

A five-tab bottom bar (Today, Log, Chat, Insights, More) with Chat in the center; voice is one long-press away from any tab.

**Tab bar (left to right):** Today · Log · Chat (center, accent-filled circle) · Insights · More. Long-pressing the Chat tab from any screen opens Chat with the mic already listening.

| ID | Screen | Route | Reached from | Purpose | Req |
| --- | --- | --- | --- | --- | --- |
| S1 | Sign-in | `/sign-in` | First launch, signed out | Cognito sign-in, then permission onboarding | — |
| S2 | Today | `/today` | Tab; app launch default | Check-in summary, schedule, due items | R2, R9 |
| S3 | Chat | `/chat/[id]` | Tab; check-in push; any "Ask" button | Converse by text or voice; action cards | R1, R3, R10 |
| S4 | Quick log | `/log` | Tab | One-tap and short-form logging | R5 |
| S5 | Insights | `/insights` | Tab | Week and month analytics | R6 |
| S6 | Lists and chores | `/more/lists` | More | Shopping lists, chore schedule | R8 |
| S7 | Notes | `/more/notes`, `/more/notes/[id]` | More | Browse, search, view notes | R7 |
| S8 | Reminders | `/more/reminders` | More | Upcoming and past reminders | R4 |
| S9 | Settings | `/more/settings` | More | Check-in time, channels, voice, integrations | R4, R9, R10 |
| S10 | Check-in conversation | `/checkin/[date]` | Morning push (app link) | Chat seeded with today's check-in | R9 |

**External entry points:**

- Morning check-in push → S10.
- Reminder push → S8 with the reminder highlighted, plus "Done" and "Snooze 10 min" notification actions.
- Calendar confirmation needed (from a background flow) → S3 at the pending confirmation card.

## 5. Screen specs

Each screen lists its purpose, layout from top to bottom, sample data to use in mockups, actions, and required states.

### S1 Sign-in and onboarding

- **Purpose:** sign in once, then grant permissions with clear reasons.
- **Layout:** app name and one-line value statement; "Continue" button (opens Cognito hosted UI). After sign-in, three onboarding cards in sequence: Notifications ("for reminders and your morning check-in"), Microphone and speech ("to talk instead of type"), Google Calendar ("to read and add events"). Each card has "Allow" and "Not now".
- **States:** permission denied (card shows how to enable later in Settings).

### S2 Today

- **Purpose:** answer "what matters today?" in one glance. Default screen on launch.
- **Layout:**
  1. Header: "Tuesday, Oct 6" (`display`), greeting line, settings shortcut icon.
  2. Check-in card: top 3 ranked items with icons, "Open check-in" link to S10. Critical items get a `danger` left marker and the word "Critical".
  3. Schedule: vertical timeline of today's events (time, title, location). A "now" line marks the current time.
  4. Due today: reminders and chores as checkable rows; overdue chores in `warning` with "2 days overdue".
  5. Habits strip: today's habits as chips (Breathing, Language practice, Stretching); tap to mark done. Streak count on each (small flame icon + number; no emoji).
  6. Sticky "Ask about today" pill above the tab bar.
- **Sample data:** 6:30 AM Breathing (habit); 9:00 AM–5:30 PM Work; 12:15 PM Lunch; 6:00 PM Muay Thai, Downtown gym; 7:30 PM Call with Mom. Critical reminder: "Car registration due today". Chores: Take out recycling (due), Clean bathroom (2 days overdue). Streaks: Breathing 12, Language practice 5.
- **Actions:** check off a reminder or chore (strikethrough + undo toast); tap an event to see details sheet; tap a habit chip to log it.
- **States:** empty day ("Nothing scheduled. Enjoy it." + quick-log suggestion); calendar not connected (inline card with "Connect Google Calendar").

### S3 Chat

- **Purpose:** the main way to ask and act, by text or voice.
- **Layout:** message list (user messages right-aligned in `accentSoft`; assistant messages left, no bubble, plain text on `bg`); action cards inline under assistant messages (component C3); composer at bottom with text field, send button, and the mic button (C1) to the right. Suggested-prompt chips above the composer when the conversation is empty.
- **Sample conversation:**
  - User (voice): "Log 60 minutes of Muay Thai, felt strong, 6 rounds of pads."
  - Assistant: "Logged 60 min Muay Thai." + Log card: Training · Muay Thai · 60 min · 6 rounds · "felt strong" · Undo.
  - User: "Move Thursday's capoeira to 7."
  - Assistant: "Here's the change. Confirm?" + Event card in pending state: Capoeira, Thu Oct 8, 6:00 → 7:00 PM, with "Confirm" and "Cancel".
- **Empty-state chips:** "What's on today?", "How was my training this week?", "Add eggs to groceries", "Remind me at 5 to call the shop".
- **States:** assistant thinking (three-dot indicator in the assistant column); tool running ("Checking your calendar…" caption); error with "Retry"; offline (composer disabled with banner).

### S4 Quick log

- **Purpose:** log in under 5 seconds without the assistant.
- **Layout:**
  1. Segmented control: Training · Habit · Study · Other.
  2. Grid of favorite activities (2 columns of large tiles with icon + name + last-logged date). Training favorites: Muay Thai, Capoeira, Breaking, Kali/Escrima, Pickleball, Strength & conditioning, Run.
  3. Tapping a tile opens a bottom sheet: duration stepper (default from last time), time (default now), optional metrics fields for that activity (rounds, distance, RPE 1–10 slider), note field with mic. "Log" button.
  4. Below the grid: "Recent" list of the last 5 entries with swipe-to-delete.
- **States:** first use with no favorites ("Add activities you do often"); logged confirmation (sheet closes, success toast with Undo).

### S5 Insights

- **Purpose:** show progress over a week or month.
- **Layout:**
  1. Period switcher: This week · This month · Custom.
  2. Summary metrics row: total training time ("6 h 45 m"), sessions ("7"), study time ("3 h 10 m"), habits completed ("85%"), each with change vs previous period ("+12%").
  3. Stacked bar chart: minutes per day by category.
  4. Habit grid: rows = habits, columns = days, filled cells for done.
  5. Breakdown list: time per activity, sorted descending, with horizontal bars.
  6. "Ask about this" button that opens Chat prefilled with "Summarize my training this week".
- **States:** not enough data ("Log a few sessions to see trends"); loading skeletons.

### S6 Lists and chores

- **Purpose:** shopping lists and the chore rotation.
- **Layout:** segmented control Lists · Chores.
  - Lists: list picker chips (Groceries, Hardware store, + New). Items as checkable rows with quantity; checked items move to a collapsed "Done (4)" group. Add-item field pinned at the bottom with mic.
  - Chores: grouped by Overdue, Today, This week, Later. Each row: name, recurrence ("Every Sunday"), next due. Swipe right = done, swipe left = skip once.
- **Sample data:** Groceries: Eggs (12), Coffee beans, Bananas, Greek yogurt, Rice. Hardware store: Brake cleaner, Zip ties. Chores: Take out recycling (every Tue), Clean bathroom (every Sat, overdue), Change HVAC filter (every 3 months).
- **States:** empty list; all items checked ("All done" + "Clear checked").

### S7 Notes

- **Purpose:** find and read notes the assistant took.
- **Layout:** search field at top (searches meaning, not just words); list of notes (title, first line, date, tag chips, bell icon if a reminder is attached). Note detail: title, body, tags, attached reminder card, "Ask about this note" button. Editing is plain text only.
- **Sample notes:** "Brake pad part numbers", "Capoeira song lyrics to learn" (title only), "Gift ideas for Dad", "Ideas for portfolio site".
- **States:** no results for a search; empty notes.

### S8 Reminders

- **Purpose:** see and manage what will notify the user.
- **Layout:** Upcoming (grouped by Today, Tomorrow, Later) and Past (last 7 days, with sent / failed status). Row: time, message, channel icons (push, email, SMS), priority tag for critical. Swipe to cancel. Tapping opens a sheet with "Snooze", "Edit time", "Cancel".
- **States:** empty; a failed delivery shown with `danger` text and "Retry".

### S9 Settings

- **Groups:** Morning check-in (time picker, channels toggles, "Skip when nothing is scheduled"); Voice (read-back: Off / Voice only / Always; auto-send after speaking; manage vocabulary hints); Notifications (per-channel toggles, phone number for SMS, test notification button); Integrations (Google Calendar status with reconnect; Siri Shortcut token: create, copy, revoke); Account (timezone, sign out).
- **States:** Google token expired (red status + "Reconnect").

### S10 Check-in conversation

- **Purpose:** the morning check-in as an actionable conversation.
- **Layout:** same as S3, but the first assistant message is the check-in rendered as a card: date header, numbered items (max 7), a "Heads-up" line, a "Yesterday" line. Below it, reply chips: "Looks good", "Move something", "Mark something done", plus the composer and mic.
- **Sample check-in:** 1. Car registration due today (critical). 2. Muay Thai 6:00 PM, Downtown gym. 3. Call with Mom 7:30 PM. 4. Take out recycling. 5. Breathing streak at 12 days. Heads-up: Clean bathroom is 2 days overdue. Yesterday: 90 min training, 40 min study, 3 of 4 habits.

## 6. Voice interaction UI

The mic button (C1) has six visible states, and every voice-started action ends in a spoken and on-screen read-back of what the assistant understood.

**Mic button states:**

| State | Trigger | Visual | Feedback |
| --- | --- | --- | --- |
| Idle | Default | 64 pt circle, `accent` outline, mic icon | — |
| Listening | Press and hold (or tap once if tap-to-talk is on) | Filled `accent`, pulsing ring scaled to input volume; live transcript appears in the composer | Light haptic on start |
| Released | Finger lifts | Ring stops; transcript stays editable; 1.5 s countdown ring if auto-send is on | — |
| Sending | Send tapped or countdown ends | Mic disabled; short acknowledgement tone; assistant thinking indicator in the list | Tone |
| Speaking | Read-back plays | Speaker icon replaces mic; tap it to stop speech | — |
| Awaiting reply | After a confirm or undo prompt | Mic shows a small listening badge for 5 s, plus visible "Confirm / Cancel" or "Undo" buttons | Light haptic |

Cancel gesture: while listening, sliding the finger left over a "Slide to cancel" hint discards the recording.

**Read-back presentation:**

- The spoken sentence also appears as a caption under the action card it describes, so the user can read it in a noisy place.
- The action card is the source of truth on screen: it shows the stored values (activity name as stored, duration, time) so misheard words are visible.
- Undo stays as a button on the card for 30 seconds, then the card shows "Saved".
- Calendar changes show the card in a pending style (dashed `accent` border, "Needs confirmation" label) until confirmed.

**Permission and failure states:** microphone or speech permission denied → mic button greyed with a tooltip "Enable microphone in Settings"; recognition returns nothing → inline hint "Didn't catch that. Try again."

## 7. Shared components and system states

Design these components once and reuse them on every screen; the action cards (C3) carry the "show what the assistant understood" principle.

| ID | Component | Used on | Variants and rules |
| --- | --- | --- | --- |
| C1 | Mic button | S3, S10, add-item and note fields | States in section 6; compact 36 pt version inside text fields |
| C2 | Composer | S3, S10 | Multiline text field (max 5 lines, then scroll), send button, C1; disabled offline |
| C3 | Action card | S3, S10 | Kinds: Event, Log entry, Reminder, Note, List change, Chore. States: saved, pending confirmation, undone, failed. Shows icon, title, 2–4 key fields, and actions (Confirm/Cancel, Undo, Open) |
| C4 | Check-in card | S2, S10 | Date header, numbered items, Heads-up line, Yesterday line; critical items marked by label + `danger` marker |
| C5 | Timeline row | S2 | Time column (caption), title, location; current-time line |
| C6 | Checkable row | S2, S6, S8 | Checkbox, text, metadata; swipe actions; strikethrough when done with Undo toast |
| C7 | Activity tile | S4 | Icon, name, last logged; long-press to edit or remove favorite |
| C8 | Log sheet | S4 | Bottom sheet with duration stepper, time, per-activity metrics, note, Log button |
| C9 | Metric tile | S5 | Label, `metric` number, change vs previous period (arrow + %, color + sign) |
| C10 | Chip | Many | Filter, suggestion, habit (with streak), tag; selected state uses `accentSoft` |
| C11 | Toast | Many | Bottom, above tab bar, 4 s, optional Undo action |
| C12 | Banner | Many | Top of screen for offline, integration errors; dismissible unless blocking |

**System states every screen MUST define:**

| State | Treatment |
| --- | --- |
| Loading | Skeleton shapes matching the content layout; no full-screen spinners |
| Empty | Short sentence of what will appear here + one primary action |
| Error | Inline message with what failed and "Retry"; never a raw error code |
| Offline | Top banner "Offline. Showing saved data." Cached data stays visible; write actions queue and show a clock icon until synced |
| Permission denied | Inline explanation + "Open Settings" button |
| Integration broken | Banner "Google Calendar disconnected" + "Reconnect" (links to S9) |

## 8. Accessibility requirements

The app MUST meet WCAG 2.2 AA equivalents on mobile and work fully with VoiceOver and TalkBack.

- Text contrast at least 4.5:1 (3:1 for 18 pt+ and icons) in both light and dark mode.
- All text scales with the system font size up to 200% without clipping; layouts reflow rather than truncate.
- Every icon-only control has an accessible label ("Start voice input", "Mark Take out recycling done").
- Color never carries meaning alone: critical, overdue, and category states also use a word or icon.
- Swipe actions also exist as buttons in a long-press or row menu.
- The mic button announces its state ("Listening", "Sending"); live transcript updates are announced politely, not on every word.
- Spoken read-back does not play while VoiceOver or TalkBack is speaking; the on-screen caption is announced instead.
- Charts in S5 have a text summary and a data table alternative.
- Respect reduce motion and reduce transparency settings.

## 9. Prompts for Claude Design

Start every session with the shared context prompt, then send one screen prompt at a time and iterate on that screen before moving on.

**Shared context (send first):**

```text
You are designing a cross-platform mobile app (React Native, iOS and Android) for a single-user personal assistant powered by an LLM. The user talks or types to it; it manages their calendar, reminders, activity logs (training, habits, study), notes, shopping lists, and chores, and sends a morning check-in.

Design principles: chat is the hub and screens are views; fast paths beat conversation; every assistant action is shown as a structured card so the user can verify it; calm and uncluttered; one-handed use with primary actions in the bottom third.

Frame: 393 x 852 pt, safe areas respected. 4 pt grid, 16 pt side padding, 16 pt card radius, 12 pt button radius, 44 pt minimum touch targets.
Colors (light / dark): bg #F7F7F5 / #111213; surface #FFFFFF / #1C1D1F; text #18181B / #F4F4F5; textMuted #6B6B73 / #A1A1AA; border #E4E4E7 / #2E2F33; accent #0F766E / #2DD4BF; accentSoft #CCFBF1 / #134E4A; danger #B91C1C / #F87171; warning #B45309 / #FBBF24; success #15803D / #4ADE80. Category colors: training #7C3AED, habit #0891B2, study #CA8A04, other #6B7280. Never use color as the only signal.
Type: system font. display 28/34 semibold, title 20/26 semibold, body 16/22, label 14/18 medium, caption 12/16, metric 32/36 semibold tabular.
Icons: one outline set, 24 pt, 1.5 pt stroke. No emoji.
Navigation: bottom tab bar Today, Log, Chat (center, accent-filled circle), Insights, More.
Always show light and dark mode. Use the realistic sample data I give you. If something is ambiguous, choose the simplest option and note the assumption.
```

**S2 Today:**

```text
Design the Today screen, the default screen on launch. Top to bottom: date header "Tuesday, Oct 6" with a greeting; a check-in card with the top 3 items and an "Open check-in" link; a vertical schedule timeline with a current-time line; a "Due today" list of checkable reminders and chores; a strip of habit chips with streak counts; a sticky "Ask about today" pill above the tab bar.
Sample data: events 6:30 AM Breathing, 9:00 AM-5:30 PM Work, 12:15 PM Lunch, 6:00 PM Muay Thai at Downtown gym, 7:30 PM Call with Mom. Critical reminder: Car registration due today. Chores: Take out recycling (due), Clean bathroom (2 days overdue). Habits: Breathing (12-day streak), Language practice (5), Stretching (0).
Also show: the empty-day state, and the "Google Calendar not connected" state.
```

**S3 Chat with voice:**

```text
Design the Chat screen. User messages right-aligned in accentSoft bubbles; assistant messages left-aligned as plain text. Assistant actions appear as structured action cards under the message. Composer at the bottom: text field, send button, and a 64 pt mic button.
Show this conversation:
1. User (voice): "Log 60 minutes of Muay Thai, felt strong, 6 rounds of pads." Assistant: "Logged 60 min Muay Thai." with a Log card: Training, Muay Thai, 60 min, 6 rounds, note "felt strong", Undo button, and the caption "Logged 60 minutes of Muay Thai, training, today at 6 PM."
2. User: "Move Thursday's capoeira to 7." Assistant: "Here's the change. Confirm?" with an Event card in a pending style (dashed accent border, "Needs confirmation" label): Capoeira, Thu Oct 8, 6:00 PM to 7:00 PM, Confirm and Cancel buttons.
Also show: the mic in Listening state (filled accent, pulsing ring, live transcript in the composer, "Slide to cancel" hint); the empty conversation with suggestion chips "What's on today?", "How was my training this week?", "Add eggs to groceries", "Remind me at 5 to call the shop"; the assistant-thinking state; the offline state.
```

**S4 Quick log:**

```text
Design the Quick log screen for logging in under 5 seconds without chatting. Segmented control: Training, Habit, Study, Other. A 2-column grid of large activity tiles (icon, name, last logged): Muay Thai, Capoeira, Breaking, Kali/Escrima, Pickleball, Strength & conditioning, Run. Below: a "Recent" list of the last 5 entries.
Also show the bottom sheet opened from the Muay Thai tile: duration stepper (60 min), time (now), rounds field, RPE slider 1-10, note field with a small mic, and a Log button. And show the success toast with Undo.
```

**S5 Insights:**

```text
Design the Insights screen. Period switcher: This week, This month, Custom. A row of metric tiles: Training 6 h 45 m (+12%), Sessions 7 (+1), Study 3 h 10 m (-8%), Habits 85% (+5 pts). A stacked bar chart of minutes per day by category (training, habit, study). A habit grid (rows: Breathing, Language practice, Stretching; columns: Mon-Sun). A breakdown list of time per activity with horizontal bars: Muay Thai 3 h, Capoeira 1 h 30 m, Run 1 h 15 m, Strength & conditioning 1 h. An "Ask about this" button. Also show the not-enough-data state and loading skeletons.
```

**S6 Lists and chores:**

```text
Design the Lists and chores screen with a segmented control: Lists, Chores.
Lists: list chips Groceries, Hardware store, + New. Groceries items: Eggs (12), Coffee beans, Bananas, Greek yogurt, Rice; checked items collapse into "Done (4)". Add-item field pinned at the bottom with a small mic.
Chores: grouped Overdue (Clean bathroom, every Saturday, 2 days overdue), Today (Take out recycling, every Tuesday), Later (Change HVAC filter, every 3 months). Show swipe right = Done and swipe left = Skip once.
```

**S7 Notes and S8 Reminders:**

```text
Design two screens under the More tab.
Notes: search field ("Search by meaning"), list of notes with title, first line, date, tag chips, and a bell icon when a reminder is attached: "Brake pad part numbers", "Gift ideas for Dad", "Ideas for portfolio site". Plus a note detail view with an attached reminder card and an "Ask about this note" button.
Reminders: Upcoming grouped Today, Tomorrow, Later, and Past (last 7 days). Each row: time, message, channel icons (push, email, SMS), a "Critical" tag where relevant. Show one failed delivery with Retry.
```

**S9 Settings:**

```text
Design the Settings screen as grouped lists: Morning check-in (time 7:00 AM, channel toggles push/email/SMS, "Skip when nothing is scheduled"); Voice (read-back: Off / Voice only / Always, auto-send after speaking, vocabulary hints); Notifications (per-channel toggles, phone number, "Send test notification"); Integrations (Google Calendar: Connected, with Reconnect; Siri Shortcut token: Create, Copy, Revoke); Account (timezone America/Los_Angeles, Sign out). Also show the "Google Calendar disconnected" error state.
```

**S10 Check-in conversation and S1 Sign-in:**

```text
Design two flows.
Check-in conversation: opens from the morning push. The first assistant message is a check-in card: header "Tuesday, Oct 6"; items 1. Car registration due today (Critical), 2. Muay Thai 6:00 PM, Downtown gym, 3. Call with Mom 7:30 PM, 4. Take out recycling, 5. Breathing streak at 12 days; "Heads-up: Clean bathroom is 2 days overdue"; "Yesterday: 90 min training, 40 min study, 3 of 4 habits." Below it reply chips "Looks good", "Move something", "Mark something done", then the composer with the mic. Also show the lock-screen push notification that leads here.
Sign-in and onboarding: a sign-in screen with app name, one-line value statement, and Continue; then three onboarding cards for Notifications, Microphone and speech, and Google Calendar, each with a one-line reason, Allow, and Not now.
```

## 10. Out of scope and open questions

**Out of scope for V1 designs:** tablet and landscape layouts, home-screen widgets, Apple Watch, a web layout, multi-user or sharing, a full calendar month view (the app shows today and asks Google Calendar for the rest), two-way hands-free voice conversation.

**Open questions:**

- [ ] App name and logo (prompts currently say "app name").
- [ ] Should Chat or Today be the launch screen? This brief assumes Today.
- [ ] Is the teal accent final, or should Claude Design propose 2–3 palette options?
- [ ] Press-and-hold or tap-to-talk as the default mic gesture? This brief assumes press-and-hold with tap-to-talk as a setting.
- [ ] Should habits be configured in Settings, or created only by logging them the first time?
