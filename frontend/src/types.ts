// src/types.ts

export type OperatorDecision =
  | {
      type: "ok";
    }
  | {
      type: "defect";
      defects: Array<{
        bboxId: string;
        cls: string;
        confidence: number;
      }>;
      place?: string; // "Место"
      comment?: string; // "Комментарий" (Описание)
      category?: "A" | "Б" | "В"; // Категорийность
      recommendedFix?: string; // Рекомендуемый способ устранения
    };

export type OperatorDraft = {
  place?: string;
  comment?: string;
};

export type BBox = {
  id: string;
  x: number; // 0..1
  y: number; // 0..1
  w: number; // 0..1
  h: number; // 0..1
  cls: string;
  confidence: number;
};

export type PhotoItem = {
  id: string;
  name: string;
  src: string;
  bboxes?: BBox[];
  srcIsObjectUrl?: boolean;
};
