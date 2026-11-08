"""PDFDocument —— 统一处理"结构化 PDF"与"扫描件 PDF"的编辑核心。

坐标约定
--------
- 全部使用 PDF 点（1pt = 1/72 inch），原点页面左上角，x 向右、y 向下。
- 前端/外部系统只需按这个约定换算，不需要关心 PyMuPDF 的内部细节。

对象身份（id）
--------------
- 文本层对象:  p{页}:t{x},{y}    —— 由左上角坐标定位，跨会话稳定
- OCR 对象:    p{页}:o{x},{y}
- 用户文本:    p{页}:ut{短哈希}   —— 记录在状态里，可精确编辑
- 原生图片:    p{页}:i{xref}
- 用户图片:    p{页}:ui{短哈希}
- 笔迹:        p{页}:k{短哈希}

状态（用户插入的文本/图片/笔迹元数据）内嵌在 PDF 的自定义键 PDFXState 中，
所以文件移动、改名都不会丢；也可通过 export_state 导出为旁挂 JSON。
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import pymupdf as fitz

from .ocr import OcrCache, OcrEngine, OcrLine
from .ops import ImageMixin, InkMixin, SearchMixin, TextMixin
from .util import (
    PDFX_HOME,
    PdfxError,
    clean_text,
    has_cjk,
    hex_to_rgb,
    ink_color_for,
    iou,
    norm_rect,
    normalize_text,
    parse_page_selector,
    rect_area,
    rect_intersect,
    resolve_size,
    rgb_to_hex,
)

STATE_KEY = "PDFXState"
INK_PREFIX = "pdfx-ink"
OCR_DPI = 200
UNDO_DEPTH = 8
# 位图 / 对象列表的缓存条数。一张 96dpi 的 A4 位图约 89KB，
# 48 张约 4MB，换来的是「同一页同一缩放不重复渲染」。
RENDER_CACHE = 48


# --------------------------------------------------------------------------- 小工具

def _rect_list(r) -> list[float]:
    return [round(float(r.x0), 2), round(float(r.y0), 2), round(float(r.x1), 2), round(float(r.y1), 2)]


class PDFDocument(TextMixin, ImageMixin, InkMixin, SearchMixin):
    # ================================================================== 生命周期
    def __init__(
        self,
        path: str | os.PathLike | None = None,
        password: str | None = None,
        ocr_backend: str = "auto",
        cache_dir: str | os.PathLike | None = None,
    ) -> None:
        self.path: Path | None = Path(path).expanduser().resolve() if path else None
        self.state: dict[str, Any] = {"version": 1, "pages": {}}
        self._undo: list[tuple] = []
        self._dirty = False
        # 内容修订号：任何写操作都 +1，缓存键带上它，写入即自然失效。
        # 没有这个的话只能靠"改完手动清缓存"，漏一处就会读到旧位图/旧对象列表。
        self._rev = 1
        # 每份文档一把锁。渲染是 CPU 密集的，不能因为别的文档在渲染就把
        # 这份文档的接口全堵住（原来是全站一把锁，多文档同时用会互相等待）。
        self.lock = threading.RLock()
        self._cache: "OrderedDict[tuple, Any]" = OrderedDict()
        self._cache_cap = RENDER_CACHE

        if self.path:
            if not self.path.exists():
                raise PdfxError(f"文件不存在: {self.path}", "not_found")
            try:
                self.doc = fitz.open(str(self.path))
            except Exception as exc:
                raise PdfxError(f"无法打开 PDF: {exc}", "open_failed")
            if self.doc.needs_pass:
                if not password or not self.doc.authenticate(password):
                    raise PdfxError("PDF 已加密，需要正确密码", "password_required")
            if not self.doc.is_pdf:
                raise PdfxError("仅支持 PDF 格式", "unsupported_format")
            self._load_state()
        else:
            self.doc = fitz.open()

        self._ocr_engine = OcrEngine.get(ocr_backend)
        self._ocr_cache = OcrCache(Path(cache_dir) if cache_dir else PDFX_HOME / "ocr")

    def close(self) -> None:
        try:
            self.doc.close()
        except Exception:
            pass
        self._cache.clear()

    # ------------------------------------------------------------------ 缓存
    def _bump(self) -> None:
        """内容变了：修订号 +1 并丢掉所有派生缓存。"""
        self._rev += 1
        self._cache.clear()

    def _touch(self) -> None:
        """写操作收尾：标记未保存 + 让所有派生缓存失效。

        必须放在"写完"之后而不是之前 —— 写的过程中还会读同一页的图片实例、
        页面类型等（比如删图要按 bbox 定位），提前清缓存会让这些读取
        重新计算一遍旧内容，既慢又容易把过期结果存回缓存。
        """
        self._dirty = True
        self._bump()

    @property
    def rev(self) -> int:
        return self._rev

    def _cached(self, key: tuple, build: Callable[[], Any]) -> Any:
        """按修订号缓存的派生结果（位图、缩略图、图片实例列表）。

        这些都是"算一次几十毫秒"的东西，而界面会在翻页、拖动出图、
        缩略图刷新时反复要同一份 —— 不缓存的话每次都要重新渲染一遍。
        """
        hit = self._cache.get(key)
        if hit is not None:
            self._cache.move_to_end(key)
            return hit
        val = build()
        self._cache[key] = val
        while len(self._cache) > self._cache_cap:
            self._cache.popitem(last=False)
        return val

    def __enter__(self) -> "PDFDocument":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ------------------------------------------------------------------ 状态
    def _load_state(self) -> None:
        self.state = {"version": 1, "pages": {}}
        try:
            kind, val = self.doc.xref_get_key(self.doc.pdf_catalog(), STATE_KEY)
            if kind == "xref" and val:
                xref = int(val.split()[0])
                raw = self.doc.xref_stream(xref)
                if raw:
                    data = json.loads(raw.decode("utf-8"))
                    if isinstance(data, dict) and "pages" in data:
                        self.state = data
        except Exception:
            pass

    def _persist_state(self) -> None:
        payload = json.dumps(self.state, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        try:
            cat = self.doc.pdf_catalog()
            kind, val = self.doc.xref_get_key(cat, STATE_KEY)
            if kind == "xref" and val:
                xref = int(val.split()[0])
                self.doc.update_stream(xref, payload)
            else:
                xref = self.doc.get_new_xref()
                self.doc.update_object(xref, "<<>>")
                self.doc.update_stream(xref, payload)
                self.doc.xref_set_key(cat, STATE_KEY, f"{xref} 0 R")
        except Exception as exc:
            raise PdfxError(f"写入文档状态失败: {exc}", "state_write_failed")

    def export_state(self) -> dict[str, Any]:
        return copy.deepcopy(self.state)

    # ------------------------------------------------------------------ 撤销
    def _push_undo(self, light: tuple | None = None) -> None:
        """记录一次可撤销的操作。

        默认整份 PDF 序列化一份（tobytes）当快照 —— 4.5MB 的扫描件要 20ms，
        50MB 的要几百毫秒，落在「每画一笔」上就是明显的卡顿。
        所以笔迹类操作走 light：只记页面 xref + 改动前的笔迹数组，
        撤销时重放 _rebuild_inks，成本只和笔迹数有关，与文档体积无关。
        """
        self._bump()
        if light is not None:
            if len(self._undo) >= UNDO_DEPTH:
                self._undo.pop(0)
            self._undo.append(light)
            return
        try:
            raw = self.doc.tobytes(garbage=0, deflate=False)
        except Exception:
            # 空文档（0 页）没法序列化 —— 没有可回退的内容，直接不记
            return
        if len(self._undo) >= UNDO_DEPTH:
            self._undo.pop(0)
        self._undo.append(("snapshot", raw, copy.deepcopy(self.state)))

    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    def undo(self) -> bool:
        if not self._undo:
            return False
        entry = self._undo.pop()
        if entry[0] == "snapshot":
            _, raw, state = entry
            try:
                self.doc.close()
            except Exception:
                pass
            self.doc = fitz.open("pdf", raw)
            self.state = state
        else:
            # ("ink", page_xref, 改动前的笔迹列表)
            _, pxref, prev = entry
            page = None
            for i in range(self.doc.page_count):
                if self.doc[i].xref == pxref:
                    page = self.doc[i]
                    break
            if page is None:
                return False
            st = self._pstate(page)
            st["strokes"] = copy.deepcopy(prev)
            try:
                self._rebuild_inks(page, st["strokes"])
            except Exception:
                pass
        self._touch()
        self._bump()
        return True


    # ------------------------------------------------------------------ 页级状态
    def _pstate(self, page) -> dict[str, Any]:
        key = str(page.xref)
        pages = self.state.setdefault("pages", {})
        return pages.setdefault(key, {"texts": [], "images": [], "strokes": [], "covers": []})

    def _pstate_by_index(self, page_no: int) -> dict[str, Any]:
        return self._pstate(self.doc[page_no])

    # ================================================================== 文档信息
    @property
    def page_count(self) -> int:
        return self.doc.page_count

    def page(self, page_no: int) -> fitz.Page:
        try:
            count = self.doc.page_count
        except ValueError:  # fitz 的 document closed
            raise PdfxError("文档已关闭，请重新打开", "document_closed")
        if not 0 <= page_no < count:
            raise PdfxError(f"页码越界: {page_no}（共 {count} 页）", "page_out_of_range")
        return self.doc[page_no]

    def page_size(self, page_no: int) -> tuple[float, float]:
        r = self.page(page_no).rect
        return (round(r.width, 2), round(r.height, 2))

    def page_type(self, page_no: int) -> str:
        """text / scanned / mixed / empty

        以"位图覆盖率"为主判据：整页被一张图占满 = 扫描页，
        即使之后插入了文本（有了零星文本层），仍然是 scanned/mixed，
        检索时依然会走 OCR，不会丢掉原图里的内容。
        """
        p = self.page(page_no)
        try:
            txt = p.get_text("text")
        except Exception:
            txt = ""
        chars = len(re.sub(r"\s", "", txt))
        cov = self._image_coverage(p)
        has_img = bool(p.get_images(full=True))
        if cov >= 0.5:
            return "scanned" if chars < 20 else "mixed"
        if chars >= 20:
            return "text"
        if has_img:
            return "mixed" if chars >= 5 else "scanned"
        return "text" if chars else "empty"

    def info(self, with_types: bool = False) -> dict[str, Any]:
        """文档概览。

        默认不逐页判断类型：page_type 要读整页内容流（扫描件上单页 40ms），
        100 页的文档就是 4 秒的开屏等待。前端只需要尺寸，类型在翻到那一页时
        由 /api/page/<n>/objects 顺带给出。
        """
        meta = self.doc.metadata or {}
        pages = []
        for i in range(self.doc.page_count):
            entry: dict[str, Any] = {"index": i, "size": list(self.page_size(i))}
            if with_types:
                entry["type"] = self.page_type(i)
            pages.append(entry)
        return {
            "path": str(self.path) if self.path else None,
            "page_count": self.doc.page_count,
            "pages": pages,
            "metadata": {k: v for k, v in meta.items() if v},
            "encrypted": bool(self.doc.needs_pass),
            "modified": self._dirty,
            "can_undo": self.can_undo,
            "ocr": self._ocr_engine.info(),
        }


    def describe(self) -> dict[str, Any]:
        """给 AI 用的"可操作对象清单"：一页一页列出文本/图片/笔迹数量与页面类型。"""
        out = []
        for i in range(self.doc.page_count):
            st = self._pstate_by_index(i)
            ptype = self.page_type(i)
            entry: dict[str, Any] = {
                "index": i,
                "size": list(self.page_size(i)),
                "type": ptype,
                "user_texts": len(st.get("texts", [])),
                "user_images": len(st.get("images", [])),
                "strokes": len(st.get("strokes", [])),
                "native_images": len(self.page(i).get_images(full=True)),
            }
            if ptype in ("text", "mixed"):
                entry["native_text_lines"] = len(self._native_lines(i))
            out.append(entry)
        return {
            "path": str(self.path) if self.path else None,
            "page_count": self.doc.page_count,
            "pages": out,
            "ocr": self._ocr_engine.info(),
            "coordinate_system": "PDF points, origin top-left, x right, y down",
        }

    # ================================================================== 渲染
    def render(self, page_no: int, dpi: int = 110, clip: Sequence[float] | None = None, fmt: str = "png") -> bytes:
        fmt = fmt if fmt in ("png", "jpg", "jpeg", "pnm", "pgm", "ppm") else "png"
        ck = None if clip is None else tuple(round(float(v), 2) for v in norm_rect(clip))
        key = ("render", page_no, int(dpi), ck, fmt, self._rev)

        def build() -> bytes:
            p = self.page(page_no)
            kw: dict[str, Any] = {"dpi": int(dpi), "colorspace": fitz.csRGB, "alpha": False}
            if ck:
                kw["clip"] = fitz.Rect(*ck) & p.rect
            pix = p.get_pixmap(**kw)
            return pix.tobytes(fmt)

        return self._cached(key, build)

    def thumbnail(self, page_no: int, width: int = 150) -> bytes:
        key = ("thumb", page_no, int(width), self._rev)

        def build() -> bytes:
            p = self.page(page_no)
            zoom = max(0.05, float(width) / max(1.0, p.rect.width))
            pix = p.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csRGB, alpha=False)
            return pix.tobytes("png")

        return self._cached(key, build)


    # ================================================================== 页面操作
    def add_page(self, size: Any = "a4", position: int | None = None, width: float | None = None,
                 height: float | None = None, background: str | None = None) -> int:
        self._push_undo()
        if width and height:
            w, h = float(width), float(height)
        else:
            w, h = resolve_size(size)
        idx = self.doc.page_count if position is None else max(0, min(int(position), self.doc.page_count))
        p = self.doc.new_page(pno=idx, width=w, height=h)
        if background:
            p.draw_rect(p.rect, color=None, fill=hex_to_rgb(background), overlay=False)
        self._touch()
        return idx

    def delete_pages(self, pages: Any) -> list[int]:
        targets = parse_page_selector(pages, self.doc.page_count)
        if len(targets) >= self.doc.page_count:
            raise PdfxError("不能删除全部页面", "would_empty_document")
        self._push_undo()
        for i in sorted(targets, reverse=True):
            self.doc.delete_page(i)
        self._touch()
        return targets

    def move_page(self, source: int, target: int) -> int:
        n = self.doc.page_count
        if not (0 <= source < n and 0 <= target < n):
            raise PdfxError("页码越界", "page_out_of_range")
        self._push_undo()
        self.doc.move_page(source, target)
        self._touch()
        return target

    def rotate_page(self, pages: Any, degrees: int) -> list[int]:
        targets = parse_page_selector(pages, self.doc.page_count)
        deg = int(degrees) % 360
        if deg not in (0, 90, 180, 270):
            raise PdfxError("旋转角度必须是 90 的倍数", "bad_rotation")
        self._push_undo()
        for i in targets:
            p = self.doc[i]
            p.set_rotation((p.rotation + deg) % 360)
        self._touch()
        return targets

    def duplicate_page(self, page_no: int, position: int | None = None) -> int:
        self._push_undo()
        idx = self.doc.page_count if position is None else int(position)
        self.doc.fullcopy_page(page_no, idx)
        self._touch()
        return idx

    def import_pdf(self, src: str | os.PathLike, pages: Any = None, position: int | None = None) -> list[int]:
        sp = Path(src).expanduser()
        if not sp.exists():
            raise PdfxError(f"源文件不存在: {sp}", "not_found")
        self._push_undo()
        other = fitz.open(str(sp))
        idxs: list[int] = []
        try:
            idxs = parse_page_selector(pages, other.page_count)
            if not idxs:
                raise PdfxError("没有可导入的页面", "bad_page_selector")
            at = self.doc.page_count if position is None else max(0, min(int(position), self.doc.page_count))
            # 逐页插入，兼容 "0,2" 这类不连续选择
            for k, i in enumerate(idxs):
                self.doc.insert_pdf(other, from_page=i, to_page=i, start_at=at + k)
        finally:
            other.close()
        self._touch()
        return list(range(at, at + len(idxs)))

    # ================================================================== 保存
    def save(self, path: str | os.PathLike | None = None, incremental: bool = False,
             clean: bool = False, flatten_inks: bool = False, as_current: bool = False) -> str:
        target = Path(path).expanduser().resolve() if path else self.path
        if target is None:
            raise PdfxError("未指定保存路径", "no_path")
        if flatten_inks:
            self._flatten_inks_all()
        self._persist_state()

        same = self.path is not None and target == self.path
        try:
            if incremental and same:
                self.doc.saveIncr()
            elif same:
                tmp = target.with_suffix(target.suffix + ".pdfx.tmp")
                self.doc.save(str(tmp), garbage=3 if clean else 1, deflate=True, clean=clean)
                self.doc.close()
                try:
                    os.replace(str(tmp), str(target))
                except Exception as exc:
                    # 替换失败（文件被别的程序占用等）：先把内存里的文档救回来，
                    # 否则会话会留下一个"已关闭"的文档对象
                    self.doc = fitz.open(str(tmp))
                    raise PdfxError(f"无法覆盖原文件（可能被其他程序占用）：{target}", "file_locked") from exc
                self.doc = fitz.open(str(target))
                self._load_state()
            else:
                self.doc.save(str(target), garbage=3 if clean else 1, deflate=True, clean=clean)
                if as_current:
                    self.path = target
        except PdfxError:
            raise
        except Exception as exc:
            raise PdfxError(f"保存失败: {exc}", "save_failed")
        self._dirty = False
        return str(target)
