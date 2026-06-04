/**
 * PolygonManager — Core CAD polygon logic.
 * Zero AI dependency. Pure geometric math.
 */

export interface Point { x: number; y: number }

export interface PolygonData {
  id: string;
  points: Point[];
  materialId: string;
  closed: boolean;
  areaPx: number;       // raw pixel area (Shoelace)
  areaM2: number | null; // m² if calibration is available
}

// ─── Geometry utilities ────────────────────────────────────────────────────
export function shoelaceArea(pts: Point[]): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y;
    a -= pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

export function polygonCentroid(pts: Point[]): Point {
  if (pts.length === 0) return { x: 0, y: 0 };
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

export function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Ray casting: is point P inside polygon?
 */
export function isPointInPolygon(p: Point, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const intersect = yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Distance from point to a line segment.
 */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/**
 * Find the midpoint of the edge closest to a point (for adding vertices).
 */
export function findClosestEdge(
  p: Point,
  pts: Point[],
  threshold = 10
): { edgeIndex: number; midpoint: Point } | null {
  let best: { edgeIndex: number; midpoint: Point; d: number } | null = null;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const d = distToSegment(p, pts[i], pts[j]);
    if (d < threshold && (!best || d < best.d)) {
      best = {
        edgeIndex: i,
        midpoint: { x: (pts[i].x + pts[j].x) / 2, y: (pts[i].y + pts[j].y) / 2 },
        d,
      };
    }
  }
  return best ? { edgeIndex: best.edgeIndex, midpoint: best.midpoint } : null;
}

// ─── PolygonManager ─────────────────────────────────────────────────────────
let _counter = 1;
function newId() { return `poly_${Date.now()}_${_counter++}`; }

export class PolygonManager {
  private _polys: PolygonData[] = [];

  get polys(): PolygonData[] { return this._polys; }

  createPolygon(materialId: string): PolygonData {
    const poly: PolygonData = {
      id: newId(), points: [], materialId, closed: false, areaPx: 0, areaM2: null,
    };
    this._polys = [...this._polys, poly];
    return poly;
  }

  addPoint(id: string, pt: Point): PolygonData | null {
    this._polys = this._polys.map(p => {
      if (p.id !== id || p.closed) return p;
      const pts = [...p.points, pt];
      return { ...p, points: pts, areaPx: shoelaceArea(pts) };
    });
    return this._polys.find(p => p.id === id) ?? null;
  }

  closePolygon(id: string, pixelsPerMeter?: number): PolygonData | null {
    this._polys = this._polys.map(p => {
      if (p.id !== id || p.points.length < 3) return p;
      const areaPx = shoelaceArea(p.points);
      const areaM2 = pixelsPerMeter ? areaPx / (pixelsPerMeter ** 2) : null;
      return { ...p, closed: true, areaPx, areaM2 };
    });
    return this._polys.find(p => p.id === id) ?? null;
  }

  moveVertex(id: string, vtxIdx: number, pt: Point, pixelsPerMeter?: number): void {
    this._polys = this._polys.map(p => {
      if (p.id !== id) return p;
      const pts = p.points.map((v, i) => i === vtxIdx ? pt : v);
      const areaPx = shoelaceArea(pts);
      const areaM2 = pixelsPerMeter ? areaPx / (pixelsPerMeter ** 2) : p.areaM2;
      return { ...p, points: pts, areaPx, areaM2 };
    });
  }

  deleteVertex(id: string, vtxIdx: number, pixelsPerMeter?: number): void {
    this._polys = this._polys.map(p => {
      if (p.id !== id) return p;
      if (p.points.length <= 3 && p.closed) {
        // Can't have fewer than 3 vertices on a closed polygon — delete the polygon
        return p;
      }
      const pts = p.points.filter((_, i) => i !== vtxIdx);
      const areaPx = shoelaceArea(pts);
      const areaM2 = pixelsPerMeter ? areaPx / (pixelsPerMeter ** 2) : p.areaM2;
      return { ...p, points: pts, areaPx, areaM2 };
    });
    // If polygon now has <3 points after deletion, remove it
    this._polys = this._polys.filter(p => !(p.points.length < 3 && p.closed));
  }

  insertVertex(id: string, afterEdgeIndex: number, pt: Point, pixelsPerMeter?: number): void {
    this._polys = this._polys.map(p => {
      if (p.id !== id) return p;
      const pts = [...p.points];
      pts.splice(afterEdgeIndex + 1, 0, pt);
      const areaPx = shoelaceArea(pts);
      const areaM2 = pixelsPerMeter ? areaPx / (pixelsPerMeter ** 2) : p.areaM2;
      return { ...p, points: pts, areaPx, areaM2 };
    });
  }

  changeMaterial(id: string, materialId: string): void {
    this._polys = this._polys.map(p => p.id === id ? { ...p, materialId } : p);
  }

  deletePolygon(id: string): void {
    this._polys = this._polys.filter(p => p.id !== id);
  }

  setAll(polys: PolygonData[]): void {
    this._polys = polys;
  }

  clone(): PolygonManager {
    const m = new PolygonManager();
    m._polys = this._polys.map(p => ({ ...p, points: [...p.points] }));
    return m;
  }

  /** Recalculate all areas with a new calibration */
  recalibrate(pixelsPerMeter: number): void {
    this._polys = this._polys.map(p => ({
      ...p,
      areaM2: p.areaPx / (pixelsPerMeter ** 2),
    }));
  }
}
