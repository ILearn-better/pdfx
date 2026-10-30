---
name: pdf-toolkit
display_name: PDF 编辑与扫描件 OCR
display_name_en: PDF Toolkit (native + scanned OCR)
description: |
  统一处理"结构化 PDF"与"扫描/图片型 PDF"的本地工具箱。支持新建/导入、页面增删、
  文本框与手写笔迹与图片的插入/修改/删除、全文检索（扫描件自动 OCR）。
  提供 CLI（JSON 输出）、HTTP API、Python 三种调用方式，供 AI 直接驱动。
  当用户要"改 PDF 里的字/删某一页/加批注/在扫描件上写字/查 PDF 里有没有某句话"时使用。
version: 1.0.0
auto_trigger:
  keywords: [PDF编辑, 修改PDF, PDF改字, PDF替换文字, 删除PDF页面, 添加PDF页面, PDF插入图片,
    PDF加批注, PDF手写, PDF涂改, 扫描件OCR, 扫描PDF识别, 图片型PDF, 发票识别, 合同改字,
    PDF全文检索, PDF搜索文字, PDF提取文字, 合并PDF页面, PDF旋转, PDF加水印文字,
    无文本层PDF, PDF页码, pdfx]
---

# PDF 工具箱（结构化 + 扫描件统一处理）

## 何时用

- 用户给出一个 PDF，要求**改字、删页、加字、插图、手写批注、盖章式标注、检索内容、导出文本**
- 该 PDF 可能是**扫描件/照片**（没有文本层），普通 PDF 库改不动 —— 本工具会自动 OCR 并支持"贴补式"编辑
- 需要在扫描件上"把某行字改掉"这类传统工具做不到的操作

## 环境

已安装在本机：`~/.workbuddy/skills/pdf-toolkit/`（自包含，含 pdfx 包与前端）。
依赖：PyMuPDF / Flask / numpy；OCR 后端按优先级自动选择
（RapidOCR → Windows 系统 OCR → Tesseract），不可用时自动降级为"仅文本层"。

调用入口（任选其一）：

```bash
# Windows cmd / PowerShell
%USERPROFILE%\.workbuddy\skills\pdf-toolkit\bin\pdfx.cmd describe "D:\a.pdf"
# Git Bash
~/.workbuddy/skills/pdf-toolkit/bin/pdfx describe "D:/a.pdf"
```

下文统一简写为 `pdfx`。

## 三条铁律（AI 必读）

1. **坐标是 PDF 点**（1pt = 1/72 inch，A4 = 595×842），**原点在左上角**，x 向右、y 向下。
   和前端 CSS 像素换算：`px = pt × 96/72`。
   **页码一律 0 基**：`--page 0` 是第一页，`--pages "0-2"` 是前三页。
2. **先 list 再操作**。每个对象都有 id，但**编辑后 id 可能变化**，每次编辑完要重新 list。
3. **默认写回原文件**。想保留原件必须加 `-o 新路径.pdf`，或先 `--no-save` 做多步再 `save`。

## 标准工作流

```bash
pdfx describe "a.pdf"                    # 1. 看几页、每页是 text 还是 scanned、有多少对象
pdfx text list "a.pdf" --page 0          # 2. 列出该页文本行（扫描页自动 OCR），拿 id
pdfx text update "a.pdf" --page 0 --id "p0:o57,429" --text "新内容"   # 3. 精确改
pdfx search "a.pdf" "要核对的词"          # 4. 验证：新内容能搜到、旧内容搜不到
```

`describe` 返回的关键信息：

```json
{"page_count":1,
 "pages":[{"index":0,"type":"scanned","size":[595,842],
           "native_text_lines":0,"native_images":1,"user_texts":0,"strokes":0}]}
```

`type` 含义：`text` 有文本层 / `scanned` 整页是图 / `mixed` 图文混合 / `empty` 空白。

## 命令速查

| 目的 | 命令 |
|---|---|
| 新建 | `pdfx new out.pdf --size a4 --pages 2` |
| 看结构 | `pdfx describe a.pdf` |
| 页面 | `pdfx page add a.pdf --at 1 --size a4` / `page delete a.pdf --pages "1,3-4"` / `page move --from 0 --to 3` / `page rotate --pages all --degrees 90` / `page import --src b.pdf --pages "0-2"` |
| 列文本 | `pdfx text list a.pdf --page 0 [--ocr]` |
| 加文本 | `pdfx text add a.pdf --page 0 --text "已复核" --rect 400,60,540,84 --size 12 --color "#c00"` |
| 改文本 | `pdfx text update a.pdf --page 0 --id "p0:t56,57" --text "新标题"` |
| 移动缩放文本 | `pdfx text transform a.pdf --page 0 --id "p0:t56,57" --rect 56,140,320,152 [--size 12]` |
| 删文本 | `pdfx text delete a.pdf --page 0 --id "p0:t56,57"` （可重复 `--id`，或用 `--id "x0,y0,x1,y1"` 按区域删） |
| 列图片 | `pdfx image list a.pdf --page 0` |
| 加图片 | `pdfx image add a.pdf --page 0 --rect 300,520,420,600 --src logo.png` |
| 换图片 | `pdfx image replace a.pdf --page 0 --id "p0:i@56,500" --src new.png` |
| 删图片 | `pdfx image delete a.pdf --page 0 --id "p0:i@56,500" [--mode purge]` |
| 移动缩放图 | `pdfx image transform a.pdf --page 0 --id "..." --rect 100,100,260,220 [--no-keep-ratio]` |
| 手写笔迹 | `pdfx ink add a.pdf --page 0 --strokes '[{"points":[[60,700],[120,680]],"color":"#1a73e8","width":3}]'` |
| 擦笔迹 | `pdfx ink erase a.pdf --page 0 --points "150,690;160,690" --radius 12` / `--bbox 100,680,200,720` |
| 擦页面内容 | `pdfx erase a.pdf --page 0 --points "120,300;260,300" --radius 14` / `--rects "x0,y0,x1,y1;..."`（结构化页真删文字，扫描件涂纸色；`--no-text` 只涂不删）|
| 烘焙笔迹 | `pdfx ink flatten a.pdf` （转成矢量图形，之后不可再擦） |
| 检索 | `pdfx search a.pdf "关键词" [--pages "0-2"] [--regex] [--ocr]` |
| 导出文本 | `pdfx extract a.pdf -o out.txt [--ocr]` |
| 渲染预览 | `pdfx render a.pdf --page 0 --dpi 150 -o p0.png` |
| 起服务 | `pdfx serve a.pdf --port 8765` （浏览器编辑器 + REST API） |

所有命令默认输出**单行 JSON**：`{"ok":true,"data":{...},"warnings":[]}`；失败退出码非 0 且
`{"ok":false,"error":{"code":"...","message":"..."}}`。加 `--pretty` 缩进、`--human` 输出人读文本。

## 对象 id 规则

| 来源 | 形如 | 稳定性 |
|---|---|---|
| 文本层 | `p0:t56,57` | 由左上角坐标生成，跨会话稳定 |
| OCR 行 | `p0:o57,429` | 同上，但**重新 OCR 后可能变** |
| 我插入的文本 | `p0:ut1a2b3c4d` | 记录在文档内，最稳定 |
| 原生图片 | `p0:i@56,500` | 按显示位置，编辑后位置不变则 id 不变 |
| 我插入的图片 | `p0:ui1a2b3c4d` | 稳定 |
| 笔迹 | `p0:k1a2b3c4d` | 稳定 |

不确定时不要猜 id —— 先 `list` 拿准确值。

## 两类 PDF 的一致性（重要）

上层 API 完全一致，差别只在底层动作，**不需要写两套逻辑**：

| 操作 | 结构化 PDF | 扫描件 PDF |
|---|---|---|
| 读文本 | 直接读文本层（精确、便宜） | 渲染 200dpi → OCR（有缓存） |
| 改文本 | redaction 真删原字，再按原字号/颜色重绘 | 用页面底色**覆盖**原像素，再绘新字 |
| 删文本 | redaction 删除（保留图像与矢量） | 画背景色块盖住 |
| 检索 | 文本层匹配 | OCR 行匹配，支持"忽略空白"（OCR 常把 `12,000` 拆成 `1 2，0 0 0`） |

判断依据是**位图覆盖率**而非"有没有文字"：扫描页插入了新文本后仍然是 `mixed`，
检索依然会 OCR，不会丢掉原图内容。

已知边界：

- 扫描件"改字"是**覆盖**，不是真删。原像素还在文件里（只是被盖住）。
- 覆盖色取自区域边缘的**众数颜色**，纯色底纸效果好；照片/复杂底纹会有色差。
  可以 `--background "#f5f5f5"` 手动指定。
- OCR 不保证 100% 准确（Windows OCR 对中文打印体约 95%），**改字前先用 `--pretty` 看清
  `text` 原文**，避免把识别错的字当成"要改的字"。
- 扫描页字号由行高估算（`行高 × 0.95`），必要时用 `--size` 指定。

## 常见配方

**A. 把合同里的金额改掉（扫描件）**

```bash
pdfx text list "合同.pdf" --page 0                      # 找到含"1,038,000"的 id
pdfx text update "合同.pdf" --page 0 --id "p0:o57,298" \
     --text "合同总金额人民币 1,200,000.00 元（大写：壹佰贰拾万元整）。" --size 12
pdfx search "合同.pdf" "1,200,000"                      # 确认新值可检索
```

**B. 批量给每页右下角盖"内部资料"**

```bash
# 遍历页号，用 --point 定位、给它一个不透明的底色块
for i in 0 1 2; do
  pdfx text add "a.pdf" --page $i --text "内部资料 请勿外传" \
    --point 430,780 --width 130 --size 10 --color "#c62828" --background "#ffffff"
done
```

**C. 删掉某页上的一段话（结构化）**

```bash
pdfx text list "a.pdf" --page 2 | head -c 2000   # 找 id
pdfx text delete "a.pdf" --page 2 --id "p2:t56,300"
```

**D. 在扫描件上批注 + 画圈 + 擦除**

```bash
pdfx ink add "a.pdf" --page 0 --strokes '[{"points":[[100,200],[140,190],[180,205]],"color":"#d64545","width":2.5}]'
pdfx ink erase "a.pdf" --page 0 --points "150,195" --radius 10   # 只擦经过的那段，笔画会被切开
pdfx ink flatten "a.pdf"                                          # 定稿后烘焙，避免阅读器不显示注释
```

**D2. 擦掉扫描件上原有的手写字 / 印章（不是自己画的笔迹）**

```bash
# 结构化页：命中的文字走 redaction，真删，检索也查不到
pdfx erase "a.pdf" --page 0 --points "120,300;260,300" --radius 14
# 扫描件 / 图片页：按擦除区周边的纸色涂掉，视觉上干净
pdfx erase "a.pdf" --page 1 --rects "120,560,300,640"
pdfx erase "a.pdf" --page 1 --points "120,560;300,640" --no-text   # 只涂不删文字层
```

> 一次调用同时处理「笔迹」和「页面内容」；可撤销（`pdfx undo a.pdf`）。

**E. 挪动 / 缩放已有元素（不改内容）**

```bash
pdfx text list "a.pdf" --page 0                      # 先拿到 id 和当前 bbox
# 只平移：目标框高度与原来一致（否则字号会跟着变）
pdfx text transform "a.pdf" --page 0 --id "p0:t56,57" --rect 56,140,320,152
# 放大：高度变 1.5 倍 → 字号自动 ×1.5
pdfx text transform "a.pdf" --page 0 --id "p0:t56,57" --rect 56,140,380,170
# 想固定字号就显式给 --size（只改框，不改字）
pdfx text transform "a.pdf" --page 0 --id "p0:t56,57" --rect 56,140,380,170 --size 12
# 图片：默认等比（拖角）；--no-keep-ratio 允许单向拉伸（拖边）
pdfx image transform "a.pdf" --page 0 --id "p0:i@56,500" --rect 100,600,220,700 --no-keep-ratio
```

要点：原位置会被真正抹除（结构化页 redaction，扫描页底色块），不留残影。
界面上选中对象后的 8 个手柄，调的就是这两个接口。

**F. 只查不写（安全模式）**

```bash
pdfx search "a.pdf" "违约金" --pretty        # 检索不会改文件
pdfx extract "a.pdf" --ocr -o full.txt       # 导出全文
```

## HTTP API（给前端/远程 AI）

```bash
pdfx serve a.pdf --port 8765        # 打开 http://127.0.0.1:8765
```

核心端点（全部返回 `{ok,data|error}`，坐标为 pt）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/doc` | 文档结构 + doc_id |
| GET | `/api/docs` | 会话内所有文档（`{docs:[{doc_id,name,path,page_count,modified}], current}`）|
| GET | `/api/caps` | 能力清单 `{version, caps:[...]}`；前端用它判断服务端是不是旧进程 |
| POST | `/api/doc/activate` | `{doc}` 切换当前文档 |
| POST | `/api/new` | `{size, pages}` 新建独立文档，返回 `path: null` |
| POST | `/api/page/import` | `{path\|data_url, pages, at}` 把另一份 PDF 的页插进来 |
| GET | `/api/page/{i}/objects` | 该页文本/图片/笔迹清单 |
| GET | `/api/page/{i}.png?dpi=110` | 页面位图 |
| POST | `/api/search` | `{query, pages?, regex?, force_ocr?}` |
| POST/PUT/DELETE | `/api/text` | `{page, text, rect\|point}` / `{page, id, text}` / **`{page, id, rect, font_size?}` = 移动缩放** / `{page, id}` |
| POST/PUT/DELETE | `/api/image` | `{page, rect, data_url}` / `{page, id, data_url}` / **`{page, id, rect, keep_ratio?}` = 移动缩放** / `{page, id, mode}` |
| POST | `/api/ink` `/api/ink/erase` | `{page, strokes}` / `{page, points|bbox, radius, mode}` |
| POST | `/api/erase` | `{page, points|rects, radius, erase_text?}` 页面级橡皮：文字真删 + 图像涂纸色，返回 `{removed_text_count, covered, strokes_removed, fill}` |
| POST | `/api/page` `/api/page/move` | 页面增删移 |
| POST | `/api/save` `/api/undo` | 落盘（新文档要带 `path` + `as_current`）/ 撤销 |

> 所有带 `doc=` 的请求都可指定文档；不传则用当前文档。
> `/api/save` 对没有 path 的新建文档会返回 `no_path`，调用方需要显式给 `path`。

前端是无构建的原生页面（`web/`），支持选择/文本/画笔/橡皮/图片/拖动六种工具，
可直接给非技术用户用。

## Python API

```python
import sys; sys.path.insert(0, r"<安装目录>")
from pdfx import PDFDocument

with PDFDocument("a.pdf") as d:
    print(d.page_type(0))                       # text / scanned / mixed
    for line in d.list_text(0)["items"]:        # 扫描页自动 OCR
        print(line["id"], line["bbox"], line["text"])
    d.update_text(0, "p0:o57,429", "新内容")     # 两类 PDF 同一套调用
    print(d.search("新内容")["total"])
```

## 错误码

| code | 含义 | 处理 |
|---|---|---|
| `not_found` | 文件不存在 | 检查路径 |
| `page_out_of_range` | 页码越界 | 页码 0 基，先看 `page_count` |
| `text_not_found` / `image_not_found` | id 失效或区域没匹配到 | 重新 `list` 拿最新 id |
| `ocr_unavailable` | 没有可用 OCR 后端 | 只能在文本层工作；或安装 rapidocr |
| `password_required` | PDF 加密 | 传 `--password`（CLI 暂未暴露，用 Python/HTTP） |
| `bad_regex` | 正则写错 | 修表达式 |
| `would_empty_document` | 试图删掉全部页面 | 至少留一页 |
| `image_insert_failed` / `image_extract_failed` | 图片插入失败；或图片是矢量蒙版提取不到原始数据 | 换 `keep_proportion` 或改用 `add_image` 直接盖新图 |
| `file_locked` | 原文件被其他程序（阅读器、同步盘）占用，无法原子替换 | 关掉占用程序重试，或 `save` 到新路径 |
| `document_closed` | 会话里的文档已被关闭（服务重启过、或同文档被重开） | 重新 `open` |

## 图片的 id 为什么按位置
id 形如 `p0:i@56,500`（左上角坐标取整），**不带 xref**。原因：`insert_image` 会复用
相同图像字节的 xref，一张新图和页面原有图片可能共用一个 xref；PyMuPDF 编辑后还会重排
图片资源。按位置匹配才稳定。

因此：`list_images` → 拿 id → 立刻操作，中间不要插入别的图片操作。
`delete_image` 默认 `mode="cover"`（用页面底色覆盖，视觉删除，可撤销）；
只有 `mode="purge"` 才真正从内容流里移除。

## 坑点清单

- **`insert_textbox` 放不下会静默失败**。本工具内部会自动扩框重试；自己写代码时务必检查返回值。
- **编辑后立刻 `refresh` 再操作**：id 与 bbox 都会变，尤其是 OCR 行。
- **保存会重写文件**。默认先写临时文件再原子替换；要保留原件用 `-o`。
- **增量保存**（`--incremental`）快但文件只增不减，多次编辑后建议 `--clean` 重写一次。
- **扫描页改字后原图仍是旧内容**：如果有人用图片方式放大看，能看到被覆盖前的痕迹。
  对法律意义极强的文件，应重新生成而非覆盖。
- **`erase` 是破坏性的**：结构化页命中的文字会被 redaction 真删（不可恢复，只能靠 `undo`）。
  只想修自己画的笔迹就用 `ink erase`，别用 `erase`。
- **浏览器页面要设 `touch-action: none`**：否则在触摸屏/手写笔上，拖动会被判成滚动，
  只收到 `pointercancel` —— 表现就是「画笔只画两个点、橡皮完全没反应」。
- **页码是 0 基，不是 1 基**。`--page 0` = 第一页；`--pages "1-3"` = 第 2、3、4 页。
  界面上显示的"第 N 页"是给人看的（1 基），API 与 CLI 一律 0 基，别混。
- 负索引可用：`--page -1` 是最后一页。
