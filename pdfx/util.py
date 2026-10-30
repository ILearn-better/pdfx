"""公共工具：错误类型、坐标换算、颜色处理、JSON 信封。"""

from __future__ import annotations

import colorsys
import os
import re
import unicodedata
from pathlib import Path
from typing import Any, Iterable, Sequence

__version__ = "1.0.0"

# 用户级数据目录（OCR 缓存、探测结果）
PDFX_HOME = Path(os.environ.get("PDFX_HOME") or (Path.home() / ".pdfx"))

CJK_RE = re.compile(
    "[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]"
)

# OCR 常把 "-" 认成各种中点/破折号，比较前统一折叠
_FOLD = str.maketrans(
    {
        "\u00b7": "-",  # ·
        "\u30fb": "-",  # ・
        "\u2022": "-",  # •
        "\u2027": "-",  # ‧
        "\uff0d": "-",  # －
        "\u2014": "-",  # —
        "\u2013": "-",  # –
        "\uff5e": "~",  # ～
        "\u301c": "~",  # 〜
    }
)


class PdfxError(Exception):
    """统一业务异常，携带机器可读的 code 供 AI 判断。"""

    def __init__(self, message: str, code: str = "error", **detail: Any) -> None:
        super().__init__(message)
        self.code = code
        self.detail = detail

    def to_dict(self) -> dict[str, Any]:
        d = {"code": self.code, "message": str(self)}
        if self.detail:
            d["detail"] = self.detail
        return d


def ok(data: Any = None, warnings: Iterable[str] | None = None) -> dict[str, Any]:
    return {"ok": True, "data": data, "warnings": list(warnings or [])}


def fail(err: Exception) -> dict[str, Any]:
    if isinstance(err, PdfxError):
        return {"ok": False, "error": err.to_dict()}
    return {"ok": False, "error": {"code": "internal", "message": f"{type(err).__name__}: {err}"}}


# --------------------------------------------------------------------------- 文本工具

def has_cjk(text: str) -> bool:
    return bool(CJK_RE.search(text or ""))


def normalize_text(text: str) -> str:
    """归一化用于检索比较：全半角、大小写、空白。
    中文直接比较；英文/数字做 casefold + NFKC。
    """
    if not text:
        return ""
    t = unicodedata.normalize("NFKC", text).casefold().translate(_FOLD)
    t = re.sub(r"\s+", "", t)
    return t


def clean_text(text: str) -> str:
    """清理提取到的原始文本：去连字符换行、合并多余空白。"""
    if not text:
        return ""
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r"-\n(?=[a-zA-Z])", "", t)  # 英文断词连字符
    t = re.sub(r"[ \t]+", " ", t)
    return t.strip()


# --------------------------------------------------------------------------- 几何工具

Rect = Sequence[float]


def norm_rect(r: Rect) -> list[float]:
    x0, y0, x1, y1 = (float(v) for v in r)
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def rect_area(r: Rect) -> float:
    x0, y0, x1, y1 = norm_rect(r)
    return max(0.0, x1 - x0) * max(0.0, y1 - y0)


def rect_intersect(a: Rect, b: Rect) -> list[float] | None:
    ax0, ay0, ax1, ay1 = norm_rect(a)
    bx0, by0, bx1, by1 = norm_rect(b)
    x0, y0 = max(ax0, bx0), max(ay0, by0)
    x1, y1 = min(ax1, bx1), min(ay1, by1)
    if x1 <= x0 or y1 <= y0:
        return None
    return [x0, y0, x1, y1]


def iou(a: Rect, b: Rect) -> float:
    inter = rect_intersect(a, b)
    if not inter:
        return 0.0
    i = rect_area(inter)
    union = rect_area(a) + rect_area(b) - i
    return i / union if union > 0 else 0.0


def contains(outer: Rect, inner: Rect, tol: float = 1.0) -> bool:
    ox0, oy0, ox1, oy1 = norm_rect(outer)
    ix0, iy0, ix1, iy1 = norm_rect(inner)
    return ix0 >= ox0 - tol and iy0 >= oy0 - tol and ix1 <= ox1 + tol and iy1 <= oy1 + tol


def point_seg_dist(p, a, b) -> float:
    """点到线段距离。"""
    px, py = p
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


# --------------------------------------------------------------------------- 颜色工具

def rgb_to_hex(rgb: Sequence[float]) -> str:
    r, g, b = (max(0.0, min(1.0, float(v))) for v in rgb[:3])
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    v = (value or "#000000").lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if len(v) != 6:
        raise PdfxError(f"非法颜色值: {value}", "bad_color")
    return tuple(int(v[i : i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]


def lighten(rgb: Sequence[float], amount: float = 0.85) -> tuple[float, float, float]:
    r, g, b = (float(v) for v in rgb[:3])
    return (r + (1 - r) * amount, g + (1 - g) * amount, b + (1 - b) * amount)


def ink_color_for(bg: Sequence[float]) -> tuple[float, float, float]:
    """给定背景色，返回一个高对比度的标注色（深色底用浅色标注）。"""
    r, g, b = (float(v) for v in bg[:3])
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    if lum < 0.45:
        return (0.95, 0.45, 0.35)
    return (0.85, 0.15, 0.15)


# --------------------------------------------------------------------------- 尺寸工具

PAGE_PRESETS: dict[str, tuple[float, float]] = {
    # 单位 pt；A 系列按 72dpi
    "a4": (595.276, 841.89),
    "a3": (841.89, 1190.55),
    "a5": (419.53, 595.276),
    "letter": (612.0, 792.0),
    "legal": (612.0, 1008.0),
    "b5": (498.9, 708.66),
    "tabloid": (792.0, 1224.0),
}


def resolve_size(size: Any, default: tuple[float, float] = PAGE_PRESETS["a4"]) -> tuple[float, float]:
    """把 "a4" / "A4" / [w,h] / {"width":..,"height":..} 解析成 (w, h)。"""
    from .util import PdfxError

    if size is None:
        return default
    if isinstance(size, str):
        key = size.strip().lower()
        if key in PAGE_PRESETS:
            return PAGE_PRESETS[key]
        m = re.fullmatch(r"([\d.]+)\s*[x*×]\s*([\d.]+)", key)
        if m:
            return (float(m.group(1)), float(m.group(2)))
        raise PdfxError(f"未知页面尺寸: {size}", "bad_size")
    if isinstance(size, dict):
        w = size.get("width") or size.get("w")
        h = size.get("height") or size.get("h")
        if w and h:
            return (float(w), float(h))
        raise PdfxError("页面尺寸对象需包含 width/height", "bad_size")
    if isinstance(size, (list, tuple)) and len(size) == 2:
        return (float(size[0]), float(size[1]))
    raise PdfxError(f"无法解析页面尺寸: {size!r}", "bad_size")


def parse_page_selector(sel: Any, page_count: int) -> list[int]:
    """页面选择器 → 0-based 页索引列表。

    支持: None(全部) | 3 | "3" | [1,3,5] | "1-3,7" | "-1"(末页) | "1..3"
    """
    if sel is None or sel == "" or sel == "all":
        return list(range(page_count))
    if isinstance(sel, int):
        idx = sel
        if idx < 0:
            idx += page_count
        if not 0 <= idx < page_count:
            raise PdfxError(f"页码越界: {sel}（共 {page_count} 页）", "page_out_of_range")
        return [idx]
    if isinstance(sel, (list, tuple)):
        out: list[int] = []
        for s in sel:
            out.extend(parse_page_selector(s, page_count))
        return sorted(set(out))

    text = str(sel).strip()
    out = []
    for part in re.split(r"[,;，；]", text):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(-?\d+)\s*(?:-|\.\.|~|至)\s*(-?\d+)", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            a = a + page_count if a < 0 else a
            b = b + page_count if b < 0 else b
            step = 1 if b >= a else -1
            for i in range(a, b + step, step):
                if 0 <= i < page_count:
                    out.append(i)
            continue
        if re.fullmatch(r"-?\d+", part):
            i = int(part)
            i = i + page_count if i < 0 else i
            if 0 <= i < page_count:
                out.append(i)
            continue
        raise PdfxError(f"无法解析页码表达式: {part}", "bad_page_selector")
    if not out:
        raise PdfxError(f"页码选择器无命中: {sel}", "bad_page_selector")
    return sorted(set(out))
