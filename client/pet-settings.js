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
    // B10+: 人设区对齐 persona-presets——卡面路由 + 导入软警告阈值 + pps-*
    // 样式层（hover/focus/transition 需要伪类，内联样式表达不了）。
    var AVATAR_POST = '/api/pet-settings/persona-avatar'
    var AVATAR_GET = '/api/pet-settings/persona-avatar/'
    var SOFT_WARN_CHARS = 10000
    var PPS_CSS = [
      '.pps-fold{display:flex;align-items:center;gap:10px;padding:6px 8px;margin:0 -8px 6px;border-radius:8px;cursor:pointer;transition:background .15s ease;flex-wrap:wrap}',
      '.pps-fold:hover{background:rgba(127,127,127,.08)}',
      '.pps-chevron{display:inline-block;width:14px;text-align:center;font-weight:700;font-size:11px;opacity:.8;transition:transform .15s ease}',
      '.pps-chevron-open{transform:rotate(90deg)}',
      '.pps-input{border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;font:inherit;transition:border-color .15s ease,box-shadow .15s ease}',
      '.pps-input:hover{border-color:rgba(127,127,127,.55)}',
      '.pps-input:focus{outline:none;border-color:rgba(124,108,240,.7);box-shadow:0 0 0 2px rgba(124,108,240,.18)}',
      '.pps-name-input{width:170px;font-weight:700}',
      '.pps-textarea{width:100%;height:100%;box-sizing:border-box;resize:vertical;line-height:1.6;padding:8px 10px}',
      '.pps-btn{border:1px solid rgba(127,127,127,.4);border-radius:8px;cursor:pointer;font:inherit;font-size:12px;padding:4px 14px;background:transparent;color:inherit;display:inline-flex;align-items:center;transition:background .15s ease,border-color .15s ease,opacity .15s ease}',
      '.pps-btn:hover{background:rgba(127,127,127,.1);border-color:rgba(127,127,127,.6)}',
      '.pps-btn:disabled{opacity:.45;cursor:default}',
      '.pps-btn-primary{font-weight:700;border-color:rgba(124,108,240,.55)}',
      '.pps-btn-primary:hover{background:rgba(124,108,240,.14);border-color:rgba(124,108,240,.8)}',
      '.pps-avatar{width:120px;max-height:260px;object-fit:contain;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.06);flex:0 0 auto;align-self:flex-start}',
      '.pps-count{color:rgba(127,127,127,.85);font-size:12px}',
      '.pps-count-over{color:#ff7369;font-size:12px;font-weight:600}',
      '.pps-warn{color:#e8b268;font-size:12px;background:rgba(232,178,104,.1);border:1px solid rgba(232,178,104,.3);border-radius:999px;padding:2px 10px}',
    ].join('\n')

    // ── 角色卡导入（本机解析，文件不过服务器）────────────────────────
    // Character Card V2/V3（SillyTavern 生态标准）：角色数据以 base64 JSON
    // 嵌在 PNG tEXt 块里（V2 关键字 chara，V3 是 ccv3）。解析出的多字段按
    // 中文小节结构化平铺，空字段跳过；character_book（世界书）v1 不导入只提示。

    var latin1 = function (bytes, start, end) {
      var s = ''
      for (var i = start; i < end; i++) s += String.fromCharCode(bytes[i])
      return s
    }

    var decodeBase64Utf8 = function (b64) {
      var bin = atob(String(b64).replace(/\s+/g, ''))
      var bytes = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new TextDecoder('utf-8').decode(bytes)
    }

    // 遍历 PNG chunk 找 tEXt 的 chara/ccv3 块，返回解析后的卡 JSON；不是
    // 角色卡 PNG 时返回 null（签名不对/没有块/块内容解不开都算）。
    var pngCharaJson = function (buffer) {
      try {
        var dv = new DataView(buffer)
        if (dv.byteLength < 8 || dv.getUint8(0) !== 0x89 || dv.getUint8(1) !== 0x50) return null
        var off = 8
        while (off + 8 <= dv.byteLength) {
          var len = dv.getUint32(off)
          var type = latin1(new Uint8Array(buffer, off + 4, 4), 0, 4)
          if (type === 'tEXt') {
            var data = new Uint8Array(buffer, off + 8, len)
            var zero = -1
            for (var i = 0; i < data.length; i++) { if (data[i] === 0) { zero = i; break } }
            if (zero > 0) {
              var keyword = latin1(data, 0, zero)
              if (keyword === 'chara' || keyword === 'ccv3') {
                try { return JSON.parse(decodeBase64Utf8(latin1(data, zero + 1, data.length))) } catch (e) { /* 继续扫其它块 */ }
              }
            }
          }
          if (type === 'IEND') break
          off += 12 + len // length(4) + type(4) + data(len) + crc(4)
        }
      } catch (e) { /* 烂图按 null 处理 */ }
      return null
    }

    // 卡 JSON（V1 顶层或 V2/V3 的 data 子对象）→ 结构化平铺文本。
    function flattenCard(raw) {
      try {
        var d = raw && raw.data && (raw.data.name || raw.data.description) ? raw.data : raw
        if (!d || typeof d !== 'object') return null
        var sections = [['名字', 'name'], ['设定', 'description'], ['性格', 'personality'], ['场景', 'scenario'], ['开场白', 'first_mes'], ['对话示例', 'mes_example'], ['备注', 'creator_notes']]
        var out = []
        for (var i = 0; i < sections.length; i++) {
          var v = d[sections[i][1]]
          if (typeof v === 'string' && v.trim() !== '') out.push('【' + sections[i][0] + '】' + v.trim())
        }
        if (out.length === 0) return null
        return { text: out.join('\n\n'), hasBook: !!d.character_book }
      } catch (e) { return null }
    }

    // Theme-neutral: inherit foreground, translucent borders — readable on
    // both the host's dark and light themes without a design system.
    var card = { border: '1px solid rgba(127,127,127,.35)', borderRadius: 10, padding: '10px 14px 12px', margin: '10px 0' }
    var cardTitle = { fontWeight: 700, fontSize: 14, margin: '2px 0 8px' }
    var row = { display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0', fontSize: 13, flexWrap: 'wrap' }
    var muted = { color: 'rgba(127,127,127,.9)', fontSize: 12 }
    var inputStyle = { width: 64, padding: '2px 6px', border: '1px solid rgba(127,127,127,.4)', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' }
    // 原生 select 的下拉列表用 Chromium 默认白底、option 又继承页面浅色文字
    // = 白底白字看不见——option 显式深底浅字 + select 声明 dark 配色。
    var optionStyle = { background: '#1c2733', color: '#e8e8e8' }
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
      // 选择器的写入目标 petId：给那只宠配覆盖（voices[petId]）。全局默认
      // 已退役——没有默认声音，没配的宠只显示气泡。搜索列表只有一份，
      // 内联展开在被点宠的行下方，选用写入该宠。
      var voiceTargetState = useState(null)
      var voiceTarget = voiceTargetState[0]
      var setVoiceTarget = voiceTargetState[1]
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
      var bindingMsgState = useState({})
      var bindingMsgs = bindingMsgState[0]
      var setBindingMsgs = bindingMsgState[1]
      var bindingDraftState = useState({})
      var bindingDrafts = bindingDraftState[0]
      var setBindingDrafts = bindingDraftState[1]
      var bindingAttemptState = useState({})
      var bindingAttempts = bindingAttemptState[0]
      var setBindingAttempts = bindingAttemptState[1]
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
      // 多宠（Phase 1）：行内召唤/送走 + 再来一只。busy 记 petId——同一行转圈，其它行不受影响。
      var instanceBusyIdState = useState('')
      var instanceBusyId = instanceBusyIdState[0]
      var setInstanceBusyId = instanceBusyIdState[1]
      // 人设卡片（data.personas 按预设 4 槽，host 回落链解析生效值；旧 host
      // 无此块时整卡隐藏）：草稿按 presetId 分键，null/缺席 = 跟随 host 生效值；
      // 保存成功才交还，失败保留草稿供重试。每槽「恢复默认」= 写空串删键回落。
      var personaDraftsState = useState({})
      var personaDrafts = personaDraftsState[0]
      var setPersonaDrafts = personaDraftsState[1]
      // 槽折叠态（默认全部收起——4 张卡平铺太占屏）；有未保存草稿的槽强制展开。
      var personaOpenState = useState({})
      var personaOpen = personaOpenState[0]
      var setPersonaOpen = personaOpenState[1]
      // 卡面（角色卡 PNG 原图，host 存 persona-avatars/<presetId>.png，纯展示
      // 不进 prompt）：onError（404）隐藏降级；导入成功后 bust 刷新。
      var avatarFailState = useState({})
      var avatarFail = avatarFailState[0]
      var setAvatarFail = avatarFailState[1]
      var avatarBustState = useState({})
      var avatarBust = avatarBustState[0]
      var setAvatarBust = avatarBustState[1]

      // pets 镜像进 ref：轮询回调查最新列表而不用把 data 拖进依赖。
      var petsRef = useRef([])
      var refresh = useCallback(function () {
        fetch(READ, { credentials: 'same-origin' })
          .then(function (r) { return r.json() })
          .then(function (d) {
            petsRef.current = (d && d.pets) || []
            setData(d)
          })
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
        // Binding edits own their message under the binding row (the petId
        // comes from the patch's boundSessions keys); the global banner at
        // the top stays for the rest of the settings page.
        var boundKeys = body && body.patch && body.patch.innerVoice && body.patch.innerVoice.boundSessions
          ? Object.keys(body.patch.innerVoice.boundSessions)
          : []
        var isBinding = boundKeys.length > 0
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
              if (d && d.error) setBindingMsg(boundKeys[0], '失败: ' + d.error)
              else setBindingMsg(boundKeys[0], doneMessage || '绑定已保存')
            } else if (d && d.error) setMsg('失败: ' + d.error)
            else setMsg(doneMessage || '完成')
            setWarnings(d && d.warnings && d.warnings.length ? d.warnings.join('；') : '')
            refresh()
            loadBinding()
          })
          .catch(function (e) {
            if (isBinding) setBindingMsg(boundKeys[0], '请求失败: ' + (e && e.message))
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
      // 人设按预设 4 槽（data.personas = {presetId: {value(回落链生效文本),
      // default, maxLength, inherited}}，host 从 src/persona.ts 解析；旧 host
      // 无此块时整区隐藏）：生效文本 = 该槽草稿优先，否则 host 值；字数按
      // Unicode 码点数，和宿主的截断口径一致。inherited=true 的槽显示的是
      // 回落来的卡（全局卡或默认），一编辑就物化到该槽。
      var PRESET_SLOT_LABELS = {
        whale598: '精简（仅表达）',
        'whale598-standard': '普通（含工作工具）',
        'whale598-custom-1': '自定义1',
        'whale598-custom-2': '自定义2',
      }
      var PRESET_SLOT_IDS = ['whale598-standard', 'whale598', 'whale598-custom-1', 'whale598-custom-2']
      var personaSlots = (data && data.personas) || null
      var personaSlotOf = function (presetId) {
        return personaSlots ? personaSlots[presetId] : null
      }
      var personaTextOf = function (presetId) {
        var draft = personaDrafts[presetId]
        if (draft !== null && draft !== undefined) return draft
        var slot = personaSlotOf(presetId)
        return slot ? String(slot.value || '') : ''
      }
      // 人设槽显示名：用户取名（settings.presetNames）优先，缺省回落内置标签
      // ——与宠物改名同款（uncontrolled + key 钉住生效名，改名后重挂）。
      var presetNameOf = function (presetId) {
        var custom = settings.presetNames && settings.presetNames[presetId]
        return custom ? String(custom) : (PRESET_SLOT_LABELS[presetId] || presetId)
      }
      var commitPresetName = function (presetId, value) {
        var current = (settings.presetNames && settings.presetNames[presetId]) || ''
        var v = String(value || '').trim()
        if (v === current) return
        var next = Object.assign({}, settings.presetNames || {})
        if (v === '') delete next[presetId]
        else next[presetId] = v
        update({ presetNames: next }, '人设名已保存')
      }
      var affection = (data && data.affection) || {}
      var pets = (data && data.pets) || []
      if (!(pets && pets.length) && data && data.pet) pets = [Object.assign({ id: 'electron' }, data.pet)]
      // 多宠实例操作（/api/pet-settings/instance/*）：electron 走主身召唤，
      // electron-N 走实例召唤/送走，'new' 分配下一只。上限与去重由宿主裁决。
      var INSTANCE_REASON = {
        limit: '到多宠上限了（pet-settings.json 旁的 multi-instances.json 可调 maxInstances）',
        duplicate: '它已经在桌面上',
        'electron-installing': 'electron 还在准备，装完再试',
        'electron-unavailable': 'electron 未安装且无法自动安装',
        'spawn-disabled': 'DSH_PET_NO_SPAWN=1 已禁用拉起',
        primary: '主身不能召回或放生',
        'unknown-instance': '不认识的实例 id',
      }
      var instanceAction = function (action, petId, doneText) {
        if (instanceBusyId !== '') return
        setInstanceBusyId(petId)
        setMsg('')
        fetch('/api/pet-settings/instance/' + action, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ petId: petId }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (!d || !d.ok) {
              setMsg('失败: ' + (INSTANCE_REASON[d && d.reason] || (d && (d.reason || d.error)) || '未知原因'))
              setInstanceBusyId('')
              refresh()
              return
            }
            setMsg(doneText)
            // 新载体要 electron 拉起 + 注册表心跳后才会出现在 pets[]——立即
            // 刷新看不到（得手动点刷新的问题）。短轮询到目标状态出现即停；
            // 按钮保持「召唤中/送别中」直到落定或 ~12s 超时。
            var targetId = String((d && d.petId) || petId)
            var expectOnline = action === 'summon'
            var tries = 0
            var tick = function () {
              tries += 1
              refresh()
              setTimeout(function () {
                var row = petsRef.current.filter(function (p) { return p.id === targetId })[0]
                var settled = expectOnline ? !!(row && row.online) : (!row || !row.online)
                if (settled || tries >= 8) { setInstanceBusyId(''); return }
                tick()
              }, 1500)
            }
            tick()
          })
          .catch(function (e) {
            setMsg('请求失败: ' + ((e && e.message) || e))
            setInstanceBusyId('')
          })
      }
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
      var defaultName = function (id) {
        if (id === 'electron') return '鲸鱼娘'
        if (id === 'pure') return 'Pure 宠物'
        if (/^electron-\d+$/.test(id)) return '鲸鱼娘·' + id.split('-')[1]
        return id
      }
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
      // Per-pet since 2026-11-10: drafts/attempts/messages are maps keyed by
      // petId — each pet row owns its field (the electron-hardcoded single
      // field was a single-pet assumption).
      function savedBindingFor(petId) {
        return String((iv.boundSessions && iv.boundSessions[petId]) || '')
      }
      function setBindingMsg(petId, text) {
        setBindingMsgs(function (prev) {
          var next = Object.assign({}, prev)
          if (text) next[petId] = text
          else delete next[petId]
          return next
        })
      }
      function commitBinding(petId) {
        var saved = savedBindingFor(petId)
        var draft = bindingDrafts[petId]
        var v = (draft !== null && draft !== undefined ? draft : saved).trim()
        if (v === saved) {
          setBindingDrafts(function (prev) { var n = Object.assign({}, prev); delete n[petId]; return n })
          setBindingAttempts(function (prev) { var n = Object.assign({}, prev); delete n[petId]; return n })
          setBindingMsg(petId, '')
          return
        }
        // A blur repeats on every focus loss; do not resend the exact value
        // that already failed (the visible error would flash on each retry).
        if (v === bindingAttempts[petId]) return
        setBindingAttempts(function (prev) { return Object.assign({}, prev, (function () { var n = {}; n[petId] = v; return n })()) })
        var next = Object.assign({}, iv.boundSessions || {})
        if (v !== '') next[petId] = v
        else delete next[petId]
        update({ innerVoice: { boundSessions: next } }, '绑定已保存')
      }

      // ensure + attach + status, no visible prompt: the one-click way to
      // finish the "binding is saved but not loaded" step.
      function testBinding(petId) {
        var saved = savedBindingFor(petId)
        var draft = bindingDrafts[petId]
        if (draft !== null && draft !== undefined && draft.trim() !== saved) {
          setBindingMsg(petId, '请先保存绑定：点一下输入框外面或按回车')
          return
        }
        setBindingBusy(true)
        setMsg('')
        setBindingMsg(petId, '')
        fetch('/api/pet-settings/binding-test', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ petId: petId }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.error) { setBindingMsg(petId, '失败: ' + d.error); return }
            if (d && d.ok) {
              var notes = []
              if (d.binding && d.binding.presetWarning) notes.push('当前模式不是宠物模式，不会有气泡回应')
              if (d.binding && d.binding.attach && d.binding.attach.errorCode === 'cwd-mismatch') {
                notes.push('会话在另一个项目，不会归到 whale598 项目下')
              }
              setBindingMsg(petId, notes.length ? '绑定可用；' + notes.join('；') : '绑定测试通过')
            } else {
              var b = d && d.binding
              var reason = (b && (b.lastError || (b.attach && b.attach.errorCode))) || '未知原因'
              if (reason.indexOf('session-occupied-by:') === 0) {
                reason = '该会话已被宠物「' + petName(reason.split(':')[1]) + '」占用——一只宠物一个脑子，换一个会话或清掉那边的绑定'
              }
              setBindingMsg(petId, '绑定测试未通过：' + reason)
            }
            if (d && d.binding) {
              var nextPets = Object.assign({}, (bindingData && bindingData.pets) || {})
              nextPets[petId] = d.binding
              setBindingData({ updatedAt: Date.now(), pets: nextPets, failures: (bindingData && bindingData.failures) || [] })
            }
          })
          .catch(function (e) { setBindingMsg(petId, '请求失败: ' + (e && e.message)) })
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

      // 按宠声音（多实例）：voices[petId] 覆盖该宠的声音/语速/音量，未设
      // 字段回落 BreezeBlue 默认（没有全局声音——没配的宠不朗读）。整表提交（宿主逐键合并，patch 未提及的宠保留，
      // 手编 json 不丢）；清除 = 该键发 null——宿主的显式删除信号，整只
      // 回落默认。单字段清空也走 null（逐键合并下缺键=保留，null 才是
      // 删除）；entry 全空时折叠成 null，表里不留壳。
      var commitVoiceEntry = function (petId, patchEntry, doneMessage) {
        var next = Object.assign({}, tts.voices || {})
        if (patchEntry === null) {
          next[petId] = null
        } else {
          var entry = Object.assign({}, next[petId] || {})
          Object.keys(patchEntry).forEach(function (k) {
            var v = patchEntry[k]
            if (v === '' || v === null || v === undefined) entry[k] = null
            else entry[k] = v
          })
          next[petId] = Object.keys(entry).length ? entry : null
        }
        update({ tts: { voices: next } }, doneMessage)
      }

      // 导入：.md/.txt 直达草稿；.json/.png 解析角色卡后结构化平铺。结果只
      // 填草稿（不自动保存）——检查/删减后照常走「保存人设」唯一写路径。
      // PNG 的卡面原图单独上传（persona-avatars/，展示用不进 prompt），失败
      // 静默——图是装饰，不该打扰卡文本的导入反馈。
      var handleImport = function (presetId, file) {
        if (!file) return
        var max = Number((personaSlotOf(presetId) || {}).maxLength) || 20000
        var name = file.name.toLowerCase()
        var finish = function (imported) {
          if (!imported) { setMsg(file.name + '：解析失败——不是可识别的角色卡'); return }
          setPersonaDrafts(function (prev) { return Object.assign({}, prev, (function () { var n = {}; n[presetId] = imported.text; return n })()) })
          setPersonaOpen(function (prev) { return Object.assign({}, prev, (function () { var n = {}; n[presetId] = true; return n })()) })
        }
        if (/\.png$/.test(name)) {
          var reader = new FileReader()
          reader.onload = function () {
            var card = pngCharaJson(reader.result)
            if (!card) { setMsg(file.name + '：不是角色卡 PNG（未找到内嵌角色数据）'); return }
            finish(flattenCard(card))
          }
          reader.onerror = function () { setMsg(file.name + '：读取失败') }
          reader.readAsArrayBuffer(file)
          var imgReader = new FileReader()
          imgReader.onload = function () {
            var b64 = String(imgReader.result || '').split(',')[1] || ''
            if (!b64) return
            fetch(AVATAR_POST, {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ presetId: presetId, data: b64 }),
            })
              .then(function (r) { return r.json() })
              .then(function (d) {
                if (d && d.ok) {
                  setAvatarFail(function (prev) { var n = Object.assign({}, prev); n[presetId] = false; return n })
                  setAvatarBust(function (prev) { var n = Object.assign({}, prev); n[presetId] = Date.now(); return n })
                }
              })
              .catch(function () { /* 图是装饰：失败不打扰 */ })
          }
          imgReader.readAsDataURL(file)
          return
        }
        var textReader = new FileReader()
        textReader.onload = function () {
          var text = String(textReader.result || '')
          if (/\.json$/.test(name)) {
            try {
              var card = flattenCard(JSON.parse(text))
              if (card) { finish(card); return }
              setMsg(file.name + '：JSON 里没有角色卡字段（需要 name/description 等）')
            } catch (e) { setMsg(file.name + '：JSON 解析失败') }
            return
          }
          finish({ text: text })
        }
        textReader.onerror = function () { setMsg(file.name + '：读取失败') }
        textReader.readAsText(file)
      }

      // 人设保存走独立的 fetch（不走 update）：保存成功才把文本框交还 host
      // 生效值（清该槽草稿），失败时草稿留在框里供重试——长文本不该因为一次
      // 请求失败就丢。text 参数显式传入，避免闭包读到旧渲染趟的草稿。空文本
      // = 恢复默认：写空串删槽键，回落全局卡/DEFAULT_PERSONA（宿主语义）。
      var savePersonaSlot = function (presetId, text, doneMessage) {
        setBusy(true)
        setMsg('')
        var patchPersonas = {}
        patchPersonas[presetId] = String(text || '').trim()
        fetch(UPDATE, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch: { personas: patchPersonas } }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.error) setMsg('失败: ' + d.error)
            else {
              setPersonaDrafts(function (prev) { var n = Object.assign({}, prev); delete n[presetId]; return n })
              setMsg(doneMessage)
              // 清空保存 = 恢复默认：host 删了卡面文件，本地同步隐藏（避免 404 重试）。
              if (String(text || '').trim() === '') {
                setAvatarFail(function (prev) { var n = Object.assign({}, prev); n[presetId] = true; return n })
              }
            }
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

        // ── 状态（每宠一行 + 行内召唤/送走，多宠 Phase 1） ──
        h(Section, { title: h('span', null, '宠物 ',
          h('span', { style: { fontSize: 11, fontWeight: 400, color: 'rgba(127,127,127,.9)' } }, '同名同脸，各养各的记忆')) },
          pets.length
            ? pets.map(function (p) {
              var isExtra = /^electron-\d+$/.test(p.id)
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
                  : h('span', { style: muted }, '离线'),
                p.online && isExtra
                  ? h(SButton, { variant: 'danger', disabled: instanceBusyId === p.id, onClick: function () {
                    if (window.confirm('召回 ' + petName(p.id) + '？它会离开桌面，本子和记忆都留着——「再来一只」时会带着原来的样子回来。')) instanceAction('dismiss', p.id, petName(p.id) + ' 已召回')
                  } }, instanceBusyId === p.id ? '召回中…' : '召回')
                  : null,
                !p.online
                  ? h(SButton, { disabled: instanceBusyId === p.id, onClick: function () { instanceAction('summon', p.id, petName(p.id) + ' 已召唤') } }, instanceBusyId === p.id ? '召唤中…' : '召唤')
                  : null,
                isExtra
                  ? h(SButton, { variant: 'danger', disabled: instanceBusyId === p.id, onClick: function () {
                    if (window.confirm('赛博放生 ' + petName(p.id) + '？本子、好感、名字、窗口位置全部删除，放生之后就不会再回来了（这是幽默的说法——数据是真的没了）。只想暂时告别请用「召回」。')) {
                      instanceAction('destroy', p.id, petName(p.id) + ' 已赛博放生（数据已抹除）')
                    }
                  }, title: '删除这只宠物的全部数据（赛博放生）' }, instanceBusyId === p.id ? '放生中…' : '赛博放生')
                  : null)
            })
            : h('div', null, '没有在线的宠物', h(Hint, null, '启动 DeepSeek Harness 后鲸鱼娘会自动上桌；Pure 宠物需自行启动。')),
          h('div', { style: row },
            h(SButton, { disabled: instanceBusyId !== '' || busy, onClick: function () { instanceAction('summon', 'new', '新宠物已召唤上桌（可改名区分）') } }, instanceBusyId === 'new' ? '召唤中…' : '再来一只'),
            h('span', { style: muted }, '同种同脸，各养各的记忆；上限 3 只（multi-instances.json 可调）')),
          h(Hint, null, '召回＝让它离开桌面，本子和记忆都留着——之后「再来一只」它会带着原来的样子回来；赛博放生＝彻底删掉这只宠的全部数据，无法恢复。只想暂时告别用召回，确定不要这只了才赛博放生。')),

        // ── 人设（按预设 4 槽；身体规则是宿主契约，不在此编辑） ──
        personaSlots ? h(Section, { title: h('span', null, '人设 ',
          h('span', { style: { fontSize: 11, fontWeight: 400, color: 'rgba(127,127,127,.9)' } }, '每个预设一张卡 · 点 ▾ 展开编辑 · 改动会击穿会话前缀缓存')) },
          h('style', null, PPS_CSS),
          PRESET_SLOT_IDS.map(function (presetId) {
            var slot = personaSlotOf(presetId)
            if (!slot) return null
            var draft = personaDrafts[presetId]
            // 折叠纯手动（▾/▸）——有草稿不强制展开，收起时头部挂琥珀「有未
            // 保存草稿」提示（不静默藏字、也不锁死开关；persona-presets 同款）。
            var open = personaOpen[presetId] === true
            var hasDraft = draft !== null && draft !== undefined
            var text = personaTextOf(presetId)
            var count = Array.from(text).length
            var max = Number(slot.maxLength) || 20000
            var toggle = function () {
              setPersonaOpen(function (prev) { return Object.assign({}, prev, (function () { var n = {}; n[presetId] = !open; return n })()) })
            }
            var header = h('div', { className: 'pps-fold', onClick: toggle, role: 'button', 'aria-expanded': open, title: open ? '收起' : '展开编辑' },
              h('span', { className: open ? 'pps-chevron pps-chevron-open' : 'pps-chevron', 'aria-hidden': true }, '▸'),
              h('input', { key: 'pname-' + presetNameOf(presetId), className: 'pps-input pps-name-input', defaultValue: presetNameOf(presetId), title: '给人设取名；点击空白处或回车生效；清空恢复内置名',
                onClick: function (e) { e.stopPropagation() },
                onBlur: function (e) { commitPresetName(presetId, e.target.value) },
                onKeyDown: function (e) { if (e.key === 'Enter') { commitPresetName(presetId, e.target.value); e.target.blur() } },
                'aria-label': '人设名 · ' + presetId }),
              h('span', { style: muted }, '对应预设：' + (PRESET_SLOT_LABELS[presetId] || presetId)),
              hasDraft && !open ? h('span', { className: 'pps-warn' }, '有未保存草稿') : null)
            if (!open) return h('div', { key: presetId, style: { marginBottom: 10 } }, header)
            // 编辑区：卡面图（有则展示）在左，内容 textarea 在右——图只是装饰
            // （host 存 persona-avatars/<presetId>.png，不进 prompt），404 时
            // onError 隐藏、textarea 占满整行；flex 默认 stretch 让有图时
            // textarea 与图片等高，无图时高度由 minHeight 决定。
            var avatarSrc = AVATAR_GET + presetId + (avatarBust[presetId] ? '?t=' + avatarBust[presetId] : '')
            return h('div', { key: presetId, style: { marginBottom: 14 } },
              header,
              h('div', { style: { display: 'flex', gap: 10, alignItems: 'stretch' } },
                avatarFail[presetId] !== true ? h('img', {
                  src: avatarSrc,
                  alt: '卡面',
                  className: 'pps-avatar',
                  onError: function () { setAvatarFail(function (prev) { var n = Object.assign({}, prev); n[presetId] = true; return n }) },
                }) : null,
                h('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 260 } },
                  h('textarea', {
                    className: 'pps-input pps-textarea',
                    value: text,
                    placeholder: slot.default,
                    onChange: function (e) {
                      setPersonaDrafts(function (prev) { return Object.assign({}, prev, (function () { var n = {}; n[presetId] = e.target.value; return n })()) })
                    },
                    'aria-label': '人设文本 · ' + presetNameOf(presetId),
                  }))),
              h('div', { className: 'pps-fold', style: { cursor: 'default' } },
                h('button', { className: 'pps-btn pps-btn-primary', disabled: busy || draft === null || draft === undefined,
                  onClick: function () { savePersonaSlot(presetId, text, '人设已保存') } }, '保存人设'),
                h('button', { className: 'pps-btn', disabled: busy, onClick: function () { savePersonaSlot(presetId, '', '已恢复默认人设（回落内置卡）') } }, '恢复默认'),
                h('label', { className: 'pps-btn', title: '导入 .md/.txt/.json 或角色卡 PNG（SillyTavern 格式，解析在本机完成）' },
                  '导入',
                  h('input', {
                    type: 'file', accept: '.md,.txt,.json,.png', style: { display: 'none' },
                    onChange: function (e) { handleImport(presetId, e.target.files && e.target.files[0]); e.target.value = '' },
                  })),
                h('span', { className: count > max ? 'pps-count-over' : 'pps-count' }, String(count) + ' / ' + String(max) + ' 字'),
                count > SOFT_WARN_CHARS ? h('span', { className: 'pps-warn' }, '每回合注入 prompt，注意 token 消耗') : null))
          }),
          h(Hint, null, '每个预设一张角色卡：宠物用哪个预设，就带哪张卡（在上方「会话模式」按宠选择）。身体规则（气泡、动作、本子的用法）是固定契约，不在这里编辑。'),
          h(Hint, null, '导入支持 .md/.txt/.json 或角色卡 PNG（SillyTavern 生态的卡，解析在本机完成、文件不上传）；PNG 的卡面图会单独保存展示。清空并保存即回落该槽内置卡；改动下一次对话就生效，无需重启。'),
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
          h('div', { style: row }, '允许模型自调',
            h(Toggle, { value: iv.selfTuning === true, onChange: function () {
              update({ innerVoice: { selfTuning: !(iv.selfTuning === true) } })
            } }),
            h('span', { style: muted }, '开：她可用 pet_set_rhythm 自己调上面四项；关：她调用直接失败')),
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
          h('div', { style: row }, '默认会话模式',
            h('select', {
              style: Object.assign({}, inputStyle, { width: 190, colorScheme: 'dark' }),
              value: String(iv.preset || 'whale598'),
              onChange: function (e) {
                if (e.target.value !== iv.preset) update({ innerVoice: { preset: e.target.value } })
              },
              'aria-label': '默认会话模式',
            }, PRESET_SLOT_IDS.map(function (presetId) {
              return h('option', { key: presetId, value: presetId, style: optionStyle }, presetNameOf(presetId))
            })),
            h('span', { style: muted }, '＝默认人设（每只宠可在下方「会话预设」单独改，名字在「人设」区自定义）')),
          // ── 按宠预设（多宠）：每只宠各选各的会话模式=各带各的人设卡 ──
          (function () {
            var ids = []
            pets.forEach(function (p) { if (ids.indexOf(p.id) < 0) ids.push(p.id) })
            if (ids.indexOf('electron') < 0) ids.unshift('electron')
            var perPet = iv.presets || {}
            return ids.map(function (petId) {
              var current = String(perPet[petId] || '')
              return h('div', { key: 'preset-' + petId, style: row },
                '会话预设 · ' + petName(petId),
                h('select', {
                  style: Object.assign({}, inputStyle, { width: 190, colorScheme: 'dark' }),
                  value: current,
                  onChange: function (e) {
                    var next = Object.assign({}, perPet)
                    if (e.target.value === '') delete next[petId]
                    else next[petId] = e.target.value
                    update({ innerVoice: { presets: next } })
                  },
                  'aria-label': '会话预设 · ' + petName(petId),
                },
                  h('option', { key: '', value: '', style: optionStyle }, '跟随默认'),
                  PRESET_SLOT_IDS.map(function (presetId) {
                    return h('option', { key: presetId, value: presetId, style: optionStyle }, presetNameOf(presetId))
                  })))
            })
          })(),
          // ── 指定会话（高级）：按宠物一行——每只宠物各绑各的脑子 ──
          (function () {
            var ids = []
            pets.forEach(function (p) { if (ids.indexOf(p.id) < 0) ids.push(p.id) })
            if (ids.indexOf('electron') < 0) ids.unshift('electron')
            return ids.map(function (petId) {
              var saved = savedBindingFor(petId)
              var draft = bindingDrafts[petId]
              var petBinding = bindingData && bindingData.pets && bindingData.pets[petId]
              var statusLine = null
              if (petBinding) {
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
                if (petBinding.lastError && petBinding.lastError.indexOf('session-occupied-by:') === 0) {
                  parts.push('手动绑定被拒：该会话已被宠物「' + petName(petBinding.lastError.split(':')[1]) + '」占用')
                  color = '#f0b429'
                } else if (petBinding.lastError) {
                  parts.push(petBinding.lastError)
                }
                statusLine = h('div', { style: { color: color, fontSize: 12, margin: '2px 0 4px', wordBreak: 'break-all' } }, '· ' + parts.join(' · '))
              }
              return h('div', { key: petId, style: { margin: '0 0 8px' } },
                h('div', { style: row },
                  h('span', { style: { fontWeight: 600, flexShrink: 0 } }, '指定会话 · ' + petName(petId)),
                  h('input', {
                    style: Object.assign({}, inputStyle, { width: 300, flex: '1 1 240px' }),
                    value: draft !== null && draft !== undefined ? draft : saved,
                    placeholder: '会话 id，留空 = 自动管理',
                    onChange: function (e) {
                      setBindingDrafts(function (prev) { return Object.assign({}, prev, (function () { var n = {}; n[petId] = e.target.value; return n })()) })
                    },
                    onBlur: function () { commitBinding(petId) },
                    onKeyDown: function (e) { if (e.key === 'Enter') { commitBinding(petId); e.target.blur() } },
                  }),
                  h(SButton, {
                    onClick: function () { testBinding(petId) },
                    disabled: bindingBusy || (draft !== null && draft !== undefined && draft.trim() !== saved),
                  }, bindingBusy ? '测试中…' : '测试')),
                statusLine,
                bindingMsgs[petId] ? h('div', { style: { color: '#f0b429', fontSize: 12, margin: '2px 0 4px' } }, bindingMsgs[petId]) : null)
            })
          })(),
          warnings ? h('div', { style: { color: '#f0b429', fontSize: 12, margin: '2px 0 4px' } }, '提示：' + warnings) : null,
          h(Hint, null, '指定会话会校验当前模式：标准模式（没有 pet_say/pet_do）会被拒绝，请使用「精简（仅表达）」或「普通（含工作工具）」的宠物模式会话。会话在别的项目也没关系，唤醒和气泡照常，只是不会归到 whale598 项目下。保存后状态显示「已装载/未装载/失败」，点「测试」可立即验证；清空后回落到她之前的会话。宠物在自己专属的会话里醒来，用气泡和动作自主表达；那条「鲸鱼娘的内心戏」会话可在会话列表查看，也可以直接在那里和它聊天。醒来有两个来源：世界时钟是环境节拍，按上面的间隔和唤醒概率随机轻拍她，用户忙于会话或宠物表达未完成时不会打扰；自主唤醒是她用 pet_schedule_wake 给自己定的闹钟，到点带着当初的打算醒来，不受这个概率影响（上面的「自主唤醒遇用户忙」决定你正忙时她是否照醒，默认到点必醒）。会话模式切换只对新建会话生效：归档旧会话后，她会在下次对话时自动换代重建（旧会话记忆不迁移）。「允许模型自调」是她的节律总闸：开启后她可用 pet_set_rhythm 自己调上面四项（世界时钟间隔/唤醒概率/被摸回应概率/回应间隔，改的就是这几行的值，下一拍生效）；关闭时她调用直接失败，只能开口向你提——四项任何时候都由你改回。')),

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
          h(Hint, null, '本子在 ~/.dsh/whale598/<petId>/journal.md：可读、可追加、不静默删改；手写本子已导入。默认只有宠物自己的会话可以追加。'),
          // ── 清空长期记忆：按宠一行（全套移入 ~/.dsh/backup-journal/ 备份） ──
          (function () {
            var ids = []
            pets.forEach(function (p) { if (ids.indexOf(p.id) < 0) ids.push(p.id) })
            if (ids.indexOf('electron') < 0) ids.unshift('electron')
            return ids.map(function (petId) {
              return h('div', { key: 'jcl-' + petId, style: row },
                h('span', { style: muted }, '清空长期记忆 · ' + petName(petId)),
                h('span', { style: { flex: 1 } }),
                h(SButton, { variant: 'danger', disabled: busy, onClick: function () {
                  if (window.confirm('清空 ' + petName(petId) + ' 的长期记忆？本子、归档、阶段摘要全部移入备份目录（备份在 ~/.dsh/whale598/journal-backups/），她的连续性从零开始——旧会话上下文里还留有的印象不受影响，但新的唤醒不再带入旧本子。')) {
                    act('/api/pet-settings/journal/clear', { petId: petId }, petName(petId) + ' 的长期记忆已清空（原文件备份在 ~/.dsh/whale598/journal-backups/）')
                  }
                }, title: '删除这只宠物的连续性本子（先备份）' }, '清空'))
            })
          })()),
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
          // key 为 commit-on-blur：输入期间不落盘，清空 = 删除配置。
          // 全局声音/语速/音量已退役（2026-11-11，用户拍板：没有默认声音，
          // 没配的宠只显示气泡）——声音只存在于每宠的 voices[petId]。
          h('div', { style: row },
            'API Key',
            h('input', { key: 'tts-key-' + String(tts.apiKey || ''), ref: function (el) { keyInputRef.current = el }, style: Object.assign({}, inputStyle, { width: 260 }), type: 'password', defaultValue: tts.apiKey || '', placeholder: 'brz_...（breezeblue.ai 申请）',
              onBlur: function (e) { var v = e.target.value.trim(); if (v !== (tts.apiKey || '')) update({ tts: { apiKey: v } }) },
              onKeyDown: function (e) { if (e.key === 'Enter') e.target.blur() } }),
            h('a', { href: 'https://breezeblue.ai/app/developer/api-keys', target: '_blank', rel: 'noopener noreferrer',
              style: Object.assign(btnStyle('primary'), { display: 'inline-block', textDecoration: 'none' }), title: '打开 BreezeBlue 开发者控制台的 API Keys 页面' }, '获取 Key')),
          // ── 按宠声音（多实例，tts.voices[petId] 覆盖表）──
          // 行来源 = 桌面上的宠物（pets 注册表快照）——有几只显示几只，不从
          // windowPositions/voices 键补（桌面没有的不要显示）。每宠一个
          // 「选择」按钮打开搜索/试听列表，选用写入那只宠；没配的宠只显示
          // 气泡不朗读。语速/音量留空 = API 默认；清除 = 该键发 null，整只
          // 回落到不朗读。
          (function () {
            var ids = []
            var seen = {}
            ;(pets || []).forEach(function (p) {
              if (p && p.id && !seen[p.id]) { seen[p.id] = true; ids.push(String(p.id)) }
            })
            if (!ids.length) return null
            return [
              h('div', { style: Object.assign({}, row, { margin: '2px 0 0' }) }, h('span', { style: { fontWeight: 600 } }, '每宠单独配'),
                h('span', { style: muted }, '点某只的「选择」打开搜索列表，试听后选用——只为那一只生效')),
              ids.map(function (pid, idx) {
                var entry = (tts.voices && tts.voices[pid]) || {}
                var picking = voice && voiceTarget === pid
                // 两行布局：第一行 = 名字 + 当前声音 + 选择/清除；第二行 =
                // 速度/音量（显式显示默认值 1——用户不该面对空框猜语义）。
                // 数值改回 1 = 等效 API 默认，与未配置无行为差异。
                return [
                  h('div', { key: 'tts-per-pet-' + pid, style: Object.assign({}, row, { fontSize: 12 }) },
                    h('span', { style: { fontWeight: 600, minWidth: 64 } }, petName(pid)),
                    h('span', { style: muted }, pid),
                    h('span', { style: Object.assign({}, muted, { fontFamily: 'monospace', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) },
                      entry.voiceId || '未配置（不朗读）'),
                    h(SButton, { disabled: busy, onClick: function () {
                      if (picking) { setVoice(null); return }
                      setVoiceTarget(pid)
                      if (voice) return
                      flushKeyThen(function () { loadVoices('') })
                    } }, picking ? '收起' : '选择'),
                    h(SButton, { disabled: busy, onClick: function () { commitVoiceEntry(pid, null) }, title: '清除这只宠的声音配置——之后它只显示气泡、不再朗读' }, '清除')),
                  h('div', { key: 'tts-per-pet-sub-' + pid, style: Object.assign({}, row, { fontSize: 12, paddingLeft: 74, margin: '0 0 4px' }, idx < ids.length - 1 ? { borderBottom: '1px solid rgba(127,127,127,.2)', paddingBottom: 6 } : {}) },
                    '速度',
                    h('input', { key: 'tts-speed-' + pid + '-' + String(entry.speed ?? 1), style: Object.assign({}, inputStyle, { width: 48 }), defaultValue: String(entry.speed ?? 1), title: '0.5 – 2.0，1 = 正常语速',
                      onBlur: function (e) {
                        var v = parseFloat(e.target.value.trim())
                        if (Number.isFinite(v) && v !== (entry.speed ?? 1)) commitVoiceEntry(pid, { speed: Math.min(2, Math.max(0.5, v)) })
                      },
                      onKeyDown: function (e) { if (e.key === 'Enter') e.target.blur() } }),
                    '音量',
                    h('input', { key: 'tts-volume-' + pid + '-' + String(entry.volume ?? 1), style: Object.assign({}, inputStyle, { width: 48 }), defaultValue: String(entry.volume ?? 1), title: '0.01 – 2.0，1 = 默认音量',
                      onBlur: function (e) {
                        var v = parseFloat(e.target.value.trim())
                        if (Number.isFinite(v) && v !== (entry.volume ?? 1)) commitVoiceEntry(pid, { volume: Math.min(2, Math.max(0.01, v)) })
                      },
                      onKeyDown: function (e) { if (e.key === 'Enter') e.target.blur() } })),
                  picking ? h('div', { key: 'tts-picker-' + pid, style: { border: '1px solid rgba(127,127,127,.3)', borderRadius: 8, padding: '8px 10px', margin: '0 0 6px 74px' } },
                    h('div', { style: row },
                      h('span', { style: { fontWeight: 600, fontSize: 12 } },
                        '为「' + petName(pid) + '」（' + pid + '）挑声音'),
                      h('span', { style: { flex: 1 } }),
                      h(SButton, { disabled: busy, onClick: function () { commitVoiceEntry(pid, null) }, title: '清除这只宠的声音配置——之后它只显示气泡、不再朗读' }, '不朗读'),
                      h(SButton, { onClick: function () { setVoice(null) } }, '收起')),
                    h('div', { style: row },
                      h('input', { style: Object.assign({}, inputStyle, { width: 190 }), value: voice.search || '', placeholder: '搜索声音（名称/风格）',
                        onChange: function (e) { setVoice(Object.assign({}, voice, { search: e.target.value })) },
                        onKeyDown: function (e) { if (e.key === 'Enter') loadVoices(voice.search) } }),
                      h(SButton, { disabled: voice.loading, onClick: function () { flushKeyThen(function () { loadVoices(voice.search) }) } }, '搜索')),
                    voice.error ? h('div', { style: { color: '#ff7369', fontSize: 12, margin: '2px 0' } }, voice.error) : null,
                    h('div', { style: { maxHeight: 220, overflowY: 'auto' } },
                      (voice.items || []).map(function (v) {
                        var effective = (tts.voices && tts.voices[pid] && tts.voices[pid].voiceId) || ''
                        return h('div', { key: v.voice_id, style: Object.assign({}, row, { borderBottom: '1px solid rgba(127,127,127,.15)' }) },
                          h('span', { style: { fontWeight: 600 } }, v.name || v.voice_id),
                          h('span', { style: muted }, [v.language_code, v.gender, (v.tone || []).join('/')].filter(Boolean).join(' · ')),
                          v.voice_id === effective ? h('span', { style: { color: '#3ddc84', fontSize: 12, fontWeight: 700 } }, '当前') : null,
                          h('span', { style: { flex: 1 } }),
                          v.preview_url ? h(SButton, { onClick: function () { playPreview(v.preview_url) } }, '试听') : null,
                          h(SButton, { variant: 'primary', onClick: function () {
                            commitVoiceEntry(pid, { voiceId: v.voice_id }, '已为「' + petName(pid) + '」选用 ' + (v.name || v.voice_id))
                          } }, '选用'))
                      }),
                      (!voice.loading && !voice.error && (voice.items || []).length === 0) ? h('div', { style: muted }, '没有匹配的声音') : null)) : null,
                ]
              }),
            ]
          })(),
          h(Hint, null, '接入 BreezeBlue（breezeblue.ai）文字转语音：说话气泡显示时用所选声音朗读。key 只保存在本机 pet-settings.json；改动即时生效，无需重启宠物。没有全局默认声音——给哪只配了声音哪只才朗读，没配的只显示气泡；点某只的「选择」打开搜索列表，试听后「选用」只为那一只生效；「不朗读/清除」清掉这只的配置。气泡等语音的超时上限可在 pet-settings.json 的 tts.holdMs 调整（0–8000 毫秒，默认 5000；语音先就绪就立刻展示，超时则只展示气泡）。')),

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
