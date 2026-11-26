# 采集工作库如何运行？

可见内容只有 **`管理.base`** 和 **`素材/`**。管理表提供“最近7天”“全部正式版”“按产品”三个视图，字段为标题、产品、类型、发布时间和原始链接。

## 采集范围

`Coding Agent` 产品只采集正式版 Release 与官方 Changelog。[内容策略](../apps/worker/content-policy.json)定义允许类型与预发布识别规则；GitHub 标记、标题和版本标签中的 Alpha、Beta、RC、Preview 等会被排除，不扫描正文。采集、同步和导出使用同一范围。

[worker](../apps/worker/src/runtime.ts)每轮只采集、写入 SQLite、同步飞书并导出素材，自动内容加工和日报生成已暂停。

## 数据归属与更新

| 数据 | 权威位置 | 更新方式 |
|---|---|---|
| 原始采集记录 | 服务器 `/srv/ai-news-radar/source.sqlite` | worker 去重写入，历史记录保留 |
| 采集配置 | 飞书订阅、栏目、设置 | `apply-content-policy` 可预览规则变更；`--apply` 执行 |
| Obsidian 阅读副本 | 服务器 `/srv/ai-news-radar/obsidian-vault/素材` | [导出器](../apps/worker/scripts/export_obsidian.py)生成正式版 Markdown |
| 本机工作库 | `AI 新闻工作库/` | [拉取器](../deploy/pull_obsidian.py)从服务器更新 |

服务器[定时器](../deploy/ai-news-radar.timer)每 15 分钟执行；macOS 登录任务在联网时每 900 秒拉取。`管理.base` 首次创建后保留用户的排序和列设置。素材的文件名与 `source_id` 保持稳定；程序维护正文，非 UTF-8 字节仅在阅读副本替换并标注。

同步状态保存在 `.obsidian/collection-status.json` 与 `.obsidian/pull-status.json`，不出现在笔记列表中。

## 清理与恢复

[布局迁移](../apps/worker/scripts/obsidian_vault.py)将旧稿件、专题、模板、工作台、首页及旧 AGENTS 文件移入 `.obsidian/backups/minimal-v1/`。停用类型和预发布 Markdown 也移入该备份区；SQLite 原文不变。迁移只执行一次，不创建报道任务、模板或画布。

日常拉取验证服务器清单数量后，才归档已不在采集范围的程序生成文件；个人笔记不自动归档。传输采用明确的文件清单，旧预设和服务器桌面状态不再下发。

## 操作与验证

```bash
python3 apps/worker/scripts/export_obsidian.py --database /path/to/source.sqlite --vault /path/to/vault
python3 deploy/pull_obsidian.py --vault /path/to/vault --bootstrap
pnpm check
```

`--bootstrap` 只额外初始化管理表和基础设置。[回归测试](../apps/worker/test/test_obsidian.py)验证最小布局、备份恢复、正式版筛选、幂等更新及拉取完整性。
