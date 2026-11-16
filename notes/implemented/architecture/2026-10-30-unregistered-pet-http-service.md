# Agent Note: 工具行的无注册服务工厂（createUnregisteredPetHttp）

Status: implemented

落地于 2026-10-30（commit 407d30e）。定义处 [src/service.ts](../../../src/service.ts)，消费处 [src/tools.ts](../../../src/tools.ts)。

## Problem

pet_* 工具按 preset row 挂载（`PetTools` 类插件，`static inject = ['tools']`），只有挂了 pet preset 的会话才看得见工具目录。工具处理器需要 `PetHttpService`（发现/探活/能力/body/call 归一），但**服务从哪个上下文来**在当时是个死结：

- 从主 row 读 `ctx.petService` 不可见——Cordis 的服务注册在自己 row 的 fiber context，**兄弟分支看不到彼此的 store**；preset 子树拿不到主 row 注册的实例。
- 在 preset row 上再注册同名服务也不行——非 isolated 的同名注册会覆盖主 row 的 store 槽位，且触发 preset realm 的泄漏检查拒绝（「Preset services require isolate realms」，实测 resume failed）。

## Decision

`createUnregisteredPetHttp(home)`：返回一个 `PetService` 形状的实例，**不带任何 Service 注册副作用**。依据是消费面的事实：工具只用四个方法（list/snapshot/call/capabilities），它们对磁盘 registry 是无状态的——`home` 就位的原型实例与注册版行为完全一致。宿主 row 的正式注册（`installPetService`）继续服务 in-bundle 消费者与将来的 `inject: ['petService']` 外部插件，两条路互不干扰。

随之固化的坑位纪律：工厂用 `Object.create(PetHttpService.prototype)` 绕过构造器，**类字段永不初始化**——`capsCache` 是 undefined 导致过 pet_do / pet_state {actions:true} 崩溃（Cannot read properties of undefined）。规则写在 service.ts 工厂注释里：**`PetHttpService` 每新增一个实例字段，必须在工厂里同步初始化**（现初始化 `capsCache`、`listCache`）。

## Alternatives considered

- **工具行注入主 row 服务**（`ctx.petService` 或通过 inject 链）——输在 Cordis 的可见性模型：服务是 fiber 局部的，preset 子树与主 row 是兄弟分支，谁也看不见谁。这不是 bug 是设计，绕不开。
- **在 preset row 注册 isolated 服务**（满足 realm 检查的那个形态）——输在收益为零：四个方法无状态，为它们挂完整 Service 生命周期（isolated realm、注册/注销时机）只增加约束不增加行为；且失败路径已经实测过一次（407d30e 之前的 resume failed）。
- **工具行自己 fetch 磁盘 registry**（跳过 PetService 抽象）——输在归一化丢失：探活两层 probe、boot 序、capabilities TTL 缓存、body 回落这些差异吸收全住在 service.ts；工具行直接读文件等于把每个消费者复制一遍归一逻辑。

## Consequences

- `createUnregisteredPetHttp` 与 `installPetService` 是仅有的两个实例来源；前者只在工具行用。
- **新增 `PetHttpService` 实例字段必须同步工厂初始化**——这是本仓少数「改一处必须改两处」的硬纪律，code review 重点看。
- preset realm 的服务注册约束（isolate 检查）由此绕开，但它是宿主行为，若 cordis 升级改检查语义，工具行不受影响（它根本不注册）。

## Testing

`tests/` 覆盖 service 归一行为；工厂的类字段初始化由「pet_do 不崩」间接钉住——若新增字段漏初始化，会以运行时 undefined 崩溃的形式暴露（教训来自实测）。

---

*回填说明（2026-11-17）：本篇自 git history（407d30e）与 service.ts/tools.ts 注释重建；Alternatives 中「isolated 注册」一条的部分动机为推断，已尽量贴可还原证据。*
