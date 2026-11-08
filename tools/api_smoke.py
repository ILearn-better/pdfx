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

    # 界面上拖角放大走的就是 PUT + rect：字必须留在框内，字号跟着框走
    bb = added["bbox"]
    box = [bb[0], bb[1], bb[0] + (bb[2] - bb[0]) * 1.6, bb[1] + (bb[3] - bb[1]) * 1.6]
    rz = call("/api/text", {"page": 0, "id": added["id"], "rect": box, "font_size": 14 * 1.6},
              method="PUT")["data"]
    ok_all &= check("PUT /api/text 放大后不越框",
                    rz["bbox"][2] <= box[2] + 1.5 and rz["bbox"][3] <= box[3] + 1.5,
                    f"bbox={[round(v, 1) for v in rz['bbox']]} 框={[round(v, 1) for v in box]}")
    ok_all &= check("PUT /api/text 放大后字号联动", abs(rz["font_size"] - 14 * 1.6) < 0.6,
                    f"14.0 → {rz['font_size']:.1f}pt")

    ink = call("/api/ink", {"page": 0, "strokes": [{"points": [[60, 700], [140, 720], [220, 690]], "color": "#1a73e8", "width": 3}]})["data"]
    ok_all &= check("POST /api/ink", ink["added"] == 1)

    era = call("/api/ink/erase", {"page": 0, "points": [[140, 715]], "radius": 12})["data"]
    ok_all &= check("POST /api/ink/erase", era["removed"] >= 1, str(era))

    # 橡皮接口默认只切笔迹。擦页面原有内容是不可逆的破坏性操作，
    # 必须显式 allow_content=True 才放行 —— 老前端没刷新页面也伤不到正文。
    t_before = call("/api/page/0/objects?ocr=0")["data"]["texts"]["count"]
    call("/api/ink", {"page": 0, "strokes": [
        {"points": [[120, 300], [190, 302], [260, 300]], "color": "#d64545", "width": 3}]})
    guard = call("/api/erase", {"page": 0, "points": [[120, 300], [260, 300]], "radius": 10})["data"]
    ok_all &= check("POST /api/erase 默认只擦笔迹",
                    guard.get("removed", 0) >= 1 and "covered" not in guard, str(guard))
    t_after = call("/api/page/0/objects?ocr=0")["data"]["texts"]["count"]
    ok_all &= check("默认擦除不碰正文", t_after == t_before, f"{t_before} → {t_after}")

    # 显式允许后才擦页面内容（CLI / AI 用这条路）
    er2 = call("/api/erase", {"page": 0, "points": [[120, 300], [260, 300]], "radius": 14,
                              "allow_content": True})["data"]
    ok_all &= check("allow_content 显式开启才擦页面内容",
                    er2["covered"] >= 1, f"covered={er2['covered']} 文字={er2['removed_text_count']}")

    # ---- 图片：插入 → 删除 → 同一位置再插入 ----
    # 界面点「删除」不会传 mode。接口默认值必须是真删（purge），
    # 否则图只是被纸色盖住，保存后原图仍在文件里，之后再插图也容易认错旧实例。
    img = call("/api/image", {"page": 0, "rect": [100, 400, 220, 480], "path": "samples/logo.png"})["data"]
    ok_all &= check("POST /api/image", str(img.get("id", "")).startswith("p0:ui"),
                    f"{img.get('id')} {img.get('bbox')}")

    gone = call("/api/image", {"page": 0, "id": img["id"]}, method="DELETE")["data"]
    ok_all &= check("DELETE /api/image 不带 mode 也真删", gone.get("mode") == "purged", str(gone.get("mode")))

    left = call("/api/image?page=0")["data"]["items"]
    ok_all &= check("删完之后图片列表里没有它", all(i["id"] != img["id"] for i in left),
                    f"{len(left)} 项")

    again = call("/api/image", {"page": 0, "rect": [100, 400, 220, 480], "path": "samples/logo.png"})["data"]
    ok_all &= check("同一位置还能再插一张（bbox 落在指定位置）",
                    again.get("id") != img["id"] and abs(again["bbox"][0] - 100) < 2,
                    f"{again.get('id')} {again.get('bbox')}")

    # ---- 复制图片：界面 Ctrl+C 要把图拿成 PNG ----
    raw = call(f"/api/image/raw?page=0&id={again['id']}", raw=True)
    ok_all &= check("GET /api/image/raw 返回 PNG",
                    raw[:8] == b"\x89PNG\r\n\x1a\n" and len(raw) > 200, f"{len(raw)} bytes")
    bad_code = 0
    try:
        call("/api/image/raw?page=0&id=p0:i@9999,9999", raw=True)
    except urllib.error.HTTPError as exc:
        bad_code = exc.code
    ok_all &= check("GET /api/image/raw 找不到对象时给 400", bad_code == 400, f"HTTP {bad_code}")

    # 页面删除放到最后、在新文档上做：删的是第 0 页，主文档还要靠它出文字
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

    pg = call("/api/page", {"pages": [0], "doc": new_id}, method="DELETE")["data"]
    ok_all &= check("DELETE /api/page 删掉一页", pg["page_count"] == 2,
                    f"3 → {pg['page_count']} 页")

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
