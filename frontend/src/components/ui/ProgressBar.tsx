// src/components/ui/ProgressBar.tsx
import React, { useMemo } from "react";

type Props = {
  value: number;

  /** высота трека (tailwind), например "h-3" | "h-2.5" | "h-4" */
  heightClassName?: string;

  /** показать проценты справа */
  showLabel?: boolean;

  /** подпись слева (например: "Загрузка") */
  label?: string;

  /** доп. классы контейнера */
  className?: string;
};

export default function ProgressBar({
  value,
  heightClassName = "h-3",
  showLabel = false,
  label,
  className
}: Props) {
  const v = Math.max(0, Math.min(100, value));

  const labelText = useMemo(() => {
    const n = Math.round(v);
    return `${n}%`;
  }, [v]);

  return (
    <div className={["w-full", className ?? ""].join(" ")}>
      {(label || showLabel) ? (
        <div className="mb-2 flex items-center justify-between gap-3">
          {label ? (
            <div className="text-xs font-medium text-white/70 truncate">{label}</div>
          ) : (
            <span />
          )}
          {showLabel ? (
            <div className="text-[11px] font-medium text-white/55 tabular-nums">{labelText}</div>
          ) : null}
        </div>
      ) : null}

      {/* outer gradient frame */}
      <div className="rounded-full p-[1px] bg-[conic-gradient(from_180deg_at_50%_50%,rgba(255,169,0,0.34),rgba(255,255,255,0.08),rgba(255,86,0,0.34),rgba(255,255,255,0.05),rgba(255,169,0,0.34))] shadow-[0_18px_60px_rgba(0,0,0,0.55)]">
        {/* track */}
        <div
          className={[
            "relative w-full overflow-hidden rounded-full",
            "border border-white/10",
            "bg-[#0b101b]/60 backdrop-blur-xl",
            "shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_10px_40px_rgba(0,0,0,0.45)]",
            heightClassName
          ].join(" ")}
        >
          {/* subtle top glow */}
          <div className="pointer-events-none absolute -top-6 left-1/2 h-10 w-[260px] -translate-x-1/2 rounded-full bg-orange-500/10 blur-2xl" />

          {/* fill */}
          <div
            className={[
              "absolute left-0 top-0 h-full",
              "transition-[width] duration-300 ease-out"
            ].join(" ")}
            style={{ width: `${v}%` }}
          >
            {/* base fill */}
            <div className="h-full w-full bg-orange-500/35" />

            {/* rich gradient overlay */}
            <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,164,64,0.08)_0%,rgba(255,122,24,0.42)_35%,rgba(255,210,120,0.22)_70%,rgba(255,122,24,0.34)_100%)]" />

            {/* specular highlight */}
            <div className="pointer-events-none absolute inset-y-0 left-0 right-0 opacity-[0.85]">
              <div className="absolute top-[18%] h-[40%] w-full bg-[linear-gradient(90deg,rgba(255,255,255,0.00)_0%,rgba(255,255,255,0.12)_45%,rgba(255,255,255,0.00)_100%)]" />
            </div>

            {/* moving sheen */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div
                className="absolute -left-1/2 top-0 h-full w-[60%] rotate-[12deg] bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.10),transparent)]"
                style={{ animation: "pb_sheen 1.8s linear infinite" }}
              />
            </div>
          </div>

          {/* tick/inner shadow */}
          <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_-8px_16px_rgba(0,0,0,0.25)_inset]" />

          {/* keep layout height */}
          <div className="relative h-full w-full" />
        </div>
      </div>

      {/* local keyframes (без правок tailwind config) */}
      <style>{`
        @keyframes pb_sheen {
          0% { transform: translateX(-30%) rotate(12deg); opacity: 0.0; }
          15% { opacity: 0.9; }
          55% { opacity: 0.7; }
          100% { transform: translateX(260%) rotate(12deg); opacity: 0.0; }
        }
      `}</style>
    </div>
  );
}
