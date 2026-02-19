# app/core/config.py
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Все пути и параметры проекта + параметры обучения/инференса YOLO.
    Можно переопределять через .env или переменные окружения.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- API / host ---
    BACKEND_HOST: str = "http://127.0.0.1:8000"

    # CORS (frontend origin)
    # можно указать CSV: "http://localhost:5173,https://example.com"
    CORS_ORIGIN: str = "http://localhost:5173"

    # --- Logging ---
    LOG_LEVEL: str = "INFO"
    INFER_LOG_EVERY_CALL: bool = True

    # --- Upload ограничения ---
    ALLOWED_EXTS: List[str] = [".jpg", ".jpeg", ".png", ".webp"]
    MAX_UPLOAD_MB: int = 25

    # --- Base paths ---
    BASE_DIR: Path = Path(__file__).resolve().parents[2]  # .../backend
    DATA_DIR: Path = BASE_DIR / "data"
    UPLOADS_DIR: Path = DATA_DIR / "uploads"
    SESSIONS_DIR: Path = DATA_DIR / "sessions"
    MODELS_DIR: Path = DATA_DIR / "models"
    DATASETS_DIR: Path = DATA_DIR / "datasets"

    # --- New (for Word reports / logs) ---
    REPORTS_DIR: Path = DATA_DIR / "reports"
    TRAIN_LOGS_DIR: Path = DATA_DIR / "train_logs"

    # ---------------------------------------------------------------------
    # Inference (YOLO / Ultralytics)
    # ---------------------------------------------------------------------
    INFER_MODEL_PATH: Optional[str] = None
    INFER_DEVICE: str = "0"  # "0" / "cpu" / "auto"
    INFER_CONF: float = 0.25
    INFER_IOU: float = 0.45
    INFER_MAX_DET: int = 300
    INFER_IMGSZ: int = 640
    INFER_HALF: bool = False
    INFER_CLASSES: Optional[str] = None

    # polygon downsample
    INFER_MAX_POLY_POINTS: int = 200

    INFER_ALLOW_AUTO_DOWNLOAD_DEFAULT_WEIGHTS: bool = True
    INFER_DEFAULT_WEIGHTS_DET: str = "yolov8n.pt"
    INFER_DEFAULT_WEIGHTS_SEG: str = "yolov8n-seg.pt"
    INFER_USE_SEGMENTATION: bool = False

    INFER_STRICT_MODEL_CLASSES: bool = False
    INFER_MODEL_CLASS_MAPPING: Optional[Dict[str, str]] = None

    # ---------------------------------------------------------------------
    # Train (YOLO / Ultralytics)
    # ---------------------------------------------------------------------
    TRAIN_DEVICE: str = "0"
    TRAIN_IMGSZ: int = 640
    TRAIN_BATCH: int = 2
    TRAIN_EPOCHS: int = 30
    TRAIN_WORKERS: int = 0  # на Windows лучше 0

    TRAIN_BASE_MODEL_PATH: Optional[str] = None  # если None -> MODELS_DIR/model.pt
    ACCUM_DATASET_DIRNAME: str = "_accumulated"

    @property
    def ACCUM_DATASET_DIR(self) -> Path:
        return self.DATASETS_DIR / self.ACCUM_DATASET_DIRNAME

    @property
    def DEFAULT_MODEL_PT(self) -> Path:
        return self.MODELS_DIR / "model.pt"

    def resolve_base_model(self) -> Path:
        if self.TRAIN_BASE_MODEL_PATH:
            return Path(self.TRAIN_BASE_MODEL_PATH)
        return self.DEFAULT_MODEL_PT

    def resolve_infer_model(self) -> Path:
        """
        Возвращает Path (может не существовать).
        Если pt нет — app/ml/infer.py сам подхватит дефолтные веса, если разрешено.
        """
        if self.INFER_MODEL_PATH:
            return Path(self.INFER_MODEL_PATH)
        return self.DEFAULT_MODEL_PT

    def infer_classes_list(self) -> Optional[List[int]]:
        if not self.INFER_CLASSES:
            return None
        raw = self.INFER_CLASSES.strip()
        if not raw:
            return None
        parts = [p.strip() for p in raw.split(",") if p.strip() != ""]
        if not parts:
            return None
        out: List[int] = []
        for p in parts:
            try:
                out.append(int(p))
            except ValueError:
                continue
        return out or None

    def cors_origins_list(self) -> List[str]:
        s = (self.CORS_ORIGIN or "").strip()
        if not s:
            return []
        return [x.strip() for x in s.split(",") if x.strip()]


settings = Settings()


def ensure_dirs() -> None:
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    settings.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    settings.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    settings.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    settings.DATASETS_DIR.mkdir(parents=True, exist_ok=True)
    settings.REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    settings.TRAIN_LOGS_DIR.mkdir(parents=True, exist_ok=True)


ensure_dirs()
