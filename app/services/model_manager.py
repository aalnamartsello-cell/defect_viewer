# app/services/model_manager.py
from __future__ import annotations

import hashlib
import logging
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from app.core.config import settings

logger = logging.getLogger("model_manager")


def _norm(s: str) -> str:
    s = (s or "").strip().lower()
    s = s.replace("_", " ")
    s = " ".join(s.split())
    s = s.replace(" / ", "/").replace("/ ", "/").replace(" /", "/")
    return s


def _extract_names(model: Any) -> List[str]:
    names = getattr(model, "names", None)
    if isinstance(names, dict):
        out: List[str] = []
        try:
            for i in sorted(names.keys()):
                out.append(str(names[i]))
            return out
        except Exception:
            return [str(v) for v in names.values()]
    if isinstance(names, (list, tuple)):
        return [str(x) for x in names]
    return [str(names)] if names is not None else []


def _resolve_device() -> Tuple[str, bool]:
    """
    Returns (device_str, auto_cpu_fallback_flag).
    device_str: "cpu" or "0"/"1"/... (ultralytics device argument)
    """
    req = str(getattr(settings, "INFER_DEVICE", "auto") or "auto").strip().lower()

    if req in ("cpu", "-1"):
        return "cpu", False

    if req in ("auto", "cuda", "gpu"):
        try:
            import torch  # type: ignore

            if torch.cuda.is_available() and int(torch.cuda.device_count()) > 0:
                return "0", False
            return "cpu", True
        except Exception:
            return "cpu", True

    try:
        import torch  # type: ignore

        if torch.cuda.is_available() and int(torch.cuda.device_count()) > 0:
            return req, False
        return "cpu", True
    except Exception:
        return "cpu", True


def _resolve_weights_path() -> Any:
    """
    Prefer explicit Path from settings.resolve_infer_model().
    If not found, optionally allow ultralytics default weights (string like "yolov8n.pt").
    """
    use_seg = bool(getattr(settings, "INFER_USE_SEGMENTATION", False))

    p = settings.resolve_infer_model()
    if isinstance(p, Path) and p.exists() and p.is_file():
        return p

    allow = bool(getattr(settings, "INFER_ALLOW_AUTO_DOWNLOAD_DEFAULT_WEIGHTS", True))
    if not allow:
        raise FileNotFoundError(
            f"Файл модели не найден: {p}. "
            "Автоскачивание дефолтных весов запрещено (INFER_ALLOW_AUTO_DOWNLOAD_DEFAULT_WEIGHTS=false)."
        )

    return settings.INFER_DEFAULT_WEIGHTS_SEG if use_seg else settings.INFER_DEFAULT_WEIGHTS_DET


def _weights_key(weights: Any) -> str:
    """
    Ключ кэша: путь + mtime_ns + size, чтобы перезапись model.pt вызывала reload.
    """
    if isinstance(weights, Path):
        try:
            p = weights.resolve()
        except Exception:
            p = weights

        try:
            st = p.stat()
            mtime_ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))
            return f"{str(p)}::mtime_ns={mtime_ns}::size={int(st.st_size)}"
        except Exception:
            return str(p)

    return str(weights)


def _file_stat_ns(p: Path) -> Tuple[Optional[int], Optional[int]]:
    try:
        if not p.exists() or not p.is_file():
            return None, None
        st = p.stat()
        mtime_ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))
        size = int(st.st_size)
        return mtime_ns, size
    except Exception:
        return None, None


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


def _get_expected_registry_classes() -> List[str]:
    """
    ЕДИНЫЙ ИСТОЧНИК "ожидаемых" классов для диагностик/strict:
    backend/data/classes.json (через session_store.get_global_classes()).
    """
    try:
        from app.services.session_store import get_global_classes  # type: ignore

        xs = get_global_classes()
        if isinstance(xs, list) and xs:
            return [str(x) for x in xs]
    except Exception:
        pass
    return []


class ModelManager:
    _inst: Optional["ModelManager"] = None
    _inst_lock = threading.Lock()

    def __init__(self) -> None:
        self._load_lock = threading.Lock()
        self._predict_lock = threading.Lock()

        self._model: Any = None
        self._names: List[str] = []
        self._weights_key: str = ""
        self._use_seg: bool = False

        # last resolved infer settings
        self._device: str = "cpu"
        self._auto_cpu_fallback: bool = False

        # sha cache (because /health/ml may poll often)
        self._sha_cache_key: str = ""
        self._sha_cache_value: Optional[str] = None

    @classmethod
    def instance(cls) -> "ModelManager":
        with cls._inst_lock:
            if cls._inst is None:
                cls._inst = cls()
            return cls._inst

    @contextmanager
    def predict_lock(self) -> Iterator[None]:
        with self._predict_lock:
            yield

    def invalidate(self) -> None:
        with self._load_lock:
            self._model = None
            self._names = []
            self._weights_key = ""
            self._use_seg = False
        logger.info("ModelManager.invalidate(): cache cleared")

    def is_loaded(self) -> bool:
        return self._model is not None

    def names(self) -> List[str]:
        return list(self._names)

    def class_name(self, cls_idx: int) -> str:
        try:
            i = int(cls_idx)
        except Exception:
            return "unknown"
        if 0 <= i < len(self._names):
            return self._names[i]
        return "unknown"

    def auto_cpu_fallback(self) -> bool:
        return bool(self._auto_cpu_fallback)

    def weights_key(self) -> str:
        if self._weights_key:
            return self._weights_key
        try:
            return _weights_key(_resolve_weights_path())
        except Exception:
            return ""

    def get(
        self,
        *,
        load_if_needed: bool = True,
        force_cpu: bool = False,
    ) -> Tuple[Any, bool, str, bool]:
        """
        Returns:
          (model, use_seg, device_str, auto_cpu_fallback_flag)

        - load_if_needed=False: не грузим модель, просто вернем текущую (может быть None).
        - force_cpu=True: возвращаем device="cpu" и auto_cpu_fallback=False.
        """
        use_seg = bool(getattr(settings, "INFER_USE_SEGMENTATION", False))
        weights = _resolve_weights_path()

        device, auto_cpu = _resolve_device()
        if force_cpu:
            device, auto_cpu = "cpu", False

        wk = _weights_key(weights)
        need_reload = self._model is None or self._weights_key != wk or self._use_seg != use_seg

        self._device = device
        self._auto_cpu_fallback = bool(auto_cpu)

        if not load_if_needed:
            return self._model, self._use_seg, self._device, self._auto_cpu_fallback

        if need_reload:
            with self._load_lock:
                need_reload2 = self._model is None or self._weights_key != wk or self._use_seg != use_seg
                if need_reload2:
                    try:
                        from ultralytics import YOLO  # type: ignore
                    except Exception as e:
                        raise RuntimeError("Не установлен ultralytics. Установи: pip install ultralytics") from e

                    logger.info("Loading YOLO model: weights=%s use_seg=%s", str(weights), bool(use_seg))
                    self._model = YOLO(str(weights))
                    self._weights_key = wk
                    self._use_seg = use_seg

                    raw_names = _extract_names(self._model)
                    self._names = self._apply_mapping(raw_names)
                    self._validate_strict_if_needed(self._names)

        return self._model, self._use_seg, self._device, self._auto_cpu_fallback

    def get_cpu_fallback(self) -> Tuple[Any, bool, str, bool]:
        """
        Явный CPU fallback (для инференса при CUDA ошибках).
        """
        return self.get(load_if_needed=True, force_cpu=True)

    def _sha256_cached(self, p: Path) -> Optional[str]:
        """
        sha256 может быть дорогим (особенно если weights большие и /health/ml пуляют часто).
        Кэшируем по (path, mtime_ns, size).
        """
        mtime_ns, size = _file_stat_ns(p)
        key = f"{str(p)}::{mtime_ns or ''}::{size or ''}"
        if key and key == self._sha_cache_key:
            return self._sha_cache_value
        sha = _sha256_file(p)
        self._sha_cache_key = key
        self._sha_cache_value = sha
        return sha

    def describe(self, *, load: bool = False) -> Dict[str, Any]:
        """
        /health/ml
        Важно: плоские поля наверху, чтобы фронт мог deepPick*.

        load=True может подтянуть дефолтные веса ultralytics (если weights — строка типа yolov8n.pt).
        """
        use_seg = bool(getattr(settings, "INFER_USE_SEGMENTATION", False))
        requested_device = str(getattr(settings, "INFER_DEVICE", "auto") or "auto").strip()
        resolved_device, auto_cpu = _resolve_device()

        weights_error: Optional[str] = None
        resolved_weights: Any = None

        weights_path_str: Optional[str] = None
        weights_key_str: Optional[str] = None
        sha256: Optional[str] = None
        mtime_ns: Optional[int] = None
        size: Optional[int] = None
        exists: Optional[bool] = None

        try:
            resolved_weights = _resolve_weights_path()
            weights_key_str = _weights_key(resolved_weights)

            if isinstance(resolved_weights, Path):
                weights_path_str = str(resolved_weights.resolve())
                exists = bool(resolved_weights.exists() and resolved_weights.is_file())
                mtime_ns, size = _file_stat_ns(resolved_weights)
                sha256 = self._sha256_cached(resolved_weights)
            else:
                # строка типа "yolov8n.pt"
                weights_path_str = str(resolved_weights)
                exists = None
        except Exception as e:
            weights_error = str(e)

        weights_info: Dict[str, Any] = {
            "resolved": weights_key_str or None,
            "resolved_path": weights_path_str or None,
            "exists": exists,
            "error": weights_error,
            "allow_auto_download_default": bool(getattr(settings, "INFER_ALLOW_AUTO_DOWNLOAD_DEFAULT_WEIGHTS", True)),
            "default_det": str(getattr(settings, "INFER_DEFAULT_WEIGHTS_DET", "yolov8n.pt")),
            "default_seg": str(getattr(settings, "INFER_DEFAULT_WEIGHTS_SEG", "yolov8n-seg.pt")),
            "use_seg": bool(use_seg),
        }

        torch_info: Dict[str, Any]
        try:
            import torch  # type: ignore

            torch_info = {
                "version": getattr(torch, "__version__", None),
                "cuda_available": bool(torch.cuda.is_available()),
                "cuda_device_count": int(torch.cuda.device_count()) if torch.cuda.is_available() else 0,
            }
        except Exception as e:
            torch_info = {"error": str(e)}

        ultralytics_info: Dict[str, Any]
        try:
            import ultralytics  # type: ignore

            ultralytics_info = {"version": getattr(ultralytics, "__version__", None)}
        except Exception as e:
            ultralytics_info = {"error": str(e)}

        strict = bool(getattr(settings, "INFER_STRICT_MODEL_CLASSES", False))
        mapping = getattr(settings, "INFER_MODEL_CLASS_MAPPING", None) or {}

        expected = _get_expected_registry_classes()

        out: Dict[str, Any] = {
            "ok": True,

            # ✅ FLAT FIELDS FOR FRONTEND
            "weights_path": weights_path_str,
            "weights_key": weights_key_str,
            "sha256": sha256,
            "mtime_ns": int(mtime_ns) if isinstance(mtime_ns, int) else None,
            "size": int(size) if isinstance(size, int) else None,
            "device": str(resolved_device),
            "use_seg": bool(use_seg),

            "model_loaded": self.is_loaded(),
            "names": self.names() if self.is_loaded() else None,
            "auto_cpu_fallback": bool(auto_cpu),

            # debug/extended
            "requested_device": requested_device,
            "resolved_device": str(resolved_device),
            "weights": weights_info,
            "strict_classes": bool(strict),
            "mapping_enabled": bool(mapping),
            "expected_classes_source": "data/classes.json",
            "expected_classes": expected,
            "model_names": self.names() if self.is_loaded() else None,
            "torch": torch_info,
            "ultralytics": ultralytics_info,
        }

        if load:
            try:
                self.get(load_if_needed=True, force_cpu=False)
                out["model_loaded"] = self.is_loaded()
                out["names"] = self.names()
                out["model_names"] = self.names()
                out["weights_key"] = self.weights_key() or out.get("weights_key")

                try:
                    w2 = _resolve_weights_path()
                    if isinstance(w2, Path):
                        out["weights_path"] = str(w2.resolve())
                        m2, s2 = _file_stat_ns(w2)
                        out["mtime_ns"] = int(m2) if isinstance(m2, int) else out.get("mtime_ns")
                        out["size"] = int(s2) if isinstance(s2, int) else out.get("size")
                        out["sha256"] = self._sha256_cached(w2) or out.get("sha256")
                        out["weights"]["exists"] = bool(w2.exists() and w2.is_file())
                        out["weights"]["resolved_path"] = out["weights_path"]
                except Exception:
                    pass

            except Exception as e:
                out["ok"] = False
                out["load_error"] = str(e)

        return out

    def _apply_mapping(self, names: List[str]) -> List[str]:
        mapping: Dict[str, str] = getattr(settings, "INFER_MODEL_CLASS_MAPPING", None) or {}
        if not mapping:
            return list(names)

        norm_map = {_norm(str(k)): str(v) for k, v in mapping.items()}
        out: List[str] = []
        for n in names:
            nn = _norm(str(n))
            out.append(norm_map.get(nn, str(n)))
        return out

    def _validate_strict_if_needed(self, model_names: List[str]) -> None:
        strict = bool(getattr(settings, "INFER_STRICT_MODEL_CLASSES", False))
        if not strict:
            return

        expected = _get_expected_registry_classes()
        exp = [_norm(x) for x in expected]
        got = [_norm(x) for x in model_names]

        if exp != got:
            raise ValueError(
                "Классы модели YOLO не совпадают с ожидаемыми (строгая проверка включена).\n"
                f"Ожидается (registry data/classes.json): {expected}\n"
                f"В модели: {model_names}\n"
                "Решения: выключи INFER_STRICT_MODEL_CLASSES, либо задай INFER_MODEL_CLASS_MAPPING, либо переобучи модель."
            )


__all__ = ["ModelManager"]
