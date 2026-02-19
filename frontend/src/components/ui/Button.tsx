// src/components/ui/Button.tsx
import React, { useMemo } from "react";
import { cn } from "../../utils/cn";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md";
  leftIcon?: React.ReactNode;

  /** показывать маленький логотип слева от текста (по умолчанию: только в primary) */
  showBrandIcon?: boolean;
};

import BrandLogo from "../../brand/logo-circle.png";

export default function Button({
  variant = "secondary",
  size = "md",
  leftIcon,
  className,
  showBrandIcon,
  ...rest
}: Props) {
  const base =
    "group relative inline-flex items-center justify-center gap-2 rounded-2xl border transition select-none " +
    "disabled:opacity-40 disabled:pointer-events-none " +
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/35 focus-visible:ring-offset-0";

  const sizes =
    size === "sm"
      ? "px-3 py-2 text-xs"
      : "px-4 py-2.5 text-sm";

  const showBrand = useMemo(() => {
    if (typeof showBrandIcon === "boolean") return showBrandIcon;
    return variant === "primary";
  }, [showBrandIcon, variant]);

  const v =
    variant === "primary"
      ? cn(
          // gradient frame
          "border-transparent",
          "bg-[conic-gradient(from_180deg_at_50%_50%,rgba(255,169,0,0.44),rgba(255,255,255,0.14),rgba(255,86,0,0.44),rgba(255,255,255,0.08),rgba(255,169,0,0.44))]",
          "shadow-[0_18px_70px_rgba(0,0,0,0.55)]"
        )
      : variant === "danger"
      ? cn(
          "border-red-300/25",
          "bg-red-500/10 hover:bg-red-500/16",
          "shadow-[0_18px_60px_rgba(0,0,0,0.40)]"
        )
      : cn(
          "border-white/12",
          "bg-white/[0.03] hover:bg-white/[0.06]",
          "shadow-[0_18px_60px_rgba(0,0,0,0.35)]"
        );

  // внутренняя “панель” для primary (чтобы выглядело как дорогая кнопка с рамкой)
  const inner =
    variant === "primary"
      ? cn(
          "absolute inset-[1px] rounded-[15px]",
          "bg-[#0b101b]/70 backdrop-blur-2xl",
          "shadow-[0_1px_0_rgba(255,255,255,0.08)_inset,0_16px_45px_rgba(0,0,0,0.50)]",
          "transition",
          "group-hover:bg-[#0b101b]/62"
        )
      : null;

  const content =
    variant === "primary"
      ? cn(
          "relative z-[1] flex items-center justify-center gap-2",
          "text-white/92"
        )
      : cn(
          "relative z-[1] flex items-center justify-center gap-2",
          variant === "danger" ? "text-white/85" : "text-white/85"
        );

  const brandNode = showBrand ? (
    <span className="relative -ml-0.5 inline-flex items-center">
      <span className="absolute -inset-2 rounded-full bg-orange-500/18 blur-md opacity-90" />
      <img
        src={BrandLogo}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn(
          "relative rounded-full ring-1 ring-white/10",
          "shadow-[0_10px_26px_rgba(0,0,0,0.40)]",
          size === "sm" ? "h-4 w-4" : "h-[18px] w-[18px]"
        )}
      />
    </span>
  ) : null;

  return (
    <button className={cn(base, sizes, v, className)} {...rest}>
      {/* inner glass (only primary) */}
      {inner ? <span aria-hidden="true" className={inner} /> : null}

      {/* subtle sheen */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 overflow-hidden rounded-2xl",
          "opacity-70"
        )}
      >
        <span
          className={cn(
            "absolute -left-1/2 top-0 h-full w-[60%] rotate-[12deg]",
            "bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.10),transparent)]",
            "translate-x-[-30%] group-hover:translate-x-[260%]",
            "transition-transform duration-[900ms] ease-out"
          )}
        />
      </span>

      <span className={content}>
        {leftIcon ? leftIcon : brandNode}
        {rest.children}
      </span>
    </button>
  );
}
