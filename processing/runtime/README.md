# Relay Agent 工位

[测试配置](../practicum-workspace.json)从 `/work/task` 启动 Pi，并将本轮文章工作区挂载到相同路径。通过 `--shared` 提供的成稿按文章 ID 排列，挂载到只读的 `/work/shared`。镜像提供 `relay` 命令和 `/work/tools/relay` 下的 Skill 与说明。宿主机文章目录由派稿时的 `--task` 指定。

在仓库根目录构建测试镜像。若本机缺少基础镜像，先运行 `practicum build --pi-version 1.6.0`。构建上下文只打包 CLI、Skill 和文档。

```sh
context="$(mktemp -d)"
tar -cf "$context/context.tar" processing/runtime/Containerfile processing/bin \
  processing/scripts processing/docs processing/package.json processing/package-lock.json \
  docs/product-handbook.md docs/processing-blueprint.md .agents/skills/relay
tar -xf "$context/context.tar" -C "$context"
podman build --tag localhost/relay-workspace:pi-1.6.0 \
  -f "$context/processing/runtime/Containerfile" "$context"
rm -rf "$context"
```

用独立的练习文章和只读成稿验证挂载。分别以两个不同的宿主机目录作为 `--task` 执行一次。

```sh
practicum doctor --project processing/practicum-workspace.json --task "$task" --shared "$shared"
```

之后让 Pi 通过 `relay` 读写本轮文章，并读取 `/work/shared/<article-id>` 中的一篇成稿。交付用 `relay check` 验证。生产岗位配置见[部署说明](../../reading/docs/production.md)。
