# Paper Translation Bridge for Zotero

让 Agent 通篇翻译论文，然后在 Zotero 里对照原文读。仓库里有两部分：一个翻译 skill（在 `.agents/skills/paper-translation/`）和一个 Zotero 侧栏插件（在 `plugin/`）。翻译由 Agent 完成，插件只负责显示——它读本地的 PDF、索引和译文，做双向定位，不联网，不碰模型。

当前版本 0.4.3。

## 快速上手

需要 Node.js 22.13+、Python 3 和 pdfplumber。首次使用（以下命令都在仓库根目录执行，`$PWD` 即该根目录；`.venv`、`node_modules`、`papers/` 都在 `.gitignore` 里，是本机产物）：

```bash
git clone https://github.com/habaniu/paper-translation-bridge-for-zotero.git
cd paper-translation-bridge-for-zotero
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install pdfplumber==0.11.9
export PDF_LAYOUT_PYTHON="$PWD/.venv/bin/python"
node scripts/prepare-paper.mjs "$PWD/papers/example-paper" --pdf "/path/to/paper.pdf"
```

`--pdf` 换成你自己的文件路径。`papers/` 是本地论文工作区，已被 Git 忽略，克隆后不存在，由上面这条命令按需创建；目录名可以自己取，不一定要叫 `example-paper`。同一份 PDF 会复用，不同版本不会覆盖旧文件。`export` 只对当前终端会话有效，新开终端要么重新执行，要么把这行写进 `~/.zshrc`。

准备好之后，把这个仓库作为 Agent 的工作区打开，说"通篇翻译这篇论文，目录是 `papers/example-paper`"。Agent 会按 skill 的流程读 PDF 和索引，把译文写进该目录的 `translated.md`，然后跑 `node cli.mjs align` 检查句子定位。机器检查之外，版面警告和图表公式还需要人眼看一遍（见「版面复核与修正」）。

要在 Zotero 里读：运行 `npm run build:plugin`，在 Zotero 里从文件安装 `dist/` 下生成的 XPI，然后在「工具 → 论文译文：本地目录设置」里把路径指到论文目录的**父目录**（上面例子里就是 `papers/` 的绝对路径）。之后日常阅读不需要起任何服务。

## 对照阅读怎么工作

在主窗口的 PDF 标签页右侧，插件通过官方 ItemPaneManager 加了一个「论文译文」分区，直接渲染本地的 `translated.md`。

- 选中英文、松开鼠标，对应的中文整句会高亮并在译文区居中。PDF 不跟着动。
- 双击中文译文块，两侧一起高亮，PDF 平滑滚动到原句。合译块会高亮所有对应句子。
- 高亮用的是临时覆盖层，不建批注、不改 PDF。换句、收起面板、切标签都会自动清掉。

定位不靠文本模糊匹配。准备阶段用 pdfplumber 量了每个字形的坐标，选句和回跳都用这套坐标，所以公式里的符号也能定。找不到可靠位置就直接提示失败，不猜。

## 文件长什么样

每篇论文一个目录，插件按目录读取，不复制进 Zotero 数据库：

```text
papers/<论文目录>/
├── paper.pdf                    # 原文
├── translated.md                # 译文（Agent 写的唯一产物）
└── .translation/source.json     # 源索引：哈希、句子编号、坐标
```

编号规则和句子标记的写法见 [TRANSLATION\_PROTOCOL.md](TRANSLATION_PROTOCOL.md)，skill 翻译前会先读它。插件会同时校验 PDF 文件、源索引和译文里的 SHA-256，对不上就报错，不会悄悄猜。

一份 PDF 只能对应一个论文目录。如果同一个文件有多份拷贝，插件不会自动选，把要用的那份集中到一个父目录再指过去。

## 边界

- 跨页句子支持同页或相邻两页；三页以上、扫描件、复杂双栏抽取不保证成功。
- 监听的是选区弹窗事件，不是拖动过程逐帧更新。
- 独立 PDF 阅读窗口没有侧栏，只支持主窗口标签。
- 本版没有滚动同步。
- 插件用了一些 Zotero 内部接口，升级 Zotero 后建议回归验证选句和跳转。
- 安全方面：Markdown 禁原始 HTML 和图片加载，KaTeX 用本地资源，论文内容不出本机。

## 版面复核与修正

索引在切句前先隔离标题和公式，避免公式里的标点干扰句子。建好索引后生成叠加图，人眼核对版面：

```bash
# 生成编号、字形位置和版面报告
node cli.mjs prepare papers/<论文目录>

# 生成区域叠加图，人眼核对
node cli.mjs layout papers/<论文目录>
node scripts/review-layout.mjs papers/<论文目录> 3,4
```

复核页面在 `.translation/layout-draft/review/index.html`，正文绿、标题蓝、公式橙，红色虚线是待复核的候选框。公式识别有误时，在页面里框选完整公式、下载 `layout-overrides.json` 存到论文的 `.translation/`——修正记录绑定 PDF 指纹，可复用，不用手填坐标。

目录里已经有 `translated.md` 时，改动复核记录或解析版本都不会自动重编号，重新准备会直接报错，只能走保留编号的迁移（将来解析版本升级导致索引变化时同理）：

```bash
node cli.mjs migrate-layout papers/<论文目录> --preserve-ids
node cli.mjs migrate-layout papers/<论文目录> --preserve-ids --apply
```

先不加 `--apply` 生成草稿并核对，确认无误再加。译文里的 `$$...\tag{N}...$$` 能自动绑定独立公式目标；没有唯一标签就不猜，歧义会阻塞迁移而不是替你选一个。完整流程和失败恢复（备份、`layout-migration.lock`）见翻译协议的「数据变更」部分。

## 开发

```bash
npm ci
npm test                 # node:test
npm run build:plugin     # 打包 XPI 到 dist/
```

仓库不含论文 PDF、译文、本机配置和构建产物。插件的 `update_url` 用的是保留地址，没有自动更新，升级靠手动装新包。

接口依据：[Zotero 自定义右侧栏](https://www.zotero.org/support/dev/zotero_7_for_developers#custom_item_pane_sections) 和[阅读器事件](https://www.zotero.org/support/dev/zotero_7_for_developers#custom_reader_event_handlers)。已在 Zotero 10.0.3 上核对过分区生命周期和插件资源加载的实现。
