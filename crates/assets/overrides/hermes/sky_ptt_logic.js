// Hermes fork: Sky push-to-talk's logic that doesn't touch the page (docs/hermes-gemini-live.md,
// "Sky push-to-talk"), apart from hermes/sky_ptt.js so that Node's own test runner can test it:
// `node --test crates/assets/tests/js/*.test.mjs`.
//
// The tab bar loads this module before hermes/sky_ptt.js (module scripts run in document order),
// which reads it from `globalThis.HermesSky`: asset URLs are digested, so sky_ptt.js can't import it
// by a relative path.

// iOS 17+ AudioSession for any capture path (PTT mic and Voice Report). Stay on play-and-record;
// switching to "playback" after PTT release leaves Safari with InvalidStateError until restart
// ("AudioSession category is not compatible with audio capture"). Loud-speaker routing on iPhone
// is not chased here.
export const CAPTURE_AUDIO_SESSION = "play-and-record"

export function iosAudioSessionFor(_phase) {
  return CAPTURE_AUDIO_SESSION
}

// A release before this is a tap: a tip, nothing sent (and nothing reaches Gemini: the turn only
// starts once the hold passed it).
export const TIP_MS = 300
// Sliding this far up from the press point drops the request ("Release here to cancel").
export const CANCEL_PX = 60
// The longest hold: a warning first, then it sends by itself.
export const WARN_HOLD_MS = 50_000
export const MAX_HOLD_MS = 60_000
// Replies kept in the bubble.
export const KEEP_EXCHANGES = 3
// A restored reply (after a full page load) older than this isn't shown.
export const RESTORE_MAX_AGE_MS = 10 * 60_000
// Sky's whole answer may take a while (a long reply); past this with nothing, it's an error.
export const REPLY_TIMEOUT_MS = 30_000

// The page's states (`data-state` on the button drives the CSS):
//   ready → warming (held, connecting; audio is buffered) → listening → thinking → speaking → ready
//   plus tip (a tap), cancelled, error, offline, no_permission, unsupported.
export const STATES = [ "ready", "warming", "listening", "thinking", "speaking", "tip", "cancelled", "error", "offline", "no_permission", "unsupported" ]

// state → event → next state. Events not listed leave the state as it is.
const IDLE = { press: "warming", reset: "ready", fail: "error", offline: "offline", denied: "no_permission" }
const TRANSITIONS = {
  ready: IDLE,
  tip: IDLE,
  cancelled: IDLE,
  error: IDLE,
  offline: IDLE,
  no_permission: IDLE,
  warming: { connected: "listening", release: "thinking", short: "tip", cancel: "cancelled", fail: "error", offline: "offline", denied: "no_permission", reset: "ready" },
  listening: { release: "thinking", short: "tip", cancel: "cancelled", fail: "error", offline: "offline", reset: "ready" },
  thinking: { reply: "speaking", done: "ready", press: "warming", fail: "error", offline: "offline", reset: "ready" },
  speaking: { done: "ready", press: "warming", fail: "error", offline: "offline", reset: "ready" },
  unsupported: {}
}

export function next(state, event) {
  return TRANSITIONS[state]?.[event] || state
}

// Holding (the microphone is open).
export function holding(state) {
  return state === "warming" || state === "listening"
}

// Sky is answering (a press now interrupts it).
export function answering(state) {
  return state === "thinking" || state === "speaking"
}

// The pointer is in the "Release here to cancel" zone: `dy` is how far it moved down since the
// press (negative: up).
export function inCancelZone(dy) {
  return dy <= -CANCEL_PX
}

// What a release does: "cancel" (slid up, or the pointer was taken away), "tip" (a tap) or "send".
export function classifyRelease({ heldMs, cancelling = false }) {
  if (cancelling) return "cancel"
  if (heldMs < TIP_MS) return "tip"
  return "send"
}

// While held: "ok", "warn" (the last ten seconds) or "limit" (send now).
export function holdStage(heldMs) {
  if (heldMs >= MAX_HOLD_MS) return "limit"
  if (heldMs >= WARN_HOLD_MS) return "warn"
  return "ok"
}

const SCREENS = [ "home", "chats", "room", "board", "card", "sky", "other" ]

// The press's hint for POST /sky/context, from the page's `<template data-sky-page>` (its dataset)
// and the card sheet open over it (its number, or null). The server checks all of it.
export function pageHint(dataset = {}, sheetNumber = null) {
  const screen = SCREENS.includes(dataset.screen) ? dataset.screen : "other"
  const id = value => /^\d{1,15}$/.test(String(value ?? "")) ? Number(value) : null
  const card = id(sheetNumber) ?? id(dataset.card)
  return { screen, room_id: id(dataset.room), card }
}

// Whether the page says to hide the button (the live voice page).
export function hiddenOn(dataset) {
  return !dataset || dataset.hidden === "true"
}

// Typing in a field: keyboard shortcuts stay out of the way.
export function isTyping(element) {
  if (!element || !element.tagName) return false
  if (element.isContentEditable) return true
  const tag = element.tagName.toLowerCase()
  if (tag === "textarea" || tag === "select") return true
  if (tag !== "input") return false
  return ![ "button", "checkbox", "radio", "submit", "reset", "range", "color", "file", "image" ].includes((element.type || "text").toLowerCase())
}

// The desktop shortcut: hold Ctrl+Shift+Space (⌃⇧Space on a Mac), not while typing (plan O5).
export function isShortcut(event, typing = false) {
  return Boolean(event && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === "Space" && !typing)
}

// The replies the bubble shows: the newest last, at most KEEP_EXCHANGES.
export function keepExchanges(exchanges, exchange) {
  return [ ...exchanges, exchange ].slice(-KEEP_EXCHANGES)
}

export const TEXTS = {
  ready: "Hold to talk",
  warming: "Listening…",
  listening: "Listening…",
  releaseToCancel: "Release to cancel",
  thinking: "Thinking…",
  speaking: "Speaking · tap to stop",
  tip: "Keep holding while you speak, then let go.",
  cancelled: "Cancelled. Nothing was sent.",
  stopped: "Stopped.",
  holdWarning: "10 seconds left",
  holdLimit: "Sent: a minute is the longest hold.",
  offline: "Offline",
  offlineHelp: "No connection. Sky’s voice comes back when you’re online.",
  insecure: "The microphone only works over HTTPS: open Meshduty at its https:// address.",
  unsupported: "This browser can’t talk to Sky. Try a recent browser.",
  micDenied: "Microphone access is blocked.",
  micDeniedHelp: "Chrome: padlock in the address bar → Microphone → Allow.\niPhone: Settings → Safari → Microphone. Then hold the button again.",
  micMissing: "No microphone found on this device.",
  micError: "Couldn’t open the microphone.",
  unavailable: "Sky’s voice is unavailable; try again in a moment.",
  connectError: "Couldn’t reach Sky’s voice. Check the connection, then try again.",
  connectionLost: "The connection was lost. Hold the button to try again.",
  noReply: "Sky didn’t answer. Try again.",
  signedOut: "You’re signed out. Sign in again, then retry.",
  you: "You",
  sky: "Sky",
  listeningHeader: "SKY IS LISTENING",
  thinkingHeader: "SKY IS THINKING",
  replyHeader: "SKY",
  dismiss: "Dismiss",
  details: "Technical details",
  announceListening: "Listening",
  announceThinking: "Sky is thinking",
  buttonLabel: "Hold to talk to Sky"
}

// The plain sentence for a failed request to /sky/token or /sky/context (the server's own message
// for its refusals: limits, the daily cap, the paused budget).
export function replyError({ status = 0, redirected = false } = {}, body = {}) {
  if (redirected || status === 401) return TEXTS.signedOut
  if (status === 0) return TEXTS.offlineHelp
  if (typeof body?.message === "string" && body.message && status < 500) return body.message
  if (status === 404) return "Sky’s voice is off for you."
  return TEXTS.unavailable
}

// The microphone's failure, as a sentence (+ help), from getUserMedia's error.
export function micError(error) {
  const name = error?.name || ""
  if (name === "NotAllowedError" || name === "SecurityError") return { message: TEXTS.micDenied, help: TEXTS.micDeniedHelp, state: "no_permission" }
  if (name === "NotFoundError" || name === "OverconstrainedError") return { message: TEXTS.micMissing, state: "error" }
  return { message: TEXTS.micError, state: "error" }
}

// The note the session gets when the person cancels after their audio started streaming.
export const CANCEL_NOTE = "[The person cancelled this request: ignore it and say nothing.]"

// Seconds of 24 kHz Int16 audio in a base64 chunk (for the session's usage report).
export function audioMsFromBase64(base64, rate = 24000) {
  const length = String(base64 || "").replace(/=+$/, "").length
  const bytes = Math.floor(length * 3 / 4)
  return Math.round((bytes / 2) / rate * 1000)
}

// The usage report for one token's session (POST /sky/usage).
export function usageReport(tokenId, { heldMs = 0, replyMs = 0, turns = 0 } = {}) {
  return { token_id: tokenId, held_ms: Math.max(0, Math.round(heldMs)), reply_ms: Math.max(0, Math.round(replyMs)), turns: Math.max(0, turns | 0) }
}

const OUTCOMES = [ "answered", "no_reply", "cancelled", "tip", "error", "interrupted" ]

// One press's timings, sent with the next press (`last`) for the server's log: numbers only.
export function timingsReport(press) {
  if (!press) return null
  const ms = (from, to) => (Number.isFinite(from) && Number.isFinite(to) && to >= from) ? Math.round(to - from) : -1
  return {
    outcome: OUTCOMES.includes(press.outcome) ? press.outcome : "error",
    warm: Boolean(press.warm),
    held_ms: ms(press.pressedAt, press.releasedAt),
    context_ms: ms(press.pressedAt, press.contextAt),
    connect_ms: ms(press.pressedAt, press.connectedAt),
    release_to_first_text_ms: ms(press.releasedAt, press.firstTextAt),
    release_to_first_audio_ms: ms(press.releasedAt, press.firstAudioAt),
    reply_ms: Math.max(-1, Math.round(press.replyMs ?? -1)),
    reply_chars: Math.max(-1, press.replyChars ?? -1),
    total_tokens: Number.isFinite(press.totalTokens) ? press.totalTokens : -1
  }
}

// The administrators' line under a reply: "first words 0.8 s · first audio 1.2 s · warm".
export function timingsText(report) {
  if (!report) return ""
  const seconds = ms => ms >= 0 ? `${(ms / 1000).toFixed(1)} s` : "–"
  const parts = [ `first words ${seconds(report.release_to_first_text_ms)}`, `first audio ${seconds(report.release_to_first_audio_ms)}` ]
  parts.push(report.warm ? "warm" : `cold (connect ${seconds(report.connect_ms)})`)
  if (report.total_tokens >= 0) parts.push(`${report.total_tokens} tokens`)
  return parts.join(" · ")
}

// For display: typographic apostrophes, spaces folded (the transcription arrives in pieces).
export function displayText(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/'/g, "’").trim()
}

globalThis.HermesSky = {
  CAPTURE_AUDIO_SESSION, TIP_MS, CANCEL_PX, WARN_HOLD_MS, MAX_HOLD_MS, KEEP_EXCHANGES, RESTORE_MAX_AGE_MS, REPLY_TIMEOUT_MS, STATES, TEXTS, CANCEL_NOTE,
  iosAudioSessionFor, next, holding, answering, inCancelZone, classifyRelease, holdStage, pageHint, hiddenOn, isTyping, isShortcut, keepExchanges,
  replyError, micError, audioMsFromBase64, usageReport, timingsReport, timingsText, displayText
}
