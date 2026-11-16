# Agent Note: 信箱浮层的可见性上报与点击命中

Status: implemented

落地于 2026-11-13（monorepo 1bbeb96269 / 1e67fe147c，发布仓 911d5e3 + 0e41848，产物换代 6cacc9b）。关联：信件独立浮层 letterBox 本身是另一条决策（信是物件、与说话气泡分离——共用 `#bubble` 的信会被任何后续 pet_say 的 replaceChildren 清场丢失）。

## Problem

信封**看得见但点不动**：点击全部落到桌面。修掉第一根因后症状复发成另一形态：说话让位、气泡空档、信回归之后点击又死了；且「收好」一封后下一封未读不展示。两层症状指向同一个缺口——**渲染层知道的可见性状态，主进程不知道**。

## Decision

主进程的点击穿透判定只在 `bubbleVisible=true` 时让 `bubbleRect` 参与命中；信占的就是 bubble 区，所以信的可见性翻转**必须同步上报**。三条具体规则：

1. **信封与信纸两态都上报 `bubbleVisible=true`**（信封态 = 密封不剧透；点击拆信翻盖 → 信纸全文 +「收好」）。这是语义复用：bubbleRect 的含义就是「这块区域吃点击」，不是「气泡在这个区域」。
2. **上报覆盖所有可见性翻转路径，不只投递/拆信/推进**：说话让位期间气泡空档的 800ms 轮询回归（syncLetterBox）只改 display 不上报，曾让 flag 停在 false。修复 = 可见性翻转时同步上报——信可见 → true；信走开**且**气泡也空 → 才 false。
3. **「收好」推进必须复位 `letterDismissed`**：否则 syncLetterBox 的闸门把重建的信封又藏回去（「收好一封，下一封没展示」的实测根因）。

配套决策：/say 的 letter 直投 `webContents.send`，不走 sayTts 投递——TTS 与气泡同发的竞速会把信 generation-abandon 掉（信永远不显示，实测踩过）。回执 fire-and-forget（letter-read 打 readAt，幂等，未匹配也算成功）。

## Alternatives considered

- **信沿用 `#bubble` 共用说话气泡**——输在生命周期冲突：说话气泡的 replaceChildren 清场会丢信，信必须有独立浮层（该决策在 letterBox 特性里，本篇只引用）。
- **新增独立的「信可点区」上报通道**（不复用 bubbleVisible/bubbleRect）——输在协议成本：主进程判定协议要跟着加一路 rect 通道，而 bubbleRect 的语义（这块区域吃点击）与信的需求完全同构；双通道换不来任何行为差异。
- **主进程放宽穿透判定（信存在时整窗可点）**——输在代价不对称：会牺牲桌面的正常穿透行为，为修一个渲染层状态上报缺口去改主进程协议，方向反了。

## Consequences

- 渲染层任何「显示状态变化」都必须视为对主进程判定的输入变化——新增浮层/物件时按本篇规则接上报，不再事后补。
- 验证口径已钉死：/status 的 bubble 三态断言（信封可见 true / 让位期间 / 回归后 true；清空后 false）——回归测试照这个三态写。
- `letterDismissed` 的复位语义与 letter-read 回执解耦：回执失败不阻塞推进。

## Testing

点击命中三态由实机 /status 断言覆盖（AGENTS.md 代码地图 carrier 行）；信封推进 + 未读顶替的回归在 carrier 渲染层手工口径（letterBox 队列：最新优先、收好一封顶一封）。

---

*回填说明（2026-11-17）：本篇自 git history（monorepo 1bbeb96269/1e67fe147c、发布仓 911d5e3/0e41848/6cacc9b）与 AGENTS.md 代码地图 carrier 行重建；Alternatives 为可还原部分。*
