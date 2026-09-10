---
description: "面向用户与维护者的进程内 fork subagent 后端说明，用于选择、配置或排查以父级已提交对话作初始内容的子 agent（智能体）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-fork-in-process

[English](README.md) | 中文

## 概述

`dsh-subagent-fork-in-process` 以委派时父级已提交的对话作为每个子 agent（智能体）的初始内容，包括当前轮次的消息、推理和已记录工具结果。委派工具以 `fork` 提供方名称找到它，其行为与 spawn 后端一致，唯一差异是会话初始内容。当子任务延续当前对话时选择它；当子 agent 必须独立运行时选择 spawn。初始内容是 fork 时的一次性快照：此后父级记录的任何内容都不会到达子 agent。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当委派的工作必须建立在父级对话之上时，挂载此后端。常用路径与 spawn 相同：加载 subagent 服务与本后端，再把 `dsh-tool-subagent` 之类的委派工具指向 `fork` 提供方。

### 何时选择

当子 agent 需要对话中已提交的上下文时——后续分析、审查、延续——选择 fork。当子 agent 应全新开始时选择 spawn；当子 agent 不能共享本进程时选择进程外后端。初始内容只传递对话历史：子 agent 仍获得全新的工具作用域，且不继承父级的任何权限。

### 初始内容边界

初始内容包含提供方捕获快照时父级已提交的每个事件。Session 负责生成闭合记录，仅在子会话中配平未完成工具调用并闭合继承的步骤和轮次。那些调用仍由父级负责，子 agent 不得重试。尚未组装的流分片仅保存在日志中，父级后续事件也不会同步。

### 最小配置

先加载 subagent 服务与本后端，再配置一个委派工具。此组合暴露由 fork 支撑的 `subagent` 工具：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-fork-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `fork` | 注册到 `ctx.subagents` 的提供方名称 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-fork-in-process)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 一次 fork 委派会做什么

一次委派会捕获父级已提交上下文的一次性快照，并在独立会话中启动子 agent。前台调用返回子 agent 的最终输出，未完成的结果报告为工具错误；可继续后台调用返回持久子 agent id，以便后续发消息。委派工具的配置决定该生命周期。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端背后的设计决策，以及[使用本包](#use-this-package)中行为的来源。

### 设计理念

提供方通过 `Session.snapshotForFork()` 取得 `SessionForkSeed`。Session 负责闭合与回放语义，提供方选择历史，一次性驱动器或继续执行管理器负责子 agent 执行。seed 将真实父前缀与仅属于子会话的闭合记录区分开来。结果收集排除整个 seed。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 提供方注册：快照选择、`Config` schema、能力声明 |
| — | 不发布运行时不变式伴生入口；本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。 |

### 运行流程

`start` 时，共享驱动器使用已捕获的 seed 创建子 agent，应用 persona、工具过滤及结构化输出设置，驱动一项任务，读取子 agent 自身的最终输出，并执行 dispose（资源释放）以等待所有工作完全停稳。该提供方声明 `agentOptions`，以及与 spawn 相同的输出、深度、过滤与 persona 能力。`prepareContinuable` 在创建时只捕获一次前缀，因为该前缀会成为子 agent 自身持久保存的 transcript（文本记录）的一部分。

### 生命周期绑定

base 组合包与 ACP（Agent Client Protocol）/headless 示例在委派工具上把本提供方绑定为 `backgroundMode: one-shot`，CLI（命令行界面）预设则选择 `continuable`。两者都保留继承的请求前缀：父级与子级获得定义和顺序相同的消息工具，可继续子级的父级 ID 与返回指导位于继承历史之后的初始用户任务中（见[保持 fork 缓存的 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md)）。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从共享 subagent 模型进入兄弟后端，以及一次性绑定的设计证据。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——启动请求、结果、提供方约定与进程内深度和初始内容。
- [dsh-subagent-in-process-driver](../subagent-in-process-driver/README.zh.md)——本后端调用的共享运行驱动器。
- [dsh-subagent-spawn-in-process](../subagent-spawn-in-process/README.zh.md)——全新子级的兄弟后端。
- [dsh-tool-subagent](../tool-subagent/README.zh.md)——指向该提供方的面向模型委派工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-fork-in-process)——每个受支持配置字段及其源声明。
- [Fork child 保留 parent 请求前缀](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md)——继承历史如何保持前缀复用资格。

-----

<a id="model-experience"></a>
## 模型体验

### 子 agent 历史与包络

#### 模型看到什么

子 agent 先接收父级已提交对话、仅属于子会话的闭合结果，再逐字接收新的任务内容。配置的 persona 会在子 agent 的全新作用域中遮蔽提示词文本；工具限制会过滤其全局协议 schema、可执行工具查找与 PTC mode SDK 绑定，但不影响独立指导内容。父级的工具视图与权限不会被继承；可选的结构化输出请求会添加仅属于子 agent 的约定；当前轮次已提交的消息和推理会保留，而执行仍由父级负责。

#### Token 影响

fork 会把保留的已提交历史复制到子 agent 的请求中，子 agent 随后独立累积自己的 token。persona 会改变重复提示词的成本；过滤会改变 schema 或生成 SDK 的成本；首轮 fork 会保留当前用户消息和已提交的 assistant 工作。

#### KV Cache 影响

在提供方与模型相同的前提下，子 agent 可以复用继承的逐字节相同前缀。persona、工具过滤、生成 SDK 或路由变化可能在继承历史之前使复用失效；后续子 agent 历史仅追加。可继续消息不会增加子级专属的系统提示词区段或工具 schema；父级 ID 与返回指导在初始用户任务中位于继承历史之后（见[保持 fork 缓存的 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md)）。

### 父级工具结果（间接）

#### 模型看到什么

父级只通过 `dsh-tool-subagent` 接收子 agent 自身的最终输出，不接收继承的前缀或中间工作。

#### Token 影响

父级输入增加一个取决于数据的最终结果，并保留到上下文压缩（context compaction）为止。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明何时选择该后端是错误的；它们是当前包约束。

- **初始内容是一次性快照**——子 agent 只能看到 fork 时父级已提交的上下文，看不到父级此后记录的任何内容；不会实时共享上下文。
- **fork 生命周期策略因组合而异**——base 组合包与 ACP/headless 示例使用一次性 fork，CLI 预设使用可继续 fork。两者都因父级与子级的消息定义逐字节相同而让继承前缀保持可复用；显式 persona、工具过滤、生成 SDK 或路由变化仍可破坏相等性。理由见[保持 fork 缓存的 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md)。
- **随附 fork 工具不公开子级 LLM（大语言模型）路由选择**——它们继承父级提供方与模型，使复制的历史仍有资格复用 KV Cache。在某项改动能保留复用或公开有界重算成本前，路由选择保持禁用；[模型选择路由 Agent Note](../../../.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.zh.md)说明这项限制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
