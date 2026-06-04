/**
 * SpatialEngine — Spatial distribution & scale engine for landscape design.
 *
 * Accepts polygon points (image coordinates), real-world area in m²,
 * and a classified plant list with spacing/width data.
 *
 * Outputs valid (x%, y%) positions per item using a spatial grid:
 *   - Palms: perimeter focal points (low density)
 *   - Shrubs: inward distribution (medium density)
 *   - Ground cover: remaining interior space (high density)
 *
 * Enforces minimum separation and polygon containment.
 */

import { isPointInPolygon } from "./polygon-manager";
import type { Point } from "./polygon-manager";

// ── Plant density type classification ─────────────────────────────────────────

export type DensityType = "palm" | "shrub" | "ground_cover" | "other";

/**
 * Width of plant crown in meters (used for collision radius).
 * Defaults per density type when not specified in inventory.
 */
export const DEFAULT_WIDTH_M: Record<DensityType, number> = {
  palm: 3.0,
  shrub: 1.5,
  ground_cover: 0.5,
  other: 1.0,
};

/**
 * Default spacing in meters between plants of each type.
 * Used when inventory spacing field is missing or zero.
 */
export const DEFAULT_SPACING_M: Record<DensityType, number> = {
  palm: 4.0,
  shrub: 2.0,
  ground_cover: 0.6,
  other: 1.5,
};

/**
 * Classify a plant into a density type based on its itemType field.
 */
export function classifyPlant(itemType: string | null | undefined, name: string): DensityType {
  const t = (itemType ?? "").toLowerCase();
  const n = name.toLowerCase();

  if (
    t.includes("palm") || t.includes("árbol") || t.includes("arbol") || t.includes("tree") ||
    n.includes("palm") || n.includes("árbol") || n.includes("arbol") ||
    n.includes("bambú") || n.includes("bambu") || n.includes("yuca") || n.includes("dracena")
  ) {
    return "palm";
  }
  if (
    t.includes("arbusto") || t.includes("shrub") || t.includes("bush") ||
    t.includes("seto") || t.includes("hedge") ||
    n.includes("arbusto") || n.includes("bougainvillea") || n.includes("bugambilia") ||
    n.includes("helecho") || n.includes("ficus") || n.includes("croton") ||
    n.includes("ixora") || n.includes("gardenia") || n.includes("hibisco")
  ) {
    return "shrub";
  }
  if (
    t.includes("cubresuelo") || t.includes("ground") || t.includes("tapizante") ||
    t.includes("pasto") || t.includes("cesped") || t.includes("grass") ||
    n.includes("cubresuelo") || n.includes("pasto") || n.includes("césped") ||
    n.includes("musgo") || n.includes("suculenta") || n.includes("cactus") ||
    n.includes("agapando") || n.includes("liriope") || n.includes("mondo")
  ) {
    return "ground_cover";
  }
  // planta, flor, ornamental → shrub by default
  if (t.includes("planta") || t.includes("flor") || t.includes("ornamental")) {
    return "shrub";
  }
  return "other";
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function polygonPerimeterPoints(pts: Point[], count: number): Point[] {
  if (pts.length === 0) return [];
  const result: Point[] = [];
  const total = pts.length;
  const step = total / count;
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(i * step) % total;
    const next = (idx + 1) % total;
    // Place at edge midpoint, inset toward centroid
    const mid = { x: (pts[idx].x + pts[next].x) / 2, y: (pts[idx].y + pts[next].y) / 2 };
    result.push(mid);
  }
  return result;
}

function polygonCentroid(pts: Point[]): Point {
  if (pts.length === 0) return { x: 0.5, y: 0.5 };
  const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return { x, y };
}

function insetPoint(p: Point, centroid: Point, factor: number): Point {
  return {
    x: p.x + (centroid.x - p.x) * factor,
    y: p.y + (centroid.y - p.y) * factor,
  };
}

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// ── Spatial grid generator ────────────────────────────────────────────────────

interface GridCell {
  x: number; // image-space pixels
  y: number;
  occupied: boolean;
  occupiedRadius: number;
}

function buildGrid(
  pts: Point[],
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  cellSizePx: number
): GridCell[] {
  const cells: GridCell[] = [];
  const cols = Math.ceil((bbox.maxX - bbox.minX) / cellSizePx);
  const rows = Math.ceil((bbox.maxY - bbox.minY) / cellSizePx);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = bbox.minX + (col + 0.5) * cellSizePx;
      const cy = bbox.minY + (row + 0.5) * cellSizePx;
      if (isPointInPolygon({ x: cx, y: cy }, pts)) {
        cells.push({ x: cx, y: cy, occupied: false, occupiedRadius: 0 });
      }
    }
  }
  return cells;
}

function tryPlacePlant(
  cells: GridCell[],
  minSeparationPx: number,
  preferEdge: boolean,
  centroid: Point,
  pts: Point[],
  rng: () => number
): GridCell | null {
  const free = cells.filter(c => !c.occupied);
  if (free.length === 0) return null;

  let candidates = free;

  if (preferEdge) {
    const edgeCandidates = free.filter(c => {
      const dToCenter = dist(c, centroid);
      const polyRadius = Math.max(
        ...pts.map(p => dist(p, centroid))
      );
      return dToCenter > polyRadius * 0.4;
    });
    if (edgeCandidates.length > 0) candidates = edgeCandidates;
  } else {
    const innerCandidates = free.filter(c => {
      const dToCenter = dist(c, centroid);
      const polyRadius = Math.max(...pts.map(p => dist(p, centroid)));
      return dToCenter < polyRadius * 0.7;
    });
    if (innerCandidates.length > 0) candidates = innerCandidates;
  }

  // Shuffle and try candidates
  const shuffled = candidates.slice().sort(() => rng() - 0.5);
  for (const cell of shuffled) {
    const tooClose = cells.some(c =>
      c.occupied && dist(c, cell) < Math.max(minSeparationPx, c.occupiedRadius + minSeparationPx / 2)
    );
    if (!tooClose && isPointInPolygon(cell, pts)) {
      return cell;
    }
  }
  return null;
}

// ── Main API ──────────────────────────────────────────────────────────────────

export interface SpatialPlantInput {
  inventoryItemId: number;
  name: string;
  itemType: string | null;
  quantity: number;
  spacing: number | null; // cm from DB — converted to meters internally
  price: number;
  imageData: string | null;
}

export interface PlacedPlant {
  inventoryItemId: number;
  name: string;
  price: number;
  imageData: string | null;
  xPct: number; // 0–1 fraction of polygon bounding box width
  yPct: number; // 0–1 fraction of polygon bounding box height
  densityType: DensityType;
}

export interface FitResult {
  inventoryItemId: number;
  name: string;
  requestedQty: number;
  placedQty: number;
  wasCapped: boolean;
}

export interface SpatialEngineResult {
  placements: PlacedPlant[];
  fitResults: FitResult[];
  areaM2: number;
  ppm: number;
}

/**
 * Run the spatial engine.
 *
 * @param polygonPts  Polygon vertices in image-pixel coordinates.
 * @param ppm         Pixels per meter (from scale calibration). If 0 or null,
 *                    a fallback of 100 px/m is used.
 * @param plants      Plants from inventory to distribute.
 * @param seed        Optional RNG seed (for reproducibility in tests).
 */
export function runSpatialEngine(
  polygonPts: Point[],
  ppm: number | null,
  plants: SpatialPlantInput[],
  seed = 42
): SpatialEngineResult {
  if (polygonPts.length < 3) {
    return { placements: [], fitResults: [], areaM2: 0, ppm: ppm ?? 100 };
  }

  // Effective pixels per meter
  const effectivePpm = ppm && ppm > 0 ? ppm : 100;

  // Bounding box of polygon
  const xs = polygonPts.map(p => p.x);
  const ys = polygonPts.map(p => p.y);
  const bbox = {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
  const bboxW = bbox.maxX - bbox.minX;
  const bboxH = bbox.maxY - bbox.minY;

  // Compute real area using shoelace
  let shoelace = 0;
  for (let i = 0; i < polygonPts.length; i++) {
    const j = (i + 1) % polygonPts.length;
    shoelace += polygonPts[i].x * polygonPts[j].y;
    shoelace -= polygonPts[j].x * polygonPts[i].y;
  }
  const areaPx = Math.abs(shoelace) / 2;
  const areaM2 = areaPx / (effectivePpm * effectivePpm);

  const centroid = polygonCentroid(polygonPts);

  // Simple seeded RNG (mulberry32)
  let rngState = seed;
  const rng = () => {
    rngState |= 0; rngState = rngState + 0x6D2B79F5 | 0;
    let t = Math.imul(rngState ^ rngState >>> 15, 1 | rngState);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };

  const placements: PlacedPlant[] = [];
  const fitResults: FitResult[] = [];

  // Build the shared grid cells using the smallest plant as cell size
  const minCellM = 0.4; // 0.4 m minimum cell size
  const minCellPx = minCellM * effectivePpm;
  const gridCells = buildGrid(polygonPts, bbox, minCellPx);

  // Sort plants: palms first, then shrubs, then ground cover
  const densityOrder: DensityType[] = ["palm", "shrub", "ground_cover", "other"];
  const sortedPlants = [...plants].sort((a, b) => {
    const da = classifyPlant(a.itemType, a.name);
    const db = classifyPlant(b.itemType, b.name);
    return densityOrder.indexOf(da) - densityOrder.indexOf(db);
  });

  for (const plant of sortedPlants) {
    const density = classifyPlant(plant.itemType, plant.name);

    // Determine effective spacing in meters
    const spacingM = plant.spacing && plant.spacing > 0
      ? plant.spacing / 100  // DB stores cm
      : DEFAULT_SPACING_M[density];

    const widthM = DEFAULT_WIDTH_M[density];
    const radiusPx = (widthM / 2) * effectivePpm;
    const separationPx = spacingM * effectivePpm;

    // Capacity: how many fit in the area given spacing²
    const capacityByArea = Math.max(1, Math.floor(areaM2 / (spacingM * spacingM)));

    const requestedQty = Math.round(plant.quantity);
    const cappedQty = Math.min(requestedQty, capacityByArea);

    const wasCapped = cappedQty < requestedQty;
    let placedCount = 0;

    const preferEdge = density === "palm";
    const preferInner = density === "ground_cover";

    for (let i = 0; i < cappedQty; i++) {
      const cell = tryPlacePlant(
        gridCells,
        separationPx,
        preferEdge && !preferInner,
        centroid,
        polygonPts,
        rng
      );

      if (!cell) break; // No more valid positions

      cell.occupied = true;
      cell.occupiedRadius = radiusPx;

      // Convert to percentage of bounding box
      const xPct = bboxW > 0 ? (cell.x - bbox.minX) / bboxW : 0.5;
      const yPct = bboxH > 0 ? (cell.y - bbox.minY) / bboxH : 0.5;

      placements.push({
        inventoryItemId: plant.inventoryItemId,
        name: plant.name,
        price: plant.price,
        imageData: plant.imageData,
        xPct: Math.max(0.05, Math.min(0.95, xPct)),
        yPct: Math.max(0.05, Math.min(0.95, yPct)),
        densityType: density,
      });
      placedCount++;
    }

    fitResults.push({
      inventoryItemId: plant.inventoryItemId,
      name: plant.name,
      requestedQty,
      placedQty: placedCount,
      wasCapped: wasCapped || placedCount < requestedQty,
    });
  }

  return { placements, fitResults, areaM2, ppm: effectivePpm };
}

/**
 * Convert spatial engine placements to absolute image-pixel coordinates.
 *
 * @param placements  Output from runSpatialEngine.
 * @param polygonPts  Same polygon points used in engine.
 */
export function placementsToPixels(
  placements: PlacedPlant[],
  polygonPts: Point[]
): Array<PlacedPlant & { px: number; py: number }> {
  if (polygonPts.length === 0) return [];
  const xs = polygonPts.map(p => p.x);
  const ys = polygonPts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  return placements.map(pl => ({
    ...pl,
    px: minX + pl.xPct * bboxW,
    py: minY + pl.yPct * bboxH,
  }));
}

/**
 * Build reduced-quantity notice strings (Spanish) for capped plants.
 */
export function buildCapNotices(fitResults: FitResult[]): string[] {
  const notices: string[] = [];
  for (const r of fitResults) {
    if (r.wasCapped) {
      const diff = r.requestedQty - r.placedQty;
      if (diff > 0) {
        notices.push(
          `Se redujeron ${r.name} de ${r.requestedQty} a ${r.placedQty} por espacio disponible.`
        );
      }
    }
  }
  return notices;
}
