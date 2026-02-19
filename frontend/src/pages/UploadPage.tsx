// frontend/src/pages/UploadPage.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import ProgressBar from "../components/ui/ProgressBar";
import { toast } from "../components/ui/ToastCenter";
import { useAppStore } from "../store/useAppStore";
import { api } from "../api/api";

type SubsystemStage = {
  id: string;
  title: string;
  percent: number;
  bullets: string[];
};

type VideoSamplingMode = "every_n_seconds" | "every_n_frames" | "top_k_sharp" | "motion_based";

type PendingItem = {
  id: string;
  file: File;
  kind: "photo" | "video";
  previewUrl?: string;
};

const PHOTO_MAX_FILES = 500;
const VIDEO_MAX_FILES = 50;

const PHOTO_MAX_SIZE_MB = 25;
const VIDEO_MAX_SIZE_MB = 2048;

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function formatBytes(bytes: number) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function isImage(f: File) {
  return (f.type || "").toLowerCase().startsWith("image/");
}

function isVideo(f: File) {
  return (f.type || "").toLowerCase().startsWith("video/");
}

function pickFilesByKind(files: File[], kind: "photo" | "video") {
  if (kind === "photo") return files.filter(isImage);
  return files.filter(isVideo);
}

function humanLimits(kind: "photo" | "video") {
  if (kind === "photo") return `лимит: до ${PHOTO_MAX_FILES} файлов • до ${PHOTO_MAX_SIZE_MB} MB/файл`;
  return `лимит: до ${VIDEO_MAX_FILES} файлов • до ${VIDEO_MAX_SIZE_MB} MB/файл`;
}

export default function UploadPage() {
  const nav = useNavigate();

  const inputPhotoRef = useRef<HTMLInputElement | null>(null);
  const inputVideoRef = useRef<HTMLInputElement | null>(null);

  const { setPhotos, resetAll, sessionId, setSessionId, photos } = useAppStore();

  const [open, setOpen] = useState(false);
  const [p, setP] = useState(0);

  const [pendingPhotos, setPendingPhotos] = useState<PendingItem[]>([]);
  const [pendingVideos, setPendingVideos] = useState<PendingItem[]>([]);

  const [dragPhoto, setDragPhoto] = useState(false);
  const [dragVideo, setDragVideo] = useState(false);

  const [pastePulse, setPastePulse] = useState(false);

  const [videoMode, setVideoMode] = useState<VideoSamplingMode>("every_n_seconds");
  const [everySeconds, setEverySeconds] = useState(2);
  const [everyFrames, setEveryFrames] = useState(60);
  const [topK, setTopK] = useState(50);
  const [maxFrames, setMaxFrames] = useState(250);
  const [minMotion, setMinMotion] = useState(0.15);

  // ✅ restore photos list after F5 when sessionId exists
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (!sessionId) return;
      if ((photos?.length ?? 0) > 0) return;

      try {
        const items = await api.listPhotos(sessionId);
        if (cancelled) return;
        setPhotos(api.mapListToPhotoItems(items));
      } catch (e: any) {
        toast.warn(`listPhotos failed: ${e?.message ?? "Ошибка"}`);
      }
    }

    restore();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // cleanup preview URLs
  useEffect(() => {
    return () => {
      for (const it of pendingPhotos) {
        if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // revoke removed urls (best-effort)
  const pendingPhotoUrlMap = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const next = new Map<string, string>();
    for (const it of pendingPhotos) {
      if (it.previewUrl) next.set(it.id, it.previewUrl);
    }

    for (const [id, url] of pendingPhotoUrlMap.current.entries()) {
      if (!next.has(id)) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }

    pendingPhotoUrlMap.current = next;
  }, [pendingPhotos]);

  function validateFile(kind: "photo" | "video", f: File): string | null {
    const sizeMb = (f.size || 0) / (1024 * 1024);
    if (kind === "photo") {
      if (sizeMb > PHOTO_MAX_SIZE_MB) return `Фото слишком большое: ${f.name} (${sizeMb.toFixed(1)} MB)`;
    } else {
      if (sizeMb > VIDEO_MAX_SIZE_MB) return `Видео слишком большое: ${f.name} (${sizeMb.toFixed(1)} MB)`;
    }
    return null;
  }

  function addPending(files: File[], kind: "photo" | "video") {
    const filtered = pickFilesByKind(files, kind);
    if (!filtered.length) {
      toast.info(kind === "photo" ? "Добавь фото (image/*)" : "Добавь видео (video/*)");
      return;
    }

    const bad = filtered.map((f) => validateFile(kind, f)).filter(Boolean) as string[];
    if (bad.length) toast.warn(bad[0] ?? "Файл слишком большой");

    const okFiles = filtered.filter((f) => !validateFile(kind, f));
    if (!okFiles.length) return;

    if (kind === "photo") {
      setPendingPhotos((prev) => {
        const existingKeys = new Set(prev.map((x) => `${x.file.name}__${x.file.size}__${x.file.lastModified}`));
        const toAdd: PendingItem[] = [];

        for (const f of okFiles) {
          const key = `${f.name}__${f.size}__${f.lastModified}`;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);

          const previewUrl = URL.createObjectURL(f);
          toAdd.push({ id: uid("ph"), file: f, kind: "photo", previewUrl });
        }

        if (!toAdd.length) toast.info("Эти фото уже добавлены");

        const merged = [...prev, ...toAdd];
        if (merged.length > PHOTO_MAX_FILES) {
          toast.warn(`Лимит фото: максимум ${PHOTO_MAX_FILES} файлов. Лишние не добавлены.`);
        }
        return merged.slice(0, PHOTO_MAX_FILES);
      });
    } else {
      setPendingVideos((prev) => {
        const existingKeys = new Set(prev.map((x) => `${x.file.name}__${x.file.size}__${x.file.lastModified}`));
        const toAdd: PendingItem[] = [];

        for (const f of okFiles) {
          const key = `${f.name}__${f.size}__${f.lastModified}`;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);
          toAdd.push({ id: uid("vd"), file: f, kind: "video" });
        }

        if (!toAdd.length) toast.info("Эти видео уже добавлены");

        const merged = [...prev, ...toAdd];
        if (merged.length > VIDEO_MAX_FILES) {
          toast.warn(`Лимит видео: максимум ${VIDEO_MAX_FILES} файлов. Лишние не добавлены.`);
        }
        return merged.slice(0, VIDEO_MAX_FILES);
      });
    }
  }

  function clearPending(kind: "photo" | "video") {
    if (kind === "photo") {
      setPendingPhotos((prev) => {
        for (const it of prev) if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
        return [];
      });
      toast.info("Список фото очищен");
    } else {
      setPendingVideos([]);
      toast.info("Список видео очищен");
    }
  }

  function removeOne(kind: "photo" | "video", id: string) {
    if (kind === "photo") {
      setPendingPhotos((prev) => {
        const it = prev.find((x) => x.id === id);
        if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
        return prev.filter((x) => x.id !== id);
      });
    } else {
      setPendingVideos((prev) => prev.filter((x) => x.id !== id));
    }
  }

  async function uploadPhotos(files: File[]) {
    if (!files.length) return;

    setOpen(true);
    setP(0);

    let t = 0;
    const timer = window.setInterval(() => {
      t += 1;
      setP((v) => Math.min(92, v + (v < 70 ? 7 : 2)));
      if (t > 40) window.clearInterval(timer);
    }, 55);

    try {
      let sid = sessionId;
      if (!sid) {
        const created = await api.createSession();
        sid = created.session_id;
        setSessionId(sid);
      }

      const uploaded = await api.uploadPhotos(sid!, files);
      const photoItems = api.mapUploadToPhotoItems(uploaded);
      setPhotos(photoItems);

      setP(100);
      window.setTimeout(() => setOpen(false), 300);

      toast.success(`Загружено фото: ${files.length}`);
      clearPending("photo");

      window.setTimeout(() => nav("/gallery"), 150);
    } catch (e: any) {
      setOpen(false);
      toast.error(e?.message ?? "Ошибка загрузки");
    } finally {
      window.clearInterval(timer);
      setTimeout(() => setP(0), 650);
    }
  }

  async function prepareVideo(files: File[]) {
    if (!files.length) return;

    const settings =
      videoMode === "every_n_seconds"
        ? `каждые ${Math.max(1, everySeconds)}с`
        : videoMode === "every_n_frames"
        ? `каждые ${Math.max(1, everyFrames)} кадров`
        : videoMode === "top_k_sharp"
        ? `top-${Math.max(1, topK)} резких (лимит ${Math.max(1, maxFrames)} кадров)`
        : `по движению (порог ${minMotion.toFixed(2)}, лимит ${Math.max(1, maxFrames)} кадров)`;

    toast.info(
      `Видео подготовлено (UX). Файлов: ${files.length}. Выборка кадров: ${settings}. Дальше нужен pipeline на бэке.`
    );
  }

  // Ctrl+V paste → add images to photo queue
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      if (!items.length) return;

      const imageItems = items.filter((it) => (it.type || "").startsWith("image/"));
      if (!imageItems.length) return;

      const files: File[] = [];
      for (const it of imageItems) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
      if (!files.length) return;

      e.preventDefault();

      const stamped = files.map((f, idx) => {
        const ext = (f.type.split("/")[1] || "png").toLowerCase();
        const name = f.name && f.name !== "image.png" ? f.name : `pasted_${Date.now()}_${idx}.${ext}`;
        return new File([f], name, { type: f.type, lastModified: Date.now() });
      });

      addPending(stamped, "photo");

      setPastePulse(true);
      window.setTimeout(() => setPastePulse(false), 650);

      toast.success(`Добавлено из буфера: ${stamped.length}`);
    };

    window.addEventListener("paste", onPaste as any);
    return () => window.removeEventListener("paste", onPaste as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPhotos.length]);

  // ===== project status =====
  const TOTAL_STAGES = 6;
  const CURRENT_STAGE = 1;
  const CURRENT_STAGE_TITLE = "Аудит и стабилизация";

  const stage1Checklist = useMemo(
    () => [
      { done: true, text: "Единый API-клиент фронта (sessions/photos/labels/infer/train/classes/report)" },
      { done: true, text: "Восстановление фото после F5 по sessionId (listPhotos → store)" },
      { done: true, text: "Устойчивый монитор обучения: неизвестные статусы не ломают UI" },
      { done: true, text: "Backend: корректное ‘lost after restart’ → status=error + flags" },
      { done: false, text: "Унифицировать формат ошибок бэка (code/message/details) во всех эндпоинтах" },
      { done: false, text: "Разнести routes.py по модулям (admin/train/report/infer) и убрать дубли атомарной записи" },
    ],
    []
  );

  const stagePercent = useMemo(() => {
    const total = stage1Checklist.length || 1;
    const done = stage1Checklist.filter((x) => x.done).length;
    return Math.round((done / total) * 100);
  }, [stage1Checklist]);

  const changelog = useMemo(
    () => [
      "19.02.2026 — train status: ‘lost’ больше не ломает фронт (нормализация + fail-safe).",
      "19.02.2026 — backend: ‘lost after restart’ помечается как error + flags, исправлен баг Path(\"\") → \".\".",
      "19.02.2026 — улучшен парсинг ошибок API (detail/message в разных формах).",
      "19.02.2026 — UploadPage: статус проекта приведён к формату Этап X/6 + % + чеклист + прогресс + changelog.",
    ],
    []
  );

  const subsystems: SubsystemStage[] = useMemo(
    () => [
      {
        id: "s1",
        title: "Подсистема: Сессии + загрузка + хранение",
        percent: 92,
        bullets: [
          "createSession / upload / listPhotos / restore после F5",
          "две drop-зоны (фото/видео), лимиты, дедупликация",
          "Ctrl+V: вставка скриншотов в фото-очередь",
          "видео: пока UX, нужен backend pipeline",
        ],
      },
      {
        id: "s2",
        title: "Подсистема: Галерея + навигация",
        percent: 90,
        bullets: ["grid галерея", "переход в просмотр/итог", "стейт activeIndex + персист в sessionStorage"],
      },
      {
        id: "s3",
        title: "Подсистема: Viewer + разметка + YOLO",
        percent: 83,
        bullets: [
          "bbox add/edit/delete, хоткеи, зум/пан",
          "динамические классы + модалка добавления",
          "инференс YOLO по кнопке/хоткею",
          "осталось: корректный показ текущих весов (mtime/sha/версия)",
        ],
      },
      {
        id: "s4",
        title: "Подсистема: Обучение + статусы + веса",
        percent: 72,
        bullets: [
          "train job + status по API",
          "монитор обучения в фоне (store), fallback-progress",
          "устойчивость статуса после рестарта (job store на диске)",
          "осталось: стабильный endpoint с метаданными весов (mtime/sha/version)",
        ],
      },
      {
        id: "s5",
        title: "Подсистема: Отчёты + админка",
        percent: 68,
        bullets: ["Word-отчёт: заполнение таблицы шаблона", "админка: веса/health/train jobs/ошибки", "классы: добавление/переименование"],
      },
    ],
    []
  );

  const subsystemsOverall = useMemo(() => {
    const avg = subsystems.reduce((s, x) => s + x.percent, 0) / Math.max(1, subsystems.length);
    return Math.round(avg);
  }, [subsystems]);

  const hasPhotos = (photos?.length ?? 0) > 0;

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function onDrop(kind: "photo" | "video", e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (kind === "photo") setDragPhoto(false);
    else setDragVideo(false);

    const list = Array.from(e.dataTransfer.files ?? []);
    addPending(list, kind);
  }

  function onDragEnter(kind: "photo" | "video", e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (kind === "photo") setDragPhoto(true);
    else setDragVideo(true);
  }

  function onDragLeave(kind: "photo" | "video", e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const rt = e.relatedTarget as Node | null;
    const current = e.currentTarget as HTMLElement | null;
    if (current && rt && current.contains(rt)) return;

    if (kind === "photo") setDragPhoto(false);
    else setDragVideo(false);
  }

  const photoCount = pendingPhotos.length;
  const videoCount = pendingVideos.length;

  const photoTotalBytes = useMemo(() => pendingPhotos.reduce((s, x) => s + (x.file.size || 0), 0), [pendingPhotos]);
  const videoTotalBytes = useMemo(() => pendingVideos.reduce((s, x) => s + (x.file.size || 0), 0), [pendingVideos]);

  return (
    <div className="h-full w-full">
      <div className="mx-auto max-w-[1200px] px-5 pt-10 pb-10">
        {/* HERO */}
        <div className="fx-card fx-glint p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-3xl font-semibold leading-tight">Загрузка</div>
            </div>

            <div className="flex items-center gap-2">
              {hasPhotos ? (
                <Button variant="secondary" onClick={() => nav("/gallery")} leftIcon={<span className="text-base">🖼️</span>}>
                  Продолжить
                </Button>
              ) : null}

              <Button
                variant="danger"
                leftIcon={<span className="text-base">🗑️</span>}
                onClick={() => {
                  resetAll();
                  toast.info("Проект очищен");
                }}
              >
                Очистить сессию
              </Button>
            </div>
          </div>

          <div className="mt-7 fx-divider" />

          {/* DROPZONES */}
          <div className="mt-7 grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* PHOTO */}
            <div
              onDragOver={onDragOver}
              onDrop={(e) => onDrop("photo", e)}
              onDragEnter={(e) => onDragEnter("photo", e)}
              onDragLeave={(e) => onDragLeave("photo", e)}
              className={["fx-card fx-glint fx-border-run p-6 relative", dragPhoto || pastePulse ? "ring-2 ring-orange-300/20" : ""].join(" ")}
            >
              {dragPhoto ? (
                <div className="absolute inset-0 rounded-[18px] bg-black/40 backdrop-blur-sm flex items-center justify-center z-10">
                  <div className="rounded-2xl border border-white/10 bg-black/35 px-5 py-3 text-sm text-white/80">
                    Отпусти — добавим фото в очередь
                  </div>
                </div>
              ) : null}

              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white/90">Фото</div>
                  <div className="mt-1 text-xs text-white/60">
                    Перетащи сюда <span className="text-white/75">image/*</span> или <span className="text-white/75">Ctrl+V</span> (скриншоты).
                  </div>
                  <div className="mt-1 text-[11px] text-white/45">{humanLimits("photo")}</div>
                </div>

                <div className="text-xs text-white/55 tabular-nums text-right">
                  <div className="text-white/65">в очереди: {photoCount}</div>
                  <div className="text-white/45">{photoCount ? formatBytes(photoTotalBytes) : "—"}</div>
                </div>
              </div>

              <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 p-5">
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" leftIcon={<span className="text-base">📷</span>} onClick={() => inputPhotoRef.current?.click()}>
                    Выбрать файлы
                  </Button>

                  <Button
                    variant="secondary"
                    leftIcon={<span className="text-base">✅</span>}
                    onClick={() => void uploadPhotos(pendingPhotos.map((x) => x.file))}
                    disabled={!photoCount}
                    title={!photoCount ? "Сначала добавь фото" : "Загрузить на бэк"}
                  >
                    Загрузить фото
                  </Button>

                  <Button
                    variant="danger"
                    leftIcon={<span className="text-base">🧽</span>}
                    onClick={() => clearPending("photo")}
                    disabled={!photoCount}
                    title="Очистить список выбранных фото"
                  >
                    Очистить
                  </Button>
                </div>

                {!photoCount ? (
                  <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                    <div className="text-xs text-white/55">
                      Совет: можно вставлять серии скриншотов через <span className="text-white/75">Ctrl+V</span>.
                    </div>
                    <div className="mt-1 text-[11px] text-white/45">
                      Поддерживаются: jpg/png/webp • Рекомендуется до {PHOTO_MAX_SIZE_MB}MB на файл.
                    </div>
                  </div>
                ) : null}
              </div>

              {photoCount ? (
                <div className="mt-5 fx-glass rounded-2xl p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-white/65">Предпросмотр</div>
                    <div className="text-[11px] text-white/45">✕ — убрать файл</div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {pendingPhotos.slice(0, 24).map((it) => (
                      <div
                        key={it.id}
                        className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden group"
                        title={`${it.file.name} • ${formatBytes(it.file.size)}`}
                      >
                        <div className="relative">
                          <div className="aspect-[4/3] bg-black/35">
                            {it.previewUrl ? (
                              <img
                                src={it.previewUrl}
                                alt={it.file.name}
                                className="h-full w-full object-cover select-none"
                                draggable={false}
                              />
                            ) : null}
                          </div>

                          <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/0 to-black/0 opacity-70" />

                          <button
                            type="button"
                            onClick={() => removeOne("photo", it.id)}
                            className={[
                              "absolute top-2 right-2",
                              "h-7 w-7 rounded-full border",
                              "border-white/15 bg-black/55 text-white/85",
                              "hover:bg-black/80 transition",
                              "opacity-90 group-hover:opacity-100",
                            ].join(" ")}
                            aria-label="remove"
                            title="Убрать"
                          >
                            ✕
                          </button>
                        </div>

                        <div className="p-2">
                          <div className="text-[11px] text-white/80 truncate">{it.file.name}</div>
                          <div className="text-[10px] text-white/50 tabular-nums">{formatBytes(it.file.size)}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {photoCount > 24 ? (
                    <div className="mt-3 text-xs text-white/55">Показано 24 из {photoCount}. Остальные тоже будут загружены.</div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* VIDEO */}
            <div
              onDragOver={onDragOver}
              onDrop={(e) => onDrop("video", e)}
              onDragEnter={(e) => onDragEnter("video", e)}
              onDragLeave={(e) => onDragLeave("video", e)}
              className={["fx-card fx-glint fx-border-run p-6 relative", dragVideo ? "ring-2 ring-orange-300/20" : ""].join(" ")}
            >
              {dragVideo ? (
                <div className="absolute inset-0 rounded-[18px] bg-black/40 backdrop-blur-sm flex items-center justify-center z-10">
                  <div className="rounded-2xl border border-white/10 bg-black/35 px-5 py-3 text-sm text-white/80">
                    Отпусти — добавим видео в очередь
                  </div>
                </div>
              ) : null}

              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white/90">Видео</div>
                  <div className="mt-1 text-xs text-white/60">
                    Перетащи сюда <span className="text-white/75">video/*</span> или выбери файлы.
                  </div>
                  <div className="mt-1 text-[11px] text-white/45">{humanLimits("video")}</div>
                </div>

                <div className="text-xs text-white/55 tabular-nums text-right">
                  <div className="text-white/65">в очереди: {videoCount}</div>
                  <div className="text-white/45">{videoCount ? formatBytes(videoTotalBytes) : "—"}</div>
                </div>
              </div>

              <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 p-5">
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" leftIcon={<span className="text-base">🎥</span>} onClick={() => inputVideoRef.current?.click()}>
                    Выбрать файлы
                  </Button>

                  <Button
                    variant="primary"
                    leftIcon={<span className="text-base">🧩</span>}
                    onClick={() => void prepareVideo(pendingVideos.map((x) => x.file))}
                    disabled={!videoCount}
                    title={!videoCount ? "Сначала добавь видео" : "Подготовить (UX) под будущий пайплайн"}
                  >
                    Подготовить
                  </Button>

                  <Button
                    variant="danger"
                    leftIcon={<span className="text-base">🧽</span>}
                    onClick={() => clearPending("video")}
                    disabled={!videoCount}
                    title="Очистить список выбранных видео"
                  >
                    Очистить
                  </Button>
                </div>
              </div>

              <div className="mt-5 fx-glass rounded-2xl p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-white/75">Выборка кадров (UX)</div>
                  <div className="text-[11px] text-white/45">для будущей обработки</div>
                </div>

                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="text-xs text-white/60">
                    Режим
                    <select
                      className="mt-1 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85"
                      value={videoMode}
                      onChange={(e) => setVideoMode(e.target.value as VideoSamplingMode)}
                    >
                      <option value="every_n_seconds">Каждые N секунд</option>
                      <option value="every_n_frames">Каждые N кадров</option>
                      <option value="top_k_sharp">Top-K “резких” кадров</option>
                      <option value="motion_based">По движению (motion)</option>
                    </select>
                  </label>

                  <label className="text-xs text-white/60">
                    Лимит кадров (max)
                    <input
                      className="mt-1 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85"
                      type="number"
                      min={1}
                      max={5000}
                      value={maxFrames}
                      onChange={(e) => setMaxFrames(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
                    />
                  </label>

                  {videoMode === "every_n_seconds" ? (
                    <label className="text-xs text-white/60">
                      Шаг (секунды)
                      <input
                        className="mt-1 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85"
                        type="number"
                        min={1}
                        max={60}
                        value={everySeconds}
                        onChange={(e) => setEverySeconds(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                      />
                    </label>
                  ) : null}

                  {videoMode === "every_n_frames" ? (
                    <label className="text-xs text-white/60">
                      Шаг (кадры)
                      <input
                        className="mt-1 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85"
                        type="number"
                        min={1}
                        max={600}
                        value={everyFrames}
                        onChange={(e) => setEveryFrames(Math.max(1, Math.min(600, Number(e.target.value) || 1)))}
                      />
                    </label>
                  ) : null}

                  {videoMode === "top_k_sharp" ? (
                    <label className="text-xs text-white/60">
                      Top-K
                      <input
                        className="mt-1 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85"
                        type="number"
                        min={1}
                        max={1000}
                        value={topK}
                        onChange={(e) => setTopK(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
                      />
                    </label>
                  ) : null}

                  {videoMode === "motion_based" ? (
                    <label className="text-xs text-white/60">
                      Порог движения (0..1)
                      <input
                        className="mt-1 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85"
                        type="number"
                        step={0.01}
                        min={0}
                        max={1}
                        value={minMotion}
                        onChange={(e) => setMinMotion(Math.max(0, Math.min(1, Number(e.target.value) || 0)))}
                      />
                    </label>
                  ) : null}
                </div>

                <div className="mt-3 text-[11px] text-white/45 leading-relaxed">
                  Видео → выборка кадров → инференс по кадрам → объединение результатов → разметка/отчёт.
                </div>
              </div>

              {videoCount ? (
                <div className="mt-5 fx-glass rounded-2xl p-4">
                  <div className="text-xs text-white/65">Список видео</div>
                  <div className="mt-3 space-y-2 max-h-[260px] overflow-auto no-scrollbar pr-1">
                    {pendingVideos.map((it) => (
                      <div
                        key={it.id}
                        className="rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-2 flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <div className="text-sm text-white/85 truncate">
                            <span className="mr-2">🎞️</span>
                            {it.file.name}
                          </div>
                          <div className="text-[11px] text-white/50 tabular-nums">
                            {formatBytes(it.file.size)} • {new Date(it.file.lastModified).toLocaleString()}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => removeOne("video", it.id)}
                          className="shrink-0 h-8 px-3 rounded-2xl border border-white/10 bg-black/30 text-xs text-white/75 hover:bg-white/[0.06] transition"
                          title="Убрать"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <input
            ref={inputPhotoRef}
            className="hidden"
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              addPending(Array.from(e.target.files ?? []), "photo");
              e.currentTarget.value = "";
            }}
          />

          <input
            ref={inputVideoRef}
            className="hidden"
            type="file"
            accept="video/*"
            multiple
            onChange={(e) => {
              addPending(Array.from(e.target.files ?? []), "video");
              e.currentTarget.value = "";
            }}
          />
        </div>

        {/* PROJECT STATUS */}
        <div className="mt-8 fx-card fx-glint p-6">
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <div>
              <div className="text-xl font-semibold">Статус проекта</div>
              <div className="mt-1 text-sm text-white/70">
                <span className="text-white/85 font-semibold">
                  Этап {CURRENT_STAGE}/{TOTAL_STAGES}
                </span>{" "}
                — {CURRENT_STAGE_TITLE} •{" "}
                <span className="text-orange-200 tabular-nums">{stagePercent}%</span>
              </div>
              <div className="mt-1 text-xs text-white/55">
                Дополнительно: техготовность по подсистемам ≈ <span className="text-white/75 tabular-nums">{subsystemsOverall}%</span>
              </div>
            </div>

            <div className="min-w-[240px] w-full sm:w-[360px]">
              <ProgressBar value={clamp01(stagePercent / 100) * 100} />
              <div className="mt-1 text-[11px] text-white/45">
                прогресс текущего этапа (чеклист)
              </div>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="fx-glass rounded-2xl p-4">
              <div className="text-sm font-semibold text-white/85">Чеклист этапа {CURRENT_STAGE}/{TOTAL_STAGES}</div>
              <ul className="mt-3 text-xs text-white/65 space-y-2">
                {stage1Checklist.map((x, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0">{x.done ? "✅" : "⬜"}</span>
                    <span>{x.text}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="fx-glass rounded-2xl p-4">
              <div className="text-sm font-semibold text-white/85">Changelog</div>
              <ul className="mt-3 text-xs text-white/65 list-disc pl-5 space-y-1">
                {changelog.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>

              <div className="mt-4 text-xs text-white/55">
                Следующий крупный шаг:{" "}
                <span className="text-white/75">
                  Этап 2/6 — Видео MVP: upload видео → extract frames → галерея кадров → render mp4 (H.264, без аудио)
                </span>
              </div>
            </div>
          </div>

          <div className="mt-5">
            <div className="text-sm font-semibold text-white/80">Техпрогресс по подсистемам</div>
            <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
              {subsystems.map((s) => (
                <div key={s.id} className="fx-glass rounded-2xl p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-white/85">{s.title}</div>
                    <div className="text-xs text-white/60 tabular-nums">{s.percent}%</div>
                  </div>

                  <div className="mt-2">
                    <ProgressBar value={clamp01(s.percent / 100) * 100} />
                  </div>

                  <ul className="mt-3 text-xs text-white/65 list-disc pl-5 space-y-1">
                    {s.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Upload modal */}
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Загрузка…"
          closeOnBackdrop={false}
          hideCloseButton
          maxWidthClassName="max-w-[520px]"
        >
          <div className="space-y-3">
            <div className="text-sm text-white/70">Загружаем файлы на сервер…</div>
            <ProgressBar value={p} />
            <div className="text-[11px] text-white/45">Если загрузка прервалась — просто попробуй ещё раз.</div>
          </div>
        </Modal>
      </div>
    </div>
  );
}
