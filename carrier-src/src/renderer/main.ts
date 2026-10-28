/**
 * dsh-pet renderer: a minimal authenticated dsh client. Boots the Cordis
 * client stack directly — Typert registry, Connection, and the API gateway
 * client — with no web-frontend module system, then drives a pet state
 * machine from the forwarded `api-session/*` events and answers
 * `approval/request` and `user-questions/request` waterfalls through the
 * official `$events/result` RPC, exactly like the Web GUI's cards.
 */

import './pet.css'

const CHARACTER = 'shenshen'

type BaseState = 'idle' | 'thinking' | 'working'

interface PetGlobals {
  petDesktop: {
    setBubbleVisible(visible: boolean): void
    dragStart(screenX: number, screenY: number): void
    dragMove(screenX: number, screenY: number): void
    dragEnd(): void
    onState(listener: (state: unknown) => void): void
    onAction(listener: (action: unknown) => void): void
    onCatalog(listener: (catalog: unknown) => void): void
    onInteraction(listener: (request: unknown) => void): void
    onInteractionCancel(listener: (notice: { id: string }) => void): void
    answerInteraction(id: string, answer: unknown): void
    onSay(listener: (notice: { text: string }) => void): void
    reportStatus(snapshot: Record<string, unknown>): void
    reportTouch(touch: { part: string }): void
    reportActionDone(done: { action: string; durationMs?: number; requestId?: string }): void
  }
}

const globals = globalThis as unknown as Partial<PetGlobals>

// ── animation mapping (shenshen media, via the pet-asset:// protocol) ───────

interface AnimationName {
  dir: string
  file: string
}

const ANIMATION: Record<string, AnimationName[]> = {
  idle: [{ dir: 'idle', file: '待机呼吸休闲' }],
  thinking: [{ dir: 'random', file: '深度思考碎碎念' }],
  working: [
    { dir: 'random', file: '工作状态-忙碌点按' },
    { dir: 'random', file: '写代码' },
    { dir: 'random', file: '原地敲击桌面互动' },
  ],
  waiting: [{ dir: 'turn', file: '东张西望' }],
  error: [{ dir: 'random', file: '被吓一跳' }],
  celebrate: [{ dir: 'click', file: '点击回应-开心跃动' }],
  // One is picked at random per touch: the reaction is local and instant —
  // it never waits on the runtime round trip.
  touch: [
    { dir: 'click', file: '点击回应-开心跃动' },
    { dir: 'click', file: '点击回应-元气挥手' },
    { dir: 'click', file: '点击回应-害羞惊讶' },
    { dir: 'click', file: '点击回应-傲娇生气' },
    { dir: 'click', file: '点击回应-挠痒咯咯笑' },
  ],
}

// The random-pool clips that double as STATE animations — excluded from the
// idle theater so a working/thinking clip never pops up while resting.
const THEATER_EXCLUDED = new Set(['深度思考碎碎念', '工作状态-忙碌点按', '写代码', '原地敲击桌面互动', '被吓一跳'])

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) throw new Error(`pet renderer: missing element ${selector}`)
  return element
}

const video = requireElement<HTMLVideoElement>('#video')
video.addEventListener('error', () => {
  console.error(`[pet-video] source failed: ${video.src} ${String(video.error?.message ?? '')}`)
})
const stage = requireElement<HTMLCanvasElement>('#stage')
const bubble = requireElement<HTMLDivElement>('#bubble')

function animationSource(key: string): string {
  const names = ANIMATION[key]
  if (names === undefined) throw new Error(`pet renderer: unknown animation ${key}`)
  // A random draw per (re)render: state re-entries and post-one-shot returns
  // rotate through the pool instead of always showing its first member.
  const name = names[Math.floor(Math.random() * names.length)] ?? names[0]
  return `pet-asset:///${CHARACTER}/videos/${name.dir}/${encodeURIComponent(name.file)}.webm`
}

/**
 * Render the video into the stage canvas. The webm assets carry a real alpha
 * channel (the retired standalone pet's offline unblend-white-v6 output), so
 * the pass is a plain blit: an earlier luminance "white matte" key — written
 * under the belief the sources were white-background — only ever damaged the
 * character's own pure whites (headscarf, apron, face highlights landed
 * inside the key band and turned semi-transparent). Chroma-keying is only the
 * fallback for an opaque source.
 */
function setupStage(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false })
  if (gl === null) {
    // No WebGL: fall back to the raw video (white matte visible, still usable).
    canvas.replaceWith(video)
    video.style.display = 'block'
    return
  }
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)
    if (shader === null) throw new Error('pet renderer: shader allocation failed')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`pet renderer: shader compile failed: ${String(gl.getShaderInfoLog(shader))}`)
    }
    return shader
  }
  const program = gl.createProgram()
  if (program === null) throw new Error('pet renderer: program allocation failed')
  gl.attachShader(program, compile(gl.VERTEX_SHADER,
    'attribute vec2 p; varying vec2 v;'
    + 'void main(){ v = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }'))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER,
    'precision highp float; varying vec2 v; uniform sampler2D t;'
    + 'void main(){ gl_FragColor = texture2D(t, v); }'))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`pet renderer: program link failed: ${String(gl.getProgramInfoLog(program))}`)
  }
  gl.useProgram(program)
  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'p')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0, 0, 0, 0)

  const draw = (): void => {
    if (video.readyState < 2 || video.videoWidth === 0) return
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
    }
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
  type FrameScheduler = HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: () => void) => number
  }
  const scheduled = video as FrameScheduler
  const schedule = (): void => {
    if (typeof scheduled.requestVideoFrameCallback === 'function') {
      // Draw per decoded frame; no work between frames.
      scheduled.requestVideoFrameCallback(() => { draw(); schedule() })
    } else {
      requestAnimationFrame(() => { draw(); schedule() })
    }
  }
  schedule()
}

// ── state machine ───────────────────────────────────────────────────────────

let baseState: BaseState = 'idle'
let override: 'waiting_approval' | 'waiting_question' | null = null
let errorUntil = 0

function play(key: string): void {
  const source = animationSource(key)
  if (video.src !== source) {
    video.src = source
    // State animations loop (a state persists until an event changes it);
    // the celebration is a one-shot that hands back via its ended event.
    video.loop = key !== 'celebrate'
    void video.play().catch(() => { /* autoplay muted: always allowed */ })
  }
}

function render(): void {
  if (Date.now() < errorUntil) {
    play('error')
  } else if (override !== null) {
    play('waiting')
  } else if (baseState === 'working') {
    play('working')
  } else {
    play(baseState)
  }
  scheduleTheater()
  reportStatus()
}


function setBase(state: BaseState): void {
  if (baseState === state) return
  const finishedWork = baseState === 'working' && state === 'idle'
  baseState = state
  if (state !== 'idle' && theaterTimer !== undefined) {
    // Leaving idle cancels the pending theater clip; re-entering idle
    // re-arms through render().
    clearTimeout(theaterTimer)
    theaterTimer = undefined
  }
  if (finishedWork) {
    // One celebration hop when a turn lands back at idle.
    playOneShot('celebrate')
    return
  }
  render()
}

/**
 * Play a one-shot animation and hand control back when it ends. Recovery must
 * not depend on `ended` alone: a source that fails to load never ends and
 * would freeze the state machine on the stale frame — `error` hands back too.
 * Loop must be off or `ended` never fires (it stays on from looping state
 * animations).
 */
function playOneShot(key: string, requestId?: string): void {
  playOneShotAt(ANIMATION[key]?.[0] ?? { dir: 'click', file: key }, requestId)
}

function playOneShotAt(name: AnimationName, requestId?: string): void {
  const source = `pet-asset:///${CHARACTER}/videos/${name.dir}/${encodeURIComponent(name.file)}.webm`
  if (video.src === source) return
  oneShotActive = true
  const handBack = (): void => {
    video.onended = null
    video.onerror = null
    oneShotActive = false
    // Report completion with the clip's own duration — the one observable
    // trace that a one-shot actually FINISHED (override/animation are not).
    globals.petDesktop?.reportActionDone({
      action: name.file,
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
      ...(requestId === undefined ? {} : { requestId }),
    })
    render()
  }
  video.onended = handBack
  video.onerror = handBack
  video.loop = false
  video.src = source
  void video.play().catch(() => { /* autoplay muted: always allowed */ })
}

function flashError(): void {
  errorUntil = Date.now() + 6_000
  render()
  setTimeout(render, 6_100)
}

// ── action catalog + idle theater ───────────────────────────────────────────

/** The pet's playable clips, scanned by the main process at boot and pushed
 * over IPC: what /action names resolve against and where the idle theater
 * draws from. Populated by the `pet:catalog` push (main sends it once the
 * page has loaded). */
const actionCatalog = new Map<string, AnimationName>()

globals.petDesktop?.onCatalog?.((catalog) => {
  const entries = (catalog as { actions?: unknown }).actions
  if (!Array.isArray(entries)) return
  actionCatalog.clear()
  for (const entry of entries) {
    const record = entry as { id?: unknown; dir?: unknown; file?: unknown }
    if (typeof record.id !== 'string' || typeof record.dir !== 'string' || typeof record.file !== 'string') continue
    actionCatalog.set(record.id, { dir: record.dir, file: record.file })
  }
  scheduleTheater()
})

/**
 * The idle theater (the animation half of the settings page's 自主表达):
 * while idle — no override bubble, no error flash, no one-shot in flight —
 * the pet occasionally plays a clip drawn from its own catalog's random
 * pool. Config arrives on /state pushes (`autonomy`, read by the driver
 * from pet-settings.json); a pet that never receives a push keeps the
 * theater off, so behavior is unchanged until the driver speaks.
 */
interface TheaterConfig {
  enabled: boolean
  gapMinutes: number
}

let theater: TheaterConfig = { enabled: false, gapMinutes: 10 }
let theaterTimer: ReturnType<typeof setTimeout> | undefined
let theaterLastFile: string | undefined
// A one-shot in flight (touch reaction, /action, a theater clip itself): the
// pending timer must not hijack the stage mid-clip.
let oneShotActive = false

function theaterPool(): AnimationName[] {
  return [...actionCatalog.values()].filter(entry =>
    entry.dir === 'random'
    && !THEATER_EXCLUDED.has(entry.file)
    && entry.file !== theaterLastFile)
}

function scheduleTheater(): void {
  if (theaterTimer !== undefined) return
  if (!theater.enabled || baseState !== 'idle' || override !== null || Date.now() < errorUntil) return
  if (theaterPool().length === 0) return
  theaterTimer = setTimeout(() => {
    theaterTimer = undefined
    if (!theater.enabled || baseState !== 'idle' || override !== null || oneShotActive || Date.now() < errorUntil) {
      scheduleTheater() // conditions changed while pending: re-arm from now
      return
    }
    const pool = theaterPool()
    const pick = pool[Math.floor(Math.random() * pool.length)]
    if (pick !== undefined) {
      theaterLastFile = pick.file
      playOneShotAt(pick)
    }
  }, Math.max(1, theater.gapMinutes) * 60_000)
}

// ── bubbles ─────────────────────────────────────────────────────────────────

type PendingAnswer = (outcome: 'allowed-once' | 'rejected') => void

const questionSelections = new Map<string, string[]>()

function hideBubble(): void {
  bubble.hidden = true
  bubble.replaceChildren()
  globals.petDesktop?.setBubbleVisible(false)
}

/** Localized payload text arrives as a locale→string map; pick the page's best match. */
type LocalizedText = string | { readonly en?: string; readonly [locale: string]: string | undefined } | undefined

function localizedText(value: LocalizedText): string | undefined {
  if (value === undefined || typeof value === 'string') return value
  const languages = navigator.languages ?? [navigator.language]
  for (const language of languages) {
    const hit = value[language.split('-')[0] ?? '']
    if (typeof hit === 'string') return hit
  }
  return typeof value.en === 'string' ? value.en : undefined
}

function showApprovalBubble(request: {
  toolName?: string
  reason?: string
  displayReason?: LocalizedText
}, answer: PendingAnswer): void {
  bubble.replaceChildren()
  const title = document.createElement('p')
  title.className = 'bubble-title'
  title.textContent = request.toolName === undefined || request.toolName === ''
    ? '请求执行'
    : `请求执行：${request.toolName}`
  const detail = document.createElement('p')
  detail.className = 'bubble-detail'
  detail.textContent = localizedText(request.displayReason) ?? request.reason ?? ''
  const actions = document.createElement('div')
  actions.className = 'bubble-actions'
  const allow = document.createElement('button')
  allow.className = 'bubble-button primary'
  allow.textContent = '允许'
  allow.addEventListener('click', () => {
    hideBubble()
    answer('allowed-once')
  })
  const reject = document.createElement('button')
  reject.className = 'bubble-button danger'
  reject.textContent = '拒绝'
  reject.addEventListener('click', () => {
    hideBubble()
    answer('rejected')
  })
  actions.append(allow, reject)
  bubble.append(title, detail, actions)
  bubble.hidden = false
  globals.petDesktop?.setBubbleVisible(true)
  render()
}

interface PetQuestion {
  id: string
  question: LocalizedText
  detail?: LocalizedText
  header?: LocalizedText
  options?: { label: LocalizedText; description?: LocalizedText }[]
  multiSelect?: boolean
}

function showQuestionBubble(questions: PetQuestion[], answer: (value: { answers: { id: string; selected: string[] }[] }) => void): void {
  questionSelections.clear()
  bubble.replaceChildren()
  for (const question of questions) {
    questionSelections.set(question.id, [])
    const heading = document.createElement('p')
    heading.className = 'bubble-question'
    const questionText = localizedText(question.question) ?? ''
    const headerText = localizedText(question.header)
    heading.textContent = headerText === undefined || headerText === ''
      ? questionText
      : `${headerText} · ${questionText}`
    bubble.append(heading)
    const detailText = localizedText(question.detail)
    if (detailText !== undefined && detailText !== '') {
      const detail = document.createElement('p')
      detail.className = 'bubble-detail'
      detail.textContent = detailText
      bubble.append(detail)
    }
    const options = document.createElement('div')
    options.className = 'bubble-options'
    for (const option of question.options ?? []) {
      const label = localizedText(option.label) ?? ''
      const button = document.createElement('button')
      button.className = 'bubble-button'
      button.textContent = label
      const description = localizedText(option.description)
      if (description !== undefined) button.title = description
      button.addEventListener('click', () => {
        questionSelections.set(question.id, [label])
        for (const sibling of options.children) {
          (sibling as HTMLButtonElement).classList.remove('primary')
        }
        button.classList.add('primary')
        if (questions.every(entry => (questionSelections.get(entry.id) ?? []).length > 0)) {
          answer({
            answers: questions.map(entry => ({
              id: entry.id,
              selected: questionSelections.get(entry.id) ?? [],
            })),
          })
        }
      })
      options.append(button)
    }
    bubble.append(options)
  }
  bubble.hidden = false
  globals.petDesktop?.setBubbleVisible(true)
  render()
}

// ── interaction lifecycle ───────────────────────────────────────────────────

interface InteractionMessage {
  kind?: unknown
  toolName?: string
  reason?: string
  displayReason?: LocalizedText
  questions?: PetQuestion[]
}

/** Bumped whenever the displayed bubble changes identity; a settle callback
 * from a superseded display must not touch the newer bubble. */
let interactionEpoch = 0
// The interaction whose bubble is currently on screen. New arrivals and
// cancel notices are routed against it.
let currentInteractionId: string | undefined
// Interactions that arrived while a bubble was up. FIFO: the next one shows
// the moment the current bubble settles or is withdrawn. Earlier behavior
// was last-arrival-wins: the overwritten approval silently lost its only
// pet-side answer surface, and the user had no way to know it existed.
const interactionQueue: Array<{ id: string; message: InteractionMessage }> = []

// ── boot ────────────────────────────────────────────────────────────────────

function boot(): void {
  setupStage(video, stage)
  render()
}

// ── window drag ─────────────────────────────────────────────────────────────

// Manual drag (app-region is inert under transparent+ignore toggling, §5 #9):
// the page captures the pointer over the pet body and reports fractional DIP
// screen coordinates in one space for the whole gesture; the main process
// follows with size-pinned setBounds so the DWM ratchet cannot accumulate
// (§5 #11-12).
const petBody = requireElement<HTMLDivElement>('#pet')

/**
 * Which body region a pet-body click landed on, in the 640x360 video frame
 * the stage shows (object-fit contain inside the 340x200 box): head and body
 * boxes come from the character manifest.
 */
function touchPartOf(clientX: number, clientY: number): string {
  const rect = petBody.getBoundingClientRect()
  const scale = Math.min(rect.width / 640, rect.height / 360)
  const drawWidth = 640 * scale
  const drawHeight = 360 * scale
  const videoX = (clientX - rect.left - (rect.width - drawWidth) / 2) / scale
  const videoY = (clientY - rect.top - (rect.height - drawHeight) / 2) / scale
  const inBox = (box: readonly number[]): boolean =>
    videoX >= box[0] && videoX <= box[2] && videoY >= box[1] && videoY <= box[3]
  if (inBox([185, 60, 436, 195])) return 'head'
  if (inBox([212, 60, 428, 330])) return 'body'
  return 'unknown'
}

/** A completed gesture that never moved far nor lasted long is a touch. */
const CLICK_MAX_DISTANCE = 5
const CLICK_MAX_MS = 500

function handleTouch(clientX: number, clientY: number): void {
  const part = touchPartOf(clientX, clientY)
  const reactions = ANIMATION.touch
  if (reactions !== undefined && reactions.length > 0 && override === null && Date.now() >= errorUntil) {
    playOneShotAt(reactions[Math.floor(Math.random() * reactions.length)])
  }
  globals.petDesktop?.reportTouch({ part })
}

petBody.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  try { petBody.setPointerCapture(event.pointerId) } catch { /* pointer already gone */ }
  const startX = event.screenX
  const startY = event.screenY
  const startAt = Date.now()
  globals.petDesktop?.dragStart(startX, startY)
  const onMove = (move: PointerEvent): void => {
    globals.petDesktop?.dragMove(move.screenX, move.screenY)
  }
  const onUp = (up: PointerEvent): void => {
    petBody.removeEventListener('pointermove', onMove)
    petBody.removeEventListener('pointerup', onUp)
    petBody.removeEventListener('pointercancel', onUp)
    globals.petDesktop?.dragEnd()
    const moved = Math.hypot(up.screenX - startX, up.screenY - startY)
    if (moved <= CLICK_MAX_DISTANCE && Date.now() - startAt <= CLICK_MAX_MS) {
      handleTouch(up.clientX, up.clientY)
    }
  }
  petBody.addEventListener('pointermove', onMove)
  petBody.addEventListener('pointerup', onUp)
  petBody.addEventListener('pointercancel', onUp)
})

// ── control interface (driver path) ─────────────────────────────────────────
// The four operations, delivered over IPC from the main-process HTTP host.
// During the transition this and the in-page WS event path drive the same
// state machine side by side; the WS path retires when the driver-side lands
// (DSH-PET.md §7.2).

globals.petDesktop?.onSay((notice) => {
  // Fire-and-forget speech: self-dismisses, never blocks, and an interaction
  // bubble in flight outranks it (single-bubble design).
  if (override !== null || notice.text === '') return
  bubble.replaceChildren()
  const text = document.createElement('p')
  text.className = 'bubble-detail'
  text.textContent = notice.text
  bubble.append(text)
  bubble.hidden = false
  globals.petDesktop?.setBubbleVisible(true)
  setTimeout(() => {
    if (override !== null || bubble.textContent !== notice.text) return
    hideBubble()
  }, 4000 + Math.min(notice.text.length * 60, 4000))
})

let reportedSnapshot = ''
const reportStatus = (): void => {
  const snapshot = JSON.stringify({ state: baseState, override, animation: decodeURIComponent(video.src.split('/').pop() ?? '') })
  if (snapshot === reportedSnapshot) return
  reportedSnapshot = snapshot
  globals.petDesktop?.reportStatus(JSON.parse(snapshot) as Record<string, unknown>)
}

globals.petDesktop?.onState((message) => {
  const payload = message as { state?: unknown; autonomy?: unknown }
  // The autonomy half rides on every push: the driver reads the settings
  // page's idle-theater switches fresh each time. A change re-arms the
  // timer (or disarms it when switched off).
  const autonomy = payload.autonomy
  if (typeof autonomy === 'object' && autonomy !== null) {
    const record = autonomy as { idleAnimation?: unknown; gapMinutes?: unknown }
    const enabled = typeof record.idleAnimation === 'boolean' ? record.idleAnimation : theater.enabled
    const gapMinutes = typeof record.gapMinutes === 'number' && Number.isFinite(record.gapMinutes)
      ? Math.min(120, Math.max(1, Math.round(record.gapMinutes)))
      : theater.gapMinutes
    if (enabled !== theater.enabled || gapMinutes !== theater.gapMinutes) {
      theater = { enabled, gapMinutes }
      if (theaterTimer !== undefined) {
        clearTimeout(theaterTimer)
        theaterTimer = undefined
      }
      scheduleTheater()
    }
  }
  const state = payload.state
  if (state === 'idle' || state === 'thinking' || state === 'working') setBase(state)
  else if (state === 'error') flashError()
})
globals.petDesktop?.onAction((message) => {
  const payload = message as { action?: unknown; requestId?: unknown }
  const action = payload.action
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined
  if (action === 'celebrate') playOneShot('celebrate', requestId)
  else if (action === 'error') flashError()
  else if (typeof action === 'string') {
    // Named clip playback: the main process validated the name against its
    // catalog before forwarding, so an unresolvable id here can only come
    // from a stale catalog — ignoring it keeps the state machine intact.
    const hit = actionCatalog.get(action)
    if (hit !== undefined) playOneShotAt(hit, requestId)
  }
})
/** Keep the queue badge (`.bubble-queue`, appended inside the bubble) in
 * step with the queue: create/update/remove in one place. */
function refreshQueueBadge(): void {
  const badge = bubble.querySelector('.bubble-queue')
  if (interactionQueue.length === 0) {
    badge?.remove()
    return
  }
  const text = `还有 ${String(interactionQueue.length)} 个待处理`
  if (badge !== null) {
    badge.textContent = text
    return
  }
  const fresh = document.createElement('p')
  fresh.className = 'bubble-queue'
  fresh.textContent = text
  bubble.append(fresh)
}

/** Present one interaction as THE bubble. Only called when nothing is
 * displayed — later arrivals queue until this one settles or is withdrawn. */
function displayInteraction(id: string, message: InteractionMessage): void {
  const epoch = ++interactionEpoch
  currentInteractionId = id
  const settle = (answer: unknown): void => {
    if (epoch !== interactionEpoch) return
    hideBubble()
    override = null
    currentInteractionId = undefined
    render()
    globals.petDesktop?.answerInteraction(id, answer)
    const next = interactionQueue.shift()
    if (next !== undefined) displayInteraction(next.id, next.message)
  }
  if (message.kind === 'question') {
    override = 'waiting_question'
    render()
    showQuestionBubble(message.questions ?? [], settle)
  } else {
    override = 'waiting_approval'
    render()
    showApprovalBubble({
      toolName: message.toolName,
      reason: message.reason,
      ...(message.displayReason === undefined ? {} : { displayReason: message.displayReason }),
    }, settle)
  }
  refreshQueueBadge()
}

globals.petDesktop?.onInteraction((request) => {
  const message = request as InteractionMessage & { id?: unknown }
  const id = message.id
  if (typeof id !== 'string') return
  // One bubble at a time: while one is up, later interactions queue and
  // display the moment the current one settles or is withdrawn.
  if (currentInteractionId !== undefined) {
    interactionQueue.push({ id, message })
    refreshQueueBadge()
    return
  }
  displayInteraction(id, message)
})
globals.petDesktop?.onInteractionCancel((notice) => {
  // A queued interaction quietly leaves the queue; the displayed bubble is
  // untouched and only its badge count changes.
  const queuedIndex = interactionQueue.findIndex(entry => entry.id === notice.id)
  if (queuedIndex !== -1) {
    interactionQueue.splice(queuedIndex, 1)
    refreshQueueBadge()
    return
  }
  // The DISPLAYED interaction was withdrawn: clear the stage and show the
  // next queued one, if any. A stale cancel for an already-settled id finds
  // neither the queue nor the displayed bubble and is ignored.
  if (notice.id !== currentInteractionId) return
  interactionEpoch += 1
  currentInteractionId = undefined
  hideBubble()
  override = null
  render()
  const next = interactionQueue.shift()
  if (next !== undefined) displayInteraction(next.id, next.message)
})

void boot()
