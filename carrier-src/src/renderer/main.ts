/**
 * dsh-pet renderer: a minimal authenticated dsh client. Boots the Cordis
 * client stack directly — Typert registry, Connection, and the API gateway
 * client — with no web-frontend module system, then drives a pet state
 * machine from the forwarded `api-session/*` events and answers
 * `approval/request` and `user-questions/request` waterfalls through the
 * official `$events/result` RPC, exactly like the Web GUI's cards.
 */

import './pet.css'

const CHARACTER = 'whale'

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
    /** B01 朝向：main 的 click-through 轮询顺带算好的光标偏移（光标 x −
     * 窗口中心 x，px；右为正）。迟滞/去抖在渲染层。 */
    onCursor(listener: (cursor: { offsetX: number }) => void): void
    onInteraction(listener: (request: unknown) => void): void
    onInteractionCancel(listener: (notice: { id: string }) => void): void
    answerInteraction(id: string, answer: unknown): void
    onSay(listener: (notice: { text: string; audio?: Uint8Array<ArrayBuffer>; mood?: unknown; letter?: unknown; petId?: unknown; letterAt?: unknown }) => void): void
    reportStatus(snapshot: Record<string, unknown>): void
    reportTouch(touch: { part: string; rects?: string }): void
    reportActionDone(done: { action: string; durationMs?: number; requestId?: string }): void
    sendChat(text: string): Promise<{ ok: boolean; reason?: string }>
  }
}

const globals = globalThis as unknown as Partial<PetGlobals>

// ── animation mapping (whale media, via the pet-asset:// protocol) ──────────

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

// 当前身指针（switchClip 乒乓重赋值）；videoA 钉住 A 元素引用。
let video = requireElement<HTMLVideoElement>('#video')
video.addEventListener('error', () => {
  console.error(`[pet-video] source failed: ${video.src} ${String(video.error?.message ?? '')}`)
})
// B04 v2 双缓冲：A/B 两个【固定】元素乒乓，`video` 是"当前身"指针。v1 的
// 冻结根因 = 用全局指针算 incoming（返回切换时指针已指向 outgoing，三元式
// 塌缩成 incoming===outgoing → 自交叉自暂停）。v2 以固定元素引用乒乓，与
// 指针解耦——首次切换与返回切换走同一条路。
const videoA: HTMLVideoElement = video
const videoB = document.createElement('video')
videoB.muted = true
videoB.playsInline = true
videoB.crossOrigin = 'anonymous'
videoB.addEventListener('error', () => {
  console.error(`[pet-video] source failed: ${videoB.src} ${String(videoB.error?.message ?? '')}`)
})
// 交叉期旧层引用（under-lay：旧层恒 alpha 1，桌面永不透出——v1 实测"双身
// 透底"的根因是双层各半透明）。淡入完成后旧层暂停并清引用。
let prevVideo: HTMLVideoElement | undefined
let fadeStart = 0
let fadeMs = 0
// WebGL 不可用 = 无交叉能力（switchClip 走可见节点直换降级）。
let glFailed = false
const stage = requireElement<HTMLCanvasElement>('#stage')
const bubble = requireElement<HTMLDivElement>('#bubble')

// ── 留信的两态渲染：密封信封（未拆）→ 拆信过渡 → 信纸（全文+收好）────────
// 拆信动作本身=已读回执；她的声音也在拆开时才读（密封态剧透会毁仪式）。
// 纯 CSS 信封（无素材依赖）：信封主体+盖口三角+封蜡圆点+轻微浮动。
const LETTER_CSS = [
  '@keyframes letter-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
  '.letter-env{width:210px;box-sizing:border-box;padding:10px 16px 12px;background:linear-gradient(#f4e7c8,#eeddb4);border:1px solid rgba(58,47,30,.35);border-radius:10px;cursor:pointer;text-align:center;color:#3a2f1e;font:inherit;transition:transform .2s ease;animation:letter-float 2.6s ease-in-out infinite}',
  '.letter-env:hover{transform:scale(1.03)}',
  '.letter-flap{width:0;height:0;border-left:76px solid transparent;border-right:76px solid transparent;border-top:46px solid #e2cba0;margin:0 auto 4px;transition:transform .3s ease;transform-origin:top center}',
  '.letter-opening .letter-flap{transform:rotateX(180deg)}',
  '.letter-opening{animation:none;cursor:default}',
  '.letter-seal{width:18px;height:18px;background:#b04a3a;border-radius:50%;margin:-30px auto 14px;box-shadow:0 1px 3px rgba(0,0,0,.3);position:relative}',
  '.letter-hint{font-size:12px;color:rgba(58,47,30,.85);margin:0}',
  '.letter-paper{width:300px;box-sizing:border-box;padding:14px 16px;background:linear-gradient(#f6ead0,#eeddb4);border:1px solid rgba(58,47,30,.4);border-radius:10px;box-shadow:0 6px 22px rgba(20,30,50,.28);color:#3a2f1e;font-family:KaiTi,STKaiti,Georgia,serif;line-height:1.8;font-size:14px}',
  '.letter-paper .bubble-detail{margin:0 0 8px;white-space:pre-wrap}',
  '.letter-close{border:1px solid rgba(58,47,30,.4);border-radius:6px;background:rgba(58,47,30,.08);color:#3a2f1e;font:inherit;font-size:12px;padding:2px 10px;cursor:pointer}',
].join('\n')
let letterStylesInjected = false
function ensureLetterStyles(): void {
  if (letterStylesInjected) return
  letterStylesInjected = true
  const style = document.createElement('style')
  style.textContent = LETTER_CSS
  document.head.appendChild(style)
}

// ── B01 朝向（镜像语义见 body 契约 §3.1 + 需求 REQ-B01）────────────────────
// 基准朝向 = 素材原始朝向 right；facing=left → 舞台画布 scaleX(-1)（气泡是
// 独立元素，不随镜像）。迟滞 ±20px、时间去抖 40ms；one-shot 播放期间锁定。

type Facing = 'left' | 'right'

let facing: Facing = 'right'
let lastFacingDecisionAt = 0
let lastCursorOffsetX: number | undefined
let facingLocked = false

/** 空间迟滞判定（与 pet-app idle-selector.facingForOffset 同语义——渲染层
 * 无法跨包导入，此处镜像实现，行为由验收清单钉住）。 */
function facingForOffset(offsetPx: number, current: Facing, hysteresisPx = 40): Facing {
  if (Math.abs(offsetPx) <= hysteresisPx) return current
  return offsetPx > 0 ? 'right' : 'left'
}

function applyFacing(): void {
  stage.style.transform = facing === 'left' ? 'scaleX(-1)' : ''
  reportStatus()
}

function decideFacing(rawOffsetX: number): void {
  // 【用户感知校准 2026-11-07】素材原始帧的视觉朝向读作"朝左"——光标在右
  // （offsetX > 0）时镜像后才算"扭向光标"，故取负号进判定。
  const offsetX = -rawOffsetX
  lastCursorOffsetX = offsetX
  if (facingLocked) return
  const now = Date.now()
  if (now - lastFacingDecisionAt < 40) return
  lastFacingDecisionAt = now
  const next = facingForOffset(offsetX, facing)
  if (next !== facing) {
    facing = next
    applyFacing()
  }
}

globals.petDesktop?.onCursor?.((cursor) => { decideFacing(cursor.offsetX) })

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
function setupStage(canvas: HTMLCanvasElement): void {
  // 无 video 参数：B04 双缓冲下当前身是模块级 `video` 指针（乒乓重赋值），
  // 参数会把它遮蔽成 boot 时的 A 元素——draw 永远上传退役元素，画布冻结
  // 在旧身最后一帧（v2 首测实锤）。draw 闭包读指针才是"当前身"。
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
    'precision highp float; varying vec2 v; uniform sampler2D t; uniform float uAlpha;'
    + 'void main(){ vec4 c = texture2D(t, v); gl_FragColor = vec4(c.rgb, c.a * uAlpha); }'))
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
  const uAlpha = gl.getUniformLocation(program, 'uAlpha')
  // B04：每层一个纹理（WeakMap 随元素回收）。
  const textures = new WeakMap<object, WebGLTexture>()
  const textureFor = (el: HTMLVideoElement): WebGLTexture => {
    const existing = textures.get(el)
    if (existing !== undefined) return existing
    const texture = gl.createTexture()
    if (texture === null) throw new Error('pet renderer: texture allocation failed')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    textures.set(el, texture)
    return texture
  }
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0, 0, 0, 0)

  const draw = (): void => {
    // B04 交叉期两层混绘：旧层恒 alpha 1 在下（桌面不透出，双身读作动作
    // 起手的过渡影），新层按进度盖上；淡完暂停旧层并清引用。非交叉期单层。
    const now = performance.now()
    const prev = prevVideo
    const fading = prev !== undefined && fadeMs > 0 && now - fadeStart < fadeMs
    const layers: Array<{ el: HTMLVideoElement; alpha: number }> = fading && prev !== undefined
      ? [
        { el: prev, alpha: 1 },
        { el: video, alpha: Math.min(1, (now - fadeStart) / fadeMs) },
      ]
      : [{ el: video, alpha: 1 }]
    if (!fading && prev !== undefined) {
      // 淡入完成：旧层退场（pause 即可，元素留在乒乓池里复用）。
      prev.pause()
      prevVideo = undefined
    }
    if (video.videoWidth === 0) return
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
    }
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clear(gl.COLOR_BUFFER_BIT)
    for (const { el, alpha } of layers) {
      // 未就绪的层跳帧（incoming 首帧解码前不画，旧层还满屏顶着——无空窗）。
      if (el.readyState < 2 || el.videoWidth === 0) continue
      gl.bindTexture(gl.TEXTURE_2D, textureFor(el))
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el)
      gl.uniform1f(uAlpha, alpha)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
  }
  // 双缓冲后 rVFC 只能挂一个元素——统一 rAF 驱动（两层都要喂；rAF 空转的
  // 成本低于逐层 rVFC 管理的复杂度）。
  const schedule = (): void => {
    requestAnimationFrame(() => { draw(); schedule() })
  }
  schedule()
}

// ── state machine ───────────────────────────────────────────────────────────

let baseState: BaseState = 'idle'
let override: 'waiting_approval' | 'waiting_question' | null = null
let errorUntil = 0

/** 片段切换的交叉时长（body.json capabilities.transition，0-500 钳制）。
 * toIdle（动作收尾回到待机）用更从容的 toIdleMs，起手用 defaultMs。 */
function transitionMsFor(toIdle: boolean): number {
  const t = _bodyTransitions
  if (t === undefined) return 0
  return Math.max(0, toIdle ? t.toIdleMs : t.defaultMs)
}

/** 拖拽/异常路径的交叉终局：旧层立即退场，屏上永远只有一个身形。
 * （v1 实测：拖拽撞上交叉窗口会看到两个身位。） */
function finalizeFade(): void {
  const prev = prevVideo
  if (prev !== undefined) {
    prev.pause()
    prevVideo = undefined
    fadeMs = 0
  }
}

/** B04 v2 片段切换：固定元素乒乓 + under-lay 交叉淡入。无 GL 或零交叉时长
 * 降级为直换（旧层立即暂停）。同源重入（状态重渲染）= 同步 loop 标记 +
 * 确保播放，不重启不换层。 */
function switchClip(source: string, loop: boolean, transitionMs: number): void {
  if (video.src === source) {
    video.loop = loop
    void video.play().catch(() => { /* autoplay muted: always allowed */ })
    return
  }
  const outgoing = video
  // v2 修复核心：incoming 永远是"另一块"固定元素，与全局指针无关——
  // v1 用 `outgoing === videoB ? video : videoB` 算 incoming，返回切换时
  // video 已指向 outgoing，塌缩成自交叉自暂停（单动作后冻结的根因）。
  const incoming = outgoing === videoA ? videoB : videoA
  // 在途交叉先终局：换层即旧层的旧层退场，避免泄漏播放或冻结垫底。
  finalizeFade()
  incoming.src = source
  incoming.loop = loop
  void incoming.play().catch(() => { /* autoplay muted: always allowed */ })
  if (glFailed) {
    // 无 GL 的降级：可见节点直换（无交叉能力）。outgoing 可能已被上一次
    // 直换摘出 DOM——无父节点时直接挂到 body。
    incoming.style.display = 'block'
    if (outgoing.parentNode !== null) outgoing.parentNode.replaceChild(incoming, outgoing)
    else document.body.appendChild(incoming)
  } else if (transitionMs > 0) {
    // under-lay 交叉：旧层保持 alpha 1 继续垫底，新层按进度盖上；淡入
    // 完成后由 draw() 统一暂停旧层。outgoing 与 incoming 恒为不同元素。
    prevVideo = outgoing
    fadeStart = performance.now()
    fadeMs = transitionMs
  } else {
    outgoing.pause()
  }
  video = incoming
}

function play(key: string): void {
  const source = animationSource(key)
  // State animations loop (a state persists until an event changes it);
  // the celebration is a one-shot that hands back via its ended event.
  switchClip(source, key !== 'celebrate', key === 'idle' ? transitionMsFor(true) : transitionMsFor(false))
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
  if (state !== 'idle') {
    // 离开 idle：待机计时取消，bodyRuntime.idleNextAt 一并清零（过期值
    // 留在 /status 里会误导"她下一次自己动是什么时候"）。
    idleNextAt = 0
    if (theaterTimer !== undefined) {
      // Leaving idle cancels the pending theater clip; re-entering idle
      // re-arms through render().
      clearTimeout(theaterTimer)
      theaterTimer = undefined
    }
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

function playOneShotAt(name: AnimationName, requestId?: string, opts?: { noMirror?: boolean }): void {
  const source = `pet-asset:///${CHARACTER}/videos/${name.dir}/${encodeURIComponent(name.file)}.webm`
  if (video.src === source) return
  oneShotActive = true
  // B01：播放期间朝向锁定。文字片段（noMirror）在 facing=left 时临时锁
  // right（素材朝向即 right，镜像会反写文字），播完按最后已知光标偏移重判。
  facingLocked = true
  const facingBeforeLock = facing
  if (opts?.noMirror === true && facing !== 'right') {
    facing = 'right'
    applyFacing()
  }
  const handBack = (): void => {
    video.onended = null
    video.onerror = null
    oneShotActive = false
    facingLocked = false
    if (lastCursorOffsetX !== undefined) {
      const restored = facingForOffset(lastCursorOffsetX, facingBeforeLock)
      if (restored !== facing) {
        facing = restored
        applyFacing()
      }
    } else if (facing !== facingBeforeLock) {
      facing = facingBeforeLock
      applyFacing()
    }
    // Report completion with the clip's own duration — the one observable
    // trace that a one-shot actually FINISHED (override/animation are not).
    globals.petDesktop?.reportActionDone({
      action: name.file,
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
      ...(requestId === undefined ? {} : { requestId }),
    })
    render()
  }
  // B04：切层先于挂钩——onended/onerror 必须落在即将播放的新身元素上
  // （switchClip 已把 video 指到 incoming 并带交叉起播）。
  switchClip(source, false, transitionMsFor(false))
  video.onended = handBack
  video.onerror = handBack
  // past the same-src early return above: the stage really changed — record
  // it for bodyRuntime.lastClip (the "最近播放的片段" the B08 docstring
  // promises; a video.src snapshot structurally misses the gesture window).
  lastPlayedClip = `${name.file}.webm`
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
 * page has loaded). Entries carry the body 迭代的两个池标记：idleEligible
 * （B02 待机白名单）与 noMirror（B01 文字镜像豁免，来源 text_clips.json）。 */
type CatalogClip = AnimationName & { id: string; tags?: string[]; idleEligible?: boolean; noMirror?: boolean }

const actionCatalog = new Map<string, CatalogClip>()

globals.petDesktop?.onCatalog?.((catalog) => {
  const entries = (catalog as { actions?: unknown }).actions
  if (!Array.isArray(entries)) return
  actionCatalog.clear()
  for (const entry of entries) {
    const record = entry as { id?: unknown; dir?: unknown; file?: unknown; tags?: unknown; idleEligible?: unknown; noMirror?: unknown }
    if (typeof record.id !== 'string' || typeof record.dir !== 'string' || typeof record.file !== 'string') continue
    const entryTags = Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === 'string') : undefined
    actionCatalog.set(record.id, {
      id: record.id,
      dir: record.dir,
      file: record.file,
      ...(entryTags !== undefined && entryTags.length > 0 ? { tags: entryTags } : {}),
      ...(record.idleEligible === true ? { idleEligible: true } : {}),
      ...(record.noMirror === true ? { noMirror: true } : {}),
    })
  }
  // B02/B03：body 自述随 catalog 推送（main 已读好 body.json——IPC 主路径，
  // 实测渲染层 pet-asset fetch 不稳）。推送未带 body 时回落 fetch。
  const pushedBody = (catalog as { body?: unknown }).body
  if (typeof pushedBody === 'object' && pushedBody !== null) {
    applyBodyDescription(pushedBody as Record<string, unknown>)
  }
  // 启动竞速修复：渲染层 boot 时的首份 status 报告早于 main 注册
  // 'pet:status-report'，会丢——且 reportedSnapshot 已被置位，等值补报会被
  // 去重静默跳过（实测：/status 冻结在初始值、bodyRuntime 消失的根因）。
  // 清掉去重位强制重发。
  reportedSnapshot = ''
  reportStatus()
})

/**
 * The idle theater (the animation half of the settings page's 自主表达):
 * while idle — no override bubble, no error flash, no one-shot in flight —
 * the pet occasionally plays a clip. 双模式（B02 定案）：
 *  - bodyIdle（body.json capabilities.idle.supported=true）：40–120s 随机
 *    节奏 + noRepeat 2，池 = catalog 的 idleEligible 白名单（facing=left 时
 *    排除 noMirror 片段）；**autonomy 的 GapMinutes 退役**（设置页开关仍管
 *    总开关）。
 *  - legacy（无 body idle 能力）：现状行为，autonomy.gapMinutes 节奏、
 *    random 池减 THEATER_EXCLUDED。
 * Config arrives on /state pushes (`autonomy`); a pet that never receives a
 * push keeps the theater off, so behavior is unchanged until the driver
 * speaks. bodyIdle 由 body.json 自述（boot 时经 pet-asset:// 拉取）。
 */
interface TheaterConfig {
  enabled: boolean
  gapMinutes: number
}

interface BodyIdleConfig {
  intervalMs: readonly [number, number]
  noRepeat: number
}

let theater: TheaterConfig = { enabled: false, gapMinutes: 10 }
let bodyIdle: BodyIdleConfig | undefined
let idleBias: { hours: readonly [number, number]; weights: Readonly<Record<string, number>> } | undefined
let _bodyTransitions: { defaultMs: number; toIdleMs: number } | undefined
let bodyRects: Record<string, readonly (readonly number[])[]> | undefined
let theaterTimer: ReturnType<typeof setTimeout> | undefined
let theaterLastFile: string | undefined
let idleRecent: string[] = []
let idleNextAt = 0

// ── B10 表达连续性：情绪状态 ────────────────────────────────────────────────
// 判断是模型的：pet_say/pet_do 携带的 mood（她说话时最清楚自己的情绪）落
// 在这里；系统只存状态、做 10 分钟衰减、并把它翻译成剧场的标签加权。语
// 表 = actions.tags.json 的中文词表；无匹配标签的池回落无加权（不锁死）。
let moodName = 'neutral'
let moodUntil = 0
const MOOD_TTL_MS = 10 * 60_000
const MOOD_TAGS: Record<string, readonly string[]> = {
  happy: ['开心', '搞笑', '庆祝', '活泼'],
  excited: ['活泼', '开心', '才艺', '庆祝'],
  calm: ['放松', '自处', '日常'],
  focused: ['专注', '思考', '工作'],
  sleepy: ['疲惫', '自处'],
  sad: ['悲伤', '委屈'],
  angry: ['生气'],
  shy: ['害羞', '撒娇'],
  curious: ['好奇', '张望'],
}
function setMood(raw: unknown): void {
  if (typeof raw !== 'string') return
  const name = raw.toLowerCase()
  if (name === '' || name === 'neutral') {
    moodName = 'neutral'
    moodUntil = 0
    return
  }
  if (!(name in MOOD_TAGS)) return
  moodName = name
  moodUntil = Date.now() + MOOD_TTL_MS
  reportStatus()
}
function effectiveMood(): string {
  return Date.now() < moodUntil ? moodName : 'neutral'
}
/** 情绪标签与片段 tags 有交集 → ×4 加权（max-not-product 与 B06 同构）；
 * neutral/无匹配 = ×1，剧场保持原有随机面。 */
function moodWeightOf(entry: CatalogClip): number {
  const tags = MOOD_TAGS[effectiveMood()]
  if (tags === undefined) return 1
  const matched = (entry.tags ?? []).some(tag => tags.includes(tag))
  return matched ? 4 : 1
}
// bodyRuntime.lastClip 的来源：最近一次换上舞台的 one-shot 片段（小动作/
// 触摸反应//action/celebrate）。基础循环的换回（handback → play(baseState)）
// 不改写它——否则 lastClip 会退回"当前 src 快照"，小动作的几秒窗口外取
// 样永远只拍到 待机呼吸休闲（2026-11-10 实测诊断：idleNextAt 在跳、
// lastClip 18 秒纹丝不动）。存 `.webm` 全名，与旧快照格式一致。
let lastPlayedClip = ''
// A one-shot in flight (touch reaction, /action, a theater clip itself): the
// pending timer must not hijack the stage mid-clip.
let oneShotActive = false

function theaterPool(): CatalogClip[] {
  return [...actionCatalog.values()].filter(entry =>
    entry.dir === 'random'
    && !THEATER_EXCLUDED.has(entry.file)
    && entry.file !== theaterLastFile)
}

/** B02 池：idleEligible 白名单；facing=left 排除 noMirror；noRepeat 排除
 * 最近 2 个（排除后空则回落全白名单——软化不锁死）。与 pet-app
 * idle-selector.eligibleIdlePool 同语义（渲染层镜像实现）。 */
/** B06 偏置权重（与 pet-app idle-selector.biasWeightOf 同语义——渲染层镜像
 * 实现）：最强匹配标签的乘数；无表/窗外 = ×1。 */
function biasWeightOf(
  entry: CatalogClip,
  bias: { hours: readonly [number, number]; weights: Readonly<Record<string, number>> } | undefined,
  hour: number,
): number {
  if (bias === undefined) return 1
  const [from, to] = bias.hours
  const inWindow = from <= to ? hour >= from && hour < to : hour >= from || hour < to
  if (!inWindow) return 1
  let weight = 1
  for (const tag of entry.tags ?? []) {
    const w = bias.weights[tag]
    if (typeof w === 'number' && Number.isFinite(w) && w > weight) weight = w
  }
  return weight
}

function bodyIdlePool(): CatalogClip[] {
  if (bodyIdle === undefined) return []
  const eligible = [...actionCatalog.values()].filter(entry => entry.idleEligible === true)
  const facingPool = facing === 'left'
    ? eligible.filter(entry => entry.noMirror !== true)
    : eligible
  const excluded = new Set(idleRecent.slice(0, bodyIdle.noRepeat))
  // 正在循环播放的 idle 状态片段也排除——抽到它会在 playOneShotAt 里因
  // src 相同被早退，theater 计时器不再重铺（Phase 1 实测死亡路径）。
  const playingFile = decodeURIComponent(video.src.split('/').pop() ?? '').replace(/\.webm$/, '')
  if (playingFile !== '') excluded.add(playingFile)
  const fresh = facingPool.filter(entry => !excluded.has(entry.id))
  return fresh.length > 0 ? fresh : facingPool.filter(entry => entry.id !== playingFile)
}

const sampleIdleInterval = (bounds: readonly [number, number]): number => {
  const [min, max] = bounds
  const base = min + Math.random() * (max - min)
  return Math.round(Math.min(max, Math.max(min, base * (1 + (Math.random() * 2 - 1) * 0.2))))
}

function scheduleTheater(): void {
  if (theaterTimer !== undefined) return
  if (!theater.enabled || baseState !== 'idle' || override !== null || Date.now() < errorUntil) return
  const bodyIdleConfig = bodyIdle
  const bodyMode = bodyIdleConfig !== undefined && bodyIdlePool().length > 0
  if (!bodyMode && theaterPool().length === 0) return
  // B02 反馈：自由活动的 GapMinutes 不退役，作为身体节奏的间隔上限——
  // 用户把间隔调小，待机就变快（下限仍为 body.json 的 min）。
  const gapCapMs = Math.max(1, theater.gapMinutes) * 60_000
  const idleBounds: readonly [number, number] = bodyMode
    ? [
      bodyIdleConfig.intervalMs[0],
      Math.max(bodyIdleConfig.intervalMs[0], Math.min(bodyIdleConfig.intervalMs[1], gapCapMs)),
    ]
    : [60_000, 60_000]
  const delay = bodyMode ? sampleIdleInterval(idleBounds) : gapCapMs
  idleNextAt = Date.now() + delay
  reportStatus()
  theaterTimer = setTimeout(() => {
    theaterTimer = undefined
    if (!theater.enabled || baseState !== 'idle' || override !== null || oneShotActive || Date.now() < errorUntil) {
      scheduleTheater() // conditions changed while pending: re-arm from now
      return
    }
    const pool = bodyIdle !== undefined ? bodyIdlePool() : theaterPool()
    if (bodyIdle !== undefined && pool.length === 0) {
      scheduleTheater()
      return
    }
    // B06：时段偏置加权（max-not-product；权重表随 /state 载荷下发）×
    // B10 情绪标签加权（matched ×4）——两个乘数独立作用。
    let pick: CatalogClip | undefined
    if (bodyIdle !== undefined) {
      const hour = new Date().getHours()
      const weights = pool.map(entry => biasWeightOf(entry, idleBias, hour) * moodWeightOf(entry))
      const total = weights.reduce((sum, w) => sum + w, 0)
      let roll = Math.random() * total
      pick = pool[pool.length - 1]
      for (let i = 0; i < pool.length; i += 1) {
        roll -= weights[i] ?? 0
        if (roll < 0) {
          pick = pool[i]
          break
        }
      }
    } else {
      // legacy 池也吃情绪加权（无偏置表）。
      const weights = pool.map(entry => moodWeightOf(entry))
      const total = weights.reduce((sum, w) => sum + w, 0)
      let roll = Math.random() * total
      pick = pool[pool.length - 1]
      for (let i = 0; i < pool.length; i += 1) {
        roll -= weights[i] ?? 0
        if (roll < 0) {
          pick = pool[i]
          break
        }
      }
    }
    if (pick !== undefined) {
      theaterLastFile = pick.file
      idleRecent.unshift(pick.id)
      idleRecent = idleRecent.slice(0, Math.max(2, bodyIdle?.noRepeat ?? 2))
      playOneShotAt(pick, undefined, pick.noMirror === true ? { noMirror: true } : undefined)
    }
    // The next interval arms inside playOneShotAt's handback (render →
    // scheduleTheater); nothing to do here.
  }, delay)
}

// ── bubbles ─────────────────────────────────────────────────────────────────

type PendingAnswer = (outcome: 'allowed-once' | 'rejected') => void

const questionSelections = new Map<string, string[]>()

function hideBubble(): void {
  bubble.hidden = true
  bubble.replaceChildren()
  globals.petDesktop?.setBubbleVisible(false)
  syncLetterBox()
}

// ── 留信的独立浮层（B10+/内在生活外化）────────────────────────────────────
// 信是"物件"，不与说话共用气泡——她随后说的每句话都会 replaceChildren 清掉
// 旧内容（实测：密封信封被说话气泡顶掉，信直接丢失）。信件有自己的元素与
// 生命周期：气泡显示时让位（说话/审批卡优先占位），气泡一空就回来，收好
// 才走。pet-letters.json 档案保证重启/换代也不丢。
const letterBox = document.createElement('div')
letterBox.id = 'letter-box'
letterBox.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);bottom:224px;z-index:10;display:none'
let currentLetter: { text: string; petId?: string; letterAt?: number } | null = null
let letterDismissed = false
let letterOpened = false
;(bubble.parentNode ?? document.body).appendChild(letterBox)

function syncLetterBox(): void {
  // 信在"气泡空档"出现：说话/审批卡占用气泡时让位（隐藏），气泡一空就回来。
  const want = currentLetter !== null && !letterDismissed && bubble.hidden
  const was = letterBox.style.display === 'block'
  letterBox.style.display = want ? 'block' : 'none'
  if (want === was) return
  // 信占的就是 bubble 命中区（主进程点击穿透判定按 bubbleVisible 参与）：
  // 让位循环回归只走这里（renderLetterBox 的上报覆盖不到）——信可见必须
  // 重新上报，否则主进程仍判穿透，点击全落桌面；信走开且气泡也空才还域。
  if (want) {
    globals.petDesktop?.setBubbleVisible(true)
  } else if (bubble.hidden) {
    globals.petDesktop?.setBubbleVisible(false)
  }
}
setInterval(syncLetterBox, 800)

function renderLetterBox(): void {
  ensureLetterStyles()
  letterBox.replaceChildren()
  // 信封/信纸占的就是主进程点击穿透判定的 bubble 区——bubbleVisible=true
  // 让 bubbleRect 参与可交互判定（漏掉这行=光标进信封区仍是穿透态，点击
  // 全部落到桌面上，"拆信无反应"的根因）。
  globals.petDesktop?.setBubbleVisible(true)
  if (currentLetter === null) return
  const notice = currentLetter
  const unreadLabel = letterUnread > 1 ? ' · ' + String(letterUnread) + ' 封未读' : ''
  if (!letterOpened) {
    // 密封态：信封主体 + 盖口 + 封蜡 + 「她留下了一封信 · N 封未读」，点击拆信。
    const env = document.createElement('div')
    env.className = 'letter-env'
    const flap = document.createElement('div')
    flap.className = 'letter-flap'
    const seal = document.createElement('div')
    seal.className = 'letter-seal'
    const hint = document.createElement('p')
    hint.className = 'letter-hint'
    hint.textContent = '她留下了一封信' + unreadLabel
    env.append(flap, seal, hint)
    env.onclick = function (): void {
      if (letterOpened) return
      letterOpened = true
      // 拆开 = 已读回执（fire-and-forget：失败不影响拆信仪式）
      if (typeof notice.petId === 'string' && typeof notice.letterAt === 'number') {
        fetch('/api/pet-settings/letter-read', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ petId: notice.petId, at: notice.letterAt }),
        }).catch(function () { /* 回执失败不影响拆信 */ })
      }
      env.classList.add('letter-opening')
      setTimeout(renderLetterBox, 320) // 盖口翻起的过渡走完再换信纸
    }
    letterBox.append(env)
    return
  }
  // 信纸态：米色渐变底 + 楷体全文 + 收好（她的声音在拆开时读）。
  const card = document.createElement('div')
  card.className = 'letter-paper'
  const paper = document.createElement('p')
  paper.className = 'bubble-detail'
  paper.style.margin = '0 0 8px'
  paper.textContent = notice.text
  const close = document.createElement('button')
  close.className = 'letter-close'
  close.textContent = '✉ 收好'
  close.onclick = function (): void {
    const petId = notice.petId
    letterDismissed = true
    currentLetter = null
    // 信箱堆叠：还有未读 → 下一封顶上（重新密封）；拆完了 → 信箱空
    if (typeof petId === 'string') {
      fetchLetterQueue(petId, () => {
        const next = letterQueue.find((l) => l.readAt === undefined)
        if (next !== undefined) {
          currentLetter = { text: next.text, petId, letterAt: next.at }
          letterOpened = false
          letterDismissed = false // 下一封未读顶上：浮层回归显示态（收好置位的闸门必须复位，否则 syncLetterBox 把重建好的信封藏回去）
          renderLetterBox()
        }
        syncLetterBox()
      })
    } else {
      syncLetterBox()
    }
  }
  card.append(paper, close)
  letterBox.append(card)
}

// 信箱队列（pet-letters.json 的未读子集，新信在前）：badge 显示积压数，
// 收好一封后下一封未读自动顶上（信箱清空才回到无信状态）。
let letterQueue: Array<{ at: number; text: string; readAt?: number }> = []
let letterUnread = 0
function fetchLetterQueue(petId: string, cb: (unread: number) => void): void {
  fetch(`/api/pet-settings/letters?petId=${encodeURIComponent(petId)}`, { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((d) => {
      const letters = Array.isArray(d?.letters) ? d.letters as Array<{ at: number; text: string; readAt?: number }> : []
      letterQueue = letters
      letterUnread = letters.filter((l) => l.readAt === undefined).length
      cb(letterUnread)
    })
    .catch(() => cb(0))
}

function deliverLetter(notice: { text: string; petId?: unknown; letterAt?: unknown }): void {
  currentLetter = { text: notice.text, petId: typeof notice.petId === 'string' ? notice.petId : undefined, letterAt: typeof notice.letterAt === 'number' ? notice.letterAt : undefined }
  letterDismissed = false
  letterOpened = false
  const petId = currentLetter.petId
  if (petId !== undefined) {
    fetchLetterQueue(petId, () => { renderLetterBox(); syncLetterBox() })
  } else {
    renderLetterBox()
  }
  syncLetterBox()
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

/** B02：拉取身体自述，capabilities.idle.supported 时以身体节奏接管 idle
 * theater（autonomy 的 GapMinutes 退役，总开关仍归设置页）。失败 = legacy。 */
type BodyCapabilityWire = {
  kind?: unknown
  supported?: unknown
  intervalMs?: unknown
  noRepeat?: unknown
  defaultMs?: unknown
  toIdleMs?: unknown
}

/** B02/B03：身体自述入库——idle 节奏 / transition / 命中区（含多矩形）。
 * bodyIdle 激活时清掉 legacy 计时器再重铺（否则第一个动作要等满 legacy
 * 间隔——实测 idleNextAt 缺失的根因）。 */
function applyBodyDescription(raw: Record<string, unknown>): void {
  const capabilities = raw.capabilities as
    | Record<string, BodyCapabilityWire>
    | undefined
  const transition = capabilities?.transition
  if (transition?.kind === 'transition' && transition.supported === true
    && typeof transition.defaultMs === 'number' && Number.isFinite(transition.defaultMs)) {
    _bodyTransitions = {
      defaultMs: Math.min(500, Math.max(0, transition.defaultMs)),
      toIdleMs: typeof transition.toIdleMs === 'number' && Number.isFinite(transition.toIdleMs)
        ? Math.min(500, Math.max(0, transition.toIdleMs))
        : Math.min(500, Math.max(0, transition.defaultMs)),
    }
  }
  const rects = (raw.hitboxes as { rects?: unknown } | undefined)?.rects
  if (typeof rects === 'object' && rects !== null) {
    const cleaned: Record<string, readonly (readonly number[])[]> = {}
    for (const [part, shape] of Object.entries(rects as Record<string, unknown>)) {
      if (!Array.isArray(shape)) continue
      if (shape.every(n => typeof n === 'number' && Number.isFinite(n))) {
        cleaned[part] = [shape as readonly number[]]
        continue
      }
      const multi = shape.filter(entry =>
        Array.isArray(entry) && (entry as unknown[]).every(n => typeof n === 'number' && Number.isFinite(n)))
      if (multi.length > 0) cleaned[part] = multi as readonly (readonly number[])[]
    }
    if (Object.keys(cleaned).length > 0) bodyRects = cleaned
  }
  const idle = capabilities?.idle
  const interval: readonly unknown[] = Array.isArray(idle?.intervalMs) ? idle.intervalMs : []
  const min = typeof interval[0] === 'number' && Number.isFinite(interval[0]) ? interval[0] : undefined
  const max = typeof interval[1] === 'number' && Number.isFinite(interval[1]) ? interval[1] : undefined
  const idleOk = idle?.kind === 'idle' && idle.supported === true
    && min !== undefined && max !== undefined && min < max
  console.info(`[pet-body] 应用完成：idle=${idleOk ? `${String(min)}-${String(max)}ms` : '未声明（待机走 legacy 节奏）'}，hitboxes=${Object.keys(bodyRects ?? {}).join('+') || '无'}`)
  if (!idleOk) return
  bodyIdle = {
    intervalMs: [min, max],
    noRepeat: typeof idle.noRepeat === 'number' && Number.isInteger(idle.noRepeat) && idle.noRepeat >= 1
      ? idle.noRepeat
      : 2,
  }
  if (theaterTimer !== undefined) {
    clearTimeout(theaterTimer)
    theaterTimer = undefined
  }
  scheduleTheater()
}

async function loadBodyDescription(): Promise<void> {
  // pet-asset fetch 是降级路径：主路径 = pet:catalog 推送（main 已读好
  // body.json，随 catalog 一起发——实机实测 fetch 不稳）。
  try {
    const response = await fetch(`pet-asset:///${CHARACTER}/body.json`)
    if (!response.ok) {
      console.error(`[pet] body.json fetch HTTP ${String(response.status)}——bodyIdle/命中区走 legacy`)
      return
    }
    const raw = await response.json() as Record<string, unknown>
    applyBodyDescription(raw)
  } catch (error) {
    console.error(`[pet] body.json fetch failed: ${String(error)}——bodyIdle/命中区走 legacy`)
  }
}

function boot(): void {
  setupStage(stage)
  render()
  void loadBodyDescription()
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
  const visualX = (clientX - rect.left - (rect.width - drawWidth) / 2) / scale
  const videoY = (clientY - rect.top - (rect.height - drawHeight) / 2) / scale
  // B01/B03：舞台镜像后，视觉坐标先折回原始帧坐标，再比对 body.json 的矩形
  //（缺 body.json 回落 head/body 两个既有矩形）。判定顺序 = 特定分区优先。
  const frameX = facing === 'left' ? 640 - visualX : visualX
  const rects: Record<string, readonly (readonly number[])[]> = bodyRects ?? {
    head: [[185, 60, 436, 195]],
    body: [[212, 60, 428, 330]],
  }
  const inBox = (box: readonly number[]): boolean =>
    frameX >= box[0] && frameX <= box[2] && videoY >= box[1] && videoY <= box[3]
  // 判定顺序 = 特定分区优先；一个分区允许多矩形（尾巴的双侧尾鳍）。
  for (const part of ['tail', 'hand', 'head', 'body']) {
    const shape = rects[part]
    if (shape === undefined) continue
    // 单矩形视作单元素多矩形，统一走同一条命中路径（避免跨形状断言）。
    for (const box of shape) {
      if (inBox(box)) return part
    }
  }
  return 'body' // B03 有意变更：unknown 兜底改按 body
}

/** B03 分区专属反应：尾巴 → 吐泡泡（吐魂近似），手 → 元气挥手；其余走通用
 * 点击回应组。片段经 catalog 解析，未收录时回落通用组。 */
const PART_REACTIONS: Record<string, readonly string[]> = {
  tail: ['鲸鱼吐泡泡特效'],
  hand: ['点击回应-元气挥手'],
}

/** A completed gesture that never moved far nor lasted long is a touch. */
const CLICK_MAX_DISTANCE = 5
const CLICK_MAX_MS = 500

// The touch REPORT is deferred by the dblclick window (~260ms): a
// double-click (open the chat card) must not also register as two pats —
// the instant reaction animation still plays, only the ledger report
// waits for the click pattern to settle. Rapid petting then counts as
// one touch per 260ms burst, which matches the gesture.
let touchReportTimer: ReturnType<typeof setTimeout> | undefined
function handleTouch(clientX: number, clientY: number): void {
  const part = touchPartOf(clientX, clientY)
  // 触摸诊断：分区命中与可用矩形进 runtime log——tail 摸不到时先看这行
  // （bodyRects 若是 FALLBACK，说明 body.json 没送达渲染层）。
  console.info(`[pet-touch] part=${part} rects=${Object.keys(bodyRects ?? {}).join('+') || 'FALLBACK'} facing=${facing}`)
  const named = PART_REACTIONS[part]
    ?.map(name => actionCatalog.get(name))
    .filter((entry): entry is CatalogClip => entry !== undefined)
  const reactions: CatalogClip[] = named !== undefined && named.length > 0
    ? named
    : ANIMATION.touch.map(entry => ({ ...entry, id: entry.file }))
  if (reactions.length > 0 && override === null && Date.now() >= errorUntil) {
    const pick = reactions[Math.floor(Math.random() * reactions.length)]
    if (pick !== undefined) {
      playOneShotAt(pick, undefined, pick.noMirror === true ? { noMirror: true } : undefined)
    }
  }
  if (touchReportTimer !== undefined) clearTimeout(touchReportTimer)
  touchReportTimer = setTimeout(() => {
    touchReportTimer = undefined
    globals.petDesktop?.reportTouch({ part, rects: Object.keys(bodyRects ?? {}).join('+') || 'FALLBACK' })
  }, 260)
}

petBody.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  // B04：开拖即终局交叉——拖拽撞上交叉窗口会看到两个身位（v1 实测教训），
  // 拖拽永远单一身形（新身继续播，旧身立即退场）。
  finalizeFade()
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

// ── chat input card (§6 chat上行) ───────────────────────────────────────────
// Double-click the pet body to talk to it: the text rides a /events `chat`
// event to the driver's inner-voice session, and the reply comes back as a
// normal /say bubble. One message in flight per pet (the contract's input
// modal): a busy send is refused with an inline hint, not silently dropped.

function openChatCard(): void {
  // One bubble at a time: an interaction card outranks the chat input, and
  // the chat card itself parks inside THE bubble (hidden by hideBubble()).
  if (override !== null || Date.now() < errorUntil) return
  stopSayAudio() // the chat card replaces the say bubble; its voice stops too
  bubble.replaceChildren()
  const row = document.createElement('div')
  row.className = 'bubble-chat'
  const input = document.createElement('input')
  input.className = 'bubble-chat-input'
  input.maxLength = 2000
  input.placeholder = '和鲸鱼娘说点什么…'
  const send = document.createElement('button')
  send.className = 'bubble-button primary'
  send.textContent = '发送'
  const cancel = document.createElement('button')
  cancel.className = 'bubble-button'
  cancel.textContent = '取消'
  cancel.addEventListener('click', () => { hideBubble() })
  const submit = async (): Promise<void> => {
    const text = input.value.trim()
    if (text === '' || send.disabled) return
    send.disabled = true
    input.disabled = true
    const result = await globals.petDesktop?.sendChat(text)
    if (result?.ok === true) {
      hideBubble() // the reply arrives later as a plain /say bubble
      return
    }
    send.disabled = false
    input.disabled = false
    input.placeholder = result?.reason === 'busy' ? '上一条还没送达，稍等一下…' : '没发出去，再试一次'
    input.focus()
  }
  send.addEventListener('click', () => { void submit() })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape') {
      hideBubble()
    }
  })
  row.append(input, send, cancel)
  bubble.append(row)
  bubble.hidden = false
  globals.petDesktop?.setBubbleVisible(true)
  render()
  input.focus()
}

petBody.addEventListener('dblclick', (event) => {
  event.stopPropagation()
  // A double-click is INTENT TO TALK, not two pats: cancel the deferred
  // touch reports from both clicks of the gesture.
  if (touchReportTimer !== undefined) {
    clearTimeout(touchReportTimer)
    touchReportTimer = undefined
  }
  openChatCard()
})

// ── control interface (driver path) ─────────────────────────────────────────
// The four operations, delivered over IPC from the main-process HTTP host.
// During the transition this and the in-page WS event path drive the same
// state machine side by side; the WS path retires when the driver-side lands
// (DSH-PET.md §7.2).

// The say bubble's hide timer, ONE slot: a fresh /say re-arms it with the
// text-length formula, an arriving TTS track re-arms it to cover the audio —
// so the text never disappears mid-sentence. The guard re-checks the bubble:
// a timer from a superseded display must not close a newer one.
let sayHideTimer: ReturnType<typeof setTimeout> | undefined

function armSayHide(text: string, delayMs: number): void {
  if (sayHideTimer !== undefined) clearTimeout(sayHideTimer)
  sayHideTimer = setTimeout(() => {
    sayHideTimer = undefined
    if (override !== null || bubble.textContent !== text) return
    hideBubble()
  }, Math.max(1000, delayMs))
}

// ── say voice (BreezeBlue, carrier-side synthesis) ──────────────────────────
// When TTS is configured, the main process holds the bubble until the mp3
// lands (bounded) and delivers text + audio as ONE message. Playback rules:
// the track starts the moment its bubble appears (they are the same event),
// the bubble lifetime extends to the audio's duration, and when it ends the
// bubble goes with it. A delivery without audio (synthesis off, slow, or
// failed) is exactly yesterday's bubble.
let sayAudio: HTMLAudioElement | undefined
let sayAudioUrl: string | undefined

function stopSayAudio(): void {
  const audio = sayAudio
  if (audio !== undefined && !audio.paused) audio.pause()
}

function playSayAudio(text: string, bytes: Uint8Array<ArrayBuffer>): void {
  if (sayAudioUrl !== undefined) URL.revokeObjectURL(sayAudioUrl)
  const audio = sayAudio ?? (sayAudio = new Audio())
  sayAudioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
  audio.src = sayAudioUrl
  audio.onloadedmetadata = () => {
    // The authoritative lifetime: the track's own length plus a small tail,
    // replacing the text-length estimate for as long as this bubble lives.
    if (Number.isFinite(audio.duration) && audio.duration > 0) armSayHide(text, audio.duration * 1000 + 1500)
  }
  audio.onended = () => {
    if (override === null && bubble.textContent === text) hideBubble()
  }
  audio.onerror = () => { /* the say timer already governs the bubble */ }
  void audio.play().catch(() => { /* synthesis is an enhancement: silence is fine */ })
}

globals.petDesktop?.onSay((notice) => {
  // Fire-and-forget speech: self-dismisses, never blocks, and an interaction
  // bubble in flight outranks it (single-bubble design). A new say also
  // stops the previous utterance — the voice follows the newest bubble.
  setMood(notice.mood)
  if (override !== null || notice.text === '') return
  if (notice.letter === true) {
    // 留信走独立浮层（letterBox）：信是"物件"，不与说话共用气泡——她随后
    // 说的每句话都会 replaceChildren 清掉旧内容（实测：密封信封被说话气泡
    // 顶掉，信直接丢失）。气泡显示时信让位，气泡一空信回来；收好才走。
    deliverLetter(notice)
    return
  }
  letterBox.style.display = 'none' // 新说话到达：信立即让位（不等同步轮询）
  bubble.style.background = ''
  bubble.style.border = ''
  bubble.style.boxShadow = ''
  bubble.style.padding = ''
  bubble.style.width = ''
  bubble.style.color = ''
  stopSayAudio()
  bubble.replaceChildren()
  const text = document.createElement('p')
  text.className = 'bubble-detail'
  text.textContent = notice.text
  bubble.append(text)
  bubble.hidden = false
  globals.petDesktop?.setBubbleVisible(true)
  armSayHide(notice.text, 4000 + Math.min(notice.text.length * 60, 4000))
  const bytes = notice.audio
  if (bytes !== undefined && bytes.length > 0) playSayAudio(notice.text, bytes)
})

let reportedSnapshot = ''
const reportStatus = (): void => {
  // B08 bodyRuntime：朝向 / 下一次待机时刻 / 最近播放的片段。lastClip 读
  // lastPlayedClip（最近一次 one-shot，不被基础循环的换回覆盖）——`clip`
  // 是当前 src 快照，只供 animation 字段用；快照口径曾让 lastClip 在小动
  // 作窗口外永远显示基础循环，失去"她刚才做了什么"的信息量。
  const clip = decodeURIComponent(video.src.split('/').pop() ?? '')
  const bodyRuntime = {
    facing,
    // B10：当前表达情绪（恒定输出；pet_state 经 normalizeStatus 透传给模型
    // ——她能看到自己此刻的身体情绪，10 分钟无续期回落 neutral）。
    mood: effectiveMood(),
    ...(idleNextAt > 0 ? { idleNextAt } : {}),
    ...(lastPlayedClip !== '' ? { lastClip: lastPlayedClip } : {}),
  }
  const snapshot = JSON.stringify({ state: baseState, override, animation: clip, bodyRuntime })
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
    const record = autonomy as { idleAnimation?: unknown; gapMinutes?: unknown; idleBias?: unknown }
    // B06：偏置表随载荷下发（absent = 旧驱动保持现状；null = 显式关闭）。
    if ('idleBias' in record) {
      const value = record.idleBias
      if (typeof value === 'object' && value !== null) {
        const candidate = value as { hours?: unknown; weights?: unknown }
        if (Array.isArray(candidate.hours) && candidate.hours.length === 2
          && typeof candidate.weights === 'object' && candidate.weights !== null) {
          idleBias = {
            hours: [candidate.hours[0] as number, candidate.hours[1] as number],
            weights: candidate.weights as Record<string, number>,
          }
        } else {
          idleBias = undefined
        }
      } else {
        idleBias = undefined
      }
    }
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
  const payload = message as { action?: unknown; requestId?: unknown; mood?: unknown }
  setMood(payload.mood)
  const action = payload.action
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined
  if (action === 'celebrate') playOneShot('celebrate', requestId)
  else if (action === 'error') flashError()
  else if (typeof action === 'string') {
    // Named clip playback: the main process validated the name against its
    // catalog before forwarding, so an unresolvable id here can only come
    // from a stale catalog — ignoring it keeps the state machine intact.
    const hit = actionCatalog.get(action)
    if (hit !== undefined) playOneShotAt(hit, requestId, hit.noMirror === true ? { noMirror: true } : undefined)
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
  stopSayAudio() // the say bubble (if any) is superseded; its voice stops with it
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
