# 原文与加工结果如何关联？

每篇内容只有两个业务文件：[source.md](../content/relay-demo/source.md) 和 [processed.json](../content/relay-demo/processed.json)。全文使用 `article`，章节通过 `chunk_id` 一对一连接；每个 unit 都有 `brief`、`interpretation`。网页数据由它们导出。

## source.md

文件头包含 `title`、`url`、`version` 和 `next_chunk`。元数据采用扁平 YAML，值使用 JSON 字面量。`version` 从 `1` 开始。

`init` 默认每个顶层 H2 章节一个 chunk，范围到下一个 H2。H3 及以下标题、段落、列表、表格、引用和代码都留在章节内；代码块和引用内的 H2 不产生边界。

第一个 H2 前有实质正文时，保留独立 Intro；只有 H1 等标题时，前缀归入第一个章节。没有 H2 的全文作为一个 chunk。正文只统一换行为 LF 并补齐末尾换行。

每块包在 `<!-- chunk:c0001 -->` 与 `<!-- /chunk -->` 之间。ID 表示身份，移动块不改 ID。`next_chunk` 由程序维护，编号不回收。全文原文由这些内容按原顺序组成，不额外存一份。

## processed.json

```json
{
  "source": "source.md",
  "article": {
    "brief": { "text": "全文简要。", "source_version": 1 },
    "interpretation": { "text": "全文解读。", "source_version": 1 }
  },
  "chunks": {
    "c0001": {
      "brief": { "text": "章节简要。", "source_version": 1 },
      "interpretation": { "text": "第一段解释。\n\n第二段解释。", "source_version": 1 }
    }
  }
}
```

`chunks` 的 key 对应原文 ID；展示顺序以原文为准。`text` 是字符串，里面的 Markdown 标题和代码围栏不参与结构解析。新槽位使用空字符串。

每个字段的 `source_version` 独立记录 Agent 写入时所依据的原文版本，不能领先原文；更新一项不代表另一项已经复核。CLI 自动维护这个整数，不需要 Agent 改结构或版本字段。

状态由文件内容推导，不另存进度：

| 状态 | 条件 |
|---|---|
| `pending` | 正文为空、缺失或只有占位符 |
| `stale` | 正文存在，但版本落后于原文 |
| `done` | 正文存在，且版本与原文一致 |

旧格式的全局 `source_version` 和字符串字段仍可读取；`sync` 或 `write` 会保留原有正文，转换为上述格式，并补上全文槽位。

## 原文更新

1. 从当前 `source.md` 创建编辑副本，保留已有 chunk 标记和 `version`；新内容可以不加标记。
2. 运行 `update --workspace … --input /path/to/edited-source.md`。脚本比较副本与当前原文，有变化才递增 `version`，并为新内容分配 ID、补齐空槽位；无变化不递增。
3. Agent 通过 CLI 读取待办并重新提交，操作见[加工命令](cli.md)。

`update` 拒绝版本落后的副本。原文版本变化后，所有已有非空结果保留，并变为 `stale`；逐项写入后恢复为 `done`。删除原文后也保留对应旧结果，检查器报告额外引用，交由处理者确认清除。

`sync` 只补齐结构，不递增版本，也不把加工结果标为已复核。直接修改当前 `source.md` 后，版本号无法自动发现正文变化；更新原文必须通过 `update`。

## 重新分块

`rechunk [--input plain-markdown.md]` 显式按上述章节规则重新切分；省略输入时使用当前原文。普通 `sync` 和 `update` 保留已有块的身份，不自动重排边界。

切分变化时，CLI 先把旧的两个文件完整备份到 `.history/rechunk-v<version>-<unique-id>/`，再递增版本，为所有新章节分配未使用的 ID 和空槽位。旧段落稿留在备份里，不作为新章节稿拼接；全文稿保留为 `stale`，需要复核后提交。输入必须是无 chunk 标记的 Markdown，不含文件头。文字和边界都相同时，不改文件、版本或 ID，也不创建备份。

## 自动检查

检查原文 ID 唯一、JSON key 不重复、两边 ID 对应、字段类型正确且非空、来源文件正确，以及各字段版本一致。

全文或任意 chunk 不合格，`export` 都拒绝导出，包括未选中预览的 chunk。检查保证结构完整，不证明内容正确，也不能证明 Agent 已实际完成复核。

存储与检查由 [content-store.mjs](../scripts/content-store.mjs) 、[content.test.mjs](../test/content.test.mjs) 和 [rechunk.test.mjs](../test/rechunk.test.mjs) 定义。
