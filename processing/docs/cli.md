# Agent 如何加工内容？

在加工源码目录运行以下命令。CLI 负责读写与检查，Agent 负责生成内容；字段和进度规则见[文件契约](content-format.md)。完整参数由 `relay --help` 提供。

## 默认工作区

先设置一次默认值，后续命令可以从任意目录运行：

```sh
relay config set workspace content/relay-demo
relay config
relay config get workspace
```

默认工作区仍对应一篇文章。相对路径在设置时转成绝对路径；配置默认保存在 `~/.config/relay/config.json`，遵循 `XDG_CONFIG_HOME`。`RELAY_CONFIG_FILE` 可指定独立配置文件，测试使用它避免修改用户设置。

显式 `--workspace` 优先于默认值，且不修改配置。临时切换和清除默认值：

```sh
relay status --workspace /path/to/another-article
relay config unset workspace
```

未配置时，工作区命令要求显式 `--workspace`。允许先配置尚未创建的目录，再运行 `relay init --input /path/to/article.md`。

## 启动 Pi

```sh
relay pi --workspace content/relay-demo
```

`relay pi` 和 `relay review` 都从加工源码目录启动。会话内的 Relay 命令默认指向本次绑定的文章。需要查阅其他文章时，可运行 `relay read --workspace content/<article-id> --unit article`。绑定随会话结束释放。

会话内的 `relay config` 显示固定项目目录。将该目录传给 `--workspace` 也会读取本次绑定的文章。会话外的 `relay config` 显示本机保存的设置。

`relay pi` 固定系统提示和内置工具 `read,bash,edit,write`，显式加载[项目 Relay Skill](../../.agents/skills/relay/SKILL.md)。扩展、MCP、其他 Skill 和上下文文件的自动发现关闭。训练和后续复用时可用 `--model <provider/model>` 指定同一模型。

Pi 原始记录保存在 `.relay/sessions/<article-id>/`。外部工作区的记录保存在该工作区的 `.relay/sessions/`。

用 `--checkpoint <session.jsonl>` 从冻结会话开一份独立的加工会话。相对路径按调用目录解析，文章仍由 `--workspace` 绑定。Pi 将新会话保存到文章对应的会话目录。

## 读取与提交

以下命令使用已配置的默认工作区：

```sh
relay status
relay read --unit article --json
relay read --unit c0034 --view all --json
relay next --json
```

`article` 表示全文，其他 unit 使用原文 chunk ID。`read` 默认读取原文，`--view all` 同时返回原文和已有加工结果。

`next` 返回一个待处理字段的原文、当前 `version` 和旧结果；可以用 `--unit`、`--field` 限定范围。顺序为全文、原文中的各 chunk；每个 unit 先 `brief`，后 `interpretation`。它只查询任务，不占用或启动 Agent。

Agent 生成内容后写入 UTF-8 文件，再提交：

```sh
relay write --unit c0034 --field brief --version 2 --input /tmp/brief.md --json
relay write --unit article --field interpretation --version 2 --input /tmp/interpretation.md --json
```

也可以用 `--input -` 从 stdin 接收正文，避免命令行转义。`--version` 必须使用本次读取返回的版本；冲突时重新读取原文。

## 串读、局部编辑与导出

```sh
relay read --sequence --view brief --json
relay read --sequence --view interpretation --json
relay edit --unit c0034 --field brief --version 2 --before '旧片段' --after '新片段' --json
relay review --out /path/to/reviewed.json --json
```

`read --sequence` 按原文顺序返回各章节的指定视图、ID 和状态。全文稿仍通过 `read --unit article` 读取。

`edit` 在当前版本的已完成字段中替换唯一匹配的片段，并返回 `diff.before` 和 `diff.after`。片段缺失或重复时重新读取并选取更精确的上下文。用 `--after ''` 删除片段。

`review` 使用已配置的 Pi 模型。在同一会话先注入章节简要，再注入章节解读和上轮修改。每条编辑提供 `unit`、`before` 和 `after`，需要进一步核对的问题写入 `findings`。两轮完成且稿件通过校验后，CLI 保存修改并将阅读页所需的文档 JSON 写入 `--out`。并发修改或审阅失败时保留原稿及已有导出。目录需已存在，`--model` 可覆盖 Pi 的默认模型。

## 初始化与重新分块

```sh
relay init --input /path/to/article.md --title "Article" --url https://example.com/article
relay rechunk
relay rechunk --input /path/to/structured-original.md
```

`init` 和 `rechunk` 使用[章节边界规则](content-format.md#sourcemd)。已有工作区通过 `rechunk` 显式迁移，旧稿备份与新稿待办规则见[重新分块](content-format.md#重新分块)。

## 恢复与结束

每次成功 `write` 都持久化到 `processed.json`。再次调用 `next` 会跳过已完成字段，因而中断后可以继续，不需要额外进度文件。

`next` 的 `task: null` 表示选定范围没有待办；整个工作区是否完成要看 `ready`。`status --json` 提供全局计数和逐项状态，`errors` 只列结构问题。

```sh
relay check --json
relay export --unit article --out /tmp/article.json --json
npm run build
```

`export --document` 一次导出全文和所有 chunk，按原文顺序保留 ID，供阅读前端构建使用。它与 `--unit`、`--chunk` 互斥。

`check` 和 `export` 要求全文及所有 chunk 的两项内容都完成。`export --unit article` 导出全文；`npm run build` 使用项目现有 demo 的预览配置。

所有命令支持 `--json`；命令失败退出码非零，错误包含 `code` 和 `message`。`status`、`next` 有待办时仍正常退出。写操作用临时 `.content.lock` 互斥，遇到 `workspace_busy` 应在当前命令结束后重试。锁内记录 PID；若进程异常退出，确认该进程已结束后再清除遗留锁。

命令入口见 [relay.mjs](../bin/relay.mjs)，加工操作见 [processing.mjs](../scripts/processing.mjs)，配置见 [config.mjs](../scripts/config.mjs)，验证见 [processing.test.mjs](../test/processing.test.mjs) 和 [config.test.mjs](../test/config.test.mjs)。
