"""Fixed JSON adapter for Paper Search's pinned PyMuPDF4LLM runtime."""

from __future__ import annotations

import contextlib
import importlib.metadata
import io
import json
import os
import sys
import time
from typing import Any


PROTOCOL = "paper-search.pymupdf4llm"
VERSION = 1
REQUEST_LIMIT = 64 * 1024


class AdapterFailure(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def response(ok: bool, **payload: Any) -> dict[str, Any]:
    return {"protocol": PROTOCOL, "version": VERSION, "ok": ok, **payload}


def failure(code: str, message: str) -> dict[str, Any]:
    return response(False, error={"code": code, "message": message})


def read_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
    if len(raw) > REQUEST_LIMIT:
        raise AdapterFailure("SIDECAR_PROTOCOL_ERROR", "The parser request is too large")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AdapterFailure("SIDECAR_PROTOCOL_ERROR", "The parser request is invalid") from error
    if not isinstance(value, dict):
        raise AdapterFailure("SIDECAR_PROTOCOL_ERROR", "The parser request must be an object")
    if value.get("protocol") != PROTOCOL or value.get("version") != VERSION:
        raise AdapterFailure("SIDECAR_PROTOCOL_ERROR", "The parser request protocol is incompatible")
    if value.get("operation") != "to_markdown":
        raise AdapterFailure("SIDECAR_PROTOCOL_ERROR", "The parser operation is unsupported")
    payload = value.get("input")
    if not isinstance(payload, dict) or set(payload) != {"path", "ocr"}:
        raise AdapterFailure("SIDECAR_PROTOCOL_ERROR", "The parser input shape is invalid")
    if not isinstance(payload.get("path"), str) or not os.path.isabs(payload["path"]):
        raise AdapterFailure("SIDECAR_PROTOCOL_ERROR", "The parser PDF path is invalid")
    if not isinstance(payload.get("ocr"), bool):
        raise AdapterFailure("SIDECAR_PROTOCOL_ERROR", "The parser OCR option is invalid")
    return payload


def extract(payload: dict[str, Any]) -> dict[str, Any]:
    if payload["ocr"]:
        raise AdapterFailure(
            "OCR_UNAVAILABLE",
            "OCR is not installed in the pinned PyMuPDF4LLM runtime",
        )

    captured_stdout = io.StringIO()
    captured_stderr = io.StringIO()
    started = time.monotonic()
    try:
        with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
            import pymupdf
            import pymupdf4llm
    except (ImportError, ModuleNotFoundError) as error:
        raise AdapterFailure(
            "DEPENDENCY_MISSING",
            "The pinned PyMuPDF4LLM dependency set is incomplete",
        ) from error

    document = None
    try:
        with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
            document = pymupdf.open(payload["path"])
            if not document.is_pdf:
                raise AdapterFailure("INVALID_PDF", "The authorized file is not a PDF")
            if document.needs_pass:
                raise AdapterFailure(
                    "ENCRYPTED_PDF",
                    "The PDF requires a password and cannot be extracted",
                )
            page_count = document.page_count
            markdown = pymupdf4llm.to_markdown(
                document,
                write_images=False,
                embed_images=False,
                ignore_images=True,
                ignore_graphics=False,
                force_text=True,
                page_chunks=False,
                page_separators=False,
                table_strategy="lines_strict",
                show_progress=False,
            )
    except AdapterFailure:
        raise
    except Exception as error:
        name = type(error).__name__.lower()
        message = str(error).lower()
        if "password" in message or "encrypted" in message:
            raise AdapterFailure(
                "ENCRYPTED_PDF",
                "The PDF is encrypted and cannot be extracted",
            ) from error
        if "filedataerror" in name or "format error" in message or "cannot open" in message:
            raise AdapterFailure("INVALID_PDF", "The PDF is invalid or damaged") from error
        raise AdapterFailure(
            "EXTRACTION_FAILED",
            "PyMuPDF4LLM could not extract this PDF",
        ) from error
    finally:
        if document is not None:
            document.close()

    if not isinstance(markdown, str) or not markdown.strip():
        raise AdapterFailure("EMPTY_MARKDOWN", "PyMuPDF4LLM returned no usable Markdown")
    replacement_count = markdown.count("\ufffd")
    if replacement_count > max(20, len(markdown) // 100):
        raise AdapterFailure(
            "OCR_UNAVAILABLE",
            "The PDF text encoding is unreadable and the pinned runtime has no OCR engine",
        )

    captured = [
        line.strip()
        for line in (captured_stdout.getvalue() + "\n" + captured_stderr.getvalue()).splitlines()
        if line.strip()
    ]
    warnings: list[dict[str, str]] = [
        {
            "code": "OFFICIAL_LEGACY_MARKDOWN",
            "message": (
                "Using the official AGPL PyMuPDF4LLM Markdown pipeline without "
                "the separately licensed optional Layout extension."
            ),
        }
    ]
    unexpected_count = sum(
        1 for line in captured if "pymupdf_layout" not in line and "improved page layout" not in line
    )
    if unexpected_count:
        warnings.append(
            {
                "code": "PARSER_DIAGNOSTIC",
                "message": f"The parser emitted {unexpected_count} additional diagnostic message(s).",
            }
        )

    return response(
        True,
        markdown=markdown,
        metadata={
            "parser": {
                "name": "pymupdf4llm",
                "version": importlib.metadata.version("pymupdf4llm"),
                "pymupdfVersion": importlib.metadata.version("pymupdf"),
                "mode": "official-legacy-markdown",
                "license": "Dual Licensed - GNU AFFERO GPL 3.0 or Artifex Commercial License",
            },
            "pageCount": page_count,
            "ocr": False,
            "images": "disabled",
            "tableStrategy": "lines_strict",
            "warnings": warnings,
            "elapsedMs": round((time.monotonic() - started) * 1000),
        },
    )


def main() -> None:
    try:
        payload = extract(read_request())
    except AdapterFailure as error:
        payload = failure(error.code, error.message)
    except Exception:
        payload = failure("EXTRACTION_FAILED", "The local PDF parser failed unexpectedly")
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
