// src/components/ui/ToastCenter.tsx
import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import BrandLogo from "../../brand/logo-circle.png";

type ToastKind = "success" | "info" | "warn" | "error";
type ToastItem = { id: string; kind: ToastKind; text: string };

let pushFn: ((t: Omit<ToastItem, "id">) => void) | null = null;

export const toast = {
  success: (text: string) => pushFn?.({ kind: "success", text }),
  info: (text: string) => pushFn?.({ kind: "info", text }),
  warn: (text: string) => pushFn?.({ kind: "warn", text }),
  error: (text: string) => pushFn?.({ kind: "error", text })
};

function kindMeta(k: ToastKind) {
  if (k === "success")
    return {
      label: "Успех",
      ring: "ring-emerald-300/30",
      border: "border-emerald-300/30",
      bg: "bg-emerald-500/10",
      dot: "bg-emerald-300/80"
    };
  if (k === "error")
    return {
      label: "Ошибка",
      ring: "ring-red-300/30",
      border: "border-red-300/30",
      bg: "bg-red-500/10",
      dot: "bg-red-300/80"
    };
  if (k === "warn")
    return {
      label: "Предупреждение",
      ring: "ring-yellow-300/25",
      border: "border-yellow-300/25",
      bg: "bg-yellow-500/10",
      dot: "bg-yellow-300/80"
    };
  return {
    label: "Инфо",
    ring: "ring-orange-300/20",
    border: "border-orange-300/20",
    bg: "bg-orange-500/10",
    dot: "bg-orange-300/80"
  };
}

export default function ToastCenter() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    pushFn = (t) => {
      const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const item: ToastItem = { id, ...t };
      setItems((p) => [item, ...p].slice(0, 4));
      window.setTimeout(() => setItems((p) => p.filter((x) => x.id !== id)), 2400);
    };
    return () => {
      pushFn = null;
    };
  }, []);

  return (
    <div className="fixed bottom-5 right-5 z-[9999] w-[420px] max-w-[92vw] pointer-events-none">
      <AnimatePresence>
        {items.map((t) => (
          <ToastCard key={t.id} t={t} reduceMotion={!!reduceMotion} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastCard({ t, reduceMotion }: { t: ToastItem; reduceMotion: boolean }) {
  const meta = useMemo(() => kindMeta(t.kind), [t.kind]);

  return (
    <motion.div
      className="mb-2 pointer-events-none"
      initial={reduceMotion ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 10, scale: 0.985 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.16 }}
    >
      {/* градиентная рамка */}
      <div
        className={[
          "rounded-[20px] p-[1px]",
          "bg-[conic-gradient(from_180deg_at_50%_50%,rgba(255,169,0,0.34),rgba(255,255,255,0.10),rgba(255,86,0,0.34),rgba(255,255,255,0.06),rgba(255,169,0,0.34))]",
          "shadow-[0_25px_90px_rgba(0,0,0,0.62)]"
        ].join(" ")}
      >
        <div
          className={[
            "relative overflow-hidden rounded-[19px] border",
            "bg-[#0b101b]/72 backdrop-blur-2xl",
            "shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_20px_70px_rgba(0,0,0,0.55)]",
            meta.border
          ].join(" ")}
        >
          {/* мягкие подсветки */}
          <div className="pointer-events-none absolute -top-16 left-1/2 h-28 w-[420px] -translate-x-1/2 rounded-full bg-orange-500/10 blur-3xl" />
          <div className="pointer-events-none absolute -top-20 left-1/2 h-32 w-[300px] -translate-x-1/2 rounded-full bg-amber-300/10 blur-3xl" />

          {/* watermark */}
          <img
            src={BrandLogo}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="pointer-events-none absolute -right-10 -bottom-10 w-[200px] rotate-12 opacity-[0.06] select-none"
          />

          <div className="relative flex items-start gap-3 px-4 py-3">
            {/* left: logo + status dot */}
            <div className="relative mt-0.5 shrink-0">
              <div className={["absolute -inset-2 rounded-full blur-lg", meta.bg].join(" ")} />
              <div
                className={[
                  "relative h-10 w-10 rounded-full",
                  "ring-1 ring-white/10",
                  "shadow-[0_10px_30px_rgba(0,0,0,0.45)]",
                  "bg-white/[0.02]"
                ].join(" ")}
              >
                <img
                  src={BrandLogo}
                  alt="Company logo"
                  className="h-10 w-10 rounded-full"
                  draggable={false}
                />
              </div>

              <span
                className={[
                  "absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full",
                  "ring-2 ring-[#0b101b]/80",
                  meta.dot
                ].join(" ")}
              />
            </div>

            {/* center: text */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="text-[11px] uppercase tracking-wider text-white/55">{meta.label}</div>
                <span className="inline-block h-[2px] w-10 rounded-full bg-white/10" />
              </div>

              <div className="mt-1 text-sm text-white/85 leading-snug whitespace-pre-wrap break-words">
                {t.text}
              </div>
            </div>

            {/* right: micro accent */}
            <div className="mt-1 hidden sm:block shrink-0">
              <span
                className={[
                  "inline-flex items-center rounded-full px-2.5 py-1",
                  "border border-white/10 bg-white/[0.03]",
                  "text-[11px] text-white/60",
                  meta.ring
                ].join(" ")}
              >
                {t.kind.toUpperCase()}
              </span>
            </div>
          </div>

          {/* bottom fade */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-[linear-gradient(to_top,rgba(0,0,0,0.22),transparent)]" />
        </div>
      </div>
    </motion.div>
  );
}
