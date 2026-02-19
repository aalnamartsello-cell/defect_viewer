// src/App.tsx
import React, { useEffect, useMemo, useRef } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import AppHeader from "./components/AppHeader";
import UploadPage from "./pages/UploadPage";
import GalleryPage from "./pages/GalleryPage";
import ViewerPage from "./pages/ViewerPage";
import SummaryPage from "./pages/SummaryPage";
import AdminPage from "./pages/AdminPage";

import ToastCenter from "./components/ui/ToastCenter";
import ErrorBoundary from "./components/ui/ErrorBoundary";

import bgUpload from "./brand/upload-bg.png";
import bgEnergy from "./brand/bg-energy.png";

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export default function App() {
  const nav = useNavigate();
  const loc = useLocation();

  // Route-based background (дороже: разные “настроения” под страницы)
  const bgImage = useMemo(() => {
    const p = loc.pathname || "";
    if (p.startsWith("/upload")) return bgEnergy;
    return bgUpload;
  }, [loc.pathname]);

  // Global cursor energy + parallax
  const rafRef = useRef<number | null>(null);
  const target = useRef({ x: -999, y: -999 });
  const trail = useRef({ x: -999, y: -999 });

  useEffect(() => {
    const root = document.documentElement;

    const onMove = (e: MouseEvent) => {
      target.current.x = e.clientX;
      target.current.y = e.clientY;

      const px = (e.clientX / window.innerWidth - 0.5) * 14;
      const py = (e.clientY / window.innerHeight - 0.5) * 10;
      root.style.setProperty("--px", `${px}px`);
      root.style.setProperty("--py", `${py}px`);
    };

    const tick = () => {
      trail.current.x = lerp(trail.current.x, target.current.x, 0.12);
      trail.current.y = lerp(trail.current.y, target.current.y, 0.12);

      root.style.setProperty("--mx", `${target.current.x}px`);
      root.style.setProperty("--my", `${target.current.y}px`);
      root.style.setProperty("--mx2", `${trail.current.x}px`);
      root.style.setProperty("--my2", `${trail.current.y}px`);

      rafRef.current = window.requestAnimationFrame(tick);
    };

    window.addEventListener("mousemove", onMove);
    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", onMove);
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div className="app-shell" style={{ ["--app-bg-image" as any]: `url(${bgImage})` }}>
      {/* background stack */}
      <div className="app-bg-layer" aria-hidden />
      <div className="app-bg-aurora" aria-hidden />
      <div className="app-bg-grain" aria-hidden />
      <div className="app-bg-specular" aria-hidden />

      {/* cursor glow */}
      <div className="cursor-energy" aria-hidden>
        <div className="energy-trail" />
        <div className="energy-halo" />
        <div className="energy-core" />
        <div className="energy-wave w1" />
        <div className="energy-wave w2" />
        <div className="energy-wave w3" />
      </div>

      {/* toasts */}
      <ToastCenter />

      {/* layout */}
      <div className="app-scroll">
        <AppHeader onHome={() => nav("/upload")} />

        <div className="app-main">
          <ErrorBoundary onGoHome={() => nav("/upload")}>
            <div key={loc.pathname} className="page-fade">
              <Routes>
                <Route path="/" element={<Navigate to="/upload" replace />} />
                <Route path="/upload" element={<UploadPage />} />
                <Route path="/gallery" element={<GalleryPage />} />
                <Route path="/viewer" element={<ViewerPage />} />
                <Route path="/summary" element={<SummaryPage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route path="*" element={<Navigate to="/upload" replace />} />
              </Routes>
            </div>
          </ErrorBoundary>

          <footer className="app-footer">Управление развития новых проектов</footer>
        </div>
      </div>
    </div>
  );
}
