#!/usr/bin/env python3
"""Paper Search's bounded one-request adapter for the pinned InstSci capture."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

PROTOCOL_VERSION = 1
ADAPTER_ID = "instsci-publisher-batch"
REVISION = "836cd6b65ad74136b7a1ff17672816a3b8b789aa"
PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def response(request: dict, status: str, *, reason: str = "", message: str = "", handoff=None) -> dict:
    result = {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request.get("requestId", "invalid"),
        "adapter": {"id": ADAPTER_ID, "revision": REVISION},
        "status": status,
    }
    if reason:
        result["reasonCode"] = reason
    if message:
        result["message"] = message[:500]
    if handoff is not None:
        result["handoff"] = handoff
    return result


def checkout_probe(checkout: Path) -> tuple[bool, str, str]:
    if not checkout.is_dir() or not (checkout / "instsci" / "publisher_batch.py").is_file():
        return False, "checkout_unavailable", "Configure institutional.checkoutRoot to the pinned InstSci checkout."
    try:
        commit = subprocess.run(
            ["git", "-C", str(checkout), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if commit.returncode != 0 or commit.stdout.strip().lower() != REVISION:
            return False, "checkout_revision_mismatch", f"InstSci checkout must be pinned to commit {REVISION}."
        dirty = subprocess.run(
            ["git", "-C", str(checkout), "status", "--porcelain", "--untracked-files=no"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if dirty.returncode != 0 or dirty.stdout.strip():
            return False, "checkout_modified", "The pinned InstSci checkout has tracked local modifications; restore it before continuing."
    except (OSError, subprocess.SubprocessError):
        return False, "checkout_revision_unverifiable", "Git is required to verify the configured InstSci checkout revision."
    sys.path.insert(0, str(checkout))
    missing = [name for name in ("requests", "cloakbrowser") if importlib.util.find_spec(name) is None]
    if missing:
        return False, "dependencies_unavailable", "Install the pinned InstSci capture dependencies and CloakBrowser runtime before continuing."
    return True, "ready", "Pinned InstSci capture and Python dependencies are available."


def load_request() -> dict:
    raw = sys.stdin.buffer.readline(65537)
    if not raw or len(raw) > 65536 or sys.stdin.buffer.read(1):
        raise ValueError("one bounded request is required")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("request must be an object")
    if value.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError("protocol mismatch")
    if value.get("adapter") != {"id": ADAPTER_ID, "revision": REVISION}:
        raise ValueError("adapter mismatch")
    allowed = {"protocolVersion", "requestId", "operation", "adapter", "doi", "profileId", "handoffRoot", "maxPdfBytes"}
    if set(value) - allowed:
        raise ValueError("unexpected request fields")
    if value.get("operation") == "probe" and set(value) - {"protocolVersion", "requestId", "operation", "adapter"}:
        raise ValueError("probe contains acquisition fields")
    return value


def acquire(request: dict, checkout: Path) -> dict:
    doi = request.get("doi")
    profile_id = request.get("profileId", "default")
    handoff_root = request.get("handoffRoot")
    max_bytes = request.get("maxPdfBytes")
    if not isinstance(doi, str) or not doi.startswith("10.") or "/" not in doi:
        return response(request, "failed", reason="invalid_doi", message="A valid DOI is required.")
    if not isinstance(profile_id, str) or not PROFILE_RE.fullmatch(profile_id):
        return response(request, "failed", reason="invalid_profile", message="The institution profile id is invalid.")
    if not isinstance(handoff_root, str) or not Path(handoff_root).is_absolute():
        return response(request, "failed", reason="invalid_handoff", message="The host handoff root is invalid.")
    if not isinstance(max_bytes, int) or max_bytes < 1024:
        return response(request, "failed", reason="invalid_limit", message="The host PDF limit is invalid.")

    sys.path.insert(0, str(checkout))
    from instsci.config import Config
    from instsci.publisher_batch import PaperRecord, PublisherBatchDownloader
    from instsci.publisher_profiles import infer_publisher_profile

    publisher = infer_publisher_profile(doi)
    if publisher is None:
        return response(request, "unsupported", reason="unsupported_publisher", message="No pinned publisher workflow supports this DOI prefix.")
    config_path = Path.home() / ".instsci" / "config.json"
    if profile_id != "default":
        config_path = Path.home() / ".instsci" / "profiles" / profile_id / "config.json"
    config = Config.load(config_path)
    scratch = Path(handoff_root)
    scratch.mkdir(parents=True, exist_ok=True)
    downloader = PublisherBatchDownloader(config=config, profile=publisher)
    context = None
    try:
        context = downloader._launch_context()
        result = downloader.fetch_one(context, PaperRecord(doi=doi), scratch)
    except Exception:
        return response(request, "failed", reason="adapter_crash", message="The institutional browser workflow failed. Inspect local setup with institutional probe.")
    finally:
        if context is not None:
            try:
                context.close()
            except Exception:
                pass

    reason = str(getattr(result, "reason", "") or "").lower()
    if result.status == "success" and result.verified_match is True:
        pdf = Path(result.pdf_path)
        try:
            pdf = pdf.resolve(strict=True)
            root = scratch.resolve(strict=True)
            pdf.relative_to(root)
            payload = pdf.read_bytes()
        except (OSError, ValueError):
            return response(request, "failed", reason="invalid_adapter_handoff", message="InstSci did not return a contained PDF handoff.")
        if len(payload) > max_bytes:
            return response(request, "failed", reason="output_too_large", message="The acquired PDF exceeds the configured size limit.")
        relative = pdf.relative_to(root).as_posix()
        return response(request, "acquired", handoff={
            "relativePath": relative,
            "sizeBytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        })
    if any(marker in reason for marker in ("sso", "login", "auth", "challenge", "captcha", "timeout")):
        return response(request, "action_required", reason="login_required", message="Complete the visible institutional sign-in, then retry the continuation command.")
    if any(marker in reason for marker in ("entitl", "paywall", "access_denied", "forbidden")):
        return response(request, "not_entitled", reason="not_entitled", message="The active institutional session did not provide access to this paper.")
    return response(request, "failed", reason="pdf_not_acquired", message="The publisher workflow did not produce a DOI-verified PDF.")


def main() -> int:
    try:
        request = load_request()
    except Exception:
        request = {"requestId": "invalid"}
        print(json.dumps(response(request, "failed", reason="invalid_request", message="The sidecar request was invalid."), separators=(",", ":")))
        return 0
    checkout = Path(os.environ.get("INSTSCI_CHECKOUT_ROOT", ""))
    ok, reason, message = checkout_probe(checkout)
    if request.get("operation") == "probe":
        print(json.dumps(response(request, "ready" if ok else "unavailable", reason=reason, message=message), separators=(",", ":")))
        return 0
    if request.get("operation") != "acquire":
        result = response(request, "failed", reason="unsupported_operation", message="The requested sidecar operation is unsupported.")
    elif not ok:
        result = response(request, "failed", reason=reason, message=message)
    else:
        result = acquire(request, checkout)
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
