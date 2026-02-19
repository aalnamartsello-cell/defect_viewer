// src/components/PhotoProgress.tsx
import React, { useMemo } from "react";
import ProgressBar from "./ui/ProgressBar";
import { useAppStore } from "../store/useAppStore";

export default function PhotoProgress() {
  const { photos, activeIndex, decisionByPhoto } = useAppStore();

  const stats = useMemo(() => {
    const items = photos ?? [];
    const total = items.length;

    const idx = Math.max(0, Math.min(activeIndex ?? 0, Math.max(total - 1, 0)));

    const decisions = decisionByPhoto ?? {};
    const done = items.reduce((acc, p) => acc + (decisions[p.id] ? 1 : 0), 0);

    const pct = total ? Math.round((done / total) * 100) : 0;

    return { total, idx, done, pct };
  }, [photos, activeIndex, decisionByPhoto]);

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-white/85 font-semibold">Прогресс</div>
        <div className="text-xs text-white/55 tabular-nums">
          {stats.done}/{stats.total}
        </div>
      </div>

      <div className="mt-3">
        <ProgressBar value={stats.pct} />
      </div>

      <div className="mt-2 text-xs text-white/55 tabular-nums">
        Текущее фото: {stats.total ? stats.idx + 1 : 0}/{stats.total}
      </div>
    </div>
  );
}
