// src/pages/GalleryPage.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/ui/Button";
import { toast } from "../components/ui/ToastCenter";
import { useAppStore } from "../store/useAppStore";
import { api } from "../api/api";

function withNonce(src: string, nonce: number) {
  const s = String(src ?? "");
  if (!s) return s;
  const sep = s.includes("?") ? "&" : "?";
  return `${s}${sep}r=${encodeURIComponent(String(nonce))}`;
}

export default function GalleryPage() {
  const nav = useNavigate();
  const { photos, setPhotos, setActiveIndex, activeIndex, decisionByPhoto, setDecision, sessionId } = useAppStore();

  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(1);
  const inflightRef = useRef(false);

  const items = photos ?? [];

  const stats = useMemo(() => {
    const total = items.length;
    const decided = Object.values(decisionByPhoto ?? {}).filter(Boolean).length;
    return { total, decided };
  }, [items, decisionByPhoto]);

  const statusUi = (decision: any) => {
    if (!decision) return { text: "не решено", dot: "bg-white/35", icon: "⏳", tone: "text-white/70" };
    if (decision.type === "ok") return { text: "дефектов нет", dot: "bg-emerald-400/80", icon: "✅", tone: "text-emerald-200" };
    return { text: "есть дефект", dot: "bg-orange-300/90", icon: "⚠️", tone: "text-orange-200" };
  };

  const refreshFromBackend = async (opts?: { silent?: boolean }) => {
    if (!sessionId) return;
    if (inflightRef.current) return;

    inflightRef.current = true;
    if (!opts?.silent) setLoading(true);

    try {
      const list = await api.listPhotos(sessionId);

      // 1) обновляем фото (src = url бэка, joinUrl внутри api)
      setPhotos(api.mapListToPhotoItems(list));

      // 2) подтянем решения из бэка, но НЕ затираем локальные, если decision=null
      for (const it of list) {
        const d = api.decisionFromBackend(it as any);
        if (d) setDecision(it.id, d);
      }

      // ✅ cache-bust, чтобы точно увидеть “всё новое”
      setNonce((n) => n + 1);
    } catch (e: any) {
      if (!opts?.silent) toast.error(e?.message ?? "Не удалось получить список фото из бэка");
    } finally {
      inflightRef.current = false;
      if (!opts?.silent) setLoading(false);
    }
  };

  // Всегда пробуем подтянуть актуальный список при входе на страницу
  useEffect(() => {
    if (!sessionId) return;
    void refreshFromBackend({ silent: items.length > 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Авто-обновление при возвращении на вкладку/в окно
  useEffect(() => {
    if (!sessionId) return;

    const onFocus = () => void refreshFromBackend({ silent: true });
    const onVis = () => {
      if (document.visibilityState === "visible") void refreshFromBackend({ silent: true });
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!items.length) {
      toast.info("Сначала загрузите фотографии.");
      nav("/upload", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const openViewer = (idx: number) => {
    setActiveIndex(idx);
    nav("/viewer");
  };

  if (!items.length) {
    return (
      <div className="h-full w-full p-6">
        <div className="mx-auto max-w-5xl fx-card p-6 text-white/70">Переходим на страницу загрузки…</div>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <div className="mx-auto max-w-[1200px] px-5 pt-10 pb-10">
        {/* HEADER CARD */}
        <div className="fx-card fx-border-run p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-3xl font-semibold">Галерея</div>
              <div className="mt-2 text-xs text-white/55 tabular-nums">
                Загружено: {stats.total} • Решено: {stats.decided}{" "}
                {loading ? (
                  <span className="text-orange-200 inline-flex items-center gap-2">
                    <span className="inline-block h-3 w-3 rounded-full border border-white/20 border-t-orange-200 animate-spin" />
                    обновление…
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                leftIcon={<span className="text-base">⟳</span>}
                onClick={() => void refreshFromBackend()}
                disabled={loading}
                title="Обновить список с бэка"
              >
                Обновить
              </Button>

              <Button variant="primary" leftIcon={<span>👁️</span>} onClick={() => nav("/viewer")}>
                Открыть просмотр
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {items.map((p, idx) => {
            const selected = idx === (activeIndex ?? 0);
            const decision = (decisionByPhoto ?? {})[p.id];
            const st = statusUi(decision);

            return (
              <div
                key={p.id}
                className={[
                  "group fx-card fx-border-run fx-soft-hover overflow-hidden",
                  selected ? "border-orange-300/45 ring-2 ring-orange-300/20" : "border-white/10",
                ].join(" ")}
              >
                <button
                  className="w-full text-left"
                  onClick={() => setActiveIndex(idx)}
                  onDoubleClick={() => openViewer(idx)}
                  type="button"
                  title="Открыть"
                >
                  <div className="p-4">
                    <div className="rounded-2xl overflow-hidden border border-white/10 bg-black/30">
                      <img
                        src={withNonce(p.src, nonce)}
                        alt={p.name}
                        className="w-full h-[210px] object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03]"
                        loading="lazy"
                        draggable={false}
                      />
                    </div>

                    <div className="mt-3">
                      <div className="text-sm font-semibold truncate">{p.name}</div>

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span
                          className={[
                            "inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px]",
                            st.tone,
                          ].join(" ")}
                        >
                          <span className={["h-2 w-2 rounded-full", st.dot].join(" ")} />
                          <span className="tabular-nums">{st.icon}</span>
                          <span className="text-white/80">{st.text}</span>
                        </span>

                        <span className="text-[11px] text-white/55 tabular-nums">bbox: {p.bboxes?.length ?? 0}</span>
                      </div>
                    </div>
                  </div>
                </button>

                <div className="px-4 pb-4">
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => openViewer(idx)} title="Открыть это фото в просмотре">
                      Открыть →
                    </Button>

                    <div className="ml-auto text-xs text-white/55 tabular-nums">
                      {selected ? <span className="text-orange-200">выбрано</span> : <span> </span>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-8 flex justify-center">
          <Button variant="secondary" onClick={() => nav("/viewer")}>
            Перейти к просмотру →
          </Button>
        </div>
      </div>
    </div>
  );
}
