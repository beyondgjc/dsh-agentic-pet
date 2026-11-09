# AGENTS.md — dsh-agentic-pet 开发/本地部署/发布手册

> 给后续接手的人（和 agent）：这个插件有两套仓库、两条构建链、一处本地安装点，
> 2026-11-07 的记忆召回系统开发在上面踩过一圈坑。本文记录现状与纪律，改动前先读。
> 全景技术文档（协议栈/端点契约/各模块深读）= Obsidian `DSH-PET 技术实现.md`（§6.9 = 记忆系统）；
> 记忆系统需求与修订台账 = `C:\Users\beyondguo\whale598\docs\pet-memory-recall-requirements-v0.2.md`。

## 1. 三仓结构（最重要）

| 仓 | 路径 | 角色 |
| --- | --- | --- |
| **发布仓**（本仓） | `Agents/dsh-pet/dsh-agentic-pet` | npm 包 `dsh-agentic-pet` 的家；拥有版本号；`lib/` 构建产物入库；README/AGENTS 在这 |
| **monorepo**（dev upstream） | `Agents/dsh-pet/dsh/deepseek-harness` | 插件源码的 monorepo 副本：`packages/bundle/pet-app`（插件）+ `apps/pet`（carrier 源码）；workspace 版本号（0.2.1-rc.3），tsdown/tsconfig 是 monorepo 版（**别互相覆盖这两个文件**）；remote 是 deepseek-ai 上游，**feat/pet-surface 分支只能本地提交** |
| **素材源**（legacy 仓） | `Agents/dsh-pet/dsh-pet-indesktop` | **媒体与清单的真源**：`assets/characters/shenshen/`（body.json / actions.tags.json / videos）。remote 是上游作者（MerZlin），同样只能本地提交 |
| **素材发布仓** | `Agents/dsh-pet/dsh-pet-assets` | npm 包 `dsh-agentic-pet-assets`；**`assets/` 整树被自己的 .gitignore 忽略**（build-payload.cmd 的暂存区，shenshen→whale 改名在铺送时发生）——**改素材必须改 indesktop 源，再跑 build-payload.cmd 重铺**，直接改 assets/ 会在下次重铺时丢失（2026-11-08 实测踩过） |

- `scripts/sync-from-monorepo.cmd` 单向镜像 monorepo → 发布仓（src/client/tests/cordis/package.json 字段/lib/presets/carrier 产物/carrier-src）。**它不认识发布仓新写的代码——monorepo 落后时跑它会把发布仓覆盖回旧稿。**
- 反向同步没有脚本，手工镜像：发布仓的 `src/*.ts`、`tests/*.ts`、`client/`、`presets/`、`carrier-src/src` → monorepo 对应位置；`package.json`（版本差异是设计）、`tsdown.config.ts`、`tsconfig.json` 不带过去。
- **纪律（三条，全部实测踩过）**：① 改完任一侧，另一侧立刻跟上，用逐字节 diff 核验（2026-11-07 之前 monorepo 落后了整整一个 0.4.x 周期）；② **每批改动只允许一个镜像方向**——release↔monorepo 两侧都有未同步改动时，先对齐再开工，末尾的收尾 cp 会把先做的改动冲掉（body.ts 多矩形、B06 渲染层消费都被这样冲过一次）；③ 镜像完成后 grep 抽查关键标记（如 `readIdleBias`）确认双向都在。

## 2. 本地开发（发布仓直连）

```bash
# 测试（自包含，只要 cordis + vitest）
./node_modules/.bin/vitest run            # 全量 12 文件；journal-recall.spec.ts 是记忆系统

# 快速类型检查（发布仓宽松 flags）
./node_modules/.bin/tsc --ignoreConfig --noEmit --skipLibCheck --allowImportingTsExtensions \
  --module esnext --moduleResolution bundler --target es2024 --lib esnext --types node --strict \
  src/journal.ts src/journal-recall.ts src/inner-voice.ts src/driver.ts

# 严格检查（monorepo 同款，防积压——发布仓积压过 35 处 exactOptionalPropertyTypes 违规就是这么来的）
#   在上面的命令里加 --exactOptionalPropertyTypes
```

**monorepo 强制的规矩**（本地不守，反向同步时 monorepo 的 tsc/oxlint 会全拦）：
- `exactOptionalPropertyTypes: true`：可选属性**不许显式写 undefined**。用条件展开：`...(x === undefined ? {} : { x })`。注意 narrowing 陷阱——`...(f(a) === undefined ? {} : { v: f(a) })` 两次调用不被收窄，先提 hoist 成 const。
- 禁用非空断言 `!`：数组 bigram 用 `slice(i, i+2).join('')`，取值用显式判空。
- 行宽 ≤140；`let` 若有初始化器且确会重赋值，别顺手改成 const（oxlint prefer-const 对"声明后闭包内首赋值"会误报，加 `= undefined` 初始化器可两全）。
- 行尾：仓库规范 **LF**（.gitattributes 强制）。用 python 打补丁时必须检测/保持原行尾，混入 CRLF 会被 pre-commit 的 whitespace 检查拦下。

## 3. 构建（发布仓两段式）

```bash
# 1) tsc emit：src/*.ts → lib/types/*.js（.ts 后缀导入靠 --rewriteRelativeImportExtensions 重写成 .js）
./node_modules/.bin/tsc --ignoreConfig --rootDir src --outDir lib/types \
  --module esnext --moduleResolution bundler --target es2024 --lib esnext --types node --strict \
  --skipLibCheck --declaration --declarationMap --sourceMap --rewriteRelativeImportExtensions

# 2) tsdown 打包：lib/types/index.js + tools.js + persona.js → 三个入口 + 两个共享 hash chunk
#    （driver-* + service-*：persona 入口与 tools 共享 service/petdata，tsdown 拆出第二个 chunk）
rm -f lib/driver-*.js lib/service-*.js   # 先删旧 chunk 再打包！tsdown 是 clean:false
./node_modules/.bin/tsdown

# 3) 验证：lib/ 恰好一个 driver-*.js 和一个 service-*.js（release.mjs 同款校验）；各入口能独立加载
grep -c "driver-" lib/index.js && grep -c "service-" lib/persona.js
node --input-type=module -e "await import('./lib/index.js'); await import('./lib/persona.js')"
```

`lib/` 是入库产物——**改了 src 必须重建并一起提交**，不许 src 和 lib 漂移。
（历史事故：按文件名排序删"旧 chunk"，hash 顺序一变删掉了新的，部署了断链的 lib——冒烟测试当场抓住。所以先删后建。）

## 4. 本地部署测试

安装点：`~/.dsh/profiles/desktop/node_modules/dsh-agentic-pet/`（拷贝式安装，非链接）。

```bash
P="$USERPROFILE/.dsh/profiles/desktop/node_modules/dsh-agentic-pet"
cp -r "$P" "$P.bak-<旧版本>-<日期>"     # 先备份（回滚就靠它）
rm -rf "$P/lib" && cp -r lib "$P/lib"   # 通常只换 lib/；presets/client/cordis 若有变一并核
cd "$P" && node --input-type=module -e "await import('./lib/index.js')"
```

- 宿主（DeepSeek Harness 桌面端）要**重启才重载插件**；carrier 是独立进程（`start-pet.cmd`，从 `~/.dsh/whale598/pet-surface-url.json` 取地址）。
- 运行配置：`~/.dsh/whale598/pet-settings.json`（journal 注入预算等），改前备份。
- 宠物数据目录：`~/.dsh/whale598/<petId>/`（journal.md / archive / epochs / index / last-recall）。
- **发布仓的 `carrier-src/` 从不在本地编译**（它只是 monorepo `apps/pet` 的参考镜像）——carrier 的 bug 在这里全是潜伏的（/expression 引用未定义 `body` 潜伏了一整版）。改过 carrier-src 后必须在 monorepo 跑 `pnpm run build` 验证。

## 5. 发布

```bash
# 前置：工作树干净（release.mjs 会拒绝）、测试全绿、lib 双 chunk（driver+service）
node scripts/release.mjs 0.4.13 --dry-run   # 预检：版本、包清单，不发不提交
node scripts/release.mjs 0.4.13             # npm publish + commit "chore(release): X.Y.Z" + tag vX.Y.Z
git push --follow-tags
```

- 版本必须严格递增；脚本失败会自动还原 package.json。
- **验证发布结果别用 `npm view`**——本机 `~/.npmrc` 指向镜像（release.mjs 显式传 `--registry` 直发官方源），`npm view` 读镜像会滞后甚至 ENEEDAUTH。用直查：

```bash
curl -s "https://registry.npmjs.org/dsh-agentic-pet?cb=$(date +%s%N)" -o meta.json
python -I -c "import json; d=json.load(open('meta.json',encoding='utf-8')); print(d['dist-tags'])"
```

## 6. 提交约定

- Conventional commits，中文 subject 常见：`feat(pet): …`、`fix(pet): …`、`chore(release): X.Y.Z`（这个只能由 release.mjs 产生）。
- pre-commit 是 lefthook：oxlint（`scripts/run-oxlint.ts --config .oxlintrc.staged.json`，带 `--fix`）+ whitespace 检查 + vendor manifest guard。**lint --fix 会让第一次 commit 失败**——`git add -A` 再 commit 一次即可；whitespace 失败优先怀疑行尾。
- 单仓提交前跑一遍 `vitest run`；动了 src 就重建 lib。

## 7. 代码地图（记忆系统 + 身体系统）

| 文件 | 职责 |
| --- | --- |
| `src/journal.ts` | 哈希链 journal 存储：条目格式（tags/entities/echo/voids/window）、append（防回声）、rotate（保留 pin + 置位 pendingEpoch）、meta（pin 名单/epoch 记账，跨重写保留） |
| `src/journal-recall.ts` | 召回半边：CJK bigram 分词、派生索引（digest 快检+确定性重建）、recallJournal（min(2,词数) 门槛/自动降级/去重/matchedBy/excluded/belowThreshold/totalMatched）、epochs、pin/void、注入预算制（budgetWake）、last-recall 留痕 |
| `src/body.ts` | body/1 自述校验：behavior 能力 kind 分流（facing/idle/transition）、hitboxes 单矩形/多矩形（tail 双尾鳍）、resolveExpressionRequest/suggestExpressionFallback |
| `src/idle-selector.ts` | 待机选择器纯函数：白名单池过滤（idleEligible/facing 排 noMirror/noRepeat 回落）、加权随机 + 时段偏置（max-not-product）、区间采样抖动、朝向迟滞判定；RNG 可注入（mulberry32） |
| `src/inner-voice.ts` | 唤醒/触摸/对话 prompt 构造；journal 与 epoch 索引行的渲染；touchPartWording（head/body/tail/hand）；"回忆不是新事实"边界声明 |
| `src/persona.ts` | 人设 row（两个 preset 挂载，替换 @deepseek-ai/dsh-persona 独占 deployment:persona-prefix 段）：角色卡读 pet-settings.json `persona`（readPersonaCard 同步读，空/缺回落 DEFAULT_PERSONA，8000 字截断），拼在 yml 静态身体规则前；interpolate:false + 每次组装重读，改人设下一轮即生效 |
| `src/carrier-summon.ts` | 召唤决策纯函数（planSummon：no-webserver → NO_SPAWN → carrier 目录 → electron 可得性的优先级门）；副作用半边在 index.ts `summonCarrier`——child exit 复位 `carrierLaunched` 一次性闸后经 spawnPetCarrier 重拉，路由 `POST /api/pet-settings/summon`（settings-page），客户端召唤卡在 pet-settings.js（在线即隐藏 + 4s 轮询确认） |
| `src/instances.ts` | 多实例注册表（Phase 1，设计文档 §12）：desired set 读写（whale598/multi-instances.json）、id 算术（nextInstanceId）、召唤准入（admitSummon：上限+去重）；index.ts `instanceControl`（summonInstance/dismissInstance）+ 路由 instance/summon|dismiss + carrier `--user-data-dir` 按实例隔离（锁作用域 = userData） |
| `src/board.ts` | 客厅记事板（Phase 2，设计文档 §5）：共享留字区（pet-board.json，cap 20/回复 10/字 200）；反收音机三禁（不打断/自言自语不自动上板/不合并流）——注入只报数与来源，注入即已读（游标 whale598/<petId>/pet-board-cursor.json）；工具 pet_board（read/leave/reply） |
| `src/driver.ts` | 工具注册（`pet_journal` 六个 op、`pet_recall`）、唤醒路径接线、readAutonomy（autonomy + idleBias 载荷）；**绑定防呆**（`sessionOccupiedBy` 拒绝跨宠占用同会话——一只宠物一个脑子）+ **knownPetIds 动态清扫**（registry + 宠物目录，60s 一轮，不硬编码宠物种类） |
| `src/rhythm.ts` | 静默时段 + B06 时辰偏置表（readIdleBias：默认 凌晨安静系×1.5/活跃系×0.5，可配可 null 关） |
| carrier `apps/pet/src/renderer/main.ts` | 身体的呈现半边：WebGL stage 绘制、镜像（scaleX(-1) + 命中折返）、idle theater 双模式（bodyIdle 接管/legacy）、touchPartOf（body.json 驱动 + 特定优先）、**双缓冲已回退**（单元素直换，见 §9）、bodyRuntime.lastClip 记最近播放的 one-shot（非 src 快照——快照口径在动作窗口外永远拍到基础循环） |
| carrier `apps/pet/src/main.ts` | 光标轮询喂 pet:cursor（click-through 轮询顺带）、readActionTags（_meta 守卫 + idleEligible）、text_clips no_mirror 合入 catalog、/status 透传 bodyRuntime、runtimeLog 诊断落盘 |
| 需求文档 | 仓外（不在 git 里）：`C:\Users\beyondguo\whale598\docs\pet-memory-recall-requirements-v0.2.md`（§11.1 三轮实测修订）、`pet-body-requirements-v0.2.md`（§13 变更记录） |
| 全景技术文档 | Obsidian：`C:\Users\beyondguo\Documents\Obsidian Vault\DSH-PET 技术实现.md`（协议栈/八端点契约/各模块深读；§6.9 记忆系统；本手册是它的操作面补充） |

## 8. whale598 文件归属规则（2026-11-10 起，防劣化）与本地安装点速查

**三层规则**——新状态落盘前先回答「这是哪一层的」：

| 层 | 位置 | 放什么 | 例 |
| --- | --- | --- | --- |
| **宠物私有** | `whale598/<petId>/` | 单写者、按实例隔离的宠物状态 | journal/epochs/events/affection/pet-name（原有）+ pet-inner-voice / pet-wake-plans / pet-wake-state / pet-binding-status / pet-window / pet-world / pet-board-cursor（2026-11-10 收口起） |
| **插件/宿主级** | `whale598/` 根 | 插件配置、宿主定位、跨宠比较性账本、机器层键控目录 | pet-settings.json、pet-surface-url.json、electron-runtime.json、pet-interactions.json、pet-messages.json、pet-board.json（客厅记事板——跨宠公共空间）、multi-instances.json（多实例 desired set + 上限）、pet-http.d/（按实例清单）、carrier-instances/（每实例 Chromium userData——机器层，不进宠物数据目录）、carrier-*.log、pet-driver.log |
| **legacy 只读** | `~/.dsh/` 根 | 上一代布局的只读回退（readPetStateJson/readGlobalJson 兜底链的最末层） | 不要再往这里写 |

**准入规则（硬性）**：禁止在 `whale598/` 根上**新增按 petId 分键的文件**；宠物私有状态一律走 `petdata.petStatePaths` / `readPetStateJson` / `writePetStateJson`（读走三层回退链，写直达宠物文件）。petId 来源：载体 spawn env `DSH_PET_ID`（现恒 `'electron'`，多实例时传不同 id）+ `petdata.existingPetIds()`。

**已知例外（数据模型天然跨宠物，单写者 = driver，拆分无并发收益）**：pet-interactions.json（跨宠竞速账本，每条带 `pet` 字段）、pet-messages.json（跨宠投递）留根。

**一次性迁移**：installPetDriver 里 `migrateGlobalSplits` 把旧的按 petId 分键根文件切片进宠物目录（已存在的宠物文件优先，绝不覆盖），根副本改名 `<name>.bak-migrated-<date>`——验证无误后可手工删除这些 .bak。守护测试：`tests/petdata-layout.spec.ts`（切分正确性 + **根目录不得残留 B 类文件**的自动化断言）。

### 本地安装点速查

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/profiles/desktop/node_modules/dsh-agentic-pet` | 已安装插件（lib/carrier 手工部署到最新；manifest 0.4.9 待下次插件页更新对齐） |
| `~/.dsh/profiles/desktop/node_modules/dsh-agentic-pet.bak-0.4.9-20261107` | 0.4.9 回滚点 |
| `~/.dsh/profiles/desktop/node_modules/dsh-agentic-pet-assets/assets/characters/whale` | 已安装素材（body.json/actions.tags.json 手工同步到最新） |
| `~/.dsh/profiles/desktop/vendor/dsh-pet-app/lib` | carrier main 的另一个部署位（历史遗留；当前运行体 = 插件包 carrier/，见进程命令行） |
| `~/.dsh/whale598/pet-settings.json`（+.bak-20261107） | 运行配置（注入预算已开启） |
| `~/.dsh/whale598/<petId>/` | 各宠物私有状态目录（规则见上） |
| `~/.dsh/whale598/carrier-runtime.log` | **载体诊断主日志**（渲染层 console ≥info + 窗口移动 bounds）——排查触摸命中/朝向/待机的第一现场 |
| `~/.dsh/whale598/carrier-boot.log` | 载体启动标记（`[pet] boot: … body=body/1` = 跑的哪一版） |

## 9. 实战坑单（2026-11-07/08 身体迭代汇总，按杀伤力排序）

1. **部署后必须验包内容**：`lib/` 与 `carrier/dist-renderer` 的 chunk 是内容哈希命名——部署完 `grep` 一个本轮新符号（如 `readIdleBias`、`idleNextAt`）确认真的进了包。三次事故（断链 chunk、覆盖回旧版、lib 未重部署）都是"改了/构建了但没验"造成的。
2. **单向批量**：release↔monorepo 的收尾 cp 只能有一个方向；两侧都有改动时先对齐（body.ts 多矩形、B06 渲染层消费都被收尾 cp 冲掉过）。
3. **素材改源不改暂存**：`dsh-pet-assets/assets/` 整树 gitignored，是 build-payload 的暂存区——改 `dsh-pet-indesktop/assets/characters/shenshen/` 源，再跑 build-payload.cmd 重铺（shenshen→whale 改名发生在铺送时）。
4. **Electron 44 console-message 双签名**：事件对象（level 为字符串）与旧位置参数并存，按位置取值会全 undefined——诊断日志被静默过滤的事故根源。两种签名都接。
5. **渲染层 boot 报告竞态**：渲染层模块执行早于 main 注册 `pet:status-report`——首份报告必丢，idle 会话里没有后续 render 就永远不补。修复 = catalog（带 body）到达时强制补报（清 `reportedSnapshot` 去重位）。同类模式：任何"启动即发"的 IPC 都要确认对端 handler 已注册。
6. **oxlint 三连**：禁非空断言（bigram 用 slice().join('')）、行宽 140、prefer-const 对"声明后闭包内首赋值"误报（加 `= undefined` 初始化器）。
7. **heredoc 长脚本会断**：>150 行的 python 补丁用 Write 写文件再 `python file.py`，别用 `<<'EOF'`（实际行为不稳）；python 打补丁必须先做 CRLF 规范化。

## 10. 已知边界（身体迭代，2026-11-08）

- B04 双缓冲交叉淡入**已整体回退**（两轮实机失败：交叉期重影透底 + 单动作后冻结）——`capabilities.transition` 仍解析，渲染路径待带测试环境重做。
- tail/hand 命中区坐标来自单帧标注（`docs/body-hitboxes-preview.png`），未逐帧校准；`method: "clips"`（按朝向选片段）留作升级路径。
- B06 默认表对现白名单是统计性差异（10 片段中 3 个 ×1.5），观感 subtle——可调 `pet-settings.json rhythm.idleBias.weights`。
- carrier 的 `stdio: 'ignore'` 吞 stdout——诊断靠 `carrier-runtime.log`（§8），别再找 stdout。
