# Relay CLI

[Relay](../README.md) 的内容加工 CLI。安装本机命令：

```sh
npm link --ignore-scripts
relay --help
```

[source.md](content/relay-demo/source.md) 保存原文，[processed.json](content/relay-demo/processed.json) 保存全文及各 chunk 的简要、解读。原始抓取材料见[来源记录](cases/relay-demo/README.md)。

在本目录设置一次默认工作区，之后可从任意目录运行：

```sh
relay config set workspace content/relay-demo
relay status
relay next --json
```

读取、写入、初始化和原文更新参数见 `relay --help`。加工循环见 [CLI 使用说明](docs/cli.md)，持久化结构和版本规则见[文件契约](docs/content-format.md)。

解读的 Unicode 图表达约定见[内容风格](docs/content-style.md)。

`npm run check` 验证实现及当前案例；`npm run build` 检查完整工作区后生成 demo。[build.py](build.py) 默认预览 `c0002`，可用 `--workspace`、`--chunk` 指定其他案例，`--chunk article` 预览全文。

运行构建后打开 [index.html](index.html)。构建生成 `data/article.json` 和 `article-data.js`。网页保留点击切换与原文按钮，动画使用 [Torph](https://github.com/lochie/torph)，许可证见 [vendor/TORPH-LICENSE.txt](vendor/TORPH-LICENSE.txt)。
