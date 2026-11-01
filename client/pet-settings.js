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

    var READ = '/api/pet-settings/read'
    var UPDATE = '/api/pet-settings/update'

    // Theme-neutral: inherit foreground, translucent borders — readable on
    // both the host's dark and light themes without a design system.
    var card = { border: '1px solid rgba(127,127,127,.35)', borderRadius: 10, padding: '10px 14px 12px', margin: '10px 0' }
    var cardTitle = { fontWeight: 700, fontSize: 14, margin: '2px 0 8px' }
    var row = { display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0', fontSize: 13, flexWrap: 'wrap' }
    var muted = { color: 'rgba(127,127,127,.9)', fontSize: 12 }
    var inputStyle = { width: 64, padding: '2px 6px', border: '1px solid rgba(127,127,127,.4)', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' }
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
    function Section(props) {
      return h('div', { style: card }, h('div', { style: cardTitle }, props.title), props.children)
    }
    function Hint(props) {
      return h('div', { style: Object.assign({ margin: '6px 0 2px' }, muted) }, props.children)
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

      var refresh = useCallback(function () {
        fetch(READ, { credentials: 'same-origin' })
          .then(function (r) { return r.json() })
          .then(function (d) { setData(d) })
          .catch(function (e) { setMsg('读取失败: ' + (e && e.message)) })
      }, [])
      useEffect(function () { refresh() }, [refresh])

      var act = useCallback(function (path, body, doneMessage) {
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
            if (d && d.error) setMsg('失败: ' + d.error)
            else setMsg(doneMessage || '完成')
            refresh()
          })
          .catch(function (e) { setMsg('请求失败: ' + (e && e.message)) })
          .finally(function () { setBusy(false) })
      }, [refresh])

      var settings = (data && data.settings) || {}
      var pro = settings.proactivity || {}
      var iv = settings.innerVoice || {}
      var debug = settings.debug || {}
      var affection = (data && data.affection) || {}
      var pets = (data && data.pets) || []
      if (!(pets && pets.length) && data && data.pet) pets = [Object.assign({ id: 'electron' }, data.pet)]
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
      // 提交一次改名（失焦/回车调用）：与当前值比较，无变化零开销；
      // 空值删键（回落默认）。一次编辑 = 至多一次 update = 至多一条 [改名]。
      var commitName = function (id, raw) {
        var v = (raw || '').trim()
        var next = Object.assign({}, (settings.names || {}))
        var current = next[id]
        if (v !== '' && v !== defaultName(id)) {
          if (current === v) return
          next[id] = v
        } else {
          if (current === undefined) return
          delete next[id]
        }
        update({ names: next })
      }

      function update(patch, doneMessage) { act(UPDATE, { patch: patch }, doneMessage) }

      return h('div', { style: { width: '100%', maxWidth: 720 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 10px' } },
          h('span', { style: { fontWeight: 700, fontSize: 15 } }, '桌宠'),
          h('span', { style: muted }, '驱动插件 dsh-agentic-pet'),
          h('span', { style: { flex: 1 } }),
          h(SButton, { onClick: refresh, disabled: busy }, '刷新')),
        msg ? h('div', { style: { fontSize: 12, margin: '0 0 6px', color: msg.indexOf('失败') >= 0 ? '#ff7369' : 'inherit' } }, msg) : null,

        // ── 状态（每宠一行） ──
        h(Section, { title: '宠物' },
          pets.length
            ? pets.map(function (p) {
              return h('div', { key: p.id, style: row },
                // Uncontrolled + commit-on-blur/Enter: typing is LOCAL until the
                // edit completes — a per-keystroke update would fire a [改名]
                // turn per character.清空 + 失焦 = 恢复默认名。
                h('input', { style: Object.assign({}, inputStyle, { width: 120, fontWeight: 700 }), defaultValue: petName(p.id), title: '改名后点击空白处或回车生效；清空恢复默认',
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

        // ── 好感度（每宠独立账本） ──
        h(Section, { title: '好感度' },
          (function () {
            var bookIds = affection && typeof affection === 'object' ? Object.keys(affection) : []
            var ids = []
            pets.forEach(function (p) { if (ids.indexOf(p.id) < 0) ids.push(p.id) })
            bookIds.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id) })
            if (!ids.length) return h('div', { style: muted }, '还没有互动记录')
            return ids.map(function (id) {
              var book = (affection && affection[id]) || { affection: 0, total: 0 }
              var name = petName(id)
              return h('div', { key: id, style: row },
                h('span', { style: { fontWeight: 700 } }, name),
                h('span', { style: { fontSize: 18, fontWeight: 700 } }, String(book.affection ?? 0)),
                h('span', { style: muted }, '/ 100 · ' + moodOf(book.affection ?? 0) + ' · 羁绊：' + bondTier(book.bond ? (book.bond.value ?? book.bond.days ?? 0) : 0) + '（' + String(book.bond ? (book.bond.value ?? book.bond.days ?? 0) : 0) + ' 天）'),
                h('span', { style: muted }, '累计 ' + String(book.total ?? 0) + ' 次'))
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
            '唤醒间隔',
            h('input', { style: inputStyle, value: String(iv.wakeIntervalMinutes ?? 2), onChange: function (e) {
              var v = parseInt(e.target.value, 10)
              if (Number.isFinite(v)) update({ innerVoice: { wakeIntervalMinutes: v } })
            } }),
            '分钟'),
          h('div', { style: row },
            '请求模型的概率',
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
            h('input', { style: Object.assign({}, inputStyle, { width: 340, flex: '1 1 260px' }), value: String((iv.boundSessions && iv.boundSessions.electron) || ''), placeholder: '会话 id，留空 = 自动管理', onChange: function (e) {
              var v = e.target.value.trim()
              var next = Object.assign({}, iv.boundSessions || {})
              if (v !== '') next.electron = v
              else delete next.electron
              update({ innerVoice: { boundSessions: next } })
            } })),
          h(Hint, null, '宠物在自己专属的会话里醒来，用气泡和动作自主表达；那条「鲸鱼娘的内心戏」会话可在会话列表查看，也可以直接在那里和它聊天。用户忙于会话或宠物表达未完成时不会打扰。会话模式切换只对新建会话生效：归档旧会话后，她会在下次对话时自动换代重建（旧会话记忆不迁移）。指定会话立即生效——下一次对话就用新绑定的会话；清空后自动回落到她之前的会话（那条若已被归档，会自动创建新的）。')),

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
