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

import copy
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


def _squash(text: str) -> str:
    """去掉所有空白，用来比对"这是不是同一段文字"。

    换行、缩进、CJK 之间的空格在文本层提取时并不可靠，
    直接比字符串会把同一段内容判成不同。
    """
    return re.sub(r"\s+", "", text or "")


def _as_text_list(value: Any) -> list[str]:
    """drop_text 允许传一个字符串或一组字符串。"""
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple, set)):
        return [str(v) for v in value if v is not None]
    return [str(value)]


def _restore_font(name: str, text: str) -> str:
    """补画别人文字时只能用内置字体 —— 原字体常常是子集或没嵌进页面。"""
    if has_cjk(text):
        return "china-s"
    n = (name or "").lower()
    if any(k in n for k in ("courier", "mono", "consol")):
        return "cour"
    if any(k in n for k in ("times", "serif", "georgia", "song", "ming")):
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
            # get_text("dict") 在扫描页上要 60ms 左右（得把整页内容流解析成块结构），
            # 而扫描页根本没有文字块。先用几乎免费的纯文本探测挡一道：
            # 页面一个字都没有就直接返回，翻页/对象查询从 60ms+ 降到 1ms 以内。
            if not p.get_text("text").strip():
                return out
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
        """把内容流里的用户文本识别出来，换成可精确操作的 state id。

        **按内容认领，不按就近认领**。insert_textbox 插入的多行文字在文本层里
        是一行一条，只比坐标会把记录绑到旁边不相干的一行上 —— 于是拖这个框，
        被抹掉的却是别人的字（表现为"文字越拖越乱、框放大后字跑出去"）。
        这里改成：取落在记录框里的原生行，按阅读顺序拼起来，内容与记录一致
        才认领；认领后把这几行合成**一个**对象（同一个 id、同一个框）。
        """
        st = self._pstate_by_index(page_no)
        recs = st.get("texts", [])
        if not recs:
            return lines

        claimed: set[int] = set()
        drop: set[int] = set()
        for rec in recs:
            rb = rec.get("bbox")
            if not rb:
                continue
            want = _squash(rec.get("text", ""))
            idxs: list[int] = []
            for i, ln in enumerate(lines):
                if ln.get("source") != "text" or i in claimed:
                    continue
                x0, y0, x1, y1 = ln["bbox"]
                cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
                if (rb[0] - 4 <= x0 and x1 <= rb[2] + 4 and rb[1] - 4 <= cy <= rb[3] + 4) \
                        or (rb[0] - 4 <= cx <= rb[2] + 4 and rb[1] - 4 <= cy <= rb[3] + 4):
                    idxs.append(i)
            idxs.sort(key=lambda i: (round(lines[i]["bbox"][1] / 3.0), lines[i]["bbox"][0]))

            group: list[int] = []
            got = ""
            for i in idxs:
                group.append(i)
                got += _squash(lines[i]["text"])
                if len(got) >= len(want):
                    break

            if group and want and got == want:
                claimed.update(group)
                first = lines[group[0]]
                union = fitz.Rect(first["bbox"])
                for i in group[1:]:
                    union |= fitz.Rect(lines[i]["bbox"])
                    drop.add(i)
                first.update(
                    {
                        "id": rec["id"],
                        "source": "user",
                        "user_record": True,
                        "bbox": _rect_list(union),
                        "text": rec.get("text", ""),
                        "size": float(rec.get("font_size") or first.get("size") or 11),
                        "color": rec.get("color") or first.get("color"),
                        "font": rec.get("font") or first.get("font", ""),
                    }
                )
                # 用实际文字范围回填，后续定位更准
                if rect_area(_rect_list(union)) < rect_area(rb):
                    rec["bbox"] = _rect_list(union)
                continue

            # 内容对不上（字形没编码、文字已被涂掉等）：按记录自己的框挂一个对象。
            # 绝不能借用别人的 id —— 那样拖动会删掉别人的内容。
            lines.append(
                {
                    "id": rec["id"],
                    "page": page_no,
                    "bbox": list(rb),
                    "text": rec.get("text", ""),
                    "source": "user",
                    "size": float(rec.get("font_size") or 11),
                    "font": rec.get("font", ""),
                    "color": rec.get("color", [0, 0, 0]),
                    "user_record": True,
                    "detached": True,
                }
            )

        if drop:
            lines = [ln for i, ln in enumerate(lines) if i not in drop]
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

    def _page_lines(self, page_no: int, force_ocr: bool = False, dpi: int = OCR_DPI,
                    auto_ocr: bool = False) -> list[dict]:
        """文本层 + OCR 结果的统一视图。

        **浏览时 OCR 默认不跑**。以前只要页面被位图主导就自动识别，结果是翻到
        任何一页扫描件都要等 1~3 秒（整页 200dpi 识别），连续模式下滚动翻页
        一路卡到底 —— 而用户多数时候只是看图，并不需要文字层。

        现在分三种场合：
        - 界面浏览（默认）：只返回文本层，扫描页拿到空列表，界面提示"未识别"；
        - 界面显式点「识别本页文字」：force_ocr=True；
        - 检索 / 导出全文：auto_ocr=True —— 这是用户主动发起的动作，
          扫描件必须识别，否则"搜不到东西"才是真问题。
        识别结果按图像哈希缓存，同一页只算一次。
        """
        native = self._merge_user_texts(page_no, self._native_lines(page_no))
        if not force_ocr:
            if not auto_ocr or not self._needs_ocr(page_no, native):
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

    def _needs_ocr(self, page_no: int, native: list[dict] | None = None) -> bool:
        """这页有没有"只存在于图里"的内容（扫描件）。"""
        lines = native if native is not None else self._native_lines(page_no)
        page = self.page(page_no)
        if self._image_coverage(page) >= 0.5:
            return True
        return not lines and bool(page.get_images())

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
        # 定位一个 OCR 行时当然得先跑识别，否则"用户点的是识别结果，后端却看不见它"
        if not force_ocr:
            if isinstance(target, dict):
                force_ocr = target.get("source") == "ocr"
            elif isinstance(target, str):
                force_ocr = ":o" in target
        lines = self._page_lines(page_no, force_ocr=force_ocr, dpi=dpi)
        if isinstance(target, dict):
            # 只给 id 也要能用（界面拖动时传的就是 {page, id, rect}）
            if target.get("id") and not target.get("bbox"):
                return self._find_text(page_no, str(target["id"]), force_ocr=force_ocr, dpi=dpi)
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
                        "size": float(rec.get("font_size") or rec.get("size") or 11),
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
    def _redact(self, page: fitz.Page, rects: Sequence[Sequence[float]], drop_text: Any = None) -> None:
        """真正抹除文字（保留图像与矢量图形）。

        `drop_text` 是"这次只该删掉的那段文字"。给了它就只删它：红框里**别人的
        字**会先按整段一起删干净、删除后按原位补画回去。
        不这么做就会出现"拖一下文本框，底下那段正文跟着没了" ——
        redaction 是按矩形整块删字符的，切到谁就删谁。
        """
        boxes = []
        for r in rects:
            rr = fitz.Rect(*norm_rect(r))
            if not rr.is_empty:
                boxes.append(rr)
        if not boxes:
            return
        targets = [t for t in (_squash(x) for x in _as_text_list(drop_text)) if t]
        keep: list[dict] = []
        if targets:
            keep = self._spans_outside_target(page, boxes, targets)
        # 别人的那段字往往比目标框宽（框只压住半行）。只 redact 半行会留下半截，
        # 再补画整行就叠字；所以把它们的整段 bbox 一起纳入，删干净再完整补画。
        areas = list(boxes) + [fitz.Rect(*sp["bbox"]) for sp in keep]
        for rr in areas:
            page.add_redact_annot(rr)
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
        )
        if keep:
            self._restore_spans(page, keep)

    def _spans_outside_target(self, page: fitz.Page, boxes: list[fitz.Rect], targets: list[str]) -> list[dict]:
        """框里不属于目标文字的那些 span（删完要补画的候选）。"""
        out: list[dict] = []
        seen: set[tuple] = set()
        # 目标文字按行拆开：文本框的每一行在文本层里就是一条 span，整行相等最可靠。
        lines = {n for t in targets for n in (_squash(x) for x in re.split(r"[\r\n]+", t)) if n}
        # 有些 PDF 会把同一行按颜色/字体拆成几条 span，这时只能退化成"是不是目标的子串"。
        # 加一个字符预算，避免正文里恰好有同样的词被误认成目标而一起删掉。
        budget = sum(len(t) for t in targets) + 2
        used = 0
        spans = self._page_spans(page)
        for b in boxes:
            for sp in self._spans_touching(spans, b):
                n = _squash(sp.get("text") or "")
                if not n:
                    continue
                if n in lines:
                    continue
                if any(n in tg for tg in targets) and used + len(n) <= budget:
                    used += len(n)
                    continue
                key = (n, tuple(round(v, 1) for v in sp["bbox"]))
                if key in seen:
                    continue
                seen.add(key)
                out.append(sp)
        return out

    def _page_spans(self, page: fitz.Page) -> list[dict]:
        """整页的 span（完整文本，不被 clip 截断），带位置/字号/颜色/字体。

        必须整页取：`get_text("dict", clip=..)` 会把跨出裁剪框的 span 文本截断，
        拿截断的文本去补画，页面上就会出现"前半行新字 + 后半行旧字"。
        """
        try:
            data = page.get_text("dict")
        except Exception:
            return []
        out: list[dict] = []
        for blk in data.get("blocks", []):
            if blk.get("type") != 0:
                continue
            for line in blk.get("lines") or []:
                for sp in line.get("spans") or []:
                    t = sp.get("text") or ""
                    bb = sp.get("bbox") or []
                    if not t.strip() or len(bb) != 4:
                        continue
                    origin = sp.get("origin") or (bb[0], bb[3])
                    out.append(
                        {
                            "text": t,
                            "bbox": [float(v) for v in bb],
                            "origin": [float(origin[0]), float(origin[1])],
                            "size": float(sp.get("size") or 10.0),
                            "color": int(sp.get("color") or 0),
                            "font": sp.get("font") or "",
                        }
                    )
        return out

    @staticmethod
    def _spans_touching(spans: list[dict], box: fitz.Rect) -> list[dict]:
        hit = []
        for sp in spans:
            try:
                if fitz.Rect(*sp["bbox"]).intersects(box):
                    hit.append(sp)
            except Exception:
                continue
        return hit

    def _restore_spans(self, page: fitz.Page, spans: list[dict]) -> None:
        """把被 redaction 顺带删掉的"别人的字"按原位置补回去。

        字体只能用内置的（原有字体多半是子集、页面里拿不到字体文件），
        所以字号、位置、颜色照抄，字形可能与原稿有极小差异 ——
        但总比整段正文消失好。
        """
        alive = [_squash(sp.get("text") or "") for sp in self._page_spans(page)]
        for sp in spans:
            n = _squash(sp.get("text") or "")
            if not n or n in alive:
                continue
            try:
                page.insert_text(
                    fitz.Point(float(sp["origin"][0]), float(sp["origin"][1])),
                    sp["text"],
                    fontname=_restore_font(sp.get("font") or "", sp["text"]),
                    fontsize=max(1.0, float(sp["size"])),
                    color=tuple(_color_from_int(sp.get("color") or 0)),
                    overlay=True,
                )
            except Exception:
                continue

    def _paper_color(self, page: fitz.Page) -> tuple[float, float, float]:
        """页面纸张底色：低分辨率渲染整页后取四角最亮者。

        专门用于「移动元素后擦掉原位」。不能复用 `_bg_color` —— 那个取的是
        区域边缘的众数色，而被移动的那块本来就是图片自己，取出来就是图片的颜色，
        涂上去等于用图盖图，原位会留下一个一模一样的残影。
        """
        try:
            pix = page.get_pixmap(dpi=24, colorspace=fitz.csRGB, alpha=False)
            w, h, n = pix.width, pix.height, pix.n
            if w < 3 or h < 3:
                return (1.0, 1.0, 1.0)
            s = pix.samples
            best, best_sum = (255, 255, 255), -1
            for x, y in ((1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2)):
                i = (y * w + x) * n
                c = (s[i], s[i + 1], s[i + 2])
                if sum(c) > best_sum:
                    best, best_sum = c, sum(c)
            return (best[0] / 255.0, best[1] / 255.0, best[2] / 255.0)
        except Exception:
            return (1.0, 1.0, 1.0)

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

    def _draw_text_fit(
        self,
        page: fitz.Page,
        rect: Sequence[float],
        text: str,
        font_size: float,
        color: Any = None,
        font: str | None = None,
        align: int = 0,
        line_height: float | None = None,
        min_size: float = 4.0,
    ) -> tuple[list[float], float, bool, list[float]]:
        """把文字画进 rect，**装不下就缩字号，绝不让字跑到框外**。

        这是"放大文本框"的正确行为：插入/改内容时框可以跟着字长，
        但拖动缩放手柄时框是用户给定的边界，字只能在这个边界内重排。

        insert_textbox 放不下时不会写入任何内容（返回负数 = 还差多少高度），
        所以可以原地按比例反复试，不需要在临时页上测量。
        返回 (目标框, 实际字号, 是否成功, 文字实际占用的排版框)。
        """
        r = fitz.Rect(*norm_rect(rect))
        if r.width < 6:
            r.x1 = r.x0 + 6
        outer = fitz.Rect(r)
        pr = page.rect
        # 一点点余量：tight bbox 只量到字形，而 insert_textbox 还要算行距，
        # 不留余量的话"等比放大"会莫名其妙地缩掉 10%。返回值仍按 outer 报，
        # 真实的字形范围由 _bbox_of_text 回填。
        pad = min(3.0, max(1.0, r.height * 0.02))
        r = fitz.Rect(min(r.x0, pr.x1), min(r.y0, pr.y1),
                      min(r.x1 + pad, pr.x1), min(r.y1 + pad, pr.y1))

        fn = font or _font_for(text)
        col = _as_rgb(color)
        kwargs: dict[str, Any] = {
            "fontname": fn,
            "color": col,
            "align": int(align),
            "overlay": True,
        }
        if line_height:
            kwargs["lineheight"] = float(line_height)

        size = max(min_size, float(font_size))
        for _ in range(12):
            rc = page.insert_textbox(r, text, fontsize=size, **kwargs)
            if rc >= 0:
                # 剩下的高度 = 没用到的高度，反推文字真正占的排版高度。
                # 拿它当排版框存下来，下次按比例缩放时就不会累积误差
                # （累积的话拖几次字号就被"塞"小了）。
                fitbox = [r.x0, r.y0, r.x1, round(r.y1 - rc, 2)]
                return _rect_list(outer), size, True, fitbox
            # rc 负值 = 还差多少高度；按"现有高度 / 需要高度"反推字号
            need = abs(rc)
            nxt = size * (r.height / max(r.height + need, 1e-6))
            if nxt >= size - 0.05:
                nxt = size * 0.94           # 保证单调下降，避免卡住
            size = max(min_size, nxt)
            if size <= min_size + 1e-6:
                break
        rc = page.insert_textbox(r, text, fontsize=min_size, **kwargs)
        fitbox = [r.x0, r.y0, r.x1, round(r.y1 - rc, 2)] if rc >= 0 else _rect_list(r)
        return _rect_list(outer), min_size, rc >= 0, fitbox

    def _bbox_of_text(self, page_no: int, box: Sequence[float], text: str) -> list[float] | None:
        """回溯刚绘制文本的真实包围盒（insert_textbox 只返回"剩余空间"）。

        只统计内容属于 `text` 的行 —— 文本框往往压在正文上，不筛内容的话
        框里原有的字会把包围盒撑大，判据就失效了（画笔框位置会歪）。
        """
        try:
            p = self.page(page_no)
            clip = fitz.Rect(*norm_rect(box)) + (-1, -1, 1, 1)
            data = p.get_text("dict", clip=clip)
        except Exception:
            return None
        want = _squash(text)
        boxes = []
        for block in data.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                t = "".join(s.get("text", "") for s in line.get("spans") or [])
                if not t.strip():
                    continue
                if want and _squash(t) not in want:
                    continue
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
        drawn = self._draw_text(
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
        used = drawn
        tight = self._bbox_of_text(page_no, drawn, text)
        if tight:
            used = tight
        rec = {
            "id": f"p{page_no}:ut{_short()}",
            "bbox": used,
            # 排版框：文字按这个框换行。它比字形范围（bbox）略大，
            # 拖动时按同样比例缩放，字号才不会每次都被"重新塞一遍"而缩水。
            "box": list(_rect_list(fitz.Rect(*norm_rect(drawn)))),
            "text": text,
            "font_size": float(font_size),
            "color": list(_as_rgb(color)),
            "font": font or _font_for(text),
            "align": int(align),
            "created": time.time(),
        }
        self._pstate(page)["texts"].append(rec)
        self._touch()
        # 同样返回副本：后续 update/transform 会原地改写内部记录
        return dict(rec)

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
            self._redact(page, [bbox], drop_text=item.get("text"))
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
        drawn = self._draw_text(
            page,
            box,
            text,
            font_size=style["font_size"],
            color=style["color"],
            font=style["font"],
            align=style["align"],
            line_height=style["line_height"],
        )
        used = drawn
        tight = self._bbox_of_text(page_no, drawn, text)
        if tight:
            used = tight

        st = self._pstate(page)
        for rec in st.get("texts", []):
            if rec["id"] == item.get("id"):
                rec.update({"text": text, "bbox": used, "box": list(_rect_list(fitz.Rect(*norm_rect(drawn)))),
                            "font_size": style["font_size"],
                            "color": list(_as_rgb(style["color"])), "font": style["font"]})
                break
        else:
            if item.get("source") in ("user", "ocr") or item.get("user_record"):
                # OCR 行的 id 是按坐标编号的，改完位置就失效，换一个新的 ut id
                keep_id = item.get("source") != "ocr" and item.get("id")
                st.setdefault("texts", []).append(
                    {
                        "id": keep_id or f"p{page_no}:ut{_short()}",
                        "bbox": used,
                        "box": list(_rect_list(fitz.Rect(*norm_rect(drawn)))),
                        "text": text,
                        "font_size": style["font_size"],
                        "color": list(_as_rgb(style["color"])),
                        "font": style["font"],
                        "created": time.time(),
                    }
                )
        self._touch()
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
        **目标框是硬边界**：字号放不下就在框内缩小，不会像以前那样把绘制框
        往下撑开 —— 那样字会跑到框外面去，看上去就是"字体脱离了文本框"。
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

        page = self.page(page_no)
        pr = page.rect
        new = [
            min(max(new[0], 0.0), pr.width - 4),
            min(max(new[1], 0.0), pr.height - 4),
            min(max(new[2], new[0] + 4), pr.width),
            min(max(new[3], new[1] + 4), pr.height),
        ]

        base_size = float(item.get("font_size") or item.get("size") or 11)
        if font_size is not None:
            size = float(font_size)
        else:
            # 只有明显的高度变化才联动字号，避免只拖边时误改字号
            ratio = (new[3] - new[1]) / max(old[3] - old[1], 1e-6)
            size = base_size * ratio if 0.25 < ratio < 4 else base_size
        size = max(4.0, min(300.0, size))

        st = self._pstate_by_index(page_no)
        rec = next((r for r in st.get("texts", []) if r.get("id") == item.get("id")), None)
        # 目标框是"字形范围"缩放来的，而排版框（box）比它高一点。
        # 这里宽度直接用用户拖出来的宽度（换行按这个宽度重排），高度沿用
        # 原来的排版余量再按比例缩放 —— 否则 tight bbox 比排版框矮，
        # 每次等比放大都会被重新"塞"一遍，字号一点点掉下去。
        draw = list(new)
        old_box = list((rec or {}).get("box") or [])
        sx = sy = 1.0
        if old[2] > old[0] and old[3] > old[1]:
            sx = (new[2] - new[0]) / (old[2] - old[0])
            sy = (new[3] - new[1]) / (old[3] - old[1])
        if len(old_box) != 4:
            # 没有记录（原生文字 / OCR 行）时按行距估一个排版框：
            # insert_textbox 对一行 CJK 要 1.57×字号的高度（行距 + 上下留白），
            # 而字形范围只有 0.87 左右 —— 直接拿 bbox 当框，等比放大必被挤小。
            box_h = max((old[3] - old[1]) * 1.08, base_size * 1.6)
            old_box = [new[0], new[1], new[2], new[1] + box_h]
        if 0.1 < sy < 10:
            draw[3] = min(pr.height, new[1] + (old_box[3] - old_box[1]) * sy)
        # 只拖左右边（高度没变）= 纯重排：字号保持不变，框放不下就往下长。
        # 这是编辑器里"改宽度"的正常手感，不该把字号缩掉。
        reflow = abs(sy - 1.0) < 0.03 and abs(sx - 1.0) > 0.03
        src = item.get("source")
        self._push_undo()
        if src == "ocr":
            bg = self._cover(page, old)
            lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]
            ink = color if color is not None else ((0.96, 0.96, 0.96) if lum < 0.4 else (0.08, 0.08, 0.09))
        else:
            self._redact(page, [old], drop_text=text)
            ink = color if color is not None else (item.get("color") or [0, 0, 0])

        if reflow:
            drawn = self._draw_text(
                page, draw, text, font_size=size, color=ink, font=_font_for(text, item.get("font", "")), align=0
            )
            fitted = True
        else:
            outer, size, fitted, fitbox = self._draw_text_fit(
                page, draw, text, size, color=ink, font=_font_for(text, item.get("font", "")), align=0
            )
            drawn = fitbox if fitted else outer
        used = drawn
        if not fitted:
            # 极端情况：框小到 4pt 都放不下。允许外扩，至少要保证内容完整、不丢字。
            used = drawn = self._draw_text(
                page, draw, text, font_size=size, color=ink, font=_font_for(text, item.get("font", "")), align=0
            )
        tight = self._bbox_of_text(page_no, drawn, text)
        if tight:
            used = tight

        for r in st.get("texts", []):
            if r.get("id") == item.get("id"):
                r.update({"bbox": used, "box": list(_rect_list(fitz.Rect(*norm_rect(drawn)))),
                          "font_size": size, "color": list(_as_rgb(ink))})
                break
        else:
            # 扫描件上的 OCR 文字没有 state 记录，改完之后就只剩"内容流里的几行字"：
            # 下次再拖它，排版框和字号都无从继承（会一点点被塞小），id 也会随坐标变。
            # 这里补一条记录，让它从此和用户插入的文本框一样可反复操作。
            if src == "ocr":
                st.setdefault("texts", []).append(
                    {
                        "id": f"p{page_no}:ut{_short()}",
                        "bbox": used,
                        "box": list(_rect_list(fitz.Rect(*norm_rect(drawn)))),
                        "text": text,
                        "font_size": size,
                        "color": list(_as_rgb(ink)),
                        "font": _font_for(text, item.get("font", "")),
                        "created": time.time(),
                    }
                )
        self._touch()
        return {"page": page_no, "bbox": used, "font_size": size, "source": src,
                "fitted": bool(fitted)}

    # ---------------------------------------------------------------- 删
    def delete_text(self, page_no: int, targets: Any, background: Any = None) -> dict[str, Any]:
        items = targets if isinstance(targets, list) else [targets]
        if not items:
            raise PdfxError("未指定要删除的文本", "bad_target")
        found = [self._find_text(page_no, t) for t in items]
        self._push_undo()
        page = self.page(page_no)
        redact_boxes = []
        drop_texts = []
        covered = 0
        for it in found:
            if it.get("source") == "ocr":
                self._cover(page, it["bbox"], background)
                covered += 1
            else:
                redact_boxes.append(it["bbox"])
                drop_texts.append(it.get("text") or "")
        if redact_boxes:
            self._redact(page, redact_boxes, drop_text=drop_texts)

        st = self._pstate(page)
        ids = {it.get("id") for it in found}
        before = len(st.get("texts", []))
        st["texts"] = [r for r in st.get("texts", []) if r["id"] not in ids]
        removed_user = before - len(st["texts"])
        self._touch()
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

        get_image_info(xrefs=True) 在扫描页上约 40ms（要解析内容流并取图像元数据），
        而它会被 list_images / _instance_near 反复调用 —— 翻页、拖图、插图的
        每一帧都摊一次。按页面修订号缓存，内容没变就直接复用。
        """
        key = ("imginst", page.number, self._rev)

        def build() -> list[dict]:
            out: list[dict] = []
            seen: set[tuple] = set()
            # 只能用 get_image_info(xrefs=True)：
            # get_images + get_image_rects 看着更快，但它按"图像资源"返回所有绘制位置 ——
            # 同一份图像字节被复用时（比如插入的图和页面原有的图恰好同源），
            # PyMuPDF 会把两个引用指向同一个 xref，于是每个 xref 都返回全部矩形，
            # 拼出来的实例列表既重复又张冠李戴（一张图被算成两处）。
            try:
                infos = page.get_image_info(xrefs=True)
            except Exception:
                infos = []
            for info in infos:
                xref = int(info.get("xref") or 0)
                bbox = _rect_list(fitz.Rect(info["bbox"]))
                k = (xref,) + tuple(round(v, 1) for v in bbox)
                if k in seen:
                    continue
                seen.add(k)
                out.append(
                    {
                        "xref": xref,
                        "bbox": bbox,
                        "pixel_width": int(info.get("width") or 0),
                        "pixel_height": int(info.get("height") or 0),
                    }
                )
            return out

        return self._cached(key, build)


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

    def image_png(self, page_no: int, target: Any, max_px: int = 2400) -> bytes:
        """取某个图片实例的像素，统一转成 PNG。

        用途是「复制图片到剪贴板」：系统剪贴板只可靠地接受 image/png，
        而 PDF 里的图可能是 JPEG / JPEG2000 / CMYK，所以这里统一转码。
        取不到 xref（内联图像）时退化为按显示区域渲染一块。
        """
        item = self._pick_image(self.list_images(page_no)["items"], target)
        page = self.page(page_no)
        xref = int(item.get("xref") or 0)
        raw: bytes | None = None
        if xref:
            try:
                raw = self.doc.extract_image(xref).get("image")
            except Exception:
                raw = None
        if raw:
            try:
                pix = fitz.Pixmap(raw)
                # CMYK / 带额外色板的图直接 tobytes("png") 会抛错，先转 RGB
                if pix.colorspace is not None and pix.colorspace.n > 3:
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                longest = max(pix.width, pix.height)
                if longest > max_px:
                    k = 1
                    while (longest >> k) > max_px:
                        k += 1
                    pix.shrink(k)
                return pix.tobytes("png")
            except Exception:
                pass
        # 内联图像（BI/ID/EI）没有独立 xref：按显示区域渲染，至少能复制走
        r = fitz.Rect(*item["bbox"])
        zoom = max(1.0, min(4.0, max_px / max(1.0, r.width)))
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=r, colorspace=fitz.csRGB, alpha=False)
        return pix.tobytes("png")

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
        self._bump()   # 内容流变了，下面按位置回查实例必须看新的
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
        self._touch()
        # 返回副本：这份记录后续会被 transform / replace 原地更新，
        # 直接把内部 dict 交出去的话，调用方拿到的"插入时 bbox"会自己变掉
        return dict(rec)

    def _redact_image_only(self, page: fitz.Page, rect: Any, xref: Any = None) -> bool:
        """把 rect 处的图像从内容流里删掉，但保留同一张图在页面上的其他落点。

        redaction 删的是"图像资源"，不是"某一次摆放"。同一张图（相同 xref）
        在页面上摆了两个位置时，删一处会把两处一起抹掉 —— 用户把同一张图插
        两次、删掉其中一个，另一个会凭空消失。所以先把其他落点记下来，
        删完按原 bbox 补画回去。返回 False 表示 redaction 没成功，调用方应退回涂色。
        """
        target = _rect_list(fitz.Rect(*rect))
        siblings: list[list[float]] = []
        data = None
        if xref:
            try:
                siblings = [
                    i["bbox"]
                    for i in self._image_instances(page)
                    if i["xref"] == int(xref) and iou(i["bbox"], target) < 0.3
                ]
            except Exception:
                siblings = []
            if siblings:
                try:
                    data = self.doc.extract_image(int(xref))["image"]
                except Exception:
                    data = None
                if not data:
                    siblings = []
        try:
            page.add_redact_annot(fitz.Rect(*target))
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_REMOVE,
                text=fitz.PDF_REDACT_TEXT_NONE,
                graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            )
        except Exception:
            return False
        restored: list[tuple[list[float], int]] = []
        for b in siblings:
            try:
                nx = page.insert_image(fitz.Rect(*b), stream=data, keep_proportion=False, overlay=True)
                restored.append((b, int(nx)))
            except Exception:
                pass
        # 补画出来的实例换了新 xref，state 里的记录要跟着改 ——
        # 否则下次按 xref 判断"还有没有别的落点"会落空。
        if restored:
            st = self._pstate(page)
            for b, nx in restored:
                for rec in st.get("images", []):
                    if iou(rec["bbox"], b) > 0.6:
                        rec["bbox"] = _rect_list(fitz.Rect(*b))
                        rec["xref"] = nx
        return True

    def replace_image(self, page_no: int, target: Any, src: Any, keep_ratio: bool = True) -> dict[str, Any]:
        items = self.list_images(page_no)["items"]
        item = self._pick_image(items, target)
        data = self._read_binary(src)
        page = self.page(page_no)
        self._push_undo()

        # 和删除 / 移动一样：redaction 真删旧图，别涂色块盖住。
        # 涂色的后果是旧图仍在内容流里，之后任何"按位置找实例"的操作都可能抓到它，
        # 记录里的 bbox 就会被写成旧图的位置。
        old = _rect_list(fitz.Rect(*item["bbox"]))
        if not self._redact_image_only(page, old, item.get("xref")):
            self._cover(page, old, color=self._paper_color(page))
            if item["source"] == "user":
                self._suppress(page, old)  # 用户图重绘在别处时，旧实例也要从列表里退场
        self._bump()
        r = fitz.Rect(*old)
        try:
            xref = page.insert_image(r, stream=data, keep_proportion=bool(keep_ratio), overlay=True)
        except Exception as exc:
            raise PdfxError(f"替换图片失败: {exc}", "image_insert_failed")
        self._bump()
        st = self._pstate(page)
        taken = [rec["bbox"] for rec in st.get("images", []) if rec["id"] != item["id"]]
        bbox = self._instance_near(page, r, taken=taken)

        for rec in st.get("images", []):
            if rec["id"] == item["id"]:
                rec.update({"bbox": bbox, "xref": xref})
                break
        if st.get("strokes"):
            self._rebuild_inks(page, st["strokes"])
        self._touch()
        return {"page": page_no, "id": item["id"], "bbox": bbox, "old_source": item["source"]}

    def delete_image(self, page_no: int, target: Any, mode: str = "purge") -> dict[str, Any]:
        """删掉一张图。

        默认 purge：用 redaction 把这块区域的图像从内容流里真正移除 ——
        不留下任何"被白块盖着的原图"。这一点很关键：以前默认涂一块纸色，
        图还在下面，之后往同一位置插新图时，`get_image_info` 依然能列出那张
        旧图，按位置匹配就会把新记录的 bbox 写成旧图的位置，界面上表现为
        "删掉图片以后再也插不进来 / 插了看不见"。真删之后这条路就干净了。
        """
        items = self.list_images(page_no)["items"]
        item = self._pick_image(items, target)
        page = self.page(page_no)
        self._push_undo()
        rect = _rect_list(fitz.Rect(*item["bbox"]))
        done = "purged"
        if mode != "cover":
            if not self._redact_image_only(page, rect, item.get("xref")):
                self._cover(page, rect, color=self._paper_color(page))
                done = "cover"
        else:
            # 显式要求"只盖掉"时才走涂色（比如用户想保留底层内容做底稿）
            self._cover(page, rect, color=self._paper_color(page))
            done = "cover"
        self._bump()   # 内容流已改，后面的读取不能再用写之前的实例列表

        st = self._pstate(page)
        st["images"] = [r for r in st.get("images", []) if r["id"] != item["id"]]
        # 同一位置的历史"已遮住"记录一并清掉，否则日后往这儿插新图会被它判成隐藏
        keep_hidden = []
        for h in st.get("hidden_images", []):
            hb = h.get("bbox") or []
            if len(hb) == 4 and iou(hb, rect) > 0.6:
                continue
            keep_hidden.append(h)
        if keep_hidden:
            st["hidden_images"] = keep_hidden
        else:
            st.pop("hidden_images", None)
        if done == "cover":
            # 只是视觉覆盖，记下来避免它继续出现在对象列表里
            self._suppress(page, rect)
        # redaction 会连带吃掉区域内的 ink 注释，已提交的笔迹按状态重建
        if st.get("strokes"):
            self._rebuild_inks(page, st["strokes"])
        self._touch()
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
        old_rect = fitz.Rect(*old)
        # 整页的底图（扫描页那张大图）不是"可移动的元素"，误删等于把整页擦掉
        if old_rect.get_area() > page.rect.get_area() * 0.6:
            raise PdfxError(
                "这看起来是整页的底图（扫描页那张大图），不能整体移动",
                "image_is_background",
            )
        # 把原图从这一页真正删掉，而不是涂一块色块盖住：
        # 底下被它遮住的文字会自然露出来，也不会留下白斑。
        # 用 redaction 删掉这块区域里的图像，文字与矢量线条原样保留。
        # 不要靠"xref 是否唯一"来决定要不要删：同样字节的图会被 PyMuPDF 复用成
        # 同一个 xref，replace_image 之后同一位置甚至叠着两个实例，判断必然失手，
        # 结果退回涂色又被上层实例盖住 → 原位残留一个一模一样的残影。
        if not self._redact_image_only(page, old, item.get("xref")):
            # redaction 失败就退化为用页面纸张底色盖住（至少不会两个影子）
            self._cover(page, old, color=self._paper_color(page))
            self._suppress(page, old)
        r = fitz.Rect(*norm_rect(rect))
        xref = page.insert_image(r, stream=data, keep_proportion=bool(keep_ratio), overlay=True)
        # 不能拿 get_image_info 回查实际 bbox：这一页的内容流刚被 redaction 重写过，
        # PyMuPDF 那边返回的可能还是改动前的快照（新图压根不在列表里），
        # 于是会把旧位置的 bbox 写回记录，界面上就出现"图挪了、框还留在原地"。
        # 按 insert_image 的居中适配规则自己算，稳定且没有往返。
        iw = int(item.get("pixel_width") or 0)
        ih = int(item.get("pixel_height") or 0)
        if not iw or not ih:
            try:
                pm = fitz.Pixmap(data)
                iw, ih = pm.width, pm.height
            except Exception:
                iw = ih = 0
        if keep_ratio and iw > 0 and ih > 0 and r.width > 0 and r.height > 0:
            ar = iw / ih
            w, h = r.width, r.height
            if w / h > ar:
                w = h * ar
            else:
                h = w / ar
            dx, dy = (r.width - w) / 2, (r.height - h) / 2
            bbox = _rect_list(fitz.Rect(r.x0 + dx, r.y0 + dy, r.x0 + dx + w, r.y0 + dy + h))
        else:
            bbox = _rect_list(r)
        st = self._pstate(page)
        for rec in st.get("images", []):
            if rec["id"] == item["id"]:
                rec.update({"bbox": bbox, "xref": xref})
                break
        self._touch()
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
                # 必须是"数值对"而不是 Point 对象：add_ink_annot 只认
                # seq of seq of float pairs，传 Point 会抛 ValueError 然后
                # 悄悄退化成本页矢量线条 —— 矢量画上去就删不掉了，
                # 撤销时会发现笔迹纹丝不动、重建一次还叠一层。
                path = [[float(p[0]), float(p[1])] for p in pts]
                annot = page.add_ink_annot([path])
                annot.set_colors(stroke=color)
                annot.set_border(width=max(0.3, width))
                annot.set_opacity(float(s.get("opacity", 1.0)))
                annot.set_info(title=f"{INK_PREFIX}:{s['id']}", content=s["id"])
                annot.update()
            except Exception:
                # 注释失败则退化为矢量绘制（此时撤销无法还原这几笔，但至少画得出来）
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
        page = self.page(page_no)
        st = self._pstate(page)
        # 笔迹撤销不拍整份 PDF 快照：扫描件动辄几十 MB，序列化一次就是几百毫秒，
        # 落在"每写一笔"上就是肉眼可见的卡。只记改动前的笔迹数组，撤销时重建。
        self._push_undo(("ink", page.xref, copy.deepcopy(st.get("strokes", []))))
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
        self._touch()
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

        self._push_undo(("ink", page.xref, copy.deepcopy(strokes)))
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
        self._touch()
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
        self._touch()
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
        self._touch()
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
            self._touch()
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
                lines = self._page_lines(pno, force_ocr=force_ocr, dpi=dpi, auto_ocr=True)
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
                lines = self._page_lines(pno, force_ocr=force_ocr, dpi=dpi, auto_ocr=True)
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
