# Hermes fork: live voice tickets (Gemini Live)

An employee opens a room's voice page, talks a **ticket** through with a Gemini Live voice
interviewer, in **any language**, that asks only for what's missing, confirms the recap, and the
ticket is posted **in the room, as that employee**, with an @mention of the Hermes bot. A ticket is
any operational request, task, fault, complaint, incident or safety issue: "refill the water
bottles in room 101" (a low request), "fix the lift in building 7" (a high fault; critical with
people stuck), "the guest in room 403 complained about the noise" (a medium complaint). The mention fires the bot's webhook
exactly as a typed @mention would, so the Hermes bridge and its `incident-report` skill take it
from there (Fizzy card etc.).

During the interview the assistant can also **ask Hermes** (`ask_hermes`, with `HERMES_ASK_URL`):
a procedure, the tickets already open on the Fizzy board, a contact… It says it's checking with
Sky (the name people see for Hermes; in the employee's language), the page forwards the question through Campfire to the Hermes bridge, and the
assistant speaks the answer and carries on with the interview.

This is a fork-only feature: none of it exists in the reference app or upstream
`once-campfire-rust`. Everything is off unless `GEMINI_API_KEY` is set.

## Flow

```
Browser (Campfire session)                 Campfire (this fork)                    Gemini / Hermes
GET  /rooms/:id/voice ───────────────────▶ membership check, page
POST /rooms/:id/voice/token ─────────────▶ POST v1alpha/auth_tokens (x-goog-api-key)
     ◀── {token, ws_url, model, expires_at}: single use, 1 min to open, 30 min life,
         model/instructions/tools/transcription locked in the token
mic 16 kHz PCM ══WSS (BidiGenerateContentConstrained, {"setup":{}})══▶ Gemini Live
     ◀══ 24 kHz audio + input/output transcriptions
tool call ask_hermes(question)             (only with HERMES_ASK_URL; Gemini waits for the answer)
POST /rooms/:id/voice/ask ───────────────▶ POST HERMES_ASK_URL ─────────────────▶ bridge /ask/<secret>
     ◀── 200 {answer} ◀──────────────────── {answer} ◀──── Hermes /v1/responses ◀┘
toolResponse {result: answer} ══▶ Gemini speaks it, resumes the interview
tool call submit_incident(...)
POST /rooms/:id/voice/report ────────────▶ message as Current.user, "@Hermes …"
                                            broadcast + deliver_webhooks_to_bots ──▶ bot webhook
     ◀── 201 {message_id, message_url}
```

The API key never reaches the browser. The browser only gets a single-use ephemeral token whose
`bidiGenerateContentSetup` fixes the model, the interviewer instructions (English, multilingual —
see *The interviewer* below — with the room and user names and the browser's languages frozen in,
as quoted data), the `submit_incident` declaration (plus `ask_hermes` and its
paragraph of instructions when `HERMES_ASK_URL` is set), audio transcription both ways, session
resumption and sliding-window context compression.

**The lock** (batch S1-1). Every token request is built by one helper,
`gemini_live::locked_token_request(setup, lifetime, now)`, for the voice page now and Sky later: the
whole setup goes into `bidiGenerateContentSetup` and **no `fieldMask` is sent, on purpose**. The
`AuthToken` reference: with an empty field mask and a setup present, the token's setup is the
effective one and the Live connection's own `setup` is ignored (the Python SDK's "global lock",
`lock_additional_fields=None`); a non-empty mask makes the listed fields come from the token and
merges the client's setup for every other field, so adding a mask could only weaken the lock. The
July 2026 report (a client replacing the system instruction and turning on code execution) was
about tokens minted **without** any setup; the helper makes that impossible here. Still to check
live (plan spike E3): a client `setup` carrying its own `systemInstruction` and
`tools: [{codeExecution:{}}]` is ignored or refused.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | unset (feature off) | Gemini API key (paid tier: the free tier's terms exclude EEA/CH/UK end users and allow human review). Server-side only; never logged. |
| `GEMINI_LIVE_MODEL` | `models/gemini-3.8-live` | Live model; a bare name gets `models/` prepended. |
| `GEMINI_LIVE_VOICE_BOT` | unset | The bot the report @mentions: a bot **user id** (e.g. `3`) or its **exact name** (e.g. `Hermes`). It must be an active bot **member of the room**. Unset: the room's only active bot; a room with none or several answers 422 `bot_not_in_room`. |
| `GEMINI_LIVE_TOKENS_PER_HOUR` | `10` | Tokens one user may mint per rolling hour (in memory, per process) before 429. |
| `GEMINI_LIVE_EXTRA_INSTRUCTIONS` | unset | Text appended to the interviewer's system instruction (e.g. site-specific questions). |
| `HERMES_ASK_URL` | unset (`ask_hermes` off) | The Hermes bridge's ask endpoint, e.g. `http://campfire-bridge:8645/ask/<BRIDGE_ASK_SECRET>`. Its path is a secret: never logged, never sent to the browser (`Debug` redacted, and a malformed value fails the boot without being quoted). Only read with `GEMINI_API_KEY`. |
| `HERMES_ASKS_PER_HOUR` | `30` | `ask_hermes` questions one user may ask per rolling hour (in memory, per process) before 429. |

Browsers only allow the microphone on a secure origin: serve Campfire over HTTPS (or localhost).

## Routes and contract

All four answer 404 while the feature is off (`/voice/ask` also while `HERMES_ASK_URL` is unset), run `ApplicationController`'s chain (session
cookie only, bots denied, `Sec-Fetch-Site` forgery protection on the POSTs, so same-origin `fetch`
needs no token) and `RoomScoped#set_room` (404 unless the user is a member of the room). They live in
a separate route table tried after the Rails one (`controllers::HERMES_ROUTES`), so the Rails table
still matches `bin/rails routes`.

### `GET /rooms/:room_id/voice`

HTML page in the application layout (Turbo-Frame requests get the frame layout). Root element:

```html
<section class="voice" data-controller="voice"
  data-voice-token-url-value="/rooms/:room_id/voice/token"
  data-voice-report-url-value="/rooms/:room_id/voice/report"
  data-voice-ask-url-value="/rooms/:room_id/voice/ask"          only with HERMES_ASK_URL
  data-voice-worklet-url-value="/assets/voice/pcm-worklet-<digest>.js"
  data-voice-room-url-value="/rooms/:room_id"
  data-voice-room-name-value="<room display name>">
  <div data-voice-target="transcript" aria-live="off"></div>      chat bubbles, newest at the bottom
  <div data-voice-target="notice" role="alert" hidden>…</div>      errors (+ "Technical details")
  <div data-voice-target="confirm" hidden>…</div>                  "Start over" confirmation
  <div data-voice-target="result" hidden>…</div>                   success card, "View the message"
  <div class="voice__bar">                                         bottom control bar
    <div data-voice-target="control">                              mic-level ring (--voice-level)
      <button data-voice-target="toggle" data-action="voice#toggle">…</button>
    </div>
    <p data-voice-target="status">…</p> <span data-voice-target="timer">00:00</span>
    <p data-voice-target="hint"></p>
    Cancel (cancel) · Resume (resume → voice#retry) · Start over (restart)
  </div>
  <p data-voice-target="announcer" role="status" class="for-screen-reader"></p>
</section>
```

The page (title "Voice report", the room name in the intro) is a column: intro, transcript (the
only part that scrolls, `flex: 1`), and a bottom bar with a 72 px round button: a mic (Campfire's
primary look) to start or resume, a hang-up (`.btn--negative`) while live. `data-voice-state` is
`idle | starting | live | finishing | stopped | closed | error | unavailable | done`; while live,
`data-voice-activity` is `speaking` while the assistant's audio plays ("The assistant is speaking…") and
`listening` otherwise ("Your turn", with the mic-level ring from the worklet chunks' RMS and a
running `mm:ss` clock). Right after setup the controller sends a short text instruction
(`KICKOFF_TEXT`) so the assistant speaks first; text input isn't transcribed, so it's neither on
the page nor in the report. "Hang up" keeps the transcript and the session: "Resume"
(`retry()`) reconnects with a fresh token and replays the transcript; "Start over" wipes it after
an in-page confirmation. Publishing is by voice ("Confirm the recap to the assistant to send the
ticket."). The page's own texts are English (owner decision, 1 Oct 2026; they were French until
v0.1.2-hermes.20, and there is still no i18n); the conversation is in the employee's language, and
the transcript is shown as spoken (typographic apostrophes only, no language-specific spacing). Error sentences stay plain; HTTP/WebSocket codes and hostnames go in a
"Technical details" disclosure and `console.warn`. Screen readers get the step while starting,
each completed assistant turn once (the transcript itself is `aria-live="off"`), and the focus moves
to "View the message" when done. Styles: `hermes/hermes.css` (below).

The layout's viewport meta (upstream `layouts/application`) has no `viewport-fit=cover`, so
`env(safe-area-inset-bottom)` is 0 in Safari's browser tab (content already stops above the home
indicator there); the bar still honours it where it's set.

The worklet URL is the Propshaft-digested path of `voice/pcm-worklet.js`, resolved through the asset
manifest (`campfire_assets::try_asset_path`); it's served like every digested asset
(`text/javascript`, immutable), which `audioWorklet.addModule(url)` accepts.

### The interviewer

`Interview::system_instruction` (`gemini_live.rs`) is written in English (the model follows it
best) and tells the model to:

- **Speak the employee's language**, whatever it is (French, English, Spanish, Portuguese, Arabic,
  Tagalog, Hindi…), and switch when they switch. Before they speak, greet in the first of the
  device's preferred languages, which sit in the quoted context block as data (« - device's
  preferred languages, most preferred first: "es-MX", "es" », or `unknown` → a short greeting in
  English). They come from `Accept-Language` (`preferred_languages`: only its first 256 bytes and
  20 entries are read; at most three well-formed tags by quality, each at most 35 characters and 4
  subtags; `*`, `q=0` and duplicates dropped).
- **Take any ticket**: type `request | task | fault | complaint | incident | safety`, where (room,
  building, floor, area), what needs to be done, how urgent; ask only what's missing and matters
  (a simple request needs what and where; incidents and safety issues also when, who, injuries,
  actions taken); never invent.
- **Severity guide**: low (routine request), medium (inconvenience or complaint, fix today), high
  (a service down or someone seriously affected, e.g. a broken lift), critical (people in danger,
  injured or trapped; a lift with people stuck inside is critical).
- **Fixed identifiers**: the ticket's text fields in the employee's language; `type` and
  `severity` are English enum values, never translated; room numbers, building names, people's
  names and codes kept exactly as said ("room 101", "building 7").
- **Never claim the ticket exists**: after `submit_incident` answers ok, say it was sent to Sky (the name people
  see for Hermes), who files it and confirms in the room; no card number. On `already_submitted` (the page answers
  that to a second call in the same conversation), don't call it again: say it was already sent
  (another ticket = a new conversation). On an error, say so and offer to retry.
- **Title**: « verb object — place » (`Refill water bottles — room 101`), the same format as the
  `incident-report` skill's.

The page's kickoff and reconnection texts (`KICKOFF_TEXT`, `recapText`) and the tool errors it
returns to the model are English too; the transcript's labels are `Employee:` / `Assistant:`.
`GEMINI_LIVE_EXTRA_INSTRUCTIONS` is appended under « Additional instructions from the
organization » (any language).

### `POST /rooms/:room_id/voice/token`

No body needed; the `Accept-Language` request header (sent by every browser) picks the greeting's
language. `200`:

```json
{"token": "auth_tokens/…",
 "ws_url": "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
 "model": "models/gemini-3.8-live",
 "expires_at": "2026-09-29T12:30:00Z"}
```

The browser connects to `ws_url?access_token=<token>` and sends `{"setup":{}}`. Errors are JSON
`{"error": code, "message": English text}`: `429 rate_limited`; `502 upstream_error` or
`502 upstream_timeout` (the whole upstream call is capped at 10 s).

Upstream call: `POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens`, header
`x-goog-api-key`, body `{"uses":1, "expireTime": now+30min, "newSessionExpireTime": now+1min,
"bidiGenerateContentSetup": {...}}` (exactly these keys: no `fieldMask`, see *The lock*); the reply `{"name": "auth_tokens/…"}` is the token.
Checked against the live API on 2026-09-29 (200 with that shape, including the `enum` in the
function schema).

`submit_incident` (the name is kept; it sends any ticket) parameters (all strings): `title` (short
and actionable: verb and object — place, "Refill water bottles — room 101") and `summary` (required),
`type` (`request` | `task` | `fault` | `complaint` | `incident` | `safety`), `what_happened`,
`location`, `occurred_at`, `people_involved`, `injuries`, `actions_taken`, `severity`
(`low` | `medium` | `high` | `critical`).

### `POST /rooms/:room_id/voice/ask`

The interviewer's `ask_hermes`. JSON body `{"question": "…"}`: whitespace folded to single
spaces, cut at 1,000 characters (`…`). Campfire forwards, server-side, `{"room_id", "user_id"
(the speaker's Campfire id, an integer), "user_name", "room_name" (the display name), "channel":
"voice", "question"}` to `HERMES_ASK_URL` over the `integrations::net`
client (10 s to connect, 60 s in all) and answers `200 {"answer": "…"}`. Errors, JSON
`{"error": code, "message": English text}`: `422 invalid_question` (blank), `429 rate_limited`
(`HERMES_ASKS_PER_HOUR`), `504 upstream_timeout` (no answer within 60 s, or the bridge's own 504:
it gives Hermes 55 s), `502 upstream_error` (anything else). One log line per question: room,
user, lengths and duration, never the text.

`ask_hermes` declaration: one required string parameter, `question` (in the employee's language,
self-contained, room numbers and names as said); an English description (Sky, the organization's
internal assistant: procedures, tickets already open on the Fizzy board, contacts, anything
organization-specific; files nothing; the answer can take several seconds). No `behavior` field: the default
blocking call was checked against the live API on 2026-09-29 (the model says it's checking, waits
for the `toolResponse`, then speaks the answer; 8 s tested). `NON_BLOCKING` + `INTERRUPT` worked
too, `WHEN_IDLE` never delivered the answer. The system instruction gets a paragraph (before the
quoted context): when the employee asks something organization-specific or such a fact is missing
(e.g. whether this fault is already reported), say briefly, in the employee's language, that it's
checking with Sky, call `ask_hermes`, give the answer in one or two sentences in the employee's
language and resume; never invent procedures; if Sky doesn't answer, say so; such questions
aren't off-topic; `ask_hermes` files nothing. `submit_incident` is unchanged.

The page (`#askHermes` in `voice_controller.js`) POSTs the question (same-origin, same headers as
the report) with a 65 s client timeout, and answers the tool call with `{result: answer}` or
`{error: "Sky did not answer."}`. While it waits the status reads "Checking with Sky…", and the
transcript shows a centred, dashed "Question for Sky" note (the question, then "Waiting for the
answer…" → "Answered" or "No answer"). The answer itself isn't repeated there:
the assistant speaks it, so it's in the assistant's next bubble. These notes stay **out of the
report's transcript** (and of the reconnection recap): the assistant's own lines already carry
the "checking with Sky" sentence and the answer.

The bridge side (`campfire-bridge/server.py` in the Hermes repo, `BRIDGE_ASK_SECRET`) prefixes
the question with `[user in room]` and a voice-style instruction (answer in the question's
language, 1–3 short sentences, no markdown, room numbers and names as written, say so if unknown), chains it on the speaker's own thread in that room,
`voice:<room_id>:<user_id>` (apart from the room's chat thread; since batch S1, so one person
never sees what another asked: SF-3, voice part), and strips leftover markdown from the answer.
A bridge older than S1 ignores `user_id` and `channel` and keeps one `voice:<room_id>` thread per
room; deploy the bridge first.

The ask body, as the bridge must honour it (`hermes_ask::Question::to_json`):

| Field | Type | When |
|---|---|---|
| `user_id` | integer | always (the bridge answers 400 to a non-integer) |
| `user_name` | string | always |
| `channel` | `"voice"` \| `"sky"` | always; absent (older Campfire) means `voice` |
| `room_id` | integer | always for `voice`; may be absent for `sky` (left out, never `null`) |
| `room_name` | string | with `room_id` |
| `question` | string | always, ≤ 1,000 characters |

Threads: `voice:<room_id>:<user_id>` for `voice`, `sky:<user_id>` for `sky` (phase 1b; no call id,
so nothing Hermes proposes from a Sky question is credited to a call).

### `POST /rooms/:room_id/voice/report`

JSON body: the `submit_incident` arguments plus an optional `transcript` string. Each field is cut
at 2 KB and the transcript at 20 KB (cut text ends with `…`, and the transcript heading says
"(cut)"); an unknown `severity` or `type` is dropped. `201 {"message_id": 123, "message_url":
"https://host/rooms/:room_id/@123"}`. Errors: `422 invalid_report` (no title or summary),
`422 bot_not_in_room`.

The message is created **as the current user** through `MessagesController#create`'s own path
(`create_message` → `broadcast_create` → `deliver_webhooks_to_bots`), so it's canonicalized,
stored, broadcast, pushed and delivered exactly like a typed message. Its body, every value
HTML-escaped (the text comes from a model and a browser):

```html
<p><action-text-attachment sgid="<bot's attachable sgid>" content-type="application/vnd.campfire.mention"></action-text-attachment> Live voice ticket, confirmed by the reporter.</p>
<h3>title</h3>
<p><strong>Summary:</strong> summary</p>
<ul><li><strong>Type:</strong> request</li><li><strong>What happened / what is needed:</strong> …</li>
<li><strong>Location:</strong> room 101</li> … <li><strong>Severity:</strong> high</li></ul>
<p><strong>Conversation transcript:</strong></p>
<blockquote>Assistant: …<br>Employee: …</blockquote>
```

Only tags the display sanitizer (`ContentFilters::SanitizeTags`) keeps are used (`<details>` is not
one of them, hence the blockquote). Missing fields read *not stated*. The labels, the type and the
severity are fixed English identifiers the `incident-report` skill reads; the values are in the
employee's language. The opening sentence is `campfire_workspace::proposals::LIVE_REPORT_OPENING`,
which the workspace uses to recognize a confirmed live report; the French opening images up to
v0.1.2-hermes.16 posted (« Compte rendu d’incident dicté en direct (voix), confirmé par
l’auteur ») is still recognized (`LEGACY_LIVE_REPORT_OPENINGS`).

### Why the bot's webhook fires (the plan's open point)

In a shared (non-direct) room, `deliver_webhooks_to_bots` calls only the *mentioned* active bots:
`message.mentionees` = the `User` attachables of the stored body (`campfire_richtext::mentioned_users`,
verified SGIDs only) that are members of the room. The server writes the same
`<action-text-attachment sgid=… content-type="application/vnd.campfire.mention">` the composer
inserts, with the bot's `attachable_sgid` (the one the mention autocomplete hands out), and the
body goes through the same canonicalization, so the mention is recognized like a human's.
`controllers/voice/tests.rs` (`a_report_mentions_the_bot_whose_webhook_then_fires_in_a_shared_room`)
proves it end to end: the report in *All Talk* (a closed room) makes Bender's webhook receive the
message. Consequence: **the bot must be a member of the room**, or nothing can be delivered (hence
the 422 rather than a silent message).

## Composer buttons and voice notes

The room composer gets up to two buttons after the attachment (paperclip) button, both from
`hermes/_composer_buttons.html`:

- **Voice note** (microphone, always on: `ShowView::voice_note`, set by `rooms#show`). Tap to record,
  tap again to stop and send; the bin discards (and gives the focus back to the mic). While
  recording, the input row becomes a recording bar (hermes/hermes.css hides the text field, the
  attachment, rich-text and live buttons and the composer's Send, via `:has()`): bin, a blinking red
  dot with the timer, a level meter (`AnalyserNode`), and the record button turned into a pulsing
  send arrow ("Send the voice message"). At 4:30 "Sending automatically in 30 s" replaces the
  meter; recording stops and sends by itself at 5 minutes. `voice_note_controller.js` records with `MediaRecorder`
  (`audio/webm;codecs=opus`, else `audio/mp4` for Safari, else `audio/ogg;codecs=opus`, else the
  browser's default) and names the file `note-vocale-YYYYMMDD-HHMMSS.webm|m4a|ogg` (the player recognizes voice notes by
  that prefix: a data contract, so it stays French) with a plain
  `audio/*` type. The file goes through the composer's own attachment path: the controller fires
  `drop-target:drop` on `window` (what a file dropped on the room fires, which `composer#dropFiles`
  handles) and clicks the composer's Send button, so the upload, its pending bubble, the
  `client_message_id` and the Turbo Stream answer are those of a picked file. Like Send, that also
  sends any text typed in the composer. The button stays hidden where the browser can't record; on
  plain HTTP it shows and explains that HTTPS is needed.
- **Live report** (headset, only when `ShowView::voice_path` is set, i.e. `GEMINI_API_KEY`): a
  link to `/rooms/:id/voice` named "Voice report (request, fault, incident)", out of the composer's turbo frame
  (`data-turbo-frame="_top"`). On touch screens (no hover title) it shows a small "Report" label
  under the icon, in the round buttons' footprint ("Voice report", the page's title, is too wide for
  that 44 px button; the link's accessible name and hover title say "Voice report …"). It replaces the room nav's mic button of
  v0.1.1-hermes.2.

On touch screens (`pointer: coarse`) every composer button is 2.75rem (44 px).

Audio attachments (`audio/*`, e.g. voice notes, whatever recorded them) render as
`<audio controls preload="metadata">`, full width of the bubble (`AttachmentPreview::Audio`,
`hermes::audio_preview`). A voice note (`note-vocale-*`) gets a compact "Voice message · 0:07"
line and a download button instead of the file-name row; the `voice-player` controller fills in the
duration once the browser knows it (Chrome's MediaRecorder WebM has none until played). Other audio
files keep the reference's file link (name, download, share) under the player.

All these styles live in one stylesheet, `crates/assets/overrides/hermes/hermes.css`, linked on
every page from the layout's head by the fork's head seam (`campfire_views::hermes::head_tags`,
docs/hermes-theme.md), with `data-turbo-track="reload"`. Its rules only match the voice features'
own markup, so pages without them look the same. `build.rs` leaves `hermes/` out of
`stylesheet_link_tag :all`, so that list keeps the reference's exact `<link>` tags, and the views'
goldens (which don't install the seam's assets) keep the reference's bytes.

## Sky push-to-talk

The plan is Hermes-self `docs/ui-redesign/10-push-to-talk-plan.md`. Batch S1 laid the plumbing
(tokens, limits, usage counters); **batch 1a** adds the floating button and the voice: hold, speak,
let go, and Sky answers out loud and in writing, knowing which screen the person is on. Talk only:
no tool reads or changes a ticket yet (batch 1b adds the read tools, 2a/2b the confirmed changes).

### Turning it on

Sky needs the workspace (`FIZZY_URL`, `FIZZY_TOKEN`) and the live voice (`GEMINI_API_KEY`). Then:

```
SKY_PTT=admins            # administrators only (the owner's first test)
SKY_PTT=users             # the pilot: SKY_PTT_USERS=1,5,9 plus administrators
SKY_PTT=on                # everyone signed in (never bots)
```

`SKY_PTT=off` (the default) removes everything: every `/sky/*` route answers 404 and no page
carries the button or its scripts (byte-identical pages). `SKY_PTT=spike` behaves exactly as
`admins` in batch 1a (the plan's bare spike page was not built; the button itself carries the
spike's measurements, below).
Rollback: `SKY_PTT=off` and restart Campfire.

### What the person sees

A terracotta disc in the bottom corner of every signed-in page, above the tab bar (and above a
room's composer, so its buttons stay reachable), above the card sheet (z-index 11 vs 10), with
"Hold to talk" under it. Hidden on the live voice page (it has its own microphone), while the
composer has focus (the soft keyboard is up) and while a modal dialog is open.

| State (`data-state` on the button) | Looks | Means |
|---|---|---|
| `ready` | terracotta (`--ui-ptt`) | Hold to talk |
| `warming`, `listening` | darker, 1.12×, pulsing ring; "Release here to cancel" at the top | Held: the microphone is open; the card above shows the chip and the words heard |
| `thinking` | teal (`--ui-ptt-ai`), the mic breathing | Released: Sky is answering |
| `speaking` | teal, sound bars | Sky's reply plays; its words fill the card ("Speaking · tap to stop") |
| `cancel` (while held in the zone), `tip`, `cancelled` | grey, then a short hint | "Keep holding while you speak, then let go." / "Cancelled. Nothing was sent." |
| `error`, `offline`, `no_permission`, `unsupported` | grey | A plain sentence in a card, a "Technical details" disclosure |

- **Hold** (pointer, or focus + Space/Enter, or **Ctrl+Shift+Space** anywhere outside a text field)
  to talk; **release** to send. **Slide up** 60 px onto "Release here to cancel" (or lose the
  pointer) to drop it. A hold under **300 ms** is a tap: a tip, nothing sent, no press counted, no
  token minted (the context call waits for the 300 ms). A
  hold stops at **60 s** (a warning at 50 s) and sends by itself. Pressing while Sky speaks stops
  it (barge-in); a tap then just stops it.
- **Replies**: the last three exchanges in cards above the disc (chip, "you" line from the input
  transcription, Sky's words from the output transcription), dismissible; the last reply is kept
  in `sessionStorage` for 10 minutes and shown again after a full page load. Screen readers hear
  "Listening", "Sky is thinking", "Cancelled" and each finished reply (`role="status"`).
- **Administrators** also see each reply's timings ("first words 0.8 s · first audio 1.2 s · warm ·
  812 tokens"): the spike's measurements on a real phone (plan §3.2, E1/E4/E10).
- `prefers-reduced-motion`: no pulse, no scaling, a static ring instead.

### How a press works

```
pointerdown ── mic opens (getUserMedia, AudioWorklet 16 kHz), audio buffered
at 300 ms ──┬─ POST /sky/context {screen, room_id?, card?, last?}  → {press_id, note, chip, restricted}
            └─ if no warm session: POST /sky/token {reconnect_of?} → locked token, then the socket
when held ≥ 300 ms, the note back and the socket open:
             clientContent(note, turnComplete:false) → activityStart → buffered audio → live audio
pointerup ── activityEnd → Sky answers: audio (24 kHz) + outputAudioTranscription
idle SKY_WARM_SECONDS, page hidden or left ── socket closed, POST /sky/usage {token_id, held_ms, reply_ms, turns}
```

- The session is Sky's own (`campfire_workspace::sky::SkySetup`), locked in the token like the voice
  page's (`locked_token_request`, no field mask): audio replies with transcription both ways,
  **manual activity detection** (`realtimeInputConfig.automaticActivityDetection.disabled`), session
  resumption and sliding-window compression, **no tools** in 1a. Its instruction: Sky's role,
  answer in the speaker's language in one to three short sentences, the screen note is data and
  never answered, a restricted ticket is never discussed, a cancelled request gets no answer, and in
  this version it can't read other tickets or change anything ("never say something is done"). The
  person's name and device languages go in as JSON-quoted data.
- **The screen note** (`ContextNote::build`) is built server-side from the page's hint, checked: a
  room only if the person is a member (its display name, quoted), a card only if the picture has
  it and the person may see it (`Workspace::sky_card`: visibility as the sheet's), and for a card
  in a restricted department only its number ("restricted", decision O7: no title or column goes
  to Google). Title, column and severity of a visible card are quoted. The chip shows what Sky used
  ("Ticket #57 · Lift out of order", "Room · Front desk", "Home · open tickets").
- The press is kept 10 minutes (`press_id`), for batch 1b's tools to refer to a checked context.
- **Warm session**: the socket stays open `SKY_WARM_SECONDS` (default 120) after the last reply, so a
  follow-up keeps its context and starts at once; the microphone is closed between presses. It
  closes on `pagehide`, when the tab is hidden, on the live voice page (nothing of Sky's plays over
  a voice report), on a page without the button (signed out), and `SKY_WARM_SECONDS` after a failed
  press too; a session still connecting then is closed as soon as it opens. `goAway` reconnects
  through `LiveSession` with a fresh token naming the previous one (`reconnect_of`), which counts a
  quarter only for a new session's token at least 5 minutes old, once (a reconnection's own token
  can't be renewed at a quarter, so they can't be chained).
- **Turns**: a turn the person interrupted (a new press while Sky answers), cancelled after it
  began, or whose press failed is dropped: its late audio and words are ignored until the server
  ends it (`interrupted` or its `turnComplete`), so nothing of it reaches the next reply. Its audio
  still counts in the usage report.
- **Turbo**: `#sky-ptt` is `data-turbo-permanent` and `hermes/sky_ptt.js` a module (run once per
  document; Turbo inserts body scripts without waiting for each other, so when it runs before
  `hermes/sky_ptt_logic.js` it imports that from `data-sky-logic-url`), so a reply keeps playing across Turbo visits; each page's own facts come from its
  non-permanent `<template data-sky-page data-screen data-room data-card data-hidden>`, read on
  `turbo:load`. The card sheet's card is read from the DOM at press time.
- iOS: the `AudioContext` is resumed in the press's own handler; `navigator.audioSession.type` stays
  `play-and-record` for capture (PTT and Voice Report). Do not switch to `playback` on release: that
  leaves Safari unable to `getUserMedia` until restart (iOS 17+, ignored elsewhere).

### Routes

All three: 404 unless the workspace and the live voice are on, `SKY_PTT` isn't `off` and lets this
person use it; `ApplicationController`'s chain (session only, no bots, `Sec-Fetch-Site` forgery
protection). They log `sky:` lines with ids, sizes and timings, never words or tokens.

| Route | Body → answer | Checks |
|---|---|---|
| `POST /sky/token` | `{reconnect_of?}` → `{token, ws_url, model, expires_at, warm_seconds, token_id}` | Month budget (402 `budget_paused`), Sky's hourly token limit (429 `rate_limited`; a reconnection of the person's own new-session token, 5 to 10 minutes old, counts ¼, once per token, never chained), then a 10-minute single-use token (`TokenLifetime::SKY`); 502 `upstream_error` if Gemini fails (an error counted, nothing charged) |
| `POST /sky/context` | `{screen, room_id?, card?, last?}` → `{press_id, note, chip, restricted}` | Counts a press (429 `daily_cap` past `SKY_PRESSES_PER_DAY`); room membership; card visibility; `last` = the previous press's timings, logged (known keys, numbers only) |
| `POST /sky/usage` | `{token_id, held_ms, reply_ms, turns}` → `{counted: true}` | The token must be one minted for this person in the last 30 minutes (404 `unknown_token`) and not reported yet (409 `already_reported`) |

### Cost, budget and usage

- **Tied to a minted token, spent once** (the S1 review's F6): `/sky/token` creates a receipt
  (`Sky::grant_token`); a minted token adds a floor of $0.005 (one exchange) to the month at once,
  so a page that never reports still counts; `/sky/usage` adds the estimate above that floor
  (audio in $0.005/min, out $0.018/min, $0.0015 per turn), clamped to one token's ceiling
  ($0.23), **once per receipt**, only for the person it was minted for. The page can't add a cost
  any other way (`record_cost` is gone).
- **One saver**: `sky-usage.json` is written only by the save task `controllers::sky::start` spawns
  (every 5 s, in `spawn_blocking`), and `Sky::save` holds a lock across the write, so two saves can
  never land out of order.
- Not in 1a: the admins' DM at 50 / 80 / 100 % of the budget and the usage panel (batch 3); the
  Google Cloud budget alert stays the owner's backstop.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SKY_PTT` | `off` | `off` (no route, nothing rendered) \| `spike` (as `admins`) \| `admins` \| `users` (`SKY_PTT_USERS` and administrators) \| `on` (everyone signed in, never bots) |
| `SKY_PTT_USERS` | empty | Pilot user ids, comma-separated (`1,5,9`) |
| `SKY_TOKENS_PER_HOUR` | `30` | Sky tokens per person per rolling hour; a reconnection of an open session counts a quarter |
| `SKY_PRESSES_PER_DAY` | `150` | Presses per person per house day (the handover's time zone) |
| `SKY_ASKS_PER_HOUR` | `30` | Questions to Hermes per person per rolling hour (batch 1b) |
| `SKY_MONTHLY_BUDGET_USD` | `100` | The organization's estimated month budget; reached, no more Sky tokens until the 1st (house time zone) |
| `SKY_WARM_SECONDS` | `120` | Idle seconds before the page closes a warm session (1–600) |

Caps are at least 1. A malformed `SKY_*` value **stops the boot** whenever the workspace is on; with
the workspace off they aren't read at all. The model is the voice page's `GEMINI_LIVE_MODEL`. The
rolling hourly windows and the token receipts are in memory (per process); the day and month
counters (presses, tokens, reconnections, asks, confirms, refusals, errors, estimated cost; no
words, no audio, no tokens) persist in `<CAMPFIRE_STORAGE_PATH>/hermes/sky-usage.json` (atomic
writes; 90 days per person, 13 months of totals). A file that can't be decoded is renamed
`sky-usage.json.corrupt-<seconds>` (logged at boot, for an administrator: the month's spend was in
it) and counting starts again from zero; the budget is then only the Google Cloud alert's until
someone restores it.

### To check on a real phone (plan §3.2)

Manual activity detection and the screen note as `clientContent` before `activityStart` (E5: one
reply, after release), time to first audio warm and cold (E1, the administrators' timing line),
transcription lag (E4), Turbo visits while Sky speaks (E7), iPhone home-screen app: microphone
prompt per launch, no long-press menu, reply on the loud speaker (E8), Android (E9), and
`usageMetadata` (E10, the token count in the timing line).

Open question: a warm session reconnects (`goAway`) with its last resumption handle, which may be
older than the turn just finished (the voice page saw a handle only right after setup, 29 Sep
2026); whether a resumed Sky session still has the previous exchange is untested.

## Where the code is

| Path | What |
|---|---|
| `crates/campfire/src/config.rs` | `GeminiLiveConfig`, `ApiKey` (redacted `Debug`) |
| `crates/campfire/src/integrations/gemini_live.rs` | Token request body, system instruction, `submit_incident` and `ask_hermes` declarations, `HttpMinter` (the existing `integrations::net` HTTP/1.1 + rustls client, no new crate), `TokenMinter` trait (tests swap it), rate limiters, the asker |
| `crates/campfire/src/integrations/hermes_ask.rs` | `Question` (`user_id`, optional room, `Channel`), `HttpAsker` (`POST HERMES_ASK_URL`, same client), `HermesAsker` trait (tests swap it), question cap |
| `crates/workspace/src/sky.rs` | Sky push-to-talk's config, limits, usage counters and token receipts, session setup and instruction, screen note, checked presses |
| `crates/workspace/src/overlay.rs`, `crates/workspace/templates/workspace/_sky_ptt.html` | The button's markup (`SkyButton`), rendered with the tab bar |
| `crates/campfire/src/controllers/sky.rs` | `/sky/token`, `/sky/context`, `/sky/usage`, the usage save task |
| `crates/assets/overrides/lib/hermes/live_session.js` | `LiveSession`, `Player` and the protocol helpers, shared by the voice page and Sky (moved out of `voice_controller.js` in batch 1a) |
| `crates/assets/overrides/hermes/sky_ptt.js`, `hermes/sky_ptt_logic.js` | The button's page script (one per document) and its pure logic (`globalThis.HermesSky`) |
| `crates/campfire/src/controllers/voice.rs` | The four actions, `IncidentReport` (caps, escaping, markup) |
| `crates/campfire/src/controllers/mod.rs` | `HERMES_ROUTES`, tried after the Rails table |
| `crates/campfire/src/app.rs` | `AppState::gemini_live` |
| `crates/views/src/hermes/`, `crates/views/templates/hermes/` | The page, the composer's voice buttons (`_composer_buttons.html`) and the inline audio player |
| `crates/views/templates/rooms/show/_composer.html` | The one upstream-template insertion: `hermes/_composer_buttons` after the attachment button |
| `crates/assets/overrides/controllers/voice_controller.js`, `voice/pcm-worklet.js`, `controllers/voice_note_controller.js`, `controllers/voice_player_controller.js`, `hermes/hermes.css`, `headset.svg`, `phone-hangup.svg`, `microphone.svg` | Frontend |
| `crates/assets/build/importmap.rs` | `pin_all_from` also picks up files the overrides *add* (otherwise `controllers/voice_controller` would never be pinned or registered) |

## Tests

- `integrations::gemini_live::tests`: request body shape, the lock (exactly `uses`, `expireTime`,
  `newSessionExpireTime`, `bidiGenerateContentSetup`, no `fieldMask`; the Constrained endpoint),
  token lifetimes (voice 30 min, Sky 10 min), `mint_locked`, quoting of names, extra instructions, rate
  limit, `ask_hermes` declared (and its instructions added) only when enabled, and the HTTP minter
  against a fake server (path, `x-goog-api-key`, body; 403 and garbage replies are errors).
- `integrations::hermes_ask::tests`: the asker against a fake bridge (path, JSON body with
  `user_id` and `channel`, a Sky question without a room; answer;
  504 → timeout, other statuses and blank answers are errors, the secret never in an error).
- `controllers::voice::tests`: feature off → 404 and no live button (the voice-note one stays);
  the page's data values and worklet URL (served as JavaScript); token route builds the locked setup through an injected
  minter, forgery protection, membership, 429, 502; report membership / validation / no-bot room;
  the bot-mention webhook proof above; report escaping and caps; route order; `ask`: 404 without
  `HERMES_ASK_URL` (and no `ask_hermes` in the token), forwarding to a fake bridge (with the
  speaker's `user_id`) and the answer,
  the question cap, membership / forgery / blank question, 504 on timeout, 502, 429.
- `campfire_workspace::sky::tests`: `SKY_*` parsing and defaults, who is allowed per mode, the
  rolling window, token limits with the reconnection weight, presses per house day across
  midnight in Paris, asks, the month budget's pause and new month, persistence round trip,
  retention, a damaged file; batch 1a: the setup (manual activity detection, no tools, quoted
  name and languages), the note (quoting, one line per fact, the chip), costs tied to a minted
  receipt and counted once (another person's or a forged id refused, the floor, the ceiling),
  reconnections (a quarter once per new session's token, 5 minutes old at least, within its life,
  never chained, given back when the mint fails), a damaged file kept aside, presses kept 10 minutes per person, saves
  serialized. `tests::sky_ptt`: a hidden card is dropped, a restricted one carries no content.
- `campfire_workspace::overlay::tests`: the button once, after the tab bar, permanent, with its
  template; hidden on the voice page; nothing when off; the screen of each path.
- `controllers::sky::tests` (CI): 404 and nothing rendered while off, without the voice or the
  workspace, or for a member under `admins`; a pilot member under `users`; the button on a room,
  Home and (hidden) the voice page; the token request locked, 10 minutes, Sky's setup; the hourly
  limit and a reconnection's quarter; forgery protection; 502; the month budget pausing tokens and
  usage counted once; the context's room and card checks and the daily cap; route order.
- `node --test crates/assets/tests/js/*.test.mjs`: `live_session.test.mjs` (a fake socket: the note
  then `activityStart`, `activityEnd`, server content and `usageMetadata`, a tool call, `goAway`
  reconnecting with one token) and `sky_ptt_logic.test.mjs` (every transition, the 300 ms tip,
  the 60 px cancel, the 60 s limit, the page hint, the shortcut, three exchanges kept, error
  sentences, timings without words).
- `crates/views/tests/hermes_views.rs`: the page renders; the composer's buttons are absent with both
  flags off (the goldens' input) and present, in place, with each on; voice notes get a player and a
  compact line, other audio files keep their file link.
- `crates/views/tests/hermes_head.rs`: the head seam links `hermes/hermes.css` once, after
  Custom styles, and nothing while not installed.
- `crates/assets/tests/reference.rs`: the import map equals the reference's plus the added
  controllers' pins and `lib/hermes/live_session`; `hermes/hermes.css` is served but not in
  `stylesheet_link_tag :all`; Sky's scripts are served, not pinned.

The request-level tests need the parity seed (`parity/bin/seed build`) and skip without it.

## Privacy

Transcripts are personal data (GDPR): they end up in the room's message and in whatever the bot
files. Decide on retention, or drop the transcript from the message if a summary is enough.
