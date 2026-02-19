// src/api/api.ts
import type { PhotoItem, OperatorDecision, BBox } from "../types";
import type { DefectClass } from "../constants/defects";
import { DEFECT_CLASSES } from "../constants/defects";

/**
 * Backend contracts
 */
export type BackendPhotoListItem = {
  id: string;
  filename: string;
  url: string;
  decision: "defect" | "ok" | null;
  meta:
    | {
        class?: string;
        place?: string;
        comment?: string;
        category?: string;
        recommendedFix?: string;
      }
    | null;
  bboxes_count: number;
};

export type BackendPhotoDetail = {
  id: string;
  filename: string;
  url: string;
  decision: "defect" | "ok" | null;
  meta:
    | {
        class?: string;
        place?: string;
        comment?: string;
        category?: string;
        recommendedFix?: string;
      }
    | null;
  bboxes: Array<{
    id: string;
    class: string; // ⚠️ с бэка может прийти нестрогий класс
    confidence: number;
    bbox: [number, number, number, number];
    source?: string;
    polygon?: Array<[number, number]> | Array<number[]>; // optional
  }>;
};

export type BackendBBox = {
  id: string;
  class: string;
  confidence: number;
  bbox: [number, number, number, number];
  source?: string;
  polygon?: Array<[number, number]> | Array<number[]>;
};

// ✅ теперь createSession может вернуть classes
export type CreateSessionResult = { session_id: string; classes?: string[] };

export type UploadPhotosResultItem = { id: string; filename: string; url: string };

// ---- Train API ----
export type TrainStartResult = { job_id: string; status: string; message: string };

export type TrainStatusResult = {
  job_id: string;
  status: "queued" | "running" | "done" | "error";
  message: string;
  model_path?: string | null;
  dataset_dir?: string | null;

  epoch?: number | string; // ✅ бэк может прислать "12/30"
  epochs_total?: number | string;
  progress?: number;

  dataset_total?: number;
  model_sha256_before?: string | null;
  model_sha256_after?: string | null;
  model_version_path?: string | null;
};

// ---- Infer API ----
export type InferResponse =
  | BackendBBox[]
  | {
      ok?: boolean;
      photo_id?: string;
      bboxes: BackendBBox[];
      took_ms?: number;
      device?: string;
      num_det?: number;
      used_cpu_fallback?: boolean;
    };

// ---- ML Health ----
export type MlHealthResult = {
  // mm.describe() / health/ml может быть любым — делаем максимально гибко
  weights?: string;
  weights_path?: string;
  weights_key?: string;
  model_path?: string;
  device?: string;
  use_seg?: boolean;

  // иногда эти поля есть напрямую
  mtime_ns?: number | string;
  size?: number | string;
  sha256?: string;

  // всё остальное
  [k: string]: any;
};

export type PredictResult = { ok: boolean; bboxes?: any[] };
export type TrainResult = { ok: boolean; jobId?: string };

export type PredictPayload = { photoIds: string[] };
export type TrainPayload = {
  photos: PhotoItem[];
  decisions: Record<string, OperatorDecision | undefined>;
};

// ✅ VITE_API_BASE:
// - http://localhost:8000
// - http://localhost:8000/api
const RAW_BASE = (import.meta.env.VITE_API_BASE ?? "http://localhost:8000").replace(/\/+$/, "");
const API_PREFIX = RAW_BASE.toLowerCase().endsWith("/api") ? "" : "/api";

/**
 * ✅ Главный фикс:
 * - если бэк вернул абсолютный URL -> используем как есть
 * - если вернул /api/... -> RAW_BASE + /api/...
 * - если вернул /sessions/... (или /train/...) -> добавляем API_PREFIX
 */
function joinUrl(pathOrUrl: string) {
  if (!pathOrUrl) return pathOrUrl;

  // absolute
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;

  // normalize to leading slash
  const p = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;

  // already includes /api
  if (p.startsWith("/api/")) return `${RAW_BASE}${p}`;

  // backend sometimes returns "/sessions/..." instead of "/api/sessions/..."
  if (p.startsWith("/sessions/") || p.startsWith("/train/") || p.startsWith("/models/") || p.startsWith("/uploads/")) {
    return `${RAW_BASE}${API_PREFIX}${p}`;
  }

  // default: RAW_BASE + path
  return `${RAW_BASE}${p}`;
}

async function parseErrorMessage(res: Response, fallbackStatus: number) {
  let msg = `Ошибка запроса: ${fallbackStatus}`;
  try {
    const j = await res.json();
    if (typeof (j as any)?.detail === "string") msg = (j as any).detail;
    else if (typeof (j as any)?.message === "string") msg = (j as any).message;
  } catch {
    // ignore
  }
  return msg;
}

async function httpJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${RAW_BASE}${API_PREFIX}${path}`;

  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, res.status));
  }

  if (res.status === 204) return undefined as any;

  const ct = res.headers.get("content-type") || "";
  if (!ct.toLowerCase().includes("application/json")) {
    const txt = await res.text().catch(() => "");
    try {
      return JSON.parse(txt) as T;
    } catch {
      // @ts-expect-error - best effort
      return txt as T;
    }
  }

  return (await res.json()) as T;
}

async function httpBlob(path: string, init?: RequestInit): Promise<Blob> {
  const url = `${RAW_BASE}${API_PREFIX}${path}`;

  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, res.status));
  }

  return await res.blob();
}

// ✅ теперь классы динамические: принимаем любой непустой cls
function normalizeCls(cls: string | undefined | null): DefectClass {
  const s = String(cls ?? "").trim();
  if (s) return s;

  const fallback = (DEFECT_CLASSES[DEFECT_CLASSES.length - 1] ?? DEFECT_CLASSES[0]) as unknown as string;
  return fallback;
}

function toFrontendBBoxes(bxs: BackendBBox[]): BBox[] {
  return (bxs ?? []).map((b) => {
    const [x, y, w, h] = b.bbox;
    return {
      id: b.id,
      x,
      y,
      w,
      h,
      cls: normalizeCls(b.class),
      confidence: b.confidence,
    };
  });
}

function toOperatorDecisionFromBackend(p: BackendPhotoDetail | BackendPhotoListItem): OperatorDecision | undefined {
  if (!p.decision) return undefined;
  if (p.decision === "ok") return { type: "ok" };

  const meta: any = (p as any).meta ?? {};
  const place = meta?.place ?? undefined;
  const comment = meta?.comment ?? undefined;
  const category = meta?.category ?? undefined;
  const recommendedFix = meta?.recommendedFix ?? undefined;

  const bboxes: any[] = (p as any).bboxes ?? [];
  const defects = (bboxes ?? []).map((b: BackendBBox) => ({
    bboxId: b.id,
    cls: normalizeCls(b.class),
    confidence: b.confidence,
  }));

  return { type: "defect", defects, place, comment, category, recommendedFix } as any;
}

function normalizeUploadResponse(payload: any): UploadPhotosResultItem[] {
  if (Array.isArray(payload)) return payload as UploadPhotosResultItem[];
  if (Array.isArray(payload?.items)) return payload.items as UploadPhotosResultItem[];
  if (Array.isArray(payload?.photos)) return payload.photos as UploadPhotosResultItem[];
  if (Array.isArray(payload?.data)) return payload.data as UploadPhotosResultItem[];
  throw new Error("Бэк вернул неожиданный формат ответа на upload (ожидался массив фото)");
}

function normalizeInferResponse(payload: InferResponse): BackendBBox[] {
  if (Array.isArray(payload)) return payload as BackendBBox[];
  if (payload && typeof payload === "object" && Array.isArray((payload as any).bboxes))
    return (payload as any).bboxes as BackendBBox[];
  return [];
}

export const api = {
  baseUrl: `${RAW_BASE}${API_PREFIX}`,

  // --- sessions
  async createSession(): Promise<CreateSessionResult> {
    return await httpJson<CreateSessionResult>("/sessions", { method: "POST" });
  },

  async resetSession(sessionId: string): Promise<{ ok: true }> {
    // ⚠️ если на бэке нет reset — этот метод просто не вызывать
    return await httpJson<{ ok: true }>(`/sessions/${encodeURIComponent(sessionId)}/reset`, { method: "POST" });
  },

  // ✅ classes (динамические)
  async getSessionClasses(sessionId: string): Promise<{ classes: string[] }> {
    return await httpJson<{ classes: string[] }>(`/sessions/${encodeURIComponent(sessionId)}/classes`, { method: "GET" });
  },

  async addSessionClass(sessionId: string, name: string): Promise<{ ok: true; classes: string[] }> {
    return await httpJson<{ ok: true; classes: string[] }>(`/sessions/${encodeURIComponent(sessionId)}/classes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  },

  /**
   * ✅ Rename класса (переименование).
   * ВАЖНО: эндпоинт на бэке нужно будет добавить.
   * Предлагаемый контракт:
   * POST /sessions/{sid}/classes/rename { from: string, to: string }
   * -> { ok: true, classes: string[] }
   */
  async renameSessionClass(
    sessionId: string,
    from: string,
    to: string
  ): Promise<{ ok: true; classes: string[] }> {
    return await httpJson<{ ok: true; classes: string[] }>(`/sessions/${encodeURIComponent(sessionId)}/classes/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
  },

  // --- photos
  async uploadPhotos(sessionId: string, files: File[]): Promise<UploadPhotosResultItem[]> {
    if (!files.length) throw new Error("Нет файлов для загрузки");

    const fd = new FormData();
    for (const f of files) fd.append("files", f);

    const raw = await httpJson<any>(`/sessions/${encodeURIComponent(sessionId)}/photos/upload`, {
      method: "POST",
      body: fd,
    });

    return normalizeUploadResponse(raw);
  },

  async listPhotos(sessionId: string): Promise<BackendPhotoListItem[]> {
    return await httpJson<BackendPhotoListItem[]>(`/sessions/${encodeURIComponent(sessionId)}/photos`);
  },

  async getPhoto(sessionId: string, photoId: string): Promise<BackendPhotoDetail> {
    return await httpJson<BackendPhotoDetail>(
      `/sessions/${encodeURIComponent(sessionId)}/photos/${encodeURIComponent(photoId)}`
    );
  },

  // --- infer
  async infer(sessionId: string, photoId: string): Promise<InferResponse> {
    return await httpJson<InferResponse>(`/sessions/${encodeURIComponent(sessionId)}/infer/${encodeURIComponent(photoId)}`, {
      method: "POST",
    });
  },

  // alias, чтобы не ломать возможный старый код
  async inferMock(sessionId: string, photoId: string): Promise<BackendBBox[]> {
    const raw = await api.infer(sessionId, photoId);
    return normalizeInferResponse(raw);
  },

  // --- labels
  async saveLabels(args: {
    sessionId: string;
    photoId: string;
    decision: "defect" | "ok";
    meta: {
      class?: string;
      place?: string;
      comment?: string;
      category?: string;
      recommendedFix?: string;
    };
    bboxes: Array<{ id?: string; class: DefectClass; confidence?: number; bbox: [number, number, number, number] }>;
  }): Promise<{ ok: true }> {
    return await httpJson<{ ok: true }>(
      `/sessions/${encodeURIComponent(args.sessionId)}/labels/${encodeURIComponent(args.photoId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: args.decision,
          meta: args.meta ?? {},
          bboxes: args.bboxes ?? [],
        }),
      }
    );
  },

  // --- report (docx)
  async downloadReportDocx(sessionId: string): Promise<Blob> {
    return await httpBlob(`/sessions/${encodeURIComponent(sessionId)}/report.docx`, { method: "GET" });
  },

  // --- TRAIN
  async trainSession(sessionId: string): Promise<TrainStartResult> {
    return await httpJson<TrainStartResult>(`/sessions/${encodeURIComponent(sessionId)}/train`, { method: "POST" });
  },

  async trainStatus(jobId: string): Promise<TrainStatusResult> {
    return await httpJson<TrainStatusResult>(`/train/${encodeURIComponent(jobId)}/status`, { method: "GET" });
  },

  // ✅ ML HEALTH (для ViewerPage/Админки: “какие веса сейчас используются”)
  async healthML(opts?: { load?: boolean }): Promise<MlHealthResult> {
    const q = opts?.load ? "?load=true" : "";
    return await httpJson<MlHealthResult>(`/health/ml${q}`, { method: "GET" });
  },

  // --- compatibility stubs
  async predict(_payload: any): Promise<PredictResult> {
    return { ok: true, bboxes: [] };
  },

  async train(_payload: any): Promise<TrainResult> {
    return { ok: true, jobId: `train_${Date.now()}` };
  },

  // --- helpers
  mapUploadToPhotoItems(items: UploadPhotosResultItem[]): PhotoItem[] {
    return (Array.isArray(items) ? items : []).map((it) => ({
      id: it.id,
      name: it.filename,
      src: joinUrl(it.url),
      bboxes: [],
      srcIsObjectUrl: false,
    }));
  },

  mapListToPhotoItems(items: BackendPhotoListItem[]): PhotoItem[] {
    return (items ?? []).map((it) => ({
      id: it.id,
      name: it.filename,
      src: joinUrl(it.url),
      bboxes: [],
      srcIsObjectUrl: false,
    }));
  },

  applyBackendDetailToPhotoItem(existing: PhotoItem, detail: BackendPhotoDetail): PhotoItem {
    return {
      ...existing,
      name: detail.filename,
      src: joinUrl(detail.url),
      bboxes: toFrontendBBoxes((detail.bboxes ?? []) as any),
      srcIsObjectUrl: false,
    };
  },

  decisionFromBackend: toOperatorDecisionFromBackend,

  bboxesFromBackend(payload: InferResponse | BackendBBox[]): BBox[] {
    const bxs = normalizeInferResponse(payload as any);
    return toFrontendBBoxes(bxs);
  },
};
