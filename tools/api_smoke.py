"""对本地服务做一轮接口冒烟测试。

    python tools/api_smoke.py [base_url]
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 不指定地址时自己起一个随机端口的服务：
# 默认端口 8765 上可能正跑着用户自己的实例（甚至旧版本的），复用会测到别人身上
_PORT = 8900 + (os.getpid() % 90)
BASE = (sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{_PORT}").rstrip("/")

# 直连本机，绕开系统代理
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _reachable() -> bool:
    try:
        _opener.open(BASE + "/api/doc", timeout=2)
        return True
    except urllib.error.HTTPError:
        return True  # 服务在跑，只是还没打开文档
    except Exception:
        return False


def ensure_server() -> subprocess.Popen | None:
    """服务没起来就临时拉一个，跑完再关掉。"""
    if _reachable():
        return None
    port = BASE.rsplit(":", 1)[-1]
    kw = {}
    if sys.platform == "win32":
        kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    proc = subprocess.Popen(
        [sys.executable, "-m", "pdfx", "serve", "--port", port],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **kw,
    )
    for _ in range(80):
        if _reachable():
            print(f"[smoke] 已临时启动服务 {BASE}")
            return proc
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    proc.terminate()
    raise SystemExit(f"[smoke] 无法启动服务 {BASE}")


def call(path: str, payload=None, method: str | None = None, raw: bool = False):
    url = BASE + path
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method or ("POST" if data else "GET"))
    with _opener.open(req, timeout=120) as resp:
        body = resp.read()
    if raw:
        return body
    return json.loads(body.decode("utf-8"))


def check(name: str, cond: bool, extra: str = "") -> bool:
    print(f"{'PASS' if cond else 'FAIL'}  {name}{(' — ' + extra) if extra else ''}")
    return cond


def _head(path: str):
    """拿响应头和响应体，用来断言缓存策略。"""
    req = urllib.request.Request(BASE + path)
    with _opener.open(req, timeout=60) as resp:
        return resp.read(), dict(resp.headers)


def main() -> int:
    ok_all = True
    spawned = ensure_server()

    # 全程在副本上操作：本例最后会 /api/save 写回当前文件，不能拿正式样本开刀
    work = ROOT / "tmp" / "smoke"
    work.mkdir(parents=True, exist_ok=True)
    target = sys.argv[2] if len(sys.argv) > 2 else "samples/sample_text.pdf"
    src = Path(target)
    src = src if src.is_absolute() else ROOT / src
    dst = work / src.name
    # 直接覆盖写，避免 unlink 在部分环境里被回收站机制拦截
    dst.write_bytes(src.read_bytes())
    target = str(dst)

    opened = call("/api/open", {"path": target})
    ok_all &= check("POST /api/open", opened.get("ok") is True, str(dst.relative_to(ROOT)))

    d = call("/api/doc")
    ok_all &= check("GET /api/doc", d.get("ok") and d["data"]["page_count"] >= 1)

    objs = call("/api/page/0/objects")["data"]
    ok_all &= check(
        "GET /api/page/0/objects",
        objs["texts"]["count"] > 0,
        f"type={objs['type']} texts={objs['texts']['count']} images={objs['images']['count']}",
    )

    png = call("/api/page/0.png?dpi=80", raw=True)
    ok_all &= check("GET /api/page/0.png", png[:4] == b"\x89PNG" and len(png) > 5000, f"{len(png)} bytes")

    # 缓存策略：位图可以长期缓存（URL 带 rev），JSON 接口必须实时
    _, png_hdr = _head("/api/page/0.png?dpi=80")
    ok_all &= check("页面位图允许浏览器缓存", "max-age=" in (png_hdr.get("Cache-Control") or ""),
                    str(png_hdr.get("Cache-Control")))
    _, json_hdr = _head("/api/doc")
    ok_all &= check("JSON 接口不缓存", "no-store" in (json_hdr.get("Cache-Control") or ""),
                    str(json_hdr.get("Cache-Control")))

    # 同参数位图第二次应该走后端内存缓存（第一次 40~80ms，这时应 < 15ms）
    t0 = time.perf_counter()
    call("/api/page/0.png?dpi=80", raw=True)
    warm = (time.perf_counter() - t0) * 1000
    ok_all &= check("重复请求同一张位图命中缓存", warm < 25, f"第二次 {warm:.1f} ms")

    thumb = call("/api/page/0/thumb.png?w=120", raw=True)
    ok_all &= check("GET thumb.png", thumb[:4] == b"\x89PNG")

    # OCR 检索只在扫描件上有意义：临时切到扫描样本，再切回来
    scan = work / "sample_scan.pdf"
    scan.write_bytes((ROOT / "samples" / "sample_scan.pdf").read_bytes())
    call("/api/open", {"path": str(scan)})
    s = call("/api/search", {"query": "恒信"})["data"]
    ok_all &= check("POST /api/search (OCR)", s["total"] >= 1, f"hits={s['total']} ocr_pages={s['ocr_pages']}")
    call("/api/open", {"path": target})

    first_text = objs["texts"]["items"][0]
    upd = call("/api/text", {"page": 0, "id": first_text["id"], "text": "采购合同（已复核）"}, method="PUT")["data"]
    ok_all &= check("PUT /api/text", "bbox" in upd, str(upd.get("bbox")))

    added = call("/api/text", {"page": 0, "text": "API 插入测试", "rect": [330, 620, 520, 660], "font_size": 14})["data"]
    ok_all &= check("POST /api/text", added.get("id", "").startswith("p0:ut"), added.get("id", ""))

    ink = call("/api/ink", {"page": 0, "strokes": [{"points": [[60, 700], [140, 720], [220, 690]], "color": "#1a73e8", "width": 3}]})["data"]
    ok_all &= check("POST /api/ink", ink["added"] == 1)

    era = call("/api/ink/erase", {"page": 0, "points": [[140, 715]], "radius": 12})["data"]
    ok_all &= check("POST /api/ink/erase", era["removed"] >= 1, str(era))

    # 页面级橡皮：擦的是页面原有内容，不只是自己画的笔迹
    er2 = call("/api/erase", {"page": 0, "points": [[120, 300], [260, 300]], "radius": 14})["data"]
    ok_all &= check("POST /api/erase（擦页面内容）",
                    er2["covered"] >= 1, f"covered={er2['covered']} 文字={er2['removed_text_count']} 笔迹={er2['strokes_removed']}")

    ext = call("/api/extract", {})["data"]
    ok_all &= check("POST /api/extract", "采购合同" in ext["text"], f"{ext['total_chars']} chars")

    saved = call("/api/save", {"path": None})["data"]
    ok_all &= check("POST /api/save", saved["size"] > 1000, f"{saved['size']} bytes")

    caps = call("/api/caps")["data"]
    ok_all &= check("GET /api/caps", "text.transform" in caps.get("caps", []), f"{len(caps.get('caps', []))} 项能力")

    und = call("/api/undo", {})["data"]
    ok_all &= check("POST /api/undo", und.get("undone") is True)

    # ---- 多文档 / 新建 / 插入 PDF ----
    docs = call("/api/docs")["data"]
    ok_all &= check("GET /api/docs", len(docs["docs"]) >= 1, f"{len(docs['docs'])} 个文档")

    newd = call("/api/new", {"size": "a4", "pages": 1})["data"]
    ok_all &= check("POST /api/new 显式返回 path=None", newd.get("path") is None and newd["page_count"] == 1,
                    f"doc={newd.get('doc_id')}")
    new_id = newd.get("doc_id")

    imp = call("/api/page/import", {"path": "samples/sample_text.pdf", "pages": "all", "at": 1, "doc": new_id})["data"]
    ok_all &= check("POST /api/page/import", imp["imported_count"] == 2 and imp["page_count"] == 3,
                    f"插入 {imp['imported_count']} 页 → 共 {imp['page_count']} 页")

    first_id = docs["docs"][0]["doc_id"]
    act = call("/api/doc/activate", {"doc": first_id})["data"]
    ok_all &= check("POST /api/doc/activate", act.get("page_count", 0) >= 1,
                    f"切到 {first_id}, {act.get('page_count')} 页")

    if spawned is not None:
        spawned.terminate()

    print("\n结果:", "全部通过" if ok_all else "有失败项")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
