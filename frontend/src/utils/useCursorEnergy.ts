// src/utils/useCursorEnergy.ts
import { useEffect } from "react";

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function useCursorEnergy() {
  useEffect(() => {
    const root = document.documentElement;

    let x = -999,
      y = -999; // мгновенная позиция
    let tx = -999,
      ty = -999; // шлейф (lag)
    let raf = 0;

    const onMove = (e: MouseEvent) => {
      x = e.clientX;
      y = e.clientY;
    };

    const tick = () => {
      // старт без прыжка
      if (tx < -900) {
        tx = x;
        ty = y;
      }

      // шлейф (плавно догоняет)
      tx += (x - tx) * 0.12;
      ty += (y - ty) * 0.12;

      root.style.setProperty("--mx", `${x}px`);
      root.style.setProperty("--my", `${y}px`);
      root.style.setProperty("--mx2", `${tx}px`);
      root.style.setProperty("--my2", `${ty}px`);

      // parallax (мягкий)
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      const nx = clamp((x / w - 0.5) * 2, -1, 1); // -1..1
      const ny = clamp((y / h - 0.5) * 2, -1, 1);
      root.style.setProperty("--px", `${nx * 18}px`);
      root.style.setProperty("--py", `${ny * 10}px`);

      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);
}
