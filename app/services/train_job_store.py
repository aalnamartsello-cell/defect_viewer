# app/services/train_job_store.py
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.core.config import settings

# =========================================================
# Train jobs on disk — survives restart
# =========================================================

SERVER_BOOT_ID = str(uuid.uuid4())

# allow override via settings, but keep old default path
_raw_jobs_dir = getattr(settings, "TRAIN_JOBS_DIR", None)
if isinstance(_raw_jobs_dir, Path):
    JOBS_DIR = _raw_jobs_dir
elif isinstance(_raw_jobs_dir, str) and _raw_jobs_dir.strip():
    JOBS_DIR = Path(_raw_jobs_dir.strip())
else:
    JOBS_DIR = settings.DATA_DIR / "_train_jobs"

JOBS_INDEX = JOBS_DIR / "index.json"
JOBS_LOCK = threading.Lock()

# If log not updated > N seconds and job not done/error — consider lost
JOB_STALE_SEC = int(getattr(settings, "TRAIN_JOB_STALE_SEC", 120) or 120)


def now_ns() -> int:
    return time.time_ns()


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _ensure_jobs_dir() -> None:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)


def job_path(job_id: str) -> Path:
    return JOBS_DIR / f"{job_id}.json"


def _load_json(path: Path) -> Any:
    try:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _load_index() -> List[str]:
    data = _load_json(JOBS_INDEX)
    if isinstance(data, list):
        return [str(x) for x in data if str(x)]
    return []


def _save_index(ids: List[str]) -> None:
    seen = set()
    out: List[str] = []
    for x in ids:
        x = str(x or "").strip()
        if not x:
            continue
        if x in seen:
            continue
        seen.add(x)
        out.append(x)
    _atomic_write_json(JOBS_INDEX, out)


def _touch_index(job_id: str) -> None:
    idx = _load_index()
    _save_index([job_id] + idx)


def _maybe_mark_lost(job: Dict[str, Any]) -> Dict[str, Any]:
    """
    If service restarted / another worker wrote status, and log hasn't been updated
    for a long time -> mark as lost to prevent "running forever".
    """
    try:
        status = str(job.get("status") or "")
        if status not in ("queued", "running"):
            return job

        boot_id = str(job.get("boot_id") or "")
        if boot_id == SERVER_BOOT_ID:
            return job

        log_path = Path(str(job.get("log_path") or ""))
        if log_path.exists():
            try:
                age = time.time() - log_path.stat().st_mtime
                if age <= float(JOB_STALE_SEC):
                    return job
            except Exception:
                pass

        job_id = str(job.get("job_id") or "")
        job["status"] = "lost"
        job["message"] = (
            "Сервис был перезапущен или статус читается из другого воркера. "
            "Этот job больше не отслеживается в текущем процессе. "
            "Проверь лог и запусти обучение заново при необходимости."
        )
        job["updated_at_ns"] = now_ns()
        if job_id:
            _atomic_write_json(job_path(job_id), job)
        return job
    except Exception:
        return job


def set_job(job_id: str, patch: Dict[str, Any]) -> None:
    """
    Create or update job json atomically.
    Always writes:
      - job_id
      - created_at_ns
      - updated_at_ns
      - boot_id
      - worker_pid
    """
    _ensure_jobs_dir()
    job_id = str(job_id or "").strip()
    if not job_id:
        return

    with JOBS_LOCK:
        path = job_path(job_id)
        cur = _load_json(path)
        if not isinstance(cur, dict):
            cur = {}

        if "job_id" not in cur:
            cur["job_id"] = job_id
        if "created_at_ns" not in cur:
            cur["created_at_ns"] = now_ns()

        cur["boot_id"] = SERVER_BOOT_ID
        cur["worker_pid"] = os.getpid()

        cur.update(patch or {})
        cur["updated_at_ns"] = now_ns()

        _atomic_write_json(path, cur)
        _touch_index(job_id)


def get_job(job_id: str) -> Dict[str, Any]:
    _ensure_jobs_dir()
    job_id = str(job_id or "").strip()
    if not job_id:
        return {}

    with JOBS_LOCK:
        data = _load_json(job_path(job_id))
        if not isinstance(data, dict):
            return {}
    return _maybe_mark_lost(data)


def list_jobs(limit: int = 50) -> List[Dict[str, Any]]:
    _ensure_jobs_dir()
    limit = max(1, int(limit or 50))

    idx = _load_index()
    jobs: List[Dict[str, Any]] = []

    if not idx:
        # fallback — scan directory
        try:
            files = sorted(
                [p for p in JOBS_DIR.glob("train_*.json") if p.is_file()],
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            idx = [p.stem for p in files]
        except Exception:
            idx = []

    for job_id in idx[:limit]:
        j = get_job(job_id)
        if j:
            jobs.append(j)

    try:
        jobs.sort(key=lambda x: int(x.get("updated_at_ns") or 0), reverse=True)
    except Exception:
        pass

    return jobs


__all__ = [
    "SERVER_BOOT_ID",
    "JOBS_DIR",
    "JOBS_INDEX",
    "JOB_STALE_SEC",
    "set_job",
    "get_job",
    "list_jobs",
]
