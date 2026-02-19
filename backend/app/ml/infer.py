# app/ml/infer.py
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from app.core.config import settings
from app.services.model_manager import ModelManager

logger = logging.getLogger("infer")

Number = Union[int, float]


@dataclass
class InferResult:
    ok: bool
    bboxes: List[Dict[str, Any]]
    took_ms: int
    device: str
    num_det: int
    used_cpu_fallback: bool


def _clamp01(x: float) -> float:
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x


def _safe_float(x: Any, default: float = 0.0) -> float:
    try:
        v = float(x)
        if v != v:  # NaN
            return default
        return v
    except Exception:
        return default


def _cuda_available() -> bool:
    try:
        import torch  # type: ignore

        return bool(torch.cuda.is_available() and int(torch.cuda.device_count()) > 0)
    except Exception:
        return False


def _xyxy_to_xywh_norm(
    xyxy: Tuple[Number, Number, Number, Number],
    img_w: int,
    img_h: int,
) -> Tuple[float, float, float, float]:
    x1, y1, x2, y2 = (
        _safe_float(xyxy[0]),
        _safe_float(xyxy[1]),
        _safe_float(xyxy[2]),
        _safe_float(xyxy[3]),
    )
    if img_w <= 0:
        img_w = 1
    if img_h <= 0:
        img_h = 1

    x1 = max(0.0, min(x1, float(img_w)))
    x2 = max(0.0, min(x2, float(img_w)))
    y1 = max(0.0, min(y1, float(img_h)))
    y2 = max(0.0, min(y2, float(img_h)))

    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1

    w = max(0.0, x2 - x1)
    h = max(0.0, y2 - y1)

    x = _clamp01(x1 / img_w)
    y = _clamp01(y1 / img_h)
    ww = _clamp01(w / img_w)
    hh = _clamp01(h / img_h)

    # YOLO не любит строго нулевые
    if ww <= 0.0:
        ww = 0.0001
    if hh <= 0.0:
        hh = 0.0001

    # гарантируем, что bbox помещается
    x = _clamp01(min(x, 1.0 - ww))
    y = _clamp01(min(y, 1.0 - hh))

    return x, y, ww, hh


def _downsample_points(points: List[Tuple[float, float]], max_points: int) -> List[Tuple[float, float]]:
    if max_points <= 0:
        return points
    if len(points) <= max_points:
        return points
    step = max(1, int(len(points) / max_points))
    out = points[::step]
    return out[:max_points]


def _normalize_polygon_any(poly: Any) -> Optional[List[Tuple[float, float]]]:
    if poly is None:
        return None

    try:
        if hasattr(poly, "tolist"):
            poly = poly.tolist()
    except Exception:
        pass

    if poly is None:
        return None

    # формат: [x1,y1,x2,y2,...]
    if isinstance(poly, (list, tuple)) and poly and all(isinstance(x, (int, float)) for x in poly):
        nums = [float(x) for x in poly]
        if len(nums) < 4:
            return None
        pts: List[Tuple[float, float]] = []
        n = len(nums) - (len(nums) % 2)
        for i in range(0, n, 2):
            pts.append((float(nums[i]), float(nums[i + 1])))
        return pts or None

    # формат: [[x,y], [x,y], ...]
    if isinstance(poly, (list, tuple)):
        pts2: List[Tuple[float, float]] = []
        for pt in poly:
            try:
                if hasattr(pt, "tolist"):
                    pt = pt.tolist()
            except Exception:
                pass
            if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                pts2.append((_safe_float(pt[0], 0.0), _safe_float(pt[1], 0.0)))
        return pts2 or None

    return None


def _polygon_to_norm(poly_pts: List[Tuple[float, float]], img_w: int, img_h: int) -> List[Tuple[float, float]]:
    if img_w <= 0:
        img_w = 1
    if img_h <= 0:
        img_h = 1
    out: List[Tuple[float, float]] = []
    for x, y in poly_pts:
        out.append((_clamp01(_safe_float(x) / img_w), _clamp01(_safe_float(y) / img_h)))
    return out


def _normalize_ultralytics_device(raw: Any) -> str:
    """
    Ultralytics YOLO ожидает device строкой:
      - "cpu"
      - "0" / "0,1"
      - "mps" (mac)
    Здесь мы приводим к безопасным значениям, чтобы не случалось "вечно cpu" из-за bool.
    """
    if raw is None:
        return "cpu"
    if isinstance(raw, bool):
        # самый частый баг: use_seg(bool) случайно попадал в device
        return "cpu"

    s = str(raw).strip()
    if not s:
        return "cpu"

    low = s.lower()

    if low in ("false", "true", "none", "null"):
        return "cpu"
    if low in ("cpu", "mps"):
        return low

    # "cuda:0" -> "0" (самый совместимый формат для Ultralytics)
    if low.startswith("cuda:"):
        tail = s.split(":", 1)[1].strip()
        return tail if tail else "0"

    # "cuda" / "gpu" / "auto" -> выберем 0 при наличии CUDA
    if low in ("cuda", "gpu", "nvidia", "gtx", "auto"):
        return "0" if _cuda_available() else "cpu"

    # Если это просто число "0" / "1" или "0,1" — оставляем
    return s


def _looks_like_cuda_error(e: Exception) -> bool:
    msg = (str(e) or "").lower()
    needles = [
        "cuda",
        "cudnn",
        "cublas",
        "device-side assert",
        "illegal memory access",
        "out of memory",
        "gpu",
        "runtimeerror: cuda",
    ]
    return any(n in msg for n in needles)


def _get_model_bundle(mm: ModelManager, *, force_cpu: bool = False) -> Tuple[Any, bool, str, bool]:
    """
    Нормализуем контракт под текущий ModelManager.get():
      -> (model, use_seg, device_str, auto_cpu_fallback_flag)

    Держим обратную совместимость на случай старых сигнатур:
      - (model, device)
      - (model, device, use_seg)
      - (model, use_seg, device)
    """
    got = mm.get(load_if_needed=True, force_cpu=force_cpu)

    model: Any = None
    use_seg: bool = False
    device: Any = "cpu"
    auto_cpu: bool = False

    if isinstance(got, (list, tuple)):
        if len(got) >= 1:
            model = got[0]

        if len(got) >= 4:
            # ✅ актуальный контракт: (model, use_seg, device, auto_cpu)
            use_seg = bool(got[1])
            device = got[2]
            auto_cpu = bool(got[3])
        elif len(got) == 3:
            # (model, use_seg, device) ИЛИ (model, device, use_seg)
            a, b = got[1], got[2]
            if isinstance(a, bool) and not isinstance(b, bool):
                use_seg = bool(a)
                device = b
            elif isinstance(b, bool) and not isinstance(a, bool):
                device = a
                use_seg = bool(b)
            else:
                # fallback
                device = a
                use_seg = bool(b) if isinstance(b, bool) else False
        elif len(got) == 2:
            # (model, device)
            device = got[1]
    else:
        model = got

    device_str = _normalize_ultralytics_device(device)
    return model, bool(use_seg), device_str, bool(auto_cpu)


def _predict_with_lock(
    *,
    mm: ModelManager,
    model: Any,
    image_path: Path,
    device: str,
    conf: float,
    iou: float,
    imgsz: int,
    max_det: int,
    half: bool,
    classes: Optional[List[int]],
) -> Any:
    with mm.predict_lock():
        return model.predict(
            source=str(image_path),
            device=device,
            conf=conf,
            iou=iou,
            imgsz=imgsz,
            max_det=max_det,
            half=half,
            classes=classes,
            verbose=False,
        )


def run_infer_for_photo(image_path: Path) -> Dict[str, Any]:
    t0 = time.perf_counter()

    if not image_path.exists() or not image_path.is_file():
        raise FileNotFoundError(f"Файл изображения не найден: {str(image_path)}")

    mm = ModelManager.instance()

    # настройки инференса
    conf = float(getattr(settings, "INFER_CONF", 0.25))
    iou = float(getattr(settings, "INFER_IOU", 0.45))
    max_det = int(getattr(settings, "INFER_MAX_DET", 300))
    imgsz = int(getattr(settings, "INFER_IMGSZ", 640))

    half_cfg = bool(getattr(settings, "INFER_HALF", False))
    use_seg_cfg = bool(getattr(settings, "INFER_USE_SEGMENTATION", False))
    max_poly = int(getattr(settings, "INFER_MAX_POLY_POINTS", 200))
    classes = settings.infer_classes_list()
    classes = classes if classes else None

    log_every = bool(getattr(settings, "INFER_LOG_EVERY_CALL", True))

    model, mm_use_seg, device_used, auto_cpu = _get_model_bundle(mm, force_cpu=False)
    used_runtime_fallback = False

    if model is None:
        raise RuntimeError("Модель не загружена (ModelManager вернул None). Проверь веса/ultralytics.")

    # ✅ сегментация только если:
    # - пользователь включил
    # - и модель реально segmentation
    use_seg = bool(use_seg_cfg and mm_use_seg)

    # ✅ half только на GPU (на CPU/не-CUDA может дать ошибки/бессмысленно)
    half = bool(half_cfg and device_used != "cpu")

    # ✅ preflight: если вдруг mm вернул GPU, но CUDA реально недоступна — сразу уйдём на CPU
    if device_used != "cpu" and not _cuda_available():
        logger.warning("CUDA недоступна в runtime, переключаюсь на CPU (device было %s)", str(device_used))
        model, mm_use_seg, device_used, auto_cpu = _get_model_bundle(mm, force_cpu=True)
        used_runtime_fallback = True
        use_seg = bool(use_seg_cfg and mm_use_seg)
        half = False

    if log_every:
        logger.info(
            "infer start: img=%s device=%s conf=%.3f iou=%.3f imgsz=%d max_det=%d half=%s classes=%s use_seg=%s",
            str(image_path),
            str(device_used),
            conf,
            iou,
            imgsz,
            max_det,
            bool(half),
            str(classes) if classes else "all",
            bool(use_seg),
        )

    try:
        preds = _predict_with_lock(
            mm=mm,
            model=model,
            image_path=image_path,
            device=device_used,
            conf=conf,
            iou=iou,
            imgsz=imgsz,
            max_det=max_det,
            half=half,
            classes=classes,
        )
    except Exception as e:
        # runtime fallback на CPU, если GPU реально ломается
        if device_used != "cpu" and _looks_like_cuda_error(e):
            logger.warning("CUDA error on device=%s, retrying on CPU: %s", str(device_used), str(e))
            model2, mm_use_seg2, device2, auto_cpu2 = _get_model_bundle(mm, force_cpu=True)
            if model2 is None:
                raise

            model = model2
            mm_use_seg = mm_use_seg2
            device_used = "cpu"
            auto_cpu = bool(auto_cpu or auto_cpu2)
            used_runtime_fallback = True

            use_seg = bool(use_seg_cfg and mm_use_seg)
            half = False  # на CPU half не нужен

            preds = _predict_with_lock(
                mm=mm,
                model=model,
                image_path=image_path,
                device=device_used,
                conf=conf,
                iou=iou,
                imgsz=imgsz,
                max_det=max_det,
                half=half,
                classes=classes,
            )
        else:
            raise

    r0 = preds[0] if isinstance(preds, (list, tuple)) and preds else preds

    img_w = 1
    img_h = 1
    try:
        osh = getattr(r0, "orig_shape", None)  # (h,w)
        if isinstance(osh, (list, tuple)) and len(osh) >= 2:
            img_h = int(osh[0])
            img_w = int(osh[1])
    except Exception:
        pass

    out_boxes: List[Dict[str, Any]] = []

    boxes = getattr(r0, "boxes", None)
    masks = getattr(r0, "masks", None)

    masks_xy = None
    try:
        if use_seg and masks is not None:
            masks_xy = getattr(masks, "xy", None)
    except Exception:
        masks_xy = None

    if boxes is not None:
        try:
            xyxy_all = getattr(boxes, "xyxy", None)
            conf_all = getattr(boxes, "conf", None)
            cls_all = getattr(boxes, "cls", None)

            if hasattr(xyxy_all, "tolist"):
                xyxy_all = xyxy_all.tolist()
            if hasattr(conf_all, "tolist"):
                conf_all = conf_all.tolist()
            if hasattr(cls_all, "tolist"):
                cls_all = cls_all.tolist()

            if not isinstance(xyxy_all, list):
                xyxy_all = []
            if not isinstance(conf_all, list):
                conf_all = []
            if not isinstance(cls_all, list):
                cls_all = []

            n = min(len(xyxy_all), len(conf_all), len(cls_all))
            for i in range(n):
                xyxy = xyxy_all[i]
                if not (isinstance(xyxy, (list, tuple)) and len(xyxy) >= 4):
                    continue

                cls_idx = int(_safe_float(cls_all[i], 0.0))
                cls_name = mm.class_name(cls_idx)
                confv = _clamp01(_safe_float(conf_all[i], 0.0))

                x, y, w, h = _xyxy_to_xywh_norm(
                    (xyxy[0], xyxy[1], xyxy[2], xyxy[3]),
                    img_w=img_w,
                    img_h=img_h,
                )

                item: Dict[str, Any] = {
                    "id": f"yolo_{i}",
                    "class": str(cls_name),
                    "confidence": confv,
                    "bbox": [x, y, w, h],
                    "source": "yolo",
                }

                if use_seg and masks_xy is not None and isinstance(masks_xy, (list, tuple)) and i < len(masks_xy):
                    poly_raw = masks_xy[i]
                    poly_pts = _normalize_polygon_any(poly_raw)
                    if poly_pts:
                        poly_pts = _downsample_points(poly_pts, max_poly)
                        poly_norm = _polygon_to_norm(poly_pts, img_w=img_w, img_h=img_h)
                        item["polygon"] = [[float(px), float(py)] for px, py in poly_norm]

                out_boxes.append(item)

        except Exception as e:
            logger.exception("Failed to parse YOLO output: %s", str(e))
            raise ValueError(str(e)) from e

    took_ms = int((time.perf_counter() - t0) * 1000.0)

    # ✅ честный флаг fallback:
    # - runtime fallback с GPU на CPU
    # - или mm сам ушёл в CPU (auto_cpu=True) потому что CUDA недоступна
    # - или если device_used == cpu, а INFER_DEVICE был не cpu (best-effort)
    try:
        infer_dev_cfg = str(getattr(settings, "INFER_DEVICE", "") or "").strip().lower()
    except Exception:
        infer_dev_cfg = ""

    cfg_wanted_cpu = infer_dev_cfg in ("", "cpu", "none", "null", "false")
    used_cpu_fallback = bool(
        used_runtime_fallback
        or (device_used == "cpu" and auto_cpu)
        or (device_used == "cpu" and not cfg_wanted_cpu)
    )

    if log_every:
        logger.info(
            "infer done: img=%s device=%s det=%d took_ms=%d cpu_fallback=%s",
            str(image_path),
            str(device_used),
            int(len(out_boxes)),
            int(took_ms),
            bool(used_cpu_fallback),
        )

    return {
        "ok": True,
        "bboxes": out_boxes,
        "took_ms": took_ms,
        "device": str(device_used),
        "num_det": int(len(out_boxes)),
        "used_cpu_fallback": bool(used_cpu_fallback),
    }


def run_yolo_infer(image_path: Path) -> InferResult:
    d = run_infer_for_photo(image_path)
    return InferResult(
        ok=bool(d.get("ok", True)),
        bboxes=list(d.get("bboxes") or []),
        took_ms=int(d.get("took_ms") or 0),
        device=str(d.get("device") or ""),
        num_det=int(d.get("num_det") or 0),
        used_cpu_fallback=bool(d.get("used_cpu_fallback") or False),
    )
