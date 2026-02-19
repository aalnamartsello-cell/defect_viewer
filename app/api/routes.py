# app/api/routes.py
from __future__ import annotations

from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import FileResponse, Response
from typing import Any, Dict, List, Optional, Callable, Tuple
from pathlib import Path
import uuid
import shutil
import threading
import time
import traceback
from datetime import datetime
from urllib.parse import quote
import json
import hashlib
import os

from pydantic import BaseModel, Field

from app.core.config import settings, ensure_dirs
from app.services.storage import save_upload
from app.services.session_store import (
    create_session,
    load_session,
    add_photo,
    set_photo_labels,
    get_session_classes,
    add_class_to_session,
    rename_class_in_session,
)
from app.services.dataset_builder import (
    build_accumulated_dataset_for_session,
    validate_session_for_training,
    build_yolo_det_dataset_from_all_sessions,
)
from app.ml.infer import run_yolo_infer
from app.services.model_manager import ModelManager
from app.services import train_job_store
from report_docx import build_defect_report_docx_bytes


router = APIRouter(prefix="/api")


def _now_ns() -> int:
    return time.time_ns()


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


# =========================================================
# ✅ Accumulated dataset hygiene (C) — uses settings.ACCUM_DATASET_DIR
# =========================================================

def _resolve_accumulated_dir() -> Path:
    """
    Накопительный датасет строится в build_accumulated_dataset_for_session()
    и живёт в settings.ACCUM_DATASET_DIR (если нет — fallback).
    """
    try:
        p = getattr(settings, "ACCUM_DATASET_DIR", None)
        if isinstance(p, Path):
            return p
        if isinstance(p, str) and p.strip():
            return Path(p)
    except Exception:
        pass
    return settings.DATA_DIR / "_accumulated"


def _resolve_accumulated_archive_dir(acc_dir: Path) -> Path:
    try:
        raw = getattr(settings, "ACCUMULATED_ARCHIVE_DIR", None)
        if isinstance(raw, str) and raw.strip():
            return Path(raw)
        if isinstance(raw, Path):
            return raw
    except Exception:
        pass
    return acc_dir.parent / "_accumulated_archive"


def _ensure_yolo_skeleton(root: Path) -> None:
    (root / "images" / "train").mkdir(parents=True, exist_ok=True)
    (root / "images" / "val").mkdir(parents=True, exist_ok=True)
    (root / "labels" / "train").mkdir(parents=True, exist_ok=True)
    (root / "labels" / "val").mkdir(parents=True, exist_ok=True)


def _dir_size_bytes(p: Path) -> int:
    total = 0
    if not p.exists():
        return 0
    for f in p.rglob("*"):
        if f.is_file():
            try:
                total += f.stat().st_size
            except Exception:
                pass
    return total


def _list_files(p: Path, exts: Tuple[str, ...]) -> List[Path]:
    if not p.exists():
        return []
    out: List[Path] = []
    for f in p.rglob("*"):
        if f.is_file() and f.suffix.lower() in exts:
            out.append(f)
    return out


def _mtime_ns(p: Path) -> int:
    try:
        return int(p.stat().st_mtime_ns)
    except Exception:
        return 0


def _match_label_for_image(img: Path) -> Path:
    parts = list(img.parts)
    try:
        idx = parts.index("images")
        parts[idx] = "labels"
        return Path(*parts).with_suffix(".txt")
    except ValueError:
        return img.with_suffix(".txt")


def _load_manifest(dataset_dir: Path) -> Dict[str, Any]:
    mp = dataset_dir / "manifest.json"
    if not mp.exists():
        return {}
    try:
        data = json.loads(mp.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_manifest(dataset_dir: Path, manifest: Dict[str, Any]) -> None:
    mp = dataset_dir / "manifest.json"
    try:
        _atomic_write_json(mp, manifest if isinstance(manifest, dict) else {})
    except Exception:
        pass


def _cleanup_manifest_missing_files(dataset_dir: Path, manifest: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(manifest, dict) or not manifest:
        return manifest if isinstance(manifest, dict) else {}

    cleaned: Dict[str, Any] = {}
    removed = 0

    for k, v in manifest.items():
        if not isinstance(k, str) or not isinstance(v, dict):
            removed += 1
            continue

        rel_img = str(v.get("image") or "")
        rel_lbl = str(v.get("label") or "")

        ok = True
        if rel_img:
            if not (dataset_dir / rel_img).exists():
                ok = False
        if rel_lbl:
            if not (dataset_dir / rel_lbl).exists():
                ok = False

        if ok:
            cleaned[k] = v
        else:
            removed += 1

    if removed > 0:
        _save_manifest(dataset_dir, cleaned)

    return cleaned


def _accumulated_stats(acc_root: Path) -> Dict[str, Any]:
    _ensure_yolo_skeleton(acc_root)

    img_train = _list_files(acc_root / "images" / "train", (".jpg", ".jpeg", ".png", ".webp", ".bmp"))
    img_val = _list_files(acc_root / "images" / "val", (".jpg", ".jpeg", ".png", ".webp", ".bmp"))
    lab_train = _list_files(acc_root / "labels" / "train", (".txt",))
    lab_val = _list_files(acc_root / "labels" / "val", (".txt",))

    manifest = _load_manifest(acc_root)
    manifest = _cleanup_manifest_missing_files(acc_root, manifest)

    all_files = img_train + img_val + lab_train + lab_val
    mt = [m for m in (_mtime_ns(x) for x in all_files) if m > 0]

    return {
        "accumulated_dir": str(acc_root),
        "images": {"train": len(img_train), "val": len(img_val)},
        "labels": {"train": len(lab_train), "val": len(lab_val)},
        "manifest_items": len(manifest),
        "bytes_total": _dir_size_bytes(acc_root),
        "oldest_mtime_ns": min(mt) if mt else 0,
        "newest_mtime_ns": max(mt) if mt else 0,
    }


def _accumulated_rotate(acc_root: Path, archive_root: Path, keep_archives: int = 5) -> Dict[str, Any]:
    _ensure_yolo_skeleton(acc_root)
    archive_root.mkdir(parents=True, exist_ok=True)

    ts = time.strftime("%Y%m%d_%H%M%S")
    dst = archive_root / f"acc_{ts}"
    if dst.exists():
        dst = archive_root / f"acc_{ts}_{_now_ns()}"

    shutil.move(str(acc_root), str(dst))

    acc_root.mkdir(parents=True, exist_ok=True)
    _ensure_yolo_skeleton(acc_root)

    removed: List[str] = []
    try:
        archives = sorted(
            [p for p in archive_root.iterdir() if p.is_dir() and p.name.startswith("acc_")],
            key=lambda p: p.name,
            reverse=True,
        )
        k = max(0, int(keep_archives or 0))
        for p in archives[k:]:
            try:
                shutil.rmtree(p)
                removed.append(p.name)
            except Exception:
                pass
    except Exception:
        pass

    return {
        "accumulated_dir": str(acc_root),
        "archive_root": str(archive_root),
        "archived_to": str(dst),
        "removed_archives": removed,
        "message": f"Ротация выполнена. Архив: {dst.name}.",
    }


def _accumulated_prune(
    acc_root: Path,
    keep_last_n: Optional[int] = None,
    max_age_days: Optional[int] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    _ensure_yolo_skeleton(acc_root)

    imgs = _list_files(acc_root / "images", (".jpg", ".jpeg", ".png", ".webp", ".bmp"))
    imgs_sorted = sorted(imgs, key=lambda p: _mtime_ns(p), reverse=True)

    if keep_last_n is None and max_age_days is None:
        return {
            "accumulated_dir": str(acc_root),
            "removed_images": 0,
            "removed_labels": 0,
            "removed_bytes": 0,
            "kept_images": len(imgs_sorted),
            "dry_run": bool(dry_run),
            "message": "Ничего не сделано: не задан keep_last_n и max_age_days.",
        }

    keep: set[Path] = set()

    if keep_last_n is not None:
        n = max(0, int(keep_last_n))
        keep.update(imgs_sorted[:n])

    if max_age_days is not None:
        days = max(0, int(max_age_days))
        cutoff_ns = _now_ns() - int(days * 24 * 3600 * 1_000_000_000)
        for p in imgs_sorted:
            if _mtime_ns(p) >= cutoff_ns:
                keep.add(p)

    removed_images = 0
    removed_labels = 0
    removed_bytes = 0

    for img in imgs_sorted:
        if img in keep:
            continue

        lbl = _match_label_for_image(img)

        try:
            removed_bytes += img.stat().st_size
        except Exception:
            pass
        if lbl.exists():
            try:
                removed_bytes += lbl.stat().st_size
            except Exception:
                pass

        if not dry_run:
            try:
                img.unlink(missing_ok=True)
                removed_images += 1
            except Exception:
                pass

            if lbl.exists():
                try:
                    lbl.unlink(missing_ok=True)
                    removed_labels += 1
                except Exception:
                    pass
        else:
            removed_images += 1
            if lbl.exists():
                removed_labels += 1

    # cleanup manifest (remove broken refs)
    manifest_before = _load_manifest(acc_root)
    if manifest_before:
        if not dry_run:
            _cleanup_manifest_missing_files(acc_root, manifest_before)
        else:
            _cleanup_manifest_missing_files(acc_root, dict(manifest_before))

    return {
        "accumulated_dir": str(acc_root),
        "removed_images": removed_images,
        "removed_labels": removed_labels,
        "removed_bytes": removed_bytes,
        "kept_images": len(keep),
        "dry_run": bool(dry_run),
        "message": "Ок. Очистка выполнена." if not dry_run else "Dry-run: посчитано, что было бы удалено.",
    }


class PruneReq(BaseModel):
    keep_last_n: Optional[int] = Field(default=None, ge=0)
    max_age_days: Optional[int] = Field(default=None, ge=0)
    dry_run: bool = False


class RotateReq(BaseModel):
    keep_archives: int = Field(default=5, ge=0)


# ---------------------------
# Helpers
# ---------------------------

def _session_or_404(session_id: str) -> Dict[str, Any]:
    try:
        return load_session(session_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Сессия не найдена")


def _photo_entry(session_id: str, photo_id: str) -> Optional[Dict[str, Any]]:
    s = _session_or_404(session_id)
    for ph in s.get("photos", []):
        if isinstance(ph, dict) and ph.get("photo_id") == photo_id:
            return ph
    return None


def _photo_url(session_id: str, photo_id: str) -> str:
    return f"/api/sessions/{session_id}/photos/{photo_id}/file"


def _resolve_photo_file_path(session_id: str, photo_id: str) -> Optional[Path]:
    ph = _photo_entry(session_id, photo_id)
    if not ph:
        return None

    rel = ph.get("relative_path")
    stored_name = ph.get("stored_name")
    original_name = ph.get("original_name")

    candidates: List[Path] = []

    def _add(p: Optional[Path]):
        if p and p not in candidates:
            candidates.append(p)

    if isinstance(rel, str) and rel.strip():
        try:
            rel_clean = rel.replace("\\", "/").lstrip("/")
            if rel_clean.lower().startswith("uploads/"):
                rel_clean = rel_clean[len("uploads/"):]
            _add(settings.UPLOADS_DIR / Path(rel_clean))
        except Exception:
            pass

        try:
            rel_clean2 = rel.replace("\\", "/").lstrip("/")
            _add(settings.DATA_DIR / Path(rel_clean2))
        except Exception:
            pass

    if isinstance(stored_name, str) and stored_name.strip():
        _add(settings.UPLOADS_DIR / session_id / stored_name)

    if isinstance(original_name, str) and original_name.strip():
        _add(settings.UPLOADS_DIR / session_id / original_name)

    sess_dir = settings.UPLOADS_DIR / session_id
    try:
        if sess_dir.exists() and sess_dir.is_dir():
            if isinstance(stored_name, str) and stored_name.strip():
                for p in sess_dir.glob(f"*{stored_name}*"):
                    _add(p)
            for p in sess_dir.glob(f"*{photo_id}*"):
                _add(p)
    except Exception:
        pass

    for p in candidates:
        try:
            if p.exists() and p.is_file():
                return p
        except Exception:
            continue

    return None


def _labels_to_frontend(ph: Dict[str, Any]) -> Dict[str, Any]:
    labels = ph.get("labels") if isinstance(ph.get("labels"), dict) else {}

    decision = labels.get("decision")
    if decision not in ("defect", "ok"):
        hd = labels.get("has_defect")
        if hd is True:
            decision = "defect"
        elif hd is False:
            decision = "ok"
        else:
            decision = None

    meta_out = {
        "class": "",
        "place": labels.get("place"),
        "comment": labels.get("comment"),
        "category": labels.get("category"),
        "recommendedFix": labels.get("recommendedFix"),
    }
    meta = meta_out if any(v is not None and str(v).strip() != "" for v in meta_out.values()) else None

    bboxes_src = labels.get("bboxes") if isinstance(labels.get("bboxes"), list) else []
    bboxes_out: List[Dict[str, Any]] = []
    for b in bboxes_src:
        if not isinstance(b, dict):
            continue
        bboxes_out.append(
            {
                "id": str(b.get("id") or uuid.uuid4()),
                "class": b.get("cls") or b.get("class") or "unknown",
                "confidence": float(b.get("conf") if b.get("conf") is not None else 1.0),
                "bbox": [
                    float(b.get("x", 0.0)),
                    float(b.get("y", 0.0)),
                    float(b.get("w", 0.0)),
                    float(b.get("h", 0.0)),
                ],
                "source": b.get("source"),
                "polygon": b.get("polygon"),
            }
        )

    return {"decision": decision, "meta": meta, "bboxes": bboxes_out}


def _as_list_item(session_id: str, ph: Dict[str, Any]) -> Dict[str, Any]:
    norm = _labels_to_frontend(ph)
    bxs = norm.get("bboxes") or []
    return {
        "id": ph.get("photo_id"),
        "filename": ph.get("original_name") or ph.get("stored_name") or "photo",
        "url": _photo_url(session_id, ph.get("photo_id")),
        "decision": norm.get("decision"),
        "meta": norm.get("meta"),
        "bboxes_count": len(bxs),
    }


def _as_detail(session_id: str, ph: Dict[str, Any]) -> Dict[str, Any]:
    norm = _labels_to_frontend(ph)
    return {
        "id": ph.get("photo_id"),
        "filename": ph.get("original_name") or ph.get("stored_name") or "photo",
        "url": _photo_url(session_id, ph.get("photo_id")),
        "decision": norm.get("decision"),
        "meta": norm.get("meta"),
        "bboxes": norm.get("bboxes") or [],
    }


def _normalize_labels_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        return {
            "has_defect": None,
            "decision": None,
            "category": None,
            "place": None,
            "comment": None,
            "recommendedFix": None,
            "bboxes": [],
        }

    decision = payload.get("decision")
    has_defect = payload.get("has_defect")

    if decision in ("defect", "ok"):
        has_defect = True if decision == "defect" else False
    elif isinstance(has_defect, bool):
        decision = "defect" if has_defect else "ok"
    else:
        decision = None
        has_defect = None

    meta_in = payload.get("meta")
    meta: Dict[str, Any] = meta_in if isinstance(meta_in, dict) else {}

    category = meta.get("category", payload.get("category"))
    place = meta.get("place", payload.get("place"))
    comment = meta.get("comment", payload.get("comment"))
    recommendedFix = meta.get("recommendedFix", payload.get("recommendedFix"))

    raw_bboxes = payload.get("bboxes")
    bboxes_out: List[Dict[str, Any]] = []
    if isinstance(raw_bboxes, list):
        for b in raw_bboxes:
            if not isinstance(b, dict):
                continue

            if "bbox" in b and isinstance(b.get("bbox"), (list, tuple)) and len(b["bbox"]) == 4:
                x, y, w, h = b["bbox"]
                bboxes_out.append(
                    {
                        "id": str(b.get("id") or uuid.uuid4()),
                        "cls": b.get("class") or b.get("cls") or "unknown",
                        "x": float(x),
                        "y": float(y),
                        "w": float(w),
                        "h": float(h),
                        "conf": float(b.get("confidence")) if b.get("confidence") is not None else None,
                        "source": b.get("source") or "manual",
                        "polygon": b.get("polygon"),
                    }
                )
                continue

            if all(k in b for k in ("x", "y", "w", "h")):
                bboxes_out.append(
                    {
                        "id": str(b.get("id") or uuid.uuid4()),
                        "cls": b.get("class") or b.get("cls") or "unknown",
                        "x": float(b["x"]),
                        "y": float(b["y"]),
                        "w": float(b["w"]),
                        "h": float(b["h"]),
                        "conf": float(b.get("confidence")) if b.get("confidence") is not None else None,
                        "source": b.get("source") or "manual",
                        "polygon": b.get("polygon"),
                    }
                )

    return {
        "has_defect": has_defect,
        "decision": decision,
        "category": category,
        "place": place,
        "comment": comment,
        "recommendedFix": recommendedFix,
        "bboxes": bboxes_out,
    }


def _read_photo_bytes(session_id: str, photo_id: str) -> Optional[bytes]:
    p = _resolve_photo_file_path(session_id, photo_id)
    if not p or not p.exists():
        return None
    try:
        return p.read_bytes()
    except Exception:
        return None


def _merge_labels_preserve_meta(existing_labels: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(existing_labels or {})
    for k, v in patch.items():
        out[k] = v
    return out


def _torch_cuda_snapshot() -> Dict[str, Any]:
    snap: Dict[str, Any] = {
        "gpu_available": False,
        "gpu_name": None,
        "torch_cuda_version": None,
        "cuda_device_count": 0,
    }
    try:
        import torch  # type: ignore
        snap["torch_cuda_version"] = getattr(torch.version, "cuda", None)
        snap["gpu_available"] = bool(torch.cuda.is_available())
        snap["cuda_device_count"] = int(torch.cuda.device_count()) if snap["gpu_available"] else 0
        if snap["gpu_available"] and snap["cuda_device_count"] > 0:
            try:
                snap["gpu_name"] = torch.cuda.get_device_name(0)
            except Exception:
                snap["gpu_name"] = None
    except Exception:
        pass
    return snap


def _resolve_train_device() -> str:
    requested = str(getattr(settings, "TRAIN_DEVICE", "auto") or "auto").strip()
    req_low = requested.lower()

    if req_low == "cpu":
        return "cpu"

    if req_low in ("auto", "cuda", "gpu", "nvidia", "gtx"):
        try:
            import torch  # type: ignore
            if torch.cuda.is_available() and int(torch.cuda.device_count()) > 0:
                return "0"
            return "cpu"
        except Exception:
            return "cpu"

    normalized = requested.strip()
    low = normalized.lower()

    if low.startswith("cuda:"):
        normalized = normalized.split(":", 1)[1].strip()
    elif low.startswith("gpu:"):
        normalized = normalized.split(":", 1)[1].strip()
    elif low.startswith("gpu") and low[3:].strip().isdigit():
        normalized = low[3:].strip()
    elif low.startswith("cuda") and low[4:].strip().isdigit():
        normalized = low[4:].strip()

    try:
        import torch  # type: ignore
        if not (torch.cuda.is_available() and int(torch.cuda.device_count()) > 0):
            return "cpu"

        n_gpus = int(torch.cuda.device_count())

        parts = [p.strip() for p in normalized.split(",") if p.strip()]
        if parts and all(p.isdigit() for p in parts):
            idxs = [int(p) for p in parts]
            if max(idxs) < n_gpus:
                return ",".join(str(i) for i in idxs)
            return "0"

        return normalized
    except Exception:
        return "cpu"


def _count_epochs_from_results_csv(results_csv: Path) -> int:
    try:
        if not results_csv.exists():
            return 0
        lines = results_csv.read_text(encoding="utf-8", errors="ignore").splitlines()
        if len(lines) <= 1:
            return 0
        return max(0, len(lines) - 1)
    except Exception:
        return 0


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def _sha256_file(p: Path) -> Optional[str]:
    try:
        if not p.exists() or not p.is_file():
            return None
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def _read_accumulated_total(dataset_dir: Path) -> int:
    try:
        mp = dataset_dir / "manifest.json"
        if mp.exists():
            data = json.loads(mp.read_text(encoding="utf-8"))
            if isinstance(data, dict) and len(data) > 0:
                return len(data)
    except Exception:
        pass

    try:
        lbl_train = dataset_dir / "labels" / "train"
        lbl_val = dataset_dir / "labels" / "val"
        n = 0
        if lbl_train.exists():
            n += len([p for p in lbl_train.glob("*.txt") if p.is_file()])
        if lbl_val.exists():
            n += len([p for p in lbl_val.glob("*.txt") if p.is_file()])
        if n > 0:
            return n
    except Exception:
        pass

    try:
        img_train = dataset_dir / "images" / "train"
        img_val = dataset_dir / "images" / "val"
        n = 0
        if img_train.exists():
            n += len([p for p in img_train.iterdir() if p.is_file()])
        if img_val.exists():
            n += len([p for p in img_val.iterdir() if p.is_file()])
        return n
    except Exception:
        return 0


def _norm_xywh_bbox(bbox: Any) -> List[float]:
    try:
        x, y, w, h = bbox
        x = float(x)
        y = float(y)
        w = float(w)
        h = float(h)
    except Exception:
        return [0.0, 0.0, 0.0, 0.0]

    w = max(0.0, w)
    h = max(0.0, h)

    x = _clamp01(x)
    y = _clamp01(y)
    w = _clamp01(w)
    h = _clamp01(h)

    x = _clamp01(min(x, 1.0 - w))
    y = _clamp01(min(y, 1.0 - h))

    return [x, y, w, h]


def _invalidate_model_manager_cache_safe() -> None:
    """
    После train сбрасываем кэш модели, чтобы следующий infer пересоздал YOLO по новому weights_key.
    """
    try:
        mm = ModelManager.instance()
        if hasattr(mm, "invalidate") and callable(getattr(mm, "invalidate")):
            mm.invalidate()
            return
        for attr in ("_model", "_names", "_weights_key", "_use_seg"):
            if hasattr(mm, attr):
                if attr == "_names":
                    setattr(mm, attr, [])
                elif attr == "_use_seg":
                    setattr(mm, attr, False)
                else:
                    setattr(mm, attr, None if attr == "_model" else "")
    except Exception:
        pass


def _get_train_patience() -> Optional[int]:
    raw = getattr(settings, "TRAIN_PATIENCE", None)
    try:
        if raw is None:
            return None
        v = int(raw)
        return v if v > 0 else None
    except Exception:
        return None


def _get_train_seed() -> Optional[int]:
    raw = getattr(settings, "TRAIN_SEED", None)
    try:
        if raw is None:
            return None
        return int(raw)
    except Exception:
        return None


# ---------------------------
# Routes
# ---------------------------

@router.get("/sessions/{session_id}/classes")
def get_classes(session_id: str) -> Dict[str, Any]:
    ensure_dirs()
    _session_or_404(session_id)
    return {"classes": get_session_classes(session_id)}


@router.post("/sessions/{session_id}/classes")
def add_class(session_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    ensure_dirs()
    _session_or_404(session_id)

    name = ""
    if isinstance(payload, dict):
        name = str(payload.get("name") or "").strip()

    if not name:
        raise HTTPException(status_code=400, detail="Не задан name")

    cls = add_class_to_session(session_id, name)
    return {"ok": True, "classes": cls}


@router.post("/sessions/{session_id}/classes/rename")
def rename_class(session_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    ensure_dirs()
    _session_or_404(session_id)

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Некорректный payload")

    frm = payload.get("from") or payload.get("from_name") or payload.get("old") or payload.get("old_name") or ""
    to = payload.get("to") or payload.get("to_name") or payload.get("new") or payload.get("new_name") or ""

    frm = str(frm or "").strip()
    to = str(to or "").strip()

    if not frm or not to:
        raise HTTPException(status_code=400, detail="Нужно передать поля 'from' и 'to'")

    try:
        classes = rename_class_in_session(session_id, frm, to)
        return {"ok": True, "classes": classes, "from": frm, "to": to}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка rename: {e}")


@router.get("/health/ml")
def health_ml(load: bool = False) -> Dict[str, Any]:
    ensure_dirs()
    mm = ModelManager.instance()
    return mm.describe(load=bool(load))


# ==========================
# ✅ Admin endpoints (C + D)
# ==========================

@router.get("/admin/accumulated/stats")
def admin_accumulated_stats() -> Dict[str, Any]:
    ensure_dirs()
    acc = _resolve_accumulated_dir()
    return _accumulated_stats(acc)


@router.post("/admin/accumulated/prune")
def admin_accumulated_prune(req: PruneReq) -> Dict[str, Any]:
    ensure_dirs()
    acc = _resolve_accumulated_dir()
    return _accumulated_prune(
        acc_root=acc,
        keep_last_n=req.keep_last_n,
        max_age_days=req.max_age_days,
        dry_run=bool(req.dry_run),
    )


@router.post("/admin/accumulated/rotate")
def admin_accumulated_rotate(req: RotateReq) -> Dict[str, Any]:
    ensure_dirs()
    acc = _resolve_accumulated_dir()
    arch = _resolve_accumulated_archive_dir(acc)
    return _accumulated_rotate(acc_root=acc, archive_root=arch, keep_archives=int(req.keep_archives))


@router.get("/admin/train/jobs")
def admin_train_jobs(limit: int = 50) -> Dict[str, Any]:
    ensure_dirs()
    items = train_job_store.list_jobs(limit=limit)
    return {"jobs_dir": str(train_job_store.JOBS_DIR), "items": items}


@router.get("/admin/train/jobs/{job_id}")
def admin_train_job(job_id: str) -> Dict[str, Any]:
    ensure_dirs()
    j = train_job_store.get_job(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="Job не найден")
    return {"jobs_dir": str(train_job_store.JOBS_DIR), "item": j}


@router.post("/sessions")
def create_session_route() -> Dict[str, Any]:
    ensure_dirs()
    sid = str(uuid.uuid4())
    s = create_session(sid)
    return {"session_id": sid, "classes": s.get("classes", [])}


@router.post("/sessions/{session_id}/photos/upload")
def upload_photos(session_id: str, files: List[UploadFile] = File(...)) -> List[Dict[str, Any]]:
    ensure_dirs()
    if not files:
        raise HTTPException(status_code=400, detail="Файлы не переданы")

    created: List[Dict[str, Any]] = []
    for up in files:
        try:
            photo_id, original_name, stored_name, relative_path = save_upload(session_id, up)
            ph = add_photo(session_id, photo_id, original_name, stored_name, relative_path)
            created.append({"id": ph["photo_id"], "filename": original_name, "url": _photo_url(session_id, ph["photo_id"])})
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Ошибка сохранения файла: {e}")

    return created


@router.get("/sessions/{session_id}/photos")
def list_photos(session_id: str) -> List[Dict[str, Any]]:
    s = _session_or_404(session_id)
    out: List[Dict[str, Any]] = []
    for ph in s.get("photos", []):
        if not isinstance(ph, dict):
            continue
        out.append(_as_list_item(session_id, ph))
    return out


@router.get("/sessions/{session_id}/photos/{photo_id}")
def get_photo_detail(session_id: str, photo_id: str) -> Dict[str, Any]:
    ph = _photo_entry(session_id, photo_id)
    if not ph:
        raise HTTPException(status_code=404, detail="Фото не найдено")
    return _as_detail(session_id, ph)


@router.get("/sessions/{session_id}/photos/{photo_id}/file")
def get_photo_file(session_id: str, photo_id: str):
    p = _resolve_photo_file_path(session_id, photo_id)
    if not p:
        ph = _photo_entry(session_id, photo_id) or {}
        raise HTTPException(
            status_code=404,
            detail=(
                "Файл не найден. "
                f"photo_id={photo_id}, relative_path={ph.get('relative_path')}, "
                f"stored_name={ph.get('stored_name')}, original_name={ph.get('original_name')}, "
                f"uploads_dir={settings.UPLOADS_DIR}"
            ),
        )
    return FileResponse(str(p))


@router.post("/sessions/{session_id}/infer/{photo_id}")
def infer_photo(session_id: str, photo_id: str) -> Dict[str, Any]:
    ensure_dirs()

    ph = _photo_entry(session_id, photo_id)
    if not ph:
        raise HTTPException(status_code=404, detail="Фото не найдено")

    img_path = _resolve_photo_file_path(session_id, photo_id)
    if not img_path or not img_path.exists():
        raise HTTPException(status_code=404, detail="Файл фото не найден")

    try:
        out = run_yolo_infer(img_path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка инференса: {e}")

    stored_bboxes: List[Dict[str, Any]] = []
    frontend_bboxes: List[Dict[str, Any]] = []

    for item in out.bboxes:
        if not isinstance(item, dict):
            continue

        cls_name = str(item.get("class") or "unknown")
        conf = float(item.get("confidence") if item.get("confidence") is not None else 0.0)
        conf = _clamp01(conf)

        bbox_raw = item.get("bbox") if isinstance(item.get("bbox"), list) and len(item["bbox"]) == 4 else [0, 0, 0, 0]
        x, y, w, h = _norm_xywh_bbox(bbox_raw)
        poly = item.get("polygon")

        bid = str(item.get("id") or uuid.uuid4())
        src = item.get("source") or "yolo"

        stored_bboxes.append(
            {"id": bid, "cls": cls_name, "x": float(x), "y": float(y), "w": float(w), "h": float(h), "conf": float(conf), "source": src, "polygon": poly}
        )
        frontend_bboxes.append(
            {"id": bid, "class": cls_name, "confidence": float(conf), "bbox": [float(x), float(y), float(w), float(h)], "source": src, "polygon": poly}
        )

    existing_labels = ph.get("labels") if isinstance(ph.get("labels"), dict) else {}
    patched = _merge_labels_preserve_meta(existing_labels, {"bboxes": stored_bboxes})
    try:
        set_photo_labels(session_id, photo_id, patched)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка сохранения bbox: {e}")

    return {
        "ok": True,
        "photo_id": photo_id,
        "bboxes": frontend_bboxes,
        "took_ms": int(out.took_ms),
        "device": str(out.device),
        "num_det": int(out.num_det),
        "used_cpu_fallback": bool(out.used_cpu_fallback),
    }


@router.post("/sessions/{session_id}/labels/{photo_id}")
def save_labels(session_id: str, photo_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    ensure_dirs()
    try:
        normalized = _normalize_labels_payload(payload)
        ph = set_photo_labels(session_id, photo_id, normalized)
        detail = _as_detail(session_id, ph)
        return {"ok": True, "photo_id": detail["id"], "labels": {"decision": detail["decision"], "meta": detail["meta"], "bboxes": detail["bboxes"]}}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка сохранения разметки: {e}")


@router.get("/sessions/{session_id}/report.docx")
def download_report_docx(session_id: str):
    ensure_dirs()
    s = _session_or_404(session_id)
    photos = s.get("photos", []) or []

    rows: List[Dict[str, Any]] = []
    idx = 0

    for ph in photos:
        if not isinstance(ph, dict):
            continue

        labels = ph.get("labels") if isinstance(ph.get("labels"), dict) else {}
        decision = labels.get("decision")
        if decision not in ("defect", "ok"):
            hd = labels.get("has_defect")
            if hd is True:
                decision = "defect"
            elif hd is False:
                decision = "ok"
            else:
                decision = None

        if decision != "defect":
            continue

        idx += 1
        place = (labels.get("place") or "").strip()
        comment = (labels.get("comment") or "").strip()
        category = (labels.get("category") or "").strip()
        recommended = (labels.get("recommendedFix") or "").strip()

        bboxes = labels.get("bboxes") if isinstance(labels.get("bboxes"), list) else []
        description_lines: List[str] = ["Дефекты:"]

        if bboxes:
            for b in bboxes:
                if not isinstance(b, dict):
                    continue
                cls = b.get("cls") or b.get("class") or "—"
                conf = b.get("conf")
                pct = 100 if conf is None else int(round(float(conf) * 100))
                description_lines.append(f"• {cls} ({pct}%)")
        else:
            description_lines.append("—")

        if comment:
            description_lines.append(comment)

        image_bytes = _read_photo_bytes(session_id, str(ph.get("photo_id")))

        rows.append({"index": idx, "place": place or "—", "image_bytes": image_bytes, "description_lines": description_lines, "category": category or "—", "recommendation": recommended or "—"})

    created_at = datetime.now()

    template_path = Path(__file__).resolve().parents[2] / "templates" / "Пример.дефектной ведомости.docx"
    if not template_path.exists():
        raise HTTPException(status_code=500, detail=f"Не найден шаблон Word: {template_path}. Положи шаблон в backend/templates/.")

    docx_bytes = build_defect_report_docx_bytes(template_path=template_path, created_at=created_at, rows=rows)

    fname = f"Defect_report_{created_at.strftime('%Y-%m-%d_%H-%M-%S')}.docx"
    fname_ru = f"Дефектная_ведомость_{created_at.strftime('%Y-%m-%d_%H-%M-%S')}.docx"
    cd = f"attachment; filename={fname}; filename*=UTF-8''{quote(fname_ru)}"

    headers = {"Content-Disposition": cd, "Cache-Control": "no-store"}

    return Response(content=docx_bytes, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document", headers=headers)


@router.post("/sessions/{session_id}/train")
def train(session_id: str, quality: bool = False) -> Dict[str, Any]:
    """
    quality=false: накопительный датасет по одной сессии (ACCUM_DATASET_DIR)
    quality=true: global yolo_det по всем sessions
    """
    ensure_dirs()

    if not quality:
        v = validate_session_for_training(session_id)
        if not v.ok:
            raise HTTPException(status_code=400, detail={"message": v.message, "stats": v.stats})

    job_id = f"train_{int(time.time())}_{session_id[:8]}_{'q' if quality else 's'}"
    log_path = settings.DATA_DIR / "train_logs" / f"{job_id}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    cuda_snap = _torch_cuda_snapshot()

    train_job_store.set_job(
        job_id,
        {
            "job_id": job_id,
            "status": "queued",
            "message": "Очередь обучения",
            "epoch": 0,
            "epochs_total": int(settings.TRAIN_EPOCHS),
            "progress": 0.0,
            "model_path": None,
            "log_path": str(log_path),
            "dataset_total": 0,
            "dataset_boxes": 0,
            "dataset_mode": "global" if quality else "session",
            "model_sha256_before": None,
            "model_sha256_after": None,
            "model_version_path": None,
            "gpu_available": bool(cuda_snap.get("gpu_available")),
            "gpu_name": cuda_snap.get("gpu_name"),
            "torch_cuda_version": cuda_snap.get("torch_cuda_version"),
            "cuda_device_count": int(cuda_snap.get("cuda_device_count") or 0),
            "resolved_device": None,
            "patience": _get_train_patience(),
            "seed": _get_train_seed(),
            "quality": bool(quality),
        },
    )

    def _write_log(line: str) -> None:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line.rstrip("\n") + "\n")

    def _run():
        done_evt = threading.Event()

        def _monitor_results_csv(run_dir: Path, epochs_total: int) -> None:
            results_csv = run_dir / "results.csv"
            last_epoch = -1
            while not done_evt.is_set():
                ep_done = _count_epochs_from_results_csv(results_csv)
                if ep_done != last_epoch:
                    last_epoch = ep_done
                    prog = 0.0
                    if epochs_total > 0:
                        prog = min(0.99, max(0.0, float(ep_done) / float(epochs_total)))
                    train_job_store.set_job(
                        job_id,
                        {
                            "status": "running",
                            "epoch": int(ep_done),
                            "epochs_total": int(epochs_total),
                            "progress": float(prog),
                            "message": f"Обучение YOLO… эпоха {int(ep_done)}/{int(epochs_total)}",
                        },
                    )
                time.sleep(1.0)

        def _register_ultralytics_callbacks(model, epochs_total: int) -> bool:
            def _safe_progress_update(trainer: Any) -> None:
                try:
                    ep0 = int(getattr(trainer, "epoch", 0))
                    ep_ui = max(0, ep0 + 1)

                    total = int(getattr(trainer, "epochs", epochs_total)) if epochs_total else int(getattr(trainer, "epochs", 0) or 0)
                    if total <= 0:
                        total = int(epochs_total) if epochs_total else 0

                    batch_i = getattr(trainer, "batch_i", None)
                    nb = getattr(trainer, "nb", None)

                    frac = 0.0
                    if isinstance(batch_i, int) and isinstance(nb, int) and nb > 0:
                        frac = (batch_i + 1) / float(nb)

                    prog = 0.0
                    if total > 0:
                        prog = _clamp01((ep0 + frac) / float(total))
                        prog = min(0.99, prog)

                    msg_bits = [f"Обучение YOLO… эпоха {ep_ui}/{total if total else epochs_total}"]
                    if isinstance(batch_i, int) and isinstance(nb, int) and nb > 0:
                        msg_bits.append(f"батч {batch_i+1}/{nb}")
                    message = " • ".join(msg_bits)

                    train_job_store.set_job(
                        job_id,
                        {
                            "status": "running",
                            "epoch": int(ep_ui),
                            "epochs_total": int(total if total else epochs_total),
                            "progress": float(prog),
                            "message": message,
                        },
                    )
                except Exception:
                    pass

            def on_train_batch_end(trainer: Any) -> None:
                _safe_progress_update(trainer)

            def on_train_epoch_end(trainer: Any) -> None:
                _safe_progress_update(trainer)

            try:
                add_cb: Optional[Callable[..., Any]] = getattr(model, "add_callback", None)
                if callable(add_cb):
                    add_cb("on_train_batch_end", on_train_batch_end)
                    add_cb("on_train_epoch_end", on_train_epoch_end)
                    return True
            except Exception:
                pass

            return False

        try:
            # 1) build dataset
            if quality:
                train_job_store.set_job(job_id, {"status": "running", "message": "Подготовка датасета (global yolo_det)...", "progress": 0.05})
                try:
                    build_g = build_yolo_det_dataset_from_all_sessions(incremental=True)
                except ValueError as e:
                    msg = str(e)
                    _write_log("[ERROR] " + msg.replace("\n", " "))
                    train_job_store.set_job(job_id, {"status": "error", "message": msg, "progress": 0.0})
                    return

                _write_log(f"[DATASET] mode=global dir={build_g.dataset_dir}")
                _write_log(f"[DATASET] data_yaml={build_g.data_yaml}")
                _write_log(
                    f"[DATASET] sessions_scanned={build_g.sessions_scanned} photos_scanned={build_g.photos_scanned} "
                    f"photos_included={build_g.photos_included} boxes={build_g.total_boxes_kept} "
                    f"duplicates_skipped={build_g.duplicates_skipped} missing_files={build_g.missing_files} "
                    f"invalid_boxes_skipped={build_g.invalid_boxes_skipped} "
                    f"updated_images={build_g.updated_images} updated_labels={build_g.updated_labels} "
                    f"seed={build_g.seed} min_train_objects={build_g.min_train_objects}"
                )

                dataset_total = int(build_g.photos_included)
                dataset_boxes = int(build_g.total_boxes_kept)
                train_job_store.set_job(job_id, {"dataset_total": dataset_total, "dataset_boxes": dataset_boxes})

                data_yaml = build_g.data_yaml
                if not data_yaml.exists():
                    raise RuntimeError(f"Не найден датасет: {data_yaml}")

                if dataset_boxes <= 0:
                    msg = (
                        "Обучение не запущено: в global датасете 0 bbox.\n"
                        "Нужно больше разметки (decision='defect' + bbox)."
                    )
                    _write_log("[ERROR] " + msg.replace("\n", " "))
                    train_job_store.set_job(job_id, {"status": "error", "message": msg, "progress": 0.0})
                    return

            else:
                train_job_store.set_job(job_id, {"status": "running", "message": "Подготовка датасета (накопление)...", "progress": 0.05})

                build = build_accumulated_dataset_for_session(session_id, incremental=True)
                _write_log(f"[DATASET] mode=session dir={build.dataset_dir}")
                _write_log(f"[DATASET] data_yaml={build.data_yaml}")
                _write_log(
                    f"[DATASET] session_photos={build.total_photos_in_session} "
                    f"updated_images={build.updated_images} updated_labels={build.updated_labels} "
                    f"labels_written={build.total_labels_written}"
                )

                dataset_total = _read_accumulated_total(build.dataset_dir)
                _write_log(f"[DATASET] accumulated_total={dataset_total}")
                train_job_store.set_job(job_id, {"dataset_total": int(dataset_total)})

                data_yaml = build.data_yaml
                if not data_yaml.exists():
                    raise RuntimeError(f"Не найден датасет: {data_yaml}")

                if int(build.total_labels_written) <= 0:
                    msg = (
                        "Обучение не запущено: в накопленном датасете нет разметки (0 bbox).\n"
                        "Нужно хотя бы одно фото с решением 'Есть дефект' и bbox(ами).\n"
                        f"Dataset: {build.dataset_dir}"
                    )
                    _write_log("[ERROR] " + msg.replace("\n", " "))
                    train_job_store.set_job(job_id, {"status": "error", "message": msg, "progress": 0.0})
                    return

            # 2) resolve model + device
            target_model = settings.resolve_infer_model()
            target_model.parent.mkdir(parents=True, exist_ok=True)

            base_model = target_model if target_model.exists() else settings.resolve_base_model()

            if not base_model.exists():
                raise RuntimeError(
                    f"Не найден базовый вес модели: {base_model}. "
                    f"Положи model.pt в {settings.MODELS_DIR} или задай TRAIN_BASE_MODEL_PATH."
                )

            sha_before = _sha256_file(base_model)
            _write_log(f"[MODEL] sha256_before={sha_before}")
            train_job_store.set_job(job_id, {"model_sha256_before": sha_before})

            cuda_snap2 = _torch_cuda_snapshot()
            _write_log(
                f"[CUDA] available={cuda_snap2.get('gpu_available')} "
                f"count={cuda_snap2.get('cuda_device_count')} name={cuda_snap2.get('gpu_name')} "
                f"torch_cuda={cuda_snap2.get('torch_cuda_version')}"
            )
            train_job_store.set_job(
                job_id,
                {
                    "gpu_available": bool(cuda_snap2.get("gpu_available")),
                    "gpu_name": cuda_snap2.get("gpu_name"),
                    "torch_cuda_version": cuda_snap2.get("torch_cuda_version"),
                    "cuda_device_count": int(cuda_snap2.get("cuda_device_count") or 0),
                },
            )

            resolved_device = _resolve_train_device()
            train_job_store.set_job(job_id, {"resolved_device": str(resolved_device)})

            patience = _get_train_patience()
            seed = _get_train_seed()

            _write_log(f"[TRAIN] requested_device={settings.TRAIN_DEVICE} resolved_device={resolved_device}")
            _write_log(f"[TRAIN] base_model={base_model}")
            _write_log(f"[TRAIN] target_model={target_model}")
            _write_log(f"[TRAIN] data={data_yaml}")
            _write_log(
                f"[TRAIN] imgsz={settings.TRAIN_IMGSZ} batch={settings.TRAIN_BATCH} "
                f"epochs={settings.TRAIN_EPOCHS} workers={settings.TRAIN_WORKERS} "
                f"patience={patience} seed={seed} "
                f"project={settings.BASE_DIR / 'runs' / 'detect'} name={job_id}"
            )

            train_job_store.set_job(job_id, {"message": f"Запуск обучения YOLO (device={resolved_device})...", "progress": 0.10})

            from ultralytics import YOLO

            run_dir = Path(str(settings.BASE_DIR / "runs" / "detect" / job_id))
            run_dir.mkdir(parents=True, exist_ok=True)

            model = YOLO(str(base_model))

            callbacks_ok = _register_ultralytics_callbacks(model, int(settings.TRAIN_EPOCHS))
            _write_log(f"[TRAIN] callbacks={'on' if callbacks_ok else 'off'}")

            mon = None
            if not callbacks_ok:
                mon = threading.Thread(target=_monitor_results_csv, args=(run_dir, int(settings.TRAIN_EPOCHS)), daemon=True)
                mon.start()

            train_kwargs: Dict[str, Any] = dict(
                data=str(data_yaml),
                epochs=int(settings.TRAIN_EPOCHS),
                imgsz=int(settings.TRAIN_IMGSZ),
                batch=int(settings.TRAIN_BATCH),
                workers=int(settings.TRAIN_WORKERS),
                device=str(resolved_device),
                project=str(settings.BASE_DIR / "runs" / "detect"),
                name=job_id,
                exist_ok=True,
            )
            if patience is not None:
                train_kwargs["patience"] = int(patience)
            if seed is not None:
                train_kwargs["seed"] = int(seed)

            model.train(**train_kwargs)

            best_pt = run_dir / "weights" / "best.pt"
            last_pt = run_dir / "weights" / "last.pt"

            chosen: Optional[Path] = best_pt if best_pt.exists() else (last_pt if last_pt.exists() else None)

            if chosen:
                shutil.copy2(chosen, target_model)

                try:
                    os.utime(str(target_model), None)
                except Exception:
                    try:
                        target_model.touch()
                    except Exception:
                        pass

                _write_log(f"[TRAIN] Copied {chosen} -> {target_model}")
                train_job_store.set_job(job_id, {"model_path": str(target_model)})

                try:
                    _invalidate_model_manager_cache_safe()
                    _write_log("[MODEL] ModelManager cache invalidated (best effort)")
                except Exception as e:
                    _write_log(f"[MODEL] ModelManager invalidate failed: {e}")

                hist_dir = settings.MODELS_DIR / "history"
                hist_dir.mkdir(parents=True, exist_ok=True)
                version_path = hist_dir / f"model_{job_id}.pt"
                shutil.copy2(chosen, version_path)
                _write_log(f"[MODEL] Version saved -> {version_path}")
                train_job_store.set_job(job_id, {"model_version_path": str(version_path)})

            sha_after = _sha256_file(target_model)
            _write_log(f"[MODEL] sha256_after={sha_after}")
            train_job_store.set_job(job_id, {"model_sha256_after": sha_after})

            done_evt.set()
            train_job_store.set_job(
                job_id,
                {
                    "status": "done",
                    "message": "Обучение завершено",
                    "epoch": int(settings.TRAIN_EPOCHS),
                    "epochs_total": int(settings.TRAIN_EPOCHS),
                    "progress": 1.0,
                },
            )

        except Exception as e:
            done_evt.set()
            _write_log("[ERROR] Training failed:")
            _write_log(traceback.format_exc())
            train_job_store.set_job(job_id, {"status": "error", "message": f"Ошибка обучения: {e}"})

    t = threading.Thread(target=_run, daemon=True)
    t.start()

    return {"ok": True, "job_id": job_id, "status": "queued", "message": "Очередь обучения", "quality": bool(quality)}


@router.get("/train/{job_id}/status")
def train_status(job_id: str) -> Dict[str, Any]:
    j = train_job_store.get_job(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="Job не найден")
    return j


@router.get("/train/{job_id}/log")
def train_log(job_id: str):
    j = train_job_store.get_job(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="Job не найден")
    p = Path(j.get("log_path") or "")
    if not p.exists():
        return {"ok": True, "log": ""}
    txt = p.read_text(encoding="utf-8", errors="ignore")
    return {"ok": True, "log": txt}
