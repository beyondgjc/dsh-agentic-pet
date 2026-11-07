# AGENTS.md — dsh-agentic-pet 开发/本地部署/发布手册

> 给后续接手的人（和 agent）：这个插件有两套仓库、两条构建链、一处本地安装点，
> 2026-11-07 的记忆召回系统开发在上面踩过一圈坑。本文记录现状与纪律，改动前先读。
> 全景技术文档（协议栈/端点契约/各模块深读）= Obsidian `DSH-PET 技术实现.md`（§6.9 = 记忆系统）；
> 记忆系统需求与修订台账 = `C:\Users\beyondguo\whale598\docs\pet-memory-recall-requirements-v0.2.md`。

## 1. 双仓结构（最重要）

| 仓 | 路径 | 角色 |
| --- | --- | --- |
| **发布仓**（本仓） | `Agents/dsh-pet/dsh-agentic-pet` | npm 包 `dsh-agentic-pet` 的家；拥有版本号；`lib/` 构建产物入库；README/AGENTS 在这 |
| **monorepo**（dev upstream） | `Agents/dsh-pet/dsh/deepseek-harness` | 插件源码的 monorepo 副本：`packages/bundle/pet-app`（插件）+ `apps/pet`（carrier 源码）；workspace 版本号（0.2.1-rc.3），tsdown/tsconfig 是 monorepo 版（**别互相覆盖这两个文件**） |

- `scripts/sync-from-monorepo.cmd` 单向镜像 monorepo → 发布仓（src/client/tests/cordis/package.json 字段/lib/presets/carrier 产物/carrier-src）。**它不认识发布仓新写的代码——monorepo 落后时跑它会把发布仓覆盖回旧稿。**
- 反向同步没有脚本，手工镜像：发布仓的 `src/*.ts`、`tests/*.ts`、`client/`、`presets/`、`carrier-src/src` → monorepo 对应位置；`package.json`（版本差异是设计）、`tsdown.config.ts`、`tsconfig.json` 不带过去。
- **纪律：改完任一侧，另一侧立刻跟上，用逐字节 diff 核验**（2026-11-07 之前 monorepo 落后了整整一个 0.4.x 周期，差点被 sync 脚本清掉）。

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

# 2) tsdown 打包：lib/types/index.js + tools.js → lib/index.js + lib/tools.js + 一个 hash chunk
rm -f lib/driver-*.js        # 先删旧 chunk 再打包！tsdown 是 clean:false
./node_modules/.bin/tsdown

# 3) 验证：lib/ 只能有一个 driver-*.js；index.js 引用它；模块能独立加载
grep -c "driver-" lib/index.js
node --input-type=module -e "await import('./lib/index.js')"
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
# 前置：工作树干净（release.mjs 会拒绝）、测试全绿、lib 单 chunk
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

## 7. 代码地图（记忆系统相关）

| 文件 | 职责 |
| --- | --- |
| `src/journal.ts` | 哈希链 journal 存储：条目格式（tags/entities/echo/voids/window）、append（防回声）、rotate（保留 pin + 置位 pendingEpoch）、meta（pin 名单/epoch 记账，跨重写保留） |
| `src/journal-recall.ts` | 召回半边：CJK bigram 分词、派生索引（digest 快检+确定性重建）、recallJournal（min(2,词数) 门槛/自动降级/去重/matchedBy/excluded/belowThreshold/totalMatched）、epochs、pin/void、注入预算制（budgetWake）、last-recall 留痕 |
| `src/inner-voice.ts` | 唤醒/触摸/对话 prompt 构造；journal 与 epoch 索引行的渲染；"回忆不是新事实"边界声明 |
| `src/driver.ts` | 工具注册（`pet_journal` 六个 op、`pet_recall`）、唤醒路径接线 |
| 需求文档 | 仓外（不在 git 里）：`C:\Users\beyondguo\whale598\docs\pet-memory-recall-requirements-v0.2.md`（§11.1 是三轮实测修订台账） |
| 全景技术文档 | Obsidian：`C:\Users\beyondguo\Documents\Obsidian Vault\DSH-PET 技术实现.md`（协议栈/八端点契约/各模块深读；§6.9 记忆系统；本手册是它的操作面补充） |

## 8. 本地安装点速查

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/profiles/desktop/node_modules/dsh-agentic-pet` | 已安装插件（0.4.9 manifest + 0.4.12 lib，待下次插件页更新对齐） |
| `~/.dsh/profiles/desktop/node_modules/dsh-agentic-pet.bak-0.4.9-20261107` | 0.4.9 回滚点 |
| `~/.dsh/whale598/pet-settings.json`（+.bak-20261107） | 运行配置（注入预算已开启） |
