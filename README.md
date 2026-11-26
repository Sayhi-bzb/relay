# Relay

Relay 采集软件的正式版和更新日志，将原始素材加工为简要、解读和原文三个阅读视图。

**采集** · [AI 新闻雷达](collection/README.md)<br>
└→ **加工** · [Relay CLI](processing/README.md)<br>
　　└→ **阅读** · [阅读站](reading/README.md)

[产品手册](docs/product-handbook.md)定义阅读与写作的目标。[发布编排](reading/docs/production.md)连接采集、编辑运行时和静态站点。

## 本地验证

需要 Node.js 24、Python 3 和 pnpm。站点内置一篇虚构示例，启动预览只需要依赖和示例文件。

```sh
(cd processing && npm ci && npm run check)
(cd reading && npm ci && npm test && npm run check && npm run build)
(cd collection && pnpm install --frozen-lockfile && pnpm check)
```

在 `reading/` 运行 `npm run dev` 查看示例。采集和模型凭据由各自的环境配置提供。
