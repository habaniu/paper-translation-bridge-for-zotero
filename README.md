# Paper Translation Bridge for Zotero（0.4.3）

本仓库同时提供论文翻译 skill 和 Zotero 译文侧栏。**Agent 负责建档、翻译与核对；Zotero 插件只读取本地 PDF、索引和译文，提供双向定位，不调用翻译模型。** 论文 PDF、译文和本机配置不随源码上传。

## 文件在哪里、怎么用

- **Skill：**[`.agents/skills/paper-translation/SKILL.md`](.agents/skills/paper-translation/SKILL.md)。以本仓库为 Codex 工作区时，Agent 可发现并使用它；明确要求“通篇翻译这篇论文”时使用。只问论文内容或只翻译一节时，不触发全文流程。
- **翻译规则：**[`TRANSLATION_PROTOCOL.md`](TRANSLATION_PROTOCOL.md)。说明主体范围、句子编号、图表与公式处理、版面复核及验收标准；skill 会先读它。
- **准备与校验程序：**`scripts/prepare-paper.mjs`、`cli.mjs`。前者保存同版 `paper.pdf` 并生成源索引，后者可重建译文定位映射。
- **Zotero 插件源码：**`plugin/`，构建入口是 `scripts/build-plugin.mjs`；安装包在本地构建后生成于 `dist/`。

首次使用：安装 Node.js 22.13+、Python 3 和 `pdfplumber`，然后在仓库根目录运行：

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install pdfplumber==0.11.9
export PDF_LAYOUT_PYTHON="$PWD/.venv/bin/python"
node scripts/prepare-paper.mjs "$PWD/papers/example-paper" --pdf "/path/to/paper.pdf"
```

将 PDF 路径换成自己的。仓库内的 `papers/` 是本地论文工作区，已被 Git 忽略。准备后，打开**这个仓库**作为 Codex 工作区，提出“通篇翻译这篇论文，目录是 `papers/example-paper`”。Agent 按 skill 阅读 PDF 与索引，写入该论文目录的 `translated.md`，并运行 `node cli.mjs align` 检查定位；人工还需核对版面警告、正文覆盖及图表公式。若只是使用已准备好的 PDF，可省略 `--pdf`，同版文件会复用，不同版不会被覆盖。

要在 Zotero 中阅读，运行 `npm run build:plugin`，安装生成的 XPI，并把插件的“本地目录设置”指向论文目录的**父目录**（上述例子为仓库内的 `papers/` 绝对路径）。日常阅读不需要运行 Node/Python 服务。详细界面操作见下文。

## 双向整句对照

- 译文分区展开且实际可见时，选中英文会高亮对应译文和完整原句；不会因为选英文改变 PDF 滚动位置。
- 双击中文译文块，两侧同时高亮，PDF 只沿纵轴平滑滚动到对应原句并居中；合译块高亮全部对应句子，跨页优先定位首句所在页。
- 原文使用临时覆盖层，不创建 Zotero 批注，也不修改 PDF。选中新句、收起右栏/译文分区、切换标签或卸载插件时清理。关闭右栏时的英文选择不会排队到重开后执行。
- 区域版索引使用准备阶段测量的 PDF 字形坐标；旧索引仍保留 Zotero 文本查找。找不到可靠区域或接口不兼容时提示失败，不猜测位置。此适配使用部分内部接口，升级 Zotero 后需回归验证。
- 本版不实现滚动同步（功能 1）。

在 **Zotero 10.x 主窗口的 PDF 标签页**右侧，利用官方 ItemPaneManager 增加“论文译文”分区。直接读取本地 Markdown，选中英文并松开鼠标后，高亮对应完整译句并在译文容器内居中。无需浏览器、Node 服务或配对令牌，不调用翻译模型，不修改 PDF、批注或译文。

## 安装与使用

1. Zotero → 工具 → 插件 → 从文件安装，选择本地构建的 `dist/paper-translation-bridge-0.4.3.xpi`，升级原来的同 ID 插件。升级后建议完全退出再启动，避免旧分区/本地化资源残留。
2. 工具 → 论文译文：本地目录设置，选择你存放论文工作目录的父目录，例如本仓库的 `papers/` 绝对路径。路径只保存在本机 Zotero 首选项。
3. 在 Zotero 主窗口打开 PDF 标签，展开右侧条目面板，点击“论文译文”导航图标/分区。可使用 Zotero 自带的固定分区功能保留显示，并拖宽右侧栏。
4. 使用普通文本选择工具选中几个英文词；对应整句中文会高亮、居中。跨句时同时高亮；超过一屏时先显示第一个译文块。

译文每约 2.5 秒检查更新，也可点“刷新”。**不需要执行 `npm start`。** 当前实现面向主窗口阅读标签；独立 PDF 阅读窗口未实现侧栏支持，不能当作已支持功能。

## 文件与校验

仍读取 `papers/<论文目录>/` 下的文件，不复制进 Zotero 数据库：

```text
paper.pdf
translated.md
.translation/source.json
```

`source.json` 和译文编号沿用 [TRANSLATION_PROTOCOL.md](TRANSLATION_PROTOCOL.md)。插件直接解析 `translated.md` 中的 SHA-256 与句子标记，不要求运行时存在 `translated.align.json`。无需重新翻译或重编号。

匹配同时校验 Zotero 附件、论文目录的 PDF、source.json、译文中的 PDF 哈希。不匹配、缺文件、空译文、重复/未知编号都会显示错误，不会悄悄猜测。缺号不当作错误：参考文献等排除内容本来就无需翻译。选区含未翻译句子时明确提示。

每个 PDF 必须对应唯一论文目录；出现多个相同 PDF 副本时暂不自动绑定，界面会提示。可将需要使用的副本集中在一个独立父目录，再将插件指向该父目录。

## 定位策略与边界

- 监听官方 `renderTextSelectionPopup`，使用选区英文、零基页码与相邻页标志。
- 新区域索引按 PDF 页码和矩形匹配；公式中的纯符号也可以定位。反向跳转和高亮使用同一套坐标，不再用去掉数学符号后的文本猜位置。旧索引才沿用规范化文本查找。
- **不假设 Zotero 的 PDF.js 文本项编号与离线索引相同。** 坐标来自测量字形，非等宽插值；新流程遇到未知区域不回退到模糊文字匹配。
- 跨页原句作为完整句参与匹配；同页或相邻两页是支持范围。三页以上、复杂公式、扫描/OCR、复杂双栏抽取异常不保证成功。
- 不是拖动过程中的逐帧更新，而是选区弹窗事件触发后的联动。
- 选中英文时只滚动译文容器；双击中文时才主动导航 PDF。每个标签对应自己的译文视图，旧异步结果不得覆盖新标签。

Markdown 禁止原始 HTML，禁用图片加载；KaTeX 使用本地资源，关闭 trust。链接仅在主动点击时允许 HTTP/HTTPS 外部打开。插件不发送论文内容到网络。禁用/卸载会清理监听、定时器和界面，不删除论文文件或目录偏好。

## 区域索引与旧译文升级

准备阶段需要 Node.js 22.13+、Python 3 + pdfplumber（已在 0.11.9 验证）；设置 `PDF_LAYOUT_PYTHON` 可指定 Python。插件日常阅读不需要这些运行时或服务。安装依赖可使用独立 venv：`python3 -m venv .venv`，再运行 `.venv/bin/pip install pdfplumber==0.11.9`，将 `PDF_LAYOUT_PYTHON` 设为该 venv 的 Python 绝对路径。

完整论文翻译使用 [paper-translation skill](.agents/skills/paper-translation/SKILL.md) 和 [翻译协议](TRANSLATION_PROTOCOL.md)。首次准备可运行 `npm run prepare-paper -- /path/to/papers/<论文目录> --pdf /path/to/original.pdf`；同版 PDF 会复用，不同版会拒绝覆盖。已有 `paper.pdf` 时省略 `--pdf` 即可再次准备。skill 依赖本仓库的协议和 CLI，使用时应保留完整仓库目录。

在本仓库目录运行：

```bash
# 新论文：自动生成编号、字形位置和版面报告
node cli.mjs prepare papers/<论文目录>
# 只生成区域草稿，不更改正式索引和译文
node cli.mjs layout papers/<论文目录>
node scripts/review-layout.mjs papers/<论文目录> 3,4
# 旧译文：保留所有编号与译文字节，核对草稿后再加 --apply
node cli.mjs migrate-layout papers/<论文目录> --preserve-ids
node cli.mjs migrate-layout papers/<论文目录> --preserve-ids --apply
```

报告与叠加图位于 `.translation/layout-draft/`。标题、普通编号公式通过启发式独立分块；密集相邻编号、未编号、多行文字标签、异常字体等可能标为待复核，不承诺任意数学排版自动正确。扫描页不做 OCR。红色报告项不等于翻译遗漏，也不能忽略范围内实际问题。报告数量可能包含同一问题的区域与编号记录，并非错误公式数量。

当前新索引使用 `regions-v2`：先隔离标题和公式，再合并正文、切分句子，避免公式内的 `s.t.` 等标点影响前后正文。已有索引不自动重编号。

复核页为 `.translation/layout-draft/review/index.html`，与同目录页图一起保留，可本地打开。它显示正文、标题、公式和待复核候选框；红色虚线只用于诊断，不会变成可靠定位坐标。在“选择原始文本项”模式下，选择完整公式（含编号、上下标），填写核对说明并下载 `layout-overrides.json`，保存到论文的 `.translation/`，再生成并核对草稿。记录绑定 PDF 指纹和文本提取版本；重复占用文本项、只替换旧区域的一部分、字形测量失败会拒绝或继续标为待复核。修正记录可重复用于后续准备，不需手填坐标。完整流程见 [翻译协议的版面复核](TRANSLATION_PROTOCOL.md#版面复核与持久修正)。

旧译文中的 `$$...\tag{N}...$$` 可自动绑定独立公式目标；没有唯一标签时不猜测。完整重编号迁移需去掉 `--preserve-ids`，有歧义则拒绝应用。备份、锁与失败恢复见 [翻译协议](TRANSLATION_PROTOCOL.md)。Agent 仍只写短 ID 标记和译文，不新增坐标/JSON 输出任务。

## 开发与本地版本管理

源码仓库不包含论文 PDF、译文、本机配置、令牌、构建产物或 `node_modules`。下列命令用于开发和验证。

```bash
npm ci
npm test
npm run build:plugin
```

构建将 Markdown/数学渲染库、许可和字体一起打包，不包括论文或秘密文件。Zotero 安装器必填的 `update_url` 使用保留 `.invalid` 地址；仅支持手工更新，自动检查更新可能提示连接失败。

旧 IP 桥接服务及网页实现已从发布源码移除。自动测试和安装包完整性检查不等于 Zotero 实机操作验收；升级 Zotero 后应复核选句、双击跳转及公式定位。

## 原始接口依据

- [官方自定义右侧栏接口](https://www.zotero.org/support/dev/zotero_7_for_developers#custom_item_pane_sections)
- [官方阅读器事件](https://www.zotero.org/support/dev/zotero_7_for_developers#custom_reader_event_handlers)
- 已核对本机 Zotero 10.0.3 的 `pluginAPI/itemPaneManager.js`、`itemPaneCustomSection.js`、`elements/contextPane.js` 和 `xpcom/plugins.js`：分区生命周期、标签归属、插件资源加载与本地化契约。
