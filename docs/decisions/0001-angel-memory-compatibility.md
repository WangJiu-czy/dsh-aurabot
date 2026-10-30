# ADR-0001: 将 Angel Memory 能力适配到 Aurabot

## Status
Accepted

## Date
2026-10-30

## Context

上游 [`astrbot_plugin_angel_memory`](https://github.com/kawayiYokami/astrbot_plugin_angel_memory) 面向 AstrBot 的 Python 运行时，并依赖 `p-memory` 等组件；Aurabot 是 Node.js / DSH 扩展。Aurabot 已有长期记忆、人物档案、心情、日常整理和 Persona Sim。上游仓库采用 GPL-3.0，而 Aurabot 当前采用 MIT。

## Decision

新增独立的 Aurabot 内置模块 `angel-memory`，只补足本地知识库：Markdown/TXT 导入、关键词搜索、阅读和删除；条目可设为共享或限定到一个 QQ 群 / 私聊。知识默认手动检索，不自动注入聊天上下文；AI 只在用户明确要求保存时写入。个人记忆、心情和人格状态继续复用 Aurabot 现有实现。

实现仅依据上游公开功能说明独立编写，不复制上游源代码或引入其 GPL 依赖。数据存于 `modules-data/angel-memory/knowledge.json`。

## Alternatives Considered

- **直接安装 AstrBot Python 插件**：它依赖 AstrBot 事件和服务接口，无法作为 DSH / Aurabot 模块加载。
- **复制上游实现**：会改变 Aurabot 现有 MIT 分发方式；本次选择独立实现，不引入 GPL 源码。
- **重写 Aurabot 全部记忆能力**：与现有 BM25 记忆、日常整理、人物档案和 Persona Sim 重复。

## Consequences

- 不新增 Python、向量数据库或运行时依赖；知识条目按共享 / 当前聊天隔离。
- 当前采用本地关键词检索；未实现上游的向量重排、自动上下文模式、定时知识库维护和可配置隐藏模式。
- 后续若要直接合并上游源码或依赖，需要先明确整体分发许可策略。
