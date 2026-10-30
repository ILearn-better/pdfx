"""把 pdfx 安装成一个自包含的 WorkBuddy Skill。

安装结果：
    ~/.workbuddy/skills/pdf-toolkit/
        SKILL.md          技能说明（AI 读取）
        README.md         给人看的完整文档
        启动PDF工具.bat    双击启动可视化编辑器（GBK/CRLF）
        pdfx/             核心包
        web/              前端编辑器
        run.py            入口
        bin/pdfx(.cmd)    命令行启动器
        samples/          示例 PDF
        tools/            自测脚本 + bat 构建脚本

改完源码后重新跑一次本脚本即可同步。

    python tools/install_skill.py [目标目录]
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TARGET = Path.home() / ".workbuddy" / "skills" / "pdf-toolkit"

RUN_PY = '''"""pdfx 入口（skill 安装副本）。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from pdfx.cli import main

if __name__ == "__main__":
    sys.exit(main())
'''

CMD = """@echo off
setlocal
python "%~dp0..\\run.py" %*
"""

SH = """#!/usr/bin/env bash
exec python "$(cd "$(dirname "$0")/.." && pwd)/run.py" "$@"
"""


def copy_tree(src: Path, dst: Path, ignore=("__pycache__", ".pyc", "tmp", "wheels")) -> None:
    if not src.exists():
        return
    if dst.exists():
        shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(
        src,
        dst,
        ignore=shutil.ignore_patterns(*ignore),
    )


def main() -> int:
    target = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else DEFAULT_TARGET

    if not (ROOT / "pdfx" / "cli.py").exists():
        print(f"[x] 找不到源码：{ROOT}")
        return 1

    target.mkdir(parents=True, exist_ok=True)
    print(f"[*] 安装到 {target}")

    copy_tree(ROOT / "pdfx", target / "pdfx")
    copy_tree(ROOT / "web", target / "web")
    copy_tree(ROOT / "samples", target / "samples")

    # 自测与文档一起随包安装，方便换机器后立刻验证环境
    tools_dir = target / "tools"
    tools_dir.mkdir(exist_ok=True)
    for name in ("selftest.py", "api_smoke.py", "make_samples.py", "build_bat.py", "launch.bat.src", "uitest.mjs"):
        src = ROOT / "tools" / name
        if src.exists():
            shutil.copy2(src, tools_dir / name)
    if (ROOT / "README.md").exists():
        shutil.copy2(ROOT / "README.md", target / "README.md")

    # 双击启动器：原样二进制复制（GBK 编码不能经过文本读写）
    bat = ROOT / "启动PDF工具.bat"
    if bat.exists():
        shutil.copy2(bat, target / "启动PDF工具.bat")
    else:
        print("[!] 缺少 启动PDF工具.bat，先跑 python tools/build_bat.py")

    skill_md = ROOT / "skill" / "SKILL.md"
    if skill_md.exists():
        shutil.copy2(skill_md, target / "SKILL.md")
    else:
        print("[!] 缺少 skill/SKILL.md")

    (target / "run.py").write_text(RUN_PY, encoding="utf-8")

    bin_dir = target / "bin"
    bin_dir.mkdir(exist_ok=True)
    (bin_dir / "pdfx.cmd").write_text(CMD, encoding="utf-8")
    sh = bin_dir / "pdfx"
    sh.write_text(SH, encoding="utf-8")
    try:
        sh.chmod(sh.stat().st_mode | stat.S_IEXEC)
    except Exception:
        pass

    readme = target / "README.txt"
    readme.write_text(
        "pdfx — PDF 编辑与扫描件 OCR\n"
        "============================\n\n"
        "最快用法：双击 启动PDF工具.bat\n"
        "  - 直接双击          启动空白编辑器\n"
        "  - 把 PDF 拖到它上面  直接打开该文件\n"
        "  - 启动PDF工具.bat -check   只检查环境\n\n"
        "命令行用法（任选）：\n"
        "  bin\\pdfx.cmd describe \"D:\\a.pdf\"      (Windows)\n"
        "  bin/pdfx describe \"D:/a.pdf\"           (Git Bash)\n"
        "  python run.py --help\n\n"
        "启动可视化编辑器：\n"
        "  python run.py serve \"D:\\a.pdf\" --port 8765\n\n"
        "自检（确认环境可用）：\n"
        "  python tools\\selftest.py     端到端 38 项\n"
        "  python tools\\api_smoke.py    HTTP 13 项（自动起停服务）\n\n"
        "技能说明见 SKILL.md，完整文档见 README.md。\n",
        encoding="utf-8",
    )

    # 自检
    sys.path.insert(0, str(target))
    try:
        from pdfx import __version__  # noqa: F401

        print(f"[+] 安装完成，版本 {__version__}")
        print(f"[+] 试运行： {bin_dir / 'pdfx.cmd'} --version")
        return 0
    except Exception as exc:
        print(f"[x] 安装后导入失败：{exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
