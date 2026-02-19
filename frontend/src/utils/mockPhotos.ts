// src/utils/mockPhotos.ts
import type { PhotoItem, BBox } from "../types";
import { DEFECT_CLASSES } from "../constants/defects";
import { uid } from "./id";

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function makeGradientPlaceholder(index: number, w = 1800, h = 1100) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const hue = (index * 19) % 360;

  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue}, 60%, 16%)`);
  g.addColorStop(1, `hsl(${(hue + 50) % 360}, 60%, 12%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  for (let i = 0; i < 900; i++) ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);

  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(60, h - 250, 620, 170);

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "700 70px system-ui, -apple-system, Segoe UI, Roboto";
  ctx.fillText("ДЕМО ФОТО", 90, h - 150);

  ctx.fillStyle = "rgba(255,122,24,0.95)";
  ctx.font = "700 38px system-ui, -apple-system, Segoe UI, Roboto";
  ctx.fillText(`#${String(index + 1).padStart(3, "0")}`, 90, h - 100);

  return c.toDataURL("image/png");
}

function mockBBoxes(): BBox[] {
  const n = Math.floor(rand(1, 5));
  const out: BBox[] = [];
  for (let i = 0; i < n; i++) {
    const w = rand(0.12, 0.35);
    const h = rand(0.10, 0.30);
    const x = rand(0.03, 1 - w - 0.03);
    const y = rand(0.03, 1 - h - 0.03);
    out.push({
      id: uid("bbox"),
      x,
      y,
      w,
      h,
      cls: DEFECT_CLASSES[Math.floor(Math.random() * DEFECT_CLASSES.length)],
      confidence: rand(0.55, 0.95)
    });
  }
  return out;
}

export function makeMockPhotosFromCount(count: number): PhotoItem[] {
  return Array.from({ length: count }).map((_, i) => ({
    id: uid("p"),
    name: `IMG_${String(i + 1).padStart(4, "0")}.jpg`,
    src: makeGradientPlaceholder(i),
    bboxes: mockBBoxes(),
    srcIsObjectUrl: false
  }));
}

export async function makePhotosFromFiles(files: File[]): Promise<PhotoItem[]> {
  return files.map((f, i) => ({
    id: uid("p"),
    name: f.name || `IMG_${String(i + 1).padStart(4, "0")}.jpg`,
    src: URL.createObjectURL(f),
    bboxes: mockBBoxes(),
    srcIsObjectUrl: true
  }));
}
