# pet 工具调用评测集（eval/）

目标：**保障模型对 14 个 `pet_*` 工具的调用准确**——工具选择、参数形态、语义纪律、报错自纠。这是模型行为评测（数据集 + harness 真跑模型），不是 driver 代码的单测（那由 `tests/` 承担）。

## 组成

| 路径 | 职责 |
|---|---|
| `schema.ts` | 场景/种子/断言的类型（`EvalScenario` = seed + turn + expect + ideal） |
| `mock-pet.ts` | mock PetService：**真实鲸鱼资产**（body.json/actions.tags.json）经同一套 normalize 函数喂给工具层；/say、/action、/expression、/events 全量记录 |
| `harness.ts` | 临时目录物化种子 → 真实 `registerPetTools` 捕获 14 个工具 → 真实 inner-voice prompt 构造器组装回合 → 工具回合循环 |
| `llm-client.ts` | OpenAI 兼容 chat/completions（环境变量驱动，厂商无关）+ ToolDefinition → JSON Schema 转换 |
| `grader.ts` | 确定性评分（无 LLM judge）：selection / args / outcome / discipline 四维 + 汇总报告 |
| `scenarios/*.ts` | 数据集 12 文件 ~133 条（say/do/state-express/digest/journal/recall/interactions-affection/schedule-wake/set-rhythm/letter-inbox-board/multipet/turns） |
| `dryrun.spec.ts` | **常驻 vitest**：数据集完整性 + 金标准回放（每条 ideal 经真实工具跑通且满分）——不需要任何 API key |
| `run.spec.ts` | 真跑入口（环境变量齐备才执行） |

## 场景的四个字段

```ts
seed   // 初始状态：在线宠、账本、本子、记事板、信箱、闹钟、绑定会话、限频窗口……
turn   // driver 会 fabricate 的回合：wake / touch / chat / dream / greet / cross / raw
expect // 评分标准：期望调用序列（含参数断言）、forbidden、maxCalls、finalTextAny、argNeverContains
ideal  // 金标准调用序列：干跑用真实工具回放，证明种子可达、断言可满足、教学报错真会触发
```

关键设计：

- **mistake 步**（`ideal` 里的刻意错误调用）只在干跑回放——它钉住「教学报错真的会发生」（`errorMatches` 正则），但模型评分自动排除（真实模型未必犯错，犯错由 `recovery` 指标单独统计）。
- **setup 步**是环境铺设（打满限频窗、预置板子字条），不参与评分。
- **确定性 id**：固定 `at` + 文本的 journal/board 种子，id 用 `journalSeedId`/`boardSeedId` 在场景文件里复算——pin/unpin/void/reply 的断言永远指向真实存在的条目。
- **verify 钩子**：跑完后检查副作用（气泡路由到哪只宠、信有没有归档、/say 线路是否带 letterAt）——调用准确不止看参数，还看落点。

## 跑法

```bash
# 干跑（无网络、无 key，随全量测试一起跑）
./node_modules/.bin/vitest run eval/dryrun.spec.ts

# 全量 vitest（干跑常驻其中）
./node_modules/.bin/vitest run

# 真跑（填你自己的端点；OpenAI 兼容协议）
PET_EVAL_BASE_URL=https://api.deepseek.com \
PET_EVAL_API_KEY=sk-xxx \
PET_EVAL_MODEL=deepseek-chat \
./node_modules/.bin/vitest run eval/run.spec.ts

# 只跑一部分（按 id/family 子串过滤）、调并发/温度/步数上限
PET_EVAL_FILTER=say PET_EVAL_CONCURRENCY=4 PET_EVAL_TEMPERATURE=0.2 ./node_modules/.bin/vitest run eval/run.spec.ts
```

报告落盘在 `eval/report/`（gitignored）：`run-<时间戳>.json`（全量逐场景）+ `summary-<时间戳>.md`（人读汇总）。

## 指标口径

- **四维**：selection（期望工具按序出现）/ args（参数断言）/ outcome（成功或按预期报错）/ discipline（forbidden、maxCalls、maxTotal、finalTextAny、argNeverContains）。
- **首发零报错**（firstTry）：无 mistake 步的场景里，所有调用一次成功的比例。
- **报错自纠**（recovery）：含 mistake 步的场景里，最终期望步仍然落地的比例——driver 的教学式报错（发生了什么/为什么/下一步）是否真能带模型回到正轨。

## 已知行为备注（写场景时实测）

- `pet_set_rhythm` 对小数是**静默取整**而非报错（`Math.round` 后落入范围即通过，如 0.5→1）——工具描述说「whole number」，实现却是取整。场景 `rhythm-sub-minute-recover` 只测真正越界（0.2→0<1）的路径；若将来 driver 改为拒绝式校验，把该场景改回非整数报错即可。
- `pet_inbox`/`pet_board` 等在无绑定会话上先撞 `requireOwnedSession` 的通用教学文案（「本会话没有绑定宠物」），到不了各自的专属文案。
- whale 身体的 `expressions.supported: false`（fallback 动作 `点击回应-害羞惊讶`）——pet_express 的不支持分支返回 `performed:false` 而非 throw。

## 纪律（接手前必读）

- driver.ts 里新增了 `petEvalSeam()`（评测缝隙：把模块级 `voiceOwners/voicePetMessages/voiceWakePlans/crossPetLog` 交给 harness 读写）。**下次向 monorepo 镜像时必须带上**（AGENTS.md §1 反向同步规则）；生产代码路径不使用它。
- 改了 `src/` 记得重建 `lib/` 并保持双向镜像；评测代码只写发布仓。
- 场景命名 `{family}-{case}` 全局唯一；断言 shorthand 与 id 复算工具都在 `scenarios/helpers.ts`，别在场景文件里手搓。
