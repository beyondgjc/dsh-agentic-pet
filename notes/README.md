# Agent Notes — 决策/提案记录

借鉴 dsh（deepseek-harness 的 `.agents/notes/` Agent Note 体系），按本仓规模裁剪。一条 Agent Note 记录一个影响本仓的决策或提案——**为什么这么定、放弃了什么**：这部分代码、测试和文档承载不了，commit message 又只能事后写、不可链接、不可维护。事实性的「现在怎么用」归 [AGENTS.md](../AGENTS.md) 代码地图和 DETAIL.zh.md；仓外的需求长文档（`~\whale598\docs\pet-*-requirements-*.md`、Obsidian 技术文档）继续住仓外——这里只住「为什么」。

## 布局与命名

`notes/{生命周期}/{类别}/yyyy-mm-dd-主题.md`，路径即元数据：

- **生命周期**（顶层目录）= 状态，文件随状态迁移：
  - `proposed/` — 实现前的提案评审；还没做（或只做了一半）。这是「需求 spec」的家：计划、迁移步骤、开放问题都写在未来时态里。
  - `implemented/` — 已落地；记录决策与被否掉的备选，并**与代码保持同步**（见下）。
  - `rejected/` — 评审后否掉；提案原文冻结，否决理由写在 `Status:` 行。
  - `archived/` — 历史决策价值仍在、前瞻指导弱化的，整篇挪入；封存后不再编辑。
- **类别**（嵌套目录）= 决策类型，闭集：`feature`（新能力）/ `bug-fix`（修缺陷、收根因）/ `architecture`（结构性决策）/ `process`（流程、发布、双仓纪律）/ `testing`（测试策略）。
- 文件名日期 = 该主题**首次提出**的日期（按 git history），不是写作日期。

## 文件格式

每篇开头三行固定（token 保持英文）：

```markdown
# Agent Note: <标题>

Status: proposed
```

`Status:` 取值三选一：`proposed` / `implemented` / `rejected — <一句为什么>`（只有 rejected 带内容，因为否决理由就是读者要的答案）。状态不带日期——日期在文件名和 git 里。

正文骨架按生命周期：

| 生命周期 | 骨架 |
| --- | --- |
| proposed | `## Problem` → `## Proposal` → `## Alternatives considered` → `## Acceptance criteria` → `## Risks` |
| implemented | `## Problem` → `## Decision` → `## Alternatives considered` → `## Consequences` |
| rejected | 提案原文冻结 + `Status: rejected — 理由` |

- `## Problem` 写动机，要求脱离方案独立成立。
- `## Proposal` 可讲未来时态；`## Decision` 必须现在时、描述已交付的现实。
- **`## Alternatives considered` 强制**：每个真实备选和它为什么输，一段一个。决策不记它打败了谁，就会招来重新翻案。备选只记录真实讨论过的，不凭空补写；格式建立之前的老决策无法还原时，在正文开头加一行回填说明（见现存三篇的写法）。

## 转正与否决（机械改写）

- **proposed → implemented**（落地的同一批改动里完成）：`## Proposal` 重写为现在时的 `## Decision`；`## Acceptance criteria` 与 `## Risks` 并入 `## Consequences`（已被测试钉住的行为可写成现在时的 `## Testing` 段）；计划腔内容（迁移步骤、开放问题）删除。implemented 里保留提案腔标题（`## Proposal` / `## Plan` / `## Acceptance criteria`）是格式错误。
- **proposed → rejected**：只在 `Status:` 行补否决理由，正文冻结。
- note 永不改写成**相反的决策**——推翻 = 新开一篇 + 两篇相互链接；被完全取代的旧篇按归并规则收编后删除（独有理由必须先搬进新篇）。
- **implemented 与代码同步**：同一批改动里更新路径、符号、默认值等事实（改决策本身不行，见上）。代码挪了、改名了、换键了，note 的事实跟着改——这是义务不是可选。

## 何时写

- 实质性功能、行为决策、根因收口、流程纪律——**在同一 PR/commit 里**写或更新对应 note；大型未来工作从 `proposed/` 起步。
- 只写**持久的决策理由**；机械改动、局部 UI 调整、口径微调不写。已有 note 归属这个决策时更新它，不重复建。
- **commit message 保持一行**（conventional commits 不变），长理由搬进 note，在 message 尾部指路（如 `notes/implemented/feature/2026-11-15-….md`）。

## 其他约定

- **语言**：中文正文；`# Agent Note: ` 与 `Status:` 两个 token 保持英文。不做双语镜像——将来要加，按根 README.i18n.yaml 的 sidecar 模式扩展。
- **交叉引用**用相对 markdown 链接（`[主题](../architecture/2026-10-30-….md)`），不裸写文件名或序号——目录迁移不断链、可机械校验。
- 引用**仓外文档**（whale598 需求文档、Obsidian）时注明「仓外，不在 git」；note 只记决策与取舍，不复制需求全文。
- **notes 只住发布仓**（与 README/AGENTS 同侧），不参与 monorepo 镜像纪律：`sync-from-monorepo.cmd` 的拷贝清单不含 `notes/`，两侧都不需要同步它。
- 初期不挂机器门禁，格式靠 review；篇数上来后可把 dsh 的 `verify-agent-note-format` 思路抄成本仓脚本进 pre-commit。
