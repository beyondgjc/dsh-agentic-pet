# Agentic 桌面宠物

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 生态的桌面宠物插件：宠物以透明置顶窗常驻桌面，跟随 agent 会话状态（idle / thinking / working / error），与 web 界面竞速应答审批与提问（先答者赢），维护每宠独立的触摸好感账本，并向模型暴露表达工具（`pet_say`、`pet_do`、`pet_digest`、`pet_interactions`、`pet_state`、`pet_schedule_wake`、`pet_cancel_wake`、`pet_set_rhythm` 等 15 个）。说话内容可通过 BreezeBlue TTS 朗读（声音按宠配置，未配置的宠只显示气泡），合成失败或超时静默降级为只显示。多只宠物可并存：目录注册表发现全部在线宠物，状态、交互、账本按宠路由。

## 安装

在 DeepSeek Harness 桌面端**插件页**安装（添加插件 → 输入 `dsh-agentic-pet` → 安装 → 打开开关），或命令行：

```bash
dsh plugin --profile <name> add dsh-agentic-pet
```

- 动画素材以独立包 `dsh-agentic-pet-assets` 分发，作为依赖自动带入。
- Electron 载体按需自拉：首次使用会下载 Electron（约 100MB，需要网络）。
- 对 DSH 核心包只有 `@deepseek-ai/cordis` 一个 peer，由宿主提供；`dsh plugin add` 时的 peer 警告不代表启动失败（宿主 profile 以 `nodeLinker: hoisted` + `autoInstallPeers: false` 初始化，宿主包经启动时的 module fallback 提供）。

## 验证

安装并重启桌面端后：

1. 桌面出现宠物窗（默认形象「鲸鱼娘」），随会话状态点亮状态灯；
2. 桌面侧栏出现宠物设置页；
3. `~/.dsh/whale598/pet-http.d/` 出现在线宠物的注册表条目。

## 使用要点

- **跟宠物说话**：用宠物表面的输入卡（双击宠物弹出），直达她自己的内心戏会话；在侧栏手动开的宠物模式会话不是对话入口。
- **好感**：抚摸积累好感；触摸回复冷却与请求模型的概率在设置页调整。
- **自主表达**：世界时钟按设置的间隔与唤醒概率轻拍她，到点她自己决定说不说；她还能用 `pet_schedule_wake` 给自己定闹钟、用 `pet_set_rhythm` 自调节律——后者默认关闭，需在设置页开启「允许模型自调」，开启后她改的就是设置页那四项的值（关闭时她调用直接失败，只能开口向你提）。
- **多宠**：「再来一只」按最低空闲序号召唤；「送走」让她离开（数据休眠、可复活）；「销毁」才抹除该宠全部数据（强确认，不可恢复）。
- **会话换代**：宠物内心戏会话在会话列表显示为「鲸鱼娘的内心戏」。归档它会让宠物换代重建新会话（编号 `-gN` 递增，记忆从零开始），所以只归档旧代——**最新一条是现役**。
- **指定会话（高级）**：设置页可把某只宠物手动绑定到一个用宠物 preset 创建的会话；绑定的会话按原样使用（persona 与工具目录由该会话自身的 preset 决定）。

## 注意事项

- 插件数据（好感账本、交互日志、内心戏会话映射）保存在 `~/.dsh` 下，卸载插件不会删除，重装后恢复。
- 载体有单实例锁：重复启动的实例会被静默挡掉，重启宠物前先确认旧进程已退出。
- 本地 HTTP 控制面无鉴权（同用户进程可读可驱动），注册表目录为 `~/.dsh/whale598/pet-http.d/`，与上游同类插件的威胁模型一致。

## 卸载

插件页卸载即可。想彻底清除宠物数据，再删除 `~/.dsh` 下的宠物账本文件与 `~/.dsh/whale598/`。

完整文档（开发部署、控制面契约、致谢与授权）见 [GitHub README](https://github.com/beyondgjc/dsh-agentic-pet#readme)。
