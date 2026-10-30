"""端到端自测：把每一类能力都跑一遍并打印结果。

    python tools/selftest.py

不需要外部服务，直接调用 Python API。用于改动后的回归验证。
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pdfx import PDFDocument  # noqa: E402
from pdfx.util import PdfxError  # noqa: E402

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

    # 界面上的"拖手柄"走的就是这两个入口：给 rect 即移动/缩放，不传 rect 才是改内容
    tf = d.transform_text(0, u.get("id") or t["id"], rect=[u["bbox"][0], u["bbox"][1] + 90, u["bbox"][2] + 40, u["bbox"][3] + 90])
    ok("移动文本", abs(tf["bbox"][1] - (u["bbox"][1] + 90)) < 6, f"y {u['bbox'][1]:.0f} → {tf['bbox'][1]:.0f}")
    big = d.transform_text(0, t["id"], rect=[tf["bbox"][0], tf["bbox"][1], tf["bbox"][2] + 60, tf["bbox"][3] + 40])
    ok("缩放文本（字号联动）", big["font_size"] > tf["font_size"], f"{tf['font_size']:.1f} → {big['font_size']:.1f}pt")
    ok("缩放后原位置无残留", d.search("已加密")["total"] >= 1, "文字仍可检索")

    ts2 = d.transform_image(0, tr["id"], [300, 600, 420, 700], keep_ratio=False)
    ok("拉伸图片（单向）", abs((ts2["bbox"][2] - ts2["bbox"][0]) - 120) < 6, f"bbox={ts2['bbox']}")

    section("删：笔迹 / 图片 / 文本 / 页面")
    e = d.erase_strokes(0, points=[[140, 702]], radius=12)
    ok("橡皮切割笔画", e["removed"] == 1 and e["split"] >= 1, str(e))

    d.delete_image(0, tr["id"])
    ok("删除图片", d.list_images(0)["count"] == 1)

    # 文本已被移动/缩放过，坐标 id 会变，这里按位置定位
    d.delete_text(0, {"bbox": big["bbox"]})
    ok("删除文本", d.search("已加密")["total"] == 0)

    n0 = d.page_count
    d.rotate_page(0, 90)
    ok("旋转页面", d.page(0).rotation == 90)
    d.move_page(0, 1)
    ok("移动页面", d.page_count == n0)
    d.delete_pages("1")
    ok("删除页面", d.page_count == n0 - 1)

    section("页面橡皮：擦掉页面原有内容（不只是自己画的笔迹）")
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

    tgt = [l for l in d._page_lines(0) if "质保期" in l["text"]][0]
    up = d.update_text(0, tgt["id"], "质保期为 24 个月。")
    ok("改扫描件文字", d.search("24 个月")["total"] == 1 and d.search("12 个月")["total"] == 0, f"bbox={up['bbox']}")
    ok("改后仍能读原图内容", d.search("恒信")["total"] == 1)

    t2 = [l for l in d._page_lines(0) if "签订日期" in l["text"]][0]
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
