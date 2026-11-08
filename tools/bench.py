# -*- coding: utf-8 -*-
"""贴近实际使用的性能基准：打开文档 → 首屏渲染 → 翻页 → 画 10 笔 → 拖动图片 5 次。

    python tmp/bench2.py [样本路径]

只统计"用户能感知的动作"，不做微基准。
"""

import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pdfx import PDFDocument  # noqa: E402

TMP = ROOT / "tmp" / "bench"


def build_pages(n: int = 24) -> Path:
    """n 页扫描件：每页一张 150dpi 位图，模拟真实扫描文档"""
    import pymupdf as fitz

    dst = TMP / f"perf_scan_{n}.pdf"
    if dst.exists():
        return dst
    TMP.mkdir(parents=True, exist_ok=True)
    src = fitz.open(ROOT / "samples" / "sample_scan.pdf")
    png = src[0].get_pixmap(dpi=150).tobytes("png")
    src.close()
    d = fitz.open()
    for _ in range(n):
        p = d.new_page(width=595, height=842)
        p.insert_image(p.rect, stream=png)
    d.save(dst, garbage=1, deflate=True)
    d.close()
    return dst


def ms(t0: float) -> float:
    return (time.perf_counter() - t0) * 1000


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else build_pages()
    work = TMP / ("run_" + os.getpid().__str__() + ".pdf")
    shutil.copy2(src, work)
    size_mb = work.stat().st_size / 1024 / 1024
    print(f"样本 {work.name}  {size_mb:.1f} MB")

    t = time.perf_counter()
    d = PDFDocument(work)
    open_ms = ms(t)
    n = min(8, d.page_count)

    t = time.perf_counter()
    for i in range(n):
        d.thumbnail(i, 150)
    thumb_ms = ms(t)

    t = time.perf_counter()
    for i in range(n):
        d.render(i, 96)
    render_ms = ms(t)

    t = time.perf_counter()
    for i in range(n):
        d.page_type(i)
        d.list_text(i)
        d.list_images(i)
        d.list_strokes(i)
    objects_ms = ms(t)

    t = time.perf_counter()
    for i in range(10):
        d.add_strokes(0, [{"points": [[40 + i, 60], [80 + i, 110], [120 + i, 70]], "color": "#d64545", "width": 2}])
    ink_ms = ms(t)

    # 拖动图片：扫描页只有整页底图（禁止移动），先插一张小图再拖
    logo = ROOT / "samples" / "logo.png"
    rec = d.add_image(0, [60, 300, 260, 420], logo, name="logo.png")
    t = time.perf_counter()
    for i in range(5):
        cur = d.list_images(0)["items"]
        target = next((x for x in cur if x["source"] == "user"), None)
        if not target:
            break
        d.transform_image(0, target["id"], [60 + i * 8, 300, 260 + i * 8, 420])
    drag_ms = ms(t)

    # 重复访问同一页（翻回来 / 缩放来回）：应几乎为零
    t = time.perf_counter()
    for _ in range(20):
        d.render(0, 96)
        d.thumbnail(0, 150)
        d.list_images(0)
    again_ms = ms(t)

    print(f"  打开            {open_ms:8.1f} ms")
    print(f"  首屏 {n} 张缩略图  {thumb_ms:8.1f} ms   ({thumb_ms / n:.1f} ms/页)")
    print(f"  首屏 {n} 页位图    {render_ms:8.1f} ms   ({render_ms / n:.1f} ms/页)")
    print(f"  {n} 页对象查询   {objects_ms:8.1f} ms   ({objects_ms / n:.1f} ms/页)")
    print(f"  画 10 笔        {ink_ms:8.1f} ms   ({ink_ms / 10:.1f} ms/笔)")
    print(f"  拖动图片 5 次   {drag_ms:8.1f} ms   ({drag_ms / 5:.1f} ms/次)")
    print(f"  重复访问 20 轮  {again_ms:8.1f} ms   ({(again_ms / 20 / 3):.1f} ms/次)")
    total = open_ms + thumb_ms + render_ms + objects_ms + ink_ms + drag_ms
    print(f"  -- 合计         {total:8.1f} ms")
    d.close()
    try:
        work.unlink()
    except Exception:
        pass


if __name__ == "__main__":
    main()
