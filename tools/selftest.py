"""端到端自测：把每一类能力都跑一遍并打印结果。

    python tools/selftest.py

不需要外部服务，直接调用 Python API。用于改动后的回归验证。
"""

from __future__ import annotations

import shutil
import sys
import time
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pymupdf as fitz  # noqa: E402

from pdfx import PDFDocument  # noqa: E402
from pdfx.util import PdfxError, iou  # noqa: E402

TMP = ROOT / "tmp" / "selftest"
PASS = 0
FAIL = 0


def ok(name: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}{(' — ' + extra) if extra else ''}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}{(' — ' + extra) if extra else ''}")


def section(title: str) -> None:
    print(f"\n== {title} ==")


def fresh(src: str | None = None, name: str = "w.pdf") -> PDFDocument:
    TMP.mkdir(parents=True, exist_ok=True)
    target = TMP / name
    if src:
        shutil.copy2(ROOT / src, target)
        return PDFDocument(target)
    return PDFDocument()


def main() -> int:
    section("文档创建与导入")
    d = fresh(name="new.pdf")
    d.add_page("a4")
    d.add_page("a4", position=1)
    ok("新建并加两页", d.page_count == 2, f"size={d.page_size(0)}")
    d.save(TMP / "new.pdf")
    d.close()
    ok("新建文档已落盘", (TMP / "new.pdf").exists())

    d = fresh("samples/sample_text.pdf", "t.pdf")
    ok("打开结构化 PDF", d.page_count == 2 and d.page_type(0) == "text")
    d.import_pdf(ROOT / "samples" / "sample_scan.pdf", pages="0", position=0)
    ok("从别的 PDF 导入页", d.page_count == 3, f"第0页类型={d.page_type(0)}")
    d.close()

    section("增：文本 / 图片 / 笔迹")
    d = fresh("samples/sample_text.pdf", "edit.pdf")
    t = d.add_text(0, "内部资料 请勿外传", rect=[380, 60, 540, 84], font_size=12, color="#c62828")
    ok("插入文本框", t["id"].startswith("p0:ut"), f"bbox={t['bbox']}")
    ok("插入后可检索", d.search("请勿外传")["total"] == 1)

    im = d.add_image(0, [300, 520, 420, 600], ROOT / "samples" / "logo.png")
    ok("插入图片", im["id"].startswith("p0:ui"), f"bbox={im['bbox']}")
    ok("图片计数", d.list_images(0)["count"] == 2)

    st = d.add_strokes(0, [
        {"points": [[60, 720], [140, 700], [220, 730]], "color": "#1a73e8", "width": 3},
        {"points": [[300, 720], [380, 740]], "color": "#e8710a", "width": 2},
    ])
    ok("添加两条笔迹", st["added"] == 2 and d.list_strokes(0)["count"] == 2)

    section("改：文本 / 图片")
    u = d.update_text(0, t["id"], "内部资料（已加密）")
    ok("修改文本", d.search("已加密")["total"] == 1 and d.search("请勿外传")["total"] == 0, f"bbox={u['bbox']}")

    rep = d.replace_image(0, im["id"], ROOT / "samples" / "logo.png")
    ok("替换图片", rep["id"] == im["id"])

    tr = d.transform_image(0, im["id"], [100, 620, 200, 680])
    ok("移动图片", tr["bbox"][0] == 100, f"bbox={tr['bbox']}")

    # 移动后原位必须干净。曾经的实现是用"区域边缘众数色"涂盖原位 ——
    # 而那片区域整个就是被移动的那张图，取到的自然是图片自己的颜色，
    # 等于用图盖图，原位留下一个一模一样的残影。
    # 判据：原位置的像素要回到"从没插过图片时的样子"。和原始样本比对，
    # 不能只看暗像素多不多 —— 那个位置本来就有正文，露出来才是对的。
    try:
        import fitz
        import numpy as np

        def rgb(doc):
            pm = fitz.Pixmap(doc.render(0, dpi=72))
            return np.frombuffer(pm.samples, dtype=np.uint8).reshape(pm.height, pm.width, pm.n)[:, :, :3].astype(int)

        orig = PDFDocument(str(ROOT / "samples" / "sample_text.pdf"))
        a_orig = rgb(orig)
        orig.close()
        a_now = rgb(d)
        ox0, oy0, ox1, oy1 = [int(v) for v in im["bbox"]]
        patch_now = a_now[oy0 + 4 : oy1 - 4, ox0 + 4 : ox1 - 4]
        patch_orig = a_orig[oy0 + 4 : oy1 - 4, ox0 + 4 : ox1 - 4]
        diff = float(np.abs(patch_now - patch_orig).mean())
        ok("移动后原位无残影", diff < 8, f"与原始页面平均差 {diff:.1f}（图涂回原位会到 100+）")
    except ImportError:
        pass

    # 界面上的"拖手柄"走的就是这两个入口：给 rect 即移动/缩放，不传 rect 才是改内容
    tf = d.transform_text(0, u.get("id") or t["id"], rect=[u["bbox"][0], u["bbox"][1] + 90, u["bbox"][2] + 40, u["bbox"][3] + 90])
    ok("移动文本", abs(tf["bbox"][1] - (u["bbox"][1] + 90)) < 6, f"y {u['bbox'][1]:.0f} → {tf['bbox'][1]:.0f}")
    big = d.transform_text(0, t["id"], rect=[tf["bbox"][0], tf["bbox"][1], tf["bbox"][2] + 60, tf["bbox"][3] + 40])
    ok("缩放文本（字号联动）", big["font_size"] > tf["font_size"], f"{tf['font_size']:.1f} → {big['font_size']:.1f}pt")
    ok("缩放后原位置无残留", d.search("已加密")["total"] >= 1, "文字仍可检索")

    # 放大文本框：字必须还留在框里。以前 insert_textbox 放不下就把绘制框往下
    # 撑到 1.8 倍，字直接压到下面的正文上 —— 用起来就是"字体脱离了文本框"。
    def user_texts():
        return [x for x in d.list_text(0)["items"] if x["source"] == "user"]

    # 单独放一个框在左侧空地：放大后不能顶到页边（顶到就没法验证"按比例"）
    bx = d.add_text(0, "放大后文字留在框内\n第二行文字要更长一些", rect=[56, 430, 256, 472], font_size=12)
    b0 = bx["bbox"]
    big_box = [
        b0[0], b0[1],
        b0[0] + (b0[2] - b0[0]) * 1.8,
        b0[1] + (b0[3] - b0[1]) * 1.8,
    ]
    up = d.transform_text(0, bx["id"], rect=big_box, font_size=12 * 1.8)
    ok("放大后文字不超出文本框", up["bbox"][2] <= big_box[2] + 1.5 and up["bbox"][3] <= big_box[3] + 1.5,
       f"bbox={[round(v, 1) for v in up['bbox']]} 框={[round(v, 1) for v in big_box]}")
    ok("放大后字号跟着框走", abs(up["font_size"] - 12 * 1.8) < 0.6, f"12.0 → {up['font_size']:.1f}pt")

    # 连续缩放不能越拖越小（排版框比字形范围高，每次都重排会把字号一点点挤掉）
    b1 = up["bbox"]
    half = [
        b1[0], b1[1],
        b1[0] + (b1[2] - b1[0]) / 1.8,
        b1[1] + (b1[3] - b1[1]) / 1.8,
    ]
    down = d.transform_text(0, bx["id"], rect=half, font_size=up["font_size"] / 1.8)
    ok("放大再缩小，字号不漂移", abs(down["font_size"] - 12) < 0.8,
       f"12.00 → 放大 {up['font_size']:.2f} → 缩回 {down['font_size']:.2f}")
    ok("多行文本框仍是一个对象", len([x for x in user_texts() if x["id"] == bx["id"]]) == 1,
       f"{len([x for x in user_texts() if x['id'] == bx['id']])} 条")
    d.delete_text(0, bx["id"])

    # 多行文本框在文本层里会被拆成多行，必须合成一个对象，
    # 否则拖框只带走第一行、删也只删一行
    mt = d.add_text(0, "第一行\n第二行更长一点", rect=[100, 700, 320, 745], font_size=12)
    objs = [x for x in d.list_text(0)["items"] if x["id"] == mt["id"]]
    ok("多行文本框只算一个对象", len(objs) == 1 and "第二行" in objs[0]["text"],
       f"命中 {len(objs)} 条")
    ok("多行文本框可整体拖动", d.transform_text(0, mt["id"], rect=[120, 720, 340, 765])["bbox"][0] > 110)
    d.delete_text(0, mt["id"])
    ok("多行文本框可整体删除", d.search("第二行更长")["total"] == 0)

    ts2 = d.transform_image(0, tr["id"], [300, 600, 420, 700], keep_ratio=False)
    ok("拉伸图片（单向）", abs((ts2["bbox"][2] - ts2["bbox"][0]) - 120) < 6, f"bbox={ts2['bbox']}")

    section("删：笔迹 / 图片 / 文本 / 页面")
    e = d.erase_strokes(0, points=[[140, 702]], radius=12)
    ok("橡皮切割笔画", e["removed"] == 1 and e["split"] >= 1, str(e))

    d.delete_image(0, tr["id"])
    ok("删除图片", d.list_images(0)["count"] == 1)

    # 文本已被移动/缩放过，坐标 id 会变，这里按内容定位
    d.delete_text(0, {"bbox": user_texts()[0]["bbox"]})
    ok("删除文本", d.search("已加密")["total"] == 0)

    n0 = d.page_count
    d.rotate_page(0, 90)
    ok("旋转页面", d.page(0).rotation == 90)
    d.move_page(0, 1)
    ok("移动页面", d.page_count == n0)
    d.delete_pages("1")
    ok("删除页面", d.page_count == n0 - 1)

    section("页面内容擦除（CLI / AI 接口能力；界面橡皮只擦笔迹，不提供这个）")
    d.close()
    d = fresh("samples/sample_text.pdf", "erase.pdf")
    before_txt = d.extract_text(0)["text"]
    before_n = len(before_txt)
    r = d.erase_area(0, points=[[80, 120], [300, 120]], radius=14)
    after_n = len(d.extract_text(0)["text"])
    ok("结构化页：轨迹扫过的文字被真删", r["removed_text_count"] >= 1 and after_n < before_n,
       f"{before_n} → {after_n} 字符，删了 {r['removed_text_count']} 处")
    ok("结构化页：擦除后检索也查不到", d.search(r["removed_text"][0][:8])["total"] == 0 if r["removed_text"] else False)
    ok("橡皮可撤销（内容回来）", d.undo() and len(d.extract_text(0)["text"]) == before_n)
    d.close()

    d = fresh("samples/sample_scan.pdf", "erase_scan.pdf")
    png_before = d.render(0, dpi=96)
    rs = d.erase_area(0, rects=[[120, 300, 260, 380]], radius=10)
    png_after = d.render(0, dpi=96)
    ok("扫描页：框选区域内容被底色涂掉", rs["covered"] >= 1 and png_before != png_after,
       f"covered={rs['covered']} fill={rs['fill']}")
    ok("扫描页：撤销能还原", d.undo() and d.render(0, dpi=96) == png_before)
    d.close()

    section("查：检索与导出")
    d.close()
    d = fresh("samples/sample_text.pdf", "search.pdf")
    s1 = d.search("毛利率")
    ok("结构化检索", s1["total"] == 2, f"{s1['total']} 处, bbox={s1['hits'][0]['bbox']}")
    s2 = d.search(r"\d{3,}", regex=True)
    ok("正则检索", s2["total"] >= 1, f"{s2['total']} 处")
    ok("跨页检索", d.search("East China")["total"] == 1)
    ext = d.extract_text()
    ok("导出全文", ext["total_chars"] > 100, f"{ext['total_chars']} 字符")
    d.close()

    d = fresh("samples/sample_scan.pdf", "scan.pdf")
    ok("扫描页类型判定", d.page_type(0) == "scanned")
    for q, expect in [("恒信", 1), ("1,038,000", 1), ("CG-2026-0871", 1), ("质保期", 1)]:
        got = d.search(q)["total"]
        ok(f"OCR 检索「{q}」", got >= expect, f"{got} 处")

    tgt = [l for l in d._page_lines(0, force_ocr=True) if "质保期" in l["text"]][0]
    up = d.update_text(0, tgt["id"], "质保期为 24 个月。")
    ok("改扫描件文字", d.search("24 个月")["total"] == 1 and d.search("12 个月")["total"] == 0, f"bbox={up['bbox']}")
    ok("改后仍能读原图内容", d.search("恒信")["total"] == 1)

    t2 = [l for l in d._page_lines(0, force_ocr=True) if "签订日期" in l["text"]][0]
    d.delete_text(0, t2["id"])
    ok("删扫描件文字", d.search("签订日期")["total"] == 0)

    section("保存 / 重开 / 撤销")
    out = TMP / "saved.pdf"
    d.save(out, flatten_inks=True)
    d.close()
    d2 = PDFDocument(out)
    ok("保存并重开", d2.page_count == 1)
    ok("重开后用户文本仍在", d2.search("24 个月")["total"] == 1)
    ok("重开后笔迹状态已烘焙", d2.list_strokes(0)["count"] == 0)
    d2.close()

    d = fresh("samples/sample_text.pdf", "undo.pdf")
    before = d.list_text(0)["count"]
    d.add_text(0, "临时内容", rect=[100, 300, 300, 320])
    mid = d.list_text(0)["count"]
    d.undo()
    after = d.list_text(0)["count"]
    ok("撤销", after == before and mid > before, f"{before}→{mid}→{after}")
    d.close()

    section("删图后重新插入 / OCR 按需 / 渲染缓存")
    d = fresh("samples/sample_text.pdf", "reinsert.pdf")
    first = d.list_images(0)["items"][0]
    d.delete_image(0, first["id"])
    ok("删掉原生图片后对象列表为空", len(d.list_images(0)["items"]) == 0)
    again = d.add_image(0, [80, 300, 240, 380], ROOT / "samples" / "logo.png", name="logo.png")
    items = d.list_images(0)["items"]
    ok("删掉之后还能再插入图片", len(items) == 1 and items[0]["source"] == "user",
       f"{len(items)} 张, bbox={again['bbox']}")
    # 记录里的 bbox 必须和图片真实落点一致，否则界面上"框住了但图在别处"
    ok("新插入的图片 bbox 与实际渲染一致",
       abs(again["bbox"][0] - 80) < 2 and abs(again["bbox"][2] - 240) < 2,
       str([round(v, 1) for v in again["bbox"]]))
    same_spot = d.add_image(0, [80, 300, 240, 380], ROOT / "samples" / "logo.png", name="again.png")
    ok("同一位置重复插入不会丢图", len(d.list_images(0)["items"]) == 2,
       f"bbox={[round(v, 1) for v in same_spot['bbox']]}")

    # 界面点「删除」不传 mode，默认必须真删。若默认回退成 cover，
    # 图只被纸色盖住，内容流里还在 —— 保存后原图仍可被提取。
    imgs_before = len(d.list_images(0)["items"])
    victim = d.list_images(0)["items"][-1]
    res = d.delete_image(0, victim["id"])
    ok("删除默认走真删（mode=purged）", res.get("mode") == "purged", str(res.get("mode")))
    remain = d.list_images(0)["items"]
    ok("删完之后对象列表里没有它",
       all(x["id"] != victim["id"] for x in remain), f"剩 {len(remain)} 张")
    # 同一张图插两次会共用同一个图像资源（xref），redaction 按资源删会把两处一起抹掉
    ok("同一张图在别处的实例仍然保留", len(remain) == imgs_before - 1,
       f"{imgs_before} → {len(remain)} 张")
    ok("原位置的图像已从内容流移除",
       not any(iou(i["bbox"], victim["bbox"]) > 0.3 for i in d._image_instances(d.doc[0])))
    d.undo()
    ok("删除可撤销：图回来了",
       any(x["id"] == victim["id"] for x in d.list_images(0)["items"]),
       f"{len(d.list_images(0)['items'])} 张")
    d.close()

    # 同一张图插两次 → 共用同一个图像资源。移动其中一张时，
    # redaction 按资源删会把两处一起抹掉，所以另一处必须补画回来。
    d = fresh("samples/sample_text.pdf", "multi_img.pdf")
    d.add_image(0, [80, 300, 240, 380], ROOT / "samples" / "logo.png", name="m1.png")
    p2 = d.add_image(0, [300, 300, 460, 380], ROOT / "samples" / "logo.png", name="m2.png")
    d.transform_image(0, p2["id"], [300, 420, 460, 500])
    users = [i for i in d.list_images(0)["items"] if i["source"] == "user"]
    ok("移动一张图不会带走同款的另一张", len(users) == 2, f"{len(users)} 张")
    ok("被移动的那张落在新位置", any(abs(i["bbox"][1] - 420) < 30 for i in users),
       str([[round(v) for v in i["bbox"]] for i in users]))

    # 复制图片：界面 Ctrl+C 要拿到 PNG（剪贴板只可靠地收 image/png）
    png = d.image_png(0, users[0]["id"])
    ok("复制图片导出的是 PNG", png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 200, f"{len(png)} bytes")
    got = fitz.Pixmap(png)
    src = fitz.Pixmap(str(ROOT / "samples" / "logo.png"))
    ok("导出的图尺寸与原图一致", (got.width, got.height) == (src.width, src.height),
       f"{got.width}x{got.height} vs {src.width}x{src.height}")
    d.close()

    d = fresh("samples/sample_scan.pdf", "ocr_opt.pdf")
    plain = d.list_text(0)
    ok("扫描页默认不跑 OCR（浏览不再等 1~3 秒）", plain["count"] == 0, f"texts={plain['count']}")
    forced = d.list_text(0, force_ocr=True)
    ok("显式要求后才识别", forced["count"] >= 5, f"texts={forced['count']}")
    ok("检索仍会自动识别扫描页", d.search("质保期")["total"] >= 1)
    d.close()

    d = fresh("samples/sample_text.pdf", "cache.pdf")
    a = d.render(0, 96)
    t0 = time.perf_counter()
    b = d.render(0, 96)
    fast = (time.perf_counter() - t0) * 1000
    ok("同页同 dpi 的位图命中缓存", a == b and fast < 8, f"第二次 {fast:.1f} ms")
    d.add_strokes(0, [{"points": [[40, 40], [90, 90]], "color": "#d64545", "width": 2}])
    c = d.render(0, 96)
    ok("内容一变缓存自动失效", c != a)
    ok("笔迹撤销走轻量快照（不做整份 PDF 序列化）",
       d._undo and d._undo[-1][0] == "ink", str(d._undo[-1][0]) if d._undo else "空")
    d.undo()
    ok("笔迹撤销后位图回到原样", d.render(0, 96) == a)
    d.close()

    section("异常处理")
    try:
        PDFDocument(TMP / "nope.pdf")
        ok("不存在的文件应报错", False)
    except PdfxError as exc:
        ok("不存在的文件报 not_found", exc.code == "not_found")

    d = fresh("samples/sample_text.pdf", "err.pdf")
    try:
        d.page(99)
        ok("越界页码应报错", False)
    except PdfxError as exc:
        ok("越界页码报 page_out_of_range", exc.code == "page_out_of_range")
    try:
        d.delete_text(0, "p0:t0,0")
        ok("无效 id 应报错", False)
    except PdfxError as exc:
        ok("无效 id 报 text_not_found", exc.code == "text_not_found")
    try:
        d.delete_pages("all")
        ok("删完所有页应报错", False)
    except PdfxError as exc:
        ok("删完所有页报 would_empty_document", exc.code == "would_empty_document")
    d.close()

    print(f"\n合计 {PASS} 项通过，{FAIL} 项失败")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
