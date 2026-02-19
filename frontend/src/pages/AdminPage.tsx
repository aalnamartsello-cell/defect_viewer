// src/pages/AdminPage.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Shield,
  Sparkles,
  RefreshCw,
  Cpu,
  HardDrive,
  Hash,
  Clock,
  Tag,
  Pencil,
  Save,
  X,
  Database,
  Layers,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  Wand2,
  Brain,
  Play,
} from "lucide-react";

import Button from "../components/ui/Button";
import ProgressBar from "../components/ui/ProgressBar";
import Modal from "../components/ui/Modal";
import { toast } from "../components/ui/ToastCenter";
import { useAppStore } from "../store/useAppStore";
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

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
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

/**
 * ✅ Рекурсивный поиск значений по ключам в любом вложении.
 */
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
      if (wanted.has(String(k).toLowerCase())) {
        return (cur as any)[k];
      }
    }

    for (const v of Object.values(cur)) {
      if (!v) continue;
      if (typeof v === "object") q.push(v);
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

/**
 * Бэк часто отдаёт epoch как:
 * - number: 12
 * - string: "12/30"
 * - или epoch_current / current_epoch / epochs_total и т.п.
 */
function parseEpochInfo(st: any): { epoch: number; total: number } {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (st && st[k] !== undefined && st[k] !== null) return st[k];
    return undefined;
  };

  const rawEpoch = pick("epoch", "epoch_current", "current_epoch", "epoch_idx", "epochIndex");
  const rawTotal = pick("epochs_total", "epochsTotal", "epochs", "total_epochs", "totalEpochs");

  let epoch = 0;
  let total = 0;

  if (typeof rawTotal === "number" && Number.isFinite(rawTotal)) total = rawTotal;
  else if (typeof rawTotal === "string") {
    const t = Number(rawTotal.trim());
    if (Number.isFinite(t)) total = t;
  }

  if (typeof rawEpoch === "number" && Number.isFinite(rawEpoch)) {
    epoch = rawEpoch;
  } else if (typeof rawEpoch === "string") {
    const s = rawEpoch.trim();
    const m = s.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) {
      epoch = Number(m[1]) || 0;
      const t = Number(m[2]) || 0;
      if (!total && t) total = t;
    } else {
      const n = Number(s);
      if (Number.isFinite(n)) epoch = n;
    }
  }

  if ((!epoch || !total) && typeof st?.progress_text === "string") {
    const mm = st.progress_text.match(/(\d+)\s*\/\s*(\d+)/);
    if (mm) {
      if (!epoch) epoch = Number(mm[1]) || 0;
      if (!total) total = Number(mm[2]) || 0;
    }
  }

  epoch = Number.isFinite(epoch) ? Math.max(0, Math.floor(epoch)) : 0;
  total = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;

  return { epoch, total };
}

/**
 * Для "точной" полоски: пытаемся вытащить прогресс внутри эпохи (батч i/n).
 */
function parseBatchInfo(st: any): { batch: number; total: number } {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (st && st[k] !== undefined && st[k] !== null) return st[k];
    return undefined;
  };

  const rawBatch = pick("batch", "batch_i", "batchIndex", "batch_idx", "iter", "i");
  const rawTotal = pick("batches_total", "batch_total", "nb", "n_batches", "batches", "iters_total");

  let batch = 0;
  let total = 0;

  if (typeof rawTotal === "number" && Number.isFinite(rawTotal)) total = rawTotal;
  else if (typeof rawTotal === "string") {
    const t = Number(rawTotal.trim());
    if (Number.isFinite(t)) total = t;
  }

  if (typeof rawBatch === "number" && Number.isFinite(rawBatch)) batch = rawBatch;
  else if (typeof rawBatch === "string") {
    const n = Number(rawBatch.trim());
    if (Number.isFinite(n)) batch = n;
  }

  const text = String(st?.progress_text ?? st?.message ?? "");
  if ((!batch || !total) && text) {
    const m = text.match(/батч\s*(\d+)\s*\/\s*(\d+)/i);
    if (m) {
      if (!batch) batch = Number(m[1]) || 0;
      if (!total) total = Number(m[2]) || 0;
    } else {
      const mm = text.match(/batch\s*(\d+)\s*\/\s*(\d+)/i);
      if (mm) {
        if (!batch) batch = Number(mm[1]) || 0;
        if (!total) total = Number(mm[2]) || 0;
      }
    }
  }

  batch = Number.isFinite(batch) ? Math.max(0, Math.floor(batch)) : 0;
  total = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;

  return { batch, total };
}

/**
 * Самый точный progress 0..1:
 *  1) st.progress (если 0..1)
 *  2) epoch/total + batch/nb (если есть)
 *  3) epoch/total
 */
function computeProgress01(st: any) {
  const raw = Number(st?.progress);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1.000001) {
    return clamp(raw, 0, 1);
  }

  const { epoch, total } = parseEpochInfo(st);
  const { batch, total: batchTotal } = parseBatchInfo(st);

  if (total > 0) {
    const epUi = epoch <= 0 ? 0 : epoch;
    const ep0 = epUi > 0 ? epUi - 1 : 0;

    let frac = 0;
    if (batchTotal > 0) {
      frac = clamp(batch / batchTotal, 0, 1);
    }

    const p = (ep0 + frac) / total;
    return clamp(Math.min(0.99, p), 0, 0.99);
  }

  return 0;
}

function ScrollLink({ toId, label, icon }: { toId: string; label: string; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => {
        const el = document.getElementById(toId);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
      className={[
        "w-full flex items-center justify-between gap-3",
        "rounded-2xl border px-3 py-2 text-sm font-semibold transition",
        "border-white/10 bg-white/[0.03] text-white/75 hover:bg-white/[0.06]",
      ].join(" ")}
    >
      <span className="inline-flex items-center gap-2">
        <span className="opacity-90">{icon}</span>
        <span>{label}</span>
      </span>
      <ArrowRight className="h-4 w-4 text-white/40" />
    </button>
  );
}

export default function AdminPage() {
  const nav = useNavigate();

  const { sessionId, photos, decisionByPhoto, setPhotos, setDecision } = useAppStore();
  const items = photos ?? [];
  const decisions = (decisionByPhoto ?? {}) as Record<string, OperatorDecision | undefined>;

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

  const updatedLabel =
    mlHealthUpdatedAt ? `обновлено: ${fmtTimeHHMMSS(mlHealthUpdatedAt)} • авто-обновление каждые 30с` : "—";

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
    if (!sessionId) {
      toast.error("Нет sessionId. Сначала загрузи фото (страница Загрузка).");
      return;
    }
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
      if (!d) continue;
      if (d.type !== "defect") continue;

      const nd = {
        ...d,
        defects: (d.defects ?? []).map((x: any) => (normKey(String(x.cls)) === normKey(a) ? { ...x, cls: b } : x)),
      } as any;

      setDecision(p.id, nd);
    }
  };

  const submitRename = async () => {
    if (!sessionId) {
      toast.error("Нет sessionId. Сначала загрузи фото (страница Загрузка).");
      return;
    }
    if (renameBusy) return;

    const from = normalizeClassName(renameFrom);
    const to = normalizeClassName(renameTo);

    if (!from || !to) {
      toast.info("Заполни оба поля");
      return;
    }
    if (from.length < 2 || to.length < 2) {
      toast.info("Слишком короткое название");
      return;
    }
    if (normKey(from) === normKey(to)) {
      toast.info("Новое имя совпадает со старым");
      return;
    }

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
    const decided = { train: 0, val: 0 };
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
      if (d) decided[split]++;

      const bxs = p.bboxes ?? [];
      const isLabeled = d?.type === "defect" && bxs.length > 0;
      if (isLabeled) {
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
      .map((cls) => ({
        cls,
        train: byClassTrain[cls] ?? 0,
        val: byClassVal[cls] ?? 0,
      }))
      .sort((a, b) => b.train + b.val - (a.train + a.val));

    return {
      ok,
      warnings,
      images,
      decided,
      labeledPhotos,
      boxes,
      classRows,
    };
  }, [items, decisions]);

  const decidedCount = useMemo(() => {
    let c = 0;
    for (const p of items) if (decisions[p.id]) c++;
    return c;
  }, [items, decisions]);

  const unresolvedCount = useMemo(() => {
    let c = 0;
    for (const p of items) if (!decisions[p.id]) c++;
    return c;
  }, [items, decisions]);

  const heroKpi = useMemo(() => {
    const total = items.length;
    const defect = items.filter((p) => decisions[p.id]?.type === "defect").length;
    const ok = items.filter((p) => decisions[p.id]?.type === "ok").length;
    const bboxes = items.reduce((s, p) => s + (p.bboxes?.length ?? 0), 0);
    return { total, ok, defect, bboxes };
  }, [items, decisions]);

  // =========================
  // ===== TRAIN (moved here)
  // =========================
  const canTrain = decidedCount >= 1 && Boolean(sessionId);

  const [trainOpen, setTrainOpen] = useState(false);
  const [trainBusy, setTrainBusy] = useState(false);
  const [trainJobId, setTrainJobId] = useState<string | null>(null);
  const [trainStatus, setTrainStatus] = useState<"idle" | "queued" | "running" | "done" | "error">("idle");
  const [trainMessage, setTrainMessage] = useState<string>("");
  const [trainProgress, setTrainProgress] = useState<number>(0);

  const [trainEpoch, setTrainEpoch] = useState<number>(0);
  const [trainEpochsTotal, setTrainEpochsTotal] = useState<number>(0);
  const [trainBatch, setTrainBatch] = useState<number>(0);
  const [trainBatchesTotal, setTrainBatchesTotal] = useState<number>(0);

  const fallbackTickRef = useRef<number | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const trainStatusRef = useRef(trainStatus);
  useEffect(() => {
    trainStatusRef.current = trainStatus;
  }, [trainStatus]);

  function stopPolling() {
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function stopFallbackTick() {
    if (fallbackTickRef.current) {
      window.clearInterval(fallbackTickRef.current);
      fallbackTickRef.current = null;
    }
  }

  function startFallbackTick() {
    stopFallbackTick();
    fallbackTickRef.current = window.setInterval(() => {
      setTrainProgress((p) => {
        const st = trainStatusRef.current;
        const cap = st === "queued" ? 35 : 92;
        if (p >= cap) return p;
        const step = p < 50 ? 2.2 : p < 80 ? 1.1 : 0.55;
        return clamp(p + step, 0, cap);
      });
    }, 220);
  }

  useEffect(() => {
    return () => {
      stopPolling();
      stopFallbackTick();
    };
  }, []);

  async function syncAllToBackend() {
    if (!sessionId) throw new Error("Нет sessionId. Вернись на Загрузку и загрузи фото заново.");
    const decidedPhotos = items.filter((p) => decisions[p.id]);

    if (!decidedPhotos.length) {
      throw new Error("Нет решений. Сначала отметьте хотя бы одно фото (Есть дефект / Дефектов нет).");
    }

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

  function resetTrainUi() {
    setTrainJobId(null);
    setTrainStatus("idle");
    setTrainMessage("");
    setTrainProgress(0);
    setTrainEpoch(0);
    setTrainEpochsTotal(0);
    setTrainBatch(0);
    setTrainBatchesTotal(0);
  }

  async function startTrainFlow() {
    if (trainBusy) return;

    if (!sessionId) {
      toast.error("Нет sessionId. Вернись на Загрузку и загрузи фото заново.");
      return;
    }
    if (decidedCount < 1) {
      toast.info("Сначала проставь решение хотя бы на одном фото (в Просмотре).");
      return;
    }

    setTrainOpen(true);
    setTrainBusy(true);
    setTrainJobId(null);
    setTrainStatus("queued");
    setTrainMessage("Подготовка…");
    setTrainProgress(5);
    setTrainEpoch(0);
    setTrainEpochsTotal(0);
    setTrainBatch(0);
    setTrainBatchesTotal(0);

    try {
      setTrainMessage("Синхронизация разметки с бэком…");
      setTrainProgress(10);
      await syncAllToBackend();

      setTrainMessage("Запускаем обучение…");
      setTrainStatus("queued");
      setTrainProgress(18);

      const started = await api.trainSession(sessionId);
      const jobId = started.job_id;

      setTrainJobId(jobId);
      setTrainMessage(started.message || "Обучение поставлено в очередь…");

      stopPolling();
      stopFallbackTick();
      startFallbackTick();

      pollTimerRef.current = window.setInterval(async () => {
        try {
          const st = await api.trainStatus(jobId);

          setTrainStatus(st.status as any);
          setTrainMessage(st.message || "");

          const { epoch, total } = parseEpochInfo(st);
          setTrainEpoch(epoch);
          if (total > 0) setTrainEpochsTotal(total);

          const { batch, total: bt } = parseBatchInfo(st);
          setTrainBatch(batch);
          setTrainBatchesTotal(bt);

          const prog01 = computeProgress01(st);

          if (st.status === "queued") {
            setTrainProgress((p) => Math.max(p, 22));
          }

          if (st.status === "running") {
            if (prog01 > 0) {
              stopFallbackTick();
              const pct = Math.round(clamp(prog01 * 100, 0, 99));
              setTrainProgress((p) => Math.max(p, pct));
            } else {
              setTrainProgress((p) => clamp(p + 1.1, 35, 92));
            }
          }

          if (st.status === "done") {
            stopPolling();
            stopFallbackTick();

            setTrainProgress(100);
            setTrainBusy(false);

            const modelPath = (st as any).model_path ? `\nМодель: ${(st as any).model_path}` : "";
            setTrainMessage(`Готово ✅ В модель добавлены новые файлы для обучения.${modelPath}`);

            toast.success("Обучение завершено: model.pt обновлён");
            // обновим ML карточку, чтобы сразу увидеть новый sha/mtime/size
            void loadMlHealth({ silent: true, toastOnWeightsChange: true });
          }

          if (st.status === "error") {
            stopPolling();
            stopFallbackTick();

            setTrainBusy(false);
            setTrainProgress((p) => Math.max(p, 70));
            setTrainMessage(st.message || "Ошибка обучения");

            toast.error("Ошибка обучения (см. сообщение в окне)");
          }
        } catch {
          setTrainMessage((m) => (m ? m : "Ожидаем статус…"));
        }
      }, 800);
    } catch (e: any) {
      stopPolling();
      stopFallbackTick();

      setTrainBusy(false);
      setTrainStatus("error");
      setTrainMessage(e?.message ?? "Ошибка запуска обучения");
      toast.error(e?.message ?? "Ошибка запуска обучения");
    }
  }

  const lastTrainBadge =
    trainStatus === "done"
      ? { text: "done", cls: "border-emerald-300/20 bg-emerald-500/10 text-emerald-200" }
      : trainStatus === "error"
      ? { text: "error", cls: "border-red-300/20 bg-red-500/10 text-red-200" }
      : trainStatus === "running"
      ? { text: "running", cls: "border-orange-300/20 bg-orange-500/10 text-orange-200" }
      : trainStatus === "queued"
      ? { text: "queued", cls: "border-orange-300/20 bg-orange-500/10 text-orange-200" }
      : { text: "idle", cls: "border-white/10 bg-white/[0.03] text-white/70" };

  return (
    <div className="h-full w-full">
      {/* ===== Rename modal ===== */}
      <Modal open={renameOpen} onClose={() => !renameBusy && setRenameOpen(false)} title="Переименование класса">
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 h-10 w-10 rounded-2xl bg-orange-500/[0.12] border border-orange-300/20 flex items-center justify-center">
                <Tag className="h-5 w-5 text-orange-200" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white/90">Rename класса дефекта</div>
                <div className="mt-1 text-xs text-white/60 leading-relaxed">
                  После применения имя обновится <span className="text-white/80">во всех bbox</span> и{" "}
                  <span className="text-white/80">в решениях оператора</span> локально.
                  <br />
                  Далее синхронизируем это с бэком (эндпоинт подключим следующим шагом).
                </div>
              </div>
            </div>
          </div>

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
        </div>
      </Modal>

      {/* ===== Train modal (using existing Modal) ===== */}
      <Modal
        open={trainOpen}
        onClose={() => setTrainOpen(false)}
        title="Обучение модели"
      >
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="flex items-center gap-3">
              <div
                className="h-10 w-10 rounded-2xl border border-white/10 bg-white/[0.04] flex items-center justify-center"
                title="Статус"
              >
                <div
                  className={[
                    "h-5 w-5 rounded-full",
                    trainStatus === "done"
                      ? "bg-emerald-400/80"
                      : trainStatus === "error"
                      ? "bg-red-400/80"
                      : "bg-orange-400/80 animate-pulse",
                  ].join(" ")}
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-white/85 truncate">{trainMessage || "…"}</div>

                {(trainStatus === "running" || trainStatus === "queued") && trainEpochsTotal > 0 ? (
                  <div className="text-xs text-white/55 mt-1 tabular-nums">
                    эпоха: {trainEpoch}/{trainEpochsTotal}
                    {trainBatchesTotal > 0 && trainBatch > 0 ? (
                      <span className="text-white/45"> • батч {trainBatch}/{trainBatchesTotal}</span>
                    ) : null}
                  </div>
                ) : null}

                {trainJobId ? <div className="text-xs text-white/50 mt-0.5 tabular-nums">job: {trainJobId}</div> : null}
              </div>

              <div className="text-xs text-white/60 tabular-nums">{Math.round(trainProgress)}%</div>
            </div>

            <div className="mt-3">
              <ProgressBar value={trainProgress} />
            </div>

            {trainStatus !== "done" && trainStatus !== "error" ? (
              <div className="mt-3 text-xs text-white/55">Можно закрыть окно — обучение продолжится в фоне.</div>
            ) : null}

            {trainStatus === "done" ? (
              <div className="mt-3 text-sm text-emerald-200">Готово ✅ model.pt обновлён.</div>
            ) : null}

            {trainStatus === "error" ? (
              <div className="mt-3 text-sm text-red-200">Ошибка ❌ Проверь сообщение и попробуй ещё раз.</div>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2">
            {trainStatus === "done" || trainStatus === "error" ? (
              <Button
                variant="primary"
                onClick={() => {
                  stopPolling();
                  stopFallbackTick();
                  setTrainBusy(false);
                  setTrainOpen(false);
                  resetTrainUi();
                }}
              >
                Закрыть
              </Button>
            ) : (
              <Button onClick={() => setTrainOpen(false)}>Скрыть</Button>
            )}

            {trainStatus === "error" ? (
              <Button variant="secondary" onClick={() => void startTrainFlow()} disabled={trainBusy}>
                Повторить
              </Button>
            ) : null}
          </div>
        </div>
      </Modal>

      <div className="mx-auto max-w-[1400px] px-5 pt-10 pb-10">
        {/* ===== HERO ===== */}
        <div className="relative overflow-hidden rounded-[32px] border border-white/10 bg-ink-900/60 backdrop-blur-xl shadow-[0_35px_140px_rgba(0,0,0,.62)]">
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute -top-24 -left-24 h-72 w-72 rounded-full bg-orange-500/12 blur-3xl" />
            <div className="absolute -top-20 right-10 h-80 w-80 rounded-full bg-amber-300/10 blur-3xl" />
            <div className="absolute -bottom-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-white/[0.04] blur-3xl" />
            <div className="absolute inset-0 bg-gradient-to-r from-white/[0.03] via-transparent to-white/[0.03]" />
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-orange-300/30 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </div>

          <div className="relative p-7 md:p-9">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 rounded-2xl border border-orange-300/15 bg-orange-500/[0.06] px-3 py-2">
                  <Shield className="h-4 w-4 text-orange-200" />
                  <span className="text-xs font-semibold text-orange-100">Админка</span>
                  <span className="text-[11px] text-white/55">модель • обучение • классы • диагностика</span>
                </div>

                <div className="mt-4 text-3xl md:text-4xl font-semibold tracking-tight">Control Center</div>
                <div className="mt-2 text-sm md:text-base text-white/70 max-w-[920px] leading-relaxed">
                  Панель для ML: веса/health, обучение (с прогрессом), переименование классов и диагностика train/val.
                </div>

                <div className="mt-4 inline-flex items-center gap-2 rounded-2xl border px-3 py-2 text-xs font-semibold border-white/10 bg-white/[0.03] text-white/70">
                  <Brain className="h-4 w-4 text-white/60" />
                  Train:
                  <span className={["rounded-full border px-2 py-0.5", lastTrainBadge.cls].join(" ")}>{lastTrainBadge.text}</span>
                  {trainJobId ? <span className="text-white/55 tabular-nums">job: {trainJobId}</span> : null}
                </div>
              </div>

              <div className="flex flex-col gap-2 w-full sm:w-auto">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-3xl border border-white/10 bg-black/25 p-4">
                    <div className="text-[11px] text-white/55">Фото</div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums">{heroKpi.total}</div>
                    <div className="mt-1 text-[11px] text-white/50">bbox: {heroKpi.bboxes}</div>
                  </div>
                  <div className="rounded-3xl border border-white/10 bg-black/25 p-4">
                    <div className="text-[11px] text-white/55">Решения</div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums">{decidedCount}</div>
                    <div className="mt-1 text-[11px] text-white/50">нерешённых: {unresolvedCount}</div>
                  </div>
                </div>

                <div className="flex gap-2 justify-end">
                  <Button variant="secondary" onClick={() => nav("/viewer")} leftIcon={<Wand2 className="h-4 w-4" />}>
                    В просмотр
                  </Button>
                  <Button variant="primary" onClick={() => nav("/summary")} leftIcon={<Sparkles className="h-4 w-4" />}>
                    Итоги
                  </Button>
                </div>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs text-white/60">ОК</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-emerald-200">{heroKpi.ok}</div>
              </div>
              <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs text-white/60">Есть дефект</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-orange-200">{heroKpi.defect}</div>
              </div>
              <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs text-white/60">Риски split</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {datasetDiag.ok ? <span className="text-emerald-200">0</span> : <span className="text-orange-200">{datasetDiag.warnings.length}</span>}
                </div>
              </div>
              <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs text-white/60">Обучение</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {trainStatus === "running" || trainStatus === "queued" ? (
                    <span className="text-orange-200">{Math.round(trainProgress)}%</span>
                  ) : trainStatus === "done" ? (
                    <span className="text-emerald-200">готово</span>
                  ) : trainStatus === "error" ? (
                    <span className="text-red-200">ошибка</span>
                  ) : (
                    <span className="text-white/70">—</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ===== LAYOUT ===== */}
        <div className="mt-6 grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-4">
          {/* LEFT sticky nav */}
          <div className="xl:sticky xl:top-[84px] h-fit">
            <div className="rounded-3xl border border-white/10 bg-ink-900/55 backdrop-blur-xl shadow-[0_22px_90px_rgba(0,0,0,0.45)] p-4">
              <div className="text-xs text-white/60 mb-3">Быстрый доступ</div>
              <div className="space-y-2">
                <ScrollLink toId="sec-train" label="Обучение модели" icon={<Brain className="h-4 w-4" />} />
                <ScrollLink toId="sec-ml" label="Модель и веса" icon={<Cpu className="h-4 w-4" />} />
                <ScrollLink toId="sec-classes" label="Классы (rename)" icon={<Tag className="h-4 w-4" />} />
                <ScrollLink toId="sec-dataset" label="Диагностика датасета" icon={<Database className="h-4 w-4" />} />
              </div>

              <div className="mt-4 rounded-3xl border border-orange-300/10 bg-orange-500/[0.05] p-4">
                <div className="text-sm font-semibold text-white/85">Порядок действий</div>
                <div className="mt-1 text-xs text-white/60 leading-relaxed">
                  1) Разметь фото → 2) Нажми “Обучить модель” → 3) После done проверь веса в “Модель и текущие веса”.
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT content */}
          <div className="min-w-0 flex flex-col gap-4">
            {/* ===== TRAIN ===== */}
            <div
              id="sec-train"
              className="rounded-[32px] border border-white/10 bg-ink-900/55 backdrop-blur-xl shadow-[0_30px_120px_rgba(0,0,0,.55)] overflow-hidden"
            >
              <div className="relative p-6">
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute -top-24 left-10 h-72 w-72 rounded-full bg-orange-500/10 blur-3xl" />
                  <div className="absolute -top-24 right-10 h-72 w-72 rounded-full bg-emerald-400/8 blur-3xl" />
                  <div className="absolute inset-0 bg-gradient-to-r from-white/[0.02] via-transparent to-white/[0.02]" />
                </div>

                <div className="relative flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Brain className="h-5 w-5 text-white/70" />
                      <div className="text-lg font-semibold">Обучение модели</div>
                    </div>
                    <div className="mt-1 text-sm text-white/60">
                      Авто-флоу: sync labels → старт обучения → статус/прогресс. Можно закрыть окно — процесс продолжится.
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="primary"
                      leftIcon={<Play className="h-4 w-4" />}
                      disabled={!canTrain || trainBusy}
                      title={!sessionId ? "Нет sessionId" : decidedCount < 1 ? "Нужно хотя бы одно решение" : "Запустить обучение"}
                      onClick={() => void startTrainFlow()}
                    >
                      {trainBusy ? "Обучаем…" : "Обучить модель"}
                    </Button>

                    <Button
                      variant="secondary"
                      leftIcon={<Wand2 className="h-4 w-4" />}
                      onClick={() => setTrainOpen(true)}
                      disabled={trainStatus === "idle"}
                      title="Открыть окно статуса"
                    >
                      Статус
                    </Button>
                  </div>
                </div>

                <div className="relative mt-4 rounded-3xl border border-white/10 bg-black/20 p-5">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className={["inline-flex items-center gap-2 rounded-2xl border px-3 py-2 text-xs font-semibold", lastTrainBadge.cls].join(" ")}>
                        {lastTrainBadge.text}
                      </span>
                      {trainJobId ? <span className="text-xs text-white/55 tabular-nums">job: {trainJobId}</span> : null}
                    </div>

                    <div className="text-xs text-white/55 tabular-nums">
                      {trainEpochsTotal > 0 ? (
                        <>
                          эпоха {trainEpoch}/{trainEpochsTotal}
                          {trainBatchesTotal > 0 && trainBatch > 0 ? (
                            <span className="text-white/45"> • батч {trainBatch}/{trainBatchesTotal}</span>
                          ) : null}
                        </>
                      ) : (
                        "—"
                      )}
                    </div>
                  </div>

                  <div className="mt-3">
                    <ProgressBar value={trainProgress} />
                  </div>

                  <div className="mt-3 text-sm text-white/70 whitespace-pre-line">
                    {trainMessage ? trainMessage : "Нажми “Обучить модель”, чтобы начать."}
                  </div>

                  {!sessionId ? (
                    <div className="mt-3 text-xs text-orange-200">
                      ⚠️ Нет sessionId — обучение недоступно. Перейди на “Загрузка” и загрузи фото заново.
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {/* ===== ML ===== */}
            <div
              id="sec-ml"
              className="rounded-[32px] border border-white/10 bg-ink-900/55 backdrop-blur-xl shadow-[0_30px_120px_rgba(0,0,0,.55)] overflow-hidden"
            >
              <div className="relative p-6">
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute -top-24 left-10 h-64 w-64 rounded-full bg-emerald-400/8 blur-3xl" />
                  <div className="absolute -top-24 right-10 h-72 w-72 rounded-full bg-orange-500/10 blur-3xl" />
                  <div className="absolute inset-0 bg-gradient-to-r from-white/[0.02] via-transparent to-white/[0.02]" />
                </div>

                <div className="relative flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Cpu className="h-5 w-5 text-white/70" />
                      <div className="text-lg font-semibold">Модель и текущие веса</div>
                    </div>
                    <div className="mt-1 text-sm text-white/60">
                      Источник: <span className="text-white/75">{api.baseUrl}/health/ml</span> • авто-обновление 30с
                    </div>
                    <div className="mt-2 text-[11px] text-white/45">{updatedLabel}</div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className={["h-2.5 w-2.5 rounded-full border", statusDot].join(" ")} />

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
                      {mlReloadBusy ? "Перезагружаем…" : "Перезагрузить веса"}
                    </Button>
                  </div>
                </div>

                {mlHealthErr ? (
                  <div className="relative mt-4 rounded-2xl border border-rose-300/20 bg-rose-500/10 p-4 text-sm text-rose-200">
                    {mlHealthErr}
                  </div>
                ) : null}

                <div className="relative mt-4 rounded-3xl border border-white/10 bg-black/20 p-5">
                  <div className="text-xs text-white/60">weights path</div>
                  <div className="mt-2 text-[13px] md:text-sm font-semibold text-white/85 break-words">{weightsPath || "—"}</div>

                  <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="rounded-3xl border border-white/10 bg-black/25 p-4">
                      <div className="text-[11px] text-white/55">sha</div>
                      <div className="mt-1 text-sm font-semibold text-white/85 tabular-nums inline-flex items-center gap-2">
                        <Hash className="h-4 w-4 text-white/50" /> {shortSha(sha)}
                      </div>
                    </div>

                    <div className="rounded-3xl border border-white/10 bg-black/25 p-4">
                      <div className="text-[11px] text-white/55">mtime</div>
                      <div className="mt-1 text-sm font-semibold text-white/85 tabular-nums inline-flex items-center gap-2">
                        <Clock className="h-4 w-4 text-white/50" /> {mtimeFromNs(mtimeNs)}
                      </div>
                    </div>

                    <div className="rounded-3xl border border-white/10 bg-black/25 p-4">
                      <div className="text-[11px] text-white/55">size</div>
                      <div className="mt-1 text-sm font-semibold text-white/85 tabular-nums inline-flex items-center gap-2">
                        <HardDrive className="h-4 w-4 text-white/50" /> {fmtBytes(size)}
                      </div>
                    </div>

                    <div className="rounded-3xl border border-white/10 bg-black/25 p-4">
                      <div className="text-[11px] text-white/55">device</div>
                      <div className="mt-1 text-sm font-semibold text-white/85 tabular-nums inline-flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-white/50" /> {device || "—"}
                        {typeof useSeg === "boolean" ? (
                          <span className="ml-2 text-[11px] font-semibold text-white/55">
                            seg: <span className="text-white/80">{useSeg ? "on" : "off"}</span>
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 text-xs text-white/55">
                    После обучения model.pt перезаписывается — тут видно новый mtime/sha/size. Если веса меняются — будет toast “✅ Веса модели обновились”.
                  </div>
                </div>
              </div>
            </div>

            {/* ===== CLASSES ===== */}
            <div
              id="sec-classes"
              className="rounded-[32px] border border-white/10 bg-ink-900/55 backdrop-blur-xl shadow-[0_30px_120px_rgba(0,0,0,.55)] overflow-hidden"
            >
              <div className="relative p-6">
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute -top-24 left-16 h-72 w-72 rounded-full bg-orange-500/10 blur-3xl" />
                  <div className="absolute -top-28 right-8 h-80 w-80 rounded-full bg-white/[0.04] blur-3xl" />
                  <div className="absolute inset-0 bg-gradient-to-r from-white/[0.02] via-transparent to-white/[0.02]" />
                </div>

                <div className="relative flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Tag className="h-5 w-5 text-white/70" />
                      <div className="text-lg font-semibold">Классы дефектов</div>
                    </div>
                    <div className="mt-1 text-sm text-white/60">Rename обновит: список классов, bbox на фото, решения оператора.</div>
                  </div>

                  <div className="flex items-center gap-2">
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
                  </div>
                </div>

                <div className="relative mt-4 rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                  <div className="px-4 py-3 bg-black/25 border-b border-white/10 flex items-center justify-between">
                    <div className="text-xs text-white/60">
                      Всего: <span className="text-white/80 tabular-nums">{classes.length}</span>
                    </div>
                    <div className="text-[11px] text-white/50">Нажми ✎ чтобы переименовать</div>
                  </div>

                  <div className="max-h-[360px] overflow-auto no-scrollbar p-2">
                    {classes.length ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {classes.map((c) => (
                          <div
                            key={c}
                            className="rounded-3xl border border-white/10 bg-white/[0.02] p-3 flex items-center justify-between gap-2"
                          >
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

                <div className="relative mt-4 rounded-3xl border border-orange-300/10 bg-orange-500/[0.05] p-4">
                  <div className="text-sm font-semibold text-white/85">Правило консистентности</div>
                  <div className="mt-1 text-xs text-white/60 leading-relaxed">
                    Rename — это не только UI:
                    <br />• фронт: bbox/decisions (готово)
                    <br />• бэк: session JSON + classes, чтобы после F5 всё сохранилось (следующий шаг).
                  </div>
                </div>
              </div>
            </div>

            {/* ===== DATASET ===== */}
            <div
              id="sec-dataset"
              className="rounded-[32px] border border-white/10 bg-ink-900/55 backdrop-blur-xl shadow-[0_30px_120px_rgba(0,0,0,.55)] overflow-hidden"
            >
              <div className="relative p-6">
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute -top-28 left-8 h-80 w-80 rounded-full bg-amber-300/10 blur-3xl" />
                  <div className="absolute -top-24 right-10 h-72 w-72 rounded-full bg-emerald-400/8 blur-3xl" />
                  <div className="absolute inset-0 bg-gradient-to-r from-white/[0.02] via-transparent to-white/[0.02]" />
                </div>

                <div className="relative flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Database className="h-5 w-5 text-white/70" />
                      <div className="text-lg font-semibold">Диагностика датасета</div>
                    </div>
                    <div className="mt-1 text-sm text-white/60">
                      Разбиение train/val как на бэке. Риски по val + распределение классов.
                    </div>
                  </div>

                  <div
                    className={[
                      "shrink-0 inline-flex items-center gap-2 rounded-2xl border px-3 py-2 text-xs font-semibold",
                      datasetDiag.ok ? "border-emerald-300/20 bg-emerald-500/10 text-emerald-200" : "border-orange-300/20 bg-orange-500/10 text-orange-200",
                    ].join(" ")}
                  >
                    {datasetDiag.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                    {datasetDiag.ok ? "ОК" : "Есть риски"}
                  </div>
                </div>

                <div className="relative mt-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* split card */}
                  <div className="rounded-[28px] border border-white/10 bg-black/20 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-white/85">Разбиение</div>
                      <div className="text-xs text-white/55 tabular-nums">
                        train {datasetDiag.images.train} • val {datasetDiag.images.val}
                      </div>
                    </div>

                    <div className="mt-4 space-y-3">
                      <div>
                        <div className="flex items-center justify-between text-xs text-white/55">
                          <span>Изображения в train</span>
                          <span className="tabular-nums">{datasetDiag.images.train}</span>
                        </div>
                        <div className="mt-2">
                          <ProgressBar
                            value={
                              datasetDiag.images.train + datasetDiag.images.val > 0
                                ? Math.round((datasetDiag.images.train / (datasetDiag.images.train + datasetDiag.images.val)) * 100)
                                : 0
                            }
                          />
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between text-xs text-white/55">
                          <span>Изображения в val</span>
                          <span className="tabular-nums">{datasetDiag.images.val}</span>
                        </div>
                        <div className="mt-2">
                          <ProgressBar
                            value={
                              datasetDiag.images.train + datasetDiag.images.val > 0
                                ? Math.round((datasetDiag.images.val / (datasetDiag.images.train + datasetDiag.images.val)) * 100)
                                : 0
                            }
                          />
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 text-xs text-white/55 leading-relaxed">
                      {datasetDiag.images.val === 0 ? (
                        <span className="text-orange-200">⚠️ В val нет изображений — обучение может упасть.</span>
                      ) : datasetDiag.labeledPhotos.val === 0 ? (
                        <span className="text-orange-200">⚠️ В val нет bbox — метрики валидации будут “пустые”.</span>
                      ) : (
                        <span className="text-emerald-200">✅ Split выглядит корректно.</span>
                      )}
                    </div>
                  </div>

                  {/* classes card */}
                  <div className="rounded-[28px] border border-white/10 bg-black/20 p-5">
                    <div className="flex items-center gap-2">
                      <Layers className="h-5 w-5 text-white/70" />
                      <div className="text-sm font-semibold text-white/85">Классы в train vs val (по bbox)</div>
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
                      <div className="mt-3 rounded-2xl border border-emerald-300/20 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                        Всё выглядит нормально: и val заполнен, и классы распределены.
                      </div>
                    )}

                    <div className="mt-4 max-h-[320px] overflow-auto no-scrollbar rounded-2xl border border-white/10">
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
                  <div className="relative mt-4 rounded-3xl border border-white/10 bg-black/20 p-5 text-sm text-white/60">
                    Пока нет фото. Перейди на “Загрузка” и добавь изображения.
                    <div className="mt-3">
                      <Button variant="primary" onClick={() => nav("/upload")}>
                        На загрузку
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {/* bottom CTA */}
            <div className="rounded-3xl border border-white/10 bg-ink-900/50 backdrop-blur-xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-white/70">
                  Быстрые переходы: <span className="text-white/85 font-semibold">разметка</span> и{" "}
                  <span className="text-white/85 font-semibold">итоги</span>.
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => nav("/upload")}>
                    Загрузка
                  </Button>
                  <Button variant="primary" onClick={() => nav("/viewer")}>
                    Разметка
                  </Button>
                </div>
              </div>
            </div>
          </div>
          {/* /RIGHT */}
        </div>
      </div>
    </div>
  );
}
