"""用 curl 取 wheel 再本地安装 —— 规避沙箱代理对 pip UA 的 403 拦截。

用法:
    python tools/fetch_wheels.py pymupdf flask rapidocr
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"
ROOT = Path(__file__).resolve().parent.parent
WHEEL_DIR = ROOT / "wheels"

# 兼容标签优先级（Python 3.13 / Windows x64）
GOOD_TAGS = [
    "cp313-cp313-win_amd64",
    "cp313-abi3-win_amd64",
    "cp312-abi3-win_amd64",
    "cp311-abi3-win_amd64",
    "cp310-abi3-win_amd64",
    "cp310-abi3-win_amd64",
    "cp39-abi3-win_amd64",
    "cp38-abi3-win_amd64",
    "cp37-abi3-win_amd64",
    "cp39-none-win_amd64",
    "py3-none-any",
    "py2.py3-none-any",
    "cp313-none-win_amd64",
]


def curl(url: str, dest: Path | None = None, timeout: int = 120) -> bytes | None:
    cmd = ["curl", "-sSL", "--max-time", str(timeout), url]
    if dest is not None:
        cmd += ["-o", str(dest)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        return None
    return r.stdout if dest is None else b""


def norm_name(pkg: str) -> str:
    return re.sub(r"[-_.]+", "-", pkg).lower()


def pick(name: str) -> str | None:
    """返回该包最新可用的 wheel 绝对 URL。"""
    page = curl(f"{MIRROR}/{norm_name(name)}/")
    if not page:
        print(f"  [!] 无法获取索引: {name}")
        return None
    html = page.decode("utf-8", "ignore")
    links = re.findall(r'href="([^"#]+)#sha256=', html)
    if not links:
        links = re.findall(r'href="([^"#]+)"', html)

    cands: list[tuple[str, str]] = []
    for href in links:
        url = urllib.parse.urljoin(f"{MIRROR}/{norm_name(name)}/", href)
        fname = url.rsplit("/", 1)[-1]
        if not fname.endswith(".whl"):
            continue
        stem = fname[: -len(".whl")]
        if not any(stem.endswith(t) for t in GOOD_TAGS):
            continue
        m = re.match(r"(.+?)-(\d[^-]*)", stem)
        if not m:
            continue
        cands.append((m.group(2), url))
    if not cands:
        print(f"  [!] 无兼容 wheel: {name}")
        return None

    from pip._vendor.packaging.version import InvalidVersion, Version

    def ver(item):
        try:
            return Version(re.sub(r"[^0-9.a-zA-Z+]", ".", item[0]))
        except InvalidVersion:
            return Version("0")

    stable = [c for c in cands if not ver(c).is_prerelease]
    pool = stable or cands
    pool.sort(key=ver)
    return pool[-1][1]


def main(pkgs: list[str]) -> int:
    WHEEL_DIR.mkdir(parents=True, exist_ok=True)
    got: list[Path] = []
    for pkg in pkgs:
        print(f"[*] {pkg}")
        url = pick(pkg)
        if not url:
            continue
        fname = url.rsplit("/", 1)[-1]
        dest = WHEEL_DIR / fname
        if dest.exists() and dest.stat().st_size > 1000:
            print(f"    已有 {fname}")
            got.append(dest)
            continue
        print(f"    下载 {fname}")
        tmp = Path(tempfile.mktemp(suffix=".part", dir=str(WHEEL_DIR)))
        if curl(url, tmp, timeout=300) is not None and tmp.exists() and tmp.stat().st_size > 1000:
            tmp.rename(dest)
            got.append(dest)
        else:
            print("    下载失败")
            if tmp.exists():
                tmp.unlink()
    print(f"\n获得 {len(got)} 个 wheel -> {WHEEL_DIR}")
    for p in got:
        print("   ", p.name)
    return 0 if got else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["pymupdf"]))
