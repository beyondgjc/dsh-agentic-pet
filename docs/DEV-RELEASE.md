# 发布指南（dsh-agentic-pet → npm）

> 实录来源：0.4.19 发布（2026-11-17）。规范路径是 `scripts/release.mjs`——0.4.19 那次手动绕过漏了 git tag，事后补了 `v0.4.19`；照本文走规范路径就不会漏。

## 0. 一句话流程

测试全绿 → 两段式构建 → feature 提交 → `node scripts/release.mjs <版本>`（bump + publish + release 提交 + 打 tag）→ `git push --follow-tags` → 收尾四件套（monorepo 镜像 / profile 锁文件 / 部署脚本标记 / 安装位核验）。

## 1. 发布物是什么

npm 包 = 发布仓根目录按 package.json `files` 白名单装箱：`lib/*.js`（tsdown 产物）、`lib/types/**`、`client/**`、`carrier/**`、`presets/**`、`locale/**`、`cordis.patch.yml`。**构建产物随手进 repo**（§DEV-DEPLOY 3.2），所以 npm 版本、git tag、tarball 来源 commit 三者恒等——这是 release.mjs 全部前置条件要守的不变量。

## 2. 发布前检查单

```bash
# 1) 测试全绿（当前 ~340 条）
node_modules/.bin/vitest run

# 2) 两段式构建（tsc 全绿才继续；★ 清干净旧 hash chunk 再打包）
node_modules/.bin/tsc -p tsconfig.build-temp.json
rm -f lib/index.js lib/tools.js lib/service-*.js lib/driver-*.js
node_modules/.bin/tsdown

# 3) 工作树干净（release.mjs 硬性要求：tag 必须指向装箱内容）
git status --short   # feature 先提交完
```

feature 提交的 message 风格见 `git log`：`feat(pet): 标题——①…②…`，把"为什么改"写进提交。

## 3. 规范路径：scripts/release.mjs

```bash
node scripts/release.mjs 0.4.20            # 正式发布
node scripts/release.mjs 0.4.21-rc.1       # 预发布：publish --tag rc，不占 latest
node scripts/release.mjs 0.4.20 --dry-run  # 只走检查 + publish --dry-run，不发布不提交不打 tag
```

脚本自动做：版本比较与写入（唯一写入方）→ 工作树干净检查 → tag 不存在检查 → 六个产物存在检查 → **lib/ 必须恰好一个 `driver-*` 和一个 `service-*` chunk**（tsdown `clean:false` 残留检查）→ `npm publish --registry https://registry.npmjs.org`（**显式官方源**，机器 .npmrc 指着 npmmirror）→ 失败自动回滚 package.json → 成功则 `chore(release): <版本>` 提交 + 打附注 tag `v<版本>`。

手动兜底（脚本中途失败时它自己会提示）：`git add package.json && git commit -m "chore(release): <版本>"` → `git tag -a v<版本>` → 无论如何 **tag 必须补上**再 push。

## 4. push 与发布后核验

```bash
git push origin master --follow-tags        # ★ --follow-tags 带上 release tag
```

核验发布**别信 `npm view`**——本地缓存会把刚发的版本显示成旧的。直接查 registry API：

```bash
curl -s --max-time 90 -o meta.json https://registry.npmjs.org/dsh-agentic-pet
# 看 dist-tags.latest 与 versions 末尾（0.4.19 实测：publish 后 ~3 分钟内 API 已可见）
```

npmmirror（默认 registry）是同步镜像，滞后数分钟到更久，只影响 `pnpm install` 走默认源的场景——见 §5。

## 5. 收尾四件套

发布 ≠ 完成，这四件做完自愈链路才算续上：

1. **monorepo 镜像**：发布仓改动的 `src/` `client/` `tests/` 逐文件拷进
   `dsh/deepseek-harness/packages/bundle/pet-app/` 对应路径 → 跑镜像侧 pet-app 测试 →
   提交（message 加「镜像发布仓 <版本>」）。eval/、notes/ 只住发布仓不进镜像。
2. **profile 锁文件对齐**（自愈链路：并行会话装插件时会按锁文件 re-resolve，
   不对齐就会把安装位拖回旧版本）：
   ```bash
   cd ~/.dsh/profiles/desktop
   sed -i 's/"dsh-agentic-pet": "<旧>"/"dsh-agentic-pet": "<新>"/' package.json
   pnpm install --registry https://registry.npmjs.org   # ← 显式官方源
   # 核验：pnpm-lock.yaml importer 块 specifier/version 都是 <新>；
   # node_modules/dsh-agentic-pet/package.json 是 <新>
   ```
3. **部署脚本标记**：`deploy-plugin.sh` 里版本核验行同步新版本号，跑一遍 ALL PASS。
4. **安装位核验**：新行为标志物 grep（本次是 `injectMaxChars: 1200` 等）。

## 6. 坑速查（0.4.19 实录）

| 坑 | 现象 | 对策 |
|---|---|---|
| 默认 registry 是 npmmirror | `npm publish` 报 ENEEDAUTH（镜像不能发） | `npm publish --registry https://registry.npmjs.org`；release.mjs 已内置 |
| npm view 缓存 | 刚发布完 `npm view` 仍显示旧版本 | curl 直查 registry API 的 dist-tags |
| npmmirror 同步滞后 | profile `pnpm install` 解析不到新版本 | `pnpm install --registry https://registry.npmjs.org`，等镜像自己追平 |
| 管道吞退出码 | `pnpm install 2>&1 \| tail` 后 `&&` 链继续跑（装失败了也不知道） | `cmd > file 2>&1; echo $?` 实测退出码，或 `set -o pipefail` |
| tsdown `clean:false` 残留 | 旧 `driver-*`/`service-*` chunk 留在 lib/，连同死代码一起发出去 | 打包前 `rm -f lib/*.js 里的旧 chunk`；release.mjs 会数 chunk 个数拦住 |
| npm publish 失败的半截状态 | package.json 已被写成新版本但没发出去 | release.mjs 自动回滚；手动跑时要自己 `git checkout package.json` |
| 漏 tag | npm 版本存在但仓库没有对应 tag（0.4.19 就漏过） | 发布完 `git tag -l` 核对；`git push --follow-tags` |
| minimumReleaseAge 闸 | 刚发布的版本可能被 profile 的 pnpm 最小版本年龄策略拦住 | pnpm 会自动把新版本写进 pnpm-workspace.yaml 的 minimumReleaseAgeExclude，无需干预 |

## 7. 版本号约定

x.y.z：patch = 修 bug / 小开关；minor = 工具面/行为变化（0.4.19 = 审计看板 + 唤醒快照默认翻转）。预发布用 `-rc.N` 后缀（publish --tag rc，不占 latest）。版本号唯一写入方是 release.mjs（sync-package-json.mjs 只做镜像间同步）。
