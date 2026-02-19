// src/utils/trainingPayload.ts
import type { PhotoItem } from "../types";
import { DEFECT_CLASSES } from "../constants/defects";

export type TrainingPayload = {
  version: 1;
  exportedAt: string;
  classes: readonly string[];
  photos: Array<{
    id: string;
    name: string;
    src: string;
    decision: any; // OperatorDecision | null (держим мягко для будущих миграций)
    bboxes: Array<{
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      cls: string;
      confidence: number;
    }>;
  }>;
};

export function buildTrainingPayload(args: {
  photos: PhotoItem[];
  decisionByPhoto: Record<string, any>;
}): TrainingPayload {
  const { photos, decisionByPhoto } = args;

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    classes: DEFECT_CLASSES,
    photos: (photos ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      src: p.src,
      decision: decisionByPhoto?.[p.id] ?? null,
      bboxes: (p.bboxes ?? []).map((b) => ({
        id: b.id,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        cls: b.cls,
        confidence: b.confidence
      }))
    }))
  };
}
