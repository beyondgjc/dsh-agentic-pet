---
description: "dsh 桌面宠物：经由 web 组合层伺服宠物页面、由进程内 dsh 事件驱动、可从桌面应答审批与提问的 agentic 宠物插件。"
kind: "package-bundle"
---

# dsh-agentic-pet

[English](README.md) | 中文

## 简介

`dsh-agentic-pet` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 生态的桌面宠物插件：宠物以透明置顶窗常驻桌面，跟随 agent 会话状态（idle / thinking / working / error），与 web 界面竞速应答审批与提问（先答者赢），维护每宠独立的触摸好感账本，并向模型暴露表达工具（`pet_say`、`pet_do`、`pet_digest`、`pet_interactions`、`pet_state`）——模型可以借宠物说话、做动作、感知被触摸。说话内容可通过 [BreezeBlue](https://breezeblue.ai) TTS 朗读——carrier 侧合成每条 `/say` 文本，语音就绪后与气泡同时下发；合成失败或超时静默降级为只显示（桌面设置页可配）。多只宠物实现可以并存：目录注册表（`~/.dsh/pet-http.d/`）发现全部在线宠物，状态、交互、账本按宠路由。

宠物本身是零 DSH 知识的纯显示端。理解运行时的一切——事件收敛、交互瀑布、多宠路由、模型工具——都在插件的 driver 里，宠物只实现一个小型本地 HTTP 控制接口。任何讲同一 HTTP 契约的宠物实现都能被采纳，插件零改动。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `src/` | 插件（Cordis bundle）：`/pet` 路由、事件 driver、注册表、`PetService` 接缝、模型工具、设置页路由 |
| `client/` | 桌面侧边栏设置页（client 半边） |
| `carrier/` | 随包分发的 Electron 载体**构建产物**（`lib/`、`dist-renderer/`） |
| `carrier-src/` | 载体**源码**（自开发上游镜像；素材在 [dsh-pet-assets](https://github.com/beyondgjc/dsh-pet-assets)） |
| `vendor/typert-plugin/` | 打包配置使用的 typert 装饰器插件（vendored） |
| `tests/` | Vitest 用例（注册表路由与 `/status` 字段矩阵的纯函数覆盖） |

## 安装

在 DeepSeek Harness 桌面端插件页安装，或：

```bash
dsh plugin --profile <name> add dsh-agentic-pet
```

动画素材以独立包 `dsh-agentic-pet-assets` 分发，作为依赖自动带入。

## 开发

日常迭代在本仓库内完成：改 `src/` → 本地构建（tsc + tsdown，工具链与私有包依赖的准备见文档）→ 部署到桌面 profile 的 vendor 目录 → 重启 DeepSeek Harness。**完整手册（含工具链准备、部署/验证/清理命令与已知坑）见 [docs/DEV-DEPLOY.md](docs/DEV-DEPLOY.md)**。

历史上的构建在 dsh monorepo workspace 内进行（被打包的 `@deepseek-ai/dsh-*` 依赖未发布 npm），经 `scripts\sync-from-monorepo.cmd` 镜像进本仓库——monorepo 侧副本已停在 `0.2.1-rc.3`，该链路已过期，仅留档；直接运行会用旧代码覆盖本仓库。

测试：`node_modules/.bin/vitest run`（vitest 及 `js-yaml@4.1.0`、`@deepseek-ai/cordis-plugin-include` 为 ad-hoc 安装，见文档 §4）；`tests/registry-service.spec.ts` 等纯函数规格只需 `cordis` 与 `vitest` 即可自持运行。

## 发布

`package.json` 的 `version` 归本仓库所有：`scripts\sync-from-monorepo.cmd` 镜像其余所有字段、只保留它。monorepo 那份带的是 workspace 版本（`0.2.1-rc.3`），早先的整文件覆盖会把已发布的版本号改掉——npm 上的 `0.4.0` 因此没有对应的 commit 与 tag。

```bash
node scripts\release.mjs 0.4.1 --dry-run   # 预检 + 打包清单，不发布
node scripts\release.mjs 0.4.1             # 发布，提交 "chore(release): 0.4.1"，打 tag v0.4.1
git push --follow-tags
```

以下任一条件不满足，脚本拒绝发布：工作树干净、新版本号大于当前值、tag `v<版本>` 不存在、构建产物齐备、`lib/` 里只有一个 bundle chunk（`tsdown` 用 `clean:false`，残留的旧 `service-*.js` 会被打进包）。发布失败会自动还原 `package.json`，工作树不会停留在一个并未发布的版本号上。预发布版本（`x.y.z-rc.N`）以 `--tag rc` 发布。

每个已发布版本都能用 tag `v<版本>` 定位——回答"npm 上是什么"的是 tag，不是清单。因此仓库里的版本号恒等于**最后已发布**的版本。

## 文档

- 开发与部署手册（本地构建工具链、vendor 部署、测试、发布、已知坑）：[docs/DEV-DEPLOY.md](docs/DEV-DEPLOY.md)。
- 控制面契约（所有宠物实现共同讲述的冻结消费方 API）见项目文档的多宠指南。
- 说话朗读（BreezeBlue TTS）设计笔记见 monorepo 工作区的 `packages/bundle/pet-app/docs/tts.md`。
- 已知边界与设计笔记见仓库 wiki 与项目工程文档。


## 致谢与授权

- 本项目基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 衍生（上游 dsh-pet 插件，作者 PC2005-cloud）。插件代码以 MIT 许可发布。
- 角色形象（"大肥鱼"鲸鱼娘，见 `carrier/assets` 与 `dsh-agentic-pet-assets`）的形象授权为 **CC BY-NC-SA 4.0**（署名 · 非商业 · 相同方式共享），[原作者声明](https://www.bilibili.com/opus/1247156596114456581)。仅限非商业使用；形象衍生须以相同方式共享。
