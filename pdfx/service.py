"""本地 HTTP 服务：把 PDFDocument 的能力暴露成 REST 接口。

- 前端编辑器（web/）通过它工作
- 外部 AI / 脚本也可以直接调用，无需 Python 环境

接口约定
--------
所有响应统一为：
    成功 {"ok": true,  "data": ...}
    失败 {"ok": false, "error": {"code": "...", "message": "..."}}
写操作默认立即写入服务端内存文档，落盘需要显式调用 POST /api/save。
"""

from __future__ import annotations

import base64
import io
import json
import mimetypes
import os
import re
import tempfile
import threading
import traceback
from pathlib import Path
from typing import Any

from flask import Flask, Blueprint, jsonify, request, send_file, send_from_directory

from .doc import PDFDocument
from .util import PdfxError, fail, ok, __version__ as PDFX_VERSION

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
UPLOAD_DIR = Path(tempfile.gettempdir()) / "pdfx_uploads"


class Session:
    """进程内文档会话。单用户本地工具，够用且简单。"""

    def __init__(self) -> None:
        self.docs: dict[str, PDFDocument] = {}
        self.current: str | None = None
        self._seq = 1
        self.lock = threading.RLock()
        # 进程唯一标识：位图 URL 里带上它，进程重启后浏览器不会拿上一次的缓存图。
        self.sid = os.urandom(4).hex()

    def add(self, doc: PDFDocument, name: str | None = None) -> str:
        # 同一路径只留一个实例：两个句柄同时开着，Windows 上 os.replace 会失败，
        # 保存就会报"文件被占用"。重开同一文件时顺手把旧的关掉。
        if doc.path is not None:
            for k, old in list(self.docs.items()):
                if old is doc:
                    continue
                try:
                    same = old.path is not None and Path(old.path) == Path(doc.path)
                except Exception:
                    same = False
                if same:
                    try:
                        old.close()
                    except Exception:
                        pass
                    self.docs.pop(k, None)
        did = f"d{self._seq}"
        self._seq += 1
        self.docs[did] = doc
        self.current = did
        return did

    def get(self, did: str | None = None) -> PDFDocument:
        key = did or self.current
        if not key or key not in self.docs:
            raise PdfxError("没有打开的文档", "no_document")
        return self.docs[key]

    def activate(self, did: str) -> str:
        if did not in self.docs:
            raise PdfxError(f"文档不存在: {did}", "no_document")
        self.current = did
        return did

    def list_docs(self) -> list[dict[str, Any]]:
        """会话内所有文档，按打开顺序。前端左侧"文档栏"用。"""
        out: list[dict[str, Any]] = []
        for did, d in self.docs.items():
            try:
                path = str(d.path) if d.path else None
                out.append(
                    {
                        "doc_id": did,
                        "name": Path(path).name if path else f"未命名-{did}",
                        "path": path,
                        "page_count": d.page_count,
                        "modified": bool(getattr(d, "_dirty", True)),
                        "encrypted": bool(getattr(d, "encrypted", False)),
                        "current": did == self.current,
                    }
                )
            except Exception:
                continue
        return out

    def close(self, did: str | None = None) -> str | None:
        key = did or self.current
        doc = self.docs.pop(key, None) if key else None
        if doc is not None:
            try:
                doc.close()
            except Exception:
                pass
        if self.current == key:
            self.current = next(iter(self.docs), None)
        return key


SESSION = Session()


def _body() -> dict[str, Any]:
    if request.is_json:
        return request.get_json(silent=True) or {}
    return {k: v for k, v in request.form.items()}


def _wrap(fn):
    def inner(*args, **kwargs):
        try:
            with SESSION.lock:
                data = fn(*args, **kwargs)
            if isinstance(data, tuple):
                return jsonify(data[0]), data[1]
            payload = ok(data)
            # 顺手把当前文档的修订号回给前端：位图 URL 用它做缓存键，
            # 内容一变 URL 就变，既能放心让浏览器缓存，又不会拿到旧图。
            cur = SESSION.docs.get(SESSION.current) if SESSION.current else None
            if cur is not None and isinstance(payload.get("data"), dict):
                payload["data"].setdefault("rev", cur.rev)
                payload["data"].setdefault("sid", SESSION.sid)
            return jsonify(payload)
        except PdfxError as exc:
            return jsonify(fail(exc)), 400
        except Exception as exc:  # pragma: no cover
            traceback.print_exc()
            return jsonify(fail(exc)), 500

    inner.__name__ = fn.__name__
    return inner


def create_app(initial: str | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config["JSON_AS_ASCII"] = False
    app.json.ensure_ascii = False

    @app.after_request
    def _no_api_cache(resp):
        """页面位图允许浏览器缓存，其余 JSON 接口一律不缓存。

        位图 URL 里带了 doc / sid / rev（修订号），内容一变 URL 就变，
        所以长期缓存是安全的 —— 这一点直接决定了缩放、翻回上一页的体感：
        以前每张图都是 no-store，放大一次就要把所有页重新渲染 + 重新传输。
        """
        p = request.path
        if p.startswith("/api/page/") and p.endswith(".png"):
            resp.headers["Cache-Control"] = "private, max-age=86400"
            return resp
        if p.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store, max-age=0"
        return resp

    # ------------------------------------------------------------------ 页面
    @app.get("/")
    def index():
        return send_from_directory(WEB_DIR, "index.html")

    @app.get("/static/<path:fname>")
    def static_file(fname: str):
        return send_from_directory(WEB_DIR, fname)

    # ------------------------------------------------------------------ 文档
    @app.post("/api/open")
    @_wrap
    def api_open():
        b = _body()
        path = b.get("path")
        if not path:
            raise PdfxError("缺少 path", "bad_request")
        p = Path(str(path)).expanduser()
        if not p.exists():
            raise PdfxError(f"文件不存在: {p}", "not_found")
        doc = PDFDocument(p, password=b.get("password"))
        did = SESSION.add(doc)
        return {"doc_id": did, **doc.info()}

    @app.post("/api/new")
    @_wrap
    def api_new():
        b = _body()
        doc = PDFDocument()
        pages = max(1, int(b.get("pages") or 1))
        size = b.get("size") or "a4"
        doc.add_page(size)
        for _ in range(pages - 1):
            doc.add_page(size)
        did = SESSION.add(doc)
        # 新建文档没有落地路径：显式回 null，避免前端沿用上一个文档的 path
        return {"doc_id": did, "path": None, **doc.info()}

    @app.post("/api/upload")
    @_wrap
    def api_upload():
        f = request.files.get("file")
        if not f:
            raise PdfxError("缺少文件", "bad_request")
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        safe = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "_", f.filename or "upload.pdf")
        target = UPLOAD_DIR / safe
        f.save(str(target))
        doc = PDFDocument(target)
        did = SESSION.add(doc)
        return {"doc_id": did, "path": str(target), **doc.info()}

    @app.get("/api/caps")
    @_wrap
    def api_caps():
        """能力清单：前端用它判断"服务端是不是旧进程"。

        前端是静态文件，刷新就拿到新版；后端不会。如果 8765 上还挂着旧进程，
        新前端调用新参数会静默失效，用户只会觉得"改了没用"。所以显式握手。
        """
        return {
            "version": PDFX_VERSION,
            "sid": SESSION.sid,
            "caps": [
                "docs", "doc.activate", "page.import",
                "text.transform", "image.transform",
                "ink.local_erase", "canvas.layered", "erase.content",
                "ocr.optional", "bitmap.cached",
            ],
        }

    @app.get("/api/doc")
    @_wrap
    def api_doc():
        did = request.args.get("doc") or SESSION.current
        doc = SESSION.get(did)
        return {"doc_id": did, **doc.describe()}

    @app.get("/api/docs")
    @_wrap
    def api_docs():
        return {"docs": SESSION.list_docs(), "current": SESSION.current}

    @app.post("/api/doc/activate")
    @_wrap
    def api_doc_activate():
        did = SESSION.activate(str(_body().get("doc") or ""))
        return {"doc_id": did, **SESSION.get(did).describe()}

    @app.post("/api/save")
    @_wrap
    def api_save():
        doc = SESSION.get(_body().get("doc"))
        b = _body()
        target = doc.save(
            b.get("path") or None,
            incremental=bool(b.get("incremental", False)),
            clean=bool(b.get("clean", False)),
            flatten_inks=bool(b.get("flatten_inks", False)),
            as_current=bool(b.get("as_current", False)),
        )
        return {"path": target, "size": os.path.getsize(target)}

    @app.post("/api/undo")
    @_wrap
    def api_undo():
        doc = SESSION.get(_body().get("doc"))
        return {"undone": doc.undo(), **doc.describe()}

    @app.post("/api/close")
    @_wrap
    def api_close():
        did = _body().get("doc") or SESSION.current
        closed = SESSION.close(did)
        return {"closed": closed, "current": SESSION.current, "docs": SESSION.list_docs()}

    # ------------------------------------------------------------------ 页面
    @app.get("/api/page/<int:pno>.png")
    def api_page_png(pno: int):
        try:
            with SESSION.lock:
                doc = SESSION.get(request.args.get("doc"))
                dpi = float(request.args.get("dpi", 110))
                clip = request.args.get("clip")
                clip_r = [float(v) for v in clip.split(",")] if clip else None
                data = doc.render(pno, dpi=dpi, clip=clip_r)
            return send_file(io.BytesIO(data), mimetype="image/png")
        except PdfxError as exc:
            return jsonify(fail(exc)), 400

    @app.get("/api/page/<int:pno>/thumb.png")
    def api_page_thumb(pno: int):
        try:
            with SESSION.lock:
                doc = SESSION.get(request.args.get("doc"))
                data = doc.thumbnail(pno, int(request.args.get("w", 150)))
            return send_file(io.BytesIO(data), mimetype="image/png")
        except PdfxError as exc:
            return jsonify(fail(exc)), 400

    @app.get("/api/page/<int:pno>/objects")
    @_wrap
    def api_objects(pno: int):
        doc = SESSION.get(request.args.get("doc"))
        force = request.args.get("ocr") in ("1", "true", "yes")
        return {
            "page": pno,
            "type": doc.page_type(pno),
            "size": list(doc.page_size(pno)),
            "texts": doc.list_text(pno, force_ocr=force),
            "images": doc.list_images(pno),
            "strokes": doc.list_strokes(pno),
        }

    @app.post("/api/page/import")
    @_wrap
    def api_page_import():
        """把另一份 PDF 的页面插入当前文档。

        body: {path} 或 {data_url}（二选一），pages（"all" / "0-2" / "1,3"），at（插入位置）
        """
        b = _body()
        doc = SESSION.get(b.get("doc"))
        src = b.get("path")
        tmp_file: Path | None = None
        if b.get("data_url"):
            raw = str(b["data_url"]).split(",", 1)[-1]
            try:
                data = base64.b64decode(raw)
            except Exception:
                raise PdfxError("上传的 PDF 数据无法解码", "bad_request")
            if not data.startswith(b"%PDF"):
                raise PdfxError("这不是一份 PDF 文件", "bad_pdf")
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            tmp_file = UPLOAD_DIR / f"import_{os.urandom(4).hex()}.pdf"
            tmp_file.write_bytes(data)
            src = str(tmp_file)
        if not src:
            raise PdfxError("请选择要插入的 PDF", "bad_request")

        at = b.get("at")
        idxs = doc.import_pdf(
            src,
            pages=(b.get("pages") or "all"),
            position=(int(at) if at is not None else None),
        )
        return {"imported": idxs, "imported_count": len(idxs), **doc.describe()}

    @app.post("/api/page")
    @_wrap
    def api_page_add():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        idx = doc.add_page(b.get("size") or "a4", position=b.get("at"), background=b.get("background"))
        return {"index": idx, **doc.describe()}

    @app.delete("/api/page")
    @_wrap
    def api_page_delete():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        removed = doc.delete_pages(b.get("pages"))
        return {"removed": removed, **doc.describe()}

    @app.post("/api/page/move")
    @_wrap
    def api_page_move():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        doc.move_page(int(b["from"]), int(b["to"]))
        return doc.describe()

    @app.post("/api/page/rotate")
    @_wrap
    def api_page_rotate():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        doc.rotate_page(b.get("pages"), int(b.get("degrees", 90)))
        return doc.describe()

    # ------------------------------------------------------------------ 文本
    @app.get("/api/text")
    @_wrap
    def api_text_list():
        doc = SESSION.get(request.args.get("doc"))
        pno = int(request.args.get("page", 0))
        force = request.args.get("ocr") in ("1", "true", "yes")
        return doc.list_text(pno, force_ocr=force)

    @app.post("/api/text")
    @_wrap
    def api_text_add():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        rec = doc.add_text(
            int(b["page"]),
            b["text"],
            rect=b.get("rect"),
            point=b.get("point"),
            font_size=float(b.get("font_size", 12)),
            color=b.get("color"),
            font=b.get("font"),
            align=int(b.get("align", 0)),
            line_height=b.get("line_height"),
            background=b.get("background"),
            width=b.get("width"),
        )
        return rec

    @app.put("/api/text")
    @_wrap
    def api_text_update():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        pno = int(b["page"])
        # 带 rect = 移动/缩放文本框（界面拖动手柄走这条），不带 = 改内容与样式
        if b.get("rect") is not None:
            return doc.transform_text(
                pno,
                b.get("id"),
                rect=b.get("rect"),
                font_size=b.get("font_size"),
                color=b.get("color"),
            )
        return doc.update_text(
            pno,
            b.get("id"),
            new_text=b.get("text"),
            font_size=b.get("font_size"),
            color=b.get("color"),
            font=b.get("font"),
            align=b.get("align"),
            line_height=b.get("line_height"),
            background=b.get("background"),
        )

    @app.delete("/api/text")
    @_wrap
    def api_text_delete():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        return doc.delete_text(int(b["page"]), b.get("ids") or b.get("id"))

    # ------------------------------------------------------------------ 图片
    @app.get("/api/image")
    @_wrap
    def api_image_list():
        doc = SESSION.get(request.args.get("doc"))
        return doc.list_images(int(request.args.get("page", 0)))

    def _image_bytes(b: dict) -> Any:
        if b.get("data_url"):
            raw = str(b["data_url"])
            if "," in raw:
                raw = raw.split(",", 1)[1]
            return base64.b64decode(raw)
        if b.get("path"):
            return b["path"]
        raise PdfxError("需要 path 或 data_url", "bad_request")

    @app.post("/api/image")
    @_wrap
    def api_image_add():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        return doc.add_image(
            int(b["page"]), b.get("rect"), _image_bytes(b), keep_ratio=bool(b.get("keep_ratio", True)), name=b.get("name")
        )

    @app.put("/api/image")
    @_wrap
    def api_image_replace():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        pno = int(b["page"])
        # 带 rect 且不带新图像 = 移动/缩放已有图片（界面拖动手柄走这条）
        if b.get("rect") is not None and not b.get("data_url") and not b.get("path"):
            return doc.transform_image(
                pno, b.get("id"), b.get("rect"), keep_ratio=bool(b.get("keep_ratio", True))
            )
        return doc.replace_image(pno, b.get("id"), _image_bytes(b), keep_ratio=bool(b.get("keep_ratio", True)))

    @app.delete("/api/image")
    @_wrap
    def api_image_delete():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        # 默认 purge：真删。界面点「删除」不带 mode，若这里退回 cover，
        # 图只是被纸色盖住、仍留在内容流里 —— 看起来删了，保存后原图还能被提取，
        # 之后往同一处插新图也更容易踩到旧实例。
        return doc.delete_image(int(b["page"]), b.get("id"), mode=b.get("mode", "purge"))

    # ------------------------------------------------------------------ 笔迹
    @app.get("/api/ink")
    @_wrap
    def api_ink_list():
        doc = SESSION.get(request.args.get("doc"))
        return doc.list_strokes(int(request.args.get("page", 0)))

    @app.post("/api/ink")
    @_wrap
    def api_ink_add():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        return doc.add_strokes(int(b["page"]), b.get("strokes") or [])

    @app.post("/api/ink/erase")
    @_wrap
    def api_ink_erase():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        return doc.erase_strokes(
            int(b["page"]),
            bbox=b.get("bbox"),
            points=b.get("points"),
            radius=float(b.get("radius", 8)),
            mode=b.get("mode", "cut"),
        )

    @app.post("/api/erase")
    @_wrap
    def api_erase():
        """页面级橡皮：把轨迹扫过的页面原有内容真正擦掉（文字真删 + 图像涂底色）。"""
        b = _body()
        doc = SESSION.get(b.get("doc"))
        return doc.erase_area(
            int(b["page"]),
            points=b.get("points"),
            rects=b.get("rects"),
            radius=float(b.get("radius", 10)),
            erase_text=bool(b.get("erase_text", True)),
        )

    @app.delete("/api/ink")
    @_wrap
    def api_ink_clear():
        doc = SESSION.get(_body().get("doc"))
        page = _body().get("page")
        return doc.clear_strokes(int(page) if page is not None else None)

    # ------------------------------------------------------------------ 检索
    @app.post("/api/search")
    @_wrap
    def api_search():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        return doc.search(
            b.get("query", ""),
            pages=b.get("pages"),
            regex=bool(b.get("regex", False)),
            force_ocr=bool(b.get("force_ocr", False)),
            limit=int(b.get("limit", 300)),
        )

    @app.post("/api/extract")
    @_wrap
    def api_extract():
        b = _body()
        doc = SESSION.get(b.get("doc"))
        return doc.extract_text(pages=b.get("pages"), force_ocr=bool(b.get("force_ocr", False)))

    @app.get("/api/ocr")
    @_wrap
    def api_ocr_status():
        doc = SESSION.docs.get(SESSION.current) if SESSION.current else None
        if doc:
            return doc._ocr_engine.info()
        from .ocr import OcrEngine

        return OcrEngine.get().info()

    @app.post("/api/ocr/warmup")
    @_wrap
    def api_ocr_warmup():
        doc = SESSION.get(_body().get("doc"))
        engine = doc._ocr_engine
        return engine.info()

    # ------------------------------------------------------------------ 文件浏览
    @app.get("/api/browse")
    @_wrap
    def api_browse():
        p = Path(request.args.get("dir") or Path.home())
        if not p.exists() or not p.is_dir():
            raise PdfxError(f"目录不存在: {p}", "not_found")
        items = []
        try:
            for child in sorted(p.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower()))[:400]:
                if child.name.startswith("."):
                    continue
                items.append(
                    {
                        "name": child.name,
                        "path": str(child),
                        "dir": child.is_dir(),
                        "size": child.stat().st_size if child.is_file() else 0,
                        "pdf": child.suffix.lower() == ".pdf",
                    }
                )
        except PermissionError:
            raise PdfxError("没有访问权限", "permission_denied")
        return {"dir": str(p), "parent": str(p.parent), "items": items}

    # ------------------------------------------------------------------ 启动
    if initial:
        try:
            SESSION.add(PDFDocument(initial))
        except Exception as exc:  # pragma: no cover
            print(f"[pdfx] 初始文档打开失败: {exc}")

    return app
