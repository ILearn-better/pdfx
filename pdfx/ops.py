"""编辑与检索操作层，以 mixin 形式挂到 PDFDocument 上。

一致性设计（关键）
------------------
两类 PDF 的差异被压缩到两个底层动作：
  · 结构化页：用 redaction 真正"抹掉"文字/图形，再叠新内容 —— 无损、可搜索
  · 扫描页  ：没有文字可抹，只能"贴补" —— 用背景色块盖住原像素，再叠新内容

上层 API（add/update/delete_text、search）对两类页面完全一致，
内部按 source（text / ocr / user）选择底层动作，调用方无需判断页面类型。
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Iterable, Sequence

import pymupdf as fitz

from .ocr import OcrEngine, OcrLine
from .util import (
    _FOLD,
    PdfxError,
    clean_text,
    has_cjk,
    hex_to_rgb,
    ink_color_for,
    iou,
    norm_rect,
    normalize_text,
    parse_page_selector,
    point_seg_dist,
    rect_area,
    rect_intersect,
    rgb_to_hex,
)

INK_PREFIX = "pdfx-ink"
OCR_DPI = 200


def _short() -> str:
    return uuid.uuid4().hex[:8]


def _rect_list(r) -> list[float]:
    return [round(float(r.x0), 2), round(float(r.y0), 2), round(float(r.x1), 2), round(float(r.y1), 2)]


def _covered_by(bbox: Sequence[float], hidden: dict) -> bool:
    """判断某个显示实例是否已被"色块覆盖"抹掉：位置高度重合，或中心点落在覆盖区内。"""
    hb = hidden.get("bbox") or []
    if not hb or not bbox:
        return False
    if iou(bbox, hb) > 0.6:
        return True
    cx = (bbox[0] + bbox[2]) / 2.0
    cy = (bbox[1] + bbox[3]) / 2.0
    return hb[0] - 1 <= cx <= hb[2] + 1 and hb[1] - 1 <= cy <= hb[3] + 1



def _color_from_int(v: int) -> list[float]:
    v = int(v) & 0xFFFFFF
    return [round(((v >> 16) & 255) / 255.0, 4), round(((v >> 8) & 255) / 255.0, 4), round((v & 255) / 255.0, 4)]


def _as_rgb(value: Any, default=(0.0, 0.0, 0.0)) -> tuple[float, float, float]:
    if value is None:
        return default
    if isinstance(value, str):
        return hex_to_rgb(value)
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return (float(value[0]), float(value[1]), float(value[2]))
    return default


def _font_for(text: str, hint: str = "") -> str:
    if has_cjk(text):
        return "china-s"
    h = (hint or "").lower()
    if "courier" in h or "mono" in h:
        return "cour"
    if "times" in h or "serif" in h or "georgia" in h:
        return "tiro"
    return "helv"


def _norm_with_map(text: str) -> tuple[str, list[int]]:
    chars: list[str] = []
    idx: list[int] = []
    for i, ch in enumerate(text):
        for c in unicodedata.normalize("NFKC", ch).casefold().translate(_FOLD):
            if c.isspace():
                continue
            chars.append(c)
            idx.append(i)
    return "".join(chars), idx


def _merge_fragments(lines: list[dict]) -> list[dict]:
    """把 OCR 切成多段的同一视觉行重新拼回一行。

    Windows / RapidOCR 常把一个长行按水平间隙切成若干片段，
    直接拿去检索会漏（例如金额 "1,038,000.00" 被切成 3 段）。
    """
    if len(lines) < 2:
        return lines
    ordered = sorted(lines, key=lambda l: ((l["bbox"][1] + l["bbox"][3]) / 2.0, l["bbox"][0]))
    groups: list[dict] = []
    for ln in ordered:
        try:
            cy = (ln["bbox"][1] + ln["bbox"][3]) / 2.0
            h = max(1.0, ln["bbox"][3] - ln["bbox"][1])
        except (TypeError, IndexError):
            groups.append({"cy": 0.0, "h": 1.0, "items": [ln]})
            continue
        for g in groups:
            if abs(cy - g["cy"]) <= max(h, g["h"]) * 0.45:
                g["items"].append(ln)
                g["cy"] = sum((i["bbox"][1] + i["bbox"][3]) / 2.0 for i in g["items"]) / len(g["items"])
                g["h"] = max(g["h"], h)
                break
        else:
            groups.append({"cy": cy, "h": h, "items": [ln]})

    out: list[dict] = []
    for g in groups:
        parts = sorted(g["items"], key=lambda l: l["bbox"][0])
        if len(parts) == 1:
            out.append(parts[0])
            continue
        text = parts[0]["text"]
        bbox = list(parts[0]["bbox"])
        words: list[dict] = list(parts[0].get("words") or [])
        for nxt in parts[1:]:
            gap = nxt["bbox"][0] - bbox[2]
            h = max(1.0, bbox[3] - bbox[1])
            sep = "" if gap <= h * 1.0 else " "
            text += sep + nxt["text"]
            bbox = [
                bbox[0],
                min(bbox[1], nxt["bbox"][1]),
                max(bbox[2], nxt["bbox"][2]),
                max(bbox[3], nxt["bbox"][3]),
            ]
            words.extend(nxt.get("words") or [])
        merged = dict(parts[0])
        merged.update({"text": text, "bbox": [round(v, 2) for v in bbox], "words": words, "fragments": len(parts)})
        out.append(merged)

    out.sort(key=lambda l: (round(l["bbox"][1] / 4), l["bbox"][0]))
    return out


def _match_spans(text: str, query: str, regex: bool = False, ignore_case: bool = True) -> list[tuple[int, int]]:
    """在一行文本里找命中区间（原文索引）。先精确匹配，失败再做"忽略空白"匹配。"""
    if not text or not query:
        return []
    if regex:
        try:
            pattern = re.compile(query, re.I if ignore_case else 0)
        except re.error as exc:
            raise PdfxError(f"正则表达式无效: {exc}", "bad_regex")
        return [(m.start(), m.end()) for m in pattern.finditer(text) if m.end() > m.start()]

    hay = text.casefold() if ignore_case else text
    needle = query.casefold() if ignore_case else query
    out: list[tuple[int, int]] = []
    pos = 0
    while True:
        i = hay.find(needle, pos)
        if i < 0:
            break
        out.append((i, i + len(needle)))
        pos = i + max(1, len(needle))
    if out:
        return out

    # OCR 常把 "2026" 拆成 "2 0 2 6"，此处退化为忽略空白匹配
    norm, idx = _norm_with_map(text)
    qn = normalize_text(query)
    if not qn:
        return []
    pos = 0
    while True:
        i = norm.find(qn, pos)
        if i < 0:
            break
        start = idx[i]
        end = idx[min(i + len(qn) - 1, len(idx) - 1)] + 1
        out.append((start, end))
        pos = i + max(1, len(qn))
    return out


# =========================================================================== 文本

class TextMixin:
    # ---------------------------------------------------------------- 读取
    def _native_lines(self, page_no: int) -> list[dict]:
        p = self.page(page_no)
        out: list[dict] = []
        try:
            data = p.get_text("dict")
        except Exception:
            return out
        for bi, block in enumerate(data.get("blocks", [])):
            if block.get("type") != 0:
                continue
            for li, line in enumerate(block.get("lines", [])):
                spans = line.get("spans") or []
                if not spans:
                    continue
                text = "".join(s.get("text", "") for s in spans)
                if not text.strip():
                    continue
                s0 = spans[0]
                bbox = _rect_list(fitz.Rect(line["bbox"]))
                out.append(
                    {
                        "id": f"p{page_no}:t{int(bbox[0])},{int(bbox[1])}",
                        "page": page_no,
                        "bbox": bbox,
                        "text": text,
                        "source": "text",
                        "size": round(float(s0.get("size", 10.0)), 2),
                        "font": s0.get("font", ""),
                        "color": _color_from_int(s0.get("color", 0)),
                        "flags": int(s0.get("flags", 0)),
                        "dir": line.get("dir", (1, 0)),
                    }
                )
        return out

    def _ocr_lines(self, page_no: int, dpi: int = OCR_DPI) -> list[dict]:
        eng = self._ocr_engine
        eng._load()  # 不可用会抛 ocr_unavailable
        backend = eng.backend
        p = self.page(page_no)
        pix = p.get_pixmap(dpi=int(dpi), colorspace=fitz.csRGB, alpha=False)
        raw = pix.samples
        digest = hashlib.sha1(raw).hexdigest()
        cached = self._ocr_cache.get(page_no, dpi, digest, backend)
        if cached is None:
            try:
                import numpy as np
            except ImportError as exc:  # pragma: no cover
                raise PdfxError(f"缺少 numpy: {exc}", "missing_dependency")
            arr = np.frombuffer(raw, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            lines = eng.recognize(arr, scale=float(dpi) / 72.0)
            self._ocr_cache.put(page_no, dpi, digest, backend, lines)
        else:
            lines = cached

        out = []
        for ln in lines:
            bbox = [round(v, 2) for v in ln.bbox]
            out.append(
                {
                    "id": f"p{page_no}:o{int(bbox[0])},{int(bbox[1])}",
                    "page": page_no,
                    "bbox": bbox,
                    "text": ln.text,
                    "source": "ocr",
                    "score": round(float(ln.score), 3),
                    "size": round(max(6.0, (bbox[3] - bbox[1]) * 0.95), 2),
                    "color": [0.0, 0.0, 0.0],
                    "words": ln.words,
                }
            )
        return _merge_fragments(out)

    def _merge_user_texts(self, page_no: int, lines: list[dict]) -> list[dict]:
        """把内容流里的用户文本识别出来，换成可精确操作的 state id。"""
        st = self._pstate_by_index(page_no)
        recs = st.get("texts", [])
        if not recs:
            return lines
        claimed: set[int] = set()
        for rec in recs:
            rb = rec.get("bbox")
            if not rb:
                continue
            best, best_i = None, -1
            best_score = 0.0
            for i, ln in enumerate(lines):
                if ln["source"] != "text" or i in claimed:
                    continue
                # 起点吻合优先（insert_textbox 的框往往比实际文字大）
                dx = abs(ln["bbox"][0] - rb[0])
                dy = abs(ln["bbox"][1] - rb[1])
                inside = (
                    rb[0] - 3 <= ln["bbox"][0] and rb[1] - 3 <= ln["bbox"][1]
                    and ln["bbox"][2] <= rb[2] + 3 and ln["bbox"][3] <= rb[3] + 3
                )
                score = 0.0
                if dx <= 3.5 and dy <= 5:
                    score = 1.0
                elif inside:
                    score = 0.8
                else:
                    score = iou(rb, ln["bbox"])
                if score > best_score:
                    best, best_i, best_score = ln, i, score
            if best is not None and best_score >= 0.5:
                claimed.add(best_i)
                best["source"] = "user"
                best["id"] = rec["id"]
                best["user_record"] = True
                # 用实际文字范围回填，后续定位更准
                if rect_area(best["bbox"]) < rect_area(rb):
                    rec["bbox"] = list(best["bbox"])
            elif best_score < 0.5:
                lines.append(
                    {
                        "id": rec["id"],
                        "page": page_no,
                        "bbox": list(rb),
                        "text": rec.get("text", ""),
                        "source": "user",
                        "size": rec.get("font_size", 11),
                        "font": rec.get("font", ""),
                        "color": rec.get("color", [0, 0, 0]),
                        "user_record": True,
                        "detached": True,
                    }
                )
        return lines

    def _image_coverage(self, page: fitz.Page) -> float:
        """页面被位图覆盖的比例 —— 判断"是不是扫描页"的可靠依据。"""
        try:
            total = max(1.0, page.rect.width * page.rect.height)
            covered = 0.0
            for info in page.get_image_info():
                covered += rect_area(info["bbox"])
            return min(1.0, covered / total)
        except Exception:
            return 0.0

    def _page_lines(self, page_no: int, force_ocr: bool = False, dpi: int = OCR_DPI) -> list[dict]:
        """文本层 + OCR 结果的统一视图。

        判定逻辑不再看"有没有文字"，而看"页面是否被位图主导"：
        扫描页即使被插入了新文本（有了文本层），仍然需要 OCR 才能看到原图内容。
        """
        page = self.page(page_no)
        native = self._merge_user_texts(page_no, self._native_lines(page_no))
        cov = self._image_coverage(page)
        need_ocr = force_ocr or cov >= 0.5 or (not native and bool(page.get_images()))
        if not need_ocr:
            return native

        try:
            ocr = self._ocr_lines(page_no, dpi)
        except PdfxError:
            if native:
                return native
            raise
        if not native:
            return ocr

        # 合并：与文本层重叠的 OCR 行丢弃（文本层更准，也避免重复计数）
        merged = list(native)
        for ol in ocr:
            if any(iou(ol["bbox"], nl["bbox"]) > 0.4 for nl in native):
                continue
            merged.append(ol)
        merged.sort(key=lambda l: (round(l["bbox"][1] / 4), l["bbox"][0]))
        return merged

    def list_text(self, page_no: int, force_ocr: bool = False, dpi: int = OCR_DPI) -> dict[str, Any]:
        lines = self._page_lines(page_no, force_ocr=force_ocr, dpi=dpi)
        return {
            "page": page_no,
            "page_type": self.page_type(page_no),
            "count": len(lines),
            "items": lines,
        }

    # ---------------------------------------------------------------- 定位
    def _find_text(self, page_no: int, target: Any, force_ocr: bool = False, dpi: int = OCR_DPI) -> dict:
        lines = self._page_lines(page_no, force_ocr=force_ocr, dpi=dpi)
        if isinstance(target, dict):
            bbox = norm_rect(target.get("bbox") or [])
            if not bbox or len(bbox) != 4:
                raise PdfxError("target 缺少 bbox", "bad_target")
            want = target.get("text")
        else:
            tid = str(target)
            st = self._pstate_by_index(page_no)
            for rec in st.get("texts", []):
                if rec["id"] == tid:
                    for ln in lines:
                        if ln.get("id") == tid:
                            return ln
                    return {
                        "id": tid,
                        "page": page_no,
                        "bbox": rec["bbox"],
                        "text": rec.get("text", ""),
                        "source": "user",
                        "size": rec.get("size", 11),
                        "color": rec.get("color", [0, 0, 0]),
                        "font": rec.get("font", ""),
                    }
            m = re.match(r"^\d+:?[toi](-?\d+),(-?\d+)$", tid.replace(f"p{page_no}:", ""))
            if m:
                key = (float(m.group(1)), float(m.group(2)))
                best, best_d = None, 1e9
                for ln in lines:
                    if ln["id"] == tid:
                        return ln
                    d = abs(ln["bbox"][0] - key[0]) + abs(ln["bbox"][1] - key[1])
                    if d < best_d:
                        best, best_d = ln, d
                if best is not None and best_d <= 6.0:
                    return best
            for ln in lines:
                if ln.get("id") == tid:
                    return ln
            raise PdfxError(f"未找到文本对象: {target}", "text_not_found")

        best, best_iou = None, 0.0
        for ln in lines:
            score = iou(bbox, ln["bbox"])
            if score > best_iou:
                best, best_iou = ln, score
        if best is None or best_iou < 0.25:
            raise PdfxError("指定区域没有匹配到文本", "text_not_found", bbox=bbox)
        return best

    # ---------------------------------------------------------------- 底层动作
    def _redact(self, page: fitz.Page, rects: Sequence[Sequence[float]]) -> None:
        """真正抹除文字（保留图像与矢量图形）。"""
        pending = False
        for r in rects:
            rr = fitz.Rect(*norm_rect(r))
            if rr.is_empty:
                continue
            page.add_redact_annot(rr)
            pending = True
        if pending:
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_NONE,
                graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                text=fitz.PDF_REDACT_TEXT_REMOVE,
            )

    def _bg_color(self, page: fitz.Page, bbox: Sequence[float]) -> tuple[float, float, float]:
        """采样区域边缘的众数颜色，作为"抹除"扫描件文字时的底色。"""
        try:
            import numpy as np
        except ImportError:
            return (1.0, 1.0, 1.0)
        r = fitz.Rect(*norm_rect(bbox))
        pad = max(1.5, min(max(r.width, 1), max(r.height, 1)) * 0.18)
        clip = fitz.Rect(r.x0 - pad, r.y0 - pad, r.x1 + pad, r.y1 + pad) & page.rect
        if clip.is_empty or clip.width < 1 or clip.height < 1:
            return (1.0, 1.0, 1.0)
        try:
            pix = page.get_pixmap(clip=clip, dpi=110, colorspace=fitz.csRGB, alpha=False)
            arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
        except Exception:
            return (1.0, 1.0, 1.0)
        h, w = arr.shape[:2]
        mh, mw = max(1, int(h * 0.28)), max(1, int(w * 0.28))
        edge = arr.copy()
        if h > 2 * mh and w > 2 * mw:
            edge[mh : h - mh, mw : w - mw] = 0
            mask = np.ones((h, w), dtype=bool)
            mask[mh : h - mh, mw : w - mw] = False
            edge = arr[mask]
        else:
            edge = arr.reshape(-1, 3)
        if edge.size == 0:
            return (1.0, 1.0, 1.0)
        packed = (edge[:, 0].astype(np.uint32) << 16) | (edge[:, 1].astype(np.uint32) << 8) | edge[:, 2].astype(np.uint32)
        vals, counts = np.unique(packed, return_counts=True)
        top = int(vals[counts.argmax()])
        return (((top >> 16) & 255) / 255.0, ((top >> 8) & 255) / 255.0, (top & 255) / 255.0)

    def _cover(self, page: fitz.Page, bbox: Sequence[float], color: Any = None, padding: float = 0.5) -> tuple[float, float, float]:
        """用底色块盖住扫描件上的原文字（视觉删除）。"""
        r = fitz.Rect(*norm_rect(bbox))
        fill = _as_rgb(color) if color is not None else self._bg_color(page, bbox)
        rr = fitz.Rect(r.x0 - padding, r.y0 - padding, r.x1 + padding, r.y1 + padding)
        page.draw_rect(rr, color=None, fill=fill, overlay=True)
        return fill

    def _draw_text(
        self,
        page: fitz.Page,
        rect: Sequence[float],
        text: str,
        font_size: float = 12,
        color: Any = None,
        font: str | None = None,
        align: int = 0,
        line_height: float | None = None,
        background: Any = None,
    ) -> list[float]:
        r = fitz.Rect(*norm_rect(rect))
        if r.width < 6:
            r.x1 = r.x0 + 6
        if r.height < font_size:
            r.y1 = r.y0 + font_size * 1.35
        fn = font or _font_for(text)
        col = _as_rgb(color)
        kwargs: dict[str, Any] = {
            "fontname": fn,
            "fontsize": float(font_size),
            "color": col,
            "align": int(align),
            "overlay": True,
        }
        if line_height:
            kwargs["lineheight"] = float(line_height)
        if background is not None:
            kwargs["fill"] = _as_rgb(background)

        rc = -1
        box = r
        for factor in (1.0, 1.8, 2.8, 4.2, 6.0):
            cand = fitz.Rect(r.x0, r.y0, r.x1, r.y0 + max(r.height, font_size * 1.4) * factor + font_size)
            cand &= fitz.Rect(-1e5, -1e5, 1e5, 1e7)
            rc = page.insert_textbox(cand, text, **kwargs)
            if rc >= 0:
                box = cand
                break
        if rc < 0:
            # 极端情况（超长文本）：退化为逐行插入
            page.insert_text((r.x0, r.y0 + font_size), text, fontname=fn, fontsize=font_size, color=col)
        return _rect_list(box)

    def _bbox_of_text(self, page_no: int, box: Sequence[float], text: str) -> list[float] | None:
        """回溯刚绘制文本的真实包围盒（insert_textbox 只返回"剩余空间"）。"""
        try:
            p = self.page(page_no)
            clip = fitz.Rect(*norm_rect(box)) + (-1, -1, 1, 1)
            data = p.get_text("dict", clip=clip)
        except Exception:
            return None
        boxes = []
        for block in data.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                t = "".join(s.get("text", "") for s in line.get("spans") or [])
                if t.strip():
                    boxes.append(fitz.Rect(line["bbox"]))
        if not boxes:
            return None
        union = boxes[0]
        for r in boxes[1:]:
            union |= r
        # 若框内混入了其他既有内容，退回原框，避免误伤
        if rect_area(_rect_list(union)) > rect_area(box) * 1.05 + 4:
            return None
        return _rect_list(union)

    def _style_of(self, item: dict, overrides: dict) -> dict[str, Any]:
        size = overrides.get("font_size") or item.get("size") or 11
        color = overrides.get("color")
        if color is None:
            color = item.get("color") or [0, 0, 0]
        font = overrides.get("font")
        if font is None:
            font = _font_for(overrides.get("text") or item.get("text") or "", item.get("font", ""))
        return {
            "font_size": float(size),
            "color": color,
            "font": font,
            "align": int(overrides.get("align", 0)),
            "line_height": overrides.get("line_height"),
            "background": overrides.get("background"),
        }

    # ---------------------------------------------------------------- 增
    def add_text(
        self,
        page_no: int,
        text: str,
        rect: Any = None,
        point: Any = None,
        font_size: float = 12,
        color: Any = "#111111",
        font: str | None = None,
        align: int = 0,
        line_height: float | None = None,
        background: Any = None,
        width: float | None = None,
        padding: float = 2.0,
    ) -> dict[str, Any]:
        if not text or not str(text).strip():
            raise PdfxError("文本内容为空", "empty_text")
        text = str(text)
        page = self.page(page_no)
        pw, ph = page.rect.width, page.rect.height

        if rect is not None:
            box = norm_rect(rect)
        elif point is not None:
            x, y = float(point[0]), float(point[1])
            w = float(width) if width else max(40.0, min(pw - x - 12, 400.0))
            lines = max(1, text.count("\n") + 1 + int(len(text) / max(1, w / max(font_size * 0.75, 1))))
            h = max(font_size * 1.4, font_size * 1.25 * lines + 4)
            box = [x, y, min(pw - 4, x + w), min(ph - 4, y + h)]
        else:
            raise PdfxError("必须给 rect 或 point", "bad_target")

        if box[2] - box[0] < font_size:
            box[2] = min(pw - 2, box[0] + max(font_size * 3, 60))
        if box[3] - box[1] < font_size:
            box[3] = min(ph - 2, box[1] + font_size * 1.5)

        self._push_undo()
        if background is not None:
            page.draw_rect(fitz.Rect(*box), color=None, fill=_as_rgb(background), overlay=True)
        used = self._draw_text(
            page,
            box,
            text,
            font_size=font_size,
            color=color,
            font=font,
            align=align,
            line_height=line_height,
            background=None,
        )
        tight = self._bbox_of_text(page_no, used, text)
        if tight:
            used = tight
        rec = {
            "id": f"p{page_no}:ut{_short()}",
            "bbox": used,
            "text": text,
            "font_size": float(font_size),
            "color": list(_as_rgb(color)),
            "font": font or _font_for(text),
            "align": int(align),
            "created": time.time(),
        }
        self._pstate(page)["texts"].append(rec)
        self._dirty = True
        return rec

    # ---------------------------------------------------------------- 改
    def update_text(
        self,
        page_no: int,
        target: Any,
        new_text: str | None = None,
        font_size: float | None = None,
        color: Any = None,
        font: str | None = None,
        align: int | None = None,
        line_height: float | None = None,
        background: Any = None,
        keep_box: bool = True,
    ) -> dict[str, Any]:
        item = self._find_text(page_no, target)
        text = str(new_text) if new_text is not None else item.get("text", "")
        if not text.strip():
            raise PdfxError("新文本为空；如需删除请用 delete_text", "empty_text")

        self._push_undo()
        page = self.page(page_no)
        bbox = item["bbox"]
        src = item.get("source")

        if src == "ocr":
            bg = self._cover(page, bbox, background)
            lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]
            color = color if color is not None else ((0.96, 0.96, 0.96) if lum < 0.4 else (0.08, 0.08, 0.09))
        else:
            self._redact(page, [bbox])
            color = color if color is not None else (item.get("color") or [0, 0, 0])

        style = self._style_of(item, {
            "text": text,
            "font_size": font_size,
            "color": color,
            "font": font,
            "align": align if align is not None else 0,
            "line_height": line_height,
            "background": None,
        })
        box = list(bbox) if keep_box else [bbox[0], bbox[1], bbox[0] + max(60.0, (bbox[2] - bbox[0]) * 1.15), bbox[3]]
        if keep_box:
            # 新内容更长时向右扩展，避免被压成多行（但不超出页面右边距）
            need = _estimate_width(text, style["font_size"]) * 1.08 + 8
            have = box[2] - box[0]
            if need > have * 1.02:
                limit = page.rect.width - box[0] - 10
                box[2] = box[0] + max(have, min(need, max(limit, have)))
        used = self._draw_text(
            page,
            box,
            text,
            font_size=style["font_size"],
            color=style["color"],
            font=style["font"],
            align=style["align"],
            line_height=style["line_height"],
        )
        tight = self._bbox_of_text(page_no, used, text)
        if tight:
            used = tight

        st = self._pstate(page)
        for rec in st.get("texts", []):
            if rec["id"] == item.get("id"):
                rec.update({"text": text, "bbox": used, "font_size": style["font_size"],
                            "color": list(_as_rgb(style["color"])), "font": style["font"]})
                break
        else:
            if item.get("source") == "user" or item.get("user_record"):
                st.setdefault("texts", []).append(
                    {
                        "id": item.get("id") or f"p{page_no}:ut{_short()}",
                        "bbox": used,
                        "text": text,
                        "font_size": style["font_size"],
                        "color": list(_as_rgb(style["color"])),
                        "font": style["font"],
                        "created": time.time(),
                    }
                )
        self._dirty = True
        return {"page": page_no, "bbox": used, "text": text, "replaced_source": src}

    def transform_text(
        self,
        page_no: int,
        target: Any,
        rect: Any = None,
        font_size: float | None = None,
        color: Any = None,
    ) -> dict[str, Any]:
        """移动 / 缩放一段文本：抹掉原位置，在目标框内按新字号重排。

        拖角 = 等比缩放（按高度比例联动字号）；拖边 = 只改框宽，字号不变（自动换行）。
        两类 PDF 走同一入口，底层仍按 source 分派：结构化页用 redaction 真删，
        扫描页用底色块贴补。修改后原位置不会留下残影。
        """
        item = self._find_text(page_no, target)
        text = str(item.get("text") or "")
        if not text.strip():
            raise PdfxError("该对象没有可重排的文字", "empty_text")
        if rect is None:
            raise PdfxError("transform_text 需要目标 rect", "bad_target")
        old = list(item["bbox"])
        new = norm_rect(rect)
        if len(new) != 4:
            raise PdfxError("rect 需要 4 个数", "bad_target")
        if new[2] - new[0] < 4 or new[3] - new[1] < 4:
            raise PdfxError("目标框太小，至少 4pt", "bad_target")

        base_size = float(item.get("size") or 11)
        if font_size is not None:
            size = float(font_size)
        else:
            # 只有明显的高度变化才联动字号，避免只拖边时误改字号
            ratio = (new[3] - new[1]) / max(old[3] - old[1], 1e-6)
            size = base_size * ratio if 0.25 < ratio < 4 else base_size
        size = max(4.0, min(300.0, size))

        page = self.page(page_no)
        src = item.get("source")
        self._push_undo()
        if src == "ocr":
            bg = self._cover(page, old)
            lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]
            ink = color if color is not None else ((0.96, 0.96, 0.96) if lum < 0.4 else (0.08, 0.08, 0.09))
        else:
            self._redact(page, [old])
            ink = color if color is not None else (item.get("color") or [0, 0, 0])

        used = self._draw_text(
            page, new, text, font_size=size, color=ink, font=_font_for(text, item.get("font", "")), align=0
        )
        tight = self._bbox_of_text(page_no, used, text)
        if tight:
            used = tight

        st = self._pstate(page)
        for rec in st.get("texts", []):
            if rec.get("id") == item.get("id"):
                rec.update({"bbox": used, "font_size": size, "color": list(_as_rgb(ink))})
                break
        self._dirty = True
        return {"page": page_no, "bbox": used, "font_size": size, "source": src}

    # ---------------------------------------------------------------- 删
    def delete_text(self, page_no: int, targets: Any, background: Any = None) -> dict[str, Any]:
        items = targets if isinstance(targets, list) else [targets]
        if not items:
            raise PdfxError("未指定要删除的文本", "bad_target")
        found = [self._find_text(page_no, t) for t in items]
        self._push_undo()
        page = self.page(page_no)
        redact_boxes = []
        covered = 0
        for it in found:
            if it.get("source") == "ocr":
                self._cover(page, it["bbox"], background)
                covered += 1
            else:
                redact_boxes.append(it["bbox"])
        if redact_boxes:
            self._redact(page, redact_boxes)

        st = self._pstate(page)
        ids = {it.get("id") for it in found}
        before = len(st.get("texts", []))
        st["texts"] = [r for r in st.get("texts", []) if r["id"] not in ids]
        removed_user = before - len(st["texts"])
        self._dirty = True
        return {
            "page": page_no,
            "deleted": len(found),
            "redacted": len(redact_boxes),
            "covered": covered,
            "user_records_removed": removed_user,
        }


# =========================================================================== 图片

class ImageMixin:
    def _image_instances(self, page: fitz.Page) -> list[dict]:
        """页面上实际显示的每个图片实例（同一图片多次摆放算多个）。

        注意两点：
        1. 同一图像字节被 insert_image 复用时会共享 xref，所以 xref 不能当唯一键；
        2. 覆盖/重绘后同一位置可能出现重复的绘制指令，这里按 (xref, 位置) 去重。
        """
        out: list[dict] = []
        seen: set[tuple] = set()
        try:
            infos = page.get_image_info(xrefs=True)
        except Exception:
            infos = []
        for info in infos:
            xref = int(info.get("xref") or 0)
            bbox = _rect_list(fitz.Rect(info["bbox"]))
            key = (xref,) + tuple(round(v, 1) for v in bbox)
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "xref": xref,
                    "bbox": bbox,
                    "pixel_width": int(info.get("width") or 0),
                    "pixel_height": int(info.get("height") or 0),
                }
            )
        return out

    def list_images(self, page_no: int) -> dict[str, Any]:
        page = self.page(page_no)
        st = self._pstate(page)
        hidden = st.get("hidden_images", [])
        user_recs = st.get("images", [])
        out: list[dict] = []
        for inst in self._image_instances(page):
            # 用户插入的图片由 state 记录代表，避免同一张图出现两条。
            # 这一判断必须排在 hidden 之前：删掉后在原位重新插入时，
            # 旧的 hidden 记录不应该把新图也吞掉。
            if any(iou(r["bbox"], inst["bbox"]) > 0.6 for r in user_recs):
                continue
            if any(_covered_by(inst["bbox"], h) for h in hidden):
                continue
            # 同一图片资源可能在页面上出现多次（甚至编辑后被去重共享），
            # 因此 id 必须带位置才能唯一定位一次"显示实例"
            base = f"p{page_no}:i@{int(inst['bbox'][0])},{int(inst['bbox'][1])}"
            out.append(
                {
                    "id": base,
                    "page": page_no,
                    "bbox": inst["bbox"],
                    "source": "pdf",
                    "xref": inst["xref"],
                    "pixel_width": inst["pixel_width"] or None,
                    "pixel_height": inst["pixel_height"] or None,
                }
            )
        for rec in st.get("images", []):
            out.append(
                {
                    "id": rec["id"],
                    "page": page_no,
                    "bbox": rec["bbox"],
                    "source": "user",
                    "xref": rec.get("xref"),
                    "name": rec.get("name"),
                }
            )
        return {"page": page_no, "count": len(out), "items": out}

    def _instance_near(self, page: fitz.Page, rect: Any, taken: list | None = None) -> list[float]:
        """找与给定矩形最吻合的显示实例，返回它的实际 bbox。

        不按 xref 找：同一图像字节会被复用成同一个 xref（甚至和页面原有图片撞号），
        按位置匹配才是稳的。
        """
        r = norm_rect(rect)
        best, best_score = None, 0.0
        for inst in self._image_instances(page):
            if any(iou(inst["bbox"], t) > 0.7 for t in (taken or [])):
                continue
            score = iou(r, inst["bbox"])
            if score > best_score:
                best, best_score = inst, score
        if best is not None and best_score > 0.15:
            return best["bbox"]
        return r

    def _suppress(self, page: fitz.Page, bbox: Any) -> None:
        """记住"这块位置已经被色块盖住"，让底层图片不再出现在对象列表里。"""
        self._pstate(page).setdefault("hidden_images", []).append(
            {"bbox": _rect_list(fitz.Rect(*norm_rect(bbox)))}
        )


    def _read_binary(self, src: Any) -> bytes:
        if isinstance(src, (bytes, bytearray)):
            data = bytes(src)
        else:
            p = Path(str(src)).expanduser()
            if not p.exists():
                raise PdfxError(f"图片文件不存在: {p}", "not_found")
            data = p.read_bytes()
        if not data:
            raise PdfxError("图片数据为空", "bad_image")
        return data

    def add_image(
        self,
        page_no: int,
        rect: Any,
        src: Any,
        keep_ratio: bool = True,
        rotate: int = 0,
        name: str | None = None,
    ) -> dict[str, Any]:
        data = self._read_binary(src)
        self._push_undo()
        page = self.page(page_no)
        r = fitz.Rect(*norm_rect(rect))
        if r.is_empty:
            raise PdfxError("图片区域无效", "bad_target")
        try:
            xref = page.insert_image(r, stream=data, keep_proportion=bool(keep_ratio), rotate=int(rotate) % 360, overlay=True)
        except Exception as exc:
            raise PdfxError(f"插入图片失败: {exc}", "image_insert_failed")
        taken = [rec["bbox"] for rec in self._pstate(page).get("images", [])]
        bbox = self._instance_near(page, r, taken=taken)
        rec = {
            "id": f"p{page_no}:ui{_short()}",
            "bbox": bbox,
            "xref": xref,
            "name": name or (Path(str(src)).name if isinstance(src, (str, Path)) else None),
            "created": time.time(),
        }
        self._pstate(page)["images"].append(rec)
        self._dirty = True
        return rec

    def replace_image(self, page_no: int, target: Any, src: Any, keep_ratio: bool = True) -> dict[str, Any]:
        items = self.list_images(page_no)["items"]
        item = self._pick_image(items, target)
        data = self._read_binary(src)
        self._push_undo()
        page = self.page(page_no)

        # 一律用色块盖住旧图再重绘。不要按 xref 删：
        # 相同字节的图片会共享 xref，删一次会连页面原有的图一起带走。
        old = _rect_list(fitz.Rect(*item["bbox"]))
        self._cover(page, old)
        if item["source"] == "user":
            self._suppress(page, old)  # 用户图重绘在别处时，旧实例也要从列表里退场
        r = fitz.Rect(*old)
        try:
            xref = page.insert_image(r, stream=data, keep_proportion=bool(keep_ratio), overlay=True)
        except Exception as exc:
            raise PdfxError(f"替换图片失败: {exc}", "image_insert_failed")
        taken = [rec["bbox"] for rec in self._pstate(page).get("images", []) if rec["id"] != item["id"]]
        bbox = self._instance_near(page, r, taken=taken)

        st = self._pstate(page)
        for rec in st.get("images", []):
            if rec["id"] == item["id"]:
                rec.update({"bbox": bbox, "xref": xref})
                break
        self._dirty = True
        return {"page": page_no, "id": item["id"], "bbox": bbox, "old_source": item["source"]}

    def delete_image(self, page_no: int, target: Any, mode: str = "cover") -> dict[str, Any]:
        items = self.list_images(page_no)["items"]
        item = self._pick_image(items, target)
        self._push_undo()
        page = self.page(page_no)
        done = "cover"
        rect = _rect_list(fitz.Rect(*item["bbox"]))

        if mode == "purge":
            try:
                page.add_redact_annot(fitz.Rect(*rect))
                page.apply_redactions(
                    images=fitz.PDF_REDACT_IMAGE_REMOVE,
                    graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                    text=fitz.PDF_REDACT_TEXT_NONE,
                )
                done = "purged"
            except Exception:
                self._cover(page, rect)
        else:
            self._cover(page, rect)

        st = self._pstate(page)
        st["images"] = [r for r in st.get("images", []) if r["id"] != item["id"]]
        if done == "cover":
            # 只是视觉覆盖，记下来避免它继续出现在对象列表里
            self._suppress(page, rect)
        self._dirty = True
        return {"page": page_no, "id": item["id"], "mode": done}

    def transform_image(self, page_no: int, target: Any, rect: Any, keep_ratio: bool = True) -> dict[str, Any]:
        """移动/缩放已有图片：提取原图 → 盖住原位置 → 在新位置重绘。

        keep_ratio=True 时按目标框内居中适配，图片不会被拉变形（拖角默认如此）；
        拖边手柄传 False，允许只改一个方向。
        """
        items = self.list_images(page_no)["items"]
        item = self._pick_image(items, target)
        page = self.page(page_no)
        data = None
        if item.get("xref"):
            try:
                data = self.doc.extract_image(int(item["xref"]))["image"]
            except Exception:
                data = None
        if not data:
            raise PdfxError("该图片无法提取原始数据（可能是矢量蒙版）", "image_extract_failed")
        self._push_undo()
        old = _rect_list(fitz.Rect(*item["bbox"]))
        self._cover(page, old)
        self._suppress(page, old)
        r = fitz.Rect(*norm_rect(rect))
        xref = page.insert_image(r, stream=data, keep_proportion=bool(keep_ratio), overlay=True)
        taken = [rec["bbox"] for rec in self._pstate(page).get("images", []) if rec["id"] != item["id"]]
        bbox = self._instance_near(page, r, taken=taken)
        st = self._pstate(page)
        for rec in st.get("images", []):
            if rec["id"] == item["id"]:
                rec.update({"bbox": bbox, "xref": xref})
                break
        self._dirty = True
        return {"page": page_no, "id": item["id"], "bbox": bbox}

    def _pick_image(self, items: list[dict], target: Any) -> dict:
        if isinstance(target, dict):
            bbox = norm_rect(target.get("bbox") or [])
            best, best_iou = None, 0.0
            for it in items:
                s = iou(bbox, it["bbox"])
                if s > best_iou:
                    best, best_iou = it, s
            if best is None or best_iou < 0.15:
                raise PdfxError("指定区域没有匹配到图片", "image_not_found")
            return best
        tid = str(target)
        for it in items:
            if it["id"] == tid:
                return it
        # p3:i@56,500 —— 按位置就近匹配（位置比 xref 稳定：PyMuPDF 编辑后会重排图片资源）
        m = re.fullmatch(r"p(\d+):i(?:\d+)?@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)", tid)
        if m:
            x, y = float(m.group(2)), float(m.group(3))
            best, best_d = None, 1e9
            for it in items:
                d = abs(it["bbox"][0] - x) + abs(it["bbox"][1] - y)
                if d < best_d:
                    best, best_d = it, d
            if best is not None and best_d <= 12:
                return best
        # 纯 xref：多个位置时取第一个
        m = re.fullmatch(r"(?:p\d+:i|xref[:=]?i?)?(\d+)", tid)
        if m:
            xref = int(m.group(1))
            for it in items:
                if it.get("xref") == xref:
                    return it
        raise PdfxError(f"未找到图片对象: {target}", "image_not_found")


# =========================================================================== 笔迹

class InkMixin:
    def list_strokes(self, page_no: int) -> dict[str, Any]:
        page = self.page(page_no)
        st = self._pstate(page)
        strokes = st.get("strokes", [])
        return {
            "page": page_no,
            "count": len(strokes),
            "flattened": bool(st.get("flattened")),
            "items": [
                {
                    "id": s["id"],
                    "points": s["points"],
                    "color": s.get("color"),
                    "width": s.get("width"),
                    "opacity": s.get("opacity", 1.0),
                }
                for s in strokes
            ],
        }

    def _rebuild_inks(self, page: fitz.Page, strokes: list[dict]) -> None:
        # 清掉本页由 pdfx 生成的 ink 注释
        try:
            for annot in list(page.annots() or []):
                if annot.type[0] == fitz.PDF_ANNOT_INK and str(annot.info.get("title", "")).startswith(INK_PREFIX):
                    page.delete_annot(annot)
        except Exception:
            pass
        for s in strokes:
            pts = s.get("points") or []
            if not pts:
                continue
            color = _as_rgb(s.get("color"), (0.85, 0.15, 0.15))
            width = float(s.get("width") or 2.0)
            try:
                if len(pts) == 1:
                    x, y = float(pts[0][0]), float(pts[0][1])
                    pts = [[x, y], [x + 0.6, y + 0.6]]
                path = [fitz.Point(float(p[0]), float(p[1])) for p in pts]
                annot = page.add_ink_annot([path])
                annot.set_colors(stroke=color)
                annot.set_border(width=max(0.3, width))
                annot.set_opacity(float(s.get("opacity", 1.0)))
                annot.set_info(title=f"{INK_PREFIX}:{s['id']}", content=s["id"])
                annot.update()
            except Exception:
                # 注释失败则退化为矢量绘制
                try:
                    page.draw_polyline(
                        [fitz.Point(float(p[0]), float(p[1])) for p in pts],
                        color=color,
                        width=width,
                        lineCap=1,
                        lineJoin=1,
                        overlay=True,
                    )
                except Exception:
                    pass

    def add_strokes(self, page_no: int, strokes: list[dict]) -> dict[str, Any]:
        if not strokes:
            raise PdfxError("没有笔画数据", "empty_strokes")
        self._push_undo()
        page = self.page(page_no)
        st = self._pstate(page)
        added = []
        for s in strokes:
            pts = [[float(p[0]), float(p[1])] for p in (s.get("points") or []) if len(p) >= 2]
            if len(pts) < 1:
                continue
            rec = {
                "id": f"p{page_no}:k{_short()}",
                "points": pts,
                "color": list(_as_rgb(s.get("color"), (0.85, 0.15, 0.15))),
                "width": float(s.get("width") or 2.0),
                "opacity": float(s.get("opacity", 1.0)),
            }
            st.setdefault("strokes", []).append(rec)
            added.append(rec)
        if not added:
            raise PdfxError("笔画数据无效（点太少）", "empty_strokes")
        st["flattened"] = False
        self._rebuild_inks(page, st["strokes"])
        self._dirty = True
        return {"page": page_no, "added": len(added), "ids": [a["id"] for a in added], "total": len(st["strokes"])}

    def erase_strokes(
        self,
        page_no: int,
        bbox: Any = None,
        points: Any = None,
        radius: float = 8.0,
        mode: str = "cut",
    ) -> dict[str, Any]:
        """橡皮擦。

        bbox   —— 框选擦除：擦掉与框相交的笔画
        points —— 自由擦除：给橡皮轨迹点（多点），命中部分被切除
        mode   —— "cut" 切割（保留未命中段）| "stroke" 整条删除
        """
        if bbox is None and not points:
            raise PdfxError("需要 bbox 或 points", "bad_target")
        page = self.page(page_no)
        st = self._pstate(page)
        strokes = st.get("strokes", [])
        if not strokes:
            return {"page": page_no, "removed": 0, "kept": 0, "split": 0}

        self._push_undo()
        eraser_pts = [[float(p[0]), float(p[1])] for p in (points or []) if len(p) >= 2]
        box = norm_rect(bbox) if bbox else None
        keep: list[dict] = []
        removed = 0
        split_count = 0

        def hit(p: Sequence[float]) -> bool:
            if box is not None:
                return box[0] - radius <= p[0] <= box[2] + radius and box[1] - radius <= p[1] <= box[3] + radius
            return any(_dist(p, e) <= radius for e in _densify(eraser_pts))

        for s in strokes:
            pts = s["points"]
            if mode == "stroke" or box is not None:
                touched = any(hit(p) for p in pts) if box is not None else any(hit(p) for p in pts)
                if touched:
                    removed += 1
                    continue
                keep.append(s)
                continue

            dens = _densify(eraser_pts)
            poly = _densify(pts, step=1.0)
            flags = [any(_dist(p, e) <= radius for e in dens) for p in poly]
            if not any(flags):
                keep.append(s)
                continue
            removed += 1
            groups: list[list[list[float]]] = []
            cur: list[list[float]] = []
            for p, f in zip(poly, flags):
                if not f:
                    cur.append(p)
                else:
                    if len(cur) >= 2:
                        groups.append(cur)
                    cur = []
            if len(cur) >= 2:
                groups.append(cur)
            split_count += len(groups)
            for g in groups:
                keep.append({**s, "id": f"p{page_no}:k{_short()}", "points": g})

        st["strokes"] = keep
        self._rebuild_inks(page, keep)
        self._dirty = True
        return {
            "page": page_no,
            "removed": removed,
            "split": split_count,
            "kept": len(keep),
            "total_before": len(strokes),
        }

    def clear_strokes(self, page_no: int | None = None) -> dict[str, Any]:
        self._push_undo()
        targets = range(self.doc.page_count) if page_no is None else [page_no]
        n = 0
        for i in targets:
            st = self._pstate_by_index(i)
            n += len(st.get("strokes", []))
            st["strokes"] = []
            self._rebuild_inks(self.page(i), [])
        self._dirty = True
        return {"cleared": n}

    def erase_area(
        self,
        page_no: int,
        points: Any = None,
        rects: Any = None,
        radius: float = 10.0,
        erase_text: bool = True,
    ) -> dict[str, Any]:
        """页面级橡皮：把橡皮轨迹扫过的**页面原有内容**真正擦掉。

        和 erase_strokes 的区别：那个只处理"我画上去的笔迹"，这个处理 PDF 本身的
        文字与图像——结构化页用 redaction 真删文字，图像内容（扫描件）用底色涂掉。
        """
        page = self.page(page_no)
        pts = [[float(p[0]), float(p[1])] for p in (points or []) if len(p) >= 2]
        boxes = [[float(v) for v in norm_rect(r)] for r in (rects or [])]
        if not pts and not boxes:
            raise PdfxError("需要 points 或 rects", "bad_target")
        radius = max(1.0, float(radius))
        self._push_undo()

        # 轨迹 → 覆盖矩形（判断文字是否被扫到）
        swath: list[tuple[str, Any]] = []
        if len(pts) == 1:
            swath.append(("dot", pts[0]))
        elif len(pts) > 1:
            swath.extend(("seg", (pts[i], pts[i + 1])) for i in range(len(pts) - 1))
        hit_boxes = list(boxes)
        for kind, v in swath:
            if kind == "dot":
                x, y = v
                hit_boxes.append([x - radius, y - radius, x + radius, y + radius])
            else:
                (ax, ay), (bx, by) = v
                hit_boxes.append([min(ax, bx) - radius, min(ay, by) - radius,
                                  max(ax, bx) + radius, max(ay, by) + radius])
        hit_boxes = [b for b in hit_boxes if b[2] > b[0] and b[3] > b[1]]
        if not hit_boxes:
            raise PdfxError("有效的擦除范围为空", "bad_target")

        # 1) 命中的文字：结构化页真删（redaction），用户插入的文本顺手同步状态
        removed_text: list[str] = []
        touched: list[dict] = []
        # 纯扫描页没有文字层，重跑 OCR 既慢又没用，直接走"涂底色"
        if erase_text and self.page_type(page_no) != "scanned":
            for item in self.list_text(page_no)["items"]:
                box = item.get("bbox") or []
                if len(box) < 4:
                    continue
                if any(iou(box, hb) > 0.02 or _covered_by(box, {"bbox": hb}) for hb in hit_boxes):
                    touched.append(item)
        if touched:
            for item in touched:
                try:
                    page.add_redact_annot(fitz.Rect(*norm_rect(item["bbox"])))
                except Exception:
                    pass
                removed_text.append(item.get("text", ""))
            try:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
            except Exception:
                pass
            st = self._pstate(page)
            if st.get("texts"):
                gone = {x.get("id") for x in touched if x.get("id")}
                if gone:
                    st["texts"] = [t for t in st["texts"] if t.get("id") not in gone]

        # 2) 图像内容：拿擦除区域周边的众数色（纸色）涂掉
        union = [min(b[0] for b in hit_boxes), min(b[1] for b in hit_boxes),
                 max(b[2] for b in hit_boxes), max(b[3] for b in hit_boxes)]
        fill = self._bg_color(page, union)
        covered = 0
        for kind, v in swath:
            try:
                if kind == "dot":
                    page.draw_circle(fitz.Point(v[0], v[1]), radius, color=fill, fill=fill, overlay=True)
                else:
                    (ax, ay), (bx, by) = v
                    page.draw_line(fitz.Point(ax, ay), fitz.Point(bx, by),
                                   color=fill, width=radius * 2, lineCap=1, lineJoin=1, overlay=True)
                covered += 1
            except Exception:
                pass
        for b in boxes:
            self._cover(page, b, color=fill, padding=0.0)
            covered += 1

        # 3) 覆盖区内的笔迹也跟着断开（否则重新 _rebuild_inks 会把它画回来）
        ink = self.erase_strokes(page_no, points=pts or None,
                                 bbox=None if pts else union, radius=radius, mode="cut") if pts else {"removed": 0}
        self._dirty = True
        return {
            "page": page_no,
            "removed_text": [t for t in removed_text if t][:20],
            "removed_text_count": len(removed_text),
            "covered": covered,
            "strokes_removed": ink.get("removed", 0),
            "fill": [round(v * 255) for v in fill],
        }

    def _flatten_inks_all(self) -> int:
        n = 0
        for i in range(self.doc.page_count):
            page = self.page(i)
            st = self._pstate(page)
            strokes = st.get("strokes", [])
            if not strokes:
                continue
            for s in strokes:
                pts = [fitz.Point(float(p[0]), float(p[1])) for p in s["points"]]
                if len(pts) < 2:
                    continue
                try:
                    page.draw_polyline(
                        pts,
                        color=_as_rgb(s.get("color"), (0.85, 0.15, 0.15)),
                        width=float(s.get("width") or 2.0),
                        lineCap=1,
                        lineJoin=1,
                        overlay=True,
                    )
                except Exception:
                    pass
            n += len(strokes)
            st["strokes"] = []
            st["flattened"] = True
            self._rebuild_inks(page, [])
        if n:
            self._dirty = True
        return n


def _estimate_width(text: str, size: float) -> float:
    """粗略估算一段文字排成一行需要的宽度（中文按 1em，其余按 0.55em）。"""
    widest = 0.0
    for line in (text or "").split("\n"):
        w = 0.0
        for ch in line:
            o = ord(ch)
            cjk = 0x2E80 <= o <= 0x9FFF or 0xFF00 <= o <= 0xFFEF or 0x3000 <= o <= 0x303F
            w += size * (1.0 if cjk else 0.55)
        widest = max(widest, w)
    return widest


def _dist(a: Sequence[float], b: Sequence[float]) -> float:
    return ((float(a[0]) - float(b[0])) ** 2 + (float(a[1]) - float(b[1])) ** 2) ** 0.5


def _densify(pts: list[list[float]], step: float = 2.0) -> list[list[float]]:
    """把折线按步长插值成密集点，便于命中判断。"""
    if not pts:
        return []
    if len(pts) == 1:
        return [list(pts[0])]
    out: list[list[float]] = [list(pts[0])]
    for i in range(len(pts) - 1):
        ax, ay = pts[i][0], pts[i][1]
        bx, by = pts[i + 1][0], pts[i + 1][1]
        dist = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
        n = max(1, int(dist / max(step, 0.5)))
        for k in range(1, n + 1):
            t = k / n
            out.append([ax + (bx - ax) * t, ay + (by - ay) * t])
    return out


# =========================================================================== 检索

def _joinable(a: dict, b: dict) -> bool:
    """判断两行是否可能属于同一段（垂直紧邻 + 水平有重叠）。"""
    ah = max(1.0, a["bbox"][3] - a["bbox"][1])
    gap = b["bbox"][1] - a["bbox"][3]
    if not (-ah * 0.6 <= gap <= max(ah * 1.3, 14.0)):
        return False
    overlap = min(a["bbox"][2], b["bbox"][2]) - max(a["bbox"][0], b["bbox"][0])
    return overlap > 0


class SearchMixin:
    def _hit(self, pno: int, ln: dict, text: str, s: int, e: int, context: int, bbox=None) -> dict:
        box = list(bbox if bbox is not None else ln["bbox"])
        if len(text) > 30 and (e - s) < len(text) and bbox is None:
            x0, y0, x1, y1 = box
            box = [x0 + (x1 - x0) * (s / len(text)), y0, x0 + (x1 - x0) * (e / len(text)), y1]
        return {
            "page": pno,
            "bbox": [round(v, 2) for v in box],
            "line_bbox": ln["bbox"],
            "text": text,
            "match": text[s:e],
            "source": ln["source"],
            "score": ln.get("score"),
            "char_start": s,
            "char_end": e,
            "context": text[max(0, s - context) : min(len(text), e + context)],
            "id": ln.get("id"),
            "multiline": bbox is not None,
        }

    def _match_in_lines(
        self, pno: int, lines: list[dict], q: str, regex: bool, context: int, allow_multiline: bool
    ) -> list[dict]:
        out: list[dict] = []
        for ln in lines:
            for s, e in _match_spans(ln["text"], q, regex=regex):
                out.append(self._hit(pno, ln, ln["text"], s, e, context))
        if out or not allow_multiline or len(lines) < 2:
            return out

        # 单行都没命中时，退化为"跨行拼接"匹配（OCR 常把一句话切成多行）
        for i in range(len(lines)):
            for w in (2, 3):
                if i + w > len(lines):
                    break
                grp = lines[i : i + w]
                if not all(_joinable(grp[k], grp[k + 1]) for k in range(len(grp) - 1)):
                    break
                text = "".join(g["text"] for g in grp)
                spans = _match_spans(text, q, regex=regex)
                if not spans:
                    continue
                box = list(grp[0]["bbox"])
                for g in grp[1:]:
                    b = g["bbox"]
                    box = [min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3])]
                for s, e in spans:
                    out.append(self._hit(pno, grp[0], text, s, e, context, bbox=box))
                break
        # 去掉重叠的重复命中
        dedup: list[dict] = []
        for h in out:
            if any(iou(h["bbox"], d["bbox"]) > 0.85 for d in dedup):
                continue
            dedup.append(h)
        return dedup

    def search(
        self,
        query: str,
        pages: Any = None,
        regex: bool = False,
        force_ocr: bool = False,
        context: int = 36,
        limit: int = 300,
        dpi: int = OCR_DPI,
        allow_multiline: bool = True,
    ) -> dict[str, Any]:
        q = (query or "").strip()
        if not q:
            raise PdfxError("检索内容不能为空", "bad_query")
        targets = parse_page_selector(pages, self.doc.page_count)
        hits: list[dict] = []
        ocr_pages: list[int] = []
        truncated = False

        for pno in targets:
            ptype = self.page_type(pno)
            try:
                lines = self._page_lines(pno, force_ocr=force_ocr, dpi=dpi)
                if force_ocr or ptype == "scanned":
                    ocr_pages.append(pno)
                elif any(l["source"] == "ocr" for l in lines):
                    ocr_pages.append(pno)
            except PdfxError:
                lines = self._native_lines(pno)

            for h in self._match_in_lines(pno, lines, q, regex, context, allow_multiline):
                hits.append(h)
                if len(hits) >= limit:
                    truncated = True
                    break
            if truncated:
                break

        return {
            "query": q,
            "regex": bool(regex),
            "total": len(hits),
            "truncated": truncated,
            "pages_searched": len(targets),
            "ocr_pages": sorted(set(ocr_pages)),
            "hits": hits,
        }

    def extract_text(self, pages: Any = None, force_ocr: bool = False, dpi: int = OCR_DPI) -> dict[str, Any]:
        targets = parse_page_selector(pages, self.doc.page_count)
        parts: list[dict] = []
        ocr_pages: list[int] = []
        for pno in targets:
            ptype = self.page_type(pno)
            try:
                lines = self._page_lines(pno, force_ocr=force_ocr, dpi=dpi)
                if force_ocr or ptype == "scanned" or any(l["source"] == "ocr" for l in lines):
                    ocr_pages.append(pno)
            except PdfxError:
                lines = self._native_lines(pno)
            txt = "\n".join(l["text"] for l in lines)
            parts.append({"page": pno, "type": ptype, "text": txt, "chars": len(txt)})
        return {
            "pages": parts,
            "total_chars": sum(p["chars"] for p in parts),
            "ocr_pages": sorted(set(ocr_pages)),
            "text": "\n\n".join(p["text"] for p in parts),
        }
