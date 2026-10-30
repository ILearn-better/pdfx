"""生成三类测试样本：结构化 PDF / 扫描件 PDF / 混合 PDF。

    python tools/make_samples.py [输出目录]
"""

from __future__ import annotations

import sys
from pathlib import Path

import pymupdf as fitz
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "samples"

CN = "china-s"
EN = "helv"


def tb(page, rect, text, **kw):
    """insert_textbox 放不下会返回负值且不报错，这里显式检查。"""
    rc = page.insert_textbox(rect, text, **kw)
    if rc < 0:
        raise RuntimeError(f"文本框放不下({rc}): {text[:24]}... rect={rect}")
    return rc


def make_logo(path: Path) -> None:
    img = Image.new("RGB", (360, 160), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([8, 8, 352, 152], radius=18, fill=(28, 92, 168))
    d.ellipse([40, 45, 110, 115], fill=(255, 198, 64))
    d.rectangle([130, 55, 320, 75], fill=(255, 255, 255))
    d.rectangle([130, 90, 260, 108], fill=(210, 228, 250))
    img.save(path)


def build_text_pdf(path: Path) -> None:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    tb(page, fitz.Rect(56, 56, 540, 96), "季度经营分析报告", fontname=CN, fontsize=24, color=(0.1, 0.1, 0.12))
    tb(page, 
        fitz.Rect(56, 100, 540, 124),
        "Quarterly Business Review — 2026 Q3",
        fontname=EN,
        fontsize=12,
        color=(0.42, 0.45, 0.5),
    )
    page.draw_line(fitz.Point(56, 132), fitz.Point(540, 132), color=(0.8, 0.82, 0.85), width=1)

    body = (
        "本季度公司实现营业收入 1,284.6 万元，同比增长 18.3%，环比增长 6.2%。"
        "毛利率维持在 42.7% 的健康水平，主要得益于供应链集中采购与产品结构优化。\n\n"
        "客户结构方面，前五大客户贡献收入的 31.5%，较上季度下降 2.1 个百分点，客户集中度风险持续缓解。"
        "新增签约客户 47 家，其中制造业客户占比 53%。\n\n"
        "研发投入 216.4 万元，占营业收入的 16.8%。本季度完成核心引擎 v2.0 发布，"
        "平均响应时延下降 37%，为下半年规模化交付奠定基础。"
    )
    tb(page, fitz.Rect(56, 148, 540, 348), body, fontname=CN, fontsize=11.5,
                        color=(0.13, 0.14, 0.16), lineheight=1.55)

    tb(page, fitz.Rect(56, 350, 540, 372), "关键指标 Key Metrics", fontname=CN, fontsize=13,
                        color=(0.1, 0.1, 0.12))

    rows = [
        ("营业收入 Revenue", "1,284.6 万元", "+18.3%"),
        ("毛利率 Gross Margin", "42.7%", "+1.4pt"),
        ("研发投入 R&D", "216.4 万元", "+22.1%"),
        ("客户留存率 Retention", "94.2%", "+0.8pt"),
    ]
    y = 382
    for i, (k, v, d) in enumerate(rows):
        rect = fitz.Rect(56, y, 540, y + 24)
        if i % 2 == 0:
            page.draw_rect(rect, color=None, fill=(0.96, 0.97, 0.98))
        tb(page, fitz.Rect(66, y + 4, 300, y + 22), k, fontname=CN, fontsize=10.5)
        tb(page, fitz.Rect(310, y + 4, 420, y + 22), v, fontname=CN, fontsize=10.5)
        tb(page, fitz.Rect(430, y + 4, 530, y + 22), d, fontname=CN, fontsize=10.5,
                            color=(0.1, 0.55, 0.3))
        y += 26

    logo = OUT / "logo.png"
    if logo.exists():
        page.insert_image(fitz.Rect(56, 500, 236, 580), filename=str(logo))

    tb(page, fitz.Rect(56, 600, 540, 700),
                        "备注：本报告数据未经审计，最终以年度审计报告为准。\n"
                        "联系人：周立坤  邮箱：zhou.likun@example.com  电话：0755-8888 6666",
                        fontname=CN, fontsize=9.5, color=(0.45, 0.47, 0.5), lineheight=1.5)

    # 第二页：纯英文，用于跨页检索
    p2 = doc.new_page(width=595, height=842)
    tb(p2, fitz.Rect(56, 56, 540, 90), "Appendix: Raw Data", fontname=EN, fontsize=20)
    tb(p2, 
        fitz.Rect(56, 110, 540, 260),
        "Revenue by region (CNY, thousands):\n"
        "  South China      4,820\n"
        "  East China       3,940\n"
        "  North China      2,610\n"
        "  Overseas         1,476\n\n"
        "Note: figures are preliminary and subject to rounding.",
        fontname=EN, fontsize=11, lineheight=1.5,
    )
    doc.save(str(path))
    doc.close()


def build_scan_pdf(path: Path, dpi: int = 200) -> None:
    """把结构化页渲染成图片再装回 PDF —— 模拟扫描件（无文本层）。"""
    tmp = fitz.open()
    src = tmp.new_page(width=595, height=842)
    tb(src, fitz.Rect(56, 60, 540, 100), "采购合同", fontname=CN, fontsize=22)
    tb(src, 
        fitz.Rect(56, 120, 540, 500),
        "合同编号：CG-2026-0871\n"
        "签订日期：2026 年 9 月 12 日\n\n"
        "甲方（采购方）：深圳市示例科技有限公司\n"
        "乙方（供应商）：东莞市恒信精密制造有限公司\n\n"
        "第一条  合同标的\n"
        "乙方向甲方供应精密结构件 12,000 套，单价人民币 86.50 元，\n"
        "合同总金额人民币 1,038,000.00 元（大写：壹佰零叁万捌仟元整）。\n\n"
        "第二条  交付方式\n"
        "乙方应于 2026 年 10 月 31 日前分批交付至甲方指定仓库。\n\n"
        "第三条  质量保证\n"
        "质保期为验收合格之日起 12 个月。",
        fontname=CN, fontsize=12, lineheight=1.75,
    )
    tb(src, fitz.Rect(56, 470, 540, 520), "Total Amount: CNY 1,038,000.00", fontname=EN,
                       fontsize=13)
    pix = src.get_pixmap(dpi=dpi, colorspace=fitz.csRGB)
    png = pix.tobytes("jpg", jpg_quality=88)
    tmp.close()

    out = fitz.open()
    page = out.new_page(width=595, height=842)
    page.insert_image(page.rect, stream=png)
    out.save(str(path))
    out.close()


def build_mixed_pdf(path: Path) -> None:
    """第一页结构化 + 第二页扫描件。"""
    doc = fitz.open()
    p1 = doc.new_page(width=595, height=842)
    tb(p1, fitz.Rect(56, 60, 540, 100), "混合文档示例", fontname=CN, fontsize=20)
    tb(p1, fitz.Rect(56, 120, 540, 220),
                      "本页是结构化文本层，可以直接精确编辑与检索。\n"
                      "第二页是扫描图片，需要 OCR 才能检索到文字。",
                      fontname=CN, fontsize=12, lineheight=1.7)

    tmp = fitz.open()
    s = tmp.new_page(width=595, height=842)
    tb(s, fitz.Rect(56, 60, 540, 150), "扫描页：发票信息\n发票号码 0442-8891  金额 9,860.00 元",
                     fontname=CN, fontsize=16, lineheight=1.8)
    pix = s.get_pixmap(dpi=200, colorspace=fitz.csRGB)
    png = pix.tobytes("jpg", jpg_quality=88)
    tmp.close()

    p2 = doc.new_page(width=595, height=842)
    p2.insert_image(p2.rect, stream=png)
    doc.save(str(path))
    doc.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    make_logo(OUT / "logo.png")
    build_text_pdf(OUT / "sample_text.pdf")
    build_scan_pdf(OUT / "sample_scan.pdf")
    build_mixed_pdf(OUT / "sample_mixed.pdf")
    for f in sorted(OUT.glob("*.pdf")):
        print(f"{f.name:20s} {f.stat().st_size/1024:8.1f} KB")


if __name__ == "__main__":
    main()
