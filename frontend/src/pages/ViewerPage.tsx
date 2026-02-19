// src/pages/ViewerPage.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  Trash2,
  ArrowLeft,
  ArrowRight,
  XCircle,
  Sparkles,
  ChevronDown,
  Check,
  Tag,
  X,
  Search,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import ViewerCanvas from "../components/viewer/ViewerCanvas";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import { toast } from "../components/ui/ToastCenter";
import { useAppStore } from "../store/useAppStore";
import type { BBox, OperatorDecision } from "../types";
import { DEFECT_CLASSES, type DefectClass } from "../constants/defects";
import { uid } from "../utils/id";
import { api } from "../api/api";

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function fmtPct(x: number) {
  return `${Math.round(x * 100)}%`;
}

function isTypingTarget(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (t.isContentEditable) return true;
  return false;
}

function normalizeClassName(s: string) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normKey(s: string) {
  return normalizeClassName(s).toLowerCase();
}

function scoreMatch(opt: string, q: string) {
  const o = normKey(opt);
  const qq = normKey(q);
  if (!qq) return 0;
  const idx = o.indexOf(qq);
  if (idx < 0) return 10_000;
  return idx;
}

function getFallbackClasses(): DefectClass[] {
  const base = [...(DEFECT_CLASSES as unknown as string[])].map(normalizeClassName).filter(Boolean);
  const uniq = Array.from(new Set(base)).sort((a, b) => a.localeCompare(b, "ru", { sensitivity: "base" }));
  return uniq as any;
}

function normalizeRemoteClasses(xs: any): DefectClass[] {
  const remote = Array.isArray(xs) ? xs.map(normalizeClassName).filter(Boolean) : [];
  const uniq = Array.from(new Set(remote)).sort((a, b) => a.localeCompare(b, "ru", { sensitivity: "base" }));
  return uniq as any;
}

/**
 * Эвристика для "ручных" bbox:
 * - добавляем вручную через uid("bbox") => id начинается с "bbox"
 * YOLO с бэка приходит uuid (обычно не начинается с "bbox").
 * Это позволяет:
 * - при автоинференсе заменять только "авто" боксы, не трогая ручные.
 */
function isManualBox(b: Pick<BBox, "id">) {
  const id = String(b.id ?? "");
  return id.startsWith("bbox") || id.startsWith("manual");
}

/** ✅ dropdown с поиском */
function DefectDropdown(props: {
  value: DefectClass;
  options: DefectClass[];
  onChange: (v: DefectClass) => void;
  disabled?: boolean;
  className?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const { value, options, onChange, disabled, className, searchable = true, searchPlaceholder } = props;

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const query = q.trim();
    if (!searchable || !query) return options;
    const ranked = options
      .map((o) => ({ o, s: scoreMatch(o, query) }))
      .filter((x) => x.s < 10_000)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.o);
    return ranked.length ? ranked : [];
  }, [options, q, searchable]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!open) return;
      const el = e.target as Node | null;
      if (!el) return;
      if (!rootRef.current) return;
      if (!rootRef.current.contains(el)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.code === "Escape" || e.key === "Escape") setOpen(false);
    };

    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    window.setTimeout(() => {
      if (searchable) searchRef.current?.focus();
    }, 0);
  }, [open, searchable]);

  return (
    <div ref={rootRef} className={["relative w-full", className ?? ""].join(" ")}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((s) => !s)}
        className={[
          "w-full flex items-start justify-between gap-3",
          "rounded-2xl border px-4 py-2.5 transition",
          "min-h-[48px]",
          disabled ? "opacity-60 cursor-not-allowed" : "hover:bg-white/[0.06]",
          "border-white/10 bg-black/25 text-white/85",
          open ? "ring-2 ring-orange-300/25" : "",
        ].join(" ")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex-1 text-left text-[14px] md:text-[15px] font-semibold leading-snug whitespace-normal break-words">
          {value}
        </span>

        <ChevronDown className={["h-5 w-5 shrink-0 transition mt-0.5", open ? "rotate-180" : ""].join(" ")} />
      </button>

      {open ? (
        <div
          className={[
            "absolute z-50 mt-2 w-full",
            "rounded-2xl border border-white/10 bg-[#0b0f18]/95 backdrop-blur",
            "shadow-[0_18px_60px_rgba(0,0,0,0.55)]",
            "overflow-hidden",
          ].join(" ")}
          role="listbox"
        >
          {searchable ? (
            <div className="p-2 border-b border-white/10 bg-black/20">
              <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-3 py-2">
                <Search className="h-4 w-4 text-white/55" />
                <input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={searchPlaceholder ?? "Поиск…"}
                  className="w-full bg-transparent text-sm text-white/85 placeholder:text-white/40 outline-none"
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[11px] text-white/45">
                <span>Найдено: {filtered.length}</span>
                <span>Esc — закрыть</span>
              </div>
            </div>
          ) : null}

          <div className="max-h-[320px] overflow-auto no-scrollbar p-1.5">
            {filtered.length ? (
              filtered.map((opt) => {
                const active = opt === value;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      onChange(opt);
                      setOpen(false);
                    }}
                    className={[
                      "w-full text-left px-4 py-2.5 rounded-2xl",
                      "flex items-start justify-between gap-3",
                      "transition",
                      active
                        ? "bg-orange-500/[0.14] text-orange-100 border border-orange-300/25"
                        : "bg-transparent text-white/80 hover:bg-white/[0.05] border border-transparent",
                    ].join(" ")}
                  >
                    <span className="flex-1 text-[14px] md:text-[15px] font-semibold leading-snug whitespace-normal break-words">
                      {opt}
                    </span>
                    {active ? <Check className="h-5 w-5 text-orange-200 mt-0.5" /> : <span className="h-5 w-5" />}
                  </button>
                );
              })
            ) : (
              <div className="px-4 py-4 text-sm text-white/60">Ничего не найдено.</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DecisionPill(props: {
  title: string;
  subtitle?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  tone: "ok" | "defect";
}) {
  const { title, subtitle, active, disabled, onClick, icon, tone } = props;

  const base = "w-full rounded-3xl border px-4 py-3.5 text-left transition select-none relative overflow-hidden";
  const disabledCls = disabled ? "opacity-60 cursor-not-allowed" : "hover:translate-y-[-1px]";
  const activeRing = active ? "ring-2 ring-orange-300/25" : "";

  const toneCls =
    tone === "ok"
      ? active
        ? "border-emerald-300/35 bg-emerald-500/[0.10]"
        : "border-white/10 bg-white/[0.03] hover:bg-white/[0.05]"
      : active
      ? "border-orange-300/40 bg-orange-500/[0.12]"
      : "border-white/10 bg-white/[0.03] hover:bg-white/[0.05]";

  const glow = tone === "ok" ? "from-emerald-400/20 via-transparent to-white/[0.02]" : "from-orange-400/22 via-transparent to-white/[0.02]";

  return (
    <button type="button" onClick={onClick} disabled={disabled} className={[base, toneCls, disabledCls, activeRing].join(" ")} title={subtitle ?? title}>
      <div className={["pointer-events-none absolute inset-0 bg-gradient-to-br", glow].join(" ")} />
      <div className="relative flex items-center gap-3">
        <div
          className={[
            "h-11 w-11 rounded-2xl flex items-center justify-center shrink-0 border",
            tone === "ok"
              ? active
                ? "bg-emerald-500/[0.10] border-emerald-300/30"
                : "bg-black/20 border-white/10"
              : active
              ? "bg-orange-500/[0.12] border-orange-300/30"
              : "bg-black/20 border-white/10",
          ].join(" ")}
        >
          {icon}
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-white/90 truncate">{title}</div>
          {subtitle ? <div className="text-[11px] text-white/55 mt-0.5">{subtitle}</div> : null}
        </div>

        <div
          className={[
            "shrink-0 text-[11px] font-semibold px-2.5 py-1 rounded-2xl border",
            active ? "border-orange-300/25 bg-orange-500/[0.10] text-orange-100" : "border-white/10 bg-white/[0.03] text-white/60",
          ].join(" ")}
        >
          {tone === "ok" ? "1" : "2"}
        </div>
      </div>
    </button>
  );
}

function extractInferMeta(payload: any): { device?: string; used_cpu_fallback?: boolean; took_ms?: number; num_det?: number } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return {
    device: typeof payload.device === "string" ? payload.device : undefined,
    used_cpu_fallback: typeof payload.used_cpu_fallback === "boolean" ? payload.used_cpu_fallback : undefined,
    took_ms: typeof payload.took_ms === "number" ? payload.took_ms : undefined,
    num_det: typeof payload.num_det === "number" ? payload.num_det : undefined,
  };
}

export default function ViewerPage() {
  const nav = useNavigate();

  const { sessionId, photos, activeIndex, setActiveIndex, updatePhotoBBoxes, decisionByPhoto, setDecision } = useAppStore();

  // ✅ защита от некорректного activeIndex и “залипания” старого кадра
  const photosArr = photos ?? [];
  const safeIndex = useMemo(() => {
    if (!photosArr.length) return 0;
    const idx = Number.isFinite(activeIndex) ? (activeIndex as number) : 0;
    return Math.max(0, Math.min(photosArr.length - 1, idx));
  }, [photosArr.length, activeIndex]);

  useEffect(() => {
    if (!photosArr.length) return;
    if (safeIndex !== activeIndex) setActiveIndex(safeIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeIndex, photosArr.length]);

  const photo = photosArr[safeIndex];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ✅ динамические классы (с бэка)
  const [defectClasses, setDefectClasses] = useState<DefectClass[]>(getFallbackClasses());
  const [clsForNew, setClsForNew] = useState<DefectClass>((getFallbackClasses()[0] as any) || ("прочее" as any));

  const [place, setPlace] = useState("");
  const [comment, setComment] = useState("");
  const [category, setCategory] = useState<"A" | "Б" | "В" | "">("");
  const [recommendedFix, setRecommendedFix] = useState("");

  const [isSaving, setIsSaving] = useState(false);
  const [isInferring, setIsInferring] = useState(false);

  // ✅ detail loading (важно после F5)
  const [detailBusy, setDetailBusy] = useState(false);
  const detailReqRef = useRef<{ photoId: string; ts: number } | null>(null);

  // ✅ защита от гонок инференса (если быстро переключили фото)
  const inferReqRef = useRef<{ photoId: string; ts: number } | null>(null);

  // ✅ авто-инференс один раз на фото (если bbox пустые)
  const autoInferDoneRef = useRef<Set<string>>(new Set());

  // ✅ модалка добавления нового класса
  const [isAddClassOpen, setIsAddClassOpen] = useState(false);
  const [newClassName, setNewClassName] = useState("");
  const [newClassBusy, setNewClassBusy] = useState(false);

  const decision: OperatorDecision | undefined = photo ? decisionByPhoto?.[photo.id] : undefined;
  const decisionType: "ok" | "defect" | "none" = !decision ? "none" : decision.type;

  const unresolved = useMemo(() => {
    let cnt = 0;
    for (const p of photosArr) if (!decisionByPhoto?.[p.id]) cnt++;
    return cnt;
  }, [photosArr, decisionByPhoto]);

  const canPrev = safeIndex > 0;
  const canNext = safeIndex < photosArr.length - 1;

  // ✅ всегда новый ref массива — даже если где-то мутировали in-place
  const bboxes = [...(photo?.bboxes ?? [])];

  const selectedBox = useMemo(() => {
    if (!photo || !selectedId) return null;
    return (photo.bboxes ?? []).find((b) => b.id === selectedId) ?? null;
  }, [photo, selectedId]);

  // ✅ загрузка классов с бэка (и при смене sessionId)
  useEffect(() => {
    let alive = true;

    async function loadClasses() {
      if (!sessionId) {
        const fb = getFallbackClasses();
        if (!alive) return;
        setDefectClasses(fb);
        setClsForNew((prev) => (fb.includes(prev) ? prev : (fb[0] ?? ("прочее" as any))));
        return;
      }

      try {
        const res = await api.getSessionClasses(sessionId);
        const remote = normalizeRemoteClasses(res?.classes);
        const finalList = remote.length ? remote : getFallbackClasses();

        if (!alive) return;
        setDefectClasses(finalList);
        setClsForNew((prev) => (finalList.includes(prev) ? prev : (finalList[0] ?? ("прочее" as any))));
      } catch {
        const fb = getFallbackClasses();
        if (!alive) return;
        setDefectClasses(fb);
        setClsForNew((prev) => (fb.includes(prev) ? prev : (fb[0] ?? ("прочее" as any))));
      }
    }

    void loadClasses();
    return () => {
      alive = false;
    };
  }, [sessionId]);

  /**
   * ✅ подтянуть detail (bboxes + decision/meta) при входе на фото
   * - bboxes тянем только если локально пусто (чтобы не перетирать правки)
   * - decision/meta тянем, если решения в сторе нет (полезно после F5)
   */
  useEffect(() => {
    let alive = true;

    async function loadPhotoDetail() {
      if (!photo) return;
      if (!sessionId) return;

      const hasLocalBBoxes = (photo.bboxes?.length ?? 0) > 0;
      const hasLocalDecision = !!decisionByPhoto?.[photo.id];

      const needBBoxes = !hasLocalBBoxes;
      const needDecision = !hasLocalDecision;

      if (!needBBoxes && !needDecision) return;

      const req = { photoId: photo.id, ts: Date.now() };
      detailReqRef.current = req;
      setDetailBusy(true);

      try {
        const detail = await api.getPhoto(sessionId, photo.id);

        const cur = detailReqRef.current;
        if (!alive || !cur || cur.photoId !== req.photoId) return;

        // 1) decision/meta — аккуратно
        if (needDecision) {
          const d = api.decisionFromBackend(detail as any);
          if (d) setDecision(photo.id, d);
        }

        // 2) bboxes — только если локально пусто
        if (needBBoxes) {
          const mapped = api.applyBackendDetailToPhotoItem(photo, detail);
          updatePhotoBBoxes(photo.id, () => mapped.bboxes ?? []);
          setSelectedId(null);
        }
      } catch (e: any) {
        const msg = e?.message ?? "Не удалось получить детали фото";
        toast.warn(msg);
      } finally {
        if (alive) setDetailBusy(false);
      }
    }

    void loadPhotoDetail();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, photo?.id]);

  useEffect(() => {
    if (!photo) return;
    const d = decisionByPhoto?.[photo.id];

    if (d?.type === "defect") {
      setPlace(d.place ?? "");
      setComment(d.comment ?? "");
      setCategory((d.category as any) ?? "");
      setRecommendedFix(d.recommendedFix ?? "");
    } else {
      setPlace("");
      setComment("");
      setCategory("");
      setRecommendedFix("");
    }

    setSelectedId(null);
  }, [photo?.id, decisionByPhoto]);

  const addDefect = () => {
    if (!photo) return;
    const b: BBox = {
      id: uid("bbox"),
      x: 0.35,
      y: 0.35,
      w: 0.25,
      h: 0.18,
      cls: clsForNew,
      confidence: 0.9,
    };
    updatePhotoBBoxes(photo.id, (prev) => [...(prev ?? []), b]);
    setSelectedId(b.id);
    toast.success("Дефект добавлен");
  };

  const deleteSelected = () => {
    if (!photo || !selectedId) return;
    updatePhotoBBoxes(photo.id, (prev) => (prev ?? []).filter((b) => b.id !== selectedId));
    setSelectedId(null);
    toast.info("Дефект удалён");
  };

  const deleteAll = () => {
    if (!photo) return;
    if (!(photo.bboxes?.length ?? 0)) {
      toast.info("Удалять нечего");
      return;
    }
    updatePhotoBBoxes(photo.id, () => []);
    setSelectedId(null);
    toast.info("Все дефекты удалены");
  };

  const updateSelected = (patch: Partial<BBox>) => {
    if (!photo || !selectedId) return;
    updatePhotoBBoxes(photo.id, (prev) => (prev ?? []).map((b) => (b.id === selectedId ? { ...b, ...patch } : b)));
  };

  const goPrev = () => {
    if (!canPrev) return;
    setSelectedId(null);
    setActiveIndex(safeIndex - 1);
  };

  const goNext = () => {
    if (!canNext) return;
    setSelectedId(null);
    setActiveIndex(safeIndex + 1);
  };

  const goNextOrSummary = () => {
    if (canNext) setTimeout(goNext, 120);
    else setTimeout(() => nav("/summary"), 120);
  };

  async function persistToBackend(args: { decision: "ok" | "defect"; clearBBoxes?: boolean }) {
    if (!photo) return;
    if (!sessionId) {
      toast.error("Нет sessionId. Сначала загрузите фото заново (страница Загрузка).");
      return;
    }

    const bxs = (args.clearBBoxes ? [] : (photo.bboxes ?? [])).map((b) => ({
      id: b.id,
      class: b.cls as any,
      confidence: b.confidence,
      bbox: [b.x, b.y, b.w, b.h] as [number, number, number, number],
    }));

    const meta =
      args.decision === "defect"
        ? {
            class: "",
            place: place ?? "",
            comment: comment ?? "",
            category: category ?? "",
            recommendedFix: recommendedFix ?? "",
          }
        : { class: "", place: "", comment: "", category: "", recommendedFix: "" };

    await api.saveLabels({
      sessionId,
      photoId: photo.id,
      decision: args.decision,
      meta,
      bboxes: bxs as any,
    });
  }

  const markOk = async () => {
    if (!photo) return;
    if (isSaving) return;

    setIsSaving(true);
    try {
      updatePhotoBBoxes(photo.id, () => []);
      setSelectedId(null);

      await persistToBackend({ decision: "ok", clearBBoxes: true });
      setDecision(photo.id, { type: "ok" });

      toast.success("Помечено: дефектов нет");
      goNextOrSummary();
    } catch (e: any) {
      toast.error(e?.message ?? "Ошибка сохранения на бэке");
    } finally {
      setIsSaving(false);
    }
  };

  const markDefect = async () => {
    if (!photo) return;
    if (isSaving) return;

    setIsSaving(true);
    try {
      const defects = (photo.bboxes ?? []).map((b) => ({ bboxId: b.id, cls: b.cls, confidence: b.confidence }));

      await persistToBackend({ decision: "defect" });

      setDecision(photo.id, {
        type: "defect",
        defects,
        place: place || undefined,
        comment: comment || undefined,
        category: (category || undefined) as any,
        recommendedFix: recommendedFix || undefined,
      });

      toast.success("Помечено: есть дефект");
      setSelectedId(null);
      goNextOrSummary();
    } catch (e: any) {
      toast.error(e?.message ?? "Ошибка сохранения на бэке");
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * ✅ авто-инференс YOLO
   * - НЕ затираем ручные bbox (id начинается с "bbox")
   * - Заменяем только авто-bbox
   * - защита от гонок при переключении фото
   */
  const runInfer = async (opts?: { silent?: boolean }) => {
    if (!photo) return;
    if (!sessionId) {
      toast.error("Нет sessionId. Сначала загрузите фото заново (страница Загрузка).");
      return;
    }
    if (isInferring) return;

    const req = { photoId: photo.id, ts: Date.now() };
    inferReqRef.current = req;

    setIsInferring(true);
    try {
      const res = await api.infer(sessionId, photo.id);

      const cur = inferReqRef.current;
      if (!cur || cur.photoId !== req.photoId) return;

      const meta = extractInferMeta(res as any);
      const yoloBoxes = api.bboxesFromBackend(res);

      let manualCnt = 0;
      updatePhotoBBoxes(photo.id, (prev) => {
        const prevList = prev ?? [];
        const manual = prevList.filter(isManualBox);
        manualCnt = manual.length;
        return [...manual, ...(yoloBoxes ?? [])];
      });

      setSelectedId(null);

      if (!opts?.silent) {
        const dev = meta.device ? ` • device: ${meta.device}` : "";
        const cpuFb = meta.used_cpu_fallback ? " • CPU fallback" : "";
        const ms = typeof meta.took_ms === "number" ? ` • ${Math.round(meta.took_ms)}ms` : "";
        const baseMsg =
          manualCnt > 0 ? `Автопоиск: найдено ${yoloBoxes.length} (ручные сохранены: ${manualCnt})` : `Автопоиск: найдено ${yoloBoxes.length}`;
        toast.success(`${baseMsg}${dev}${cpuFb}${ms}`);
      }
    } catch (e: any) {
      if (!opts?.silent) toast.error(e?.message ?? "Ошибка автоанализа");
    } finally {
      setIsInferring(false);
    }
  };

  // ✅ авто-старт инференса: один раз на фото, если bbox пустые
  useEffect(() => {
    if (!photo) return;
    if (!sessionId) return;

    const hasAny = (photo.bboxes?.length ?? 0) > 0;
    if (hasAny) return;

    if (autoInferDoneRef.current.has(photo.id)) return;

    // если сейчас идёт сохранение — не мешаем оператору
    if (isSaving) return;

    autoInferDoneRef.current.add(photo.id);
    void runInfer({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo?.id, sessionId]);

  const openAddClassModal = () => {
    if (!sessionId) {
      toast.error("Нет sessionId. Сначала загрузите фото заново (страница Загрузка).");
      return;
    }
    if (isSaving || isInferring) return;
    setNewClassName("");
    setIsAddClassOpen(true);
  };

  const closeAddClassModal = () => {
    if (newClassBusy) return;
    setIsAddClassOpen(false);
  };

  const classExists = (name: string) => {
    const k = normKey(name);
    return defectClasses.some((c) => normKey(c) === k);
  };

  const suggestions = useMemo(() => {
    const q = normKey(newClassName);
    if (!q) return defectClasses.slice(0, 8);
    const scored = defectClasses
      .map((c) => {
        const k = normKey(c);
        const idx = k.indexOf(q);
        const score = idx < 0 ? 9999 : idx;
        return { c, score };
      })
      .filter((x) => x.score !== 9999)
      .sort((a, b) => a.score - b.score)
      .slice(0, 8)
      .map((x) => x.c);
    return scored.length ? scored : defectClasses.slice(0, 8);
  }, [defectClasses, newClassName]);

  const submitNewClass = async () => {
    if (!sessionId) {
      toast.error("Нет sessionId. Сначала загрузите фото заново (страница Загрузка).");
      return;
    }
    if (isSaving || isInferring || newClassBusy) return;

    const name = normalizeClassName(newClassName);
    if (!name) {
      toast.info("Введите название класса");
      return;
    }

    if (name.length < 2) {
      toast.info("Слишком короткое название");
      return;
    }

    if (classExists(name)) {
      setClsForNew(name as any);
      toast.info("Такой класс уже есть — выбран в списке");
      setIsAddClassOpen(false);
      return;
    }

    setNewClassBusy(true);
    try {
      const res = await api.addSessionClass(sessionId, name);

      const remote = normalizeRemoteClasses(res?.classes);
      const finalList = remote.length ? remote : getFallbackClasses();

      setDefectClasses(finalList);
      setClsForNew((finalList.includes(name as any) ? (name as any) : (finalList[0] ?? ("прочее" as any))) as any);

      toast.success(`Добавлен класс: ${name}`);
      setIsAddClassOpen(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось добавить класс на бэке");
    } finally {
      setNewClassBusy(false);
    }
  };

  // ===== HOTKEYS =====
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!photo) return;

      if (isAddClassOpen) {
        if (e.code === "Escape" || e.key === "Escape") {
          e.preventDefault();
          closeAddClassModal();
          return;
        }
        if (e.code === "Enter" || e.key === "Enter") {
          e.preventDefault();
          void submitNewClass();
          return;
        }
        return;
      }

      if (isTypingTarget(e.target)) return;

      if (e.code === "Escape" || e.key === "Escape") {
        setSelectedId(null);
        return;
      }

      if (e.code === "KeyA") {
        e.preventDefault();
        addDefect();
        return;
      }

      if (e.code === "Delete" || e.code === "Backspace" || e.key === "Delete" || e.key === "Backspace") {
        if (!selectedId) return;
        e.preventDefault();
        deleteSelected();
        return;
      }

      if (e.code === "Digit1" || e.key === "1") {
        e.preventDefault();
        void markOk();
        return;
      }

      if (e.code === "Digit2" || e.key === "2") {
        e.preventDefault();
        void markDefect();
        return;
      }

      if (e.code === "ArrowLeft" || e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
        return;
      }
      if (e.code === "ArrowRight" || e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
        return;
      }

      if (e.code === "KeyI") {
        e.preventDefault();
        void runInfer();
        return;
      }

      if (e.code === "KeyN") {
        e.preventDefault();
        openAddClassModal();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    photo?.id,
    selectedId,
    safeIndex,
    canPrev,
    canNext,
    place,
    comment,
    clsForNew,
    photosArr.length,
    category,
    recommendedFix,
    isSaving,
    isInferring,
    sessionId,
    isAddClassOpen,
    newClassName,
    newClassBusy,
  ]);

  if (!photo) {
    return (
      <div className="h-full w-full p-6">
        <div className="mx-auto max-w-5xl rounded-3xl border border-white/10 bg-white/[0.02] p-6">
          <div className="text-lg font-semibold text-white/90">Просмотр</div>
          <div className="mt-2 text-sm text-white/60">Нет фото. Сначала загрузи изображения.</div>
          <div className="mt-4">
            <Button variant="primary" onClick={() => nav("/upload")}>
              Перейти к загрузке
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const CatBtn = ({ v, label }: { v: "A" | "Б" | "В"; label: string }) => {
    const active = category === v;
    return (
      <button
        type="button"
        onClick={() => setCategory(v)}
        className={[
          "px-3 py-2 rounded-2xl border text-sm font-semibold transition",
          active ? "border-orange-300/55 bg-orange-500/18 text-orange-100" : "border-white/10 bg-white/[0.03] text-white/70 hover:bg-white/[0.06]",
        ].join(" ")}
        title={`Категория ${label}`}
        disabled={isSaving}
      >
        {label}
      </button>
    );
  };

  const canMutate = !(isSaving || isInferring);

  return (
    <div className="h-full w-full p-5">
      {/* ✅ Modal: add new defect class */}
      <Modal open={isAddClassOpen} onClose={closeAddClassModal} title="Новый класс дефекта">
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 h-10 w-10 rounded-2xl bg-orange-500/[0.12] border border-orange-300/20 flex items-center justify-center">
                <Tag className="h-5 w-5 text-orange-200" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white/90">Добавить дефект в список</div>
                <div className="mt-1 text-xs text-white/60 leading-relaxed">Класс сохранится в текущей сессии и попадёт в датасет/обучение.</div>
              </div>
            </div>
          </div>

          <div>
            <div className="text-xs text-white/60 mb-2">Название</div>
            <input
              autoFocus
              className={[
                "w-full rounded-2xl border px-4 py-3 text-sm text-white/85",
                "bg-black/25 border-white/10",
                "focus:outline-none focus:ring-2 focus:ring-orange-300/25",
                classExists(newClassName) ? "ring-2 ring-emerald-300/20" : "",
              ].join(" ")}
              value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)}
              placeholder="Введите название дефекта…"
              disabled={newClassBusy}
            />

            <div className="mt-2 flex items-center justify-between text-[11px] text-white/50">
              <div>Enter — сохранить • Esc — закрыть</div>
              <div className={newClassName.trim().length > 0 ? "text-white/60" : ""}>{newClassName.trim().length}/60</div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
            <div className="text-xs text-white/60">Подсказки</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setNewClassName(s)}
                  className={[
                    "px-3 py-2 rounded-2xl border text-xs font-semibold transition",
                    "border-white/10 bg-white/[0.03] text-white/75 hover:bg-white/[0.06]",
                  ].join(" ")}
                  disabled={newClassBusy}
                  title="Подставить в поле"
                >
                  {s}
                </button>
              ))}
            </div>

            {classExists(newClassName) ? <div className="mt-3 text-xs text-emerald-200">Такой класс уже существует — при сохранении он просто будет выбран.</div> : null}
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="secondary" leftIcon={<X className="h-4 w-4" />} onClick={closeAddClassModal} disabled={newClassBusy}>
              Отмена
            </Button>
            <Button variant="primary" leftIcon={<Plus className="h-4 w-4" />} onClick={() => void submitNewClass()} disabled={newClassBusy}>
              {newClassBusy ? "Добавляем…" : "Добавить класс"}
            </Button>
          </div>
        </div>
      </Modal>

      <div className="mx-auto max-w-[1400px] h-full grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-3">
        {/* LEFT */}
        <div className="flex flex-col gap-2.5 min-h-0">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[18px] font-semibold text-white/90 truncate">{photo.name}</div>
              {detailBusy ? <div className="mt-1 text-[11px] text-white/50">Подтягиваем детали фото…</div> : null}
              {isInferring ? <div className="mt-0.5 text-[11px] text-orange-200/70">Автопоиск…</div> : null}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button size="sm" leftIcon={<ArrowLeft className="h-4 w-4" />} onClick={goPrev} disabled={!canPrev || !canMutate}>
                Назад
              </Button>
              <Button size="sm" leftIcon={<ArrowRight className="h-4 w-4" />} onClick={goNext} disabled={!canNext || !canMutate}>
                Вперёд
              </Button>
            </div>
          </div>

          <div className="flex-1 min-h-0">
            <ViewerCanvas
              key={photo.id} // ✅ принудительно обновляем просмотр при смене фото (чтобы не “залипало” старое)
              src={photo.src}
              bboxes={bboxes}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onBBoxesChange={(next) => updatePhotoBBoxes(photo.id, () => next)}
            />
          </div>
        </div>

        {/* RIGHT */}
        <div className="flex flex-col gap-3 min-h-0">
          {/* Auto detection */}
          <div className="rounded-3xl border border-orange-300/10 bg-orange-500/[0.04] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white/85">Автопоиск дефектов</div>
                <div className="text-[11px] text-white/55 mt-0.5">
                  <span className="text-white/70 font-semibold">I</span> • заменяет только авто-bbox (ручные сохраняет)
                </div>
              </div>
              <div className="text-xs text-white/55 shrink-0">bbox: {bboxes.length}</div>
            </div>

            <div className="mt-3 flex gap-2">
              <Button variant="primary" leftIcon={<Sparkles className="h-4 w-4" />} onClick={() => void runInfer()} disabled={isInferring || isSaving}>
                {isInferring ? "Ищем…" : "Автопоиск (YOLO)"}
              </Button>

              <Button variant="danger" onClick={deleteAll} disabled={isInferring || isSaving || !bboxes.length}>
                Очистить
              </Button>
            </div>
          </div>

          {/* Defects */}
          <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-white/85">Дефекты</div>
              <div className="text-xs text-white/55">шт: {bboxes.length}</div>
            </div>

            <div className="mt-2.5 flex gap-2">
              <div className="flex-1">
                <DefectDropdown value={clsForNew} options={defectClasses} onChange={(v) => setClsForNew(v)} disabled={!canMutate} searchable searchPlaceholder="Поиск дефекта…" />
              </div>

              <Button size="sm" variant="secondary" leftIcon={<Plus className="h-4 w-4" />} onClick={openAddClassModal} disabled={!canMutate} title="Добавить новый класс (N)">
                Класс
              </Button>
            </div>

            <div className="mt-2.5 grid grid-cols-3 gap-2">
              <Button size="sm" variant="secondary" leftIcon={<Plus className="h-4 w-4" />} onClick={addDefect} disabled={!canMutate} title="A">
                Добавить
              </Button>

              <Button size="sm" variant="danger" leftIcon={<Trash2 className="h-4 w-4" />} onClick={deleteSelected} disabled={!selectedId || !canMutate} title="Del">
                Удалить
              </Button>

              <Button size="sm" variant="danger" leftIcon={<XCircle className="h-4 w-4" />} onClick={deleteAll} disabled={!bboxes.length || !canMutate}>
                Все
              </Button>
            </div>

            <div className="mt-2.5 space-y-2 max-h-[220px] overflow-auto no-scrollbar">
              {bboxes.length === 0 ? (
                <div className="text-sm text-white/55">Пока пусто. Запусти “Автопоиск” или добавь вручную.</div>
              ) : (
                bboxes.map((b) => {
                  const isSel = b.id === selectedId;
                  return (
                    <button
                      key={b.id}
                      className={[
                        "w-full text-left rounded-2xl border px-3 py-2.5 transition",
                        isSel ? "border-orange-300/50 bg-orange-500/[0.10]" : "border-white/10 bg-black/20 hover:bg-white/[0.03]",
                      ].join(" ")}
                      onClick={() => setSelectedId(b.id)}
                      type="button"
                      disabled={!canMutate}
                    >
                      <div className="text-[14px] font-semibold text-white/90">{b.cls}</div>
                      <div className="text-[11px] text-white/55 mt-0.5 tabular-nums">
                        {fmtPct(b.confidence)} • x {b.x.toFixed(2)} y {b.y.toFixed(2)} w {b.w.toFixed(2)} h {b.h.toFixed(2)}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {selectedBox ? (
              <div className="mt-2.5 rounded-2xl border border-white/10 bg-black/20 p-3">
                <div className="text-xs text-white/60">Выбранный</div>

                <div className="mt-2">
                  <DefectDropdown value={selectedBox.cls as any} options={defectClasses} onChange={(v) => updateSelected({ cls: v as any })} disabled={!canMutate} searchable searchPlaceholder="Поиск дефекта…" />
                </div>

                <div className="mt-2.5 grid grid-cols-2 gap-2">
                  <label className="text-xs text-white/55">
                    confidence
                    <input
                      className="mt-1 w-full accent-orange-400"
                      type="range"
                      min={0.1}
                      max={1}
                      step={0.01}
                      value={selectedBox.confidence}
                      onChange={(e) => updateSelected({ confidence: clamp01(Number(e.target.value)) })}
                      disabled={!canMutate}
                    />
                  </label>

                  <div className="text-xs text-white/55 flex items-end justify-end tabular-nums">{fmtPct(selectedBox.confidence)}</div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Operator decision */}
          <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-white/85">Решение</div>
              <div className="text-[11px] text-white/50">{unresolved > 0 ? `нерешённых: ${unresolved}` : "всё решено"}</div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2">
              <DecisionPill
                tone="ok"
                title={isSaving && decisionType !== "defect" ? "Сохраняем…" : "Нет дефектов"}
                subtitle="Горячая клавиша: 1"
                active={decisionType === "ok"}
                disabled={!canMutate}
                onClick={() => void markOk()}
                icon={<CheckCircle2 className="h-5 w-5 text-emerald-200" />}
              />

              <DecisionPill
                tone="defect"
                title={isSaving && decisionType !== "ok" ? "Сохраняем…" : "Есть дефект"}
                subtitle="Горячая клавиша: 2"
                active={decisionType === "defect"}
                disabled={!canMutate}
                onClick={() => void markDefect()}
                icon={<AlertTriangle className="h-5 w-5 text-orange-200" />}
              />
            </div>

            <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="text-xs text-white/60 mb-2">Категория</div>
              <div className="flex items-center gap-2">
                <CatBtn v="A" label="A" />
                <CatBtn v="Б" label="Б" />
                <CatBtn v="В" label="В" />
                <button type="button" onClick={() => setCategory("")} className="ml-auto text-xs text-white/55 hover:text-white/80" disabled={!canMutate}>
                  сброс
                </button>
              </div>
            </div>

            <div className="mt-3">
              <div className="text-xs text-white/55">Место</div>
              <input
                className="mt-1 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85"
                value={place}
                onChange={(e) => setPlace(e.target.value)}
                placeholder="Участок / отметка"
                disabled={!canMutate}
              />
            </div>

            <div className="mt-3">
              <div className="text-xs text-white/55">Комментарий</div>
              <textarea
                className="mt-1 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85 min-h-[78px]"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Коротко и по делу…"
                disabled={!canMutate}
              />
            </div>

            <div className="mt-3">
              <div className="text-xs text-white/55">Рекомендуемый способ устранения</div>
              <textarea
                className="mt-1 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85 min-h-[64px]"
                value={recommendedFix}
                onChange={(e) => setRecommendedFix(e.target.value)}
                placeholder="Например: зачистка, грунтовка, окраска…"
                disabled={!canMutate}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
