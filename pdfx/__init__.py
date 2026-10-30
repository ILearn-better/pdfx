"""pdfx —— 统一处理结构化 PDF 与扫描件 PDF 的编辑/检索工具包。

核心约定（全库统一，AI 与前端都依赖它）：
- 坐标单位：PDF 点（1pt = 1/72 inch），原点在页面左上角，x 向右、y 向下。
- 文本对象来源 source: "text"（PDF 原生文本层）| "ocr"（识别得到）| "user"（用户插入）
- 图片对象来源 source: "pdf"（PDF 原有）| "user"（用户插入）
- 所有对外接口返回统一的 JSON 信封 {"ok": bool, "data": ..., "warnings": [...], "error": ...}
"""

from __future__ import annotations

from typing import Any

from .doc import PDFDocument
from .util import PdfxError, __version__

__all__ = ["PDFDocument", "open_doc", "PdfxError", "__version__"]


def open_doc(path: str | None = None, **kwargs: Any) -> PDFDocument:
    """打开（path 为空则新建）一份文档。"""
    return PDFDocument(path, **kwargs)
