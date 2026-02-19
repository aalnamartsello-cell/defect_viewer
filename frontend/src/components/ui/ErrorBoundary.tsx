// src/components/ui/ErrorBoundary.tsx
import React from "react";
import Button from "./Button";

import BrandLogo from "../../brand/logo-circle.png";

type Props = {
  children: React.ReactNode;
  title?: string;
  onGoHome?: () => void;

  /** показать брендинг (логотип + watermark) */
  showBrand?: boolean;
};

type State = { hasError: boolean; message?: string };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(err: unknown) {
    return { hasError: true, message: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error("UI ErrorBoundary:", error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const showBrand = this.props.showBrand ?? true;

    return (
      <div className="h-full w-full p-6">
        <div
          className={[
            "mx-auto max-w-4xl",
            "rounded-[28px] p-[1px]",
            "bg-[conic-gradient(from_180deg_at_50%_50%,rgba(255,169,0,0.38),rgba(255,255,255,0.10),rgba(255,86,0,0.38),rgba(255,255,255,0.06),rgba(255,169,0,0.38))]",
            "shadow-[0_50px_180px_rgba(0,0,0,0.75)]"
          ].join(" ")}
        >
          <div
            className={[
              "relative overflow-hidden rounded-[27px]",
              "border border-white/10",
              "bg-[#0b101b]/78 backdrop-blur-2xl",
              "shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_30px_120px_rgba(0,0,0,0.55)]",
              "p-6"
            ].join(" ")}
          >
            {/* glows */}
            <div className="pointer-events-none absolute -top-28 left-1/2 h-44 w-[560px] -translate-x-1/2 rounded-full bg-orange-500/12 blur-3xl" />
            <div className="pointer-events-none absolute -top-32 left-1/2 h-48 w-[420px] -translate-x-1/2 rounded-full bg-amber-300/10 blur-3xl" />
            <div className="pointer-events-none absolute inset-0 opacity-[0.65]">
              <div className="absolute -left-24 top-0 h-56 w-[520px] rotate-[10deg] bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.08),transparent)] blur-[1px]" />
            </div>

            {/* watermark */}
            {showBrand ? (
              <img
                src={BrandLogo}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute -right-12 -bottom-12 w-[320px] rotate-12 opacity-[0.06] select-none"
                draggable={false}
              />
            ) : null}

            {/* header */}
            <div className="relative flex items-start gap-4">
              {showBrand ? (
                <div className="relative mt-0.5 h-12 w-12 shrink-0">
                  <div className="absolute inset-0 rounded-full bg-orange-500/20 blur-md" />
                  <img
                    src={BrandLogo}
                    alt="Company logo"
                    className="relative h-12 w-12 rounded-full ring-1 ring-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
                    draggable={false}
                  />
                </div>
              ) : null}

              <div className="min-w-0 flex-1">
                <div className="text-lg md:text-xl font-semibold text-white/90">
                  {this.props.title ?? "Произошла ошибка на странице"}
                </div>
                <div className="mt-1 text-sm text-white/60">
                  Если при переходе “не происходит ничего” — это обычно из-за ошибки рендера. Сообщение:
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <span className="inline-block h-[2px] w-16 rounded-full bg-orange-300/25" />
                  <span className="inline-block h-[2px] w-8 rounded-full bg-white/10" />
                </div>
              </div>

              <div className="hidden md:flex items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-white/65">
                  Error Boundary
                </span>
              </div>
            </div>

            {/* message panel */}
            <div className="relative mt-5 rounded-2xl border border-white/10 bg-black/25 p-4">
              <div className="text-[11px] uppercase tracking-wider text-white/45">Details</div>
              <div className="mt-2 text-xs text-white/80 whitespace-pre-wrap">
                {this.state.message || "—"}
              </div>
            </div>

            {/* actions */}
            <div className="relative mt-5 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => window.location.reload()}>
                Перезагрузить
              </Button>
              <Button onClick={() => this.props.onGoHome?.()}>На загрузку</Button>
            </div>

            {/* bottom fade */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-[linear-gradient(to_top,rgba(0,0,0,0.22),transparent)]" />
          </div>
        </div>
      </div>
    );
  }
}
