# 任务交接存档 — LobsterAI → magpie 插件迁移（待新会话继续）

生成时间: 本次会话（R0.5 兼容性门控触发，需禁用 Agent Teams 后开新会话继续）

## 任务目标
- 查看 D:\projects\model-reverse 的项目文档，将其中已逆向成功的应用转换为 magpie 插件并配置接入，逐步替代逆向项目。
- 首个转换目标：**LobsterAI**。
- 参考插件：https://github.com/Jasery/opencode-lobster-auth（与该应用相关），但其项目质量存疑，需要将其与自有实现合并后再采用。

## 新会话第一步（必做）
1. 新会话需重跑 R0 复杂度分诊：预计 L2（跨模块、多交付物、需调研未知项）。
2. 若新会话仍挂载 Agent Teams（spawn_teammate/wait_agent），再次执行 R0.5 门控。
3. 分诊完成后执行完整工作流：Clarification Interview → Full Plan → 并行 Subagents → Layered Acceptance。

## 调研起点
- D:\projects\model-reverse —— 自有逆向项目（已逆向成功的应用清单、LobsterAI 的逆向产物与配置文档）
- D:\projects\magpie —— magpie 插件体系（当前工作目录，插件格式、注册/配置方式）
- https://github.com/Jasery/opencode-lobster-auth —— 候选参考插件（风险评估：质量/维护性/许可证/依赖）
