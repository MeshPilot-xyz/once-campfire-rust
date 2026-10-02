// Hermes fork: tests of Sky push-to-talk's page logic (overrides/hermes/sky_ptt_logic.js), with
// Node's built-in runner, no npm package: `node --test crates/assets/tests/js/*.test.mjs`.
import { test } from "node:test"
import assert from "node:assert/strict"

import * as sky from "../../overrides/hermes/sky_ptt_logic.js"

test("the module also publishes itself for sky_ptt.js", () => {
  assert.equal(globalThis.HermesSky.next, sky.next)
  assert.equal(globalThis.HermesSky.TEXTS.ready, "Hold to talk")
})

test("every transition of a press", () => {
  const run = (events, from = "ready") => events.reduce((state, event) => sky.next(state, event), from)
  assert.equal(run([ "press" ]), "warming")
  assert.equal(run([ "press", "connected" ]), "listening")
  assert.equal(run([ "press", "connected", "release" ]), "thinking")
  assert.equal(run([ "press", "release" ]), "thinking", "released while still connecting: sent once connected")
  assert.equal(run([ "press", "connected", "release", "reply" ]), "speaking")
  assert.equal(run([ "press", "connected", "release", "reply", "done" ]), "ready")
  assert.equal(run([ "press", "connected", "release", "done" ]), "ready", "a turn with no reply")
  assert.equal(run([ "press", "short" ]), "tip")
  assert.equal(run([ "press", "connected", "cancel" ]), "cancelled")
  assert.equal(run([ "press", "fail" ]), "error")
  assert.equal(run([ "press", "denied" ]), "no_permission")
  assert.equal(run([ "press", "offline" ]), "offline")
  // Interrupting Sky: a new press while it thinks or speaks.
  assert.equal(run([ "press", "release", "press" ]), "warming")
  assert.equal(run([ "press", "release", "reply", "press" ]), "warming")
  // Everything after a failure or a tip starts over with a press.
  for (const state of [ "tip", "cancelled", "error", "offline", "no_permission" ]) {
    assert.equal(sky.next(state, "press"), "warming", state)
    assert.equal(sky.next(state, "reset"), "ready", state)
  }
  // Events that don't apply leave the state alone.
  assert.equal(sky.next("ready", "release"), "ready")
  assert.equal(sky.next("ready", "reply"), "ready")
  assert.equal(sky.next("thinking", "connected"), "thinking")
  assert.equal(sky.next("unsupported", "press"), "unsupported", "nothing gets out of unsupported")
  assert.equal(sky.next("nonsense", "press"), "nonsense")
  for (const state of sky.STATES) assert.equal(typeof sky.next(state, "press"), "string")
  assert.ok(sky.holding("warming") && sky.holding("listening") && !sky.holding("thinking"))
  assert.ok(sky.answering("thinking") && sky.answering("speaking") && !sky.answering("ready"))
})

test("gesture thresholds: 300 ms tip, 60 px cancel, a minute at most", () => {
  assert.equal(sky.classifyRelease({ heldMs: 299 }), "tip")
  assert.equal(sky.classifyRelease({ heldMs: 300 }), "send")
  assert.equal(sky.classifyRelease({ heldMs: 5000, cancelling: true }), "cancel")
  assert.equal(sky.classifyRelease({ heldMs: 100, cancelling: true }), "cancel", "cancelling wins over a tip")
  assert.equal(sky.inCancelZone(-59), false)
  assert.equal(sky.inCancelZone(-60), true)
  assert.equal(sky.inCancelZone(80), false, "down is not cancel")
  assert.equal(sky.holdStage(49_999), "ok")
  assert.equal(sky.holdStage(50_000), "warn")
  assert.equal(sky.holdStage(60_000), "limit")
})

test("the page's hint, from its template and the open sheet", () => {
  assert.deepEqual(sky.pageHint({ screen: "room", room: "12", card: "", hidden: "false" }), { screen: "room", room_id: 12, card: null })
  assert.deepEqual(sky.pageHint({ screen: "room", room: "12", card: "" }, "57"), { screen: "room", room_id: 12, card: 57 }, "the sheet's card")
  assert.deepEqual(sky.pageHint({ screen: "card", room: "", card: "57" }), { screen: "card", room_id: null, card: 57 })
  assert.deepEqual(sky.pageHint({ screen: "<img>", room: "x1", card: "1e3" }), { screen: "other", room_id: null, card: null })
  assert.deepEqual(sky.pageHint(), { screen: "other", room_id: null, card: null })
  assert.equal(sky.hiddenOn({ hidden: "true" }), true)
  assert.equal(sky.hiddenOn({ hidden: "false" }), false)
  assert.equal(sky.hiddenOn(undefined), true)
})

test("the desktop shortcut stays out of text fields", () => {
  const key = (extra = {}) => ({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: "Space", ...extra })
  assert.equal(sky.isShortcut(key()), true)
  assert.equal(sky.isShortcut(key(), true), false)
  assert.equal(sky.isShortcut(key({ shiftKey: false })), false, "Ctrl+Space switches input languages")
  assert.equal(sky.isShortcut(key({ altKey: true })), false)
  assert.equal(sky.isShortcut(key({ code: "KeyS" })), false)
  assert.equal(sky.isTyping({ tagName: "TEXTAREA" }), true)
  assert.equal(sky.isTyping({ tagName: "INPUT", type: "text" }), true)
  assert.equal(sky.isTyping({ tagName: "INPUT", type: "checkbox" }), false)
  assert.equal(sky.isTyping({ tagName: "DIV", isContentEditable: true }), true, "the composer's editor")
  assert.equal(sky.isTyping({ tagName: "BUTTON" }), false)
  assert.equal(sky.isTyping(null), false)
})

test("the bubble keeps the last three exchanges", () => {
  let list = []
  for (const n of [ 1, 2, 3, 4 ]) list = sky.keepExchanges(list, { n })
  assert.deepEqual(list.map(e => e.n), [ 2, 3, 4 ])
})

test("plain sentences for refusals and failures", () => {
  assert.equal(sky.replyError({ status: 429 }, { message: "You’ve reached today’s limit for Sky’s voice. Use the Sky tab until tomorrow." }),
    "You’ve reached today’s limit for Sky’s voice. Use the Sky tab until tomorrow.")
  assert.equal(sky.replyError({ status: 402 }, { message: "Sky’s voice is paused until the 1st of next month. Use the Sky tab." }).includes("paused"), true)
  assert.equal(sky.replyError({ status: 502 }, { message: "upstream detail" }), sky.TEXTS.unavailable, "no upstream detail in the sentence")
  assert.equal(sky.replyError({ status: 200, redirected: true }), sky.TEXTS.signedOut)
  assert.equal(sky.replyError({ status: 0 }), sky.TEXTS.offlineHelp)
  assert.equal(sky.replyError({ status: 404 }, {}), "Sky’s voice is off for you.")
  assert.equal(sky.micError({ name: "NotAllowedError" }).state, "no_permission")
  assert.match(sky.micError({ name: "NotAllowedError" }).help, /Microphone/)
  assert.equal(sky.micError({ name: "NotFoundError" }).message, sky.TEXTS.micMissing)
  assert.equal(sky.micError(new Error("x")).message, sky.TEXTS.micError)
})

test("usage and timings: numbers only", () => {
  // 4800 bytes of 24 kHz Int16 = 2400 samples = 100 ms.
  const base64 = Buffer.alloc(4800).toString("base64")
  assert.equal(sky.audioMsFromBase64(base64), 100)
  assert.deepEqual(sky.usageReport("t1", { heldMs: 1234.6, replyMs: -5, turns: 2 }), { token_id: "t1", held_ms: 1235, reply_ms: 0, turns: 2 })

  const press = {
    outcome: "answered", warm: true, pressedAt: 1000, contextAt: 1150, connectedAt: 1000, releasedAt: 3000,
    firstTextAt: 3800, firstAudioAt: 4200, replyMs: 2500, replyChars: 64, totalTokens: 812, you: "secret words", reply: "secret reply"
  }
  const report = sky.timingsReport(press)
  assert.deepEqual(report, {
    outcome: "answered", warm: true, held_ms: 2000, context_ms: 150, connect_ms: 0,
    release_to_first_text_ms: 800, release_to_first_audio_ms: 1200, reply_ms: 2500, reply_chars: 64, total_tokens: 812
  })
  assert.ok(!JSON.stringify(report).includes("secret"), "never the words")
  assert.equal(sky.timingsText(report), "first words 0.8 s · first audio 1.2 s · warm · 812 tokens")
  const cold = sky.timingsReport({ outcome: "weird", pressedAt: 0, releasedAt: 500, connectedAt: 900, firstAudioAt: NaN })
  assert.equal(cold.outcome, "error")
  assert.equal(cold.release_to_first_audio_ms, -1)
  assert.equal(sky.timingsText(cold), "first words – · first audio – · cold (connect 0.9 s)")
  assert.equal(sky.timingsReport(null), null)
})

test("display text", () => {
  assert.equal(sky.displayText("  it's   ready\n"), "it’s ready")
  assert.equal(sky.displayText(undefined), "")
})

test("iOS capture paths stay on play-and-record (never playback)", () => {
  assert.equal(sky.CAPTURE_AUDIO_SESSION, "play-and-record")
  for (const phase of [ "press", "release", "cancel", "voice-report", "hidden" ]) {
    assert.equal(sky.iosAudioSessionFor(phase), "play-and-record", phase)
    assert.notEqual(sky.iosAudioSessionFor(phase), "playback", phase)
  }
})
