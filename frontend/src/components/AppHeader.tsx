// src/components/AppHeader.tsx
import React, { useMemo, useRef } from "react";
import { Upload, Eye, BarChart3, Grid3X3, Shield } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import logo from "../brand/logo.png";
import logoCircle from "../brand/logo-circle.png";
import { useAppStore } from "../store/useAppStore";

type Props = { onHome: () => void };

const QUICK = [
  { key: "upload", label: "Загрузка", to: "/upload", Icon: Upload },
  { key: "gallery", label: "Галерея", to: "/gallery", Icon: Grid3X3 },
  { key: "viewer", label: "Просмотр", to: "/viewer", Icon: Eye },
  { key: "summary", label: "Итог", to: "/summary", Icon: BarChart3 },
  { key: "admin", label: "Админка", to: "/admin", Icon: Shield },
] as const;

export default function AppHeader({ onHome }: Props) {
  const nav = useNavigate();
  const loc = useLocation();

  // keep store usage (side effects / future)
  useAppStore();

  const dockRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastX = useRef<number>(0);
  const lastY = useRef<number>(0);

  const active = (path: string) => loc.pathname.startsWith(path);

  const accentFor = (to: string) => {
    if (active("/admin") && to === "/admin") return "from-orange-400/18 via-orange-300/8 to-white/[0.02]";
    if (active("/viewer") && to === "/viewer") return "from-orange-400/16 via-white/[0.03] to-white/[0.01]";
    if (active("/summary") && to === "/summary") return "from-amber-300/14 via-white/[0.03] to-white/[0.01]";
    if (active("/gallery") && to === "/gallery") return "from-white/[0.035] via-white/[0.02] to-white/[0.01]";
    if (active("/upload") && to === "/upload") return "from-orange-500/10 via-white/[0.02] to-white/[0.01]";
    return "from-white/[0.02] via-transparent to-white/[0.02]";
  };

  const ribbonClass = active("/admin")
    ? "from-orange-300/45 via-orange-200/20 to-transparent"
    : active("/viewer")
    ? "from-orange-300/32 via-white/[0.04] to-transparent"
    : active("/summary")
    ? "from-amber-300/26 via-white/[0.04] to-transparent"
    : active("/gallery")
    ? "from-white/[0.06] via-white/[0.028] to-transparent"
    : "from-orange-500/18 via-white/[0.028] to-transparent";

  const onDockMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = dockRef.current;
    if (!el) return;

    const r = el.getBoundingClientRect();
    lastX.current = e.clientX - r.left;
    lastY.current = e.clientY - r.top;

    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const node = dockRef.current;
      if (!node) return;
      node.style.setProperty("--mx", `${lastX.current}px`);
      node.style.setProperty("--my", `${lastY.current}px`);
    });
  };

  const onDockLeave = () => {
    const el = dockRef.current;
    if (!el) return;
    el.style.setProperty("--mx", "50%");
    el.style.setProperty("--my", "50%");
  };

  return (
    <div className="sticky top-0 z-50 w-full">
      <div className="relative w-full border-b border-white/10 bg-ink-900/10 backdrop-blur-3xl">
        {/* aurora only (NO grid) */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-28 left-6 h-72 w-72 rounded-full bg-orange-500/5 blur-3xl" />
          <div className="absolute -top-32 right-16 h-80 w-80 rounded-full bg-amber-300/4 blur-3xl" />
          <div className="absolute -bottom-40 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-white/[0.014] blur-3xl" />
          <div className="absolute inset-0 bg-gradient-to-r from-white/[0.010] via-transparent to-white/[0.010]" />
          <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-white/[0.02] to-transparent" />
        </div>

        {/* centered logo as overlay */}
        <button
          onClick={onHome}
          type="button"
          title="На загрузку"
          className="hidden xl:flex absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 items-center justify-center z-10"
          style={{ width: "min(420px, 32vw)" }}
        >
          <div className="relative w-full flex items-center justify-center">
            <div
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                background: "radial-gradient(55% 70% at 50% 50%, rgba(255,255,255,0.032), transparent 70%)",
                maskImage: "radial-gradient(60% 75% at 50% 50%, black 55%, transparent 100%)",
                WebkitMaskImage: "radial-gradient(60% 75% at 50% 50%, black 55%, transparent 100%)",
              }}
            />
            <img src={logo} alt="logo" className="relative h-9 object-contain opacity-90" />
          </div>
        </button>

        <div className="relative h-[60px] px-4 flex items-center justify-between gap-3">
          {/* LEFT */}
          <div className="flex items-center gap-3 min-w-0">
            <button className="group flex items-center gap-3 min-w-0" onClick={onHome} title="Перейти к загрузке" type="button">
              <div className="relative rounded-[18px] p-[2px] bg-gradient-to-br from-orange-500/14 via-white/[0.03] to-white/[0.018] shadow-[0_0_0_1px_rgba(255,122,24,.05),0_14px_45px_rgba(0,0,0,0.22)]">
                <div className="relative h-10 w-10 rounded-[16px] border border-white/10 bg-black/8 flex items-center justify-center overflow-hidden shrink-0">
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-orange-500/10 via-transparent to-white/[0.02]" />
                  <div className="pointer-events-none absolute -inset-10 opacity-0 group-hover:opacity-100 transition duration-500">
                    <div className="absolute inset-0 rounded-[22px] bg-orange-300/7 blur-2xl" />
                  </div>
                  <img
                    src={logoCircle}
                    alt="logo-circle"
                    className="relative h-10 w-10 object-contain opacity-95"
                    onError={(e) => (((e.currentTarget as HTMLImageElement).src = logo))}
                  />
                </div>
              </div>

              <div className="hidden sm:block min-w-0">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-semibold text-white/90 truncate leading-tight">Defect Analyzer</div>

                  {/* premium blinking live */}
                  <div className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.028] px-2 py-1 text-[10px] text-white/70">
                    <span className="relative inline-flex h-2.5 w-2.5 items-center justify-center">
                      <span className="absolute h-2.5 w-2.5 rounded-full bg-orange-300/55 animate-[pingSoft_1.2s_ease-in-out_infinite]" />
                      <span className="relative h-1.5 w-1.5 rounded-full bg-orange-200 animate-[blink_1s_ease-in-out_infinite]" />
                    </span>
                    live
                  </div>
                </div>
              </div>
            </button>
          </div>

          {/* RIGHT */}
          <div className="flex items-center gap-2.5">
            {/* Dock */}
            <div
              ref={dockRef}
              className={[
                "dock-spotlight",
                "hidden lg:flex items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.010] p-1 backdrop-blur",
                "shadow-[0_14px_50px_rgba(0,0,0,0.18)] overflow-hidden",
              ].join(" ")}
              onMouseMove={onDockMove}
              onMouseLeave={onDockLeave}
            >
              {QUICK.map((x) => {
                const isOn = active(x.to);

                return (
                  <button
                    key={x.key}
                    type="button"
                    onClick={() => nav(x.to)}
                    className={[
                      "group relative flex items-center gap-2 rounded-xl px-2.5 py-2 text-[12px] font-medium transition select-none",
                      isOn ? "text-white" : "text-white/70 hover:text-white/90",
                    ].join(" ")}
                    title={x.label}
                  >
                    {isOn ? (
                      <span className="pointer-events-none absolute inset-0 rounded-xl overflow-hidden">
                        <span className={["absolute inset-0 bg-gradient-to-br", accentFor(x.to)].join(" ")} />
                        <span className="absolute inset-0 bg-white/[0.02]" />
                        <span className="absolute -inset-8 bg-orange-300/8 blur-2xl" />
                        <span className="absolute -left-10 top-0 h-full w-24 rotate-12 bg-white/[0.05] blur-md opacity-70 animate-[shimmer_2.8s_ease-in-out_infinite]" />
                      </span>
                    ) : null}

                    <span
                      className={[
                        "relative inline-flex h-7 w-7 items-center justify-center rounded-xl border transition",
                        isOn
                          ? "border-orange-300/35 bg-orange-500/10"
                          : "border-white/10 bg-black/8 group-hover:bg-white/[0.035]",
                      ].join(" ")}
                    >
                      <x.Icon className={["h-4 w-4", isOn ? "text-orange-100" : "text-white/80"].join(" ")} />
                    </span>

                    <span className="relative">{x.label}</span>
                  </button>
                );
              })}
            </div>

            {/* compact quick (mobile/tablet) */}
            <div className="flex lg:hidden items-center gap-1.5">
              {QUICK.map((x) => {
                const isOn = active(x.to);
                return (
                  <button
                    key={x.key}
                    type="button"
                    onClick={() => nav(x.to)}
                    title={x.label}
                    className={[
                      "relative h-10 w-10 rounded-2xl border transition flex items-center justify-center overflow-hidden",
                      isOn
                        ? "border-orange-300/55 bg-orange-500/18 text-orange-100"
                        : "border-white/10 bg-white/[0.03] text-white/70 hover:bg-white/[0.06]",
                    ].join(" ")}
                  >
                    {isOn ? (
                      <span className="pointer-events-none absolute inset-0 opacity-80">
                        <span className={["absolute inset-0 bg-gradient-to-br", accentFor(x.to)].join(" ")} />
                        <span className="absolute -inset-6 bg-orange-300/10 blur-2xl" />
                      </span>
                    ) : null}
                    <span className="relative opacity-95">
                      <x.Icon className="h-4 w-4" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-orange-300/12 to-transparent" />
      </div>

      {/* route ribbon */}
      <div className="pointer-events-none h-[3px] w-full bg-black/10">
        <div className={["h-full w-full bg-gradient-to-r", ribbonClass].join(" ")} />
      </div>

      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-30px) rotate(12deg); opacity: .0; }
          20% { opacity: .55; }
          55% { opacity: .18; }
          100% { transform: translateX(520px) rotate(12deg); opacity: 0; }
        }
        @keyframes blink {
          0%, 100% { opacity: .25; filter: saturate(0.9); }
          50% { opacity: 1; filter: saturate(1.1); }
        }
        @keyframes pingSoft {
          0% { transform: scale(.65); opacity: .0; }
          30% { opacity: .45; }
          100% { transform: scale(1.65); opacity: 0; }
        }

        /* Dock spotlight */
        .dock-spotlight {
          --mx: 50%;
          --my: 50%;
          position: relative;
        }
        .dock-spotlight::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          opacity: 0.58;
          background: radial-gradient(240px 140px at var(--mx) var(--my), rgba(255,255,255,0.075), transparent 70%);
          transition: opacity 160ms ease;
        }
        .dock-spotlight:hover::before { opacity: 1; }
      `}</style>
    </div>
  );
}
