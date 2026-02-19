// src/pages/AdminPage.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Cpu,
  RefreshCw,
  Wand2,
  Brain,
  Tag,
  Database,
  Pencil,
  Save,
  X,
  AlertTriangle,
  CheckCircle2,
  Hash,
  Clock,
  HardDrive,
  Play,
} from "lucide-react";

import Button from "../components/ui/Button";
import ProgressBar from "../components/ui/ProgressBar";
import Modal from "../components/ui/Modal";
import { toast } from "../components/ui/ToastCenter";
import { useAppStore } from "../store/useAppStore";
import { useTrainStore } from "../store/useTrainStore";
import { api } from "../api/api";
import { DEFECT_CLASSES } from "../constants/defects";
import type { OperatorDecision, PhotoItem } from "../types";
import type { DefectClass } from "../constants/defects";

function normalizeClassName(s: string) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normKey(s: string) {
  return normalizeClassName(s).toLowerCase();
}

function fmtBytes(n: any) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  const d = i === 0 ? 0 : i === 1 ? 1 : 2;
  return `${x.toFixed(d)} ${units[i]}`;
}

function shortSha(s: any) {
  const t = String(s ?? "").trim();
  if (!t) return "—";
  if (t.length <= 12) return t;
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

function fmtTimeHHMMSS(d: Date) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function mtimeFromNs(mtimeNs: any): string {
  const v = Number(mtimeNs);
  if (!Number.isFinite(v) || v <= 0) return "—";
  const ms = Math.floor(v / 1_000_000);
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return "—";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mo = String(dt.getMonth() + 1).padStart(2, "0");
  const yy = dt.getFullYear();
  return `${dd}.${mo}.${yy} ${fmtTimeHHMMSS(dt)}`;
}

/** ✅ Рекурсивный поиск значений по ключам в любом вложении. */
function deepPickFirst(obj: any, keys: string[]) {
  const wanted = new Set(keys.map((k) => String(k).toLowerCase()));
  const seen = new Set<any>();
  const q: any[] = [obj];
  let steps = 0;
  const MAX = 2000;

  while (q.length && steps < MAX) {
    steps++;
    const cur = q.shift();

    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    for (const k of Object.keys(cur)) {
      if (wanted.has(String(k).toLowerCase())) return (cur as any)[k];
    }
    for (const v of Object.values(cur)) {
      if (v && typeof v === "object") q.push(v);
    }
  }
  return undefined;
}

function deepPickString(obj: any, keys: string[]) {
  const v = deepPickFirst(obj, keys);
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v && typeof v === "object") {
    const guess = deepPickFirst(v, ["path", "file", "filename", "weights", "weights_path", "model_path", "url"]);
    if (typeof guess === "string" && guess.trim()) return guess.trim();
  }
  return "";
}

function deepPickNumber(obj: any, keys: string[]) {
  const v = deepPickFirst(obj, keys);
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  if (typeof v === "string") {
    const m = Number(v.trim());
    if (Number.isFinite(m) && m > 0) return m;
  }
  return undefined;
}

function splitIsValLikeBackend(photoId: string) {
  const s = String(photoId ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i);
  return h % 10 < 2;
}

function Card({
  title,
  icon,
  right,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-ink-900/55 backdrop-blur-xl shadow-[0_18px_70px_rgba(0,0,0,0.45)] overflow-hidden">
      <div className="px-5 py-4 border-b border-white/10 bg-black/20 flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <span className="text-white/70">{icon}</span>
          <h2 className="text-sm md:text-base font-semibold text-white/90 truncate">{title}</h2>
        </div>
        {right}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export default function AdminPage() {
  const nav = useNavigate();

  const { sessionId, photos, decisionByPhoto, setPhotos, setDecision } = useAppStore();
  const items = photos ?? [];
  const decisions = (decisionByPhoto ?? {}) as Record<string, OperatorDecision | undefined>;

  // ===== TRAIN (GLOBAL via store) =====
  const train = useTrainStore((s) => ({
    jobId: s.jobId,
    status: s.status,
    message: s.message,
    progress: s.progress,
    epoch: s.epoch,
    epochsTotal: s.epochsTotal,
    batch: s.batch,
    batchesTotal: s.batchesTotal,
    patch: s.patch,
    reset: s.reset,
  }));

  const trainBusy = train.status === "queued" || train.status === "running";
  const canTrain = Boolean(sessionId) && items.length > 0;

  const [trainOpen, setTrainOpen] = useState(false);

  const trainBadge =
    train.status === "done"
      ? { text: "done", cls: "border-emerald-300/20 bg-emerald-500/10 text-emerald-200" }
      : train.status === "error"
      ? { text: "error", cls: "border-red-300/20 bg-red-500/10 text-red-200" }
      : train.status === "running"
      ? { text: "running", cls: "border-orange-300/20 bg-orange-500/10 text-orange-200" }
      : train.status === "queued"
      ? { text: "queued", cls: "border-orange-300/20 bg-orange-500/10 text-orange-200" }
      : { text: "idle", cls: "border-white/10 bg-white/[0.03] text-white/70" };

  // ===== ML HEALTH =====
  const [mlHealth, setMlHealth] = useState<any>(null);
  const [mlHealthErr, setMlHealthErr] = useState<string>("");
  const [mlHealthUpdatedAt, setMlHealthUpdatedAt] = useState<Date | null>(null);
  const [mlHealthBusy, setMlHealthBusy] = useState(false);
  const [mlReloadBusy, setMlReloadBusy] = useState(false);
  const prevWeightsKeyRef = useRef<string>("");

  const makeWeightsKey = (res: any) => {
    const weightsPath0 = deepPickString(res, ["weights", "weights_path", "model_path", "path", "file", "pt_path", "best_path"]);
    const sha0 = deepPickString(res, ["sha256", "sha", "model_sha256", "hash"]);
    const mtimeNs0 = deepPickNumber(res, ["mtime_ns", "mtime", "modified_ns", "mtimeNanos"]);
    const size0 = deepPickNumber(res, ["size", "bytes", "file_size", "weights_size", "model_size"]);
    return [weightsPath0, sha0, String(mtimeNs0 ?? ""), String(size0 ?? "")].filter(Boolean).join("::");
  };

  const applyHealthResponse = (res: any, opts?: { toastOnWeightsChange?: boolean }) => {
    setMlHealth(res ?? null);
    setMlHealthUpdatedAt(new Date());

    const key = makeWeightsKey(res);
    if (opts?.toastOnWeightsChange && key && prevWeightsKeyRef.current && key !== prevWeightsKeyRef.current) {
      toast.success("✅ Веса модели обновились");
    }
    if (key) prevWeightsKeyRef.current = key;
  };

  const loadMlHealth = async (opts?: { silent?: boolean; toastOnWeightsChange?: boolean }) => {
    if (mlHealthBusy) return;
    setMlHealthBusy(true);
    if (!opts?.silent) setMlHealthErr("");

    try {
      const res = await api.healthML({ load: false });
      applyHealthResponse(res, { toastOnWeightsChange: opts?.toastOnWeightsChange });
    } catch (e: any) {
      const msg = e?.message ?? "Не удалось получить состояние ML";
      setMlHealthErr(msg);
      if (!opts?.silent) toast.error(msg);
    } finally {
      setMlHealthBusy(false);
    }
  };

  const reloadWeights = async () => {
    if (mlReloadBusy) return;
    setMlReloadBusy(true);
    setMlHealthErr("");

    try {
      const res = await api.healthML({ load: true });
      applyHealthResponse(res, { toastOnWeightsChange: true });
      toast.success("✅ Перезагрузка весов выполнена");
      void loadMlHealth({ silent: true, toastOnWeightsChange: true });
    } catch (e: any) {
      const msg = e?.message ?? "Не удалось перезагрузить веса";
      setMlHealthErr(msg);
      toast.error(msg);
    } finally {
      setMlReloadBusy(false);
    }
  };

  useEffect(() => {
    void loadMlHealth({ silent: true });
    const t = window.setInterval(() => void loadMlHealth({ silent: true, toastOnWeightsChange: true }), 30_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // если обучение завершилось — обновим карточку весов (удобно, когда пользователь вернулся на админку)
  useEffect(() => {
    if (train.status === "done") {
      void loadMlHealth({ silent: true, toastOnWeightsChange: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [train.status]);

  const weightsPath = deepPickString(mlHealth, ["weights", "weights_path", "model_path", "path", "file", "pt_path", "best_path"]);
  const sha = deepPickString(mlHealth, ["sha256", "sha", "model_sha256", "hash"]);
  const mtimeNs = deepPickNumber(mlHealth, ["mtime_ns", "mtime", "modified_ns", "mtimeNanos"]);
  const size = deepPickNumber(mlHealth, ["size", "bytes", "file_size", "weights_size", "model_size"]);
  const device = deepPickString(mlHealth, ["device", "cuda", "gpu", "torch_device", "inference_device"]);
  const useSeg =
    typeof deepPickFirst(mlHealth, ["use_seg", "seg", "segmentation"]) === "boolean"
      ? (deepPickFirst(mlHealth, ["use_seg", "seg", "segmentation"]) as boolean)
      : undefined;

  const statusDot = mlHealthErr
    ? "bg-rose-400/20 border-rose-300/25"
    : mlHealth
    ? "bg-emerald-400/20 border-emerald-300/25"
    : "bg-white/10 border-white/10";

  const updatedLabel = mlHealthUpdatedAt ? `обновлено: ${fmtTimeHHMMSS(mlHealthUpdatedAt)}` : "—";

  // ===== CLASSES =====
  const [classes, setClasses] = useState<string[]>([]);
  const [clsBusy, setClsBusy] = useState(false);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameFrom, setRenameFrom] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  const getFallbackClasses = () => {
    const base = [...(DEFECT_CLASSES as unknown as string[])].map(normalizeClassName).filter(Boolean);
    return Array.from(new Set(base)).sort((a, b) => a.localeCompare(b, "ru", { sensitivity: "base" }));
  };

  const normalizeRemoteClasses = (xs: any) => {
    const remote = Array.isArray(xs) ? xs.map(normalizeClassName).filter(Boolean) : [];
    return Array.from(new Set(remote)).sort((a, b) => a.localeCompare(b, "ru", { sensitivity: "base" }));
  };

  const loadClasses = async (opts?: { silent?: boolean }) => {
    if (!sessionId) {
      setClasses(getFallbackClasses());
      return;
    }
    if (clsBusy) return;
    setClsBusy(true);
    try {
      const res = await api.getSessionClasses(sessionId);
      const remote = normalizeRemoteClasses(res?.classes);
      setClasses(remote.length ? remote : getFallbackClasses());
    } catch (e: any) {
      if (!opts?.silent) toast.error(e?.message ?? "Не удалось загрузить классы");
      setClasses(getFallbackClasses());
    } finally {
      setClsBusy(false);
    }
  };

  useEffect(() => {
    void loadClasses({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const openRename = (cls: string) => {
    if (!sessionId) return toast.error("Нет sessionId. Сначала загрузи фото (страница Загрузка).");
    setRenameFrom(cls);
    setRenameTo(cls);
    setRenameOpen(true);
  };

  const applyRenameLocallyEverywhere = (from: string, to: string) => {
    const a = normalizeClassName(from);
    const b = normalizeClassName(to);
    if (!a || !b) return;
    if (normKey(a) === normKey(b)) return;

    const nextPhotos: PhotoItem[] = (items ?? []).map((p) => {
      const bxs = (p.bboxes ?? []).map((bb) => (normKey(String(bb.cls)) === normKey(a) ? { ...bb, cls: b as any } : bb));
      return bxs === p.bboxes ? p : { ...p, bboxes: bxs };
    });
    setPhotos(nextPhotos);

    for (const p of nextPhotos) {
      const d = decisions[p.id];
      if (!d || d.type !== "defect") continue;

      const nd = {
        ...d,
        defects: (d.defects ?? []).map((x: any) => (normKey(String(x.cls)) === normKey(a) ? { ...x, cls: b } : x)),
      } as any;

      setDecision(p.id, nd);
    }
  };

  const submitRename = async () => {
    if (!sessionId) return toast.error("Нет sessionId. Сначала загрузи фото (страница Загрузка).");
    if (renameBusy) return;

    const from = normalizeClassName(renameFrom);
    const to = normalizeClassName(renameTo);

    if (!from || !to) return toast.info("Заполни оба поля");
    if (from.length < 2 || to.length < 2) return toast.info("Слишком короткое название");
    if (normKey(from) === normKey(to)) return toast.info("Новое имя совпадает со старым");

    setRenameBusy(true);
    try {
      applyRenameLocallyEverywhere(from, to);

      setClasses((prev) => {
        const mapped = prev.map((c) => (normKey(c) === normKey(from) ? to : c));
        return Array.from(new Set(mapped.map(normalizeClassName).filter(Boolean))).sort((a, b) =>
          a.localeCompare(b, "ru", { sensitivity: "base" })
        );
      });

      const res = await api.renameSessionClass(sessionId, from, to);
      const remote = normalizeRemoteClasses(res?.classes);
      if (remote.length) setClasses(remote);

      toast.success(`Переименовано: “${from}” → “${to}”`);
      setRenameOpen(false);
    } catch (e: any) {
      toast.warn(
        (e?.message ? `Бэк пока не поддерживает rename: ${e.message}` : "Бэк пока не поддерживает rename") + " (локально применено)"
      );
      setRenameOpen(false);
    } finally {
      setRenameBusy(false);
    }
  };

  // ===== DATASET DIAGNOSTICS =====
  const datasetDiag = useMemo(() => {
    const images = { train: 0, val: 0 };
    const labeledPhotos = { train: 0, val: 0 };
    const boxes = { train: 0, val: 0 };

    const byClassTrain: Record<string, number> = {};
    const byClassVal: Record<string, number> = {};
    const classSetTrain = new Set<string>();
    const classSetVal = new Set<string>();

    for (const p of items) {
      const split = splitIsValLikeBackend(p.id) ? "val" : "train";
      images[split]++;

      const d = decisions[p.id];
      const bxs = p.bboxes ?? [];
      const isLabeled = d?.type === "defect" && bxs.length > 0;
      if (!isLabeled) continue;

      labeledPhotos[split]++;
      boxes[split] += bxs.length;

      for (const b of bxs) {
        const cls = String((b as any).cls ?? "").trim() || "unknown";
        if (split === "train") {
          byClassTrain[cls] = (byClassTrain[cls] ?? 0) + 1;
          classSetTrain.add(cls);
        } else {
          byClassVal[cls] = (byClassVal[cls] ?? 0) + 1;
          classSetVal.add(cls);
        }
      }
    }

    const allClasses = Array.from(new Set([...Object.keys(byClassTrain), ...Object.keys(byClassVal)])).sort((a, b) =>
      a.localeCompare(b, "ru", { sensitivity: "base" })
    );

    const onlyTrain = allClasses.filter((c) => classSetTrain.has(c) && !classSetVal.has(c));
    const onlyVal = allClasses.filter((c) => classSetVal.has(c) && !classSetTrain.has(c));

    const warnings: string[] = [];
    if (images.val === 0) warnings.push("В val нет изображений. YOLO может упасть при старте обучения (val: No images found).");
    if (labeledPhotos.val === 0) warnings.push("В val нет размеченных bbox. Метрики валидации будут бессмысленны/нулевые.");
    if (onlyTrain.length) warnings.push(`Классы есть только в train: ${onlyTrain.join(", ")}`);
    if (onlyVal.length) warnings.push(`Классы есть только в val: ${onlyVal.join(", ")}`);

    const ok = warnings.length === 0;

    const classRows = allClasses
      .map((cls) => ({ cls, train: byClassTrain[cls] ?? 0, val: byClassVal[cls] ?? 0 }))
      .sort((a, b) => b.train + b.val - (a.train + a.val));

    return { ok, warnings, images, boxes, classRows };
  }, [items, decisions]);

  const heroKpi = useMemo(() => {
    const total = items.length;
    const defect = items.filter((p) => decisions[p.id]?.type === "defect").length;
    const ok = items.filter((p) => decisions[p.id]?.type === "ok").length;
    const bboxes = items.reduce((s, p) => s + (p.bboxes?.length ?? 0), 0);
    const decidedCount = items.filter((p) => Boolean(decisions[p.id])).length;
    const unresolvedCount = total - decidedCount;
    return { total, ok, defect, bboxes, decidedCount, unresolvedCount };
  }, [items, decisions]);

  async function syncAllToBackend() {
    if (!sessionId) throw new Error("Нет sessionId. Вернись на Загрузку и загрузи фото заново.");
    const decidedPhotos = items.filter((p) => decisions[p.id]);
    if (!decidedPhotos.length) throw new Error("Нет решений. Сначала отметьте хотя бы одно фото.");

    toast.info(`Синхронизация с бэком… (${decidedPhotos.length} шт.)`);

    for (const p of decidedPhotos) {
      const d = decisions[p.id]!;
      if (d.type === "ok") {
        await api.saveLabels({
          sessionId,
          photoId: p.id,
          decision: "ok",
          meta: { class: "", place: "", comment: "", category: "", recommendedFix: "" },
          bboxes: [],
        });
      } else {
        const bxs = (p.bboxes ?? []).map((b) => ({
          id: b.id,
          class: b.cls as DefectClass,
          confidence: b.confidence,
          bbox: [b.x, b.y, b.w, b.h] as [number, number, number, number],
        }));

        await api.saveLabels({
          sessionId,
          photoId: p.id,
          decision: "defect",
          meta: {
            class: "",
            place: d.place ?? "",
            comment: d.comment ?? "",
            category: (d.category ?? "") as any,
            recommendedFix: d.recommendedFix ?? "",
          },
          bboxes: bxs,
        });
      }
    }

    toast.success("Синхронизировано с бэком");
  }

  async function startTrainFlow() {
    if (trainBusy) return;
    if (!sessionId) return toast.error("Нет sessionId. Вернись на Загрузку и загрузи фото заново.");
    if (heroKpi.decidedCount < 1) return toast.info("Нужно хотя бы одно решение в “Разметка”.");

    setTrainOpen(true);

    // подготовка UI
    train.patch({
      jobId: null,
      status: "queued",
      message: "Подготовка…",
      progress: 5,
      epoch: 0,
      epochsTotal: 0,
      batch: 0,
      batchesTotal: 0,
      startedAt: Date.now(),
    });

    try {
      train.patch({ message: "Синхронизация разметки…", progress: 12 });
      await syncAllToBackend();

      train.patch({ message: "Запуск обучения…", progress: 18, status: "queued" });

      const started = await api.trainSession(sessionId);
      const jobId = started.job_id;

      train.patch({
        jobId,
        status: "queued",
        message: started.message || "Обучение в очереди…",
        progress: Math.max(train.progress, 22),
      });
    } catch (e: any) {
      train.patch({
        status: "error",
        message: e?.message ?? "Ошибка запуска обучения",
        progress: Math.max(train.progress, 70),
      });
      toast.error(e?.message ?? "Ошибка запуска обучения");
    }
  }

  const splitTotal = datasetDiag.images.train + datasetDiag.images.val;
  const trainPct = splitTotal ? Math.round((datasetDiag.images.train / splitTotal) * 100) : 0;
  const valPct = splitTotal ? Math.round((datasetDiag.images.val / splitTotal) * 100) : 0;

  return (
    <div className="h-full w-full">
      {/* ===== Rename modal ===== */}
      <Modal open={renameOpen} onClose={() => !renameBusy && setRenameOpen(false)} title="Переименование класса">
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-white/60">
              Было
              <input
                className="mt-1 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85"
                value={renameFrom}
                onChange={(e) => setRenameFrom(e.target.value)}
                disabled={renameBusy}
              />
            </label>
            <label className="text-xs text-white/60">
              Стало
              <input
                className="mt-1 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85"
                value={renameTo}
                onChange={(e) => setRenameTo(e.target.value)}
                disabled={renameBusy}
              />
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="secondary" leftIcon={<X className="h-4 w-4" />} onClick={() => setRenameOpen(false)} disabled={renameBusy}>
              Отмена
            </Button>
            <Button variant="primary" leftIcon={<Save className="h-4 w-4" />} onClick={() => void submitRename()} disabled={renameBusy}>
              {renameBusy ? "Применяем…" : "Переименовать"}
            </Button>
          </div>

          <div className="text-[11px] text-white/45 leading-relaxed">
            Переименование применяется локально к bbox и решениям. Если бэк пока не поддерживает rename — увидишь предупреждение.
          </div>
        </div>
      </Modal>

      {/* ===== Train modal ===== */}
      <Modal open={trainOpen} onClose={() => setTrainOpen(false)} title="Обучение модели">
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white/85 truncate">{train.message || "…"}</div>
                <div className="mt-1 text-xs text-white/55 tabular-nums">
                  <span className={["inline-flex items-center rounded-full border px-2 py-0.5", trainBadge.cls].join(" ")}>
                    {trainBadge.text}
                  </span>
                  {train.jobId ? <span className="ml-2 text-white/45">job: {train.jobId}</span> : null}
                </div>

                {train.status === "running" && train.epochsTotal > 0 ? (
                  <div className="mt-1 text-xs text-white/45 tabular-nums">
                    эпоха {train.epoch}/{train.epochsTotal}
                    {train.batchesTotal > 0 && train.batch > 0 ? <span> • батч {train.batch}/{train.batchesTotal}</span> : null}
                  </div>
                ) : null}
              </div>

              <div className="text-xs text-white/60 tabular-nums">{Math.round(train.progress)}%</div>
            </div>

            <div className="mt-3">
              <ProgressBar value={train.progress} />
            </div>

            <div className="mt-3 text-xs text-white/55">
              Можно закрыть окно и переходить по страницам — статус не сбросится и будет обновляться.
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            {(train.status === "done" || train.status === "error") && (
              <Button variant="secondary" onClick={() => train.reset()}>
                Сбросить
              </Button>
            )}
            <Button variant="primary" onClick={() => setTrainOpen(false)}>
              Закрыть
            </Button>
            {train.status === "error" ? (
              <Button variant="secondary" onClick={() => void startTrainFlow()} disabled={trainBusy}>
                Повторить
              </Button>
            ) : null}
          </div>
        </div>
      </Modal>

      <div className="mx-auto max-w-[1200px] px-5 pt-8 pb-10 space-y-4">
        {/* ===== TOP BAR ===== */}
        <div className="rounded-[28px] border border-white/10 bg-ink-900/55 backdrop-blur-xl shadow-[0_18px_70px_rgba(0,0,0,0.45)] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xl md:text-2xl font-semibold tracking-tight text-white/90">Админка</div>
              <div className="mt-1 text-sm text-white/60">
                session: <span className="text-white/80 tabular-nums">{sessionId || "—"}</span>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-white/70 tabular-nums">
                  фото: <span className="text-white/90 font-semibold">{heroKpi.total}</span>
                </span>
                <span className="rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-white/70 tabular-nums">
                  bbox: <span className="text-white/90 font-semibold">{heroKpi.bboxes}</span>
                </span>
                <span className="rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-white/70 tabular-nums">
                  ok: <span className="text-emerald-200 font-semibold">{heroKpi.ok}</span>
                </span>
                <span className="rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-white/70 tabular-nums">
                  defect: <span className="text-orange-200 font-semibold">{heroKpi.defect}</span>
                </span>
                <span className="rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-white/70 tabular-nums">
                  решений: <span className="text-white/90 font-semibold">{heroKpi.decidedCount}</span>
                </span>
                <span className="rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-white/70 tabular-nums">
                  без решения: <span className="text-white/90 font-semibold">{heroKpi.unresolvedCount}</span>
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => nav("/upload")}>
                Загрузка
              </Button>
              <Button variant="secondary" leftIcon={<Wand2 className="h-4 w-4" />} onClick={() => nav("/viewer")}>
                Разметка
              </Button>
              <Button variant="secondary" onClick={() => nav("/summary")}>
                Итоги
              </Button>
            </div>
          </div>
        </div>

        {/* ===== TRAIN ===== */}
        <Card
          title="Обучение модели"
          icon={<Brain className="h-5 w-5" />}
          right={
            <div className="flex items-center gap-2">
              <span className={["inline-flex items-center rounded-full border px-2 py-1 text-xs font-semibold", trainBadge.cls].join(" ")}>
                {trainBadge.text}
              </span>
              <Button
                size="sm"
                variant="primary"
                leftIcon={<Play className="h-4 w-4" />}
                disabled={!canTrain || trainBusy}
                title={!sessionId ? "Нет sessionId" : heroKpi.decidedCount < 1 ? "Нужно хотя бы одно решение" : "Запустить обучение"}
                onClick={() => void startTrainFlow()}
              >
                {trainBusy ? "Идёт…" : "Обучить"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setTrainOpen(true)} disabled={train.status === "idle"}>
                Статус
              </Button>
            </div>
          }
        >
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-white/80 whitespace-pre-line">{train.message || "Нажми “Обучить”, чтобы начать."}</div>
                <div className="mt-2 text-xs text-white/50 tabular-nums">
                  {train.jobId ? <span>job: {train.jobId}</span> : <span>job: —</span>}
                  <span className="mx-2 text-white/25">•</span>
                  {train.epochsTotal > 0 ? (
                    <span>
                      эпоха {train.epoch}/{train.epochsTotal}
                      {train.batchesTotal > 0 && train.batch > 0 ? <span> • батч {train.batch}/{train.batchesTotal}</span> : null}
                    </span>
                  ) : (
                    <span>эпоха: —</span>
                  )}
                </div>
              </div>
              <div className="text-xs text-white/60 tabular-nums">{Math.round(train.progress)}%</div>
            </div>

            <div className="mt-3">
              <ProgressBar value={train.progress} />
            </div>

            {!sessionId ? <div className="mt-3 text-xs text-orange-200">⚠️ Нет sessionId — вернись на “Загрузка”.</div> : null}
            {sessionId && heroKpi.decidedCount < 1 ? (
              <div className="mt-3 text-xs text-orange-200">⚠️ Нужно хотя бы одно решение в “Разметка”.</div>
            ) : null}
          </div>
        </Card>

        {/* ===== ML ===== */}
        <Card
          title="Модель и веса"
          icon={<Cpu className="h-5 w-5" />}
          right={
            <div className="flex items-center gap-2">
              <div className={["h-2.5 w-2.5 rounded-full border", statusDot].join(" ")} title={mlHealthErr ? "Ошибка" : mlHealth ? "ОК" : "—"} />
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<RefreshCw className={["h-4 w-4", mlHealthBusy ? "animate-spin" : ""].join(" ")} />}
                onClick={() => void loadMlHealth()}
                disabled={mlHealthBusy || mlReloadBusy}
              >
                Обновить
              </Button>
              <Button
                size="sm"
                variant="primary"
                leftIcon={<Wand2 className={["h-4 w-4", mlReloadBusy ? "animate-pulse" : ""].join(" ")} />}
                onClick={() => void reloadWeights()}
                disabled={mlReloadBusy}
                title="health/ml?load=true — перезагрузка модели/весов на бэке"
              >
                {mlReloadBusy ? "…" : "Перезагрузить"}
              </Button>
            </div>
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-white/55">
            <div className="min-w-0 truncate">
              endpoint: <span className="text-white/75">{api.baseUrl}/health/ml</span>
            </div>
            <div className="tabular-nums">{updatedLabel}</div>
          </div>

          {mlHealthErr ? (
            <div className="mt-3 rounded-2xl border border-rose-300/20 bg-rose-500/10 p-3 text-sm text-rose-200">{mlHealthErr}</div>
          ) : null}

          <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-[11px] text-white/50">weights path</div>
            <div className="mt-2 text-sm font-semibold text-white/85 break-words">{weightsPath || "—"}</div>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                <div className="text-[11px] text-white/50">sha</div>
                <div className="mt-1 text-sm font-semibold text-white/85 tabular-nums inline-flex items-center gap-2">
                  <Hash className="h-4 w-4 text-white/45" /> {shortSha(sha)}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                <div className="text-[11px] text-white/50">mtime</div>
                <div className="mt-1 text-sm font-semibold text-white/85 tabular-nums inline-flex items-center gap-2">
                  <Clock className="h-4 w-4 text-white/45" /> {mtimeFromNs(mtimeNs)}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                <div className="text-[11px] text-white/50">size</div>
                <div className="mt-1 text-sm font-semibold text-white/85 tabular-nums inline-flex items-center gap-2">
                  <HardDrive className="h-4 w-4 text-white/45" /> {fmtBytes(size)}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                <div className="text-[11px] text-white/50">device</div>
                <div className="mt-1 text-sm font-semibold text-white/85 tabular-nums inline-flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-white/45" /> {device || "—"}
                  {typeof useSeg === "boolean" ? (
                    <span className="ml-2 text-[11px] font-semibold text-white/55">
                      seg: <span className="text-white/80">{useSeg ? "on" : "off"}</span>
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-3 text-xs text-white/55">
              После обучения здесь должны измениться mtime/sha/size — это быстрый способ проверить, что model.pt обновился.
            </div>
          </div>
        </Card>

        {/* ===== CLASSES ===== */}
        <Card
          title="Классы (rename)"
          icon={<Tag className="h-5 w-5" />}
          right={
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<RefreshCw className={["h-4 w-4", clsBusy ? "animate-spin" : ""].join(" ")} />}
              onClick={() => void loadClasses()}
              disabled={clsBusy}
              title="Перезагрузить список классов"
            >
              Обновить
            </Button>
          }
        >
          <div className="flex items-center justify-between gap-3 text-xs text-white/55">
            <div>
              Всего: <span className="text-white/85 tabular-nums font-semibold">{classes.length}</span>
            </div>
            <div className="text-white/40">Нажми ✎ чтобы переименовать</div>
          </div>

          <div className="mt-3 rounded-2xl border border-white/10 bg-black/20">
            <div className="max-h-[360px] overflow-auto no-scrollbar p-2">
              {classes.length ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {classes.map((c) => (
                    <div key={c} className="rounded-2xl border border-white/10 bg-white/[0.02] p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white/85 truncate">{c}</div>
                        <div className="text-[11px] text-white/45 truncate">key: {normKey(c)}</div>
                      </div>

                      <button
                        type="button"
                        onClick={() => openRename(c)}
                        className="shrink-0 h-10 w-10 rounded-2xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] transition flex items-center justify-center"
                        title="Переименовать"
                      >
                        <Pencil className="h-4 w-4 text-white/75" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 text-sm text-white/60">Классы не найдены.</div>
              )}
            </div>
          </div>

          {!sessionId ? <div className="mt-3 text-xs text-orange-200">⚠️ Нет sessionId — rename в бэке недоступен, будет только локально.</div> : null}
        </Card>

        {/* ===== DATASET ===== */}
        <Card
          title="Диагностика датасета (train/val)"
          icon={<Database className="h-5 w-5" />}
          right={
            <div
              className={[
                "inline-flex items-center gap-2 rounded-2xl border px-3 py-2 text-xs font-semibold",
                datasetDiag.ok ? "border-emerald-300/20 bg-emerald-500/10 text-emerald-200" : "border-orange-300/20 bg-orange-500/10 text-orange-200",
              ].join(" ")}
            >
              {datasetDiag.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              {datasetDiag.ok ? "ОК" : "Есть риски"}
            </div>
          }
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-white/85">Split</div>
                <div className="text-xs text-white/55 tabular-nums">
                  train {datasetDiag.images.train} ({trainPct}%) • val {datasetDiag.images.val} ({valPct}%)
                </div>
              </div>

              <div className="mt-3 space-y-3">
                <div>
                  <div className="flex items-center justify-between text-xs text-white/55">
                    <span>train</span>
                    <span className="tabular-nums">{datasetDiag.images.train}</span>
                  </div>
                  <div className="mt-2">
                    <ProgressBar value={trainPct} />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs text-white/55">
                    <span>val</span>
                    <span className="tabular-nums">{datasetDiag.images.val}</span>
                  </div>
                  <div className="mt-2">
                    <ProgressBar value={valPct} />
                  </div>
                </div>
              </div>

              {datasetDiag.warnings.length ? (
                <div className="mt-3 rounded-2xl border border-orange-300/20 bg-orange-500/10 p-3">
                  <div className="text-xs font-semibold text-orange-200">Предупреждения</div>
                  <ul className="mt-2 space-y-1 text-xs text-white/70">
                    {datasetDiag.warnings.map((w, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="mt-[2px] h-1.5 w-1.5 rounded-full bg-orange-300/70 shrink-0" />
                        <span className="leading-snug">{w}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="mt-3 text-xs text-emerald-200">✅ Split выглядит корректно.</div>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-white/85">Классы по bbox</div>
                <div className="text-xs text-white/55 tabular-nums">
                  bbox train {datasetDiag.boxes.train} • val {datasetDiag.boxes.val}
                </div>
              </div>

              <div className="mt-3 max-h-[320px] overflow-auto no-scrollbar rounded-2xl border border-white/10">
                <div className="grid grid-cols-[1fr_86px_86px] gap-2 px-3 py-2 text-[11px] uppercase tracking-wide text-white/45 bg-black/25 sticky top-0">
                  <div>Класс</div>
                  <div className="text-right">train</div>
                  <div className="text-right">val</div>
                </div>

                {datasetDiag.classRows.length ? (
                  <div className="p-2 space-y-1">
                    {datasetDiag.classRows.map((r) => {
                      const onlyTrain = r.train > 0 && r.val === 0;
                      const onlyVal = r.val > 0 && r.train === 0;
                      return (
                        <div
                          key={r.cls}
                          className={[
                            "grid grid-cols-[1fr_86px_86px] gap-2 items-center px-2 py-2 rounded-2xl border",
                            onlyTrain
                              ? "border-orange-300/20 bg-orange-500/8"
                              : onlyVal
                              ? "border-red-300/20 bg-red-500/8"
                              : "border-white/5 bg-white/[0.02]",
                          ].join(" ")}
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-white/85 truncate">{r.cls}</div>
                            {onlyTrain ? (
                              <div className="text-[11px] text-orange-200/90">только train</div>
                            ) : onlyVal ? (
                              <div className="text-[11px] text-red-200/90">только val</div>
                            ) : (
                              <div className="text-[11px] text-white/45">train+val</div>
                            )}
                          </div>
                          <div className="text-right text-sm text-white/75 tabular-nums">{r.train}</div>
                          <div className="text-right text-sm text-white/75 tabular-nums">{r.val}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="p-4 text-sm text-white/60">
                    Пока нет bbox для сравнения. Нужны фото с решением “Есть дефект” и хотя бы одним bbox.
                  </div>
                )}
              </div>

              <div className="mt-3 text-xs text-white/55">
                Если класс есть только в train — валидация его не покажет, пока он не появится в val хотя бы в одном bbox.
              </div>
            </div>
          </div>

          {!items.length ? (
            <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
              Пока нет фото. Перейди на “Загрузка” и добавь изображения.
              <div className="mt-3">
                <Button variant="primary" onClick={() => nav("/upload")}>
                  На загрузку
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
