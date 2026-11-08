"""pdfx 命令行。设计目标是"AI 可直接调用"：

1. 默认输出单行/缩进 JSON（机器可读），--human 才输出人类可读文本
2. 每个命令都是一个幂等动作，返回值里带执行结果与后续可用 id
3. 失败时退出码非 0，并把错误码写进 JSON，便于上游判断

示例
----
    pdfx describe report.pdf
    pdfx text list scan.pdf --page 0
    pdfx text add report.pdf --page 0 --text "已复核" --rect 400,60,540,80 --size 11 --color "#c00"
    pdfx search scan.pdf "合同金额" --json
    pdfx serve report.pdf --port 8765
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .doc import PDFDocument
from .util import PdfxError, __version__, fail, ok


# --------------------------------------------------------------------------- 解析辅助

def parse_rect(value: Any) -> list[float] | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return [float(v) for v in value]
    parts = [p for p in str(value).replace(";", ",").split(",") if p.strip()]
    if len(parts) != 4:
        raise PdfxError("rect 需要 4 个数字: x0,y0,x1,y1", "bad_rect")
    return [float(p) for p in parts]


def parse_point(value: Any) -> list[float] | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return [float(v) for v in value]
    parts = [p for p in str(value).replace(";", ",").split(",") if p.strip()]
    if len(parts) != 2:
        raise PdfxError("point 需要 2 个数字: x,y", "bad_point")
    return [float(p) for p in parts]


def parse_points(value: Any) -> list[list[float]] | None:
    """支持 "x,y;x,y;..." 或 JSON 数组。"""
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return [[float(p[0]), float(p[1])] for p in value]
    text = str(value).strip()
    if text.startswith("["):
        return [[float(p[0]), float(p[1])] for p in json.loads(text)]
    out = []
    for seg in text.split(";"):
        seg = seg.strip()
        if not seg:
            continue
        xy = [p for p in seg.replace(" ", ",").split(",") if p]
        if len(xy) != 2:
            raise PdfxError(f"点格式错误: {seg}", "bad_point")
        out.append([float(xy[0]), float(xy[1])])
    return out


def load_json_arg(value: str) -> Any:
    p = Path(value)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return json.loads(value)


# --------------------------------------------------------------------------- 输出

def emit(data: Any, as_text: bool = False, pretty: bool = False) -> None:
    if as_text:
        _emit_human(data)
        return
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if pretty:
        print(json.dumps(ok(data), ensure_ascii=False, indent=2, default=str))
    else:
        print(json.dumps(ok(data), ensure_ascii=False, separators=(",", ":"), default=str))


def _emit_human(data: Any) -> None:
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, (list, dict)):
                print(f"{k}:")
                print(json.dumps(v, ensure_ascii=False, indent=2, default=str))
            else:
                print(f"{k}: {v}")
    else:
        print(data)


def emit_error(exc: Exception, pretty: bool = False) -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if pretty:
        print(json.dumps(fail(exc), ensure_ascii=False, indent=2, default=str))
    else:
        print(json.dumps(fail(exc), ensure_ascii=False, separators=(",", ":"), default=str))


# --------------------------------------------------------------------------- 命令实现

class Runner:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.doc: PDFDocument | None = None

    def open(self) -> PDFDocument:
        if self.doc is None:
            self.doc = PDFDocument(self.args.file, ocr_backend=self.args.ocr_backend)
        return self.doc

    def finish(self, data: dict[str, Any], mutate: bool = False) -> dict[str, Any]:
        """修改类命令统一收尾：保存 + 回附带状态。"""
        a = self.args
        if mutate and not a.no_save:
            doc = self.open()
            target = a.out or None
            saved = doc.save(target, incremental=bool(a.incremental), flatten_inks=bool(a.flatten_inks))
            data = {**data, "saved_to": saved}
        return data


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="pdfx", description="PDF 处理工具（结构化 + 扫描件 OCR 统一编辑）")
    p.add_argument("--version", action="version", version=f"pdfx {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp: argparse.ArgumentParser, mutate: bool = False) -> None:
        sp.add_argument("file", nargs="?", help="PDF 文件路径（新建时可省略）")
        sp.add_argument("--human", action="store_true", help="输出人类可读文本而非 JSON")
        sp.add_argument("--pretty", action="store_true", help="JSON 缩进美化")
        sp.add_argument("--ocr-backend", default="auto", choices=["auto", "rapidocr", "windows", "tesseract"])
        if mutate:
            sp.add_argument("--out", "-o", help="另存为新文件（默认写回原文件）")
            sp.add_argument("--no-save", action="store_true", help="只改内存不落盘")
            sp.add_argument("--incremental", action="store_true", help="增量保存（速度快，文件会变大）")
            sp.add_argument("--flatten-inks", action="store_true", help="保存时把手写笔迹烘焙进页面")

    # ---- 文档级
    for name, help_text in (
        ("info", "文档基本信息（页数、页面类型、OCR 状态）"),
        ("describe", "可操作对象清单，给 AI 做规划用"),
        ("ocr", "OCR 引擎状态"),
    ):
        sp = sub.add_parser(name, help=help_text)
        add_common(sp)
        sp.add_argument("--json", action="store_true", help="（默认即为 JSON）")

    sp = sub.add_parser("new", help="新建空白 PDF")
    sp.add_argument("out", help="输出路径")
    sp.add_argument("--size", default="a4", help="页面尺寸: a4/a3/letter/自定义 WxH 或 W,H")
    sp.add_argument("--pages", type=int, default=1)
    sp.add_argument("--human", action="store_true")

    sp = sub.add_parser("render", help="把某页渲染成图片")
    add_common(sp)
    sp.add_argument("--page", type=int, default=0)
    sp.add_argument("--dpi", type=float, default=150)
    sp.add_argument("--clip", help="只渲染区域 x0,y0,x1,y1")
    sp.add_argument("-o", "--out-file", required=True, help="输出 png 路径")

    # ---- 页面
    sp = sub.add_parser("page", help="页面操作")
    psub = sp.add_subparsers(dest="action", required=True)
    s = psub.add_parser("list", help="列出所有页面")
    add_common(s)
    s = psub.add_parser("add", help="新增页面")
    add_common(s, mutate=True)
    s.add_argument("--size", default="a4")
    s.add_argument("--at", type=int, help="插入位置（默认末尾）")
    s.add_argument("--background", help="底色 如 #ffffff")
    s = psub.add_parser("delete", help="删除页面")
    add_common(s, mutate=True)
    s.add_argument("--pages", required=True, help='如 "1,3-5" 或 "2-"')
    s = psub.add_parser("move", help="移动页面")
    add_common(s, mutate=True)
    s.add_argument("--from", dest="src", type=int, required=True)
    s.add_argument("--to", dest="dst", type=int, required=True)
    s = psub.add_parser("rotate", help="旋转页面")
    add_common(s, mutate=True)
    s.add_argument("--pages", default="all")
    s.add_argument("--degrees", type=int, default=90)
    s = psub.add_parser("import", help="从另一份 PDF 导入页面")
    add_common(s, mutate=True)
    s.add_argument("--src", required=True)
    s.add_argument("--pages", default="all")
    s.add_argument("--at", type=int)

    # ---- 文本
    sp = sub.add_parser("text", help="文本操作")
    tsub = sp.add_subparsers(dest="action", required=True)
    s = tsub.add_parser("list", help="列出文本行（含 OCR）")
    add_common(s)
    s.add_argument("--page", type=int, default=0)
    s.add_argument("--ocr", action="store_true", help="强制 OCR")
    s = tsub.add_parser("add", help="插入文本框")
    add_common(s, mutate=True)
    s.add_argument("--page", type=int, default=0)
    s.add_argument("--text", required=True)
    s.add_argument("--rect", help="x0,y0,x1,y1")
    s.add_argument("--point", help="x,y （只给左上角）")
    s.add_argument("--width", type=float, help="配合 --point 的文本框宽度")
    s.add_argument("--size", dest="font_size", type=float, default=12)
    s.add_argument("--color", default="#111111")
    s.add_argument("--font", help="helv/tiro/cour/china-s 等")
    s.add_argument("--align", type=int, default=0, help="0左 1中 2右 3两端")
    s.add_argument("--line-height", type=float)
    s.add_argument("--background", help="文本框底色")
    s = tsub.add_parser("update", help="修改文本（含 OCR 文本）")
    add_common(s, mutate=True)
    s.add_argument("--page", type=int, default=0)
    s.add_argument("--id", required=True, help="文本对象 id")
    s.add_argument("--text", required=True, help="新内容")
    s.add_argument("--size", dest="font_size", type=float)
    s.add_argument("--color")
    s.add_argument("--font")
    s.add_argument("--background", help="扫描件上覆盖用的底色")
    s = tsub.add_parser("transform", help="移动/缩放文本（不改内容）")
    add_common(s, mutate=True)
    s.add_argument("--page", type=int, default=0)
    s.add_argument("--id", required=True, help="文本对象 id")
    s.add_argument("--rect", required=True, help="目标框 x0,y0,x1,y1；高度变化会联动字号")
    s.add_argument("--size", dest="font_size", type=float, help="显式指定字号，覆盖联动结果")
    s = tsub.add_parser("delete", help="删除文本（含 OCR 文本）")
    add_common(s, mutate=True)
    s.add_argument("--page", type=int, default=0)
    s.add_argument("--id", action="append", required=True, help="可重复；也支持 x0,y0,x1,y1 区域")

    # ---- 图片
    sp = sub.add_parser("image", help="图片操作")
    isub = sp.add_subparsers(dest="action", required=True)
    s = isub.add_parser("list")
    add_common(s)
    s.add_argument("--page", type=int, default=0)
    s = isub.add_parser("add")
    add_common(s, mutate=True)
    s.add_argument("--page", type=int, default=0)
    s.add_argument("--rect", required=True)
    s.add_argument("--src", required=True, help="图片文件路径")
    s.add_argument("--no-keep-ratio", action="store_true")
    s = isub.add_parser("replace")
    add_common(s, mutate=True)
    s.add_argument("--page", type=int, default=0)
    s.add_argument("--id", required=True)
    s.add_argument("--src", required=True)
    s = isub.add_parser("delete")
    add_common(s, mutate=True)
    s.add_argument("--page", type=int, default=0)
    s.add_argument("--id", required=True)
    s.add_argument("--mode", choices=["cover", "purge"], default="purge",
                   help="purge=从内容流真删（默认）；cover=只涂纸色盖住")
    s = isub.add_parser("transform", help="移动/缩放图片（不改内容）")
    add_common(s, mutate=True)
    s.add_argument("--page", type=int, default=0)
    s.add_argument("--id", required=True)
    s.add_argument("--rect", required=True)
    s.add_argument("--no-keep-ratio", action="store_true", help="允许单向拉伸，不保持原始比例")

    # ---- 笔迹
    sp = sub.add_parser("ink", help="手写笔迹操作")
    ksub = sp.add_subparsers(dest="action", required=True)
    s = ksub.add_parser("list")
    add_common(s)
    s.add_argument("--page", type=int, default=0)
    s = ksub.add_parser("add")
    add_common(s, mutate=True)
    s.add_argument("--page", type=int, default=0)
    s.add_argument("--strokes", required=True, help='JSON: [{"points":[[x,y],..],"color":"#f00","width":2}]')
    s = ksub.add_parser("erase")
    add_common(s, mutate=True)
    s.add_argument("--page", type=int, default=0)
    s.add_argument("--points", help="橡皮轨迹 x,y;x,y")
    s.add_argument("--bbox", help="框选擦除 x0,y0,x1,y1")
    s.add_argument("--radius", type=float, default=8)
    s.add_argument("--mode", choices=["cut", "stroke"], default="cut")
    s = ksub.add_parser("clear")
    add_common(s, mutate=True)
    s.add_argument("--page", type=int)
    s = ksub.add_parser("flatten", help="把笔迹烘焙进页面（不可再编辑）")
    add_common(s, mutate=True)

    # ---- 页面橡皮（擦掉页面原有内容，不只是自己画的笔迹）
    sp = sub.add_parser("erase", help="页面级橡皮：擦掉扫过的页面原有内容")
    add_common(sp, mutate=True)
    sp.add_argument("--page", type=int, default=0)
    sp.add_argument("--points", help="橡皮轨迹 x,y;x,y")
    sp.add_argument("--rects", help="要擦的矩形，多个用 ; 分隔：x0,y0,x1,y1;...")
    sp.add_argument("--radius", type=float, default=10)
    sp.add_argument("--no-text", action="store_true", help="只涂图像内容，不删文字层")

    # ---- 检索
    sp = sub.add_parser("search", help="全文检索（自动对扫描页 OCR）")
    add_common(sp)
    sp.add_argument("query")
    sp.add_argument("--pages", help='如 "1-3"')
    sp.add_argument("--regex", action="store_true")
    sp.add_argument("--ocr", action="store_true", help="对所有页强制 OCR")
    sp.add_argument("--limit", type=int, default=300)
    sp.add_argument("--context", type=int, default=36)

    sp = sub.add_parser("extract", help="导出文本")
    add_common(sp)
    sp.add_argument("--pages")
    sp.add_argument("--ocr", action="store_true")
    sp.add_argument("-o", "--out-file", help="写入 txt（默认打印到 stdout）")

    # ---- 服务
    sp = sub.add_parser("serve", help="启动本地 Web 编辑器 / HTTP API")
    sp.add_argument("file", nargs="?", help="可直接打开的文件")
    sp.add_argument("--host", default="127.0.0.1")
    sp.add_argument("--port", type=int, default=8765)
    sp.add_argument("--no-browser", action="store_true")

    # ---- 内部：探测端口上跑的是不是本工具、是不是旧版本（启动脚本用）
    sp = sub.add_parser("probe", help="探测某个端口上运行的 pdfx 版本（启动脚本内部用）")
    sp.add_argument("--port", type=int, default=8765)
    sp.add_argument("--host", default="127.0.0.1")

    # ---- 保存
    sp = sub.add_parser("save", help="把当前状态写回文件（配合 --no-save 的多步操作）")
    add_common(sp, mutate=True)

    return p


def dispatch(args: argparse.Namespace) -> Any:
    r = Runner(args)
    cmd = args.cmd

    if cmd == "new":
        doc = PDFDocument()
        for _ in range(max(1, args.pages)):
            doc.add_page(args.size)
        out = doc.save(args.out)
        doc.close()
        return {"path": out, "page_count": args.pages, "size": args.size}

    if cmd == "probe":
        # 退出码：0=新版本，3=旧版本，4=不是本工具 / 没服务
        import json
        import urllib.request

        url = f"http://{args.host}:{args.port}/api/caps"
        # 必须绕开系统代理：本机常配着 HTTP_PROXY，localhost 也会被送进代理，
        # 拿回一个 502 就让启动脚本误判成"没有服务"，于是又拉起第二个进程。
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(url, timeout=3) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
            raise SystemExit(4)
        caps = (payload.get("data") or {}).get("caps") or []
        fresh = "erase.content" in caps and "ocr.optional" in caps and "erase.guarded" in caps
        print(json.dumps({"ok": True, "version": (payload.get("data") or {}).get("version"),
                          "caps": caps, "fresh": fresh}, ensure_ascii=False))
        raise SystemExit(0 if fresh else 3)

    if cmd == "serve":
        from .service import create_app

        app = create_app(args.file)
        url = f"http://{args.host}:{args.port}"
        print(f"[pdfx] serving on {url}", file=sys.stderr)
        if not args.no_browser:
            import threading
            import webbrowser

            threading.Timer(1.0, lambda: webbrowser.open(url)).start()
        app.run(host=args.host, port=args.port, debug=False, threaded=True)
        return {"stopped": True}

    if cmd == "info":
        doc = r.open()
        return doc.info()
    if cmd == "describe":
        doc = r.open()
        return doc.describe()
    if cmd == "ocr":
        doc = r.open() if args.file else None
        return (doc._ocr_engine.info() if doc else __import__("pdfx.ocr", fromlist=["OcrEngine"]).OcrEngine.get().info())

    if cmd == "render":
        doc = r.open()
        data = doc.render(args.page, dpi=args.dpi, clip=parse_rect(args.clip))
        Path(args.out_file).write_bytes(data)
        return {"path": args.out_file, "bytes": len(data)}

    if cmd == "page":
        doc = r.open()
        if args.action == "list":
            return doc.describe()
        if args.action == "add":
            idx = doc.add_page(args.size, position=args.at, background=args.background)
            return r.finish({"index": idx, **doc.describe()}, mutate=True)
        if args.action == "delete":
            removed = doc.delete_pages(args.pages)
            return r.finish({"removed": removed, **doc.describe()}, mutate=True)
        if args.action == "move":
            doc.move_page(args.src, args.dst)
            return r.finish(doc.describe(), mutate=True)
        if args.action == "rotate":
            tgt = doc.rotate_page(args.pages, args.degrees)
            return r.finish({"rotated": tgt, **doc.describe()}, mutate=True)
        if args.action == "import":
            added = doc.import_pdf(args.src, args.pages, args.at)
            return r.finish({"added": added, **doc.describe()}, mutate=True)

    if cmd == "text":
        doc = r.open()
        if args.action == "list":
            return doc.list_text(args.page, force_ocr=args.ocr)
        if args.action == "add":
            rec = doc.add_text(
                args.page,
                args.text,
                rect=parse_rect(args.rect),
                point=parse_point(args.point),
                font_size=args.font_size,
                color=args.color,
                font=args.font,
                align=args.align,
                line_height=args.line_height,
                background=args.background,
                width=args.width,
            )
            return r.finish(rec, mutate=True)
        if args.action == "update":
            res = doc.update_text(
                args.page,
                args.id,
                new_text=args.text,
                font_size=args.font_size,
                color=args.color,
                font=args.font,
                background=args.background,
            )
            return r.finish(res, mutate=True)
        if args.action == "transform":
            res = doc.transform_text(
                args.page, args.id, rect=parse_rect(args.rect), font_size=args.font_size
            )
            return r.finish(res, mutate=True)
        if args.action == "delete":
            ids = []
            for t in args.id:
                try:
                    ids.append(parse_rect(t) if t.count(",") == 3 else t)
                except Exception:
                    ids.append(t)
            res = doc.delete_text(args.page, ids)
            return r.finish(res, mutate=True)

    if cmd == "image":
        doc = r.open()
        if args.action == "list":
            return doc.list_images(args.page)
        if args.action == "add":
            rec = doc.add_image(args.page, parse_rect(args.rect), args.src, keep_ratio=not args.no_keep_ratio)
            return r.finish(rec, mutate=True)
        if args.action == "replace":
            res = doc.replace_image(args.page, args.id, args.src)
            return r.finish(res, mutate=True)
        if args.action == "delete":
            res = doc.delete_image(args.page, args.id, mode=args.mode)
            return r.finish(res, mutate=True)
        if args.action == "transform":
            res = doc.transform_image(
                args.page, args.id, parse_rect(args.rect), keep_ratio=not getattr(args, "no_keep_ratio", False)
            )
            return r.finish(res, mutate=True)

    if cmd == "ink":
        doc = r.open()
        if args.action == "list":
            return doc.list_strokes(args.page)
        if args.action == "add":
            data = load_json_arg(args.strokes)
            res = doc.add_strokes(args.page, data if isinstance(data, list) else data.get("strokes", []))
            return r.finish(res, mutate=True)
        if args.action == "erase":
            res = doc.erase_strokes(
                args.page,
                bbox=parse_rect(args.bbox),
                points=parse_points(args.points),
                radius=args.radius,
                mode=args.mode,
            )
            return r.finish(res, mutate=True)
        if args.action == "clear":
            res = doc.clear_strokes(args.page)
            return r.finish(res, mutate=True)
        if args.action == "flatten":
            n = doc._flatten_inks_all()
            return r.finish({"flattened": n}, mutate=True)

    if cmd == "erase":
        doc = r.open()
        res = doc.erase_area(
            args.page,
            points=parse_points(args.points),
            rects=[parse_rect(x) for x in (args.rects or "").split(";") if x.strip()],
            radius=args.radius,
            erase_text=not getattr(args, "no_text", False),
        )
        return r.finish(res, mutate=True)

    if cmd == "search":
        doc = r.open()
        return doc.search(
            args.query,
            pages=args.pages,
            regex=args.regex,
            force_ocr=args.ocr,
            context=args.context,
            limit=args.limit,
        )

    if cmd == "extract":
        doc = r.open()
        res = doc.extract_text(pages=args.pages, force_ocr=args.ocr)
        if args.out_file:
            Path(args.out_file).write_text(res["text"], encoding="utf-8")
            return {k: v for k, v in res.items() if k != "text"} | {"path": args.out_file}
        return res

    if cmd == "save":
        doc = r.open()
        path = doc.save(args.out or None, incremental=args.incremental, flatten_inks=args.flatten_inks)
        return {"path": path, "size": os.path.getsize(path)}

    raise PdfxError(f"未知命令: {cmd}", "bad_command")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        data = dispatch(args)
        emit(data, as_text=bool(getattr(args, "human", False)), pretty=bool(getattr(args, "pretty", False)))
        return 0
    except PdfxError as exc:
        emit_error(exc, pretty=bool(getattr(args, "pretty", False)))
        return 2
    except FileNotFoundError as exc:
        emit_error(PdfxError(f"文件不存在: {exc.filename}", "not_found"), pretty=True)
        return 2
    except Exception as exc:
        emit_error(exc, pretty=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
