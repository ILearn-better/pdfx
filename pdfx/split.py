"""PDF 批量分割 —— 把一份大文档拆成多个独立 PDF。

一本书 400 页，想按 1-10 / 11-30 / 31-40 导出成 3 份，或者每 50 页一份、
按目录的一级标题一份 —— 都在这里。

页码约定（唯一的例外，务必看清）
--------------------------------
**1 基、闭区间**：`1-10` 就是"第 1 页到第 10 页"，共 10 页。
库内其它接口（`--page`、点击命中）都是 0 基索引，但分割的输入是用户手写的
页码范围，写 `1-10` 的人不可能是指第 0~9 页。换算只在 `_parse_span` 里做，
对外的 `from` / `to` 一律 1 基，页索引另给 `index_from` / `index_to`。

三种切法
--------
- ``ranges``: ``"1-10, 2-30, 31-40"`` —— 逗号/分号/顿号/换行分隔；`5` 是单页；
  `1-` 表示到末页；`1-10:封面` 给这一段单独起文件名。
- ``every``:  每 N 页一份（400 页 ÷ 50 = 8 份，最后一份可不足 N 页）。
- ``toc``:    按目录/书签切，默认取 1 级条目（章）；没有目录时明确报错，
  而不是悄悄切成一份。

重叠与遗漏
----------
`1-10, 2-30` 这种写法的第 2~10 页会出现在两个文件里 —— 这是**允许**的
（封面、答案页常常要重复），但会在 `warnings` 里点名；没被任何一段覆盖的页
同样会点名，避免"导出完才发现中间少了几页"。
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import pymupdf as fitz

from .util import PdfxError

# 一次最多切多少份。再多基本是脚本传错了（比如每 1 页一份地去切 3000 页扫描件）
MAX_PARTS = 500
MAX_NAME = 80
# Windows 全路径 260 的上限要留出余量；超了就截名字，而不是让保存直接失败
PATH_BUDGET = 240

_SEPS = re.compile(r"[,;，；、\n\r]+")
_BAD_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_SPAN_RE = re.compile(r"(\d+)\s*(?:-|–|—|~|～|至|到|\.\.)\s*(\d*)")
_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}


# --------------------------------------------------------------------------- 规划

def safe_name(name: Any, fallback: str = "part") -> str:
    """文件名清洗：去掉 Windows 非法字符、折叠空白、避开保留名。"""
    s = _BAD_CHARS.sub("_", str(name or ""))
    s = re.sub(r"\s+", " ", s).strip().strip(".")
    s = s[:MAX_NAME].strip().strip(".")
    if not s:
        s = fallback
    if s.lower() in _RESERVED:
        s = "_" + s
    return s


def _fit_name(out_dir: Path, name: str) -> str:
    """按目标目录剩下的空间截断文件名，避免超长路径导致保存失败。"""
    room = PATH_BUDGET - len(str(out_dir)) - 1 - 4  # 4 = ".pdf"
    if room < 12:
        return name[:12]
    return name[: max(12, room)]


def _parse_span(item: str, page_count: int) -> tuple[int, int, bool]:
    """单段页码 → (起始页, 结束页, 是否被末页截断)，全部 1 基。"""
    m = _SPAN_RE.fullmatch(item)
    if m:
        a = int(m.group(1))
        b = int(m.group(2)) if m.group(2) else page_count
    elif re.fullmatch(r"\d+", item):
        a = b = int(item)
    else:
        raise PdfxError(
            f'这段页码看不懂："{item}"（写成 1-10、5，或 1-10:小标题）', "bad_range"
        )
    if a < 1:
        raise PdfxError(f"页码从 1 开始，不能是 {a}", "bad_range")
    if b < a:
        raise PdfxError(f"范围 {a}-{b} 是倒着的：起始页要 ≤ 结束页", "bad_range")
    if a > page_count:
        raise PdfxError(f"第 {a} 页超出范围（这份 PDF 共 {page_count} 页）", "page_out_of_range")
    return a, min(b, page_count), b


def parse_ranges(spec: Any, page_count: int) -> tuple[list[dict[str, Any]], list[str]]:
    """``"1-10, 2-30, 31-40"`` → 段列表 + 提示。

    返回项：``{"start", "end", "name", "title"}``，页码 1 基闭区间。
    """
    text = str(spec or "").strip()
    if not text:
        raise PdfxError("请填写页码范围，例如 1-10, 11-30, 31-40", "empty_ranges")
    if text.lower() in ("all", "全部"):
        return [{"start": 1, "end": int(page_count), "name": ""}], []

    parts: list[dict[str, Any]] = []
    warns: list[str] = []
    for raw in _SEPS.split(text):
        item = raw.strip()
        if not item:
            continue
        name = ""
        # 1-10:第一章 —— 冒号后面是这一段自己的文件名
        m = re.match(r"^(.*?)[:：=](.+)$", item)
        if m and re.search(r"\d", m.group(1)):
            item, name = m.group(1).strip(), m.group(2).strip()
        a, b, requested_b = _parse_span(item, page_count)
        if requested_b > page_count:
            warns.append(f"第 {a}-{requested_b} 页超出总页数 {page_count}，已按末页截断（实际 {a}-{b}）")
        parts.append({"start": a, "end": b, "name": name, "title": ""})

    if not parts:
        raise PdfxError("页码范围里没有有效的一段", "bad_range")
    if len(parts) > MAX_PARTS:
        raise PdfxError(f"一次最多分 {MAX_PARTS} 份，现在是 {len(parts)} 份", "too_many_parts")
    return parts, warns


def toc_ranges(
    page_count: int, toc: Sequence[dict[str, Any]], level: int = 1
) -> tuple[list[dict[str, Any]], list[str]]:
    """按目录切：取 ``level`` 级及更浅的条目作为分段起点。"""
    level = max(1, int(level or 1))
    usable = [
        e for e in toc if 1 <= int(e.get("page") or 0) <= page_count
    ]
    if not usable:
        raise PdfxError(
            "这份 PDF 没有可用目录（书签），请改用「页码范围」或「每 N 页」", "no_toc"
        )
    warns: list[str] = []
    entries = [e for e in usable if int(e.get("level") or 1) <= level]
    if not entries:
        shallow = min(int(e.get("level") or 1) for e in usable)
        entries = [e for e in usable if int(e.get("level") or 1) <= shallow]
        warns.append(f"没有 {level} 级书签，已按 {shallow} 级切")

    starts: dict[int, str] = {}
    for e in entries:  # 同一页多个条目时，保留排在最前面的标题
        starts.setdefault(int(e["page"]), str(e.get("title") or "").strip())

    pages = sorted(starts)
    parts: list[dict[str, Any]] = []
    if pages[0] > 1:
        parts.append({"start": 1, "end": pages[0] - 1, "name": "前置页", "title": ""})
    for i, pg in enumerate(pages):
        end = pages[i + 1] - 1 if i + 1 < len(pages) else page_count
        if end < pg:
            continue
        parts.append({"start": pg, "end": end, "name": "", "title": starts[pg]})

    if len(parts) > MAX_PARTS:
        raise PdfxError(
            f"按 {level} 级目录会切出 {len(parts)} 份（上限 {MAX_PARTS}），"
            "请把目录层级调大，或改用每 N 页",
            "too_many_parts",
        )
    if len(parts) == 1:
        warns.append("目录只有 1 个分段起点，导出的是整本书")
    return parts, warns


def _merged_ranges(flags: bytearray, pred: Callable[[int], bool]) -> list[list[int]]:
    """把满足条件的页号合并成 ``[[起, 止], ...]``（1 基），避免几百页逐页列出。"""
    out: list[list[int]] = []
    start = None
    for i, v in enumerate(flags):
        hit = pred(v)
        if hit and start is None:
            start = i + 1
        elif not hit and start is not None:
            out.append([start, i])
            start = None
    if start is not None:
        out.append([start, len(flags)])
    return out


def _fmt_ranges(rs: list[list[int]], limit: int = 3) -> str:
    def one(r: list[int]) -> str:
        return f"第 {r[0]} 页" if r[0] == r[1] else f"第 {r[0]}-{r[1]} 页"

    head = "、".join(one(r) for r in rs[:limit])
    if len(rs) > limit:
        head += f" 等 {len(rs)} 段"
    return head


def default_out_dir(source: str | os.PathLike | None, home: Path) -> Path:
    """默认输出目录：源文件旁边 ``<书名>_split/``；没有源文件就落到桌面（更好找）。"""
    if source:
        p = Path(str(source))
        if p.suffix.lower() == ".pdf":
            return p.parent / f"{safe_name(p.stem, 'document')}_split"
    for name in ("Desktop", "Documents"):
        d = Path(home) / name
        if d.is_dir():
            return d / "pdfx_split"
    return Path(home) / "pdfx_split"


def plan(
    page_count: int,
    *,
    mode: str = "ranges",
    ranges: Any = "",
    every: int = 0,
    level: int = 1,
    toc: Sequence[dict[str, Any]] | None = None,
    prefix: str = "",
    out_dir: str | os.PathLike = "",
    source: str = "",
    home: Path | None = None,
) -> dict[str, Any]:
    """算出「会切出哪几个文件」，不写任何东西。

    前端拿它做实时预览：页数、文件名、重名、已存在、重叠、遗漏一次看全。
    """
    page_count = int(page_count)
    if page_count <= 0:
        raise PdfxError("这份文档没有页面", "empty_document")
    mode = mode if mode in ("ranges", "every", "toc") else "ranges"

    warns: list[str] = []
    if mode == "ranges":
        raw, w = parse_ranges(ranges, page_count)
        warns += w
    elif mode == "every":
        step = int(every or 0)
        if step < 1:
            raise PdfxError("每份页数要 ≥ 1", "bad_every")
        raw = [
            {"start": i + 1, "end": min(i + step, page_count), "name": "", "title": ""}
            for i in range(0, page_count, step)
        ]
        if step >= page_count:
            warns.append(f"每份 {step} 页 ≥ 总页数 {page_count} 页，只会导出 1 个文件")
    else:
        raw, w = toc_ranges(page_count, toc or [], level)
        warns += w

    # 覆盖情况：重叠 / 遗漏
    flags = bytearray(page_count)
    for p in raw:
        for i in range(p["start"] - 1, p["end"]):
            flags[i] += 1
    dup = _merged_ranges(flags, lambda v: v > 1)
    gap = _merged_ranges(flags, lambda v: v == 0)
    if dup:
        warns.append(f"{_fmt_ranges(dup)}会同时出现在多个文件里（按需要重复导出）")
    if gap:
        warns.append(f"{_fmt_ranges(gap)}没有被任何一段包含，不会出现在导出结果里")

    # 输出目录一律给绝对路径：CLI 传相对路径时，回给用户的路径也要能直接粘到资源管理器
    out = Path(out_dir).expanduser().resolve() if out_dir else default_out_dir(source, home or Path.home())
    stem = safe_name(prefix or (Path(str(source)).stem if source else "未命名"), "未命名")

    used: set[str] = set()
    parts: list[dict[str, Any]] = []
    for i, p in enumerate(raw):
        label = f"{p['start']}-{p['end']}" if p["end"] > p["start"] else str(p["start"])
        title = str(p.get("title") or "")
        if p.get("name"):
            base = safe_name(p["name"], label)  # 用户起的名字原样用，不加前缀
        elif title:
            base = safe_name(f"{stem}_{i + 1:02d}_{title}", f"{stem}_{label}")
        else:
            base = safe_name(f"{stem}_{label}", f"{stem}_{label}")
        base = _fit_name(out, base)
        name = base
        n = 2
        while name.lower() in used:  # 同一批里重名，依次加 -2 / -3
            name = f"{base}-{n}"
            n += 1
        used.add(name.lower())
        target = out / f"{name}.pdf"
        parts.append(
            {
                "index": i,
                "label": label,
                "from": p["start"],
                "to": p["end"],
                "index_from": p["start"] - 1,
                "index_to": p["end"] - 1,
                "pages": p["end"] - p["start"] + 1,
                "name": name,
                "file": f"{name}.pdf",
                "path": str(target),
                "title": title,
                "custom": bool(p.get("name")),
                "exists": target.exists(),
            }
        )

    conflicts = [p["path"] for p in parts if p["exists"]]
    if conflicts:
        warns.append(f"有 {len(conflicts)} 个目标文件已存在，勾选「覆盖同名文件」才会写")
    if len(str(out)) > PATH_BUDGET:
        warns.append("输出目录路径偏长，文件名已被截短；换个浅一点的目录更稳")

    return {
        "source": str(source or ""),
        "mode": mode,
        "page_count": page_count,
        "out_dir": str(out),
        "prefix": stem,
        "parts": parts,
        "part_count": len(parts),
        "total_pages": sum(p["pages"] for p in parts),
        "unique_pages": sum(1 for v in flags if v),
        "duplicated": dup,
        "uncovered": gap,
        "conflicts": conflicts,
        "warnings": warns,
    }


# --------------------------------------------------------------------------- 执行

def list_toc(doc: fitz.Document) -> list[dict[str, Any]]:
    """目录条目 → ``[{level, title, page}]``（page 1 基，外部链接丢掉）。"""
    out: list[dict[str, Any]] = []
    try:
        raw = doc.get_toc(simple=True) or []
    except Exception:
        return out
    for item in raw:
        if not item or len(item) < 3:
            continue
        lvl, title, page = item[0], item[1], item[2]
        try:
            pg = int(page)
        except (TypeError, ValueError):
            continue
        if pg <= 0:
            continue
        out.append({"level": int(lvl or 1), "title": str(title or "").strip(), "page": pg})
    return out


def open_source(source: Any, password: str | None = None) -> tuple[fitz.Document, bool]:
    """打开源文档；返回 (doc, 是否由本函数负责关闭)。"""
    if isinstance(source, fitz.Document):
        doc, own = source, False
    elif isinstance(source, (bytes, bytearray, memoryview)):
        try:
            doc, own = fitz.open("pdf", bytes(source)), True
        except Exception as exc:
            raise PdfxError(f"无法读取 PDF 数据: {exc}", "open_failed")
    else:
        p = Path(str(source)).expanduser()
        if not p.exists():
            raise PdfxError(f"文件不存在: {p}", "not_found")
        try:
            doc, own = fitz.open(str(p)), True
        except Exception as exc:
            raise PdfxError(f"无法打开 PDF: {exc}", "open_failed")
    if doc.needs_pass and not (password and doc.authenticate(password)):
        if own:
            doc.close()
        raise PdfxError("这份 PDF 有密码，请先打开它并输入密码", "password_required")
    return doc, own


def _attach_state(path: Path, state: dict[str, Any], old_xrefs: list[int], start0: int) -> None:
    """把页面状态（用户文本框 / 笔迹记录）挂到**已保存**的分段文件上。

    必须在 save 之后做：`garbage=3` 会重排对象号（我们实测 20 页的副本里
    页 xref 从 13/16/19 变成 15/17/19），保存前写进去的键全都对不上，
    导出的文件里"用户文本框"就退化成一堆普通文字 —— 内容没少，但不能再整体拖动。

    所以先正常保存（体积优先），再重新打开、按稳定的新 xref 写状态、追加保存
    （incremental 只往后补几 KB，不会把整个文件重写一遍）。
    """
    pages = (state or {}).get("pages") or {}
    if not pages:
        return
    from .doc import write_state  # 延迟导入，避免 doc ↔ split 循环引用

    doc = fitz.open(str(path))
    try:
        mapping: dict[int, int] = {}
        xref_page: dict[int, int] = {}
        for k in range(doc.page_count):
            i = start0 + k
            if i < len(old_xrefs):
                mapping[old_xrefs[i]] = doc[k].xref
            xref_page[doc[k].xref] = k
        new_pages: dict[str, Any] = {}
        for old, rec in pages.items():
            try:
                newx = mapping.get(int(old))
            except (TypeError, ValueError):
                newx = None
            if newx:
                new_pages[str(newx)] = _relabel_ids(rec, xref_page.get(newx, 0))
        if not new_pages:
            return
        write_state(doc, {"version": (state or {}).get("version", 1), "pages": new_pages})
        doc.save(str(path), incremental=True, encryption=fitz.PDF_ENCRYPT_KEEP)
    finally:
        try:
            doc.close()
        except Exception:
            pass


def _relabel_ids(rec: dict[str, Any], page_no: int) -> dict[str, Any]:
    """把状态里 ``p{原页}:…`` 前缀改成段内的新页号。

    文本框/图片的 id 前缀只是给人看的标签（查对象是按"某页 + id"找的），
    但导出后 p5:ut… 出现在第 1 页会很奇怪，改掉也不影响任何查找。
    笔迹不动：它的 id 还写在 ink 注释的 title 里，只改一边会让"擦除"对不上。
    """
    out = dict(rec)
    for key in ("texts", "images"):
        items = rec.get(key)
        if not isinstance(items, list):
            continue
        fixed = []
        for item in items:
            if not isinstance(item, dict):
                fixed.append(item)
                continue
            obj = dict(item)
            oid = obj.get("id")
            if isinstance(oid, str) and re.match(r"^p\d+:", oid):
                obj["id"] = re.sub(r"^p\d+:", f"p{page_no}:", oid)
            fixed.append(obj)
        out[key] = fixed
    return out


def _carry_toc(part: fitz.Document, toc: Sequence[Sequence[Any]], start0: int, end0: int) -> None:
    """裁剪目录：只留落在本段里的条目，并把页号平移到段内。

    注意层级要重新归一：整段的第一个条目可能是 2 级（它上面那章被切走了），
    而 PDF 目录不允许"第一条就是 2 级"—— 直接 set_toc 会抛异常，
    这份导出的文件就彻底没有书签了。
    """
    sel: list[list[Any]] = []
    for entry in toc:
        if not entry or len(entry) < 3:
            continue
        lvl, title, page = entry[0], entry[1], entry[2]
        try:
            pg = int(page)
        except (TypeError, ValueError):
            continue
        if start0 + 1 <= pg <= end0 + 1:
            sel.append([int(lvl or 1), str(title or ""), pg - start0])
    if not sel:
        try:
            part.set_toc([])
        except Exception:
            pass
        return
    base = sel[0][0]
    prev = 1
    norm: list[list[Any]] = []
    for lvl, title, pg in sel:
        lvl = max(1, lvl - base + 1)
        lvl = min(lvl, prev + 1)  # 不允许跳级
        norm.append([lvl, title, pg])
        prev = lvl
    try:
        part.set_toc(norm)
    except Exception:
        pass


def run(
    source: Any,
    plan_obj: dict[str, Any],
    *,
    state: dict[str, Any] | None = None,
    password: str | None = None,
    overwrite: bool = False,
    progress: Callable[[int, int, dict[str, Any]], None] | None = None,
    cancel: Any = None,
) -> dict[str, Any]:
    """按 ``plan()`` 的结果真正写出文件。

    ``source`` 可以是路径、PDF bytes（在内存文档上直接切，含未保存的修改）
    或已打开的 ``fitz.Document``。逐份写临时文件再原子改名，中途失败/取消
    不会留下半截的 PDF。
    """
    t0 = time.time()
    parts = list(plan_obj.get("parts") or [])
    if not parts:
        raise PdfxError("没有要导出的分段", "empty_plan")
    out_dir = Path(plan_obj.get("out_dir") or ".")
    src, own = open_source(source, password)
    warns: list[str] = list(plan_obj.get("warnings") or [])
    try:
        if src.page_count != int(plan_obj.get("page_count") or src.page_count):
            warns.append(
                f"源文档页数从 {plan_obj.get('page_count')} 变成了 {src.page_count}，已按当前页数裁剪"
            )
        total = src.page_count
        # 目标已存在就整批拒绝，不写一半再报错
        exists = [p["path"] for p in parts if Path(p["path"]).exists()]
        if exists and not overwrite:
            raise PdfxError(
                f"有 {len(exists)} 个目标文件已存在：{Path(exists[0]).name}"
                + ("……" if len(exists) > 1 else "")
                + "。确认覆盖请勾选「覆盖同名文件」",
                "exists",
                files=exists,
            )

        out_dir.mkdir(parents=True, exist_ok=True)
        old_xrefs: list[int] = []
        try:
            old_xrefs = [src[i].xref for i in range(total)]
        except Exception:
            old_xrefs = []
        st = src.get_toc(simple=True) or []
        if state is None:
            # 不传就自己读：拆出来的文件也要能继续认出"用户文本框 / 笔迹"
            try:
                from .doc import read_state

                state = read_state(src)
            except Exception:
                state = {"version": 1, "pages": {}}
        base_meta = dict(src.metadata or {})
        stem = plan_obj.get("prefix") or "document"

        files: list[dict[str, Any]] = []
        cancelled = False
        for i, p in enumerate(parts):
            if cancel is not None and getattr(cancel, "is_set", lambda: False)():
                cancelled = True
                break
            start0 = max(0, min(int(p["from"]) - 1, total - 1))
            end0 = max(start0, min(int(p["to"]) - 1, total - 1))
            target = Path(p["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(f".{target.name}.pdfx.tmp")
            part = fitz.open()
            try:
                part.insert_pdf(
                    src, from_page=start0, to_page=end0,
                    links=True, annots=True, widgets=True,
                )
                _carry_toc(part, st, start0, end0)
                meta = dict(base_meta)
                title = (meta.get("title") or "").strip()
                label = p.get("label") or f"{start0 + 1}-{end0 + 1}"
                meta["title"] = f"{title} · {label}" if title and title != label else (
                    f"{stem} · {label}"
                )
                try:
                    part.set_metadata(meta)
                except Exception:
                    pass
                part.save(str(tmp), garbage=3, deflate=True)
            except Exception as exc:
                try:
                    part.close()
                except Exception:
                    pass
                try:
                    tmp.unlink()
                except Exception:
                    pass
                raise PdfxError(f"导出第 {i + 1} 份（{p.get('file')}）失败: {exc}", "split_failed")
            part.close()
            # 状态要在保存之后再挂（保存会重排 xref），见 _attach_state 的说明
            try:
                _attach_state(tmp, state or {}, old_xrefs, start0)
            except Exception:
                # 状态属于"锦上添花"：挂了失败也不能让整份导出失败，
                # 但下面会再校验一次文件能不能读，免得把坏文件当成成品交出去
                pass
            try:
                with fitz.open(str(tmp)) as check:
                    if check.page_count != end0 - start0 + 1:
                        raise ValueError(f"页数 {check.page_count} ≠ {end0 - start0 + 1}")
            except Exception as exc:
                try:
                    tmp.unlink()
                except Exception:
                    pass
                raise PdfxError(f"导出的第 {i + 1} 份校验不通过: {exc}", "split_failed")
            try:
                os.replace(str(tmp), str(target))
            except Exception as exc:
                try:
                    tmp.unlink()
                except Exception:
                    pass
                raise PdfxError(
                    f"无法写入 {target.name}（可能被其他程序占用）: {exc}", "file_locked"
                )
            entry = {
                "index": i,
                "name": p.get("name"),
                "file": target.name,
                "path": str(target),
                "from": start0 + 1,
                "to": end0 + 1,
                "pages": end0 - start0 + 1,
                "bytes": target.stat().st_size if target.exists() else 0,
            }
            files.append(entry)
            if progress is not None:
                try:
                    progress(i + 1, len(parts), entry)
                except Exception:
                    pass

        return {
            "out_dir": str(out_dir),
            "part_count": len(parts),
            "written": len(files),
            "files": files,
            "total_bytes": sum(f["bytes"] for f in files),
            "elapsed": round(time.time() - t0, 2),
            "cancelled": cancelled,
            "warnings": warns,
        }
    finally:
        if own:
            try:
                src.close()
            except Exception:
                pass
