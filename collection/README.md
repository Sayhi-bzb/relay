# AI 新闻雷达

Worker 按订阅采集版本更新。飞书多维表格管理订阅和栏目，SQLite 保存原始事件及同步状态，Obsidian 保存导出的 [Markdown 素材和管理视图](docs/obsidian.md)。

**飞书采集配置 → Worker → SQLite**<br>
　　　　　　　　　　　├→ 飞书动态<br>
　　　　　　　　　　　└→ Obsidian Markdown

订阅的「标识」必须唯一。表字段映射见 [Base 客户端](apps/worker/src/base.ts)，本地队列见 [SQLite 存储](apps/worker/src/sqlite.ts)。

## 开发与验证

需要 Node.js 24 和 pnpm。按 [环境样例](apps/worker/.env.example)配置应用及表格 ID。用于真实采集的飞书应用需要对应表格的访问权限。

```sh
pnpm install --frozen-lockfile
pnpm check
```

[Compose](deploy/compose.production.yml)使用 `AIDT_WORKER_IMAGE` 指定自行构建的镜像，镜像入口见 [Dockerfile](apps/worker/Dockerfile)。[定时器](deploy/ai-news-radar.timer)每 15 分钟启动一次 worker。
