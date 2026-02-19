# app/services/dataset_builder.py
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import json
import shutil
import hashlib

from app.core.config import settings, ensure_dirs
from app.utils.json_io import atomic_write_json
from app.services.session_store import (
    load_session,
    add_class_to_session,
    get_session_classes,
    get_global_classes,
)

# ---------------------------------------------------------------------
# Utils
# ---------------------------------------------------------------------


def _norm(s: str) -> str:
    s = (s or "").strip()
    s = " ".join(s.split())
    return s


def _norm_low(s: str) -> str:
    return _norm(s).lower()


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def _xywh_to_yolo(x: float, y: float, w: float, h: float) -> Tuple[float, float, float, float]:
    # x,y top-left normalized -> YOLO wants cx,cy,w,h
    x = _clamp01(x)
    y = _clamp01(y)
    w = _clamp01(w)
    h = _clamp01(h)
    cx = _clamp01(x + w / 2.0)
    cy = _clamp01(y + h / 2.0)
    return cx, cy, w, h


def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except Exception:
        return float(default)


def _bbox_ok(b: Dict[str, Any]) -> bool:
    """
    Проверяем, что bbox нормализован и имеет ненулевой размер.
    Ожидаем session-формат: x,y,w,h (0..1), x/y top-left.
    """
    x = _safe_float(b.get("x", 0.0), 0.0)
    y = _safe_float(b.get("y", 0.0), 0.0)
    w = _safe_float(b.get("w", 0.0), 0.0)
    h = _safe_float(b.get("h", 0.0), 0.0)

    if w <= 0.0 or h <= 0.0:
        return False
    if x < -0.001 or y < -0.001:
        return False
    if w > 1.001 or h > 1.001:
        return False
    if x > 1.001 or y > 1.001:
        return False
    if (x + w) > 1.001 or (y + h) > 1.001:
        return False
    return True


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


def _resolve_photo_path(session_id: str, ph: Dict[str, Any]) -> Optional[Path]:
    # пытаемся устойчиво восстановить файл, аналогично routes.py
    rel = ph.get("relative_path")
    stored_name = ph.get("stored_name")
    original_name = ph.get("original_name")

    candidates: List[Path] = []

    def add(p: Optional[Path]):
        if p and p not in candidates:
            candidates.append(p)

    if isinstance(rel, str) and rel.strip():
        try:
            rel_clean = rel.replace("\\", "/").lstrip("/")
            if rel_clean.lower().startswith("uploads/"):
                rel_clean = rel_clean[len("uploads/") :]
            add(settings.UPLOADS_DIR / Path(rel_clean))
        except Exception:
            pass
        try:
            add(settings.DATA_DIR / Path(rel.replace("\\", "/").lstrip("/")))
        except Exception:
            pass

    sess_dir = settings.UPLOADS_DIR / session_id
    if isinstance(stored_name, str) and stored_name.strip():
        add(sess_dir / stored_name)
    if isinstance(original_name, str) and original_name.strip():
        add(sess_dir / original_name)

    for p in candidates:
        try:
            if p.exists() and p.is_file():
                return p
        except Exception:
            continue
    return None


def _is_image_file(p: Path) -> bool:
    if not p.is_file():
        return False
    ext = (p.suffix or "").lower().lstrip(".")
    return ext in {"jpg", "jpeg", "png", "bmp", "webp", "tif", "tiff", "heic", "dng", "mpo", "pfm"}


def _list_images(dirp: Path) -> List[Path]:
    try:
        if not dirp.exists():
            return []
        return [p for p in dirp.iterdir() if _is_image_file(p)]
    except Exception:
        return []


def _list_labels(dirp: Path) -> List[Path]:
    try:
        if not dirp.exists():
            return []
        return [p for p in dirp.glob("*.txt") if p.is_file()]
    except Exception:
        return []


def _copy_pair(
    *,
    dataset_dir: Path,
    src_img: Path,
    src_lbl: Path,
    dst_img_dir: Path,
    dst_lbl_dir: Path,
    split_name: str,
    manifest: Dict[str, Any],
) -> bool:
    """
    Копирует 1 изображение + label в нужный split.
    Пытается обновить manifest.
    """
    try:
        dst_img_dir.mkdir(parents=True, exist_ok=True)
        dst_lbl_dir.mkdir(parents=True, exist_ok=True)

        dst_img = dst_img_dir / src_img.name
        dst_lbl = dst_lbl_dir / src_lbl.name

        shutil.copy2(src_img, dst_img)
        shutil.copy2(src_lbl, dst_lbl)

        rel_img = str(dst_img.relative_to(dataset_dir)).replace("\\", "/")
        rel_lbl = str(dst_lbl.relative_to(dataset_dir)).replace("\\", "/")

        found_key = None
        src_rel_lbl = str(src_lbl.relative_to(dataset_dir)).replace("\\", "/")
        src_rel_img = str(src_img.relative_to(dataset_dir)).replace("\\", "/")

        for k, v in (manifest or {}).items():
            if not isinstance(v, dict):
                continue
            if str(v.get("label") or "") == src_rel_lbl:
                found_key = k
                break
            if str(v.get("image") or "") == src_rel_img:
                found_key = k
                break

        if found_key:
            cur = manifest.get(found_key)
            if not isinstance(cur, dict):
                cur = {}
            cur.update({"split": split_name, "image": rel_img, "label": rel_lbl})
            manifest[found_key] = cur

        return True
    except Exception:
        return False


def _ensure_nonempty_train_val(
    *,
    dataset_dir: Path,
    images_train: Path,
    images_val: Path,
    labels_train: Path,
    labels_val: Path,
    manifest: Dict[str, Any],
) -> None:
    """
    Ultralytics падает если images/val пустой.
    Поэтому гарантируем, что:
      - если val пустой и train не пустой -> копируем 1 пару train -> val
      - если train пустой и val не пустой -> копируем 1 пару val -> train
    """
    train_imgs = _list_images(images_train)
    val_imgs = _list_images(images_val)

    train_lbls = {p.stem: p for p in _list_labels(labels_train)}
    val_lbls = {p.stem: p for p in _list_labels(labels_val)}

    def pick_pair(imgs: List[Path], lbls: Dict[str, Path]) -> Optional[Tuple[Path, Path]]:
        for img in imgs:
            lbl = lbls.get(img.stem)
            if lbl and lbl.exists():
                return img, lbl
        return None

    if len(val_imgs) == 0 and len(train_imgs) > 0:
        pair = pick_pair(train_imgs, train_lbls)
        if pair:
            src_img, src_lbl = pair
            _copy_pair(
                dataset_dir=dataset_dir,
                src_img=src_img,
                src_lbl=src_lbl,
                dst_img_dir=images_val,
                dst_lbl_dir=labels_val,
                split_name="val",
                manifest=manifest,
            )

    train_imgs = _list_images(images_train)
    val_imgs = _list_images(images_val)
    if len(train_imgs) == 0 and len(val_imgs) > 0:
        pair = pick_pair(val_imgs, val_lbls)
        if pair:
            src_img, src_lbl = pair
            _copy_pair(
                dataset_dir=dataset_dir,
                src_img=src_img,
                src_lbl=src_lbl,
                dst_img_dir=images_train,
                dst_lbl_dir=labels_train,
                split_name="train",
                manifest=manifest,
            )


def _uniq_classes(xs: List[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for x in xs or []:
        nx = _norm(str(x))
        if not nx:
            continue
        k = _norm_low(nx)
        if k in seen:
            continue
        seen.add(k)
        out.append(nx)
    return out


def _ensure_prochee_last(xs: List[str]) -> List[str]:
    # гарантируем, что "прочее" существует и стоит в конце
    xs2 = _uniq_classes(xs)
    proch_key = _norm_low("прочее")

    filtered: List[str] = []
    has_proch = False
    for x in xs2:
        if _norm_low(x) == proch_key:
            has_proch = True
            continue
        filtered.append(x)

    if not has_proch:
        filtered.append("прочее")
    else:
        filtered.append("прочее")

    return filtered


# ---------------------------------------------------------------------
# ✅ Train precheck (per-session)
# ---------------------------------------------------------------------


@dataclass
class TrainValidationResult:
    ok: bool
    message: str
    stats: Dict[str, Any]


def validate_session_for_training(session_id: str) -> TrainValidationResult:
    """
    ✅ Быстрый валидатор перед запуском train (на уровне одной сессии).
    Возвращает ok/message/stats, чтобы фронт мог показать причину.
    """
    s = load_session(session_id)
    photos = s.get("photos", []) if isinstance(s.get("photos"), list) else []

    total_photos = 0
    photos_with_decision = 0
    defect_photos = 0
    ok_photos = 0

    total_bboxes = 0
    valid_bboxes = 0
    invalid_bboxes = 0
    defect_photos_with_bbox = 0

    missing_files = 0

    for ph in photos:
        if not isinstance(ph, dict):
            continue
        total_photos += 1

        labels = ph.get("labels") if isinstance(ph.get("labels"), dict) else {}
        decision = labels.get("decision")
        if decision in ("defect", "ok"):
            photos_with_decision += 1
            if decision == "defect":
                defect_photos += 1
            else:
                ok_photos += 1

        try:
            p = _resolve_photo_path(session_id, ph)
            if not p or not p.exists():
                missing_files += 1
        except Exception:
            missing_files += 1

        bxs = labels.get("bboxes") if isinstance(labels.get("bboxes"), list) else []
        if isinstance(bxs, list) and bxs:
            for b in bxs:
                if not isinstance(b, dict):
                    continue
                total_bboxes += 1
                if _bbox_ok(b):
                    valid_bboxes += 1
                else:
                    invalid_bboxes += 1

            if decision == "defect":
                if any(isinstance(b, dict) and _bbox_ok(b) for b in bxs):
                    defect_photos_with_bbox += 1

    stats = {
        "total_photos": total_photos,
        "photos_with_decision": photos_with_decision,
        "defect_photos": defect_photos,
        "ok_photos": ok_photos,
        "total_bboxes": total_bboxes,
        "valid_bboxes": valid_bboxes,
        "invalid_bboxes": invalid_bboxes,
        "defect_photos_with_bbox": defect_photos_with_bbox,
        "missing_files": missing_files,
    }

    if total_photos <= 0:
        return TrainValidationResult(
            ok=False,
            message="Обучение невозможно: в сессии нет загруженных фото.",
            stats=stats,
        )

    if defect_photos_with_bbox <= 0:
        return TrainValidationResult(
            ok=False,
            message=(
                "Обучение невозможно: нет ни одного фото с решением 'defect' и хотя бы одним bbox.\n"
                "Сделай разметку: выбери 'Есть дефект' и нарисуй хотя бы один bbox, затем сохрани."
            ),
            stats=stats,
        )

    if valid_bboxes <= 0:
        return TrainValidationResult(
            ok=False,
            message="Обучение невозможно: bbox есть, но все некорректные (нулевые или выходят за границы 0..1).",
            stats=stats,
        )

    return TrainValidationResult(ok=True, message="OK", stats=stats)


# ---------------------------------------------------------------------
# Dataset build (per-session accumulated)
# ---------------------------------------------------------------------


@dataclass
class BuildResult:
    dataset_dir: Path
    data_yaml: Path
    total_photos_in_session: int
    updated_images: int
    updated_labels: int
    total_labels_written: int


def build_accumulated_dataset_for_session(session_id: str, incremental: bool = True) -> BuildResult:
    """
    Накопительный датасет на диске:
      settings.ACCUM_DATASET_DIR/
        images/train
        images/val
        labels/train
        labels/val
        manifest.json
        data.yaml

    split: детерминированный по photo_id.
    """
    ensure_dirs()

    s = load_session(session_id)
    photos = s.get("photos", []) if isinstance(s.get("photos"), list) else []

    dataset_dir = settings.ACCUM_DATASET_DIR

    images_train = dataset_dir / "images" / "train"
    images_val = dataset_dir / "images" / "val"
    labels_train = dataset_dir / "labels" / "train"
    labels_val = dataset_dir / "labels" / "val"
    for p in [images_train, images_val, labels_train, labels_val]:
        p.mkdir(parents=True, exist_ok=True)

    manifest_path = dataset_dir / "manifest.json"
    manifest: Dict[str, Any] = {}
    try:
        if manifest_path.exists():
            manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(manifest_data, dict):
                manifest = manifest_data
    except Exception:
        manifest = {}

    # ✅ classes берём из сессии (snapshot)
    classes = _ensure_prochee_last(get_session_classes(session_id))
    cls_to_idx = {c: i for i, c in enumerate(classes)}

    def ensure_class(cls_name: str) -> int:
        nonlocal classes, cls_to_idx
        c = _norm(cls_name)
        if not c:
            c = "прочее"
        if c not in cls_to_idx:
            classes = _ensure_prochee_last(add_class_to_session(session_id, c))
            cls_to_idx = {cc: i for i, cc in enumerate(classes)}
        return int(cls_to_idx[c])

    updated_images = 0
    updated_labels = 0
    total_labels_written = 0

    def split_is_val(photo_id: str) -> bool:
        h = sum(ord(ch) for ch in str(photo_id))
        return (h % 10) < 2

    for ph in photos:
        if not isinstance(ph, dict):
            continue
        photo_id = str(ph.get("photo_id") or "")
        if not photo_id:
            continue

        key = f"{session_id}:{photo_id}"

        src_img = _resolve_photo_path(session_id, ph)
        if not src_img:
            continue

        is_val = split_is_val(photo_id)
        dst_img_dir = images_val if is_val else images_train
        dst_lbl_dir = labels_val if is_val else labels_train

        ext = src_img.suffix.lower() if src_img.suffix else ".jpg"
        dst_img = dst_img_dir / f"{session_id}_{photo_id}{ext}"
        dst_lbl = dst_lbl_dir / f"{session_id}_{photo_id}.txt"

        if not dst_img.exists():
            try:
                shutil.copy2(src_img, dst_img)
                updated_images += 1
            except Exception:
                pass

        labels = ph.get("labels") if isinstance(ph.get("labels"), dict) else {}
        decision = labels.get("decision")
        bboxes = labels.get("bboxes") if isinstance(labels.get("bboxes"), list) else []

        lines: List[str] = []

        if decision == "defect" and bboxes:
            for b in bboxes:
                if not isinstance(b, dict):
                    continue
                if not _bbox_ok(b):
                    continue

                cls = b.get("cls") or b.get("class") or "прочее"
                cls = _norm(str(cls))
                idx = ensure_class(cls)

                try:
                    x = float(b.get("x", 0.0))
                    y = float(b.get("y", 0.0))
                    w = float(b.get("w", 0.0))
                    h = float(b.get("h", 0.0))
                except Exception:
                    continue

                cx, cy, ww, hh = _xywh_to_yolo(x, y, w, h)
                lines.append(f"{idx} {cx:.6f} {cy:.6f} {ww:.6f} {hh:.6f}")

        txt = "\n".join(lines) + ("\n" if lines else "")
        prev = ""
        try:
            if dst_lbl.exists():
                prev = dst_lbl.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            prev = ""

        if (not incremental) or (prev != txt):
            try:
                dst_lbl.write_text(txt, encoding="utf-8")
                updated_labels += 1
            except Exception:
                pass

        total_labels_written += len(lines)

        manifest[key] = {
            "session_id": session_id,
            "photo_id": photo_id,
            "split": "val" if is_val else "train",
            "image": str(dst_img.relative_to(dataset_dir)).replace("\\", "/"),
            "label": str(dst_lbl.relative_to(dataset_dir)).replace("\\", "/"),
            "num_boxes": len(lines),
        }

    _ensure_nonempty_train_val(
        dataset_dir=dataset_dir,
        images_train=images_train,
        images_val=images_val,
        labels_train=labels_train,
        labels_val=labels_val,
        manifest=manifest,
    )

    atomic_write_json(manifest_path, manifest)

    data_yaml = dataset_dir / "data.yaml"
    dataset_dir_posix = dataset_dir.as_posix()

    yaml_txt = (
        f"path: {dataset_dir_posix}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"nc: {len(classes)}\n"
        f"names:\n"
        + "\n".join([f"  {i}: {json.dumps(name, ensure_ascii=False)}" for i, name in enumerate(classes)])
        + "\n"
    )
    data_yaml.write_text(yaml_txt, encoding="utf-8")

    return BuildResult(
        dataset_dir=dataset_dir,
        data_yaml=data_yaml,
        total_photos_in_session=len(photos),
        updated_images=updated_images,
        updated_labels=updated_labels,
        total_labels_written=total_labels_written,
    )


# ---------------------------------------------------------------------
# ✅ Dataset build (global, quality-mode style)
# ---------------------------------------------------------------------


@dataclass
class GlobalBuildResult:
    dataset_dir: Path
    data_yaml: Path
    manifest_path: Path

    sessions_scanned: int
    photos_scanned: int
    photos_included: int

    duplicates_skipped: int
    missing_files: int

    total_boxes_kept: int
    invalid_boxes_skipped: int

    updated_images: int
    updated_labels: int

    classes: List[str]
    seed: int
    min_train_objects: int


def _default_min_train_objects() -> int:
    raw = (str(getattr(settings, "MIN_TRAIN_OBJECTS", "") or "")).strip()
    if raw:
        try:
            v = int(raw)
            return v if v > 0 else 50
        except Exception:
            return 50
    return 50


def _default_seed() -> int:
    raw = (str(getattr(settings, "TRAIN_SEED", "") or "")).strip()
    if raw:
        try:
            return int(raw)
        except Exception:
            return 1337
    return 1337


def _global_split_is_val(img_hash: str, seed: int) -> bool:
    """
    Seeded 80/20 split по sha256.
    """
    try:
        x = int(img_hash[:8], 16)
    except Exception:
        x = sum(ord(c) for c in img_hash[:32])
    x = (x ^ int(seed)) & 0xFFFFFFFF
    return (x % 10) < 2  # 20%


def build_yolo_det_dataset_from_all_sessions(
    *,
    incremental: bool = True,
    seed: Optional[int] = None,
    min_train_objects: Optional[int] = None,
) -> GlobalBuildResult:
    """
    Глобальный датасет по всем sessions/*.json:
      data/datasets/yolo_det/
        images/train
        images/val
        labels/train
        labels/val
        manifest.json
        data.yaml

    ✅ ВАЖНО: classes берём из registry data/classes.json (get_global_classes()).
    Это устраняет рассинхрон после rename/add.
    """
    ensure_dirs()

    seed_v = int(seed) if isinstance(seed, int) else _default_seed()
    min_obj = int(min_train_objects) if isinstance(min_train_objects, int) else _default_min_train_objects()
    if min_obj <= 0:
        min_obj = 1

    # ✅ ЕДИНЫЙ ИСТОЧНИК КЛАССОВ ДЛЯ GLOBAL TRAIN
    classes = _ensure_prochee_last(get_global_classes())
    cls_to_idx_low: Dict[str, int] = {_norm_low(c): i for i, c in enumerate(classes)}
    fallback_idx = cls_to_idx_low.get(_norm_low("прочее"), 0)

    def class_to_idx(name: str) -> int:
        nn = _norm_low(name)
        if not nn:
            return int(fallback_idx)
        return int(cls_to_idx_low.get(nn, fallback_idx))

    dataset_dir = settings.DATASETS_DIR / "yolo_det"
    images_train = dataset_dir / "images" / "train"
    images_val = dataset_dir / "images" / "val"
    labels_train = dataset_dir / "labels" / "train"
    labels_val = dataset_dir / "labels" / "val"
    for p in [images_train, images_val, labels_train, labels_val]:
        p.mkdir(parents=True, exist_ok=True)

    manifest_path = dataset_dir / "manifest.json"
    manifest: Dict[str, Any] = {}
    try:
        if manifest_path.exists():
            d = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(d, dict):
                manifest = d
    except Exception:
        manifest = {}

    existing_hashes: Dict[str, Dict[str, Any]] = {}
    for k, v in (manifest or {}).items():
        if isinstance(k, str) and isinstance(v, dict):
            existing_hashes[k] = v

    sessions_scanned = 0
    photos_scanned = 0
    photos_included = 0
    duplicates_skipped = 0
    missing_files = 0
    total_boxes_kept = 0
    invalid_boxes_skipped = 0
    updated_images = 0
    updated_labels = 0

    sess_files: List[Path] = []
    try:
        sess_files = [p for p in settings.SESSIONS_DIR.glob("*.json") if p.is_file()]
    except Exception:
        sess_files = []

    for sess_path in sess_files:
        session_id = sess_path.stem
        sessions_scanned += 1

        try:
            # ✅ берём через load_session (устойчивость схемы)
            s = load_session(session_id)
        except Exception:
            continue

        photos = s.get("photos", []) if isinstance(s.get("photos"), list) else []
        for ph in photos:
            if not isinstance(ph, dict):
                continue
            photos_scanned += 1

            labels = ph.get("labels") if isinstance(ph.get("labels"), dict) else {}
            decision = labels.get("decision")
            if decision != "defect":
                continue

            bboxes = labels.get("bboxes") if isinstance(labels.get("bboxes"), list) else []
            if not bboxes:
                continue

            kept: List[Dict[str, Any]] = []
            for b in bboxes:
                if not isinstance(b, dict):
                    continue
                if _bbox_ok(b):
                    kept.append(b)
                else:
                    invalid_boxes_skipped += 1

            if not kept:
                continue

            src_img = _resolve_photo_path(session_id, ph)
            if not src_img or not src_img.exists() or not src_img.is_file():
                missing_files += 1
                continue

            img_hash = _sha256_file(src_img)
            if not img_hash:
                missing_files += 1
                continue

            photo_id = str(ph.get("photo_id") or "")

            if img_hash in existing_hashes:
                src_key = str(existing_hashes[img_hash].get("source_key") or "")
                cur_key = f"{session_id}:{photo_id}"
                if src_key and src_key != cur_key:
                    duplicates_skipped += 1
                    continue

            is_val = _global_split_is_val(img_hash, seed_v)
            dst_img_dir = images_val if is_val else images_train
            dst_lbl_dir = labels_val if is_val else labels_train

            ext = (src_img.suffix.lower() if src_img.suffix else ".jpg").strip()
            if not ext.startswith("."):
                ext = "." + ext
            if ext == ".":
                ext = ".jpg"

            dst_img = dst_img_dir / f"{img_hash}{ext}"
            dst_lbl = dst_lbl_dir / f"{img_hash}.txt"

            lines: List[str] = []
            for b in kept:
                cls = b.get("cls") or b.get("class") or "прочее"
                idx = class_to_idx(str(cls))

                try:
                    x = float(b.get("x", 0.0))
                    y = float(b.get("y", 0.0))
                    w = float(b.get("w", 0.0))
                    h = float(b.get("h", 0.0))
                except Exception:
                    invalid_boxes_skipped += 1
                    continue

                cx, cy, ww, hh = _xywh_to_yolo(x, y, w, h)
                lines.append(f"{idx} {cx:.6f} {cy:.6f} {ww:.6f} {hh:.6f}")

            if not lines:
                continue

            txt = "\n".join(lines) + "\n"

            if not dst_img.exists():
                try:
                    shutil.copy2(src_img, dst_img)
                    updated_images += 1
                except Exception:
                    continue

            prev = ""
            try:
                if dst_lbl.exists():
                    prev = dst_lbl.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                prev = ""

            if (not incremental) or (prev != txt):
                try:
                    dst_lbl.write_text(txt, encoding="utf-8")
                    updated_labels += 1
                except Exception:
                    continue

            photos_included += 1
            total_boxes_kept += len(lines)

            rel_img = str(dst_img.relative_to(dataset_dir)).replace("\\", "/")
            rel_lbl = str(dst_lbl.relative_to(dataset_dir)).replace("\\", "/")

            source_key = f"{session_id}:{photo_id}"
            manifest[img_hash] = {
                "hash": img_hash,
                "split": "val" if is_val else "train",
                "image": rel_img,
                "label": rel_lbl,
                "num_boxes": int(len(lines)),
                "session_id": session_id,
                "photo_id": photo_id,
                "source_key": source_key,
                "decision": "defect",
            }
            existing_hashes[img_hash] = manifest[img_hash]

    _ensure_nonempty_train_val(
        dataset_dir=dataset_dir,
        images_train=images_train,
        images_val=images_val,
        labels_train=labels_train,
        labels_val=labels_val,
        manifest=manifest,
    )

    total_objects = 0
    try:
        for v in (manifest or {}).values():
            if isinstance(v, dict):
                total_objects += int(v.get("num_boxes") or 0)
    except Exception:
        total_objects = int(total_boxes_kept)

    if total_objects < min_obj:
        atomic_write_json(manifest_path, manifest)

        data_yaml = dataset_dir / "data.yaml"
        dataset_dir_posix = dataset_dir.as_posix()
        yaml_txt = (
            f"path: {dataset_dir_posix}\n"
            f"train: images/train\n"
            f"val: images/val\n"
            f"nc: {len(classes)}\n"
            f"names:\n"
            + "\n".join([f"  {i}: {json.dumps(name, ensure_ascii=False)}" for i, name in enumerate(classes)])
            + "\n"
        )
        data_yaml.write_text(yaml_txt, encoding="utf-8")

        raise ValueError(
            "Обучение невозможно: недостаточно объектов для train.\n"
            f"Нужно минимум: {min_obj}\n"
            f"Сейчас объектов (bbox): {total_objects}\n"
            "Разметь больше дефектов (decision='defect' + bbox) и попробуй снова."
        )

    atomic_write_json(manifest_path, manifest)

    data_yaml = dataset_dir / "data.yaml"
    dataset_dir_posix = dataset_dir.as_posix()
    yaml_txt = (
        f"path: {dataset_dir_posix}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"nc: {len(classes)}\n"
        f"names:\n"
        + "\n".join([f"  {i}: {json.dumps(name, ensure_ascii=False)}" for i, name in enumerate(classes)])
        + "\n"
    )
    data_yaml.write_text(yaml_txt, encoding="utf-8")

    return GlobalBuildResult(
        dataset_dir=dataset_dir,
        data_yaml=data_yaml,
        manifest_path=manifest_path,
        sessions_scanned=int(sessions_scanned),
        photos_scanned=int(photos_scanned),
        photos_included=int(photos_included),
        duplicates_skipped=int(duplicates_skipped),
        missing_files=int(missing_files),
        total_boxes_kept=int(total_objects),
        invalid_boxes_skipped=int(invalid_boxes_skipped),
        updated_images=int(updated_images),
        updated_labels=int(updated_labels),
        classes=list(classes),
        seed=int(seed_v),
        min_train_objects=int(min_obj),
    )


__all__ = [
    "TrainValidationResult",
    "validate_session_for_training",
    "BuildResult",
    "build_accumulated_dataset_for_session",
    "GlobalBuildResult",
    "build_yolo_det_dataset_from_all_sessions",
]
