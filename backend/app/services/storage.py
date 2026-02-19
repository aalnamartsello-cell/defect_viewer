# app/services/storage.py
from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Tuple

from fastapi import UploadFile

from app.core.config import settings


def _get_ext(filename: str) -> str:
    _, ext = os.path.splitext(filename or "")
    return (ext or "").lower()


def validate_ext(filename: str) -> str:
    ext = _get_ext(filename)
    allowed = getattr(settings, "ALLOWED_EXTS", [".jpg", ".jpeg", ".png", ".webp"])
    if ext not in set(e.lower() for e in allowed):
        raise ValueError(f"Недопустимый формат файла: {ext}. Разрешены: {', '.join(allowed)}")
    return ext


def _validate_size(file: UploadFile) -> None:
    max_mb = int(getattr(settings, "MAX_UPLOAD_MB", 25))
    max_bytes = max_mb * 1024 * 1024

    try:
        pos = file.file.tell()
        file.file.seek(0, os.SEEK_END)
        size = file.file.tell()
        file.file.seek(pos, os.SEEK_SET)
    except Exception:
        return

    if size > max_bytes:
        raise ValueError(f"Слишком большой файл: {size/1024/1024:.1f}MB. Максимум: {max_mb}MB")


def save_upload(session_id: str, up: UploadFile) -> Tuple[str, str, str, str]:
    """
    Сохраняет upload в data/uploads/<session_id>/<uuid>.<ext>

    Возвращает:
      (photo_id, original_name, stored_name, relative_path)
    """
    if not up or not up.filename:
        raise ValueError("Пустой файл (filename отсутствует).")

    validate_ext(up.filename)
    _validate_size(up)

    photo_id = str(uuid.uuid4())
    original_name = up.filename

    session_dir = Path(settings.UPLOADS_DIR) / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    ext = _get_ext(original_name)
    stored_name = f"{photo_id}{ext}"
    abs_path = session_dir / stored_name

    with abs_path.open("wb") as f:
        up.file.seek(0)
        while True:
            chunk = up.file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)

    # относительный к BASE_DIR (как ожидает твой routes resolver)
    try:
        relative_path = abs_path.relative_to(settings.BASE_DIR).as_posix()
    except Exception:
        relative_path = str(abs_path)

    return photo_id, original_name, stored_name, relative_path
