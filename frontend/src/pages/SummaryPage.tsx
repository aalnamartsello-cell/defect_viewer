// src/pages/SummaryPage.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/ui/Button";
import ProgressBar from "../components/ui/ProgressBar";
import { toast } from "../components/ui/ToastCenter";
import { useAppStore } from "../store/useAppStore";
import { api } from "../api/api";
import type { OperatorDecision } from "../types";
import type { DefectClass } from "../constants/defects";

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

type FilterMode = "all" | "defect" | "ok" | "unresolved";

export default function SummaryPage() {
  const nav = useNavigate();
  const { photos, decisionByPhoto, resetAll, sessionId } = useAppStore();

  const items = photos ?? [];
  const decisions = (decisionByPhoto ?? {}) as Record<string, OperatorDecision | undefined>;

  const [isWordBusy, setIsWordBusy] = useState(false);

  // UX: фильтр списка
  const [filter, setFilter] = useState<FilterMode>("all");

  useEffect(() => {
    if (!items.length) {
      toast.info("Сначала загрузите фотографии.");
      nav("/upload", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const summary = useMemo(() => {
    let ok = 0;
    let defect = 0;
    let unresolved = 0;

    const byClass: Record<string, number> = {};

    for (const p of items) {
      const d = decisions[p.id];
      if (!d) {
        unresolved++;
        continue;
      }
      if (d.type === "ok") ok++;
      else defect++;

      if (d.type === "defect") {
        for (const b of p.bboxes ?? []) {
          byClass[b.cls] = (byClass[b.cls] ?? 0) + 1;
        }
      }
    }

    const total = items.length;
    return { total, ok, defect, unresolved, byClass };
  }, [items, decisions]);

  const chartRows = useMemo(() => {
    const entries = Object.entries(summary.byClass);
    entries.sort((a, b) => b[1] - a[1]);
    return entries;
  }, [summary.byClass]);

  const maxVal = chartRows.length ? Math.max(...chartRows.map((x) => x[1])) : 1;

  const filteredItems = useMemo(() => {
    if (filter === "all") return items;

    return items.filter((p) => {
      const d = decisions[p.id];
      if (filter === "unresolved") return !d;
      if (filter === "ok") return d?.type === "ok";
      if (filter === "defect") return d?.type === "defect";
      return true;
    });
  }, [items, decisions, filter]);

  const filterPill = (id: FilterMode, label: string, count: number) => {
    const active = filter === id;
    return (
      <button
        type="button"
        onClick={() => setFilter(id)}
        className={[
          "px-3 py-1.5 rounded-full border text-[11px] transition",
          "bg-black/20",
          active ? "border-orange-300/40 text-orange-200" : "border-white/10 text-white/70 hover:bg-white/[0.05]",
        ].join(" ")}
        title={label}
      >
        <span className="tabular-nums">{count}</span>
        <span className="mx-2 text-white/25">•</span>
        <span>{label}</span>
      </button>
    );
  };

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

  async function onGenerateWord() {
    if (isWordBusy) return;

    if (!sessionId) {
      toast.error("Нет sessionId. Вернись на Загрузку и загрузи фото заново.");
      return;
    }

    setIsWordBusy(true);
    try {
      await syncAllToBackend();

      toast.info("Запрашиваем Word с бэка…");
      const blob = await api.downloadReportDocx(sessionId);

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const fileName = `Дефектная_ведомость_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
        now.getHours()
      )}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.docx`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();

      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

      toast.success("Word сформирован");
    } catch (e: any) {
      toast.error(e?.message ?? "Ошибка формирования Word");
    } finally {
      setIsWordBusy(false);
    }
  }

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
        {/* HEADER */}
        <div className="fx-card fx-border-run p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              {/* ✅ без градиента */}
              <div className="text-3xl font-semibold text-white">Итог</div>
              <div className="mt-1 text-sm text-white/65">Сводка решений оператора + дефектная ведомость (Word).</div>
            </div>

            <div className="flex flex-wrap gap-3 justify-end">
              <Button variant="secondary" onClick={() => nav("/viewer")}>
                Вернуться в просмотр
              </Button>

              <Button
                variant="primary"
                onClick={onGenerateWord}
                leftIcon={<span>🧾</span>}
                disabled={isWordBusy}
                title="Сформировать Word"
              >
                {isWordBusy ? "Формируем…" : "Сформировать ведомость (Word)"}
              </Button>
            </div>
          </div>

          <div className="mt-5">
            <div className="fx-divider opacity-70" />
          </div>

          {/* ✅ счётчики оставляем компактно в фильтрах, KPI-карточки убраны */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {filterPill("all", "все", summary.total)}
            {filterPill("unresolved", "не решено", summary.unresolved)}
            {filterPill("ok", "дефектов нет", summary.ok)}
            {filterPill("defect", "есть дефект", summary.defect)}
          </div>
        </div>

        {/* CHART */}
        <div className="mt-6 fx-card fx-border-run p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold">График выявленных дефектов</div>
              <div className="text-sm text-white/60">Считается по фото, где оператор выбрал “Есть дефект”.</div>
            </div>
            <div className="text-xs text-white/55 tabular-nums">Нерешённых: {summary.unresolved}</div>
          </div>

          {chartRows.length ? (
            <div className="mt-5 space-y-3">
              {chartRows.map(([name, val]) => {
                const pct = Math.round((val / maxVal) * 100);
                return (
                  <div key={name} className="grid grid-cols-[220px_1fr_40px] gap-3 items-center">
                    <div className="text-sm text-white/80 truncate">{name}</div>
                    <ProgressBar value={pct} />
                    <div className="text-sm text-white/70 tabular-nums text-right">{val}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-5 text-sm text-white/60">
              Пока нет данных для графика (нужно разметить дефекты и выбрать “Есть дефект” хотя бы на одном фото).
            </div>
          )}
        </div>

        {/* LIST */}
        <div className="mt-6 fx-card fx-border-run p-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-lg font-semibold">Список</div>
              <div className="text-sm text-white/60">
                Отфильтровано: <span className="text-white/80 tabular-nums">{filteredItems.length}</span>
              </div>
            </div>

            <Button
              variant="danger"
              onClick={() => {
                resetAll();
                toast.info("Проект сброшен");
                nav("/upload");
              }}
            >
              Сбросить проект
            </Button>
          </div>

          <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredItems.map((p) => {
              const d = decisions[p.id];
              const pill =
                !d
                  ? { text: "не решено", dot: "bg-white/35", tone: "text-white/70", icon: "⏳" }
                  : d.type === "ok"
                  ? { text: "дефектов нет", dot: "bg-emerald-400/80", tone: "text-emerald-200", icon: "✅" }
                  : { text: "есть дефект", dot: "bg-orange-300/90", tone: "text-orange-200", icon: "⚠️" };

              return (
                <div key={p.id} className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                  <div className="p-4 flex gap-4 items-center">
                    <div className="group h-16 w-24 rounded-2xl overflow-hidden border border-white/10 bg-black/30 shrink-0">
                      <img
                        src={p.src}
                        alt={p.name}
                        className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.05]"
                        draggable={false}
                      />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate">{p.name}</div>

                          <div className="mt-2 flex items-center gap-2">
                            <span
                              className={[
                                "inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px]",
                                pill.tone,
                              ].join(" ")}
                            >
                              <span className={["h-2 w-2 rounded-full", pill.dot].join(" ")} />
                              <span className="tabular-nums">{pill.icon}</span>
                              <span className="text-white/80">{pill.text}</span>
                            </span>

                            <span className="text-[11px] text-white/55 tabular-nums">bbox: {p.bboxes?.length ?? 0}</span>
                          </div>

                          {d?.type === "defect" ? (
                            <div className="mt-2 text-[11px] text-white/55">
                              категория: <span className="text-white/80 font-semibold">{(d as any).category ?? "—"}</span>
                            </div>
                          ) : null}
                        </div>

                        <Button size="sm" variant="secondary" onClick={() => nav("/viewer")} title="Перейти в просмотр">
                          Открыть →
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 text-xs text-white/55">
            Word формируется по фото, где оператор выбрал “Есть дефект”. “Дефектов нет” и “Не решено” в ведомость не попадают.
          </div>
        </div>
      </div>
    </div>
  );
}
