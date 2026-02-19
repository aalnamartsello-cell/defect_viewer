// src/store/useAppStore.ts
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { PhotoItem, BBox, OperatorDecision } from "../types";

type State = {
  sessionId?: string;
  photos: PhotoItem[];
  activeIndex: number;
  decisionByPhoto: Record<string, OperatorDecision | undefined>;

  setSessionId: (id?: string) => void;
  setPhotos: (photos: PhotoItem[]) => void;
  resetAll: () => void;

  /** ✅ Полная очистка sessionStorage/localStorage + сброс стора */
  hardResetStorage: () => void;

  setActiveIndex: (i: number) => void;
  updatePhotoBBoxes: (photoId: string, updater: (prev: BBox[]) => BBox[]) => void;
  setDecision: (photoId: string, decision: OperatorDecision | undefined) => void;
};

function safeArray<T>(a: unknown, fallback: T[] = []) {
  return Array.isArray(a) ? (a as T[]) : fallback;
}
function safeObj<T extends object>(o: unknown, fallback: T) {
  return o && typeof o === "object" ? (o as T) : fallback;
}
function safeNumber(n: unknown, fallback = 0) {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}
function safeString(s: unknown, fallback = "") {
  return typeof s === "string" ? s : fallback;
}

function revokeObjectUrls(photos: PhotoItem[]) {
  for (const p of photos ?? []) {
    if (p?.srcIsObjectUrl && typeof p.src === "string") {
      try {
        URL.revokeObjectURL(p.src);
      } catch {
        // ignore
      }
    }
  }
}

export const useAppStore = create<State>()(
  persist(
    (set, get) => ({
      sessionId: undefined,
      photos: [],
      activeIndex: 0,
      decisionByPhoto: {},

      setSessionId: (id) => set({ sessionId: id || undefined }),

      setPhotos: (photos) => {
        // освобождаем предыдущие objectURL, чтобы не текла память
        const prev = safeArray<PhotoItem>(get().photos, []);
        revokeObjectUrls(prev);

        const next = safeArray<PhotoItem>(photos, []);
        set({
          photos: next,
          activeIndex: next.length ? 0 : 0,
          decisionByPhoto: safeObj<Record<string, OperatorDecision | undefined>>(get().decisionByPhoto, {}),
        });
      },

      resetAll: () => {
        const prev = safeArray<PhotoItem>(get().photos, []);
        revokeObjectUrls(prev);
        set({ sessionId: undefined, photos: [], activeIndex: 0, decisionByPhoto: {} });
      },

      hardResetStorage: () => {
        // 1) сброс стора в памяти
        const prev = safeArray<PhotoItem>(get().photos, []);
        revokeObjectUrls(prev);
        set({ sessionId: undefined, photos: [], activeIndex: 0, decisionByPhoto: {} });

        // 2) очистка хранилищ
        try {
          sessionStorage.clear();
        } catch {
          // ignore
        }
        try {
          localStorage.clear();
        } catch {
          // ignore
        }
      },

      setActiveIndex: (i) => {
        const photos = safeArray<PhotoItem>(get().photos, []);
        const idx = Math.max(0, Math.min(photos.length - 1, safeNumber(i, 0)));
        set({ activeIndex: idx });
      },

      updatePhotoBBoxes: (photoId, updater) => {
        const photos = safeArray<PhotoItem>(get().photos, []);
        const next = photos.map((p) => {
          if (p.id !== photoId) return p;
          const prevB = safeArray<BBox>((p as any).bboxes, []);
          return { ...p, bboxes: updater(prevB) };
        });
        set({ photos: next });
      },

      setDecision: (photoId, decision) => {
        const curr = safeObj<Record<string, OperatorDecision | undefined>>(get().decisionByPhoto, {});
        set({ decisionByPhoto: { ...curr, [photoId]: decision } });
      },
    }),
    {
      name: "defect-ui-stage1",
      version: 4,
      storage: createJSONStorage(() => sessionStorage),

      // ✅ КЛЮЧЕВОЕ: НЕ сохраняем photos в sessionStorage
      partialize: (s) => ({
        sessionId: s.sessionId,
        activeIndex: s.activeIndex,
        decisionByPhoto: s.decisionByPhoto,
      }),

      migrate: (persisted: any) => {
        const decisionByPhoto = safeObj<Record<string, OperatorDecision | undefined>>(persisted?.decisionByPhoto, {});
        const activeIndex = safeNumber(persisted?.activeIndex, 0);

        const sessionIdRaw = persisted?.sessionId;
        const sessionId = sessionIdRaw ? safeString(sessionIdRaw, "") : "";

        // ✅ photos после перезагрузки всегда будут пустыми (их нужно подтянуть с бэка по sessionId)
        return {
          sessionId: sessionId || undefined,
          activeIndex: Math.max(0, activeIndex),
          decisionByPhoto,
          photos: [],
        };
      },
    }
  )
);
