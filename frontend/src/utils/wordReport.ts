// src/utils/wordReport.ts
import type { PhotoItem, OperatorDecision, BBox } from "../types";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ImageRun,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";

function safeText(x: unknown, fallback = "—") {
  const s = String(x ?? "").trim();
  return s ? s : fallback;
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Не удалось загрузить картинку для эскиза"));
    img.src = url;
  });
}

// Делает один “эскиз”: набор вырезок bbox, сложенных вертикально
async function makeDefectSketchPngBytes(src: string, bboxes: BBox[]): Promise<Uint8Array | null> {
  if (!bboxes.length) return null;

  // если bbox слишком много — ограничим, чтобы Word не раздувался
  const boxes = bboxes.slice(0, 6);

  try {
    const img = await loadImage(src);
    const iw = img.naturalWidth || 1;
    const ih = img.naturalHeight || 1;

    const targetW = 260; // px (в Word будет масштабироваться)
    const gap = 10;

    // сначала считаем размеры всех кропов
    const crops = boxes.map((b) => {
      const x = Math.floor(clamp01(b.x) * iw);
      const y = Math.floor(clamp01(b.y) * ih);
      const w = Math.max(1, Math.floor(clamp01(b.w) * iw));
      const h = Math.max(1, Math.floor(clamp01(b.h) * ih));

      // небольшой отступ вокруг кропа
      const pad = 10;
      const x0 = Math.max(0, x - pad);
      const y0 = Math.max(0, y - pad);
      const x1 = Math.min(iw, x + w + pad);
      const y1 = Math.min(ih, y + h + pad);

      const cw = Math.max(1, x1 - x0);
      const ch = Math.max(1, y1 - y0);

      const scale = targetW / cw;
      const outH = Math.max(60, Math.round(ch * scale));

      return { x0, y0, cw, ch, outH, label: `${b.cls} • ${Math.round(b.confidence * 100)}%` };
    });

    const totalH = crops.reduce((acc, c) => acc + c.outH, 0) + gap * (crops.length - 1) + 10;

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = totalH;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // фон
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let y = 5;
    for (const c of crops) {
      // рамка
      ctx.fillStyle = "#f3f3f3";
      ctx.fillRect(0, y, targetW, c.outH);

      // кроп
      ctx.drawImage(img, c.x0, c.y0, c.cw, c.ch, 0, y, targetW, c.outH);

      // подпись
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.font = "14px Arial";
      ctx.fillText(c.label, 8, y + 18);

      y += c.outH + gap;
    }

    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b as Blob), "image/png"));
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
  } catch {
    // например, canvas tainted из-за CORS — тогда без эскиза
    return null;
  }
}

function cellBorders() {
  return {
    top: { style: BorderStyle.SINGLE, size: 1, color: "666666" },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: "666666" },
    left: { style: BorderStyle.SINGLE, size: 1, color: "666666" },
    right: { style: BorderStyle.SINGLE, size: 1, color: "666666" }
  };
}

function headerCell(text: string) {
  return new TableCell({
    borders: cellBorders(),
    width: { size: 1, type: WidthType.AUTO },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text, bold: true })]
      })
    ]
  });
}

function bodyCell(children: Paragraph[], widthPct?: number) {
  return new TableCell({
    borders: cellBorders(),
    width: widthPct ? { size: widthPct, type: WidthType.PERCENTAGE } : undefined,
    children
  });
}

export async function buildDefectReportDocx(args: {
  photos: PhotoItem[];
  decisions: Record<string, OperatorDecision | undefined>;
}): Promise<Blob> {
  const { photos, decisions } = args;

  const defectPhotos = (photos ?? []).filter((p) => decisions[p.id]?.type === "defect") as PhotoItem[];

  const now = new Date();
  const stamp = `${now.toLocaleDateString("ru-RU")} ${now.toLocaleTimeString("ru-RU")}`;

  const title = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "Дефектная ведомость", bold: true, size: 28 })]
  });

  const subtitle = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: `Сформировано: ${stamp}`, size: 18 })]
  });

  const header = new TableRow({
    children: [
      headerCell("№\nп/п"),
      headerCell("Расположение"),
      headerCell("Фото (эскиз)"),
      headerCell("Описание"),
      headerCell("Категория"),
      headerCell("Рекомендуемый\nспособ\nустранения")
    ]
  });

  const rows: TableRow[] = [header];

  for (let i = 0; i < defectPhotos.length; i++) {
    const p = defectPhotos[i];
    const d = decisions[p.id];
    if (!d || d.type !== "defect") continue;

    const bboxes = p.bboxes ?? [];

    // ✅ делаем эскиз по bbox (вырезки)
    const sketchBytes = await makeDefectSketchPngBytes(p.src, bboxes);

    const sketchPara = sketchBytes
      ? [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                data: sketchBytes,
                transformation: {
                  width: 240,
                  height: 160 // Word сам будет выглядеть нормально, это “окно” в ячейке
                }
              })
            ]
          })
        ]
      : [new Paragraph({ children: [new TextRun({ text: "(нет эскиза)" })] })];

    // Описание: сначала комментарий, потом дефекты списком
    const descParas: Paragraph[] = [];
    const comment = safeText(d.comment, "—");
    if (comment !== "—") {
      descParas.push(new Paragraph({ children: [new TextRun({ text: comment })] }));
      descParas.push(new Paragraph({ text: "" }));
    }

    descParas.push(new Paragraph({ children: [new TextRun({ text: "Дефекты:", bold: true })] }));

    if (!bboxes.length) {
      descParas.push(new Paragraph({ children: [new TextRun({ text: "—" })] }));
    } else {
      for (const b of bboxes) {
        const pct = Math.round((b.confidence ?? 0) * 100);
        descParas.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [new TextRun({ text: `${b.cls} (${pct}%)` })]
          })
        );
      }
    }

    const row = new TableRow({
      children: [
        bodyCell([new Paragraph({ children: [new TextRun({ text: String(i + 1) })] })], 6),
        bodyCell([new Paragraph({ children: [new TextRun({ text: safeText(d.place) })] })], 16),
        bodyCell(sketchPara, 18),
        bodyCell(descParas, 34),
        bodyCell(
          [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: safeText(d.category) })] })],
          8
        ),
        // ✅ FIX: было d.recommendation (не существует), должно быть recommendedFix
        bodyCell([new Paragraph({ children: [new TextRun({ text: safeText(d.recommendedFix) })] })], 18)
      ]
    });

    rows.push(row);
  }

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows
  });

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              orientation: PageOrientation.LANDSCAPE
            },
            margin: {
              top: 720,
              bottom: 720,
              left: 720,
              right: 720
            }
          }
        },
        children: [title, subtitle, new Paragraph({ text: "" }), table]
      }
    ]
  });

  const buf = await Packer.toBlob(doc);
  return buf;
}
