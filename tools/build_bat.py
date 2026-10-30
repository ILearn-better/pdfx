"""把 tools/launch.bat.src（UTF-8）编译成能双击的 GBK 批处理。

    python tools/build_bat.py [目标路径]

为什么要多这一步：cmd.exe 是按字节偏移逐行读取 .bat 的，文件里同时存在 UTF-8 中文
和 chcp 切换时会出现行错位（典型症状是 `'xx' is not recognized`）。所以批处理
必须存成系统默认代码页（简体中文 Windows = GBK/936），且换行必须是 CRLF。

源文件用 UTF-8 存放，便于编辑与 diff；每次改完重跑本脚本即可。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "launch.bat.src"
DEFAULT_OUT = ROOT / "启动PDF工具.bat"


def build(src: Path = SRC, out: Path = DEFAULT_OUT) -> Path:
    text = src.read_text(encoding="utf-8")
    text = text.replace("\r\n", "\n").replace("\n", "\r\n")  # cmd 只认 CRLF
    data = text.encode("gbk")  # 不能有 BOM，不能是 UTF-8
    out.write_bytes(data)
    return out


def main() -> int:
    out = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else DEFAULT_OUT
    if not SRC.exists():
        print(f"[x] 缺少源文件：{SRC}")
        return 1
    try:
        build(SRC, out)
    except UnicodeEncodeError as exc:
        print(f"[x] 源文件含 GBK 无法表示的字符：{exc}")
        return 2
    size = out.stat().st_size
    print(f"[+] 生成 {out}  ({size} 字节, GBK, CRLF)")
    print("[i] 双击即可启动；首次建议先跑  启动PDF工具.bat -check")
    return 0


if __name__ == "__main__":
    sys.exit(main())
