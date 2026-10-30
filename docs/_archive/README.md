# _archive · 归档件

> **这里不是文档体系的一部分。** 存放**原始资料**与**已完结任务的中间稿**，
> 结论一律以 `docs/` 下的编号文档为准（分工表见 `docs/00-项目总览.md`）。
> 归档 = 保留可追溯，不是「删掉忘了」；原件的结论若已并入编号文档，此处只留证据。

## 目录

| 归档件 | 是什么 | 并入了哪份编号文档 / 现状 |
|---|---|---|
| `2026-lobster-merge/lobster-merge-vs-upstream.patch` | lobster 插件**合并自有逆向实现前后**的完整 diff（1833 行） | 决策与合并清单见 `docs/10-LobsterAI插件迁移决策记录.md`；上游基线 SHA 见同目录 `upstream-baseline.txt` |
| `2026-lobster-merge/upstream-baseline.txt` | 合并前上游仓库的基线 SHA | 同上（`10` 的「上游基线」条目引用它） |
| `2026-lobster-merge/W2A-baseline.md` | 子代理中断前落盘的**工作基线**（`lib/version.mjs`、`lib/checkin.mjs` 的实现要点） | 其中「`lib/constants.mjs` 尚未提供 `apiUrl(env)` 导出」的告警**已解决**（该导出现存在于 `plugins/lobster/lib/constants.mjs`）；两份文件的最终实现与验收结论见 `docs/12-LobsterAI插件验收报告.md` |
| `HANDOFF-lobsterai-migration.md` | 「LobsterAI → magpie 插件迁移」任务**开工前**的交接稿（任务已闭环） | 结论全部在 `docs/10`～`docs/12`；本件只保留「当时为什么这么开工」的历史 |

## 为什么原 `docs/research/` 被并入这里

原 `docs/research/` 只有一个混合体：两个**数据资产**（`.patch` / `.txt`）加一个**工作笔记**
（`W2A-baseline.md`），既不是「按主题切分的文档」，也没有被任何编号文档引用 ——
按文档体系的六条判据只满足 1 条，属于**违规平行体系**（会被体检脚本判 FAIL）。

处置（并档四步）：

1. **按主题并入**：工作笔记里仍然有效的结论（`apiUrl(env)` 导出、两个文件的实现要点）已由
   `docs/10`/`docs/12` 覆盖；两个数据资产作为**原始证据**随目录一起归档。
2. **活引用逐条重定向**：`docs/99-变更日志.md` 与 `README.md` 里指向 `docs/research/` 的引用已改到新路径。
3. **原件 `git mv` 进 `_archive/`**（归档非删除，git 历史完整保留）。
4. **更新目录树 + 建本 README**（本文件）说明「哪个归档件并入了哪份编号文档」。

## 归档触发条件

- 主题文档正文**超过 800 行**或**超过半年未更新**且已被新结构取代 → 正文进编号文档，
  原文 `git mv` 进 `_archive/`。
- 任务闭环后的中间稿（交接稿、基线稿）→ 直接进 `_archive/`，不进 `docs/` 根。
