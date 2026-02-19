// src/components/ui/Modal.tsx
import React, { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";

import BrandLogo from "../../brand/logo-circle.png";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;

  /** скрыть крестик */
  hideCloseButton?: boolean;

  /** клик по фону закрывает */
  closeOnBackdrop?: boolean;

  /** макс ширина панели (tailwind класс), например: "max-w-[760px]" */
  maxWidthClassName?: string;

  /** доп. классы панели */
  className?: string;

  /** показывать бренд (логотип + водяной знак) */
  showBrand?: boolean;
};

export default function Modal({
  open,
  onClose,
  title,
  children,
  hideCloseButton,
  closeOnBackdrop = true,
  maxWidthClassName,
  className,
  showBrand = true
}: ModalProps) {
  const root = useMemo(() => (typeof document !== "undefined" ? document.body : null), []);
  const reduceMotion = useReducedMotion();

  const titleId = useMemo(() => `modal_title_${Math.random().toString(16).slice(2)}`, []);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    window.addEventListener("keydown", onKey);

    // Лочим скролл body, чтобы фон не ездил
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!root) return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[1000] flex items-center justify-center p-4"
          initial={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
        >
          {/* Backdrop */}
          <motion.button
            type="button"
            aria-label="close"
            onClick={() => closeOnBackdrop && onClose()}
            className={[
              "absolute inset-0",
              // чуть “дороже” чем просто bg-black/70: легкая виньетка + блюр
              "bg-black/70",
              "backdrop-blur-[6px]",
              "after:pointer-events-none after:absolute after:inset-0",
              "after:bg-[radial-gradient(ellipse_at_center,rgba(255,174,64,0.10),rgba(0,0,0,0.62)_55%,rgba(0,0,0,0.86)_100%)]"
            ].join(" ")}
            initial={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
          />

          {/* рамка-градиент */}
          <motion.div
            className={[
              "relative w-full",
              maxWidthClassName ?? "max-w-[760px]",
              "rounded-[28px]",
              "p-[1px]",
              "bg-[conic-gradient(from_180deg_at_50%_50%,rgba(255,169,0,0.40),rgba(255,255,255,0.10),rgba(255,86,0,0.40),rgba(255,255,255,0.06),rgba(255,169,0,0.40))]",
              "shadow-[0_50px_180px_rgba(0,0,0,0.82)]",
              className ?? ""
            ].join(" ")}
            initial={
              reduceMotion
                ? { opacity: 1, scale: 1, y: 0 }
                : { opacity: 0, scale: 0.985, y: 18 }
            }
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 1 } : { opacity: 0, scale: 0.99, y: 10 }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 22 }}
          >
            {/* Panel */}
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={title ? titleId : undefined}
              className={[
                "relative overflow-hidden rounded-[27px]",
                // “стекло”
                "bg-[#0b101b]/88 backdrop-blur-2xl",
                // внутренняя рамка
                "border border-white/10",
                // мягкая тень + внутренняя
                "shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_30px_120px_rgba(0,0,0,0.55)]",
                "outline-none"
              ].join(" ")}
            >
              {/* ambient glows */}
              <div className="pointer-events-none absolute -top-28 left-1/2 h-44 w-[560px] -translate-x-1/2 rounded-full bg-orange-500/12 blur-3xl" />
              <div className="pointer-events-none absolute -top-32 left-1/2 h-48 w-[420px] -translate-x-1/2 rounded-full bg-amber-300/10 blur-3xl" />

              {/* subtle “shine” */}
              <div className="pointer-events-none absolute inset-0 opacity-[0.65]">
                <div className="absolute -left-24 top-0 h-56 w-[520px] rotate-[10deg] bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.08),transparent)] blur-[1px]" />
              </div>

              {/* watermark */}
              {showBrand ? (
                <img
                  src={BrandLogo}
                  alt=""
                  aria-hidden="true"
                  className="pointer-events-none absolute -right-10 -bottom-10 w-[280px] rotate-12 opacity-[0.06] select-none"
                />
              ) : null}

              {(title || !hideCloseButton || showBrand) ? (
                <div className="relative px-6 py-4 border-b border-white/10">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {showBrand ? (
                        <div className="relative h-10 w-10 shrink-0">
                          <div className="absolute inset-0 rounded-full bg-orange-500/20 blur-md" />
                          <img
                            src={BrandLogo}
                            alt="Company logo"
                            className="relative h-10 w-10 rounded-full ring-1 ring-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
                            draggable={false}
                          />
                        </div>
                      ) : null}

                      <div className="min-w-0">
                        {title ? (
                          <div
                            id={titleId}
                            className="text-[15px] md:text-base font-semibold text-white/90 truncate"
                          >
                            {title}
                          </div>
                        ) : (
                          <div className="text-[15px] md:text-base font-semibold text-white/80 truncate">
                            {/* если нет title — оставим аккуратный “брендовый” заголовок */}
                            {showBrand ? " " : ""}
                          </div>
                        )}

                        <div className="text-[11px] md:text-xs text-white/45 mt-1">
                          <span className="inline-flex items-center gap-2">
                            <span className="inline-block h-[2px] w-14 rounded-full bg-orange-300/25 align-middle" />
                            <span className="inline-block h-[2px] w-6 rounded-full bg-white/10 align-middle" />
                          </span>
                        </div>
                      </div>
                    </div>

                    {!hideCloseButton ? (
                      <button
                        type="button"
                        onClick={onClose}
                        className={[
                          "h-9 w-9 shrink-0 rounded-2xl",
                          "border border-white/10 bg-white/[0.03]",
                          "hover:bg-white/[0.06] active:bg-white/[0.08] transition",
                          "flex items-center justify-center",
                          "shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
                        ].join(" ")}
                        aria-label="close"
                        title="Закрыть"
                      >
                        <X className="h-4 w-4 text-white/75" />
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="relative p-6">
                {/* контент */}
                {children}
              </div>

              {/* bottom fade */}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-[linear-gradient(to_top,rgba(0,0,0,0.28),transparent)]" />
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    root
  );
}
