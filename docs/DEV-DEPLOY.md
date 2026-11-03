# 开发与部署指南（dsh-agentic-pet）

> 本仓库（release repo）是 dsh 桌宠插件的**发布之家**。它最初开发于 dsh monorepo
> （`dsh/deepseek-harness/packages/bundle/pet-app`），2026-10 起独立维护，monorepo
> 侧的副本已停在 0.2.1-rc.3（**不要**再从那边同步，见 §5）。
>
> 本文档整理 2026-11-03 落地「模型自主作息」特性时验证过的完整链路，供以后复用。

---

## 0. 部署通道现状（2026-11-04 起以 npm 为主）

桌面 profile（`~/.dsh/profiles/desktop/package.json`）已于 2026-11-03 被插件管理器切换为
**npm 安装形态**（`"dsh-agentic-pet": "0.4.5"`，node_modules 变成真实目录，vendor 的
symlink 被清除，vendor/dsh-pet-app 被清空）：

- **日常迭代 = 改码 → 本地构建（§3.2 的 tsc+tsdown）→ commit（构建产物 lib/ 随手进 repo），
  不发版**。攒批到用户拍板发版时才 `node scripts/release.mjs 0.4.x` → 桌面端插件页更新。
  发版前必查 `npm view dsh-agentic-pet version` 与 `git log`——多窗口并行可能已占用下一个
  版本号（0.4.6 撞号先例）。
- **§3 的 vendor 部署流程**仅在 profile 改回 `file:vendor/dsh-pet-app` 时才需要——流程命令
  保留备查；当前形态下向 vendor 拷贝是**无效写入**（运行时不读它）。
- ⚠️ 教训：部署前先核实通道——`cat ~/.dsh/profiles/desktop/package.json` 看依赖是
  `file:vendor/...` 还是版本号，node_modules/dsh-agentic-pet 是 symlink 还是真实目录。
  否则会出现「部署成功但运行时无感」的假象（本次三修复曾因此全部落空半天）。

---

## 1. 两个仓库的关系

| 仓库 | 路径 | 角色 | 现状 |
|---|---|---|---|
| release repo | `Documents/Agents/dsh-pet/dsh-agentic-pet`（git） | 源码 + 构建产物（`lib/` 也入 git）+ 版本/发布 | **唯一活跃**，0.4.4 |
| monorepo | `Documents/Agents/dsh-pet/dsh/deepseek-harness/packages/bundle/pet-app` | 历史开发上游 | 停在 0.2.1-rc.3，已分叉 |

- 版本只由 release repo 拥有（`scripts/sync-package-json.mjs` 负责镜像其余字段）。
- `tsconfig.json` 是"archival mirror"：真正的类型检查/构建配置在 monorepo 的
  tsconfig.base 里。本地重建需要自备临时 tsconfig（见 §3.2）。

## 2. 运行时部署形态（桌面端如何加载本插件）

```
~/.dsh/                                   ← dsh home（可用 DSH_HOME 覆盖，见 src/service.ts petHome()）
└─ profiles/desktop/
   ├─ package.json                        ← 依赖声明 "dsh-agentic-pet": "file:vendor/dsh-pet-app"
   └─ vendor/dsh-pet-app/                 ← ★ 部署目标（node_modules/dsh-agentic-pet 是指向它的 symlink）
      ├─ lib/        （tsdown 产物：index.js + tools.js + service-<hash>.js 共享 chunk + types/）
      ├─ client/     （设置页前端，源码直发）
      ├─ presets/    （pet.patch.yml / pet-inner-voice.patch.yml）
      ├─ cordis.patch.yml
      ├─ package.json
      ├─ carrier/    （Electron 宠物壳，仅 carrier-src 改动时才需要重建部署）
      └─ electron-bin/（vendor 独有，部署时不要动）
```

**部署 = 覆盖 `lib/ client/ presets/ cordis.patch.yml package.json` 到 vendor 目录，
然后完全重启 DeepSeek Harness。** carrier/ 与 electron-bin 平时不动。

运行日志：`~/.dsh/whale598/pet-driver.log`（`logStamp()` 本地时间戳，grep 友好）。

## 3. 工作流 A：本地源码迭代 → 部署重启（日常）

### 3.1 一次性工具链准备

仓库的 package.json **不声明**构建/测试依赖（正式构建在 monorepo 的设计遗留），本地
用 ad-hoc 方式装在 node_modules（gitignore 内，不污染 package.json）。私有包从
registry 拉 tarball 手工安装（它们的依赖树里有 404 的 `@deepseek-ai/dsh-type-meta`，
只存在于 peers，运行时闭包用不到）：

```bash
cd dsh-agentic-pet
mkdir -p ../.scratch/build-env && cd ../.scratch/build-env

# 私有包 tarball（运行时闭包：dsh-tools → session/scope/llm/timeout；构建插件 → typert-protocol）
for p in dsh-session dsh-scope dsh-llm dsh-timeout; do npm pack @deepseek-ai/$p@0.0.1-rc.1; done
npm pack @deepseek-ai/dsh-tools@0.0.1-rc.1        # 核心：defineTool 所在
npm pack @deepseek-ai/dsh-typert-protocol@0.2.1-rc.5  # vendor/typert-plugin 需要

# 公开工具链
cd ../../dsh-agentic-pet
printf 'autoInstallPeers: false\n' >> pnpm-workspace.yaml   # ★ 临时：见 §3.5 清理
pnpm add -D typescript@6.0.3 tsdown @types/node @jridgewell/gen-mapping \
  "file:../.scratch/build-env/deepseek-ai-dsh-tools-0.0.1-rc.1.tgz" \
  "file:../.scratch/build-env/deepseek-ai-dsh-session-0.0.1-rc.1.tgz" \
  "file:../.scratch/build-env/deepseek-ai-dsh-scope-0.0.1-rc.1.tgz" \
  "file:../.scratch/build-env/deepseek-ai-dsh-llm-0.0.1-rc.1.tgz" \
  "file:../.scratch/build-env/deepseek-ai-dsh-timeout-0.0.1-rc.1.tgz" \
  "file:../.scratch/build-env/deepseek-ai-dsh-typert-protocol-0.2.1-rc.5.tgz"
```

**两个类型桩**（手工放置；`src/index.ts` 的 `import type {}` 需要它们存在，且真实包
会对 cordis 的 `Context` 做声明合并，桩里要补上）：

```bash
mkdir -p node_modules/@deepseek-ai/dsh-client-connection node_modules/@deepseek-ai/dsh-host-webserver
for m in dsh-client-connection dsh-host-webserver; do
  printf '{\n  "name": "@deepseek-ai/%s",\n  "version": "0.0.0-local-stub",\n  "types": "./index.d.ts"\n}\n' "$m" \
    > "node_modules/@deepseek-ai/$m/package.json"
done
# client-connection 的 index.d.ts：
printf 'import type { Context } from "@deepseek-ai/cordis"\ndeclare module "@deepseek-ai/cordis" {\n  interface Context {\n    connection: any\n  }\n}\nexport {}\n' \
  > node_modules/@deepseek-ai/dsh-client-connection/index.d.ts
# host-webserver 的 index.d.ts：同上，把 connection 换成 webServer
```

★ `autoInstallPeers: false` 必须写进 **pnpm-workspace.yaml**（pnpm 11 不再读 .npmrc
的这个键）。不加它，`dsh-session` 的 peers（含 404 的 dsh-type-meta）会让安装直接失败。

### 3.2 构建（tsc → tsdown）

临时 tsconfig（复刻 monorepo 产物形态，用完删）——`tsconfig.build-temp.json`：

```json
{
  "compilerOptions": {
    "rootDir": "src", "outDir": "lib/types",
    "target": "es2024", "module": "nodenext", "moduleResolution": "nodenext",
    "rewriteRelativeImportExtensions": true,
    "strict": true, "skipLibCheck": true, "types": ["node"],
    "declaration": true, "declarationMap": false, "sourceMap": true,
    "esModuleInterop": true, "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

```bash
node_modules/.bin/tsc -p tsconfig.build-temp.json      # 全绿才继续（含真 dsh-tools 类型检查）
rm -f lib/index.js lib/tools.js lib/service-*.js       # ★ tsdown clean:false，旧 hash chunk 会残留
node_modules/.bin/tsdown                               # 产物：lib/index.js + tools.js + service-<新hash>.js
```

产物自检：外部 import 只允许 `@deepseek-ai/cordis` + `node:*`（grep `from "` 核对）；
`defineTool` 是真实现（grep `function defineTool(options)` 后应看到 userExecute 等）。

### 3.3 部署

```bash
V=~/.dsh/profiles/desktop/vendor/dsh-pet-app
TS=$(date +%m%d%H%M)
mkdir -p "../.scratch/vendor-bak-$TS"                  # 先备份现网副本
cp -r "$V/lib" "$V/client" "$V/presets" "$V/cordis.patch.yml" "$V/package.json" "../.scratch/vendor-bak-$TS/"

rm -rf "$V/lib" "$V/client" "$V/presets"               # 再覆盖（lib 整换，避免新旧 chunk 混杂）
cp -r lib client presets "$V/"
cp cordis.patch.yml package.json "$V/"
```

### 3.4 验证 → 重启

```bash
# 部署副本加载冒烟（Windows 必须用 file:// URL，裸绝对路径会被 ESM loader 拒绝）
node --input-type=module -e "
const p = 'C:/Users/<you>/.dsh/profiles/desktop/vendor/dsh-pet-app/lib/index.js';
const m = await import('file:///' + p);
console.log('loads ✓:', Object.keys(m).join(','));
"
```

然后**完全重启 DeepSeek Harness**（插件在启动时装载）。运行期验证：

```bash
tail -f ~/.dsh/whale598/pet-driver.log | grep -E "VOICE|WAKE|wake plan"
```

### 3.5 构建后清理（每次装完依赖做一次）

```bash
git checkout -- package.json pnpm-workspace.yaml      # 版本字段/工作区配置只归 release 流程管
rm -f .npmrc tsconfig.build-temp.json                 # 临时文件
# node_modules 里的工具链【保留】——下次构建直接用；但绝不要再跑 pnpm install/exec，
# 否则会被 prune 掉（package.json 没声明它们），又要重来一遍 §3.1。
```

## 4. 工作流 B：测试（vitest，ad-hoc）

```bash
pnpm add -D vitest@4.1.12 js-yaml@4.1.0 "@deepseek-ai/cordis-plugin-include@~1.0.10"
node_modules/.bin/vitest run            # ★ 用 .bin 直调；pnpm exec 会在 package.json 不匹配时自动 prune
```

- `js-yaml` **必须钉 4.1.0**：npmmirror 上的 "5.5.0" 是假包（带 .ts 源码，解析行为不对）。
- `tests/pet-app.spec.ts` 会 import `src/index.ts` → 整个运行时图。本机没有私有包时，
  临时加 `vitest.config.ts` 把 `@deepseek-ai/dsh-tools` alias 到一个恒等桩
  （`export const defineTool = <T,>(d: T): T => d`）即可全绿，跑完删掉。
- 装完记得回退 package.json（§3.5）。

## 5. 工作流 C：正式发布（npm）

```bash
node scripts/release.mjs <version> [--dry-run]
```

前置条件（脚本会自检）：工作树干净、版本号大于现值且 tag 不存在、构建产物齐全
（`lib/index.js` `lib/tools.js` `client/pet-settings.js` `carrier/lib/main.js`
`carrier/dist-renderer/index.html`）、chunk 唯一（又一个 clean:false 残留检查点）。
发布 = npm `<version>` == git tag `v<version>` == tarball 所在 commit。

## 6. 工作流 D：monorepo 同步（⚠️ 已过期，留档）

`scripts/sync-from-monorepo.cmd`：robocopy /MIR 把 monorepo 的 src/tests/lib/carrier
镜像进本仓库。**monorepo 侧已停在 0.2.1-rc.3，直接跑会用旧代码覆盖本仓库**。只有把
monorepo 的 pet-app 先追平到当前 release 状态后，这条链路才可复活；日常迭代一律走 §3。

## 7. 已知坑速查

| 坑 | 后果 | 对策 |
|---|---|---|
| `pnpm install` / `pnpm exec` 自动 prune | 把 ad-hoc 工具链（tsdown/私有包/vitest）全部删掉 | 用 `node_modules/.bin/<bin>` 直调；装完即回退 package.json，且**之后不再 install** |
| tsdown `clean:false` | 源码变更后旧 `service-<hash>.js` 残留在 lib/ | 打包前 `rm -f lib/service-*.js`；发布前 release.mjs 会再查一遍 |
| pnpm 11 忽略 .npmrc 的 `auto-install-peers` | peers 里的 404 包（dsh-type-meta）炸安装 | 写进 pnpm-workspace.yaml（临时），装完回退 |
| npmmirror 假 js-yaml@5.5.0 | pet-app.spec 解析 preset YAML 失败 | 钉 `js-yaml@4.1.0` |
| vendor 的 package.json 版本字段不随部署更新 | 部署副本显示旧版本号（无功能影响） | 部署时一并覆盖 package.json |
| Windows ESM 冒烟用裸路径 | `Received protocol 'c:'` | 必须转 `file:///` URL |
| 宿主不外露 dsh-tools 等私有运行时 | lib 若保持 external，宿主解析不到直接崩 | 必须按 tsdown.config 的 noExternal 打进 bundle（这也是本地构建需要真包的原因） |
