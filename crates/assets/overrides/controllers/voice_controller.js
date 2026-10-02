import { Controller } from "@hotwired/stimulus"
import {
  INPUT_RATE, STEP_TIMEOUT_MS, StepTimeout, withTimeout, base64FromBytes, bytesFromBase64, float32FromPcm16, frameText,
  setupMessage, audioMessage, textMessage, toolResponseMessage, TokenError, ConnectError, LiveSession, Player, levelFromPcm16
} from "lib/hermes/live_session"

// The protocol and audio helpers moved to lib/hermes/live_session.js (shared with Sky
// push-to-talk); re-exported here under their old names.
export {
  StepTimeout, withTimeout, base64FromBytes, bytesFromBase64, float32FromPcm16, frameText,
  setupMessage, audioMessage, textMessage, toolResponseMessage, TokenError, ConnectError, LiveSession, levelFromPcm16
}

// Live voice ticket (a request, fault, complaint or incident, in any language) over Gemini Live,
// spoken directly from the browser.
//
// The server mints a single-use ephemeral token that locks the whole session setup (model,
// instructions, tools, transcription, resumption, compression), so the browser only ever sends
// `{"setup":{}}` (plus a resumption handle when reconnecting) and never sees the API key. The
// microphone is captured by voice/pcm-worklet.js (16 kHz Int16LE mono, ~100 ms chunks); the
// model answers with 24 kHz Int16LE mono audio and incremental transcriptions of both sides.
// When the model calls `submit_incident`, its arguments plus the accumulated transcript are
// POSTed to the report URL, which publishes the message in the room as the current user. When the
// page has an ask URL (HERMES_ASK_URL on the server), the model can also call `ask_hermes`: the
// question is POSTed there, the server asks the Hermes agent (shown as Sky), and the answer goes
// back to the model as the tool response, which it then speaks. The page shows each question as a
// small "Sky" line; those lines stay out of the report's transcript (the assistant's spoken answer is in it).
//
// The protocol lives in LiveSession (lib/hermes/live_session.js: no DOM, no audio) so it can be
// exercised on its own; the Stimulus controller wires it to the microphone, the speaker and the page.
//
// Never store anything in `this.context`, `this.element`, `this.application`, `this.scope`,
// `this.data` or `this.targets` in the controller: they're Stimulus' own (an AudioContext once
// stored in `this.context` broke every target lookup).

const FINISH_TIMEOUT_MS = 10000
// The server gives the bridge 60 s (and the bridge gives Hermes 55 s); a little more here.
const ASK_TIMEOUT_MS = 65000

// The report's transcript says "Employee" (fixed English labels, like the report's, whatever language
// is spoken); the page says "You".
const LABELS = { user: "Employee", model: "Assistant" }
const SCREEN_LABELS = { user: "You", model: "Assistant" }

// Sent as text right after setup so the assistant speaks first (greets, asks what they need). Text
// input isn't transcribed, so it shows neither on the page nor in the report. In English, like the
// system instruction, which says which language to greet in.
export const KICKOFF_TEXT = "[The session starts: greet the employee briefly, in the language your instructions say, and ask what they need or what happened.]"

// For the "Technical details" of an error, not the sentence.
const STEP_LABELS = {
  mic: "microphone permission",
  audio: "starting the browser's audio",
  token: "opening a session on the Meshduty server",
  connect: "connecting to Google's voice service (generativelanguage.googleapis.com)"
}

export const MESSAGES = {
  ready: "Tap the mic to start",
  insecure: "The microphone only works over HTTPS: open this page at an https:// address.",
  unsupported: "This browser can't hold a live voice conversation. Try a recent browser.",
  micDenied: "Microphone access is blocked.",
  micDeniedHelp: "Chrome: padlock in the address bar → Microphone → Allow.\niPhone: Settings → Safari → Microphone. Then try again.",
  micMissing: "No microphone found on this device.",
  micError: "Couldn't open the microphone.",
  micLost: "The microphone was cut off (an incoming call, another app or the screen locked).",
  stepMic: "Asking for microphone access…",
  stepConnect: "Connecting to the assistant…",
  reconnecting: "Reconnecting…",
  listening: "Your turn",
  speaking: "The assistant is speaking…",
  liveHint: "Confirm the recap to the assistant to send the ticket.",
  resumeFailed: "Reconnected; the assistant picked up where you left off.",
  rateLimited: "Too many sessions in a short time. Wait a minute, then try again.",
  tokenError: "Couldn't open a voice session. Try again in a moment.",
  connectError: "Couldn't reach the voice assistant. Check the connection, then try again.",
  timeout: "The voice assistant isn't answering. Try again.",
  closed: "The connection was lost.",
  closedStatus: "Connection lost",
  closedHelp: "Tap the mic to carry on.",
  retry: "Tap the mic to try again",
  unavailable: "Unavailable",
  paused: "Conversation paused",
  submitting: "Sending the ticket…",
  submitError: "Sending the ticket failed. The assistant will offer to try again.",
  finishing: "Ticket sent. The assistant is wrapping up…",
  asking: "Checking with Sky…",
  askLabel: "Question for Sky",
  askPending: "Waiting for the answer…",
  askAnswered: "Answered",
  askFailed: "No answer",
  live: "Live.",
  details: "Technical details",
  published: "Ticket sent",
  publishedIn: (room) => `Ticket sent to “${room}”: Sky files it and confirms in the room.`
}

// Button labels (the round button's accessible name).
const TOGGLE_LABELS = {
  idle: "Start", starting: "Connecting…", live: "Hang up", finishing: "Hang up",
  stopped: "Resume", closed: "Resume", error: "Try again", unavailable: "Unavailable", done: "Done"
}

// Accumulates the incremental transcriptions into alternating "Employee: …" / "Assistant: …"
// turns.
export class Transcript {
  constructor() {
    this.lines = []
    this.turnEnded = false
  }

  // Returns the line that was appended to or created.
  append(role, text) {
    if (!text) return null

    const last = this.lines[this.lines.length - 1]
    const continues = last && last.role === role && !(role === "model" && this.turnEnded)
    this.turnEnded = false

    if (continues) {
      last.text += text
      return last
    } else {
      const line = { role, text: text.replace(/^\s+/, "") }
      this.lines.push(line)
      return line
    }
  }

  // The model's next words start a new line even if the employee said nothing in between.
  endTurn() {
    this.turnEnded = true
  }

  get empty() {
    return this.toString() === ""
  }

  toString() {
    return this.lines
      .map(({ role, text }) => `${LABELS[role]}: ${text.replace(/\s+/g, " ").trim()}`)
      .filter(line => !line.endsWith(": "))
      .join("\n")
  }
}

// Sent as text after a reconnection. Observed on 2026-09-29: a resumed session is accepted, but
// the server only issued a resumption handle right after setup, so the conversation since then
// was lost. Replaying the transcript makes reconnects safe either way.
export function recapText(transcript) {
  return "[Resuming after a connection loss. Here is the conversation so far; do not repeat it " +
    "and do not ask again what was already answered: carry on where it stopped, in the language " +
    "the employee was speaking.]\n" + transcript.toString()
}


const pad = (n) => String(n).padStart(2, "0")

// For display: typographic apostrophes. Nothing language-specific (the transcript is in whatever
// language the employee speaks).
export function displayText(text) {
  return text.replace(/'/g, "’")
}

// 65 → "01:05"
export function formatClock(seconds) {
  const whole = Math.max(0, Math.floor(seconds))
  return `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`
}

// ---------------------------------------------------------------------------------------------
// Stimulus controller
//
// States (data-voice-state): idle → starting → live ⇄ (finishing → done)
//   live → stopped ("Hang up"), closed (connection lost), error; each can resume (retry())
//   with the transcript kept, or "Start over" (in-page confirmation) wipes it.
//   unavailable: no HTTPS, no AudioWorklet.
// While live, data-voice-activity is "speaking" while the assistant's audio plays, else
// "listening".

export default class extends Controller {
  static targets = [ "toggle", "label", "control", "status", "timer", "hint", "transcript", "notice", "noticeBody",
    "confirm", "cancel", "resume", "restart", "result", "resultText", "messageLink", "announcer" ]
  static values = { tokenUrl: String, reportUrl: String, askUrl: String, workletUrl: String, roomUrl: String, roomName: String }

  connect() {
    this.state = "idle"
    this.activity = "listening"
    this.transcript = new Transcript()
    this.submitted = false
    this.liveSeconds = 0
    this.liveSince = null
    this.level = 0
    this.onVisibilityChange = () => this.#reacquireWakeLock()
    document.addEventListener("visibilitychange", this.onVisibilityChange)

    // The transcript sticks to its newest line unless scrolled up, also when the notice or the
    // action buttons appear and shrink it.
    this.stickToBottom = true
    this.onTranscriptScroll = () => {
      const t = this.transcriptTarget
      this.stickToBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 48
    }
    this.transcriptTarget.addEventListener("scroll", this.onTranscriptScroll, { passive: true })
    if (window.ResizeObserver) {
      this.transcriptObserver = new ResizeObserver(() => this.#stickTranscript())
      this.transcriptObserver.observe(this.transcriptTarget)
    }

    if (!window.isSecureContext) {
      this.#fail({ message: MESSAGES.insecure, retry: false })
    } else if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      this.#fail({ message: MESSAGES.unsupported, retry: false })
    } else {
      this.#render()
    }
  }

  disconnect() {
    document.removeEventListener("visibilitychange", this.onVisibilityChange)
    this.transcriptTarget.removeEventListener("scroll", this.onTranscriptScroll)
    this.transcriptObserver?.disconnect()
    this.#teardown()
    this.session = null
    clearInterval(this.clockTimer)
    clearTimeout(this.transientTimer)
  }

  // Works whether or not the markup wires the button with data-action="voice#toggle".
  toggleTargetConnected(button) {
    if (!(button.dataset.action || "").includes("voice#")) {
      button.addEventListener("click", event => this.toggle(event))
    }
  }

  toggle(event) {
    event?.preventDefault()

    switch (this.state) {
      case "idle":      return this.start()
      case "live":
      case "finishing": return this.stop()
      case "stopped":
      case "closed":
      case "error":     return this.retry()
    }
  }

  // A fresh conversation. Only reached with an empty transcript (idle, or after "Start over").
  async start() {
    if (this.state === "starting" || this.state === "live") return
    if (!this.#supported) return

    this.#reset()
    this.#enterStarting(MESSAGES.stepMic)

    try {
      await this.#startAudio()
      this.#setStep(MESSAGES.stepConnect)
      this.session = this.#buildSession()
      await this.session.start()
      if (this.state !== "starting") return this.session?.close()

      this.session.sendText(KICKOFF_TEXT)
      this.#enterLive()
    } catch (error) {
      if (this.state === "starting") this.#startFailed(error)
    }
  }

  // Resumes the conversation (after "Hang up", a lost connection or an error), transcript
  // kept: a fresh token, the session resumed when possible, and the transcript replayed to the
  // assistant either way (LiveSession's onReconnected).
  async retry() {
    if (!this.session) return this.start()
    if (this.state === "starting" || this.state === "live") return

    this.#hideNotice()
    this.#hideConfirm()
    this.#enterStarting(this.audioContext ? MESSAGES.reconnecting : MESSAGES.stepMic)

    try {
      if (!this.audioContext || this.audioContext.state === "closed") await this.#startAudio()
      await withTimeout(this.audioContext.resume().catch(() => {}), 3000, "audio").catch(() => {})
      this.#setStep(MESSAGES.stepConnect)
      const { resumed } = await this.session.restart()
      if (this.state !== "starting") return

      this.#enterLive()
      if (!resumed) this.#setTransient(MESSAGES.resumeFailed, 4000)
    } catch (error) {
      if (this.state === "starting") this.#startFailed(error)
    }
  }

  // "Hang up": ends the call, keeps the transcript (and the session, to resume).
  stop() {
    if (this.state === "finishing") return this.#finish()
    this.#teardown()
    this.#hideNotice()
    this.state = this.submitted ? "done" : (this.transcript.empty ? "idle" : "stopped")
    this.#render()
    this.#announce(this.state === "stopped" ? MESSAGES.paused : "")
  }

  // The small "Cancel" while starting.
  cancel(event) {
    event?.preventDefault()
    if (this.state !== "starting") return
    this.#teardown()
    this.state = this.transcript.empty ? "idle" : "stopped"
    this.#render()
    this.#focus(this.toggleTarget)
  }

  // "Start over": asks first when there's something to lose.
  restart(event) {
    event?.preventDefault()
    if (this.transcript.empty) return this.confirmRestart()

    this.confirmTarget.hidden = false
    this.#focus(this.confirmTarget.querySelector("button"))
  }

  confirmRestart(event) {
    event?.preventDefault()
    this.#hideConfirm()
    this.#teardown()
    this.session = null
    this.state = "idle"
    this.start()
  }

  cancelRestart(event) {
    event?.preventDefault()
    this.#hideConfirm()
    this.#focus(this.hasRestartTarget ? this.restartTarget : this.toggleTarget)
  }

  // Session wiring

  #buildSession() {
    return new LiveSession({
      fetchToken: () => this.#fetchToken(),
      handlers: {
        onAudio: data => this.player?.enqueue(data),
        onInterrupted: () => {
          this.player?.flush()
          this.#setActivity("listening")
        },
        onTranscript: (role, text) => this.#appendTranscript(role, text),
        onTurnComplete: () => {
          this.transcript.endTurn()
          this.#completeTurn()
          if (this.player?.idle !== false) this.#setActivity("listening")
          if (this.state === "finishing") this.#finishSoon()
        },
        onToolCall: call => this.#handleToolCall(call),
        onReconnecting: () => { if (this.state === "live") this.#setTransient(MESSAGES.reconnecting) },
        onReconnected: ({ resumed }) => {
          if (!this.submitted) this.session?.sendText(this.transcript.empty ? KICKOFF_TEXT : recapText(this.transcript))
          if (this.state === "live") this.#setTransient(resumed ? null : MESSAGES.resumeFailed, 4000)
        },
        onClosed: ({ code, reason }) => this.#connectionLost(code, reason)
      }
    })
  }

  #handleToolCall({ name, args }) {
    if (name === "submit_incident") return this.#submitIncident(args)
    if (name === "ask_hermes" && this.askUrlValue) return this.#askHermes(args)
    return { error: `Unknown tool: ${name}` }
  }

  // `ask_hermes`: the answer (or an error the assistant tells the employee about) is the tool
  // response. The assistant waits for it (blocking function call), having said it is checking
  // with Sky (in the employee's language).
  async #askHermes(args) {
    const question = String(args?.question || "").trim()
    if (!question) return { error: "Empty question." }

    const line = this.#appendHermesLine(question)
    this.#setTransient(MESSAGES.asking)
    this.#announce(`${MESSAGES.askLabel}: ${question}`)

    try {
      const answer = await this.#postQuestion(question)
      this.#settleHermesLine(line, true)
      return { result: answer }
    } catch (error) {
      console.warn("voice: ask_hermes failed", error)
      this.#settleHermesLine(line, false)
      return { error: "Sky did not answer." }
    } finally {
      if (this.transient === MESSAGES.asking) this.#setTransient(null)
    }
  }

  async #submitIncident(args) {
    if (this.submitted) return { result: "already_submitted" }

    this.#setTransient(MESSAGES.submitting)

    try {
      const report = await this.#postReport(args)
      this.submitted = true
      this.state = "finishing"
      this.#hideNotice()
      this.#showResult(report)
      this.#setTransient(null)
      this.#render()
      this.finishTimer = setTimeout(() => this.#finishSoon(), FINISH_TIMEOUT_MS)
      return { result: "ok" }
    } catch (error) {
      console.warn("voice: report failed", error)
      this.#setTransient(null)
      this.#showNotice({ message: MESSAGES.submitError, details: error.message })
      return { result: "error", error: "The ticket could not be sent. Tell the employee, in their language, and offer to try again." }
    }
  }

  // Lets the assistant finish its confirmation before hanging up.
  #finishSoon() {
    clearTimeout(this.finishTimer)
    const waitForPlayback = () => {
      if (this.state !== "finishing") return
      if (this.player && !this.player.idle) {
        this.finishTimer = setTimeout(waitForPlayback, 250)
      } else {
        this.#finish()
      }
    }
    this.finishTimer = setTimeout(waitForPlayback, 250)
  }

  #finish() {
    if (this.state !== "finishing") return
    this.#teardown()
    this.session = null
    this.state = "done"
    this.#render()
    this.#announce(this.hasResultTextTarget ? this.resultTextTarget.textContent : MESSAGES.published)
    if (this.hasMessageLinkTarget) this.#focus(this.messageLinkTarget)
  }

  #connectionLost(code, reason) {
    if (this.state === "finishing") return this.#finish()
    if (this.state !== "live") return

    console.warn("voice: connection closed", code, reason)
    this.#teardown()
    this.state = "closed"
    this.#showNotice({ message: `${MESSAGES.closed} ${MESSAGES.closedHelp}`, details: `WebSocket closed (code ${code}${reason ? `, ${reason}` : ""})` })
    this.#render()
  }

  #micLost() {
    if (this.state === "finishing") return this.#finish()
    if (this.state !== "live") return

    this.#teardown()
    this.#fail({ message: MESSAGES.micLost })
  }

  #startFailed(error) {
    this.#teardown()
    this.#fail(this.#describe(error))
  }

  // HTTP

  async #fetchToken() {
    let response
    try {
      response = await fetch(this.tokenUrlValue, { method: "POST", credentials: "same-origin", headers: this.#headers })
    } catch {
      throw new TokenError(0)
    }
    if (!response.ok) throw new TokenError(response.status)

    const body = await response.json()
    if (!body?.token || !body?.ws_url) throw new TokenError(response.status)
    return body
  }

  async #postReport(args) {
    const body = JSON.stringify({ ...args, transcript: this.transcript.toString() })
    const response = await fetch(this.reportUrlValue, {
      method: "POST", credentials: "same-origin", headers: this.#headers, body
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json().catch(() => ({}))
  }

  // Resolves with the answer text; rejects on an HTTP error, a network error or ASK_TIMEOUT_MS.
  async #postQuestion(question) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS)
    try {
      const response = await fetch(this.askUrlValue, {
        method: "POST", credentials: "same-origin", headers: this.#headers,
        body: JSON.stringify({ question }), signal: controller.signal
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      const answer = typeof body?.answer === "string" ? body.answer.trim() : ""
      if (!answer) throw new Error("empty answer")
      return answer
    } finally {
      clearTimeout(timer)
    }
  }

  get #headers() {
    const headers = { "Content-Type": "application/json", "Accept": "application/json" }
    const csrf = document.querySelector("meta[name=csrf-token]")?.content
    if (csrf) headers["X-CSRF-Token"] = csrf
    return headers
  }

  // Audio

  async #startAudio() {
    this.audioContext = new AudioContext()
    this.audioContext.resume().catch(() => {})
    // iOS 17+: PTT used to leave the session on "playback", which makes getUserMedia throw
    // InvalidStateError. Stay on play-and-record before any capture (same policy as Sky PTT).
    try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record" } catch {}

    try {
      this.stream = await withTimeout(navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      }), STEP_TIMEOUT_MS.mic, "mic")
    } catch (error) {
      if (!(error instanceof StepTimeout)) error.micError = true
      throw error
    }

    // Some browsers (iOS Safari) leave resume() pending after the permission prompt: don't block
    // on it, and resume again once the mic is open.
    await withTimeout(this.audioContext.resume().catch(() => {}), 3000, "audio").catch(() => {})
    await withTimeout(this.audioContext.audioWorklet.addModule(this.workletUrlValue), STEP_TIMEOUT_MS.audio, "audio")

    this.source = this.audioContext.createMediaStreamSource(this.stream)
    this.worklet = new AudioWorkletNode(this.audioContext, "pcm-capture", {
      numberOfOutputs: 1,
      processorOptions: { targetRate: INPUT_RATE, chunkMs: 100 }
    })
    this.worklet.port.onmessage = ({ data }) => {
      if (this.state === "live" || this.state === "finishing") {
        this.#showLevel(levelFromPcm16(data))
        this.session?.sendAudio(base64FromBytes(data))
      }
    }
    this.source.connect(this.worklet)
    this.worklet.connect(this.audioContext.destination) // outputs silence; keeps the node pulled everywhere
    this.player = new Player(this.audioContext, playing => this.#setActivity(playing ? "speaking" : "listening"))

    this.stream.getAudioTracks().forEach(track => {
      track.onended = () => this.#micLost()
    })
  }

  // Stops the audio and the connection. The session object (resumption handle) is kept, so
  // retry() can pick the conversation up again.
  #teardown() {
    clearTimeout(this.finishTimer)
    this.session?.close()
    this.player?.flush()
    this.player = null

    if (this.worklet) {
      this.worklet.port.onmessage = null
      try { this.worklet.port.postMessage("stop") } catch {}
      this.worklet.disconnect()
      this.worklet = null
    }
    this.source?.disconnect()
    this.source = null
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    this.stream = null
    if (this.audioContext && this.audioContext.state !== "closed") this.audioContext.close().catch(() => {})
    this.audioContext = null

    this.#releaseWakeLock()
    this.#stopClock()
    this.#showLevel(0)
    this.#setActivity("listening")
    this.#markPartial(null)
  }

  // A new conversation: empty transcript, clock at zero, no result.
  #reset() {
    this.session = null
    this.submitted = false
    this.transcript = new Transcript()
    this.lastLine = null
    this.lastLineElement = null
    this.transcriptTarget.replaceChildren()
    this.stickToBottom = true
    this.liveSeconds = 0
    this.resultTarget.hidden = true
    this.#hideNotice()
    this.#hideConfirm()
  }

  // Wake lock: the screen going to sleep cuts the microphone on phones.

  async #acquireWakeLock() {
    if (!navigator.wakeLock || this.wakeLock || document.visibilityState !== "visible") return
    try {
      this.wakeLock = await navigator.wakeLock.request("screen")
      this.wakeLock.addEventListener("release", () => { this.wakeLock = null })
    } catch {}
  }

  #reacquireWakeLock() {
    if (document.visibilityState === "visible" && (this.state === "live" || this.state === "finishing")) {
      this.#acquireWakeLock()
      this.audioContext?.resume().catch(() => {})
    }
  }

  #releaseWakeLock() {
    this.wakeLock?.release().catch(() => {})
    this.wakeLock = null
  }

  // States

  #enterStarting(step) {
    this.state = "starting"
    this.step = step
    this.#hideNotice()
    this.#render()
    this.#announce(step)
    if (this.hasCancelTarget && (document.activeElement === this.toggleTarget || document.activeElement === document.body)) {
      this.#focus(this.cancelTarget)
    }
  }

  #setStep(step) {
    if (this.state !== "starting") return
    this.step = step
    this.#render()
    this.#announce(step)
  }

  #enterLive() {
    this.state = "live"
    this.#startClock()
    this.#render()
    this.#announce(`${MESSAGES.live} ${MESSAGES.liveHint}`)
    this.#acquireWakeLock()
    if (!this.toggleTarget.contains(document.activeElement)) this.#focus(this.toggleTarget)
  }

  #fail({ message, help, details, retry = true }) {
    this.state = retry ? "error" : "unavailable"
    this.#showNotice({ message, help, details })
    this.#render()
  }

  #setActivity(activity) {
    if (this.activity === activity) return
    this.activity = activity
    this.element.dataset.voiceActivity = activity
    if (this.state === "live") this.#renderStatus()
  }

  // A status that wins over "Your turn" / "The assistant is speaking…" for a while (or until cleared).
  #setTransient(text, ms) {
    clearTimeout(this.transientTimer)
    this.transient = text
    if (text && ms) this.transientTimer = setTimeout(() => this.#setTransient(null), ms)
    this.#renderStatus()
  }

  // Clock (time spent live, across resumptions)

  #startClock() {
    this.liveSince = performance.now()
    clearInterval(this.clockTimer)
    this.clockTimer = setInterval(() => this.#renderClock(), 500)
    this.#renderClock()
  }

  #stopClock() {
    if (this.liveSince !== null) this.liveSeconds += (performance.now() - this.liveSince) / 1000
    this.liveSince = null
    clearInterval(this.clockTimer)
    this.#renderClock()
  }

  get #elapsed() {
    return this.liveSeconds + (this.liveSince === null ? 0 : (performance.now() - this.liveSince) / 1000)
  }

  // Page

  #appendTranscript(role, text) {
    const line = this.transcript.append(role, text)
    if (!line) return

    const container = this.transcriptTarget

    if (line !== this.lastLine) {
      this.lastLine = line
      const element = document.createElement("div")
      element.className = `voice__line voice__line--${role}`
      const label = document.createElement("span")
      label.className = "voice__role"
      label.textContent = SCREEN_LABELS[role]
      const bubble = document.createElement("p")
      bubble.className = "voice__bubble"
      this.lastLineText = document.createTextNode("")
      bubble.append(this.lastLineText)
      element.append(label, bubble)
      container.append(element)
      this.lastLineElement = element
      this.announcedLine = null
    }
    this.lastLineText.data = displayText(line.text)
    this.#markPartial(this.lastLineElement)
    this.#stickTranscript()
  }

  // A "Sky" line (an ask_hermes question) in the transcript: the question, and below it where the answer stands. Not
  // part of `this.transcript` (so not in the report); the assistant's next words start a new
  // bubble below it.
  #appendHermesLine(question) {
    this.transcript.endTurn()
    this.#markPartial(null)
    this.lastLine = null

    const element = document.createElement("div")
    element.className = "voice__line voice__line--hermes voice__line--pending"
    const label = document.createElement("span")
    label.className = "voice__role"
    label.textContent = MESSAGES.askLabel
    const bubble = document.createElement("p")
    bubble.className = "voice__bubble"
    bubble.textContent = displayText(question)
    const state = document.createElement("span")
    state.className = "voice__hermes-state txt-small"
    state.textContent = MESSAGES.askPending
    element.append(label, bubble, state)
    this.transcriptTarget.append(element)
    this.#stickTranscript()
    return element
  }

  #settleHermesLine(element, answered) {
    element.classList.remove("voice__line--pending")
    element.classList.toggle("voice__line--failed", !answered)
    const state = element.querySelector(".voice__hermes-state")
    if (state) state.textContent = answered ? MESSAGES.askAnswered : MESSAGES.askFailed
  }

  #stickTranscript() {
    if (this.stickToBottom) this.transcriptTarget.scrollTop = this.transcriptTarget.scrollHeight
  }

  // The line being streamed; null when nothing is.
  #markPartial(element) {
    if (this.partialElement && this.partialElement !== element) this.partialElement.classList.remove("voice__line--partial")
    this.partialElement = element
    element?.classList.add("voice__line--partial")
  }

  // The assistant's turn is over: its line is final, and read out once to screen readers.
  #completeTurn() {
    const line = this.lastLine
    if (line?.role !== "model") return
    this.#markPartial(null)
    if (this.announcedLine !== line) {
      this.announcedLine = line
      this.#announce(`${SCREEN_LABELS.model}: ${displayText(line.text.trim())}`)
    }
  }

  #showLevel(level) {
    this.level = level === 0 || level > this.level ? level : this.level * 0.6 + level * 0.4
    if (this.hasControlTarget) this.controlTarget.style.setProperty("--voice-level", this.level.toFixed(2))
  }

  #showResult({ message_url }) {
    if (this.hasResultTextTarget) {
      this.resultTextTarget.textContent = this.roomNameValue ? MESSAGES.publishedIn(this.roomNameValue) : `${MESSAGES.published}.`
    }
    if (this.hasMessageLinkTarget) {
      this.messageLinkTarget.href = message_url || this.roomUrlValue
    }
  }

  #showNotice({ message, help, details }) {
    if (details) console.warn("voice:", message, details)
    if (!this.hasNoticeTarget) return this.#renderStatus(message)

    const parts = []
    const sentence = document.createElement("p")
    sentence.textContent = message
    parts.push(sentence)

    if (help) {
      const how = document.createElement("p")
      how.className = "txt-small voice__help"
      how.textContent = help
      parts.push(how)
    }

    if (details) {
      const disclosure = document.createElement("details")
      const summary = document.createElement("summary")
      summary.textContent = MESSAGES.details
      const code = document.createElement("code")
      code.textContent = details
      disclosure.append(summary, code)
      parts.push(disclosure)
    }

    const body = this.hasNoticeBodyTarget ? this.noticeBodyTarget : this.noticeTarget
    body.replaceChildren(...parts)
    this.noticeTarget.hidden = false
  }

  #hideNotice() {
    if (!this.hasNoticeTarget) return
    this.noticeTarget.hidden = true
    if (this.hasNoticeBodyTarget) this.noticeBodyTarget.replaceChildren()
  }

  #hideConfirm() {
    if (this.hasConfirmTarget) this.confirmTarget.hidden = true
  }

  #announce(text) {
    if (!this.hasAnnouncerTarget || !text) return
    // Cleared first so the same sentence twice is still read.
    this.announcerTarget.textContent = ""
    requestAnimationFrame(() => { this.announcerTarget.textContent = text })
  }

  #focus(element) {
    try { element?.focus({ preventScroll: true }) } catch {}
  }

  #render() {
    const state = this.state
    const live = state === "live" || state === "finishing"
    this.element.dataset.voiceState = state
    this.element.dataset.voiceActivity = this.activity

    if (this.hasToggleTarget) {
      const button = this.toggleTarget
      button.classList.toggle("btn--negative", live)
      button.classList.toggle("btn--reversed", !live)
      button.disabled = state === "starting" || state === "unavailable" || state === "done"
      button.hidden = state === "done"
      button.title = TOGGLE_LABELS[state] || ""
      if (this.hasLabelTarget) this.labelTarget.textContent = TOGGLE_LABELS[state] || ""
    }
    if (this.hasControlTarget) {
      if (state === "starting") {
        this.controlTarget.setAttribute("aria-busy", "true")
      } else {
        this.controlTarget.removeAttribute("aria-busy")
      }
    }

    const resumable = state === "stopped" || state === "closed" || (state === "error" && !this.transcript.empty)
    if (this.hasCancelTarget) this.cancelTarget.hidden = state !== "starting"
    if (this.hasResumeTarget) this.resumeTarget.hidden = !resumable
    if (this.hasRestartTarget) this.restartTarget.hidden = !(resumable || state === "error") || this.transcript.empty
    if (this.hasResultTarget) this.resultTarget.hidden = state !== "done"
    if (this.hasHintTarget) this.hintTarget.textContent = live && state === "live" ? MESSAGES.liveHint : ""

    this.#renderStatus()
    this.#renderClock()
  }

  #renderStatus(override) {
    if (!this.hasStatusTarget) return
    const texts = {
      idle: MESSAGES.ready,
      starting: this.step,
      live: this.transient || (this.activity === "speaking" ? MESSAGES.speaking : MESSAGES.listening),
      finishing: MESSAGES.finishing,
      stopped: MESSAGES.paused,
      closed: MESSAGES.closedStatus,
      error: MESSAGES.retry,
      unavailable: MESSAGES.unavailable,
      done: MESSAGES.published
    }
    const text = override || texts[this.state] || ""
    if (this.statusTarget.textContent !== text) this.statusTarget.textContent = text
  }

  #renderClock() {
    if (!this.hasTimerTarget) return
    const elapsed = this.#elapsed
    this.timerTarget.hidden = elapsed < 0.5 && this.state !== "live"
    const text = formatClock(elapsed)
    if (this.timerTarget.textContent !== text) this.timerTarget.textContent = text
  }

  // The sentence stays plain; codes and hostnames go in "Technical details".
  #describe(error) {
    if (error?.micError) {
      const details = [ error.name, error.message ].filter(Boolean).join(" : ")
      switch (error.name) {
        case "NotAllowedError":
        case "PermissionDeniedError":
        case "SecurityError":        return { message: MESSAGES.micDenied, help: MESSAGES.micDeniedHelp, details }
        case "NotFoundError":
        case "DevicesNotFoundError":
        case "OverconstrainedError": return { message: MESSAGES.micMissing, details }
        default:                     return { message: MESSAGES.micError, details }
      }
    }
    if (error instanceof StepTimeout) {
      return { message: error.step === "mic" ? MESSAGES.micError : MESSAGES.timeout, details: `Timed out at step “${STEP_LABELS[error.step] || error.step}”` }
    }
    if (error instanceof TokenError) {
      const details = error.status ? `POST ${this.tokenUrlValue} → HTTP ${error.status}` : `POST ${this.tokenUrlValue}: network unreachable`
      return { message: error.status === 429 ? MESSAGES.rateLimited : MESSAGES.tokenError, details }
    }
    if (error instanceof ConnectError) {
      return { message: MESSAGES.connectError, details: `generativelanguage.googleapis.com: WebSocket closed (code ${error.code}${error.reason ? `, ${error.reason}` : ""})` }
    }
    return { message: MESSAGES.connectError, details: String(error?.message || error) }
  }

  get #supported() {
    return window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode
  }
}
