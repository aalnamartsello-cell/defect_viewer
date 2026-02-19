// src/constants/defects.ts
// ВАЖНО: это fallback-список (если бэк недоступен).
// Реальный список теперь берём с бэка через api.getSessionClasses / api.addSessionClass.

export const DEFECT_CLASSES = [
  "трещины",
  "протечки/высолы",
  "оголение арматуры",
  "коррозия",
  "сколы/разрушения",
  "отслоение/обрушение",
  "деформация",
  "грибок/плесень",
  "нарушение швов",
  "прочее"
] as const;

// ✅ теперь классы динамические => тип string
export type DefectClass = string;
