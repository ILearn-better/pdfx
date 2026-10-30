"""OCR 层：把扫描页/图片页转成带坐标的文本块。

引擎可插拔，按下面的优先级自动选择（探测结果会缓存，避免每次都踩坑）：
  1. rapidocr  —— 精度最好，需要 onnxruntime
  2. windows   —— Windows 10/11 自带 OCR，零依赖，中文打印体识别可靠
  3. tesseract —— 系统已装则用

三者都不可用时抛 PdfxError("ocr_unavailable")，上层自动降级为"只处理文本层"。

输出统一为行级文本块（含单词级坐标），坐标已换算回 PDF 点（左上原点），
与文本层对象同构 —— 上层完全不需要关心文字到底来自 OCR 还是原生文本层。
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .util import PDFX_HOME, PdfxError, clean_text, norm_rect

CACHE_VERSION = 4
PROBE_TTL = 7 * 24 * 3600


def _is_cjk(ch: str) -> bool:
    if not ch:
        return False
    o = ord(ch)
    return (
        0x2E80 <= o <= 0x9FFF
        or 0xF900 <= o <= 0xFAFF
        or 0xFF00 <= o <= 0xFFEF
        or 0x3000 <= o <= 0x303F
    )


@dataclass
class OcrLine:
    bbox: list[float]
    text: str
    score: float = 1.0
    quad: list[list[float]] | None = None
    words: list[dict] | None = None
    line_no: int = 0

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "bbox": [round(v, 2) for v in self.bbox],
            "text": self.text,
            "score": round(self.score, 3),
        }
        if self.quad:
            d["quad"] = [[round(p[0], 1), round(p[1], 1)] for p in self.quad]
        if self.words:
            d["words"] = self.words
        return d


def compose_line(words: list[dict]) -> str:
    """把单词序列拼成行文本：中文之间不留空格，英文按几何间距补空格。"""
    if not words:
        return ""
    parts: list[str] = []
    for i, w in enumerate(words):
        if i:
            prev = words[i - 1]
            gap = float(w["x"]) - (float(prev["x"]) + float(prev["w"]))
            last = (prev.get("text") or "")[-1:]
            first = (w.get("text") or "")[:1]
            h = max(float(w.get("h") or 1), float(prev.get("h") or 1), 1.0)
            if _is_cjk(last) or _is_cjk(first):
                sep = ""
            elif gap > 0.28 * h:
                sep = " "
            else:
                sep = ""
            parts.append(sep)
        parts.append(w.get("text") or "")
    return "".join(parts)


class OcrEngine:
    """单例式 OCR 引擎，延迟加载模型。"""

    _registry: dict[str, "OcrEngine"] = {}

    def __init__(self, backend: str = "auto", lang: str = "") -> None:
        self.requested = backend or "auto"
        self.lang = lang
        self.backend = "none"
        self._impl: Any = None
        self._detail = ""
        self._failed: set[str] = set()

    @classmethod
    def get(cls, backend: str = "auto", lang: str = "") -> "OcrEngine":
        key = f"{backend}|{lang}"
        if key not in cls._registry:
            cls._registry[key] = cls(backend, lang)
        return cls._registry[key]

    # ------------------------------------------------------------------ 探测
    @staticmethod
    def _probe_file() -> Path:
        return PDFX_HOME / "ocr_probe.json"

    @classmethod
    def _probe(cls) -> dict[str, bool]:
        """用子进程探测 rapidocr（onnxruntime 崩溃会拖死主进程，必须隔离）。"""
        f = cls._probe_file()
        cached: dict[str, Any] = {}
        try:
            if f.exists():
                cached = json.loads(f.read_text(encoding="utf-8"))
                if time.time() - float(cached.get("ts", 0)) < PROBE_TTL:
                    return dict(cached.get("result", {}))
        except Exception:
            pass

        result: dict[str, bool] = {}
        code = "import onnxruntime, rapidocr; print('OK')"
        try:
            r = subprocess.run(
                [sys.executable, "-c", code],
                capture_output=True,
                text=True,
                timeout=90,
            )
            result["rapidocr"] = r.returncode == 0 and "OK" in (r.stdout or "")
        except Exception:
            result["rapidocr"] = False

        result["windows"] = platform.system() == "Windows" and (Path(__file__).parent / "win_ocr.ps1").exists()
        result["tesseract"] = bool(shutil.which("tesseract"))

        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps({"ts": time.time(), "result": result}), encoding="utf-8")
        except Exception:
            pass
        return result

    def _load(self) -> None:
        if self._impl is not None:
            return
        if self.requested not in ("auto", ""):
            order = [self.requested]
        else:
            probe = self._probe()
            order = [n for n in ("rapidocr", "windows", "tesseract") if probe.get(n)]

        errors: list[str] = []
        for name in order:
            if name in self._failed:
                continue
            try:
                if name == "rapidocr":
                    from rapidocr import RapidOCR  # type: ignore

                    self._impl = RapidOCR()
                    self.backend = "rapidocr"
                    self._detail = "RapidOCR (ONNX, 中英文, 行级+四点框)"
                    return
                if name == "windows":
                    script = Path(__file__).parent / "win_ocr.ps1"
                    if not script.exists():
                        errors.append("windows: 缺少 win_ocr.ps1")
                        continue
                    ps = shutil.which("powershell.exe") or shutil.which("powershell")
                    if not ps:
                        errors.append("windows: powershell 不可用")
                        continue
                    self._impl = ps
                    self.backend = "windows"
                    self._detail = "Windows.Media.Ocr (系统内置, 中文打印体)"
                    return
                if name == "tesseract":
                    exe = shutil.which("tesseract")
                    if not exe:
                        errors.append("tesseract: 未安装")
                        continue
                    self._impl = exe
                    self.backend = "tesseract"
                    self._detail = f"Tesseract ({exe})"
                    return
            except Exception as exc:
                errors.append(f"{name}: {exc}")

        raise PdfxError(
            "OCR 引擎不可用。" + ("；".join(errors) if errors else "未检测到可用后端"),
            "ocr_unavailable",
            hint="Windows: 系统自带 OCR 应可用；其他平台可 pip install rapidocr onnxruntime",
        )

    @property
    def available(self) -> bool:
        try:
            self._load()
            return True
        except PdfxError:
            return False

    def info(self) -> dict[str, Any]:
        try:
            self._load()
            return {"available": True, "backend": self.backend, "detail": self._detail}
        except PdfxError as exc:
            return {"available": False, "backend": "none", "error": str(exc)}

    # ------------------------------------------------------------------ 推理
    def recognize(self, image, scale: float) -> list[OcrLine]:
        """image: numpy HxWx3 (RGB uint8)；scale: 像素 → pt 的除数（dpi/72）。"""
        self._load()
        try:
            if self.backend == "rapidocr":
                raw = self._run_rapid(image)
            elif self.backend == "windows":
                raw = self._run_windows(image)
            elif self.backend == "tesseract":
                raw = self._run_tesseract(image)
            else:
                raise PdfxError("OCR 引擎不可用", "ocr_unavailable")
        except PdfxError:
            raise
        except Exception as exc:
            raise PdfxError(f"OCR 识别失败({self.backend}): {exc}", "ocr_failed")
        return self._to_lines(raw, scale)

    def _to_lines(self, raw: list[tuple], scale: float) -> list[OcrLine]:
        lines: list[OcrLine] = []
        for i, item in enumerate(raw):
            words, score = item
            if not words:
                continue
            text = clean_text(compose_line(words))
            if not text:
                continue
            pts: list[list[float]] = []
            for w in words:
                x, y, ww, hh = float(w["x"]), float(w["y"]), float(w["w"]), float(w["h"])
                pts.extend([[x / scale, y / scale], [(x + ww) / scale, (y + hh) / scale]])
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            bbox = norm_rect([min(xs), min(ys), max(xs), max(ys)])
            norm_words = [
                {
                    "text": w["text"],
                    "x": round(float(w["x"]) / scale, 2),
                    "y": round(float(w["y"]) / scale, 2),
                    "w": round(float(w["w"]) / scale, 2),
                    "h": round(float(w["h"]) / scale, 2),
                }
                for w in words
            ]
            lines.append(OcrLine(bbox=bbox, text=text, score=score, words=norm_words, line_no=i))
        lines.sort(key=lambda l: (round(l.bbox[1] / 6), l.bbox[0]))
        for i, l in enumerate(lines):
            l.line_no = i
        return lines

    # -- rapidocr ---------------------------------------------------------
    def _run_rapid(self, image) -> list[tuple[list[dict], float]]:
        out = self._impl(image)
        boxes = getattr(out, "boxes", None)
        txts = getattr(out, "txts", None)
        scores = getattr(out, "scores", None)
        res: list[tuple[list[dict], float]] = []
        if boxes is not None and txts is not None:
            for b, t, s in zip(boxes, txts, scores if scores is not None else [1.0] * len(txts)):
                xs = [float(p[0]) for p in b]
                ys = [float(p[1]) for p in b]
                w = {"text": str(t), "x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}
                res.append(([w], float(s)))
            return res
        data = out[0] if isinstance(out, tuple) else out
        for item in data or []:
            try:
                b, t, s = item[0], item[1], item[2]
            except Exception:
                continue
            xs = [float(p[0]) for p in b]
            ys = [float(p[1]) for p in b]
            w = {"text": str(t), "x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}
            res.append(([w], float(s)))
        return res

    # -- windows ----------------------------------------------------------
    def _run_windows(self, image) -> list[tuple[list[dict], float]]:
        from PIL import Image  # 延迟导入

        script = Path(__file__).parent / "win_ocr.ps1"
        with tempfile.TemporaryDirectory() as td:
            img = Path(td) / "p.png"
            out = Path(td) / "o.json"
            Image.fromarray(image).save(img)
            cmd = [
                self._impl,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script),
                "-ImagePath",
                str(img),
                "-OutFile",
                str(out),
            ]
            if self.lang:
                cmd += ["-Lang", self.lang]
            r = subprocess.run(cmd, capture_output=True, timeout=180, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if not out.exists():
                raise PdfxError(
                    f"Windows OCR 无输出: {(r.stderr or b'').decode('utf-8', 'ignore')[:200]}",
                    "ocr_failed",
                )
            data = json.loads(out.read_text(encoding="utf-8"))
        if not data.get("ok"):
            raise PdfxError(f"Windows OCR 失败: {data.get('error')} {data.get('message', '')}", "ocr_failed")

        res: list[tuple[list[dict], float]] = []
        for line in data.get("lines", []):
            words = [
                {"text": w["text"], "x": w["x"], "y": w["y"], "w": w["w"], "h": w["h"]}
                for w in line.get("words", [])
                if str(w.get("text", "")).strip()
            ]
            if words:
                res.append((words, 0.95))
        return res

    # -- tesseract --------------------------------------------------------
    def _run_tesseract(self, image) -> list[tuple[list[dict], float]]:
        from PIL import Image

        langs: list[str] = []
        try:
            r = subprocess.run([self._impl, "--list-langs"], capture_output=True, text=True, timeout=30)
            langs = [x.strip() for x in (r.stdout or "").splitlines()[1:] if x.strip()]
        except Exception:
            pass
        want = self.lang or ("chi_sim+eng" if ("chi_sim" in langs and "eng" in langs) else ("chi_sim" if "chi_sim" in langs else "eng"))

        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "p.png"
            Image.fromarray(image).save(p)
            base = Path(td) / "out"
            subprocess.run(
                [self._impl, str(p), str(base), "-l", want, "--psm", "3", "tsv"],
                capture_output=True,
                timeout=300,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            tsv = base.with_suffix(".tsv")
            if not tsv.exists():
                return []
            rows = tsv.read_text(encoding="utf-8", errors="ignore").splitlines()[1:]

        groups: dict[tuple, list[dict]] = {}
        confs: dict[tuple, list[float]] = {}
        for row in rows:
            f = row.split("\t")
            if len(f) < 12:
                continue
            try:
                key = (int(f[1]), int(f[2]), int(f[3]), int(f[4]))
                conf = float(f[10]) if f[10] not in ("", "-1") else 0.0
            except ValueError:
                continue
            word = f[11].strip()
            if not word or conf < 0:
                continue
            groups.setdefault(key, []).append(
                {"text": word, "x": int(f[6]), "y": int(f[7]), "w": int(f[8]), "h": int(f[9])}
            )
            confs.setdefault(key, []).append(conf)
        res: list[tuple[list[dict], float]] = []
        for key in sorted(groups, key=lambda k: (k[1], k[0])):
            res.append((groups[key], sum(confs[key]) / (100.0 * len(confs[key]))))
        return res


# ---------------------------------------------------------------------- 缓存

class OcrCache:
    def __init__(self, cache_dir: Path) -> None:
        self.dir = cache_dir
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

    def _file(self, page_no: int, dpi: int, digest: str, backend: str) -> Path:
        raw = f"v{CACHE_VERSION}|{backend}|p{page_no}|dpi{dpi}|{digest}"
        return self.dir / f"{hashlib.sha1(raw.encode()).hexdigest()[:24]}.json"

    def get(self, page_no: int, dpi: int, digest: str, backend: str) -> list[OcrLine] | None:
        f = self._file(page_no, dpi, digest, backend)
        if not f.exists():
            return None
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            return [OcrLine(**d) for d in data]
        except Exception:
            return None

    def put(self, page_no: int, dpi: int, digest: str, backend: str, lines: Iterable[OcrLine]) -> None:
        f = self._file(page_no, dpi, digest, backend)
        try:
            payload = [
                {"bbox": l.bbox, "text": l.text, "score": l.score, "quad": l.quad, "words": l.words, "line_no": l.line_no}
                for l in lines
            ]
            f.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    def clear(self) -> int:
        n = 0
        for p in self.dir.glob("*.json"):
            try:
                p.unlink()
                n += 1
            except OSError:
                pass
        return n
