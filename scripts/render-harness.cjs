/**
 * Client render harness — runs the settings-page client's RENDER BODY in node
 * with stubbed react hooks, catching ReferenceErrors without a browser.
 * （浏览器 Console 不可达时的设置页预检：node scripts/render-harness.cjs）
 *
 * Usage: node scripts/render-harness.cjs
 * Exit 0 = render clean; exit 1 = the render throws (the exact error printed).
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const code = fs.readFileSync(path.join(__dirname, '..', 'client', 'pet-settings.js'), 'utf8')

// Representative /api/pet-settings/read payload (same shape as the host GET).
const SAMPLE = {
  settings: {
    proactivity: { idleAnimation: true, idleAnimationGapMinutes: 5 },
    innerVoice: {
      enabled: true, preset: 'whale598-standard', wakeIntervalMinutes: 5,
      speakProbability: 1, touchReplyProbability: 1, touchReplyCooldownSeconds: 0,
    },
    debug: { cdp: false },
    names: { electron: '鲸鱼娘-999' },
    focus: undefined,
    boundSessions: {},
  },
  affection: {
    electron: {
      affection: 72, total: 30, byPart: { head: 20, body: 10 }, lastTouchAt: 1793532000000,
      recent: [{ part: 'head', at: 1 }],
      adjustments: [{ delta: 2, reason: 'test', at: 1 }],
      quota: { date: new Date().toDateString(), count: 1, sum: 2 },
      bond: { value: 1, days: 1, lastCountedDate: new Date().toDateString() },
      lastDecayAt: undefined,
      mood: 'content',
    },
  },
  windowPosition: { x: 100, y: 100 },
  pets: [{ id: 'electron', online: true, pid: 1, state: 'idle', animation: '待机', name: '鲸鱼娘-999' }],
  history: [{ tool: 'pet_say', petId: 'electron', ok: true, at: Date.now() }],
  touchTotals: { electron: { total: 6, byPart: { head: 4, body: 2 } } },
}

// Mini hooks — enough for one synchronous render pass.
let hooks = [], callbacks = [], hookIdx = 0
const React = {
  createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
  useState: (init) => {
    const i = hookIdx++
    if (hooks[i] === undefined) hooks[i] = typeof init === 'function' ? init() : init
    return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v }]
  },
  useCallback: (fn) => {
    const i = hookIdx++
    if (callbacks[i] === undefined) callbacks[i] = fn
    return callbacks[i]
  },
  useEffect: () => {},
}

let factory
const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { factory = def.factory } }, confirm: () => true },
  require: (name) => { if (name === 'react') return React; throw new Error('unexpected require: ' + name) },
  fetch: () => Promise.resolve({ json: () => Promise.resolve(SAMPLE) }),
  console, JSON, Math, Date, Object, String, Number, Promise, navigator: { language: 'zh' },
}
sandbox.window.fetch = sandbox.fetch
vm.createContext(sandbox)

try {
  vm.runInContext(code, sandbox, { filename: 'pet-settings.js' })
} catch (e) {
  console.error('LOAD-THROW:', e.message)
  process.exit(1)
}
if (typeof factory !== 'function') {
  console.error('factory not captured — __ModuleLoader__ contract changed')
  process.exit(1)
}

const slots = { registered: null }
slots.inject = (name, fn) => fn()
slots.register = (def, comp) => { slots.registered = comp; return def }
factory(sandbox.require).apply({ slots })

hookIdx = 0
hooks = [SAMPLE] // 第一个 useState(null) 的 data = SAMPLE
callbacks = []
try {
  const el = slots.registered({ close: () => {} })
  const rendered = typeof el.type === 'function' ? el.type({ close: () => {} }) : el
  console.log('RENDER OK — top-level children:', rendered && rendered.children ? rendered.children.length : 'n/a')
} catch (e) {
  console.error('RENDER-THROW:', e.constructor.name + ':', e.message)
  if (e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'))
  process.exit(1)
}
