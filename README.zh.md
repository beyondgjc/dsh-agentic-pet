---
description: "dsh 桌面宠物：经由 web 组合层伺服宠物页面、由进程内 dsh 事件驱动、可从桌面应答审批与提问的 agentic 宠物插件。"
kind: "package-bundle"
---

# dsh-agentic-pet

[English](README.md) | 中文

## 简介

`dsh-agentic-pet` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 生态的桌面宠物插件：宠物以透明置顶窗常驻桌面，跟随 agent 会话状态（idle / thinking / working / error），与 web 界面竞速应答审批与提问（先答者赢），维护每宠独立的触摸好感账本，并向模型暴露表达工具（`pet_say`、`pet_do`、`pet_digest`、`pet_interactions`、`pet_state`）——模型可以借宠物说话、做动作、感知被触摸。多只宠物实现可以并存：目录注册表（`~/.dsh/pet-http.d/`）发现全部在线宠物，状态、交互、账本按宠路由。

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

TypeScript 构建仍在 dsh monorepo workspace 内进行（被打包的 `@deepseek-ai/dsh-*` 依赖未发布 npm）。流程：

1. monorepo 内：`pnpm run build`（插件 `lib/`）与 `pnpm --filter @deepseek-ai/dsh-pet run build`（载体 `lib/` + `dist-renderer/`）。
2. 本仓库：`scripts\sync-from-monorepo.cmd`——把源码与构建产物镜像进本仓库。
3. 本仓库提交，然后 `npm publish`（先素材包后插件包；发布手册见 [dsh-pet-assets/PUBLISH.md](../dsh-pet-assets/PUBLISH.md)）。

测试：`npx vitest run tests/registry-service.spec.ts` 自持可跑（只需 `cordis` 与 `vitest`）；含 `tests/pet-app.spec.ts` 的全量测试在 monorepo workspace 内跑。

## 文档

- 控制面契约（所有宠物实现共同讲述的冻结消费方 API）见项目文档的多宠指南。
- 已知边界与设计笔记见仓库 wiki 与项目工程文档。


## 致谢与授权

- 本项目基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 衍生（上游 dsh-pet 插件，作者 PC2005-cloud）。插件代码以 MIT 许可发布。
- 角色形象（"大肥鱼"鲸鱼娘，见 `carrier/assets` 与 `dsh-agentic-pet-assets`）的形象授权为 **CC BY-NC-SA 4.0**（署名 · 非商业 · 相同方式共享），[原作者声明](https://www.bilibili.com/opus/1247156596114456581)。仅限非商业使用；形象衍生须以相同方式共享。
