/**
 * offline-design-engine.ts — Rule-based design suggestions without AI.
 *
 * When offline, this engine replaces GPT-4o design-plan calls.
 * Uses the locally cached inventory and fixed horticultural rules.
 */

import type { CachedInventoryItem } from './offline-storage';

export interface OfflinePlantSuggestion {
  inventoryItemId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  placementHint: string;
  imageData?: string;
}

export interface OfflineDesignPlan {
  title: string;
  totalAreaM2: number;
  estimatedTotal: number;
  suggestions: OfflinePlantSuggestion[];
  notes: string[];
}

// ─── Coverage ratios by category ─────────────────────────────────────────────
// How many m² does one unit of this plant typically cover / fill visually?
const COVERAGE_BY_SUBCATEGORY: Record<string, number> = {
  arbol: 25,        // 1 árbol cada 25 m²
  arbusto: 4,       // 1 arbusto cada 4 m²
  palma: 12,        // 1 palma cada 12 m²
  suculenta: 0.5,   // 1 suculenta cada 0.5 m²
  cubresuelos: 1,   // 1 cubresuelo por m²
  helecho: 1,       // 1 helecho por m²
  flor: 0.3,        // flores densas
  planta: 1.5,      // plantas genéricas
  material: 0,      // materiales no se colocan como plantas
  accesorio: 0,
};

// ─── Priority by zone area ────────────────────────────────────────────────────
// Small areas get succulents/groundcover; large areas get trees + shrubs.
function getTargetSubcategories(areaM2: number): string[] {
  if (areaM2 < 10) return ['suculenta', 'flor', 'helecho', 'planta'];
  if (areaM2 < 30) return ['arbusto', 'suculenta', 'planta', 'cubresuelos'];
  if (areaM2 < 80) return ['arbol', 'arbusto', 'palma', 'planta'];
  return ['arbol', 'palma', 'arbusto', 'planta'];
}

// ─── Main engine ─────────────────────────────────────────────────────────────

export function generateOfflineDesignPlan(
  areaM2: number,
  inventory: CachedInventoryItem[]
): OfflineDesignPlan {
  const plants = inventory.filter(
    (i) =>
      i.category === 'planta' ||
      i.category === 'plant' ||
      i.subcategory === 'arbol' ||
      i.subcategory === 'arbusto' ||
      i.subcategory === 'palma' ||
      i.subcategory === 'suculenta'
  );

  const targets = getTargetSubcategories(areaM2);

  const suggestions: OfflinePlantSuggestion[] = [];
  let remainingArea = areaM2;
  let estimatedTotal = 0;

  for (const target of targets) {
    if (remainingArea <= 0) break;

    const candidates = plants.filter(
      (p) =>
        p.subcategory?.toLowerCase().includes(target) ||
        p.name.toLowerCase().includes(target)
    );
    if (candidates.length === 0) continue;

    // Pick a random candidate from the first 5 matching
    const pool = candidates.slice(0, 5);
    const item = pool[Math.floor(Math.random() * pool.length)];
    const coverage = COVERAGE_BY_SUBCATEGORY[target] ?? 2;
    const quantity = Math.max(1, Math.round(remainingArea / coverage));
    const unitPrice = Number(item.price) || 150;
    const totalPrice = quantity * unitPrice;

    suggestions.push({
      inventoryItemId: item.id,
      name: item.name,
      quantity,
      unitPrice,
      totalPrice,
      placementHint: getPlacementHint(target),
      imageData: item.imageData,
    });

    estimatedTotal += totalPrice;
    remainingArea -= quantity * coverage;
  }

  if (suggestions.length === 0) {
    const fallback = plants.slice(0, 3);
    for (const item of fallback) {
      const quantity = Math.max(1, Math.floor(areaM2 / 5));
      const unitPrice = Number(item.price) || 150;
      suggestions.push({
        inventoryItemId: item.id,
        name: item.name,
        quantity,
        unitPrice,
        totalPrice: quantity * unitPrice,
        placementHint: 'Distribuir uniformemente',
        imageData: item.imageData,
      });
      estimatedTotal += quantity * unitPrice;
    }
  }

  return {
    title: `Plan offline para ${areaM2.toFixed(0)} m²`,
    totalAreaM2: areaM2,
    estimatedTotal,
    suggestions,
    notes: [
      'Generado sin conexión — basado en reglas hortícolas locales.',
      'Confirma disponibilidad en vivero antes de presupuestar.',
      'Precios tomados del último inventario sincronizado.',
    ],
  };
}

// ─── Offline chat fallback ────────────────────────────────────────────────────
// Returns a contextual offline tip instead of calling GPT-4o.

export function getOfflineChatFallback(inventory: CachedInventoryItem[]): string {
  const tipsPool = [
    `Sin conexión activa. Consejo local: para jardines de clima caliente, prioriza especies nativas como nopal, agave y bugambilia — requieren poca agua y mantenimiento.`,
    `Sin conexión activa. Consejo local: en zonas de sombra parcial elige helechos (Nephrolepis), Dieffenbachia o Spathiphyllum para un jardín de bajo mantenimiento.`,
    `Sin conexión activa. Consejo local: para bordes de jardín, combina Salvia, Lavanda y Romero — atraen polinizadores y son aromáticas.`,
    `Sin conexión activa. Consejo local: si el área tiene mucho sol directo, las suculentas (Sedum, Echeveria, Aloe) son la opción más resistente en México.`,
    `Sin conexión activa. Consejo local: en jardines urbanos pequeños, las palmas Chamaedorea son ideales — crecen en sombra y alcanzan solo 2–3 m.`,
  ];

  const inventoryTip =
    inventory.length > 0
      ? ` Tienes ${inventory.length} artículos en el inventario local disponibles para diseño.`
      : '';

  const randomTip = tipsPool[Math.floor(Math.random() * tipsPool.length)];
  return randomTip + inventoryTip;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPlacementHint(subcategory: string): string {
  const hints: Record<string, string> = {
    arbol: 'Esquinas y centro como punto focal',
    arbusto: 'Bordes y divisiones de zona',
    palma: 'Línea central o entrada principal',
    suculenta: 'Agrupaciones rocosas o macetas',
    cubresuelos: 'Cubrir superficie entre plantas mayores',
    helecho: 'Zonas de sombra y humedad',
    flor: 'Bordes y franjas de color',
    planta: 'Distribución libre según espacio',
  };
  return hints[subcategory] ?? 'Distribuir según el área disponible';
}
