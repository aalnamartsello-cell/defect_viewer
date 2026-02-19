# app/utils/json_io.py
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Union


JsonPath = Union[str, Path]


def atomic_write_json(path: JsonPath, data: Any, *, ensure_ascii: bool = False, indent: int = 2) -> None:
    """
    Atomically write JSON to file:
    - write to temp file in same directory
    - fsync
    - replace target
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_name = tempfile.mkstemp(prefix=p.name + ".", suffix=".tmp", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=ensure_ascii, indent=indent)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, p)
    finally:
        try:
            if os.path.exists(tmp_name):
                os.remove(tmp_name)
        except OSError:
            pass


def atomic_read_json(path: JsonPath, *, default: Any = None) -> Any:
    """
    Read JSON from file. If file doesn't exist and default is provided, returns default.
    If default is None and file doesn't exist -> raises FileNotFoundError.
    """
    p = Path(path)
    if not p.exists():
        if default is not None:
            return default
        raise FileNotFoundError(str(p))

    text = p.read_text(encoding="utf-8", errors="strict")
    if not text.strip():
        return default if default is not None else {}
    return json.loads(text)
