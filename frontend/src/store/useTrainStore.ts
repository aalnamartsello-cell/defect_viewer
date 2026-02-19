// frontend/src/store/useTrainStore.ts
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { api } from "../api/api";
import { toast } from "../components/ui/ToastCenter";

export type TrainStatus = "idle" | "queued" | "running" | "done" | "error";

type TrainStoreState = {
  jobId: string | null;
  status: TrainStatus;
  message: string;
  progress: number; // 0..100
  epoch: number;
  epochsTotal: number;
  batch: number;
  batchesTotal: number;
  updatedAt: number | null;
  startedAt: number | null;

  patch: (p: Partial<Omit<TrainStoreState, "patch" | "reset">>) => void;
  reset: () => void;
};

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function normalizeTrainStatus(raw: any): { status: TrainStatus; raw: string } {
  const s = String(raw ?? "").trim().toLowerCase();

  if (s === "queued") return { status: "queued", raw: s };
  if (s === "running") return { status: "running", raw: s };
  if (s === "done") return { status: "done", raw: s };
  if (s === "error") return { status: "error", raw: s };

  // backwards/edge statuses from backend
  if (
    s === "lost" ||
    s === "stale" ||
    s === "failed" ||
    s === "aborted" ||
    s === "canceled" ||
    s === "cancelled"
  ) {
    return { status: "error", raw: s };
  }

  // empty / missing -> treat as running (keep old behavior)
  if (!s) return { status: "running", raw: s };

  // unknown non-empty -> error (fail-safe)
  return { status: "error", raw: s };
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
    const m = text.match(/батч\s*(\d+)\s*\/\s*(\d+)/i) || text.match(/batch\s*(\d+)\s*\/\s*(\d+)/i);
    if (m) {
      if (!batch) batch = Number(m[1]) || 0;
      if (!total) total = Number(m[2]) || 0;
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
  if (Number.isFinite(raw) && raw > 0 && raw <= 1.000001) return clamp(raw, 0, 1);

  const { epoch, total } = parseEpochInfo(st);
  const { batch, total: batchTotal } = parseBatchInfo(st);

  if (total > 0) {
    const epUi = epoch <= 0 ? 0 : epoch;
    const ep0 = epUi > 0 ? epUi - 1 : 0;
    const frac = batchTotal > 0 ? clamp(batch / batchTotal, 0, 1) : 0;
    const p = (ep0 + frac) / total;
    return clamp(Math.min(0.99, p), 0, 0.99);
  }

  return 0;
}

let pollTimer: number | null = null;
let fallbackTimer: number | null = null;
let inFlight = false;

function stopTimers() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  if (fallbackTimer) {
    window.clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  inFlight = false;
}

export const useTrainStore = create<TrainStoreState>()(
  persist(
    (set) => ({
      jobId: null,
      status: "idle",
      message: "",
      progress: 0,
      epoch: 0,
      epochsTotal: 0,
      batch: 0,
      batchesTotal: 0,
      updatedAt: null,
      startedAt: null,

      patch: (p) =>
        set((s) => ({
          ...s,
          ...p,
          updatedAt: Date.now(),
        })),

      reset: () => {
        stopTimers();
        set({
          jobId: null,
          status: "idle",
          message: "",
          progress: 0,
          epoch: 0,
          epochsTotal: 0,
          batch: 0,
          batchesTotal: 0,
          updatedAt: Date.now(),
          startedAt: null,
        });
      },
    }),
    {
      name: "defect_viewer_train",
      version: 1,
      storage: createJSONStorage(() => sessionStorage),
    }
  )
);

/**
 * Фоновый монитор прямо в store:
 * - стартует, когда есть jobId и status queued/running
 * - не зависит от страницы (AdminPage можно закрыть/уйти)
 */
function ensureMonitorRunning() {
  const st = useTrainStore.getState();
  const shouldRun = Boolean(st.jobId) && (st.status === "queued" || st.status === "running");

  if (!shouldRun) {
    stopTimers();
    return;
  }

  if (!pollTimer) {
    pollTimer = window.setInterval(async () => {
      const cur = useTrainStore.getState();
      if (!cur.jobId) return;
      if (!(cur.status === "queued" || cur.status === "running")) return;
      if (inFlight) return;

      inFlight = true;
      try {
        const prevStatus = cur.status;
        const jobId = cur.jobId;

        const r: any = await api.trainStatus(jobId);

        const norm = normalizeTrainStatus(r?.status);
        const nextStatus = norm.status;

        let msg = String(r?.message ?? "").trim();
        if (!msg && nextStatus === "error" && norm.raw && !["queued", "running", "done", "error"].includes(norm.raw)) {
          msg = `Неизвестный статус обучения: "${norm.raw}"`;
        }

        const { epoch, total } = parseEpochInfo(r);
        const { batch, total: bt } = parseBatchInfo(r);
        const prog01 = computeProgress01(r);

        let nextProgress = cur.progress;

        if (nextStatus === "queued") {
          nextProgress = Math.max(nextProgress, 22);
        } else if (nextStatus === "running") {
          if (prog01 > 0) {
            nextProgress = Math.max(nextProgress, Math.round(clamp(prog01 * 100, 0, 99)));
            // если есть реальный прогресс — можно приглушить fallback
            if (fallbackTimer) {
              window.clearInterval(fallbackTimer);
              fallbackTimer = null;
            }
          } else {
            nextProgress = clamp(nextProgress + 1.1, 35, 92);
          }
        } else if (nextStatus === "done") {
          nextProgress = 100;
        } else if (nextStatus === "error") {
          nextProgress = Math.max(nextProgress, 70);
        }

        useTrainStore.getState().patch({
          status: nextStatus,
          message: msg || cur.message || "",
          progress: clamp(nextProgress, 0, 100),
          epoch,
          epochsTotal: total,
          batch,
          batchesTotal: bt,
        });

        if (prevStatus !== nextStatus) {
          if (nextStatus === "done") toast.success("✅ Обучение завершено");
          if (nextStatus === "error") toast.error("❌ Ошибка обучения");
        }

        if (nextStatus === "done" || nextStatus === "error") {
          stopTimers();
        }
      } catch {
        // не рвём UI: просто оставляем последнее состояние
      } finally {
        inFlight = false;
      }
    }, 800);
  }

  if (!fallbackTimer) {
    fallbackTimer = window.setInterval(() => {
      const cur = useTrainStore.getState();
      if (!cur.jobId) return;
      if (!(cur.status === "queued" || cur.status === "running")) return;

      const cap = cur.status === "queued" ? 35 : 92;
      if (cur.progress >= cap) return;

      const step = cur.progress < 50 ? 2.2 : cur.progress < 80 ? 1.1 : 0.55;
      useTrainStore.getState().patch({ progress: clamp(cur.progress + step, 0, cap) });
    }, 220);
  }
}

// подписка один раз на изменения store → запуск/остановка монитора
let monitorInit = false;
function initMonitorOnce() {
  if (monitorInit) return;
  monitorInit = true;

  useTrainStore.subscribe(
    (s) => ({ jobId: s.jobId, status: s.status }),
    () => ensureMonitorRunning()
  );

  // если страница перезагрузилась и в sessionStorage уже есть jobId/status:
  ensureMonitorRunning();
}
initMonitorOnce();
