// src/components/ViewerCanvas.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BBox } from "../types";
import { cn } from "../utils/cn";

type Props = {
  src: string;
  bboxes: BBox[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onBBoxesChange?: (next: BBox[]) => void;

  // ✅ опционально: если передашь из ViewerPage — сможем показывать актуальные хоткеи
  // (не обязательно, будет дефолтный набор)
  hotkeysHint?: string;
};

type Point = { x: number; y: number };

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}
function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

type LabelItem = {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function isTypingTarget(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (t.isContentEditable) return true;
  return false;
}

// ✅ важно: "ручные" bbox в ViewerPage создаются uid("bbox") => id начинается с "bbox"
function isManualBoxId(id: string) {
  const s = String(id ?? "");
  return s.startsWith("bbox") || s.startsWith("manual");
}

function uid(prefix = "bbox") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function safeNum(x: any, fallback: number) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeBox(b: BBox): BBox {
  const x = clamp01(safeNum(b.x, 0));
  const y = clamp01(safeNum(b.y, 0));
  const w = clamp01(safeNum(b.w, 0.1));
  const h = clamp01(safeNum(b.h, 0.1));
  const confidence = clamp01(safeNum((b as any).confidence, 0.9));
  const cls = String((b as any).cls ?? "прочее");
  return clampBoxToCanvas({ ...b, x, y, w, h, confidence, cls } as any);
}

function clampBoxToCanvas(b: BBox): BBox {
  const w = clamp01(Math.max(0.01, safeNum(b.w, 0.01)));
  const h = clamp01(Math.max(0.01, safeNum(b.h, 0.01)));
  const x = clamp01(Math.min(safeNum(b.x, 0), 1 - w));
  const y = clamp01(Math.min(safeNum(b.y, 0), 1 - h));
  return { ...b, x, y, w, h };
}

function nudgeBox(b: BBox, dx: number, dy: number): BBox {
  return clampBoxToCanvas({ ...b, x: safeNum(b.x, 0) + dx, y: safeNum(b.y, 0) + dy });
}

export default function ViewerCanvas({
  src,
  bboxes,
  selectedId,
  onSelect,
  onBBoxesChange,
  hotkeysHint
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });

  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 1, h: 1 });

  const selected = useMemo(() => bboxes.find((b) => b.id === selectedId) ?? null, [bboxes, selectedId]);

  // Drag state (move / resize)
  const [drag, setDrag] = useState<null | {
    id: string;
    mode: "move" | "resize";
    startMouse: Point;
    startBox: BBox;
    handle?: "nw" | "ne" | "sw" | "se";
  }>(null);

  // ✅ refs для стабильной работы в хоткеях
  const bboxesRef = useRef<BBox[]>(bboxes);
  const selectedIdRef = useRef<string | null | undefined>(selectedId);
  const dragRef = useRef<typeof drag>(drag);
  const onBBoxesChangeRef = useRef<Props["onBBoxesChange"]>(onBBoxesChange);
  const onSelectRef = useRef<Props["onSelect"]>(onSelect);

  useEffect(() => {
    bboxesRef.current = bboxes;
  }, [bboxes]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);
  useEffect(() => {
    onBBoxesChangeRef.current = onBBoxesChange;
  }, [onBBoxesChange]);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // ✅ для пункта 3: автоскролл в списке справа — используем custom event
  function requestScrollToBBox(id: string) {
    window.dispatchEvent(new CustomEvent("viewer:scrollToBBox", { detail: { id } }));
  }

  // Fit on load
  useEffect(() => {
    const img = imgRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap) return;

    const onLoad = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      const iw = img.naturalWidth || 1;
      const ih = img.naturalHeight || 1;

      setImgSize({ w: iw, h: ih });

      const fit = Math.min(w / iw, h / ih);
      const z = Math.max(0.2, Math.min(2.5, fit));
      setZoom(z);
      setPan({ x: 0, y: 0 });
    };

    if (img.complete) onLoad();
    img.addEventListener("load", onLoad);
    return () => img.removeEventListener("load", onLoad);
  }, [src]);

  // Wheel zoom (non-passive)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY;
      const factor = delta > 0 ? 1.08 : 0.92;
      setZoom((z) => clamp(z * factor, 0.15, 5));
    };

    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative as any);
  }, []);

  // Helpers: screen -> normalized image coords (0..1)
  function toImageNorm(clientX: number, clientY: number): Point {
    const wrap = wrapRef.current!;
    const img = imgRef.current!;
    const rect = wrap.getBoundingClientRect();

    const cx = clientX - rect.left - rect.width / 2 - pan.x;
    const cy = clientY - rect.top - rect.height / 2 - pan.y;

    const iw = img.naturalWidth || 1;
    const ih = img.naturalHeight || 1;

    const z = Math.max(zoom, 0.0001);
    const x = cx / (iw * z) + 0.5;
    const y = cy / (ih * z) + 0.5;

    return { x: safeNum(x, 0.5), y: safeNum(y, 0.5) };
  }

  function dedupeById(list: BBox[]) {
    const seen = new Set<string>();
    const out: BBox[] = [];
    for (const b of list) {
      const id = String((b as any).id ?? "");
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(sanitizeBox(b));
    }
    return out;
  }

  function updateBox(id: string, next: BBox) {
    const out = bboxesRef.current.map((b) => (b.id === id ? sanitizeBox(next) : sanitizeBox(b)));
    onBBoxesChangeRef.current?.(dedupeById(out));
  }

  function setBoxes(next: BBox[]) {
    onBBoxesChangeRef.current?.(dedupeById(next));
  }

  // Pan: Shift+LMB or Middle
  function startPan(e: React.MouseEvent) {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY };
      const startPan0 = { ...pan };

      const onMove = (ev: MouseEvent) => {
        setPan({ x: startPan0.x + (ev.clientX - start.x), y: startPan0.y + (ev.clientY - start.y) });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }
  }

  function onBackgroundClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).dataset.kind === "bg") onSelectRef.current?.(null);
  }

  // ✅ Alt+Drag дублируем bbox один раз, а дальше двигаем клон
  const dupRef = useRef<{
    active: boolean;
    clonedFromId: string;
    newId: string;
  } | null>(null);

  function onBoxMouseDown(e: React.MouseEvent, id: string, mode: "move" | "resize", handle?: any) {
    e.stopPropagation();
    e.preventDefault();

    const b0 = bboxesRef.current.find((x) => x.id === id);
    if (!b0) return;

    // ✅ Alt + move => duplicate
    if (mode === "move" && e.altKey) {
      const newId = uid("bbox");
      const clone: BBox = clampBoxToCanvas({
        ...sanitizeBox(b0),
        id: newId,
        x: clamp01(safeNum(b0.x, 0) + 0.01),
        y: clamp01(safeNum(b0.y, 0) + 0.01)
      });

      setBoxes([...bboxesRef.current, clone]);
      onSelectRef.current?.(newId);
      requestScrollToBBox(newId);

      dupRef.current = { active: true, clonedFromId: id, newId };
      id = newId; // продолжаем drag уже для нового бокса
    } else {
      dupRef.current = null;
      onSelectRef.current?.(id);
      requestScrollToBBox(id);
    }

    const startMouse = { x: e.clientX, y: e.clientY };
    const startBox: BBox = sanitizeBox({ ...(bboxesRef.current.find((x) => x.id === id) ?? b0) });

    setDrag({ id, mode, startMouse, startBox, handle });

    const onMove = (ev: MouseEvent) => {
      ev.preventDefault();

      const p0 = toImageNorm(startMouse.x, startMouse.y);
      const p1 = toImageNorm(ev.clientX, ev.clientY);
      const dx = safeNum(p1.x, 0.5) - safeNum(p0.x, 0.5);
      const dy = safeNum(p1.y, 0.5) - safeNum(p0.y, 0.5);

      const curr = bboxesRef.current.find((x) => x.id === id);
      const base = curr ? sanitizeBox({ ...curr }) : sanitizeBox({ ...startBox });

      if (mode === "move") {
        const next0: BBox = { ...base, x: safeNum(startBox.x, 0) + dx, y: safeNum(startBox.y, 0) + dy };
        const next = clampBoxToCanvas(next0);
        updateBox(id, next);
        return;
      }

      // resize
      let x = safeNum(startBox.x, 0);
      let y = safeNum(startBox.y, 0);
      let w = safeNum(startBox.w, 0.1);
      let h = safeNum(startBox.h, 0.1);

      const minSize = 0.02;

      if (handle === "se") {
        w = safeNum(startBox.w, 0.1) + dx;
        h = safeNum(startBox.h, 0.1) + dy;
      }
      if (handle === "sw") {
        x = safeNum(startBox.x, 0) + dx;
        w = safeNum(startBox.w, 0.1) - dx;
        h = safeNum(startBox.h, 0.1) + dy;
      }
      if (handle === "ne") {
        y = safeNum(startBox.y, 0) + dy;
        w = safeNum(startBox.w, 0.1) + dx;
        h = safeNum(startBox.h, 0.1) - dy;
      }
      if (handle === "nw") {
        x = safeNum(startBox.x, 0) + dx;
        y = safeNum(startBox.y, 0) + dy;
        w = safeNum(startBox.w, 0.1) - dx;
        h = safeNum(startBox.h, 0.1) - dy;
      }

      w = clamp01(Math.max(minSize, w));
      h = clamp01(Math.max(minSize, h));

      x = clamp01(Math.min(x, 1 - w));
      y = clamp01(Math.min(y, 1 - h));

      updateBox(id, { ...base, x, y, w, h });
    };

    const onUp = () => {
      setDrag(null);
      dupRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ===== Labels anti-overlap layout =====
  const labelItems = useMemo(() => {
    const iw = imgSize.w || 1;
    const ih = imgSize.h || 1;

    const pxToNx = (px: number) => px / (iw * Math.max(zoom, 0.0001));
    const pxToNy = (px: number) => px / (ih * Math.max(zoom, 0.0001));

    const GAP_Y = pxToNy(10);
    const PAD_X = pxToNx(10);
    const PAD_Y = pxToNy(10);

    const baseH = pxToNy(36);

    const items: LabelItem[] = bboxes.map((b) => {
      const bb = sanitizeBox(b);
      const pct = Math.round(safeNum(bb.confidence, 0) * 100);
      const text = `${bb.cls} • ${pct}%`;

      const approxPxW = clamp(90 + text.length * 7.2, 120, 320);
      const w = pxToNx(approxPxW);
      const h = baseH;

      const ax = clamp01(safeNum(bb.x, 0) + safeNum(bb.w, 0.1) / 2);

      // initial x: center
      let x = ax - w / 2;
      x = clamp(x, PAD_X, 1 - w - PAD_X);

      // initial y: top or bottom depending near top
      const preferBottom = safeNum(bb.y, 0) < 0.1;
      let y = preferBottom ? safeNum(bb.y, 0) + safeNum(bb.h, 0.1) + GAP_Y : safeNum(bb.y, 0) - h - GAP_Y;
      y = clamp(y, PAD_Y, 1 - h - PAD_Y);

      return { id: String(bb.id), text, x, y, w, h };
    });

    const placed: LabelItem[] = [];
    const sorted = [...items].sort((a, b) => a.y - b.y);

    for (const it of sorted) {
      let candidate = { ...it };

      // push-down
      let guard = 0;
      while (guard++ < 70) {
        const hit = placed.find((p) => rectsOverlap(candidate, p));
        if (!hit) break;
        candidate.y = hit.y + hit.h + GAP_Y;
        if (candidate.y > 1 - candidate.h - PAD_Y) break;
      }

      // if bottom overflow — push-up
      if (candidate.y > 1 - candidate.h - PAD_Y) {
        candidate = { ...it };
        guard = 0;
        while (guard++ < 70) {
          const hit = placed.find((p) => rectsOverlap(candidate, p));
          if (!hit) break;
          candidate.y = hit.y - candidate.h - GAP_Y;
          if (candidate.y < PAD_Y) break;
        }
        candidate.y = clamp(candidate.y, PAD_Y, 1 - candidate.h - PAD_Y);
      }

      placed.push(candidate);
    }

    return placed;
  }, [bboxes, imgSize.w, imgSize.h, zoom]);

  // ✅ Хоткеи внутри канвы: Alt+D (clone), стрелки (nudge), Esc (clear)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      // если сейчас тянут bbox — не мешаем
      if (dragRef.current) return;

      const sid = selectedIdRef.current;
      if (!sid) {
        if (e.code === "Escape") onSelectRef.current?.(null);
        return;
      }

      const arr = bboxesRef.current;
      const idx = arr.findIndex((x) => x.id === sid);
      if (idx < 0) return;
      const curr = sanitizeBox(arr[idx]);

      // Esc — снять выбор
      if (e.code === "Escape") {
        onSelectRef.current?.(null);
        return;
      }

      // Alt + D — дубликат выбранного
      if (e.altKey && (e.code === "KeyD" || e.key === "d" || e.key === "D")) {
        e.preventDefault();
        const newId = uid("bbox");
        const clone: BBox = clampBoxToCanvas({
          ...curr,
          id: newId,
          x: clamp01(curr.x + 0.01),
          y: clamp01(curr.y + 0.01)
        });
        const next = [...arr, clone];
        setBoxes(next);
        onSelectRef.current?.(newId);
        requestScrollToBBox(newId);
        return;
      }

      // стрелки — сдвиг выбранного bbox
      const step = e.shiftKey ? 0.02 : 0.005; // Shift быстрее
      let moved: BBox | null = null;

      if (e.code === "ArrowLeft") moved = nudgeBox(curr, -step, 0);
      else if (e.code === "ArrowRight") moved = nudgeBox(curr, step, 0);
      else if (e.code === "ArrowUp") moved = nudgeBox(curr, 0, -step);
      else if (e.code === "ArrowDown") moved = nudgeBox(curr, 0, step);

      if (moved) {
        e.preventDefault();
        const next = arr.map((b) => (b.id === sid ? moved! : b));
        setBoxes(next);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const hint =
    hotkeysHint ??
    [
      "Shift+ЛКМ/средняя — панорама",
      "Колесо — zoom",
      "Esc — снять выбор",
      "Alt+Drag — дублировать bbox",
      "Alt+D — дублировать выбранный",
      "↑↓←→ — сдвиг bbox (Shift быстрее)"
    ].join(" • ");

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden rounded-3xl border border-white/10 bg-ink-950/40"
      onMouseDown={startPan}
    >
      <div data-kind="bg" className="absolute inset-0 bg-grid" onMouseDown={onBackgroundClick} />

      <div
        className="absolute left-1/2 top-1/2"
        style={{ transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)` }}
      >
        <div className="relative" style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}>
          <img
            ref={imgRef}
            src={src}
            alt="photo"
            draggable={false}
            className="block max-w-none select-none pointer-events-none rounded-2xl border border-white/10"
            style={{ userSelect: "none" }}
          />

          {/* Boxes */}
          {bboxes.map((b) => {
            const bb = sanitizeBox(b);
            const isSel = bb.id === selectedId;
            const isManual = isManualBoxId(String(bb.id));

            return (
              <div
                key={String(bb.id)}
                className={cn(
                  "absolute rounded-xl border",
                  isSel
                    ? "border-orange-200/90 shadow-[0_0_0_1px_rgba(255,165,64,.55),0_0_26px_rgba(255,122,24,.35),0_0_90px_rgba(255,122,24,.18)]"
                    : "border-white/25 hover:border-orange-200/45"
                )}
                style={{
                  left: `${bb.x * 100}%`,
                  top: `${bb.y * 100}%`,
                  width: `${bb.w * 100}%`,
                  height: `${bb.h * 100}%`,
                  background: isSel ? "rgba(255,122,24,0.06)" : "transparent",
                  zIndex: isSel ? 55 : 20
                }}
                onMouseDown={(e) => {
                  onBoxMouseDown(e, String(bb.id), "move");
                }}
                title={`Дефект: ${bb.cls} • ${(bb.confidence * 100).toFixed(0)}%${isManual ? " • ручной" : ""}`}
              >
                {/* resize handles */}
                {isSel ? (
                  <>
                    {(["nw", "ne", "sw", "se"] as const).map((h) => (
                      <div
                        key={h}
                        className="absolute h-3.5 w-3.5 rounded-full border border-white/25 bg-orange-400/90"
                        style={{
                          left: h.includes("w") ? "-6px" : "calc(100% - 6px)",
                          top: h.includes("n") ? "-6px" : "calc(100% - 6px)",
                          cursor: h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize"
                        }}
                        onMouseDown={(e) => onBoxMouseDown(e, String(bb.id), "resize", h)}
                        title="Изменить размер"
                      />
                    ))}
                  </>
                ) : null}
              </div>
            );
          })}

          {/* Labels layer (clickable for select) */}
          {labelItems.map((it) => {
            const isSel = it.id === selectedId;

            return (
              <button
                key={`lbl_${it.id}`}
                type="button"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onSelectRef.current?.(it.id);
                  requestScrollToBBox(it.id);
                }}
                className="absolute"
                style={{
                  left: `${it.x * 100}%`,
                  top: `${it.y * 100}%`,
                  width: `${it.w * 100}%`,
                  height: `${it.h * 100}%`,
                  zIndex: isSel ? 80 : 45,
                  pointerEvents: "auto"
                }}
                title="Выбрать дефект"
              >
                <div
                  className={cn(
                    "h-full w-full rounded-2xl border backdrop-blur px-3 py-1.5 flex items-center justify-center",
                    "shadow-[0_18px_55px_rgba(0,0,0,.55)]",
                    isSel ? "border-orange-200/70 bg-orange-500/24" : "border-white/14 bg-black/55"
                  )}
                  style={{ textShadow: "0 1px 2px rgba(0,0,0,.65)" }}
                >
                  <div
                    className={cn(
                      "text-[14px] leading-tight font-semibold",
                      isSel ? "text-white/95" : "text-white/92"
                    )}
                  >
                    {it.text}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* HUD: zoom */}
      <div className="absolute left-4 top-4 flex items-center gap-2 rounded-2xl border border-orange-300/10 bg-orange-500/[0.06] px-3 py-2 backdrop-blur">
        <div className="text-xs text-white/75 tabular-nums">zoom: {(zoom * 100).toFixed(0)}%</div>
        <button
          className="h-8 w-8 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
          onClick={() => setZoom((z) => Math.max(0.15, z * 0.9))}
          title="Уменьшить"
          type="button"
        >
          −
        </button>
        <button
          className="h-8 w-8 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
          onClick={() => setZoom((z) => Math.min(5, z * 1.1))}
          title="Увеличить"
          type="button"
        >
          +
        </button>
        <button
          className="h-8 px-3 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] text-xs text-white/80"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          title="Сброс"
          type="button"
        >
          сброс
        </button>
      </div>

      {/* ✅ компактная подсказка: актуальные хоткеи для канвы */}
      <div className="absolute left-4 top-[74px] rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-white/70 backdrop-blur max-w-[860px]">
        {hint}
      </div>

      {selected ? (
        <div className="absolute left-4 bottom-4 rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-white/70 backdrop-blur">
          Выбрано: <span className="text-orange-200">{selected.cls}</span>
          <span className="text-white/45"> • </span>
          <span className="text-white/60">Alt+Drag / Alt+D — дубликат</span>
        </div>
      ) : null}
    </div>
  );
}
