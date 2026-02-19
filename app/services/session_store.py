# app/services/session_store.py
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
from datetime import datetime, timezone

from app.core.config import settings
from app.utils.json_io import atomic_read_json, atomic_write_json

# ВАЖНО: базовый список классов (стартовый)
# Дальше классы могут расширяться и будут храниться в data/classes.json
DEFECT_CLASSES_RU = [
    "трещины",
    "протечки/высолы",
    "оголение арматуры",
    "коррозия",
    "сколы/разрушения",
    "отслоение/обрушение",
    "деформация",
    "грибок/плесень",
    "нарушение швов",
    "прочее",
]


# --------------------------
# Utils
# --------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _norm_cls(name: str) -> str:
    s = (name or "").strip()
    s = " ".join(s.split())
    return s


def _norm_key(name: str) -> str:
    return _norm_cls(name).lower()


def _sessions_path() -> Path:
    settings.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    return settings.SESSIONS_DIR


def session_file(session_id: str) -> Path:
    return _sessions_path() / f"{session_id}.json"


def _ensure_session_shape(s: Any, session_id: str) -> Dict[str, Any]:
    """
    ✅ Делает session JSON устойчивым:
    - если файл битый/пустой/не dict -> создаём новый session
    - гарантируем photos:list, classes:list[str]
    - для каждой photo гарантируем labels:dict и labels.bboxes:list
    """
    base_classes = get_global_classes()

    if not isinstance(s, dict):
        return {
            "session_id": session_id,
            "created_at": _now_iso(),
            "classes": list(base_classes),
            "photos": [],
        }

    out: Dict[str, Any] = dict(s)

    sid = str(out.get("session_id") or session_id)
    out["session_id"] = sid

    if not out.get("created_at"):
        out["created_at"] = _now_iso()

    xs = out.get("classes")
    if not isinstance(xs, list):
        out["classes"] = list(base_classes)
    else:
        cleaned = [_norm_cls(x) for x in xs if isinstance(x, str) and _norm_cls(x)]
        out["classes"] = cleaned if cleaned else list(base_classes)

    photos = out.get("photos")
    if not isinstance(photos, list):
        photos = []
    fixed_photos: List[Dict[str, Any]] = []
    for ph in photos:
        if not isinstance(ph, dict):
            continue

        p2 = dict(ph)
        if not p2.get("photo_id"):
            # если нет id — такая запись бесполезна
            continue

        labels = p2.get("labels")
        if not isinstance(labels, dict):
            labels = {}
        labels2 = dict(labels)

        # минимальная схема labels
        labels2.setdefault("has_defect", None)
        labels2.setdefault("decision", None)
        labels2.setdefault("category", None)
        labels2.setdefault("place", None)
        labels2.setdefault("comment", None)
        labels2.setdefault("recommendedFix", None)

        bxs = labels2.get("bboxes")
        if not isinstance(bxs, list):
            bxs = []
        labels2["bboxes"] = bxs

        p2["labels"] = labels2
        fixed_photos.append(p2)

    out["photos"] = fixed_photos
    return out


def _validate_class_name_or_400(name: str) -> str:
    cls = _norm_cls(name)
    if not cls:
        raise ValueError("Пустое имя класса")
    if len(cls) < 2:
        raise ValueError("Слишком короткое имя класса")
    return cls


# --------------------------
# Global classes (data/classes.json)
# --------------------------

def _global_classes_file() -> Path:
    # backend/data/classes.json
    p = settings.DATA_DIR / "classes.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def get_global_classes() -> List[str]:
    """
    Глобальный список классов для проекта.
    Если файла нет — создаём его из DEFECT_CLASSES_RU.
    """
    p = _global_classes_file()
    if not p.exists():
        atomic_write_json(p, {"classes": list(DEFECT_CLASSES_RU)})
        return list(DEFECT_CLASSES_RU)

    try:
        data = atomic_read_json(p, default={})
        xs = data.get("classes")
        if isinstance(xs, list) and all(isinstance(x, str) for x in xs) and xs:
            out = [_norm_cls(x) for x in xs if _norm_cls(x)]
            return out if out else list(DEFECT_CLASSES_RU)
    except Exception:
        pass

    # fallback
    atomic_write_json(p, {"classes": list(DEFECT_CLASSES_RU)})
    return list(DEFECT_CLASSES_RU)


def _write_global_classes(classes: List[str]) -> None:
    atomic_write_json(_global_classes_file(), {"classes": classes})


def add_global_class(name: str) -> List[str]:
    """
    Добавляет новый класс в global classes (если его ещё нет).
    Возвращает обновлённый список.
    """
    cls = _norm_cls(name)
    if not cls:
        return get_global_classes()

    cur = get_global_classes()
    if _norm_key(cls) in {_norm_key(x) for x in cur}:
        return cur

    cur.append(cls)
    _write_global_classes(cur)
    return cur


def rename_global_class(frm: str, to: str) -> List[str]:
    """
    Переименовывает класс в global classes (если найден).
    """
    a = _norm_cls(frm)
    b = _norm_cls(to)
    if not a or not b:
        return get_global_classes()

    cur = get_global_classes()
    cur_keys = [_norm_key(x) for x in cur]

    if _norm_key(a) not in cur_keys:
        # если не нашли — добавим to (на всякий)
        if _norm_key(b) not in set(cur_keys):
            cur.append(b)
            _write_global_classes(cur)
        return cur

    out: List[str] = []
    replaced = False
    seen = set()
    for x in cur:
        k = _norm_key(x)
        if not replaced and k == _norm_key(a):
            x2 = b
            replaced = True
            k2 = _norm_key(x2)
            if k2 in seen:
                continue
            seen.add(k2)
            out.append(x2)
        else:
            if k in seen:
                continue
            seen.add(k)
            out.append(x)

    if not out:
        out = list(DEFECT_CLASSES_RU)

    _write_global_classes(out)
    return out


# --------------------------
# Session classes (snapshot)
# --------------------------

def get_session_classes(session_id: str) -> List[str]:
    """
    Классы конкретной сессии (snapshot).
    Если в сессии нет классов — вернём глобальные.
    """
    s = load_session(session_id)
    xs = s.get("classes")
    if isinstance(xs, list) and xs and all(isinstance(x, str) for x in xs):
        out = [_norm_cls(x) for x in xs if _norm_cls(x)]
        return out if out else get_global_classes()
    return get_global_classes()


def add_class_to_session(session_id: str, name: str) -> List[str]:
    """
    Добавляет класс и в global, и в session snapshot.
    Возвращает обновлённый список классов сессии.
    """
    cls = _norm_cls(name)
    if not cls:
        return get_session_classes(session_id)

    # 1) global
    global_list = add_global_class(cls)

    # 2) session
    s = load_session(session_id)
    xs = s.get("classes")
    if not isinstance(xs, list) or not xs:
        xs = list(global_list)
    else:
        xs = [_norm_cls(x) for x in xs if isinstance(x, str) and _norm_cls(x)]
        # синхронизация: добавим missing global -> session
        gkeys = {_norm_key(x) for x in xs}
        for g in global_list:
            if _norm_key(g) not in gkeys:
                xs.append(g)
                gkeys.add(_norm_key(g))

    # ensure cls present
    if _norm_key(cls) not in {_norm_key(x) for x in xs}:
        xs.append(cls)

    # гарантируем "прочее"
    if _norm_key("прочее") not in {_norm_key(x) for x in xs}:
        xs.append("прочее")

    s["classes"] = xs
    save_session(session_id, s)
    return list(xs)


def rename_class_in_session(session_id: str, frm: str, to: str) -> List[str]:
    """
    ✅ Переименовывает класс в:
    - global classes.json
    - session snapshot classes
    - session photos labels.bboxes[].cls (и на всякий случай labels.bboxes[].class)

    Возвращает обновлённый список классов сессии.
    """
    a = _validate_class_name_or_400(frm)
    b = _validate_class_name_or_400(to)

    if _norm_key(a) == _norm_key(b):
        return get_session_classes(session_id)

    # 1) global
    rename_global_class(a, b)

    # 2) session + photos
    s = load_session(session_id)

    # session classes
    xs = s.get("classes")
    if not isinstance(xs, list):
        xs = []

    out_classes: List[str] = []
    replaced_in_classes = False
    seen = set()

    for x in xs:
        if not isinstance(x, str):
            continue
        nx = _norm_cls(x)
        if not nx:
            continue
        if (not replaced_in_classes) and _norm_key(nx) == _norm_key(a):
            nx = b
            replaced_in_classes = True
        k = _norm_key(nx)
        if k in seen:
            continue
        seen.add(k)
        out_classes.append(nx)

    # если старого имени в списке классов не было — это не ошибка
    if _norm_key(b) not in seen:
        out_classes.append(b)
        seen.add(_norm_key(b))

    # гарантируем "прочее"
    if _norm_key("прочее") not in seen:
        out_classes.append("прочее")
        seen.add(_norm_key("прочее"))

    s["classes"] = out_classes

    # update bboxes in photos
    photos = s.get("photos")
    if not isinstance(photos, list):
        photos = []

    for ph in photos:
        if not isinstance(ph, dict):
            continue
        labels = ph.get("labels")
        if not isinstance(labels, dict):
            continue
        bxs = labels.get("bboxes")
        if not isinstance(bxs, list):
            continue

        changed = False
        for bb in bxs:
            if not isinstance(bb, dict):
                continue

            raw = bb.get("cls")
            if raw is None:
                raw = bb.get("class")

            cls0 = _norm_cls(str(raw or ""))
            if cls0 and _norm_key(cls0) == _norm_key(a):
                bb["cls"] = b
                # не обязаны удалять старое поле, но если есть "class" — синхронизируем
                if "class" in bb:
                    bb["class"] = b
                changed = True

        if changed:
            # приведение к канону и дедуп (на всякий случай после массовой замены)
            try:
                labels["bboxes"] = dedupe_bboxes(bxs)
            except Exception:
                labels["bboxes"] = bxs
            ph["labels"] = labels

    s["photos"] = photos
    save_session(session_id, s)
    return list(out_classes)


# --------------------------
# Sessions
# --------------------------

def create_session(session_id: str) -> Dict[str, Any]:
    base_classes = get_global_classes()
    s = {
        "session_id": session_id,
        "created_at": _now_iso(),
        "classes": list(base_classes),
        "photos": [],
    }
    atomic_write_json(session_file(session_id), s)
    return s


def load_session(session_id: str) -> Dict[str, Any]:
    """
    ✅ ВАЖНО: это место чаще всего ломает upload.
    Делаем максимально устойчиво:
    - если файла нет -> create_session
    - если json битый/пустой -> восстановим базовый session
    - если структура неполная -> дополним
    """
    p = session_file(session_id)
    if not p.exists():
        return create_session(session_id)

    try:
        raw = atomic_read_json(p, default=None)
    except Exception:
        raw = None

    fixed = _ensure_session_shape(raw, session_id)

    # если пришлось чинить — перезапишем (чтобы дальше всё было стабильно)
    try:
        if raw != fixed:
            atomic_write_json(p, fixed)
    except Exception:
        pass

    return fixed


def save_session(session_id: str, data: Dict[str, Any]) -> None:
    fixed = _ensure_session_shape(data, session_id)
    atomic_write_json(session_file(session_id), fixed)


def find_photo(session: Dict[str, Any], photo_id: str) -> Optional[Dict[str, Any]]:
    for ph in session.get("photos", []) or []:
        if isinstance(ph, dict) and ph.get("photo_id") == photo_id:
            return ph
    return None


def add_photo(
    session_id: str,
    photo_id: str,
    original_name: str,
    stored_name: str,
    relative_path: str,
) -> Dict[str, Any]:
    s = load_session(session_id)

    # ✅ идемпотентность: если уже есть — просто вернём существующую запись
    existing = find_photo(s, photo_id)
    if existing:
        return existing

    photos = s.get("photos")
    if not isinstance(photos, list):
        photos = []

    ph = {
        "photo_id": photo_id,
        "original_name": original_name,
        "stored_name": stored_name,
        "relative_path": relative_path,
        "labels": {
            "has_defect": None,        # bool | None
            "decision": None,          # "defect"/"ok"/None (для совместимости)
            "category": None,          # "A"/"Б"/"В"/None
            "place": None,             # str | None
            "comment": None,           # str | None
            "recommendedFix": None,    # str | None
            "bboxes": [],              # list[bbox]
        },
    }

    photos.append(ph)
    s["photos"] = photos
    save_session(session_id, s)
    return ph


# --------------------------
# BBoxes normalize/dedupe
# --------------------------

def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def _round6(x: float) -> float:
    return float(f"{x:.6f}")


def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except Exception:
        return float(default)


def _normalize_xywh(x: float, y: float, w: float, h: float) -> Tuple[float, float, float, float]:
    w = max(0.0, w)
    h = max(0.0, h)

    x = _clamp01(x)
    y = _clamp01(y)
    w = _clamp01(w)
    h = _clamp01(h)

    # ensure box stays inside
    x = _clamp01(min(x, 1.0 - w))
    y = _clamp01(min(y, 1.0 - h))

    return x, y, w, h


def dedupe_bboxes(bboxes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Remove duplicates (same class + nearly same coords).
    НЕ теряем id / polygon / conf / source.

    Канонический формат bbox внутри session:
      {
        "id": str|None,
        "cls": str,
        "x": float, "y": float, "w": float, "h": float,   # norm 0..1
        "conf": float|None,
        "source": str|None,
        "polygon": any
      }
    """
    seen = set()
    out: List[Dict[str, Any]] = []

    for b in bboxes or []:
        if not isinstance(b, dict):
            continue

        cls = str(b.get("cls") or b.get("class") or b.get("name") or "")
        cls = _norm_cls(cls) or "прочее"

        x0 = _safe_float(b.get("x", 0.0), 0.0)
        y0 = _safe_float(b.get("y", 0.0), 0.0)
        w0 = _safe_float(b.get("w", 0.0), 0.0)
        h0 = _safe_float(b.get("h", 0.0), 0.0)

        x, y, w, h = _normalize_xywh(x0, y0, w0, h0)

        x = _round6(x)
        y = _round6(y)
        w = _round6(w)
        h = _round6(h)

        key = (_norm_key(cls), x, y, w, h)
        if key in seen:
            continue
        seen.add(key)

        conf = b.get("conf", b.get("confidence"))
        if conf is not None:
            cf = _safe_float(conf, 0.0)
            conf = _clamp01(cf)

        out.append(
            {
                "id": str(b.get("id")) if b.get("id") is not None else None,
                "cls": cls,
                "x": x,
                "y": y,
                "w": w,
                "h": h,
                "conf": conf,
                "source": b.get("source"),
                "polygon": b.get("polygon"),
            }
        )

    return out


def set_photo_labels(
    session_id: str,
    photo_id: str,
    labels_patch: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Idempotent label save:
    - overwrites bboxes list (NOT append)
    - dedupes bboxes (но сохраняет id/поля)
    - ✅ автоматически добавляет новые классы в global/session
    """
    s = load_session(session_id)
    ph = find_photo(s, photo_id)
    if not ph:
        raise KeyError(f"Фото не найдено: {photo_id}")

    labels = ph.get("labels")
    if not isinstance(labels, dict):
        labels = {}

    for k in ["has_defect", "decision", "category", "place", "comment", "recommendedFix"]:
        if k in labels_patch:
            labels[k] = labels_patch[k]

    if "bboxes" in labels_patch:
        deduped = dedupe_bboxes(labels_patch.get("bboxes") or [])

        # ✅ ensure classes exist
        for b in deduped:
            cls = _norm_cls(str(b.get("cls") or "")) or "прочее"
            add_class_to_session(session_id, cls)

        labels["bboxes"] = deduped

    ph["labels"] = labels

    # ✅ гарантируем, что photos — список (на всякий)
    photos = s.get("photos")
    if not isinstance(photos, list):
        photos = []
    s["photos"] = photos

    save_session(session_id, s)
    return ph


def set_photo_bboxes(
    session_id: str,
    photo_id: str,
    bboxes: List[Dict[str, Any]],
) -> Dict[str, Any]:
    return set_photo_labels(session_id, photo_id, {"bboxes": bboxes})


__all__ = [
    "DEFECT_CLASSES_RU",
    "session_file",
    "create_session",
    "load_session",
    "save_session",
    "add_photo",
    "find_photo",
    "set_photo_labels",
    "set_photo_bboxes",
    "get_global_classes",
    "add_global_class",
    "get_session_classes",
    "add_class_to_session",
    "rename_class_in_session",
]
