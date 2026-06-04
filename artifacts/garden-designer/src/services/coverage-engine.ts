/**
 * coverage-engine.ts
 * Calcula cantidades y costos de materiales por área o perímetro de polígono.
 * Compatible con el sistema de materiales CAD y el inventario de la base de datos.
 */

import type { MaterialDef } from "./material-system";

// ── Polygon geometry helpers ────────────────────────────────────────────────

export interface Point { x: number; y: number; }

/** Euclidean distance between two points. */
function ptDist(a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute the perimeter of a polygon in metres.
 * @param points  Vertices in image-pixel coordinates
 * @param ppm     Pixels per metre (calibration value)
 */
export function polygonPerimeterM(points: Point[], ppm: number): number {
  if (points.length < 2 || ppm <= 0) return 0;
  let px = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    px += ptDist(points[i], next);
  }
  return px / ppm;
}

// ── Coverage rates por tipo de material ────────────────────────────────────
// Para materiales de suelo: factor de desperdicio/compactación típico México

export interface CoverageRule {
  /** How many inventory/material units needed per m² of polygon area (area-based) */
  unitsPerM2: number;
  /**
   * For length-based materials: how many units (m) per metre of perimeter.
   * Typically 1.0 (1 m of edge product per 1 m of perimeter), can be >1 for overlap.
   */
  unitsPerM?: number;
  /** Display unit label */
  unit: string;
  /** Short note shown in estimate panel */
  note: string;
}

const COVERAGE_RULES: Record<string, CoverageRule> = {
  // Ground covers — sold per m², add 5–10% for waste/cuts
  grass:       { unitsPerM2: 1.05, unit: "m²",   note: "+5% desperdicio en cortes" },
  soil:        { unitsPerM2: 1.00, unit: "m²",   note: "Tierra de jardín / relleno" },
  mulch:       { unitsPerM2: 1.00, unit: "m²",   note: "Capa ~5 cm espesor" },

  // Stone / aggregate — sold per m², factor includes compaction
  "white-stone": { unitsPerM2: 1.10, unit: "m²", note: "+10% compactación" },
  "grey-stone":  { unitsPerM2: 1.10, unit: "m²", note: "+10% compactación" },
  "red-stone":   { unitsPerM2: 1.10, unit: "m²", note: "+10% compactación" },
  "black-stone": { unitsPerM2: 1.10, unit: "m²", note: "+10% compactación" },
  marble:        { unitsPerM2: 1.10, unit: "m²", note: "+10% merma y compactación" },
  gravel:        { unitsPerM2: 1.10, unit: "m²", note: "+10% compactación" },
  "multi-stone": { unitsPerM2: 1.10, unit: "m²", note: "+10% compactación" },

  // Hard surfaces — sold per m², add 8% for cuts
  concrete:    { unitsPerM2: 1.08, unit: "m²",   note: "+8% cortes y uniones" },

  // Length-based materials — charged per linear metre of perimeter
  "borde-concreto": { unitsPerM2: 0, unitsPerM: 1.05, unit: "ml", note: "+5% cortes y esquinas" },
  "borde-madera":   { unitsPerM2: 0, unitsPerM: 1.05, unit: "ml", note: "+5% cortes y empalmes" },
  "muro-piedra":    { unitsPerM2: 0, unitsPerM: 1.10, unit: "ml", note: "+10% esquinas y rellenos" },
};

/** Get coverage rule for a material ID (fallback to 1:1 m²) */
export function getCoverageRule(materialId: string): CoverageRule {
  return COVERAGE_RULES[materialId] ?? { unitsPerM2: 1.0, unit: "m²", note: "" };
}

// ── Plant-density helpers ───────────────────────────────────────────────────

/**
 * Estimate how many plants fit in an area given their spacing in cm.
 * Returns quantity rounded up (always order ≥1).
 */
export function plantsFromSpacing(areaM2: number, spacingCm: number): number {
  if (spacingCm <= 0 || areaM2 <= 0) return 0;
  const spacingM = spacingCm / 100;
  const qty = Math.ceil(areaM2 / (spacingM * spacingM));
  return Math.max(1, qty);
}

// ── Per-polygon estimate ────────────────────────────────────────────────────

export interface PolyMaterialEstimate {
  polyId: string;
  /** Polygon area in m² (from shoelace formula + ppm calibration) */
  areaM2: number;
  /** Polygon perimeter in metres (sum of edge lengths / ppm) */
  perimeterM: number;

  // Primary material (from CAD material system)
  materialId: string;
  materialName: string;
  /** "m²" | "ml" | other */
  unit: string;
  note: string;
  /** Whether this material is charged per metre of perimeter ("length") or by area ("area") */
  unitType: "area" | "length";

  /** How many units needed (may be fractional) */
  qty: number;
  /** User-editable multiplier (defaults to 1.0) */
  densityMultiplier: number;
  /** Final adjusted quantity = qty * densityMultiplier */
  qtyAdjusted: number;

  /** Price per unit (MXN). For area→ MXN/m². For length → MXN/ml. */
  unitPrice: number;
  /** Total cost = qtyAdjusted × unitPrice */
  total: number;
}

/**
 * Compute the material estimate for one closed polygon.
 *
 * @param polyId          Polygon identifier
 * @param areaM2          Polygon area in m² (pre-computed)
 * @param mat             Material definition
 * @param densityMultiplier User-editable multiplier (default 1.0)
 * @param perimeterM      Polygon perimeter in metres (required for length-based materials)
 * @param priceOverride   Optional user-edited price per unit (overrides material default)
 */
export function estimatePolygon(
  polyId: string,
  areaM2: number,
  mat: MaterialDef,
  densityMultiplier = 1.0,
  perimeterM = 0,
  priceOverride?: number
): PolyMaterialEstimate {
  const rule = getCoverageRule(mat.id);
  const isLength = mat.unitType === "length";

  // Quantity
  const baseQty = isLength
    ? perimeterM * (rule.unitsPerM ?? 1.0)
    : areaM2 * rule.unitsPerM2;
  const qty = baseQty;
  const qtyAdjusted = qty * densityMultiplier;

  // Price per unit
  const defaultPrice = isLength ? (mat.defaultPriceM ?? 0) : mat.defaultPriceM2;
  const unitPrice = priceOverride !== undefined ? priceOverride : defaultPrice;

  const total = qtyAdjusted * unitPrice;

  return {
    polyId,
    areaM2,
    perimeterM,
    materialId: mat.id,
    materialName: mat.name,
    unit: rule.unit,
    note: rule.note,
    unitType: isLength ? "length" : "area",
    qty,
    densityMultiplier,
    qtyAdjusted,
    unitPrice,
    total,
  };
}

// ── Multi-polygon summary (totals per material) ────────────────────────────

export interface MaterialSummaryRow {
  materialId: string;
  materialName: string;
  emoji: string;
  unit: string;
  unitType: "area" | "length";
  totalQty: number;
  unitPrice: number;
  totalCost: number;
  zoneCount: number;
}

export function buildMaterialSummary(
  estimates: PolyMaterialEstimate[],
  getMaterialFn: (id: string) => MaterialDef
): MaterialSummaryRow[] {
  const map = new Map<string, MaterialSummaryRow>();
  for (const e of estimates) {
    const mat = getMaterialFn(e.materialId);
    const existing = map.get(e.materialId);
    if (existing) {
      existing.totalQty  += e.qtyAdjusted;
      existing.totalCost += e.total;
      existing.zoneCount++;
    } else {
      map.set(e.materialId, {
        materialId: e.materialId,
        materialName: e.materialName,
        emoji: mat.emoji,
        unit: e.unit,
        unitType: e.unitType,
        totalQty: e.qtyAdjusted,
        unitPrice: e.unitPrice,
        totalCost: e.total,
        zoneCount: 1,
      });
    }
  }
  // Sort by totalCost desc
  return Array.from(map.values()).sort((a, b) => b.totalCost - a.totalCost);
}
