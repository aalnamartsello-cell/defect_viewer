# /main.py
from __future__ import annotations

import logging
from typing import List

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as api_router
from app.core.config import settings


def _maybe_ensure_dirs() -> None:
    """
    На разных версиях проекта ensure_dirs мог быть или не быть.
    Поэтому вызываем мягко.
    """
    try:
        from app.core.config import ensure_dirs  # type: ignore
    except Exception:
        ensure_dirs = None  # type: ignore

    if callable(ensure_dirs):
        try:
            ensure_dirs()  # type: ignore
        except Exception:
            pass


def _default_dev_origins() -> List[str]:
    # ✅ максимально частые варианты при разработке
    return [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        # иногда UI открывают прямо с :8000 (не обязательно, но не мешает)
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]


def _cors_origins() -> list[str]:
    """
    Источники CORS:
    1) settings.cors_origins_list() если есть
    2) settings.CORS_ORIGIN (CSV)
    3) fallback: dev origins (localhost/127.0.0.1)
    """
    # если у тебя в Settings есть cors_origins_list — используем
    fn = getattr(settings, "cors_origins_list", None)
    if callable(fn):
        try:
            xs = fn()
            if isinstance(xs, (list, tuple)):
                xs2 = [str(x).strip() for x in xs if str(x).strip()]
                if xs2:
                    return xs2
        except Exception:
            pass

    # иначе — поддержим CSV строку
    raw = str(getattr(settings, "CORS_ORIGIN", "") or "").strip()
    if raw:
        xs = [x.strip() for x in raw.split(",") if x.strip()]
        if xs:
            return xs

    # ✅ fallback
    return _default_dev_origins()


def _configure_logging() -> None:
    level = str(getattr(settings, "LOG_LEVEL", "INFO") or "INFO").upper()
    logging.basicConfig(level=getattr(logging, level, logging.INFO))
    try:
        logging.getLogger("ml_infer").setLevel(level)
        logging.getLogger("model_manager").setLevel(level)
    except Exception:
        pass


def create_app() -> FastAPI:
    app = FastAPI(
        title="Defect Analyzer Backend",
        version="3.0.0",
    )

    _maybe_ensure_dirs()
    _configure_logging()

    origins = _cors_origins()

    # ✅ ВАЖНО: "Failed to fetch" в браузере чаще всего = CORS.
    # Мы явно разрешаем localhost/127.0.0.1 dev origins по умолчанию,
    # либо то, что вернул settings.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ✅ анти-двойной префикс:
    # если в routes.py уже стоит router.prefix="/api", то тут prefix НЕ добавляем
    router_prefix = getattr(api_router, "prefix", "") or ""
    rp = str(router_prefix).rstrip("/")
    mount_prefix = "" if rp == "/api" else "/api"

    # Подключаем роутер
    app.include_router(api_router, prefix=mount_prefix)

    # Логи — удобно увидеть в консоли куда смонтировалось
    logging.getLogger("uvicorn.error").info(
        "API router mounted: mount_prefix=%r router_prefix=%r final_api_prefix=%r",
        mount_prefix,
        router_prefix,
        (mount_prefix.rstrip("/") + (router_prefix if router_prefix.startswith("/") else f"/{router_prefix}")).rstrip("/"),
    )
    logging.getLogger("uvicorn.error").info("CORS allow_origins=%s", origins)

    @app.get("/health")
    def health():
        # Добавляем ML-сводку без загрузки модели (не скачивает веса)
        try:
            from app.services.model_manager import ModelManager  # type: ignore

            ml = ModelManager.instance().describe(load=False)
        except Exception as e:
            ml = {"ok": False, "error": str(e)}

        return {
            "ok": True,
            "mounted_prefix": mount_prefix,
            "router_prefix": router_prefix,
            "cors": origins,
            "ml": ml,
        }

    @app.get("/health/ml")
    def health_ml(load: bool = False):
        """
        ML health отдельно (корневой).
        /health/ml?load=1 — попробует загрузить YOLO (может скачать дефолтные веса).
        """
        from app.services.model_manager import ModelManager  # type: ignore

        return ModelManager.instance().describe(load=bool(load))

    return app


app = create_app()
