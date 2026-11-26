# 阅读页怎样帮助读者理解？

网页底座的目标是让读者更快建立基本理解，并能就地展开或核对。项目目标见 [Relay 项目手册](../../docs/product-handbook.md)。

**阅读页**<br>
├─ **这篇或这节在说什么？** · 三段式阅读<br>
│　全文和章节都有简要、解读、原文。就地切换简要和解读，查看原文后可以返回先前视图。[阅读视图](../src/components/cell/CellBlogApp.tsx)<br>
├─ **这几张图有什么不同？** · 横滑图组<br>
│　连续图片等高并列，宽度随比例变化。超出阅读列时横滑，点图放大并查看图注。[图组与图注](../src/components/cell/ArticleImage.tsx)<br>
├─ **哪些词和关系值得先看？** · 视觉锚点<br>
│　粗体用样式色突出，Unicode 图折行时保留节点缩进，章节链接可以跳到详情。[文字渲染与链接](../src/lib/relay.ts)<br>
└─ **我读到哪了，下一步想去哪？** · 右侧刻度尺<br>
　　宽屏用刻度表示进度和章节，悬停看章节名，点击任意刻度跳转。窄屏使用正文内目录。[阅读刻度尺](../src/components/cell/ReadingRuler.tsx) · [窄屏目录](../src/components/cell/CellBlogApp.tsx)

网页负责渲染已有内容、维持阅读位置和提供跳转。正文怎样解释、粗体标什么、图画什么，由[内容风格](../../processing/docs/content-style.md)定义。
