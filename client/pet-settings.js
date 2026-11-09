/* pet-settings — browser half (hand-written __ModuleLoader__ bundle, no build
 * step, dsh-qqbot precedent). Registers a "桌宠" section into the desktop
 * settings sidebar via the slot system; data goes through the host half's
 * same-origin routes (/api/pet-settings/*). The client startup audit is
 * fatal on throw — apply degrades section by section, never failing the page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agentic-pet',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback
    var useRef = React.useRef

    var READ = '/api/pet-settings/read'
    var UPDATE = '/api/pet-settings/update'
    var RUNTIME = '/api/pet-settings/electron-runtime'

    // Theme-neutral: inherit foreground, translucent borders — readable on
    // both the host's dark and light themes without a design system.
    var card = { border: '1px solid rgba(127,127,127,.35)', borderRadius: 10, padding: '10px 14px 12px', margin: '10px 0' }
    var cardTitle = { fontWeight: 700, fontSize: 14, margin: '2px 0 8px' }
    var row = { display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0', fontSize: 13, flexWrap: 'wrap' }
    var muted = { color: 'rgba(127,127,127,.9)', fontSize: 12 }
    var inputStyle = { width: 64, padding: '2px 6px', border: '1px solid rgba(127,127,127,.4)', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' }
    var eyeButton = { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 2, display: 'inline-flex', alignItems: 'center', opacity: .65 }
    var runtimeCard = { border: '1px solid rgba(124,108,240,.45)', borderRadius: 10, padding: '10px 14px 12px', margin: '10px 0', background: 'rgba(124,108,240,.06)' }
    var runtimeTrack = { position: 'relative', height: 4, borderRadius: 2, background: 'rgba(127,127,127,.18)', overflow: 'hidden', marginTop: 8 }
    var runtimeBar = { position: 'absolute', top: 0, left: '-35%', width: '35%', height: '100%', borderRadius: 2, background: 'rgba(124,108,240,.85)', animation: 'petRuntimeSlide 1.15s ease-in-out infinite' }
    function btnStyle(variant) {
      var base = { border: '1px solid rgba(127,127,127,.4)', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontSize: 12, padding: '3px 12px', background: 'transparent', color: 'inherit' }
      if (variant === 'primary') return Object.assign(base, { fontWeight: 700, borderColor: 'rgba(124,108,240,.6)' })
      if (variant === 'danger') return Object.assign(base, { color: '#ff7369', borderColor: 'rgba(229,72,77,.5)' })
      return base
    }
    function SButton(props) {
      return h('button', { style: btnStyle(props.variant), disabled: props.disabled, onClick: props.onClick }, props.children)
    }
    function Toggle(props) {
      return h('button', {
        onClick: props.onChange,
        style: {
          cursor: 'pointer', font: 'inherit', fontSize: 12, padding: '2px 12px', borderRadius: 12,
          border: '1px solid ' + (props.value ? 'rgba(31,158,79,.7)' : 'rgba(127,127,127,.4)'),
          color: props.value ? '#3ddc84' : 'inherit',
          background: props.value ? 'rgba(31,158,79,.12)' : 'transparent',
        },
      }, props.value ? '已开启' : '已关闭')
    }
    function EyeIcon(props) {
      return h('svg', {
        width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', { d: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z' }),
        h('circle', { cx: 12, cy: 12, r: 3 }),
        props.off ? h('path', { d: 'M3 3l18 18' }) : null)
    }
    function Section(props) {
      return h('div', { style: card }, h('div', { style: cardTitle }, props.title), props.children)
    }
    function Hint(props) {
      return h('div', { style: Object.assign({ margin: '6px 0 2px' }, muted) }, props.children)
    }
    // First-install visibility: the settings page is open while the runtime is
    // still downloading, so the only honest progress is phase + elapsed time.
    function RuntimeBanner(props) {
      var r = props.runtime
      if (!r || r.state === 'ready') return null
      var active = r.state === 'downloading' || r.state === 'preparing'
      var elapsed = r.startedAt ? Math.max(0, Math.floor((Date.now() - r.startedAt) / 1000)) : 0
      var sourceLabel = r.source === 'npmmirror' ? '镜像源 npmmirror' : r.source === 'github' ? 'GitHub' : r.source === 'explicit' ? '自定义镜像' : ''
      var text
      if (r.state === 'busy') text = '另一个 DSH 窗口正在准备 Electron 运行时，完成后宠物会自动出现。'
      else if (r.state === 'unavailable') text = '插件缺少 electron 安装器，无法自动下载。请重新安装 dsh-agentic-pet。'
      else if (r.state === 'failed') text = '运行时安装失败：' + String(r.error || '未知错误').slice(0, 160) + '，后台会自动重试。'
      else text = '首次安装正在准备 Electron 运行时（约 158 MB），完成后宠物会自动出现。' + (elapsed > 0 ? ' 已等待 ' + elapsed + ' 秒。' : '')
      return h('div', { style: runtimeCard },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 700, fontSize: 13 } }, 'Electron 运行时'),
          r.attempt ? h('span', { style: muted }, '第 ' + r.attempt + ' 次尝试') : null,
          sourceLabel ? h('span', { style: muted }, sourceLabel) : null),
        h('div', { style: Object.assign({ margin: '4px 0 0' }, muted) }, text),
        active ? h('div', { style: runtimeTrack }, h('div', { style: runtimeBar })) : null,
        active ? h('style', null, '@keyframes petRuntimeSlide { 0% { left: -35% } 100% { left: 100% } }') : null)
    }

    function PetSettingsPage() {
      var state = useState(null)
      var data = state[0]
      var setData = state[1]
      var msgState = useState('')
      var msg = msgState[0]
      var setMsg = msgState[1]
      var busyState = useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      // 语音朗读的声音选择器：null = 收起；展开后 {loading, error, items, search}。
      var voiceState = useState(null)
      var voice = voiceState[0]
      var setVoice = voiceState[1]
      var runtimeState = useState(null)
      var runtime = runtimeState[0]
      var setRuntime = runtimeState[1]
      var bindingState = useState(null)
      var bindingData = bindingState[0]
      var setBindingData = bindingState[1]
      var bindingBusyState = useState(false)
      var bindingBusy = bindingBusyState[0]
      var setBindingBusy = bindingBusyState[1]
      var warnState = useState('')
      var warnings = warnState[0]
      var setWarnings = warnState[1]
      var bindingMsgState = useState('')
      var bindingMsg = bindingMsgState[0]
      var setBindingMsg = bindingMsgState[1]
      var bindingDraftState = useState(null)
      var bindingDraft = bindingDraftState[0]
      var setBindingDraft = bindingDraftState[1]
      var bindingAttemptState = useState(null)
      var bindingAttempt = bindingAttemptState[0]
      var setBindingAttempt = bindingAttemptState[1]
      var previewAudioRef = useRef(null)
      var keyInputRef = useRef(null)
      // 好感度默认盖住：密码式的星星遮罩，眼睛按钮按宠物单独揭示。
      var affectionRevealState = useState({})
      var affectionReveal = affectionRevealState[0]
      var setAffectionReveal = affectionRevealState[1]
      // 召唤卡（POST /api/pet-settings/summon）：宠物进程不在时显示，上线即消失。
      var summoningState = useState(false)
      var summoning = summoningState[0]
      var setSummoning = summoningState[1]
      var summonMsgState = useState('')
      var summonMsg = summonMsgState[0]
      var setSummonMsg = summonMsgState[1]
      // 人设卡片（data.persona 由 host 提供；旧 host 无此块时整卡隐藏）：
      // 草稿 null = 跟随 host 生效值；保存成功才交还，失败保留草稿供重试。
      var personaDraftState = useState(null)
      var personaDraft = personaDraftState[0]
      var setPersonaDraft = personaDraftState[1]

      var refresh = useCallback(function () {
        fetch(READ, { credentials: 'same-origin' })
          .then(function (r) { return r.json() })
          .then(function (d) { setData(d) })
          .catch(function (e) { setMsg('读取失败: ' + (e && e.message)) })
      }, [])
      useEffect(function () { refresh() }, [refresh])
      // While the first install downloads Electron, poll the runtime status
      // until it is ready. A ready/absent status ends the loop; a failed one
      // keeps polling because the host retries on its own.
      useEffect(function () {
        var alive = true
        var timer = null
        var emptyTries = 0
        function load() {
          fetch(RUNTIME, { credentials: 'same-origin' })
            .then(function (r) { return r.json() })
            .then(function (d) {
              if (!alive) return
              var next = (d && d.runtime) || null
              setRuntime(next)
              if (next && (next.state === 'downloading' || next.state === 'preparing' || next.state === 'busy' || next.state === 'failed')) {
                emptyTries = 0
                timer = setTimeout(load, 2000)
              } else if (!next && emptyTries < 5) {
                // The first activation may still be writing its status when the
                // page mounts; give it a few seconds instead of hiding forever.
                emptyTries += 1
                timer = setTimeout(load, 3000)
              }
            })
            .catch(function () { if (alive) timer = setTimeout(load, 5000) })
        }
        load()
        return function () { alive = false; if (timer) clearTimeout(timer) }
      }, [])

      var loadBinding = useCallback(function () {
        fetch('/api/pet-settings/binding-status', { credentials: 'same-origin' })
          .then(function (r) { return r.json() })
          .then(function (d) { setBindingData((d && d.status) || null) })
          .catch(function () { /* binding status is optional */ })
      }, [])
      useEffect(function () { loadBinding() }, [loadBinding])

      var act = useCallback(function (path, body, doneMessage) {
        // Binding edits own their message under the binding row; the global
        // banner at the top stays for the rest of the settings page.
        var isBinding = !!(body && body.patch && body.patch.innerVoice && body.patch.innerVoice.boundSessions)
        setBusy(true)
        setMsg('')
        fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (isBinding) {
              if (d && d.error) setBindingMsg('失败: ' + d.error)
              else {
                setBindingMsg(doneMessage || '绑定已保存')
                setBindingAttempt(null)
              }
            } else if (d && d.error) setMsg('失败: ' + d.error)
            else setMsg(doneMessage || '完成')
            setWarnings(d && d.warnings && d.warnings.length ? d.warnings.join('；') : '')
            refresh()
            loadBinding()
          })
          .catch(function (e) {
            if (isBinding) setBindingMsg('请求失败: ' + (e && e.message))
            else setMsg('请求失败: ' + (e && e.message))
          })
          .finally(function () { setBusy(false) })
      }, [refresh, loadBinding])

      var settings = (data && data.settings) || {}
      var pro = settings.proactivity || {}
      var iv = settings.innerVoice || {}
      var rhythm = settings.rhythm || {}
      var quiet = rhythm.quiet || {}
      var quietOn = !!rhythm.quiet
      var journal = settings.journal || {}
      var journalOn = journal.enabled !== false
      var presenceSummary = settings.presenceSummary || {}
      var presenceOn = presenceSummary.enabled === true
      var tts = settings.tts || {}
      var debug = settings.debug || {}
      var savedBinding = String((iv.boundSessions && iv.boundSessions.electron) || '')
      // 人设（data.persona = {value, default, maxLength}，host 从 src/persona.ts
      // 取默认与上限）：生效文本 = 草稿优先，否则 host 值；字数按 Unicode 码点数，
      // 和宿主的截断口径一致。
      var personaInfo = (data && data.persona) || null
      var personaValue = personaInfo ? String(personaInfo.value || '') : ''
      var personaDefault = personaInfo ? String(personaInfo.default || '') : ''
      var personaMax = personaInfo ? (Number(personaInfo.maxLength) || 8000) : 8000
      var personaText = personaDraft !== null ? personaDraft : personaValue
      var personaCount = Array.from(personaText).length
      var affection = (data && data.affection) || {}
      var pets = (data && data.pets) || []
      if (!(pets && pets.length) && data && data.pet) pets = [Object.assign({ id: 'electron' }, data.pet)]
      // 在线判断与 GET /read 的 pets[].online 同源；reason → 提示文案映射。
      var anyOnline = (pets || []).some(function (p) { return p.online })
      var SUMMON_HINTS = {
        'already-running': '宠物已经在身边了',
        'no-webserver': '宿主 web 服务未就绪，稍后再试',
        'spawn-disabled': 'DSH_PET_NO_SPAWN=1 已禁用拉起（环境变量），解除后重启桌面端',
        'carrier-missing': '插件安装不完整（carrier/ 缺失）——重装插件',
        'electron-unavailable': 'electron 未安装且无法自动安装——检查插件目录的 electron 依赖',
        'unsupported': '当前插件版本不支持召唤，更新插件',
      }
      // 宠物不在身边时每 4s 轮询 /read：召唤生效（或桌面端自启）后卡片立即
      // 消失。上线瞬间清掉按钮态与提示，避免下次打开卡片读到陈旧文案。
      useEffect(function () {
        if (anyOnline) {
          setSummoning(false)
          setSummonMsg('')
          return undefined
        }
        var timer = setInterval(function () { refresh() }, 4000)
        return function () { clearInterval(timer) }
      }, [anyOnline, refresh])
      var moodOf = function (a) { return a >= 80 ? '开心' : a >= 40 ? '满足' : '平静' }
      // 显示名：用户自定义（settings.names）优先，缺省回落内置名；
      // 宠物区改名后好感度区自动跟随（同一状态、同一渲染趟）。
      var defaultName = function (id) { return id === 'electron' ? '鲸鱼娘' : id === 'pure' ? 'Pure 宠物' : id }
      var BOND_TIERS = [[0, "陌生"], [5, "认识"], [15, "熟了"], [40, "亲近"], [90, "离不开"], [180, "只有你"]]
      var bondTier = function (days) {
        var name = "陌生"
        BOND_TIERS.forEach(function (t) { if (days >= t[0]) name = t[1] })
        return name
      }
      var petName = function (id) {
        var custom = settings.names && settings.names[id]
        return custom ? String(custom) : defaultName(id)
      }
      // 提交一次改名（失焦/回车调用）：与当前生效名比较，无变化零开销。
      // 清空或改回内置名 = 发空串，宿主据此删掉 pet-name.json、回落到默认名。
      // 早先这里删键后发的是 {}，而宿主是按 patch 里的键逐个写的——空对象等于
      // 零次写入，"改回默认名"因此是一次静默的空操作。
      var commitName = function (id, raw) {
        var v = (raw || '').trim()
        var next = v === '' || v === defaultName(id) ? '' : v
        // 比较"生效名"而不是 patch：本来就用默认名时，清空/再输默认名是一次
        // 无变化的编辑，不该发请求（否则每次点进输入框失焦都会 POST 一遍）。
        if ((next === '' ? defaultName(id) : next) === petName(id)) return
        var patch = {}
        patch[id] = next
        update({ names: patch })
      }

      function update(patch, doneMessage) { act(UPDATE, { patch: patch }, doneMessage) }

      // Binding is commit-on-blur/Enter, like the name field: a per-keystroke
      // save would persist a partial session id before validation runs.
      function commitBinding() {
        var v = (bindingDraft !== null ? bindingDraft : savedBinding).trim()
        if (v === savedBinding) {
          setBindingDraft(null)
          setBindingAttempt(null)
          setBindingMsg('')
          return
        }
        // A blur repeats on every focus loss; do not resend the exact value
        // that already failed (the visible error would flash on each retry).
        if (v === bindingAttempt) return
        setBindingAttempt(v)
        var next = Object.assign({}, iv.boundSessions || {})
        if (v !== '') next.electron = v
        else delete next.electron
        update({ innerVoice: { boundSessions: next } }, '绑定已保存')
      }

      // ensure + attach + status, no visible prompt: the one-click way to
      // finish the "binding is saved but not loaded" step.
      function testBinding() {
        if (bindingDraft !== null && bindingDraft.trim() !== savedBinding) {
          setBindingMsg('请先保存绑定：点一下输入框外面或按回车')
          return
        }
        setBindingBusy(true)
        setMsg('')
        setBindingMsg('')
        fetch('/api/pet-settings/binding-test', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ petId: 'electron' }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.error) { setBindingMsg('失败: ' + d.error); return }
            if (d && d.ok) {
              var notes = []
              if (d.binding && d.binding.presetWarning) notes.push('当前模式不是宠物模式，不会有气泡回应')
              if (d.binding && d.binding.attach && d.binding.attach.errorCode === 'cwd-mismatch') {
                notes.push('会话在另一个项目，不会归到 whale598 项目下')
              }
              setBindingMsg(notes.length ? '绑定可用；' + notes.join('；') : '绑定测试通过')
            } else {
              var b = d && d.binding
              var reason = (b && (b.lastError || (b.attach && b.attach.errorCode))) || '未知原因'
              setBindingMsg('绑定测试未通过：' + reason)
            }
            if (d && d.binding) {
              setBindingData({ updatedAt: Date.now(), pets: { electron: d.binding }, failures: (bindingData && bindingData.failures) || [] })
            }
          })
          .catch(function (e) { setBindingMsg('请求失败: ' + (e && e.message)) })
          .finally(function () { setBindingBusy(false); loadBinding() })
      }

      // ── 语音朗读（BreezeBlue TTS）的取声/试听 ──
      // 列表走宿主代理路由（浏览器直连 api.breeze.blue 会被 CORS 拦下，
      // key 也不该进页面日志）；试听直接播 preview_url，不经过本插件。
      var loadVoices = function (search) {
        setVoice({ loading: true, error: '', items: (voice && voice.items) || [], search: search || '' })
        fetch('/api/pet-settings/tts/voices?search=' + encodeURIComponent(search || ''), { credentials: 'same-origin' })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.error) setVoice({ loading: false, error: d.error, items: [], search: search || '' })
            else setVoice({ loading: false, error: '', items: (d && d.voices) || [], search: search || '' })
          })
          .catch(function (e) {
            setVoice({ loading: false, error: '请求失败: ' + ((e && e.message) || e), items: [], search: search || '' })
          })
      }
      var playPreview = function (url) {
        if (!url) return
        try {
          if (previewAudioRef.current) previewAudioRef.current.pause()
          var audio = new Audio(url)
          previewAudioRef.current = audio
          audio.play().catch(function () { /* 试听失败不打断配置 */ })
        } catch (e) { /* ignore */ }
      }
      // 取声音列表前先把 key 输入框里未提交的值落盘（输入框是失焦提交，
      // “输完 key 立刻点选择声音”时 blur 的 POST 会和列表 GET 赛跑——
      // 代理读到旧文件，401。这里等提交完成再查。）
      var flushKeyThen = function (done) {
        var el = keyInputRef.current
        var current = el ? String(el.value || '').trim() : ''
        if (current === '' || current === (tts.apiKey || '')) { done(); return }
        fetch(UPDATE, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch: { tts: { apiKey: current } } }),
        }).then(function () { done() }, function () { done() })
      }

      // 人设保存走独立的 fetch（不走 update）：保存成功才把文本框交还 host
      // 生效值（setPersonaDraft(null)），失败时草稿留在框里供重试——长文本
      // 不该因为一次请求失败就丢。text 参数显式传入，避免闭包读到旧渲染趟的
      // personaText。
      var savePersona = function (text, doneMessage) {
        setBusy(true)
        setMsg('')
        fetch(UPDATE, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch: { persona: String(text || '').trim() } }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.error) setMsg('失败: ' + d.error)
            else { setPersonaDraft(null); setMsg(doneMessage) }
            setWarnings(d && d.warnings && d.warnings.length ? d.warnings.join('；') : '')
            refresh()
          })
          .catch(function (e) { setMsg('请求失败: ' + (e && e.message)) })
          .finally(function () { setBusy(false) })
      }

      // 召唤：独立 fetch（不走 act 的全局横幅，提示留在卡片里）。POST 成功后
      // 交给上面的 4s 轮询把卡片翻掉；45s 仍未上线给出提示——首次召唤可能
      // 在下载 electron（页面上方的安装进度条会显示），装完再点一次即可。
      var summonNow = function () {
        if (summoning) return
        setSummoning(true)
        setSummonMsg('')
        fetch('/api/pet-settings/summon', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok === false) {
              setSummoning(false)
              setSummonMsg(SUMMON_HINTS[d.reason] || ('失败: ' + String(d.reason || '未知原因')))
              return
            }
            setTimeout(function () {
              setSummoning(false)
              setSummonMsg('还没就绪——首次召唤可能在下载 electron（看上方安装进度），装完再点一次召唤')
            }, 45000)
          })
          .catch(function (e) {
            setSummoning(false)
            setSummonMsg('请求失败: ' + ((e && e.message) || e))
          })
      }

      return h('div', { style: { width: '100%', maxWidth: 720 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 10px' } },
          h('span', { style: { fontWeight: 700, fontSize: 15 } }, '桌宠'),
          h('span', { style: muted }, '驱动插件 dsh-agentic-pet'),
          h('span', { style: { flex: 1 } }),
          h(SButton, { onClick: refresh, disabled: busy }, '刷新')),
        msg ? h('div', { style: { fontSize: 12, margin: '0 0 6px', color: msg.indexOf('失败') >= 0 ? '#ff7369' : 'inherit' } }, msg) : null,
        h(RuntimeBanner, { runtime: runtime }),

        // ── 召唤卡：进程未运行时显示，任一宠物上线即消失 ──
        !anyOnline
          ? h('div', { style: { border: '1px solid rgba(255,115,105,.45)', background: 'rgba(255,115,105,.08)', borderRadius: 10, padding: '10px 12px', margin: '0 0 10px' } },
            h('div', { style: row },
              h('span', null, '宠物不在身边 · 进程未运行'),
              h('span', { style: { flex: 1 } }),
              h(SButton, { variant: 'primary', disabled: summoning, onClick: summonNow }, summoning ? '召唤中…' : '召唤宠物')),
            summonMsg ? h('div', { style: { fontSize: 12, marginTop: 6, color: '#ff7369' } }, summonMsg) : null)
          : null,

        // ── 状态（每宠一行） ──
        h(Section, { title: '宠物' },
          pets.length
            ? pets.map(function (p) {
              return h('div', { key: p.id, style: row },
                // Uncontrolled + commit-on-blur/Enter: typing is LOCAL until the
                // edit completes — a per-keystroke update would fire a [改名]
                // turn per character.清空 + 失焦 = 恢复默认名。
                // key 钉在当前生效名上：设置异步到达或改名成功后重挂，输入框
                // 才不会停在首帧的默认值上（曾显示"鲸鱼娘"而实际存着自定义名）。
                h('input', { key: 'name-' + petName(p.id), style: Object.assign({}, inputStyle, { width: 120, fontWeight: 700 }), defaultValue: petName(p.id), title: '改名后点击空白处或回车生效；清空恢复默认',
                  onBlur: function (e) { commitName(p.id, e.target.value) },
                  onKeyDown: function (e) { if (e.key === 'Enter') { commitName(p.id, e.target.value); e.target.blur() } } }),
                p.online
                  ? h('span', null, '在线',
                    h('span', { style: muted }, 'pid ' + String(p.pid ?? '?')),
                    p.state ? h('span', { style: muted }, '状态: ' + String(p.state)) : null,
                    p.animation ? h('span', { style: muted }, String(p.animation)) : null)
                  : h('span', { style: muted }, '离线'))
            })
            : h('div', null, '没有在线的宠物', h(Hint, null, '启动 DeepSeek Harness 后鲸鱼娘会自动上桌；Pure 宠物需自行启动。'))),

        // ── 人设（可编辑角色卡；身体规则是宿主契约，不在此编辑） ──
        personaInfo ? h(Section, { title: h('span', null, '人设 ',
          h('span', { style: { fontSize: 11, fontWeight: 400, color: 'rgba(127,127,127,.9)' } }, '改动会击穿会话前缀缓存')) },
          h('textarea', {
            style: Object.assign({}, inputStyle, { width: '100%', minHeight: 120, resize: 'vertical', lineHeight: 1.5, padding: '6px 8px' }),
            value: personaText,
            placeholder: personaDefault,
            onChange: function (e) { setPersonaDraft(e.target.value) },
            'aria-label': '人设文本',
          }),
          h('div', { style: row },
            h(SButton, { variant: 'primary', disabled: busy || personaDraft === null, onClick: function () { savePersona(personaText, '人设已保存') } }, '保存人设'),
            h(SButton, { disabled: busy, onClick: function () { setPersonaDraft(''); savePersona('', '已恢复默认人设') } }, '恢复默认'),
            h('span', { style: personaCount > personaMax ? { color: '#ff7369', fontSize: 12 } : muted },
              String(personaCount) + ' / ' + String(personaMax) + ' 字')),
          h(Hint, null, '自定义宠物的角色设定（名字、性格、口吻）。身体规则（气泡、动作、本子的用法）是固定契约，不在这里编辑。'),
          h(Hint, null, '清空并保存即恢复默认人设；改动下一次对话就生效，无需重启。'),
          h(Hint, null, '改人设不会改写本子里已有的记忆——换了设定，宠物还得慢慢适应自己想起来的旧事。')) : null,

        // ── 好感度（每宠独立账本） ──
        h(Section, { title: h('span', null, '好感度 ',
          h('span', { style: { fontSize: 11, fontWeight: 400, color: 'rgba(127,127,127,.9)' } }, '数值全由模型自己判断增减——触摸只是事实，不会自动加分')) },
          (function () {
            var bookIds = affection && typeof affection === 'object' ? Object.keys(affection) : []
            var ids = []
            pets.forEach(function (p) { if (ids.indexOf(p.id) < 0) ids.push(p.id) })
            bookIds.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id) })
            if (!ids.length) return h('div', { style: muted }, '还没有互动记录')
            return ids.map(function (id) {
              var book = (affection && affection[id]) || { affection: 0, total: 0 }
              var name = petName(id)
              var revealed = !!affectionReveal[id]
              // 羁绊两个字段分开显示（与账本的双写者设计对齐）：value 是模型
              // 的判断分（tier 由它推导），days 是一起过过的天数（系统事实）。
              // 此前 value ?? days 混取一格再标「天」——模型的判断分被读成
              // 相处天数，真正的天数反而看不见。
              var bondValue = book.bond ? (book.bond.value ?? 0) : 0
              var bondDays = book.bond ? (book.bond.days ?? 0) : 0
              return h('div', { key: id, style: row },
                h('span', { style: { fontWeight: 700 } }, name),
                h('span', { style: revealed ? { fontSize: 18, fontWeight: 700 } : { fontSize: 16, letterSpacing: 4, color: 'rgba(127,127,127,.95)' } },
                  revealed ? String(book.affection ?? 0) : '★★★★★★'),
                revealed ? h('span', { style: muted }, '/ 100 · ' + moodOf(book.affection ?? 0) + ' · 羁绊：' + bondTier(bondValue) + '（羁绊 ' + String(bondValue) + ' · 一起过 ' + String(bondDays) + ' 天）') : null,
                revealed ? h('span', { style: muted }, '累计触摸 ' + String(book.total ?? 0) + ' 次') : null,
                h('button', {
                  type: 'button',
                  title: revealed ? '隐藏好感度' : '显示好感度',
                  'aria-label': revealed ? '隐藏好感度' : '显示好感度',
                  'aria-pressed': revealed,
                  onClick: function () {
                    setAffectionReveal(function (prev) {
                      var next = Object.assign({}, prev)
                      next[id] = !prev[id]
                      return next
                    })
                  },
                  style: eyeButton,
                }, h(EyeIcon, { off: revealed })))
            })
          })(),
          h('div', { style: row }, h(SButton, { variant: 'danger', disabled: busy, onClick: function () {
            if (window.confirm('清空所有好感度账本？此操作不可撤销。')) act('/api/pet-settings/reset-affection', {}, '账本已清空')
          } }, '重置账本'),
          h('span', { style: muted }, '每 10 次触摸该宠物会自主庆祝一次'))),



        // ── 内心戏（宠物自主说话）──
        h(Section, { title: h('span', null, '自主表达 ', h('span', { style: { fontSize: 11, fontWeight: 400, color: 'rgba(127,127,127,.9)' } }, '模型驱动')) },
          h('div', { style: row }, '宠物自主醒来', h(Toggle, { value: iv.enabled !== false, onChange: function () {
            update({ innerVoice: { enabled: !(iv.enabled !== false) } })
          } })),
          h('div', { style: row },
            '世界时钟间隔',
            h('input', { style: inputStyle, value: String(iv.wakeIntervalMinutes ?? 2), onChange: function (e) {
              var v = parseInt(e.target.value, 10)
              if (Number.isFinite(v)) update({ innerVoice: { wakeIntervalMinutes: v } })
            } }),
            '分钟'),
          h('div', { style: row },
            '世界时钟唤醒概率',
            h('input', { style: inputStyle, value: String(Math.round(((typeof iv.speakProbability === 'number' ? iv.speakProbability : 0.5)) * 100)), onChange: function (e) {
              var v = parseFloat(e.target.value)
              if (Number.isFinite(v)) update({ innerVoice: { speakProbability: Math.min(100, Math.max(0, v)) / 100 } })
            } }),
            '%'),
          h('div', { style: row },
            '被摸回应概率',
            h('input', { style: inputStyle, value: String(Math.round(((typeof iv.touchReplyProbability === 'number' ? iv.touchReplyProbability : 0.3)) * 100)), onChange: function (e) {
              var v = parseFloat(e.target.value)
              if (Number.isFinite(v)) update({ innerVoice: { touchReplyProbability: Math.min(100, Math.max(0, v)) / 100 } })
            } }),
            '%'),
          h('div', { style: row },
            '两次被摸回应至少间隔',
            h('input', { style: inputStyle, value: String(iv.touchReplyCooldownSeconds ?? Math.round((iv.touchReplyCooldownMinutes ?? 5) * 60)), onChange: function (e) {
              var v = parseInt(e.target.value, 10)
              if (Number.isFinite(v) && v >= 0) update({ innerVoice: { touchReplyCooldownSeconds: Math.min(600, v) } })
            } }),
            '秒（0 = 不限）'),
          h('div', { style: row }, '自主唤醒遇用户忙',
            (function () {
              var seg = function (active, side) {
                return { padding: '4px 12px', fontSize: 12, cursor: 'pointer',
                  border: '1px solid ' + (active ? '#22c55e' : '#c9d4e0'),
                  background: active ? '#22c55e' : '#f4f7fa',
                  color: active ? '#ffffff' : '#1c2733',
                  borderRadius: side === 'left' ? '4px 0 0 4px' : '0 4px 4px 0',
                  marginLeft: side === 'right' ? -1 : 0 }
              }
              var policy = iv.selfWakeBusyPolicy === 'defer' ? 'defer' : 'fire'
              return h('div', { style: { display: 'inline-flex' } },
                h('button', { style: seg(policy === 'fire', 'left'), onClick: function () {
                  if (policy !== 'fire') update({ innerVoice: { selfWakeBusyPolicy: 'fire' } })
                } }, '到点必醒'),
                h('button', { style: seg(policy === 'defer', 'right'), onClick: function () {
                  if (policy !== 'defer') update({ innerVoice: { selfWakeBusyPolicy: 'defer' } })
                } }, '忙时顺延'))
            })()),
          h('div', { style: row }, '宠物间消息投递',
            (function () {
              var seg = function (active, side) {
                return { padding: '4px 12px', fontSize: 12, cursor: 'pointer',
                  border: '1px solid ' + (active ? '#22c55e' : '#c9d4e0'),
                  background: active ? '#22c55e' : '#f4f7fa',
                  color: active ? '#ffffff' : '#1c2733',
                  borderRadius: side === 'left' ? '4px 0 0 4px' : '0 4px 4px 0',
                  marginLeft: side === 'right' ? -1 : 0 }
              }
              var mode = iv.petToPetDelivery === 'immediate' ? 'immediate' : 'queue'
              return h('div', { style: { display: 'inline-flex' } },
                h('button', { style: seg(mode === 'queue', 'left'), onClick: function () {
                  if (mode !== 'queue') update({ innerVoice: { petToPetDelivery: 'queue' } })
                } }, '排队等她醒'),
                h('button', { style: seg(mode === 'immediate', 'right'), onClick: function () {
                  if (mode !== 'immediate') update({ innerVoice: { petToPetDelivery: 'immediate' } })
                } }, '立即叫醒'))
            })()),
          h('div', { style: row }, '会话模式',
            (function () {
              var seg = function (active, side) {
                return { padding: '4px 12px', fontSize: 12, cursor: 'pointer',
                  border: '1px solid ' + (active ? '#22c55e' : '#c9d4e0'),
                  background: active ? '#22c55e' : '#f4f7fa',
                  color: active ? '#ffffff' : '#1c2733',
                  borderRadius: side === 'left' ? '4px 0 0 4px' : '0 4px 4px 0',
                  marginLeft: side === 'right' ? -1 : 0 }
              }
              return h('div', { style: { display: 'inline-flex' } },
                h('button', { style: seg(iv.preset === 'whale598', 'left'), onClick: function () {
                  if (iv.preset !== 'whale598') update({ innerVoice: { preset: 'whale598' } })
                } }, '精简（仅表达）'),
                h('button', { style: seg(iv.preset === 'whale598-standard', 'right'), onClick: function () {
                  if (iv.preset !== 'whale598-standard') update({ innerVoice: { preset: 'whale598-standard' } })
                } }, '普通（含工作工具）'))
            })()),
          h('div', { style: row }, '指定会话（高级）',
            h('input', {
              style: Object.assign({}, inputStyle, { width: 340, flex: '1 1 260px' }),
              value: bindingDraft !== null ? bindingDraft : savedBinding,
              placeholder: '会话 id，留空 = 自动管理',
              onChange: function (e) { setBindingDraft(e.target.value) },
              onBlur: commitBinding,
              onKeyDown: function (e) { if (e.key === 'Enter') commitBinding() },
            }),
            h(SButton, {
              onClick: testBinding,
              disabled: bindingBusy || (bindingDraft !== null && bindingDraft.trim() !== savedBinding),
            }, bindingBusy ? '测试中…' : '测试')),
          (function () {
            var petBinding = bindingData && bindingData.pets && bindingData.pets.electron
            if (!petBinding) return null
            var bad = !petBinding.usable
            var color = bad ? '#ff7369' : (petBinding.presetWarning || !petBinding.armed ? '#f0b429' : '#3ddc84')
            var parts = []
            parts.push('配置会话 ' + (petBinding.configuredSessionId || '自动管理'))
            parts.push('生效会话 ' + (petBinding.effectiveSessionId || '无'))
            parts.push(petBinding.armed ? '已装载' : '未装载')
            if (petBinding.preset) parts.push('当前模式 ' + petBinding.preset)
            if (petBinding.cwd) parts.push(petBinding.cwd)
            if (petBinding.attach) {
              parts.push(petBinding.attach.ok
                ? 'attach ok'
                : (petBinding.attach.errorCode === 'cwd-mismatch'
                  ? '另一项目（未归组）'
                  : 'attach ' + petBinding.attach.errorCode))
            }
            if (petBinding.presetWarning) parts.push('不是宠物模式，没有气泡')
            if (petBinding.fallback) parts.push('已回退到内部会话')
            if (petBinding.staleOwners && petBinding.staleOwners.length) parts.push('旧 owner ' + petBinding.staleOwners.join(','))
            return h('div', { style: { color: color, fontSize: 12, margin: '2px 0 4px', wordBreak: 'break-all' } }, parts.join(' · '))
          })(),
          warnings ? h('div', { style: { color: '#f0b429', fontSize: 12, margin: '2px 0 4px' } }, '提示：' + warnings) : null,
          bindingMsg ? h('div', {
            style: {
              fontSize: 12,
              margin: '2px 0 4px',
              color: /失败|未通过/.test(bindingMsg)
                ? '#ff7369'
                : (/通过|可用|已保存/.test(bindingMsg) ? '#3ddc84' : 'rgba(127,127,127,.9)'),
            },
          }, bindingMsg) : null,
          h(Hint, null, '指定会话会校验当前模式：标准模式（没有 pet_say/pet_do）会被拒绝，请使用「精简（仅表达）」或「普通（含工作工具）」的宠物模式会话。会话在别的项目也没关系，唤醒和气泡照常，只是不会归到 whale598 项目下。保存后状态显示「已装载/未装载/失败」，点「测试」可立即验证；清空后回落到她之前的会话。宠物在自己专属的会话里醒来，用气泡和动作自主表达；那条「鲸鱼娘的内心戏」会话可在会话列表查看，也可以直接在那里和它聊天。醒来有两个来源：世界时钟是环境节拍，按上面的间隔和唤醒概率随机轻拍她，用户忙于会话或宠物表达未完成时不会打扰；自主唤醒是她用 pet_schedule_wake 给自己定的闹钟，到点带着当初的打算醒来，不受这个概率影响（上面的「自主唤醒遇用户忙」决定你正忙时她是否照醒，默认到点必醒）。会话模式切换只对新建会话生效：归档旧会话后，她会在下次对话时自动换代重建（旧会话记忆不迁移）。')),

        h(Section, { title: '静默时段' },
          h('div', { style: row }, '启用静默', h(Toggle, { value: quietOn, onChange: function () {
            if (quietOn) update({ rhythm: { quiet: null } })
            else update({ rhythm: { quiet: { from: '01:00', to: '09:00', allowTouchReply: true } } })
          } })),
          quietOn ? h('div', { style: row },
            '从', h('input', {
              type: 'time',
              style: Object.assign({}, inputStyle, { width: 92 }),
              value: quiet.from || '01:00',
              onChange: function (e) {
                update({ rhythm: { quiet: {
                  from: e.target.value,
                  to: quiet.to || '09:00',
                  allowTouchReply: quiet.allowTouchReply !== false,
                } } })
              },
            }),
            '到', h('input', {
              type: 'time',
              style: Object.assign({}, inputStyle, { width: 92 }),
              value: quiet.to || '09:00',
              onChange: function (e) {
                update({ rhythm: { quiet: {
                  from: quiet.from || '01:00',
                  to: e.target.value,
                  allowTouchReply: quiet.allowTouchReply !== false,
                } } })
              },
            })) : null,
          quietOn ? h('div', { style: row }, '静默时仍回应触摸', h(Toggle, {
            value: quiet.allowTouchReply !== false,
            onChange: function () {
              update({ rhythm: { quiet: {
                from: quiet.from || '01:00',
                to: quiet.to || '09:00',
                allowTouchReply: quiet.allowTouchReply === false,
              } } })
            },
          })) : null,
          h(Hint, null, '静默只压世界时钟；自主唤醒照常，只会在 prompt 里提示“用户可能已睡”；启动问好不变。')),
        h(Section, { title: '连续性本子' },
          h('div', { style: row }, '唤醒时带入本子', h(Toggle, { value: journalOn, onChange: function () {
            update({ journal: { enabled: !journalOn } })
          } })),
          journalOn ? h('div', { style: row }, '每次唤醒注入最近',
            h('input', { style: inputStyle, value: String(journal.injectRecent ?? 3), onChange: function (e) {
              var v = parseInt(e.target.value, 10)
              if (Number.isFinite(v)) update({ journal: { injectRecent: Math.min(20, Math.max(1, v)) } })
            } }), '条') : null,
          h('div', { style: row }, '允许无绑定会话追加', h(Toggle, {
            value: journal.allowUnboundAppend === true,
            onChange: function () { update({ journal: { allowUnboundAppend: journal.allowUnboundAppend !== true } }) },
          })),
          h(Hint, null, '本子在 ~/.dsh/whale598/<petId>/journal.md：可读、可追加、不静默删改；手写本子已导入。默认只有宠物自己的会话可以追加。')),
        h(Section, { title: '你不在的时候' },
          h('div', { style: row }, '回来时给我一份摘要', h(Toggle, { value: presenceOn, onChange: function () {
            update({ presenceSummary: { enabled: !presenceOn } })
          } })),
          h(Hint, null, '默认关闭；打开后，你回到桌面时她最多用三行说自己这段时间醒了几次、做了什么、有没有自排计划。')),
        h(Section, { title: h('span', null, '自由活动 ', h('span', { style: { fontSize: 11, fontWeight: 400, color: 'rgba(127,127,127,.9)' } }, '逻辑驱动')) },
          h('div', { style: row }, '自由活动（宠物自娱）', h(Toggle, { value: pro.idleAnimation !== false, onChange: function () {
            update({ proactivity: { idleAnimation: !(pro.idleAnimation !== false) } })
          } })),
          h('div', { style: row },
            '两次小剧场至少间隔',
            h('input', { style: inputStyle, value: String(pro.idleAnimationGapMinutes ?? 10), onChange: function (e) {
              var v = parseInt(e.target.value, 10)
              if (Number.isFinite(v)) update({ proactivity: { idleAnimationGapMinutes: v } })
            } }),
            '分钟'),
          h(Hint, null, '自由活动：宠物空闲时随机播放一段小动画（纯动画，无模型参与），改动即时推送。')),

        // ── 语音朗读（BreezeBlue TTS）──
        h(Section, { title: h('span', null, '语音朗读 ', h('span', { style: { fontSize: 11, fontWeight: 400, color: 'rgba(127,127,127,.9)' } }, 'BreezeBlue TTS')) },
          h('div', { style: row }, '朗读开关', h(Toggle, { value: tts.enabled === true, onChange: function () {
            update({ tts: { enabled: !(tts.enabled === true) } })
          } }),
          h('span', { style: muted }, '宠物展示说话气泡的同时读出来（语音就绪立即一起显示；最多等 5 秒，超时只展示气泡）')),
          // key / 声音 / 语速音量均为 commit-on-blur：输入期间不落盘，
          // 清空 = 删除配置（宠物回落为不朗读）。
          h('div', { style: row },
            'API Key',
            h('input', { key: 'tts-key-' + String(tts.apiKey || ''), ref: function (el) { keyInputRef.current = el }, style: Object.assign({}, inputStyle, { width: 260 }), type: 'password', defaultValue: tts.apiKey || '', placeholder: 'brz_...（breezeblue.ai 申请）',
              onBlur: function (e) { var v = e.target.value.trim(); if (v !== (tts.apiKey || '')) update({ tts: { apiKey: v } }) },
              onKeyDown: function (e) { if (e.key === 'Enter') e.target.blur() } }),
            h('a', { href: 'https://breezeblue.ai/app/developer/api-keys', target: '_blank', rel: 'noopener noreferrer',
              style: Object.assign(btnStyle('primary'), { display: 'inline-block', textDecoration: 'none' }), title: '打开 BreezeBlue 开发者控制台的 API Keys 页面' }, '获取 Key')),
          h('div', { style: row },
            '声音',
            h('input', { key: 'tts-voice-' + String(tts.voiceId || ''), style: Object.assign({}, inputStyle, { width: 210, fontFamily: 'monospace' }), defaultValue: tts.voiceId || '', placeholder: 'voice_id，点右侧选择',
              onBlur: function (e) { var v = e.target.value.trim(); if (v !== (tts.voiceId || '')) update({ tts: { voiceId: v } }) },
              onKeyDown: function (e) { if (e.key === 'Enter') e.target.blur() } }),
            h(SButton, { disabled: busy, onClick: function () {
              if (voice) { setVoice(null); return }
              flushKeyThen(function () { loadVoices('') })
            } }, voice ? '收起' : '选择声音')),
          voice
            ? h('div', { style: { border: '1px solid rgba(127,127,127,.3)', borderRadius: 8, padding: '8px 10px', margin: '4px 0 6px' } },
                h('div', { style: row },
                  h('input', { style: Object.assign({}, inputStyle, { width: 190 }), value: voice.search || '', placeholder: '搜索声音（名称/风格）',
                    onChange: function (e) { setVoice(Object.assign({}, voice, { search: e.target.value })) },
                    onKeyDown: function (e) { if (e.key === 'Enter') loadVoices(voice.search) } }),
                  h(SButton, { disabled: voice.loading, onClick: function () { flushKeyThen(function () { loadVoices(voice.search) }) } }, '搜索')),
                voice.error ? h('div', { style: { color: '#ff7369', fontSize: 12, margin: '2px 0' } }, voice.error) : null,
                h('div', { style: { maxHeight: 220, overflowY: 'auto' } },
                  (voice.items || []).map(function (v) {
                    return h('div', { key: v.voice_id, style: Object.assign({}, row, { borderBottom: '1px solid rgba(127,127,127,.15)' }) },
                      h('span', { style: { fontWeight: 600 } }, v.name || v.voice_id),
                      h('span', { style: muted }, [v.language_code, v.gender, (v.tone || []).join('/')].filter(Boolean).join(' · ')),
                      v.voice_id === tts.voiceId ? h('span', { style: { color: '#3ddc84', fontSize: 12, fontWeight: 700 } }, '当前') : null,
                      h('span', { style: { flex: 1 } }),
                      v.preview_url ? h(SButton, { onClick: function () { playPreview(v.preview_url) } }, '试听') : null,
                      h(SButton, { variant: 'primary', onClick: function () { update({ tts: { voiceId: v.voice_id } }, '已选用 ' + (v.name || v.voice_id)) } }, '选用'))
                  }),
                  (!voice.loading && !voice.error && (voice.items || []).length === 0) ? h('div', { style: muted }, '没有匹配的声音') : null))
            : null,
          h('div', { style: row },
            '语速',
            h('input', { key: 'tts-speed-' + String(tts.speed ?? 1), style: inputStyle, defaultValue: String(tts.speed ?? 1), title: '0.5 – 2.0，1 = 正常',
              onBlur: function (e) { var v = parseFloat(e.target.value); if (Number.isFinite(v) && v !== (tts.speed ?? 1)) update({ tts: { speed: Math.min(2, Math.max(0.5, v)) } }) },
              onKeyDown: function (e) { if (e.key === 'Enter') e.target.blur() } }),
            '音量',
            h('input', { key: 'tts-volume-' + String(tts.volume ?? 1), style: inputStyle, defaultValue: String(tts.volume ?? 1), title: '0.01 – 2.0，1 = 默认',
              onBlur: function (e) { var v = parseFloat(e.target.value); if (Number.isFinite(v) && v !== (tts.volume ?? 1)) update({ tts: { volume: Math.min(2, Math.max(0.01, v)) } }) },
              onKeyDown: function (e) { if (e.key === 'Enter') e.target.blur() } })),
          h(Hint, null, '接入 BreezeBlue（breezeblue.ai）文字转语音：说话气泡显示时用所选声音朗读。key 只保存在本机 pet-settings.json；改动即时生效，无需重启宠物。气泡等语音的超时上限可在 pet-settings.json 的 tts.holdMs 调整（0–8000 毫秒，默认 5000；语音先就绪就立刻展示，超时则只展示气泡）。')),

        // ── 调试 ──
        h(Section, { title: '调试' },
          h('div', { style: row }, 'CDP 调试端口 (9222)', h(Toggle, { value: debug.cdp === true, onChange: function () {
            update({ debug: { cdp: !(debug.cdp === true) } })
          } }),
          h('span', { style: muted }, '重启 DeepSeek Harness 后生效')),
          h('div', { style: row },
            h(SButton, { disabled: busy, onClick: function () { act('/api/pet-settings/open-logs', {}, '已打开') } }, '打开日志文件夹'),
            h(SButton, { disabled: busy, onClick: function () {
              if (window.confirm('清除记住的窗口位置？下次启动回到默认位置。')) act('/api/pet-settings/reset-position', {}, '已清除，下次启动生效')
            } }, '重置窗口位置')),
          h(Hint, null, '拖动宠物结束后自动记住位置（pet-window.json）。'))
      )
    }

    function apply(ctx) {
      // Client-side startup audit is fatal on throw: degrade per section.
      var safe = function (label, fn) {
        try { return fn() } catch (e) {
          try { console.warn('[pet-settings] ' + label + ' degraded: ' + String((e && e.message) || e)) } catch (x) { /* ignore */ }
        }
      }
      safe('settings section', function () {
        var slots = ctx.slots
        if (!slots) { console.warn('[pet-settings] slots unavailable'); return }
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'pet-surface', order: 40, label: '桌宠' },
            function (props) { return h(PetSettingsPage, { close: props && props.close }) })
        })
      })
    }

    var exports = {}
    exports.inject = ['slots']
    exports.apply = apply
    return exports
  },
})
