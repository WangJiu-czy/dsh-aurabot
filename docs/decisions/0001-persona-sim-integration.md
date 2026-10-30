# ADR-0001: 将 Persona Sim 接入 Aurabot 模块

## 状态
Accepted

## 日期
2026-10-30

## 背景

上游 `astrbot_plugin_self_evolution` 是 Python AstrBot 插件，包含 Persona Sim、主动社交、长期记忆等多个子系统，不能直接在 Aurabot 的 JavaScript 模块运行时加载。Aurabot 已有独立的心情、记忆和主动搭话模块；另起同类状态源会造成上下文和状态冲突。

## 决策

将 Persona Sim 的时间推演、互动状态变化、状态效果/待办和轻量上下文注入改写为 Aurabot 原生内置模块 `self-evolution`。心情继续以 Aurabot `mood` 模块为准；记忆和主动搭话继续复用现有模块。按聊天会话隔离保存少量数值状态，不保存原始消息文本；状态只在互动、上下文读取或主人命令时推进，30 天未使用自动清除。

主人可用 `/ps status`、`/ps todo`、`/ps tick good|normal|bad` 查看或模拟状态，并用 `/ps reset` 清除当前会话状态。面板「心情与记忆」页显示主人私聊会话的状态、效果和待办，只通过既有 overview 数据接口返回展示字段。模块仅注入状态叙事，不自动改写人格设定或插件代码。

## 考虑过的方案

- **直接运行 AstrBot Python 插件**：运行时、事件 API 和依赖均不同，不能复用 AstrBot 插件类。
- **重做一套心情/记忆系统**：会与 Aurabot 已有模块产生重复状态，放弃。
- **一次移植上游所有子系统**：范围大且与 Aurabot 既有功能重叠，先以 Persona Sim 核心接入，后续按实际需求扩展。

## 来源署名

参考并改写自 [Renyus/astrbot_plugin_self_evolution](https://github.com/Renyus/astrbot_plugin_self_evolution)，上游许可为 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)。本实现改写为 Aurabot JavaScript 模块，复用 Aurabot 的心情、记忆和主动搭话模块。

## 结果

无需新增依赖；模块可在 Aurabot「扩展」页单独开关。Persona Arc、SAN 分析、主动社交规划等上游独立子系统尚未移植，现有 Aurabot 模块承担其中已有的心情、记忆和主动搭话能力。
