/**
 * CAD Designer — Sistema profesional de diseño de paisajismo vectorial.
 *
 * Módulos:
 *   ImageLayer       — imagen del terreno como fondo fijo
 *   DrawingLayer     — canvas interactivo con zoom/pan
 *   PolygonEngine    — vértices, snap, ángulos, shoelace
 *   MeasurementSystem — calibración px→m, área real m²
 *   MaterialSystem   — catálogo visual con precios
 *   CostEngine       — costo por zona + total del proyecto
 *   ProjectStore     — estado global en AppContext
 *
 * Cero dependencia de AI. 100% funcional offline.
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from "react";
import { useLocation } from "wouter";
import {
  Pencil, MousePointer2, Trash2, Ruler, X,
  ZoomIn, ZoomOut, Maximize2, Download, Save,
  ArrowLeft, AlertCircle, Loader2, Sparkles, Palette, Wand2,
  ChevronDown, DollarSign, Footprints, Undo2, FileText, Package,
  Redo2, Eye, EyeOff, Lock, Unlock, Layers, ImageIcon, Leaf, Tag, Eraser, Check,
  Receipt, ChevronUp, Moon, Sun, Lightbulb, Waves,
} from "lucide-react";
import { useAppContext, type DesignItem } from "@/context/app-context";
import { useToast } from "@/hooks/use-toast";
import { CAD_MATERIALS, getMaterial, getMaterialsByCategory, getScaledPattern, loadTextures, type MaterialDef } from "@/services/material-system";
import {
  shoelaceArea, polygonCentroid, dist, distToSegment,
  isPointInPolygon, findClosestEdge,
  type Point, type PolygonData,
} from "@/services/polygon-manager";
import {
  runSpatialEngine, placementsToPixels, buildCapNotices,
  classifyPlant, type SpatialPlantInput,
} from "@/services/spatial-engine";
import {
  trackDesignGenerated, trackBOMAccepted, trackMaterialApplied, fetchUserProfile,
  type UserProfile,
} from "@/services/learning";
import GardenWalkthrough, { type WTPolygon, type WTInventoryItem } from "@/components/garden-walkthrough";
import { nanoid } from "nanoid";
import { applyFlatFill } from "@/services/design-engine";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { renderFlatExport, buildProjectJSON } from "@/services/export-engine";
import { useCadHistory, type CadSnapshot } from "@/hooks/use-cad-history";
import {
  estimatePolygon, buildMaterialSummary, polygonPerimeterM,
  type PolyMaterialEstimate, type MaterialSummaryRow,
} from "@/services/coverage-engine";
import { isLengthMaterial } from "@/services/material-system";
import { authHeaders } from "@/services/auth";
import { wavespeedPost } from "@/services/wavespeed-fetch";

// ─── Types ────────────────────────────────────────────────────────────────────
type Tool = "draw" | "select" | "calibrate" | "delete" | "light";
type CalibratePhase = "idle" | "picking-start" | "picking-end" | "entering-value";

type LayerId = "background" | "zones" | "plants";
interface LayerDef {
  id: LayerId;
  name: string;
  Icon: React.ElementType;
}
interface LayerState {
  visible: boolean;
  locked: boolean;
}

// ── Corrección profesional de bordes ─────────────────────────────────────────
// Suaviza trazos irregulares preservando primer y último vértice.
function smoothStroke(pts: Point[], tension = 0.5): Point[] {
  if (pts.length < 3) return pts;
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    out.push({
      x: p1.x + (p2.x - p0.x) * tension * 0.25,
      y: p1.y + (p2.y - p0.y) * tension * 0.25,
    });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Detecta si la serie de puntos es esencialmente una línea recta (tolerancia 2 px).
function isStraightLine(pts: Point[]): boolean {
  if (pts.length < 3) return true;
  const s = pts[0], e = pts[pts.length - 1];
  const len = Math.hypot(e.y - s.y, e.x - s.x);
  if (len < 1) return true;
  let total = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    total += Math.abs((e.y - s.y) * p.x - (e.x - s.x) * p.y + e.x * s.y - e.y * s.x) / len;
  }
  return total / pts.length < 2;
}

// Endereza si es línea recta; suaviza si es curva irregular.
function correctStroke(pts: Point[]): Point[] {
  if (pts.length < 2) return pts;
  if (isStraightLine(pts)) return [pts[0], pts[pts.length - 1]];
  return smoothStroke(pts);
}
// ─────────────────────────────────────────────────────────────────────────────

const CAD_LAYERS: LayerDef[] = [
  { id: "background", name: "Fondo",    Icon: ImageIcon },
  { id: "zones",      name: "Zonas CAD",Icon: Layers    },
  { id: "plants",     name: "Plantas",  Icon: Leaf      },
];
const DEFAULT_LAYER_STATES: Record<LayerId, LayerState> = {
  background: { visible: true, locked: false },
  zones:      { visible: true, locked: false },
  plants:     { visible: true, locked: false },
};

interface LocalPolygon {
  id: string;
  points: Point[];
  materialId: string;
  closed: boolean;
  label: string;
  aiApplied?: boolean;   // true once WaveSpeed texture has been baked into gardenImage
  poolType?: "pool";     // marks this polygon as a swimming pool
  poolDepth?: number;    // water depth in meters (default 1.4)
  parentZoneId?: string; // ID de la zona origen (sólo en pools creados con createPoolFromZone)
}

interface SuggestionZone {
  id: string;
  label: string;
  materialId: string;
  description: string;
  points: Point[]; // image pixel coords (converted from normalized)
}

interface SuggestionPlant {
  inventoryItemId: number;
  name: string;
  quantity: number;
  x: number; // image pixel coord
  y: number;
}

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

interface BOMItem {
  itemId: number;
  nombre: string;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
  categoria: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_SCALE = 0.15;
const MAX_SCALE = 8;
const VERTEX_R = 7;
const CLOSE_R  = 18;
const SNAP_R   = 16;
const EDGE_R   = 10;
const ANGLE_STEP   = 45;  // degrees (legacy shift-snap)
const ORTHO_TOL    = 10;  // ° — within this of H/V → auto orthogonal snap
const PERP_TOL     = 10;  // ° — within this of ⊥ → perpendicular snap
const PARALLEL_TOL  = 5;  // ° — within this of an edge direction → parallel snap

type SnapType = "vertex" | "close" | "horizontal" | "vertical" | "perpendicular" | "parallel" | null;
interface SnapResult { point: Point; type: SnapType; trackLines: Array<[Point, Point]>; label: string; }

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getContainRect(natW: number, natH: number, cW: number, cH: number) {
  const s = Math.min(cW / natW, cH / natH);
  return { x: (cW - natW * s) / 2, y: (cH - natH * s) / 2, w: natW * s, h: natH * s, scale: s };
}

function canvasPoint(
  e: React.MouseEvent | MouseEvent,
  canvas: HTMLCanvasElement,
  xform: Transform
): Point {
  const r = canvas.getBoundingClientRect();
  const cx = ((e as MouseEvent).clientX - r.left) * (canvas.width / r.width);
  const cy = ((e as MouseEvent).clientY - r.top) * (canvas.height / r.height);
  return {
    x: (cx - xform.tx) / xform.scale,
    y: (cy - xform.ty) / xform.scale,
  };
}

/** Convert raw screen coords to canvas coordinates (for touch events). */
function rawCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement, xform: Transform): Point {
  const r = canvas.getBoundingClientRect();
  const cx = (clientX - r.left) * (canvas.width / r.width);
  const cy = (clientY - r.top) * (canvas.height / r.height);
  return { x: (cx - xform.tx) / xform.scale, y: (cy - xform.ty) / xform.scale };
}

function screenPoint(p: Point, xform: Transform): Point {
  return { x: p.x * xform.scale + xform.tx, y: p.y * xform.scale + xform.ty };
}

function clampScale(s: number) { return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)); }

function snapAngle(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const rawDeg = Math.atan2(dy, dx) * (180 / Math.PI);
  const snapped = Math.round(rawDeg / ANGLE_STEP) * ANGLE_STEP;
  const rad = snapped * (Math.PI / 180);
  return { x: from.x + len * Math.cos(rad), y: from.y + len * Math.sin(rad) };
}

// ── Smart Snap Helpers ────────────────────────────────────────────────────────
/** Normalise angle difference to [-180, 180]. */
function normAngleDeg(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

/** Project point p onto the infinite line through lineOrigin in direction dirDeg°. */
function projectOnLine(p: Point, lineOrigin: Point, dirDeg: number): Point {
  const rad = dirDeg * (Math.PI / 180);
  const dx = Math.cos(rad); const dy = Math.sin(rad);
  const t = (p.x - lineOrigin.x) * dx + (p.y - lineOrigin.y) * dy;
  return { x: lineOrigin.x + t * dx, y: lineOrigin.y + t * dy };
}

/**
 * AutoCAD-style smart snap.
 * Priority: vertex → close-polygon → perpendicular → orthogonal (H/V) → parallel.
 */
function smartSnap(
  raw: Point,
  drawing: Point[] | null,
  polygons: Array<{ points: Point[]; closed?: boolean }>,
  scale: number,
): SnapResult {
  const snapR  = SNAP_R  / scale;
  const closeR = CLOSE_R / scale;

  // ① Vertex snap — nearest existing vertex
  let bestVD = snapR; let bestV: Point | null = null;
  for (const poly of polygons) {
    for (const pt of poly.points) {
      const d = dist(pt, raw);
      if (d < bestVD) { bestVD = d; bestV = pt; }
    }
  }
  if (drawing) {
    for (const pt of drawing) {
      const d = dist(pt, raw);
      if (d < bestVD) { bestVD = d; bestV = pt; }
    }
  }
  if (bestV) return { point: bestV, type: "vertex", trackLines: [], label: "Vértice" };

  // ② Close-polygon snap
  if (drawing && drawing.length >= 3 && dist(raw, drawing[0]) < closeR) {
    return { point: drawing[0], type: "close", trackLines: [], label: "Cerrar" };
  }

  // ③ Angle-based snaps — only when there is a previous drawing point
  if (drawing && drawing.length > 0) {
    const last = drawing[drawing.length - 1];
    const dx = raw.x - last.x;
    const dy = raw.y - last.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5 / scale) return { point: raw, type: null, trackLines: [], label: "" };
    const rawDeg = Math.atan2(dy, dx) * (180 / Math.PI);

    // ③a Perpendicular to the previous segment
    if (drawing.length >= 2) {
      const prev = drawing[drawing.length - 2];
      const segDeg = Math.atan2(last.y - prev.y, last.x - prev.x) * (180 / Math.PI);
      const perp1 = segDeg + 90; const perp2 = segDeg - 90;
      const d1 = Math.abs(normAngleDeg(rawDeg - perp1));
      const d2 = Math.abs(normAngleDeg(rawDeg - perp2));
      const minD = Math.min(d1, d2);
      if (minD < PERP_TOL) {
        const perpDeg = d1 < d2 ? perp1 : perp2;
        const snapped = projectOnLine(raw, last, perpDeg);
        return { point: snapped, type: "perpendicular", trackLines: [[last, snapped]], label: "90°" };
      }
    }

    // ③b Orthogonal H/V from last point
    const hDiff = Math.min(Math.abs(normAngleDeg(rawDeg - 0)), Math.abs(normAngleDeg(rawDeg - 180)));
    const vDiff = Math.min(Math.abs(normAngleDeg(rawDeg - 90)), Math.abs(normAngleDeg(rawDeg + 90)));
    if (hDiff < ORTHO_TOL && hDiff <= vDiff) {
      const snapped: Point = { x: raw.x, y: last.y };
      return { point: snapped, type: "horizontal", trackLines: [[last, snapped]], label: "Horizontal" };
    }
    if (vDiff < ORTHO_TOL) {
      const snapped: Point = { x: last.x, y: raw.y };
      return { point: snapped, type: "vertical", trackLines: [[last, snapped]], label: "Vertical" };
    }

    // ③c Parallel to any existing polygon edge or previous drawing segments
    const findParallel = (pts: Point[], closed: boolean): number | null => {
      const n = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) {
        const a = pts[i]; const b = pts[(i + 1) % pts.length];
        const edgeDeg = Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI);
        const diff = Math.min(
          Math.abs(normAngleDeg(rawDeg - edgeDeg)),
          Math.abs(normAngleDeg(rawDeg - edgeDeg - 180)),
        );
        if (diff < PARALLEL_TOL) return edgeDeg;
      }
      return null;
    };
    let parallelDeg: number | null = null;
    for (const poly of polygons) {
      parallelDeg = findParallel(poly.points, poly.closed ?? false);
      if (parallelDeg !== null) break;
    }
    if (parallelDeg === null && drawing.length >= 2) {
      parallelDeg = findParallel(drawing, false);
    }
    if (parallelDeg !== null) {
      const rad = parallelDeg * (Math.PI / 180);
      const snapped: Point = { x: last.x + len * Math.cos(rad), y: last.y + len * Math.sin(rad) };
      return { point: snapped, type: "parallel", trackLines: [[last, snapped]], label: "Paralelo" };
    }
  }

  return { point: raw, type: null, trackLines: [], label: "" };
}

function formatArea(m2: number | null): string {
  if (m2 === null) return "—";
  if (m2 >= 10000) return `${(m2 / 10000).toFixed(2)} ha`;
  return `${m2.toFixed(2)} m²`;
}

function formatCost(n: number) {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/** Formats a meter value showing both meters with 2 decimals and exact centimeters. */
function formatMeters(m: number): { m: string; cm: string } {
  return { m: m.toFixed(2), cm: (m * 100).toFixed(0) };
}

/** Formats an m² value showing exact value and cm² if small. */
function formatM2(m2: number): { m2: string; detail: string } {
  if (m2 < 1) {
    return { m2: m2.toFixed(4), detail: `${(m2 * 10000).toFixed(0)} cm²` };
  }
  return { m2: m2.toFixed(2), detail: `${(m2 * 100).toFixed(0)} dm²` };
}

// GRASS_OFFSCREEN y drawGrassFixed eliminados — ahora en material-system TextureRegistry

// ─── Pool geometry helpers (spec PASO 1-3) ────────────────────────────────────

/** Calcular centroide simple de un polígono. */
function getCentroid(points: Point[]): Point {
  let x = 0, y = 0;
  points.forEach(p => { x += p.x; y += p.y; });
  return { x: x / points.length, y: y / points.length };
}

/**
 * Escalar el polígono hacia adentro respecto al centroide.
 * factor=0.75 → 25% de margen visual hacia los bordes.
 */
function insetPolygon(points: Point[], factor = 0.75): Point[] {
  const center = getCentroid(points);
  return points.map(p => ({
    x: center.x + (p.x - center.x) * factor,
    y: center.y + (p.y - center.y) * factor,
  }));
}

/**
 * Suavizar polígono por midpoints (Chaikin 1 pass).
 * Convierte esquinas rígidas en forma orgánica tipo piscina.
 */
function smoothPolygon(points: Point[]): Point[] {
  const smooth: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const cur  = points[i];
    const next = points[(i + 1) % points.length];
    smooth.push({
      x: (cur.x + next.x) / 2,
      y: (cur.y + next.y) / 2,
    });
  }
  return smooth;
}

/**
 * Trazar path suavizado con bezierCurveTo para forma orgánica.
 * Llamar dentro de ctx.save()/ctx.restore().
 */
function traceSmoothPath(ctx: CanvasRenderingContext2D, pts: Point[]): void {
  if (pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(
    (pts[0].x + pts[pts.length - 1].x) / 2,
    (pts[0].y + pts[pts.length - 1].y) / 2,
  );
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    ctx.quadraticCurveTo(p1.x, p1.y, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
  }
  ctx.closePath();
}

// ─── replaceGrassWithGravel ────────────────────────────────────────────────────
/**
 * Post-proceso pixel-level: reemplaza TODOS los píxeles verde-pasto por gravilla fina blanca.
 * Detección: g > 100 && g > r+30 && g > b+30 (pasto típico, no agua/cielo/pool).
 * Resultado: gravilla blanca/crema fotorrealista lista para diseñar encima.
 * 100% determinístico — ignora lo que haya generado la IA.
 */
function replaceGrassWithSoil(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;

  // Generador de ruido pseudo-aleatorio determinístico (sin Math.random — consistente por píxel)
  const noise = (x: number, y: number, scale: number): number => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return (s - Math.floor(s)) * scale;
  };

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (g > 100 && g > r + 30 && g > b + 30) {
      const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      const px = (i / 4) % w;
      const py = Math.floor((i / 4) / w);

      // Ruido fino (partículas de grava) + ruido grueso (variación natural de sombra)
      const fineNoise   = noise(px, py, 28) - 14;              // ±14 — textura de grava fina
      const coarseNoise = noise(px * 0.06, py * 0.06, 18) - 9; // ±9  — variación zonal

      const n = fineNoise + coarseNoise;

      // Paleta gravilla blanca/crema: oscuro (185,178,168) → claro (240,236,228)
      // Tono ligeramente cálido (r>g>b) para aspecto natural de piedra caliza
      const baseR = Math.round(195 + lum * 45 + n);
      const baseG = Math.round(190 + lum * 45 + n * 0.92);
      const baseB = Math.round(180 + lum * 45 + n * 0.78);

      d[i]     = Math.min(255, Math.max(0, baseR));
      d[i + 1] = Math.min(255, Math.max(0, baseG));
      d[i + 2] = Math.min(255, Math.max(0, baseB));
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/** Variante async: acepta base64, devuelve base64 con pasto → tierra. */
async function deGrassBase64(base64: string): Promise<string> {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("deGrass: imagen no cargó"));
    img.src = base64;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  replaceGrassWithSoil(ctx, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.92);
}

// ─── Draw pool with chukum finish + water overlay ─────────────────────────────
function drawPool(ctx: CanvasRenderingContext2D, pts: Point[], scale: number): void {
  if (pts.length < 3) return;
  ctx.save();

  // Clip to smooth pool shape (organic, not rigid)
  traceSmoothPath(ctx, pts);
  ctx.clip();

  // 1 — Chukum base (warm off-white stucco)
  ctx.fillStyle = "#d8c3a5";
  traceSmoothPath(ctx, pts);
  ctx.fill();

  // 2 — Chukum texture: subtle diagonal lines for plaster feel
  ctx.strokeStyle = "rgba(180,160,130,0.25)";
  ctx.lineWidth = 0.8 / scale;
  const bounds = pts.reduce(
    (b, p) => ({ minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x), minY: Math.min(b.minY, p.y), maxY: Math.max(b.maxY, p.y) }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );
  for (let y = bounds.minY; y < bounds.maxY; y += 8 / scale) {
    ctx.beginPath(); ctx.moveTo(bounds.minX, y); ctx.lineTo(bounds.maxX, y + 6 / scale); ctx.stroke();
  }

  // 3 — Water overlay (translucent turquoise-blue) — forma suavizada
  ctx.fillStyle = "rgba(0,150,255,0.28)";
  traceSmoothPath(ctx, pts);
  ctx.fill();

  // 4 — Water shimmer lines
  ctx.strokeStyle = "rgba(120,200,255,0.35)";
  ctx.lineWidth = 1.5 / scale;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const rw = (bounds.maxX - bounds.minX) * 0.3;
  const rh = (bounds.maxY - bounds.minY) * 0.08;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.ellipse(cx, cy + (i * (bounds.maxY - bounds.minY) * 0.2), rw, rh / scale, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 5 — Inner shadow (depth illusion around edges)
  const innerGrad = ctx.createLinearGradient(bounds.minX, bounds.minY, bounds.minX, bounds.maxY);
  innerGrad.addColorStop(0, "rgba(0,30,80,0.25)");
  innerGrad.addColorStop(0.3, "transparent");
  innerGrad.addColorStop(0.7, "transparent");
  innerGrad.addColorStop(1, "rgba(0,30,80,0.20)");
  ctx.fillStyle = innerGrad;
  ctx.fillRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);

  ctx.restore();
}

// Converts any rgba/rgb fill color to fully opaque version for solid base fill
function solidFill(rgba: string): string {
  // "rgba(200, 169, 126, 0.65)" → "rgba(200, 169, 126, 1)"
  return rgba.replace(/,\s*[\d.]+\s*\)$/, ", 1)");
}

// ─── RENDER ESTRICTO (spec PASO 4 + PASO 5) ──────────────────────────────────
// getMaterialPattern() → imagen cargada > tile procedural > throw
// catch → ROJO visible + label en consola. NUNCA pasto como fallback.
// ─────────────────────────────────────────────────────────────────────────────
function drawMaterialFill(ctx: CanvasRenderingContext2D, pts: Point[], mat: MaterialDef): void {
  if (pts.length < 3) return;

  ctx.save();

  // FASE 3+4: estado limpio — sin herencia de alpha, composite o sombras
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur  = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Clip exacto al polígono
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.clip();

  // Cobertura TOTAL — el clip() ya restringe al polígono exacto
  const HUGE = 99999;

  try {
    // PASO 4 — getScaledPattern: escala real DOMMatrix + imagen > tile > throw
    const pattern = getScaledPattern(ctx, mat.id);
    ctx.fillStyle = pattern;
    ctx.fillRect(-HUGE, -HUGE, HUGE * 2, HUGE * 2);
  } catch (err) {
    // PASO 5 — ERROR VISUAL (spec: no ocultar, no pasto)
    console.error(err);
    const minX = Math.min(...pts.map(p => p.x));
    const maxX = Math.max(...pts.map(p => p.x));
    const minY = Math.min(...pts.map(p => p.y));
    const maxY = Math.max(...pts.map(p => p.y));
    ctx.fillStyle = "#ff0000";
    ctx.globalAlpha = 0.55;
    ctx.fillRect(-HUGE, -HUGE, HUGE * 2, HUGE * 2);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`❌ ${mat.id}`, (minX + maxX) / 2, (minY + maxY) / 2);
  }

  ctx.restore();
}

// ─── AI Pipeline Helpers ──────────────────────────────────────────────────────
// 768 px → ~44% menos píxeles que 1024 → reduce tiempo de inferencia de WaveSpeed
// (flux-fill-dev) a la mitad sin sacrificio visible de calidad para texturas de pasto/grava/piedra.
const AI_MAX = 768;

function buildPolygonMask(pts: Point[], W: number, H: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  if (pts.length < 3) return c;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
  return c;
}

function computePolygonBBox(pts: Point[], W: number, H: number, padding = 24): { x: number; y: number; w: number; h: number } {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.max(0, Math.min(...xs) - padding);
  const y = Math.max(0, Math.min(...ys) - padding);
  const x2 = Math.min(W, Math.max(...xs) + padding);
  const y2 = Math.min(H, Math.max(...ys) + padding);
  return { x, y, w: x2 - x, h: y2 - y };
}

function aiCropCanvas(src: HTMLCanvasElement, box: { x: number; y: number; w: number; h: number }): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = box.w; out.height = box.h;
  out.getContext("2d")!.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return out;
}

function aiResizeCanvas(src: HTMLCanvasElement, maxDim: number): HTMLCanvasElement {
  const scale = Math.min(maxDim / src.width, maxDim / src.height, 1);
  if (scale >= 1) return src;
  const out = document.createElement("canvas");
  out.width = Math.round(src.width * scale);
  out.height = Math.round(src.height * scale);
  out.getContext("2d")!.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

function aiDilateMask(mask: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = mask.width; out.height = mask.height;
  const ctx = out.getContext("2d")!;
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(mask, 0, 0);
  ctx.filter = "none";
  const d = ctx.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = d.data[i] > 30 ? 255 : 0;
    d.data[i] = d.data[i+1] = d.data[i+2] = v;
    d.data[i+3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  return out;
}

/**
 * Construye una máscara binaria que une MÚLTIPLES polígonos en una sola
 * imagen (blanco = todas las zonas a editar, negro = preservar).
 * Usado para la operación unificada de "aplicar mismo material a todas las áreas".
 */
function buildMultiPolygonMask(polys: Point[][], W: number, H: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  for (const pts of polys) {
    if (pts.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
  }
  return c;
}

/**
 * Calcula el bbox UNIÓN de varios polígonos. La operación unificada
 * envía un solo crop a la IA que cubre TODAS las áreas simultáneamente.
 */
function computeMultiPolygonBBox(polys: Point[][], W: number, H: number, padding = 24): { x: number; y: number; w: number; h: number } {
  const allPts = polys.flat();
  if (allPts.length === 0) return { x: 0, y: 0, w: W, h: H };
  return computePolygonBBox(allPts, W, H, padding);
}

/**
 * Composite multi-polígono: dibuja el resultado de IA UNA VEZ recortándolo
 * con la unión de TODAS las rutas de polígonos. Esto garantiza que el mismo
 * tile de textura se aplique a todas las áreas con bordes duros y sin
 * variación entre regiones.
 */
function aiCompositeClipMulti(
  original: HTMLCanvasElement,
  aiResult: HTMLCanvasElement,
  bbox: { x: number; y: number; w: number; h: number },
  polys: Point[][],
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = original.width; out.height = original.height;
  const ctx = out.getContext("2d")!;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.drawImage(original, 0, 0);

  ctx.save();
  ctx.beginPath();
  for (const pts of polys) {
    if (pts.length < 3) continue;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
  ctx.clip("nonzero");
  ctx.globalAlpha = 1;
  ctx.drawImage(aiResult, 0, 0, aiResult.width, aiResult.height, bbox.x, bbox.y, bbox.w, bbox.h);
  ctx.restore();
  return out;
}

function aiCompositeClip(
  original: HTMLCanvasElement,
  aiResult: HTMLCanvasElement,
  bbox: { x: number; y: number; w: number; h: number },
  polygonPts: Point[],
  solidBaseFill?: string   // colour for guaranteed-coverage base layer
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = original.width; out.height = original.height;
  const ctx = out.getContext("2d")!;

  // FASE 3+4+5: canvas de salida completamente opaco, sin herencia de alpha/composite
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur  = 0;

  // FASE 2: re-draw completo — imagen original primero (base limpia)
  ctx.drawImage(original, 0, 0);
  if (polygonPts.length < 3) return out;

  ctx.save();
  // FASE 5: al aplicar resultado de IA, reemplazar zona completamente (sin mezcla)
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.beginPath();
  ctx.moveTo(polygonPts[0].x, polygonPts[0].y);
  for (let i = 1; i < polygonPts.length; i++) ctx.lineTo(polygonPts[i].x, polygonPts[i].y);
  ctx.closePath();
  ctx.clip();

  // ① Solid base fill — garantiza CERO huecos en bordes antes de la textura IA
  if (solidBaseFill) {
    const xs = polygonPts.map(p => p.x), ys = polygonPts.map(p => p.y);
    ctx.fillStyle = solidBaseFill;
    ctx.fillRect(
      Math.min(...xs) - 1, Math.min(...ys) - 1,
      Math.max(...xs) - Math.min(...xs) + 2,
      Math.max(...ys) - Math.min(...ys) + 2
    );
  }

  // ② Textura IA — reemplaza zona completa, sin alpha bajo (FASE 5)
  ctx.globalAlpha = 1;
  ctx.drawImage(aiResult, 0, 0, aiResult.width, aiResult.height, bbox.x, bbox.y, bbox.w, bbox.h);

  ctx.restore();
  return out;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CadDesignerPage() {
  const {
    gardenImage, setGardenImage, pushGardenImageToHistory,
    undoGardenImage, canUndo: canUndoImage, imageHistoryCount,
    addMaterialCost, addDesignItem, removeDesignItem, updateDesignItem, restoreDesignItems,
    designItems, materials, materialCosts, totalProjectCost, clientInfo,
    showLabels, setShowLabels,
    cadPolygons: polygons, setCadPolygons: setPolygons,
    cadXform: xform, setCadXform: setXform,
  } = useAppContext();

  // ── Undo / Redo history ────────────────────────────────────────────────────
  const { saveSnapshot, undo, redo, canUndo, canRedo } = useCadHistory();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { isOnline } = useOnlineStatus();

  // ── State ──────────────────────────────────────────────────────────────────
  const [tool, setTool]                   = useState<Tool>("draw");
  const [activeMat, setActiveMat]         = useState("grass");
  // polygons and xform live in AppContext (see destructure above) — persisted across navigation
  const [drawing, setDrawing]             = useState<Point[] | null>(null);
  const [cursor, setCursor]               = useState<Point | null>(null);
  const [snapInfo, setSnapInfo]           = useState<SnapResult | null>(null);
  const [softSnap, setSoftSnap]           = useState(true);   // SNAP SUAVE toggle
  const [selectedId, setSelectedId]       = useState<string | null>(null);
  const [dragState, setDragState]         = useState<{polyId:string;vtxIdx:number} | null>(null);
  // ── Asset manipulation states ──────────────────────────────────────────────
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [assetMode, setAssetMode] = useState<"move" | "rotate" | "scale">("move");
  const [assetDragOrigin, setAssetDragOrigin] = useState<{
    ox: number; oy: number;         // click offset from asset center (world)
    cx: number; cy: number;         // asset center at drag start
    startRot: number;               // item.rotation at drag start
    startMouseAngle: number;        // atan2 of click relative to center
  } | null>(null);
  // xform lives in AppContext (see destructure above) — persisted across navigation
  const [ppm, setPpm]                     = useState<number | null>(null); // pixels per meter
  const [calibPhase, setCalibPhase]       = useState<CalibratePhase>("idle");
  const [calibStart, setCalibStart]       = useState<Point | null>(null);
  const [calibEnd, setCalibEnd]           = useState<Point | null>(null);
  const [calibInput, setCalibInput]       = useState("");
  const [showCalibModal, setShowCalibModal] = useState(false);
  const [bgImg, setBgImg]                 = useState<HTMLImageElement | null>(null);
  const [panOrigin, setPanOrigin]         = useState<{mx:number;my:number;tx:number;ty:number} | null>(null);
  const [shiftHeld, setShiftHeld]         = useState(false);
  const [labelMap, setLabelMap]           = useState<Record<string,string>>({});
  const [isApplying, setIsApplying]       = useState(false);
  const [applyingId, setApplyingId]       = useState<string | null>(null);
  const [applyMsg, setApplyMsg]           = useState("");
  const [isDesigning, setIsDesigning]     = useState(false);
  const [designMsg, setDesignMsg]         = useState("");
  const [designBOM, setDesignBOM]         = useState<BOMItem[] | null>(null);
  const [bomExpanded, setBomExpanded]     = useState(false);
  const [bomAddedToQuote, setBomAddedToQuote] = useState(false);
  // Per-polygon density multiplier overrides (user-editable)
  const [densityOverrides, setDensityOverrides] = useState<Record<string, number>>({});
  // Per-material user-editable price overrides (materialId → price per unit)
  const [priceOverrides, setPriceOverrides] = useState<Record<string, number>>({});
  const [showMaterialSummary, setShowMaterialSummary] = useState(false);
  // ── Modo de medición por polígono (override manual) ──────────────────────
  const [measureModeOverrides, setMeasureModeOverrides] = useState<Record<string, "area" | "length">>({});
  // ── Modo de escena + luces ────────────────────────────────────────────────
  const [sceneMode, setSceneMode] = useState<"day" | "night">("day");
  const [lights, setLights] = useState<{ x: number; y: number; radius: number; intensity: number }[]>([]);
  // ── Cotización en tiempo real ─────────────────────────────────────────────
  const [applyIVA, setApplyIVA] = useState(false);
  const [showQuoteSummary, setShowQuoteSummary] = useState(true);
  // ── Partidas manuales ─────────────────────────────────────────────────────
  const [showManualPanel, setShowManualPanel]   = useState(true);
  const [manualConcept, setManualConcept]       = useState("");
  const [manualQty, setManualQty]               = useState("");
  const [manualUnit, setManualUnit]             = useState<"m2" | "ml">("m2");
  const [manualPrice, setManualPrice]           = useState("");
  const [manualEntries, setManualEntries]       = useState<{ id: string; concept: string; qty: number; unit: "m2" | "ml"; price: number; total: number }[]>([]);
  const [designStyle, setDesignStyle]     = useState("moderno");
  const [showWalkthrough, setShowWalkthrough] = useState(false);
  // ── Sugerir diseño ────────────────────────────────────────────────────────
  const [suggestions, setSuggestions]         = useState<SuggestionZone[]>([]);
  const [suggestionPlants, setSuggestionPlants] = useState<SuggestionPlant[]>([]);
  const [suggestionBOM, setSuggestionBOM]     = useState<BOMItem[] | null>(null);
  const [suggestionSummary, setSuggestionSummary] = useState("");
  const [isSuggesting, setIsSuggesting]       = useState(false);
  const [suggestMsg, setSuggestMsg]           = useState("");
  const [suggestStyle, setSuggestStyle]       = useState("moderno");
  const [wtInventory, setWtInventory]     = useState<WTInventoryItem[]>([]);
  const [isExporting, setIsExporting]     = useState(false);
  const [exportType, setExportType]       = useState<"image" | "json" | "complete" | null>(null);
  const [isCleaningTerrain, setIsCleaningTerrain] = useState(false);
  const [isAutoGrass,       setIsAutoGrass]       = useState(false);
  const [cleanedTerrainUrl, setCleanedTerrainUrl] = useState<string | null>(null);
  const cadImageInputRef = useRef<HTMLInputElement>(null);

  // ── Layer system ────────────────────────────────────────────────────────────
  const [layerStates, setLayerStates] = useState<Record<LayerId, LayerState>>(DEFAULT_LAYER_STATES);
  const [activeLayerId, setActiveLayerId] = useState<LayerId>("zones");
  const [showLayerPanel, setShowLayerPanel] = useState(false);

  const toggleLayerVisible = useCallback((id: LayerId) => {
    setLayerStates(prev => ({ ...prev, [id]: { ...prev[id], visible: !prev[id].visible } }));
  }, []);

  const toggleLayerLocked = useCallback((id: LayerId) => {
    setLayerStates(prev => ({ ...prev, [id]: { ...prev[id], locked: !prev[id].locked } }));
  }, []);

  // Derived: is zones layer editable?
  const zonesLocked = layerStates.zones.locked;

  // ── Responsive device detection ────────────────────────────────────────────
  const [deviceType, setDeviceType] = useState<"mobile" | "tablet" | "desktop">(() => {
    if (typeof window === "undefined") return "desktop";
    const isCoarse = window.matchMedia("(pointer: coarse)").matches;
    const w = window.innerWidth;
    if (!isCoarse) return "desktop";
    return w < 768 ? "mobile" : "tablet";
  });
  const isMobile = deviceType === "mobile";
  const isTablet  = deviceType === "tablet";
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  useEffect(() => {
    const detect = () => {
      const isCoarse = window.matchMedia("(pointer: coarse)").matches;
      const w = window.innerWidth;
      setDeviceType(!isCoarse ? "desktop" : w < 768 ? "mobile" : "tablet");
    };
    window.addEventListener("resize", detect);
    const mql = window.matchMedia("(pointer: coarse)");
    mql.addEventListener("change", detect);
    return () => {
      window.removeEventListener("resize", detect);
      mql.removeEventListener("change", detect);
    };
  }, []);

  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const measureCanvasRef = useRef<HTMLCanvasElement>(null);  // measurement-only overlay
  const animRef          = useRef<number>(0);
  const measureAnimRef   = useRef<number>(0);
  const needsRedraw      = useRef(false);
  const imgCacheRef      = useRef<Map<string, HTMLImageElement>>(new Map());

  // ── Snapshot helpers ────────────────────────────────────────────────────────
  /** Capture the complete current state (excludes imageData to keep size small). */
  const getSnapshot = useCallback((): CadSnapshot => ({
    polygons: JSON.parse(JSON.stringify(polygons)),
    designItems: designItems.map(({ imageData: _img, ...rest }) => rest),
    ppm,
    labelMap,
    measureModeOverrides: { ...measureModeOverrides },
  }), [polygons, designItems, ppm, labelMap, measureModeOverrides]);

  /** Apply a snapshot: restores polygons, design items, ppm and labelMap. */
  const restoreSnapshot = useCallback((snap: CadSnapshot) => {
    setPolygons(snap.polygons as unknown as LocalPolygon[]);
    restoreDesignItems(snap.designItems);
    setPpm(snap.ppm);
    setLabelMap(snap.labelMap);
    setMeasureModeOverrides(snap.measureModeOverrides ?? {});
  }, [restoreDesignItems]);

  /**
   * Always-fresh ref for keyboard handler — avoids stale closures without
   * re-registering the event listener on every render.
   */
  const kbRef = useRef({ getSnapshot, saveSnapshot, undo, redo, restoreSnapshot, selectedId, resetMeasurement: null as (() => void) | null });
  useEffect(() => {
    kbRef.current = { getSnapshot, saveSnapshot, undo, redo, restoreSnapshot, selectedId, resetMeasurement: resetMeasurementSystem };
  }); // intentionally no deps — runs every render

  // ── Load background image ──────────────────────────────────────────────────
  useEffect(() => {
    if (!gardenImage) return;
    const img = new Image();
    img.onload = () => {
      setBgImg(img);
      // Only auto-fit to viewport if xform was never set (first load).
      // On return from another module the persisted xform is preserved.
      setXform(prev => {
        const isDefault = prev.scale === 1 && prev.tx === 0 && prev.ty === 0;
        if (!isDefault) return prev; // keep the user's existing zoom/pan
        const canvas = canvasRef.current;
        if (!canvas) return prev;
        const cW = canvas.width, cH = canvas.height;
        const s = clampScale(Math.min(cW / img.naturalWidth, cH / img.naturalHeight) * 0.92);
        return {
          scale: s,
          tx: (cW - img.naturalWidth * s) / 2,
          ty: (cH - img.naturalHeight * s) / 2,
        };
      });
    };
    img.src = gardenImage;
  }, [gardenImage]);

  // ── Keyboard shortcuts (registered once — uses kbRef for always-fresh state) ─
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Tool shortcuts — FASE 4: resetear medición al cambiar de herramienta
      if (e.key === "d" || e.key === "D") { kbRef.current.resetMeasurement?.(); setTool("draw"); }
      if (e.key === "s" || e.key === "S") { kbRef.current.resetMeasurement?.(); setTool("select"); }
      if (e.key === "c" || e.key === "C") { kbRef.current.resetMeasurement?.(); setTool("calibrate"); }

      if (e.key === "Escape") {
        kbRef.current.resetMeasurement?.();
        setSelectedId(null);
      }

      // Delete selected polygon
      if ((e.key === "Delete" || e.key === "Backspace") && kbRef.current.selectedId) {
        const { getSnapshot: gs, saveSnapshot: ss, selectedId: sid } = kbRef.current;
        ss(gs());
        setPolygons(ps => ps.filter(p => p.id !== sid));
        setSelectedId(null);
        return;
      }

      // Ctrl+Z → Undo
      if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        const { getSnapshot: gs, undo: u, restoreSnapshot: rs } = kbRef.current;
        const prev = u(gs());
        if (prev) rs(prev);
        return;
      }

      // Ctrl+Shift+Z / Ctrl+Y → Redo
      if ((e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey) ||
          (e.key === "y" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        const { getSnapshot: gs, redo: r, restoreSnapshot: rs } = kbRef.current;
        const next = r(gs());
        if (next) rs(next);
        return;
      }
    };

    const up = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []); // intentionally empty — kbRef always has fresh state

  // ── Hard reset del sistema de medición ───────────────────────────────────
  /**
   * FASE 2 — resetMeasurementSystem:
   * Limpia la capa de medición Y todo el estado asociado.
   * Llamar SIEMPRE antes de: cambio de imagen, aplicar material, salir de CAD.
   */
  const resetMeasurementSystem = useCallback(() => {
    // Limpiar canvas overlay de medición
    const mc = measureCanvasRef.current;
    if (mc) {
      const mctx = mc.getContext("2d");
      if (mctx) mctx.clearRect(0, 0, mc.width, mc.height);
    }
    // Resetear estado de calibración
    setCalibPhase("idle");
    setCalibStart(null);
    setCalibEnd(null);
    setCalibInput("");
    setShowCalibModal(false);
    // Resetear estado de dibujo en curso (líneas verdes)
    setDrawing(null);
    setCursor(null);
    setSnapInfo(null);
  }, []);

  // ── Canvas sizing ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      needsRedraw.current = true;
    });
    obs.observe(canvas);
    return () => obs.disconnect();
  }, []);

  // ── Measurement canvas sizing (sigue al canvas principal) ─────────────────
  useEffect(() => {
    const mc = measureCanvasRef.current;
    const main = canvasRef.current;
    if (!mc || !main) return;
    const obs = new ResizeObserver(() => {
      mc.width  = main.offsetWidth;
      mc.height = main.offsetHeight;
    });
    obs.observe(main);
    return () => obs.disconnect();
  }, []);

  // ── PASO 3 (spec): cargar texturas una sola vez al montar el canvas ────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    loadTextures(ctx);
  }, []);

  // ── Snap helper ───────────────────────────────────────────────────────────
  const snapPoint = useCallback((raw: Point, excludePolyId?: string, excludeVtxIdx?: number): Point => {
    let best = raw;
    let bestD = SNAP_R / xform.scale;
    for (const poly of polygons) {
      if (poly.id === excludePolyId) continue;
      for (const pt of poly.points) {
        const d = dist(pt, raw);
        if (d < bestD) { bestD = d; best = pt; }
      }
    }
    if (drawing && drawing.length > 0) {
      for (let i = 0; i < drawing.length; i++) {
        if (i === excludeVtxIdx) continue;
        const d = dist(drawing[i], raw);
        if (d < bestD) { bestD = d; best = drawing[i]; }
      }
    }
    return best;
  }, [polygons, drawing, xform.scale]);

  // ── Asset image helpers ───────────────────────────────────────────────────
  /** Default half-size (world px) of an asset at scale=1. */
  const ASSET_BASE = 60;

  /** Load/cache a design item's imageData into an HTMLImageElement. */
  const getAssetImage = useCallback((item: DesignItem): HTMLImageElement | null => {
    if (!item.imageData) return null;
    const cached = imgCacheRef.current.get(item.id);
    if (cached) return cached;
    const img = new Image();
    img.src = item.imageData;
    img.onload = () => { imgCacheRef.current.set(item.id, img); };
    imgCacheRef.current.set(item.id, img);
    return img;
  }, []);

  /** Hit-test a world point against an (optionally rotated) asset bounding box.
   *  item.x / item.y are stored normalised (0-1) relative to bgImg dimensions. */
  const hitTestAsset = useCallback((item: DesignItem, wx: number, wy: number): boolean => {
    const hw = ASSET_BASE * item.scale;
    const hh = ASSET_BASE * item.scale;
    const iW = bgImg?.naturalWidth  ?? canvasRef.current?.width  ?? 800;
    const iH = bgImg?.naturalHeight ?? canvasRef.current?.height ?? 600;
    const ix = item.x * iW;
    const iy = item.y * iH;
    const dx = wx - ix;
    const dy = wy - iy;
    const r  = item.rotation ?? 0;
    const ux =  dx * Math.cos(-r) - dy * Math.sin(-r);
    const uy =  dx * Math.sin(-r) + dy * Math.cos(-r);
    return Math.abs(ux) <= hw && Math.abs(uy) <= hh;
  }, [bgImg]);

  // ── Render loop ───────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // ── FASE 1+3+4: Limpieza total del frame anterior ─────────────────────────
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    ctx.save();
    ctx.translate(xform.tx, xform.ty);
    ctx.scale(xform.scale, xform.scale);
    // Estado limpio dentro del transform
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    // ── LAYER: Background ─────────────────────────────────────────────────────
    if (layerStates.background.visible) {
      if (bgImg) {
        ctx.drawImage(bgImg, 0, 0, bgImg.naturalWidth, bgImg.naturalHeight);
      } else {
        ctx.fillStyle = "#1a1a2e";
        const w = canvas.width / xform.scale;
        const h = canvas.height / xform.scale;
        ctx.fillRect(0, 0, w, h);
      }
    } else {
      // Background hidden — dark fill to indicate hidden layer
      ctx.fillStyle = "#111118";
      ctx.fillRect(0, 0, canvas.width / xform.scale, canvas.height / xform.scale);
    }

    // ── LAYER: Zones (polygons) ───────────────────────────────────────────────
    // Closed polygons — fill primero, stroke después con sombra scoped por zona
    for (const poly of polygons) {
      if (!poly.closed || poly.points.length < 3) continue;
      if (!layerStates.zones.visible) continue; // layer hidden
      const mat = getMaterial(poly.materialId);
      const isSelected = poly.id === selectedId;

      // Si la zona ya tiene textura IA integrada en gardenImage, NO dibujar el
      // patrón procedural encima — la imagen base ya contiene el resultado final.
      // Solo se dibuja el fill procedural cuando aiApplied es falso/undefined.
      if (!poly.aiApplied) {
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        drawMaterialFill(ctx, poly.points, mat);
      }

      // Stroke con sombra scoped — FASE 4: la sombra es local a este save/restore
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.shadowColor = "rgba(0,0,0,0.18)";
      ctx.shadowBlur  = 8 / xform.scale;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.beginPath();
      ctx.moveTo(poly.points[0].x, poly.points[0].y);
      for (let i = 1; i < poly.points.length; i++) ctx.lineTo(poly.points[i].x, poly.points[i].y);
      ctx.closePath();
      ctx.strokeStyle = isSelected ? "#f59e0b" : mat.strokeColor;
      ctx.lineWidth = isSelected ? 2.5 / xform.scale : 1.8 / xform.scale;
      ctx.stroke();
      ctx.restore();

      // Vertices (only when selected) — sin sombra
      if (isSelected || tool === "select") {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.shadowColor = "transparent";
        ctx.shadowBlur  = 0;
        for (const pt of poly.points) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, VERTEX_R / xform.scale, 0, Math.PI * 2);
          ctx.fillStyle = isSelected ? "#f59e0b" : "#ffffff";
          ctx.fill();
          ctx.strokeStyle = mat.strokeColor;
          ctx.lineWidth = 1.5 / xform.scale;
          ctx.stroke();
        }
        ctx.restore();
      }

    }
    // Zone labels are rendered as HTML overlay (see JSX below render loop)
    // FASE 3+4: estado limpio para capas siguientes
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.shadowColor = "transparent";
    ctx.shadowBlur  = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // ── LAYER: Pools (chukum + water) — drawn ON TOP of base material ─────────
    for (const poly of polygons) {
      if (!poly.closed || poly.points.length < 3) continue;
      if (poly.poolType !== "pool") continue;
      if (!layerStates.zones.visible) continue;
      drawPool(ctx, poly.points, xform.scale);
      // Pool stroke (selected = amber, otherwise teal)
      const isSelected = poly.id === selectedId;
      ctx.beginPath();
      ctx.moveTo(poly.points[0].x, poly.points[0].y);
      for (let i = 1; i < poly.points.length; i++) ctx.lineTo(poly.points[i].x, poly.points[i].y);
      ctx.closePath();
      ctx.strokeStyle = isSelected ? "#f59e0b" : "#22d3ee";
      ctx.lineWidth = isSelected ? 2.5 / xform.scale : 2 / xform.scale;
      ctx.stroke();
      // Pool depth label in image space
      if (poly.poolDepth) {
        const cx = poly.points.reduce((s, p) => s + p.x, 0) / poly.points.length;
        const cy = poly.points.reduce((s, p) => s + p.y, 0) / poly.points.length;
        ctx.font = `bold ${12 / xform.scale}px 'Inter', sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`🏊 ${poly.poolDepth}m prof.`, cx, cy);
        ctx.textBaseline = "alphabetic";
      }
    }

    // ── LAYER: Suggestion zones (dashed amber preview) ──────────────────────────
    if (suggestions.length > 0) {
      for (const sz of suggestions) {
        if (sz.points.length < 3) continue;
        const mat = getMaterial(sz.materialId);
        ctx.save();
        // Semi-transparent fill
        ctx.beginPath();
        ctx.moveTo(sz.points[0].x, sz.points[0].y);
        for (let i = 1; i < sz.points.length; i++) ctx.lineTo(sz.points[i].x, sz.points[i].y);
        ctx.closePath();
        ctx.fillStyle = mat.fillColor + "55"; // ~33% opacity
        ctx.fill();
        // Dashed animated border
        ctx.setLineDash([10 / xform.scale, 5 / xform.scale]);
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 2.5 / xform.scale;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      // Suggestion plant markers
      for (const sp of suggestionPlants) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 8 / xform.scale, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(16, 185, 129, 0.7)";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5 / xform.scale;
        ctx.stroke();
        ctx.restore();
      }
    }

    // In-progress drawing (only when zones layer visible)
    if (drawing && drawing.length > 0 && layerStates.zones.visible) {
      const mat = getMaterial(activeMat);
      ctx.beginPath();
      ctx.moveTo(drawing[0].x, drawing[0].y);
      for (let i = 1; i < drawing.length; i++) ctx.lineTo(drawing[i].x, drawing[i].y);
      if (cursor) ctx.lineTo(cursor.x, cursor.y);
      ctx.strokeStyle = mat.strokeColor;
      ctx.lineWidth = 2 / xform.scale;
      ctx.setLineDash([6 / xform.scale, 3 / xform.scale]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Vertices
      for (let i = 0; i < drawing.length; i++) {
        const pt = drawing[i];
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, VERTEX_R / xform.scale, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? "#10b981" : mat.strokeColor;
        ctx.fill();
        if (i === 0 && drawing.length >= 3) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2 / xform.scale;
          ctx.stroke();
        }
      }

      // Closing guide circle
      if (drawing.length >= 3) {
        ctx.beginPath();
        ctx.arc(drawing[0].x, drawing[0].y, CLOSE_R / xform.scale, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(16,185,129,0.5)";
        ctx.lineWidth = 1.5 / xform.scale;
        ctx.stroke();
      }

      // ── Smart snap indicators ─────────────────────────────────────────────
      if (cursor && snapInfo) {
        const snapColors: Record<NonNullable<SnapType>, string> = {
          horizontal:    "rgba(0,210,255,0.85)",
          vertical:      "rgba(0,210,255,0.85)",
          perpendicular: "rgba(255,180,0,0.90)",
          parallel:      "rgba(200,80,255,0.85)",
          vertex:        "rgba(255,220,40,0.90)",
          close:         "rgba(16,185,129,0.95)",
        };
        const col = snapInfo.type ? snapColors[snapInfo.type] : mat.strokeColor;
        const mr  = 6 / xform.scale;

        ctx.save();

        // Tracking line (dashed guide from anchor)
        if (snapInfo.trackLines.length > 0) {
          ctx.setLineDash([3 / xform.scale, 3 / xform.scale]);
          ctx.lineWidth = 0.8 / xform.scale;
          ctx.strokeStyle = col;
          for (const [from, to] of snapInfo.trackLines) {
            // Extend the line visually beyond the snap point
            const ddx = to.x - from.x; const ddy = to.y - from.y;
            const extend = 40 / xform.scale;
            const extLen = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
            const ex = (ddx / extLen) * extend; const ey = (ddy / extLen) * extend;
            ctx.beginPath();
            ctx.moveTo(from.x - ex, from.y - ey);
            ctx.lineTo(to.x + ex, to.y + ey);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }

        // Snap glyph at cursor position
        ctx.lineWidth = 1.5 / xform.scale;
        ctx.strokeStyle = col;
        if (snapInfo.type === "horizontal" || snapInfo.type === "vertical") {
          // Square □ for orthogonal
          ctx.strokeRect(cursor.x - mr, cursor.y - mr, mr * 2, mr * 2);
        } else if (snapInfo.type === "perpendicular") {
          // ⊥ symbol
          ctx.beginPath();
          ctx.moveTo(cursor.x - mr, cursor.y + mr);
          ctx.lineTo(cursor.x + mr, cursor.y + mr);
          ctx.moveTo(cursor.x, cursor.y + mr);
          ctx.lineTo(cursor.x, cursor.y - mr);
          ctx.stroke();
        } else if (snapInfo.type === "parallel") {
          // // two parallel lines
          ctx.beginPath();
          ctx.moveTo(cursor.x - mr, cursor.y - mr * 0.35);
          ctx.lineTo(cursor.x + mr, cursor.y - mr * 0.35);
          ctx.moveTo(cursor.x - mr, cursor.y + mr * 0.35);
          ctx.lineTo(cursor.x + mr, cursor.y + mr * 0.35);
          ctx.stroke();
        } else {
          // Circle for vertex / close
          ctx.beginPath();
          ctx.arc(cursor.x, cursor.y, mr, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Snap label
        if (snapInfo.label) {
          const labelSize = 8 / xform.scale;
          ctx.font = `bold ${labelSize}px Inter,sans-serif`;
          ctx.fillStyle = col;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(snapInfo.label, cursor.x + mr + 3 / xform.scale, cursor.y - mr);
          ctx.textBaseline = "alphabetic";
        }

        ctx.restore();
      } else if (cursor) {
        // Default cursor dot (no snap active)
        ctx.beginPath();
        ctx.arc(cursor.x, cursor.y, 4 / xform.scale, 0, Math.PI * 2);
        ctx.fillStyle = mat.strokeColor;
        ctx.fill();
      }
    }

    // Calibration lines are rendered on measureCanvasRef (separate overlay) — NOT here

    // ── Preview cursor de luz — halo cálido cuando light tool está activo ──────
    if (tool === "light" && cursor) {
      const pr = 120 / xform.scale;
      const pg = ctx.createRadialGradient(cursor.x, cursor.y, 0, cursor.x, cursor.y, pr);
      pg.addColorStop(0,   "rgba(255,220,150,0.35)");
      pg.addColorStop(0.4, "rgba(255,200,100,0.15)");
      pg.addColorStop(1,   "rgba(0,0,0,0)");
      ctx.save();
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, pr, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, 5 / xform.scale, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,240,180,0.7)";
      ctx.fill();
      ctx.restore();
    }

    // ── LAYER: Overlay nocturno — velo oscuro azul-noche sobre toda la escena ──
    if (sceneMode === "night") {
      // FASE 4: overlay con source-over puro (sin composite acumulado)
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.shadowColor = "transparent";
      ctx.shadowBlur  = 0;
      const vx = -xform.tx / xform.scale;
      const vy = -xform.ty / xform.scale;
      const vw =  canvas.width  / xform.scale;
      const vh =  canvas.height / xform.scale;
      ctx.fillStyle = "rgba(0,0,30,0.55)";
      ctx.fillRect(vx, vy, vw, vh);
      ctx.restore();
    }

    // ── LAYER: Luces — radial gradient con modo aditivo (lighter) ─────────────
    // Se renderizan SIEMPRE (en día son sutiles, en noche perforan el overlay)
    // FASE 4: "lighter" CONTROLADO — scoped en save/restore por cada luz
    for (const light of lights) {
      const r = (light.radius ?? 120) / xform.scale;
      const alpha = light.intensity ?? 0.7;

      const gradient = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, r);
      gradient.addColorStop(0,   `rgba(255,220,150,${(alpha * 0.9).toFixed(2)})`);
      gradient.addColorStop(0.3, `rgba(255,200,120,${(alpha * 0.5).toFixed(2)})`);
      gradient.addColorStop(1,   "rgba(0,0,0,0)");

      ctx.save();
      // "lighter" scoped — nunca contamina capas siguientes
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 1;
      ctx.shadowColor = "transparent";
      ctx.shadowBlur  = 0;
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(light.x, light.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Glifo del foco — visible en día y noche
      const dotR = 5 / xform.scale;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      ctx.arc(light.x, light.y, dotR * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(light.x, light.y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = "#fff9c4";
      ctx.shadowColor = "rgba(255,220,100,0.9)";
      ctx.shadowBlur = 8 / xform.scale;
      ctx.fill();
      ctx.restore();
    }

    // FASE 3+4: limpieza garantizada tras luces (composite "lighter" ya no activo)
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.shadowColor = "transparent";
    ctx.shadowBlur  = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // ── LAYER: Design items (plants, lamps, stones) ──────────────────────────
    if (layerStates.plants.visible) {
      // item.x / item.y are normalised (0-1) → convert to world pixels once
      const _iW = bgImg?.naturalWidth  ?? canvas.width;
      const _iH = bgImg?.naturalHeight ?? canvas.height;
      for (const item of designItems) {
        const hw  = ASSET_BASE * item.scale;
        const hh  = ASSET_BASE * item.scale;
        const r   = item.rotation ?? 0;
        const sel = item.id === selectedAssetId;
        const wx  = item.x * _iW;
        const wy  = item.y * _iH;

        // ── Images and labels are rendered in the HTML overlay (CSS 3D perspective).
        // ── Canvas only draws selection handles so hit-testing stays intact.

        // Selection handles (drawn on canvas in world-space)
        if (sel) {
          ctx.save();
          ctx.translate(wx, wy);
          ctx.rotate(r);
          // dashed outline
          ctx.strokeStyle = "#3b82f6";
          ctx.lineWidth = 2 / xform.scale;
          ctx.setLineDash([6 / xform.scale, 3 / xform.scale]);
          ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
          ctx.setLineDash([]);
          // corner handles
          const hs = 6 / xform.scale;
          for (const [cx2, cy2] of [[-hw,-hh],[hw,-hh],[-hw,hh],[hw,hh]]) {
            ctx.fillStyle = "#fff";
            ctx.strokeStyle = "#3b82f6";
            ctx.lineWidth = 1.5 / xform.scale;
            ctx.fillRect(cx2 - hs/2, cy2 - hs/2, hs, hs);
            ctx.strokeRect(cx2 - hs/2, cy2 - hs/2, hs, hs);
          }
          // rotation handle (top-center)
          const rhx = 0, rhy = -hh - 18 / xform.scale;
          ctx.beginPath();
          ctx.moveTo(0, -hh);
          ctx.lineTo(rhx, rhy);
          ctx.strokeStyle = "#3b82f6";
          ctx.lineWidth = 1.5 / xform.scale;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(rhx, rhy, 5 / xform.scale, 0, Math.PI * 2);
          ctx.fillStyle = assetMode === "rotate" ? "#f59e0b" : "#3b82f6";
          ctx.fill();
          ctx.restore();
        }
      }
    }

    ctx.restore();
  }, [bgImg, polygons, drawing, cursor, snapInfo, selectedId, tool, xform, activeMat, ppm, layerStates, suggestions, suggestionPlants, sceneMode, lights, designItems, selectedAssetId, assetMode, getAssetImage]);

  useEffect(() => {
    const frame = () => {
      render();
      animRef.current = requestAnimationFrame(frame);
    };
    animRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animRef.current);
  }, [render]);

  // ── FASE 1: renderMeasurement — dibuja SÓLO en measureCanvas (capa separada) ─
  const renderMeasurement = useCallback(() => {
    const mc = measureCanvasRef.current;
    if (!mc) return;
    const mctx = mc.getContext("2d");
    if (!mctx) return;

    // FASE 9: BLOQUEO — si el tool no es calibrate, capa vacía
    mctx.clearRect(0, 0, mc.width, mc.height);
    if (tool !== "calibrate") return;

    mctx.save();
    mctx.translate(xform.tx, xform.ty);
    mctx.scale(xform.scale, xform.scale);

    // Línea en progreso (calibStart → cursor)
    if (calibPhase === "picking-end" && calibStart && cursor) {
      mctx.beginPath();
      mctx.moveTo(calibStart.x, calibStart.y);
      mctx.lineTo(cursor.x, cursor.y);
      mctx.strokeStyle = "#f59e0b";
      mctx.lineWidth = 2 / xform.scale;
      mctx.setLineDash([8 / xform.scale, 4 / xform.scale]);
      mctx.stroke();
      mctx.setLineDash([]);
      const d = dist(calibStart, cursor);
      mctx.font = `${13 / xform.scale}px 'Inter', sans-serif`;
      mctx.fillStyle = "#f59e0b";
      mctx.textAlign = "center";
      mctx.fillText(`${d.toFixed(0)} px`, (calibStart.x + cursor.x) / 2, (calibStart.y + cursor.y) / 2 - 14 / xform.scale);
    }

    // Línea confirmada (calibStart → calibEnd)
    if (calibStart && (calibPhase === "entering-value" || calibPhase === "picking-end") && calibEnd) {
      mctx.beginPath();
      mctx.moveTo(calibStart.x, calibStart.y);
      mctx.lineTo(calibEnd.x, calibEnd.y);
      mctx.strokeStyle = "#f59e0b";
      mctx.lineWidth = 2.5 / xform.scale;
      mctx.stroke();
    }

    mctx.restore();
  }, [tool, xform, calibPhase, calibStart, calibEnd, cursor]);

  // RAF propio del canvas de medición
  useEffect(() => {
    const frame = () => {
      renderMeasurement();
      measureAnimRef.current = requestAnimationFrame(frame);
    };
    measureAnimRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(measureAnimRef.current);
  }, [renderMeasurement]);

  // Limpiar medición al desmontar el módulo CAD
  useEffect(() => {
    return () => { resetMeasurementSystem(); };
  }, [resetMeasurementSystem]);

  // ── Device type resize listener ───────────────────────────────────────────
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      setDeviceType(w < 768 ? "mobile" : w < 1024 ? "tablet" : "desktop");
    };
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, []);

  // ── Fetch inventory items when walkthrough opens ───────────────────────────
  useEffect(() => {
    if (!showWalkthrough) return;
    const _tok = localStorage.getItem("urbanai_token");
    fetch("/api/inventory", { credentials: "include", headers: _tok ? { Authorization: "Bearer " + _tok } : {} })
      .then(r => r.ok ? r.json() : [])
      .then((items: any[]) =>
        setWtInventory(items.map(i => ({
          id: Number(i.id),
          name: String(i.name),
          itemType: i.itemType ?? null,
          category: i.category ?? null,
        })))
      )
      .catch(() => {/* non-fatal */});
  }, [showWalkthrough]);

  // ── Mouse events ───────────────────────────────────────────────────────────
  const getPoint = useCallback((e: React.MouseEvent): Point => {
    return canvasPoint(e, canvasRef.current!, xform);
  }, [xform]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const raw = getPoint(e);

    if (panOrigin) {
      const dx = (e.clientX - panOrigin.mx);
      const dy = (e.clientY - panOrigin.my);
      setXform(prev => ({ ...prev, tx: panOrigin.tx + dx, ty: panOrigin.ty + dy }));
      return;
    }

    // ── Asset drag/rotate ──────────────────────────────────────────────────
    if (assetDragOrigin && selectedAssetId) {
      const item = designItems.find(i => i.id === selectedAssetId);
      if (item) {
        const _iW = bgImg?.naturalWidth  ?? canvasRef.current?.width  ?? 800;
        const _iH = bgImg?.naturalHeight ?? canvasRef.current?.height ?? 600;
        if (assetMode === "move") {
          // raw is in world-pixels; store back as normalised (0-1)
          const newWx = raw.x - assetDragOrigin.ox;
          const newWy = raw.y - assetDragOrigin.oy;
          updateDesignItem(selectedAssetId, {
            x: Math.max(0, Math.min(1, newWx / _iW)),
            y: Math.max(0, Math.min(1, newWy / _iH)),
          });
        } else if (assetMode === "rotate") {
          const newAngle = Math.atan2(raw.y - assetDragOrigin.cy, raw.x - assetDragOrigin.cx);
          const delta    = newAngle - assetDragOrigin.startMouseAngle;
          updateDesignItem(selectedAssetId, { rotation: assetDragOrigin.startRot + delta });
        }
      }
      return;
    }

    if (dragState) {
      const snapped = snapPoint(raw, dragState.polyId, dragState.vtxIdx);
      setPolygons(ps => ps.map(p => {
        if (p.id !== dragState.polyId) return p;
        const pts = p.points.map((v, i) => i === dragState.vtxIdx ? snapped : v);
        return { ...p, points: pts };
      }));
      return;
    }

    if (tool === "draw") {
      // SmartSnap en mouse move = SOLO preview visual (no obliga en click)
      if (softSnap) {
        const result = smartSnap(raw, drawing, polygons, xform.scale);
        setCursor(result.point);
        setSnapInfo(result.type ? result : null);
      } else {
        // snap desactivado — cursor libre, sin indicadores
        setCursor(raw);
        setSnapInfo(null);
      }
      return;
    }

    let snapped = snapPoint(raw);
    if (tool === "calibrate" && calibPhase === "picking-end" && calibStart && shiftHeld) {
      snapped = snapAngle(calibStart, snapped);
    }
    setCursor(snapped);
    setSnapInfo(null);
  }, [getPoint, panOrigin, dragState, tool, drawing, polygons, xform.scale, shiftHeld, snapPoint, calibPhase, calibStart, softSnap, assetDragOrigin, selectedAssetId, assetMode, designItems, updateDesignItem, bgImg]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const raw = getPoint(e);

    // Middle mouse or Alt+drag = pan
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      setPanOrigin({ mx: e.clientX, my: e.clientY, tx: xform.tx, ty: xform.ty });
      return;
    }
    if (e.button !== 0) return;

    // ── Asset hit detection — has priority over all other tools ───────────────
    // Check in reverse order so top-most (last added) asset wins
    for (let i = designItems.length - 1; i >= 0; i--) {
      const item = designItems[i];
      if (hitTestAsset(item, raw.x, raw.y)) {
        setSelectedAssetId(item.id);
        // item.x/y are normalised (0-1); convert to world-pixels for drag math
        const _iW = bgImg?.naturalWidth  ?? canvasRef.current?.width  ?? 800;
        const _iH = bgImg?.naturalHeight ?? canvasRef.current?.height ?? 600;
        const ix = item.x * _iW;
        const iy = item.y * _iH;
        if (assetMode === "move") {
          setAssetDragOrigin({
            ox: raw.x - ix, oy: raw.y - iy,
            cx: ix, cy: iy,
            startRot: item.rotation ?? 0,
            startMouseAngle: Math.atan2(raw.y - iy, raw.x - ix),
          });
        } else if (assetMode === "rotate") {
          setAssetDragOrigin({
            ox: 0, oy: 0,
            cx: ix, cy: iy,
            startRot: item.rotation ?? 0,
            startMouseAngle: Math.atan2(raw.y - iy, raw.x - ix),
          });
        }
        return;
      }
    }
    // Click on empty space = deselect asset
    if (selectedAssetId) {
      setSelectedAssetId(null);
      setAssetDragOrigin(null);
      return;
    }

    // ─ Draw tool ─
    if (tool === "draw") {
      if (zonesLocked) { return; } // layer locked — no edit

      // ── SNAP SUAVE: click guarda PUNTO REAL ──────────────────────────────────
      // Solo se permite vertex snap (cerrar a vértice existente) y close snap
      // (cerrar polígono al primer punto). Los snaps de ángulo (H/V/perp/paralelo)
      // son SOLO visuales en mouseMove — no afectan el punto guardado.
      let pt: Point = raw;

      if (softSnap) {
        const snapR  = SNAP_R  / xform.scale;
        const closeR = CLOSE_R / xform.scale;

        // ① Close polygon — snap al primer punto si está cerca
        if (drawing && drawing.length >= 3 && dist(raw, drawing[0]) < closeR) {
          pt = drawing[0];
        } else {
          // ② Vertex snap — snap a vértice existente más cercano
          let bestD = snapR;
          let bestV: Point | null = null;
          for (const poly of polygons) {
            for (const v of poly.points) {
              const d = dist(v, raw);
              if (d < bestD) { bestD = d; bestV = v; }
            }
          }
          if (drawing) {
            for (const v of drawing) {
              const d = dist(v, raw);
              if (d < bestD) { bestD = d; bestV = v; }
            }
          }
          if (bestV) pt = bestV;
          // ③ Ángulos NO se aplican al click — el cursor se mueve libre
        }
      }

      if (drawing === null) {
        setDrawing([pt]);
        return;
      }

      // Cerrar polígono
      if (drawing.length >= 3 && dist(pt, drawing[0]) < CLOSE_R / xform.scale) {
        saveSnapshot(getSnapshot());
        const id = nanoid(8);
        const mat = getMaterial(activeMat);
        setPolygons(ps => [...ps, {
          id, points: drawing, materialId: activeMat, closed: true, label: mat.name,
        }]);
        setDrawing(null);
        setSelectedId(id);
        return;
      }

      setDrawing([...drawing, pt]);
      return;
    }

    // ─ Select tool ─
    if (tool === "select") {
      if (zonesLocked) {
        // Still allow selection even when locked (no vertex drag though)
        for (let i = polygons.length - 1; i >= 0; i--) {
          if (isPointInPolygon(raw, polygons[i].points)) { setSelectedId(polygons[i].id); return; }
        }
        setSelectedId(null);
        return;
      }
      // Vertex drag on selected polygon — save snapshot at drag START
      if (selectedId) {
        const poly = polygons.find(p => p.id === selectedId);
        if (poly) {
          for (let i = 0; i < poly.points.length; i++) {
            if (dist(poly.points[i], raw) < VERTEX_R * 1.5 / xform.scale) {
              saveSnapshot(getSnapshot());
              setDragState({ polyId: poly.id, vtxIdx: i });
              return;
            }
          }
        }
      }

      // Click to select
      for (let i = polygons.length - 1; i >= 0; i--) {
        if (isPointInPolygon(raw, polygons[i].points)) {
          setSelectedId(polygons[i].id);
          return;
        }
      }
      setSelectedId(null);
      return;
    }

    // ─ Delete tool ─
    if (tool === "delete") {
      if (zonesLocked) { return; }
      for (let i = polygons.length - 1; i >= 0; i--) {
        if (isPointInPolygon(raw, polygons[i].points)) {
          saveSnapshot(getSnapshot());
          setPolygons(ps => ps.filter(p => p.id !== polygons[i].id));
          if (selectedId === polygons[i].id) setSelectedId(null);
          return;
        }
      }
      return;
    }

    // ─ Light tool ─
    if (tool === "light") {
      const pt = getPoint(e);
      setLights(prev => [...prev, { x: pt.x, y: pt.y, radius: 120, intensity: 0.7 }]);
      return;
    }

    // ─ Calibrate tool ─
    if (tool === "calibrate") {
      if (calibPhase === "idle" || calibPhase === "picking-start") {
        setCalibStart(raw);
        setCalibEnd(null);
        setCalibPhase("picking-end");
        return;
      }
      if (calibPhase === "picking-end") {
        const end = shiftHeld && calibStart ? snapAngle(calibStart, raw) : raw;
        setCalibEnd(end);
        setCalibPhase("entering-value");
        setShowCalibModal(true);
        return;
      }
    }
  }, [getPoint, tool, drawing, shiftHeld, polygons, selectedId, activeMat, xform, snapPoint, calibPhase, calibStart, zonesLocked, saveSnapshot, getSnapshot, softSnap, designItems, hitTestAsset, assetMode, selectedAssetId, bgImg]);

  const handleMouseUp = useCallback(() => {
    setPanOrigin(null);
    setDragState(null);
    setAssetDragOrigin(null);
  }, []);

  const handleDblClick = useCallback((e: React.MouseEvent) => {
    if (tool !== "draw" || !drawing || drawing.length < 3) return;
    if (zonesLocked) return;
    saveSnapshot(getSnapshot());
    const id = nanoid(8);
    const mat = getMaterial(activeMat);
    setPolygons(ps => [...ps, {
      id, points: drawing.slice(0, -1), materialId: activeMat, closed: true, label: mat.name,
    }]);
    setDrawing(null);
    setSelectedId(id);
  }, [tool, drawing, activeMat, zonesLocked, saveSnapshot, getSnapshot]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (tool === "select" && selectedId && !zonesLocked) {
      const raw = getPoint(e);
      const poly = polygons.find(p => p.id === selectedId);
      if (!poly) return;
      for (let i = 0; i < poly.points.length; i++) {
        if (dist(poly.points[i], raw) < VERTEX_R * 2 / xform.scale) {
          saveSnapshot(getSnapshot());
          if (poly.points.length <= 3) {
            setPolygons(ps => ps.filter(p => p.id !== selectedId));
            setSelectedId(null);
          } else {
            setPolygons(ps => ps.map(p => {
              if (p.id !== selectedId) return p;
              const pts = p.points.filter((_, idx) => idx !== i);
              return { ...p, points: pts };
            }));
          }
          return;
        }
      }
    }
  }, [tool, selectedId, getPoint, polygons, xform, zonesLocked, saveSnapshot, getSnapshot]);

  // ── Canvas touch handlers (draw + select on mobile/tablet) ─────────────────
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!canvasRef.current || e.touches.length !== 1) return;
    const t = e.touches[0];
    const synth = {
      button: 0, altKey: false, shiftKey: false,
      clientX: t.clientX, clientY: t.clientY,
      preventDefault: () => {},
    } as unknown as React.MouseEvent<HTMLCanvasElement>;
    handleMouseDown(synth);
  }, [handleMouseDown]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!canvasRef.current || e.touches.length !== 1) return;
    const t = e.touches[0];
    const synth = {
      button: 0, clientX: t.clientX, clientY: t.clientY,
      shiftKey: false, preventDefault: () => {},
    } as unknown as React.MouseEvent<HTMLCanvasElement>;
    handleMouseMove(synth);
  }, [handleMouseMove]);

  const handleTouchEnd = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    handleMouseUp();
  }, [handleMouseUp]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;

    // ── Rueda sobre asset seleccionado en modo escalar = escalar asset ────────
    if (selectedAssetId && assetMode === "scale") {
      const item = designItems.find(i => i.id === selectedAssetId);
      if (item) {
        const newScale = Math.max(0.1, Math.min(10, (item.scale ?? 1) * factor));
        updateDesignItem(selectedAssetId, { scale: newScale });
        return;
      }
    }

    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (canvas.width / r.width);
    const my = (e.clientY - r.top) * (canvas.height / r.height);
    setXform(prev => {
      const ns = clampScale(prev.scale * factor);
      const ratio = ns / prev.scale;
      return { scale: ns, tx: mx - (mx - prev.tx) * ratio, ty: my - (my - prev.ty) * ratio };
    });
  }, [selectedAssetId, assetMode, designItems, updateDesignItem]);

  // ── Calibration confirm ────────────────────────────────────────────────────
  const confirmCalibration = useCallback(() => {
    const meters = parseFloat(calibInput.replace(",", "."));
    if (!calibStart || !calibEnd || isNaN(meters) || meters <= 0) return;
    const pixelLen = dist(calibStart, calibEnd);
    const newPpm = pixelLen / meters;
    setPpm(newPpm);
    setCalibPhase("idle");
    setCalibStart(null);
    setCalibEnd(null);
    setCalibInput("");
    setShowCalibModal(false);
    setTool("draw");
    toast({ title: "Escala calibrada", description: `1 metro = ${newPpm.toFixed(1)} px` });
  }, [calibStart, calibEnd, calibInput, toast]);

  // ── Computed cost data ─────────────────────────────────────────────────────
  const zoneData = useMemo(() => {
    // POOLS excluidos de cotización (spec PASO 4)
    return polygons.filter(p => p.closed && p.poolType !== "pool").map(p => {
      const mat = getMaterial(p.materialId);
      // Respeta el override manual del usuario; si no hay override, usa el tipo del material
      const modeOverride = measureModeOverrides[p.id];
      const isLen = modeOverride !== undefined
        ? modeOverride === "length"
        : isLengthMaterial(mat);
      const isAutoMode = modeOverride === undefined;
      const areaPx    = shoelaceArea(p.points);
      const areaM2    = ppm ? areaPx / (ppm * ppm) : null;
      const perimeterM = ppm ? polygonPerimeterM(p.points, ppm) : null;
      const priceOverride = priceOverrides[p.materialId];
      const unitPrice = priceOverride !== undefined
        ? priceOverride
        : isLen ? (mat.defaultPriceM ?? 0) : mat.defaultPriceM2;
      const measuredQty = isLen ? perimeterM : areaM2;
      const cost = measuredQty !== null ? measuredQty * unitPrice : null;
      return { poly: p, mat, isLen, isAutoMode, areaPx, areaM2, perimeterM, unitPrice, cost };
    });
  }, [polygons, ppm, priceOverrides, measureModeOverrides]);

  const totalCost = useMemo(() =>
    zoneData.reduce((s, z) => s + (z.cost ?? 0), 0),
  [zoneData]);

  const totalM2 = useMemo(() =>
    zoneData.reduce((s, z) => s + (z.areaM2 ?? 0), 0),
  [zoneData]);

  // ── Per-polygon material estimates ─────────────────────────────────────────
  const polyEstimates = useMemo<PolyMaterialEstimate[]>(() => {
    if (!ppm) return [];
    return zoneData
      .filter(z => z.areaM2 !== null)
      .map(z => estimatePolygon(
        z.poly.id,
        z.areaM2!,
        z.mat,
        densityOverrides[z.poly.id] ?? 1.0,
        z.perimeterM ?? 0,
        priceOverrides[z.mat.id],
      ));
  }, [zoneData, ppm, densityOverrides, priceOverrides]);

  const materialSummary = useMemo<MaterialSummaryRow[]>(() =>
    buildMaterialSummary(polyEstimates, getMaterial),
  [polyEstimates]);

  const totalEstimatedCost = useMemo(() =>
    polyEstimates.reduce((s, e) => s + e.total, 0),
  [polyEstimates]);

  // ── IVA + cotización en tiempo real ──────────────────────────────────────
  const ivaAmount = useMemo(() =>
    applyIVA ? totalCost * 0.16 : 0,
  [totalCost, applyIVA]);

  const totalConIVA = useMemo(() =>
    totalCost + ivaAmount,
  [totalCost, ivaAmount]);

  // Helper to push one polygon's estimate to the quote
  const addPolyToQuote = useCallback((estimate: PolyMaterialEstimate) => {
    saveSnapshot(getSnapshot());
    const mat = getMaterial(estimate.materialId);
    const measureLabel = estimate.unitType === "length"
      ? `${estimate.perimeterM.toFixed(1)} ml (perímetro)`
      : `${estimate.areaM2.toFixed(1)} m²`;
    addDesignItem({
      inventoryItemId: 0,
      name: `${mat.emoji} ${estimate.materialName} — ${measureLabel}`,
      imageData: null,
      price: estimate.total,
      quantity: Math.ceil(estimate.qtyAdjusted * 10) / 10,
      unitPrice: estimate.unitPrice,
      source: "cad-estimate",
      x: 0.5, y: 0.5, scale: 1, rotation: 0,
    });
    toast({
      title: "Añadido a cotización ✓",
      description: `${estimate.materialName} — ${estimate.qtyAdjusted.toFixed(2)} ${estimate.unit} — $${estimate.total.toLocaleString("es-MX")}`,
    });
  }, [addDesignItem, getMaterial, toast, saveSnapshot, getSnapshot]);

  // ── Agregar partida manual a cotización ──────────────────────────────────
  const addManualEntry = useCallback(() => {
    const concept = manualConcept.trim();
    const qty     = parseFloat(manualQty.replace(",", "."));
    const price   = parseFloat(manualPrice.replace(",", "."));
    if (!concept || isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0) {
      toast({ title: "Datos incompletos", description: "Completa concepto, cantidad y precio antes de agregar.", variant: "destructive" });
      return;
    }
    const total = qty * price;
    const entryId = nanoid();
    const unitLabel = manualUnit === "m2" ? "m²" : "ml";
    const entry = { id: entryId, concept, qty, unit: manualUnit, price, total };
    setManualEntries(prev => [...prev, entry]);
    addMaterialCost({
      materialId: `manual-${entryId}`,
      materialName: concept,
      areaM2: manualUnit === "m2" ? qty : 0,
      perimeterM: manualUnit === "ml" ? qty : undefined,
      unitType: manualUnit === "m2" ? "area" : "length",
      pricePerM2: price,
      total,
    });
    toast({
      title: "Partida agregada ✓",
      description: `${concept} — ${qty.toFixed(2)} ${unitLabel} × $${price.toLocaleString("es-MX")} = $${total.toLocaleString("es-MX")}`,
    });
    setManualConcept("");
    setManualQty("");
    setManualPrice("");
  }, [manualConcept, manualQty, manualUnit, manualPrice, addMaterialCost, toast]);

  // ── Zoom controls ──────────────────────────────────────────────────────────
  const zoomBy = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    setXform(prev => {
      const ns = clampScale(prev.scale * factor);
      const ratio = ns / prev.scale;
      return { scale: ns, tx: cx - (cx - prev.tx) * ratio, ty: cy - (cy - prev.ty) * ratio };
    });
  };

  const resetView = () => {
    const canvas = canvasRef.current;
    if (!canvas || !bgImg) return;
    const s = clampScale(Math.min(canvas.width / bgImg.naturalWidth, canvas.height / bgImg.naturalHeight) * 0.92);
    setXform({ scale: s, tx: (canvas.width - bgImg.naturalWidth * s) / 2, ty: (canvas.height - bgImg.naturalHeight * s) / 2 });
  };

  // Ref a applyPatternDirect (definido más abajo) — usado como fallback cuando la IA
  // de WaveSpeed se atasca/timeout. Evita ciclo de dependencias en useCallback.
  const applyPatternDirectRef = useRef<((polyId: string, materialId: string) => Promise<void>) | null>(null);

  // ── Apply material with AI (WaveSpeed inpainting) ─────────────────────────
  const applyMaterialWithAI = useCallback(async (polyId: string, materialId: string) => {
    // FASE 5: limpiar dibujo/medición ANTES de aplicar material — evita "fantasma verde"
    resetMeasurementSystem();

    if (!bgImg || !gardenImage) {
      toast({ title: "Sin imagen de terreno", description: "Sube una foto del terreno primero.", variant: "destructive" });
      return;
    }
    const poly = polygons.find(p => p.id === polyId);
    if (!poly || poly.points.length < 3) return;

    // ── Offline fallback: use flat colour fill instead of WaveSpeed ────────
    if (!isOnline) {
      try {
        const W = bgImg.naturalWidth, H = bgImg.naturalHeight;
        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d")!;
        const img = new Image();
        await new Promise<void>((res, rej) => {
          img.onload = () => { ctx.drawImage(img, 0, 0); res(); };
          img.onerror = () => rej(new Error("img error"));
          img.src = gardenImage;
        });
        const mat = getMaterial(materialId);
        const COLOR_MAP: Record<string, string> = {
          // originals
          grass: "#5a8a3c", "white-stone": "#e8e4d8", "grey-stone": "#9e9e9e",
          "red-stone": "#8b3624", "black-stone": "#2a2a2a",
          marble: "#f0f0f0", gravel: "#a0a0a0", "multi-stone": "#9b72cf",
          soil: "#6b4226", mulch: "#8b6240", concrete: "#9e9e9e",
          "borde-concreto": "#9aafbe", "borde-madera": "#7a5028", "muro-piedra": "#4a5568",
          // piso — piedra yucatán
          "piedra-crema": "#d8c09a", "piedra-gris-natural": "#909090",
          "gravilla-clara": "#c8c8c8", "gravilla-oscura": "#606060",
          // piso — madera
          "madera-clara": "#c8a97e", "madera-oscura": "#6b4f2a", "deck-exterior": "#8b6b3f",
          // chukum
          "chukum-beige": "#d8c3a5", "chukum-arena": "#cdb79e",
          "chukum-gris-claro": "#bfbfbf", "chukum-gris-oscuro": "#8c8c8c",
          "chukum-rosado": "#d9a5a5", "chukum-natural": "#c4b49a",
          // lambrín
          "lambrin-claro": "#d6b48a", "lambrin-oscuro": "#5a3e2b",
          "lambrin-gris": "#999999", "lambrin-blanco": "#f5f5f5",
          // techo
          "techo-blanco": "#f8fafc",
        };
        const color = COLOR_MAP[materialId] ?? "#7aaa4e";
        ctx.save();
        ctx.beginPath();
        const pts = poly.points;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = color + "b0";
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
        const resultUrl = canvas.toDataURL("image/jpeg", 0.92);
        pushGardenImageToHistory(resultUrl);
        // aiApplied: true → color ya integrado en gardenImage, no dibujar patrón procedural encima
        setPolygons(ps => ps.map(p => p.id === polyId ? { ...p, materialId, aiApplied: true } : p));
        toast({ title: `${mat.name} aplicado (modo offline)`, description: "Relleno simplificado — la IA de texturas requiere conexión.", duration: 3000 });
      } catch (err) {
        toast({ title: "Error", description: String(err), variant: "destructive" });
      }
      return;
    }

    setIsApplying(true);
    setApplyingId(polyId);
    const mat = getMaterial(materialId);

    try {
      setApplyMsg(`Preparando zona para ${mat.name}...`);

      // ① Load current gardenImage into canvas at native resolution
      const W = bgImg.naturalWidth, H = bgImg.naturalHeight;
      const srcCanvas = document.createElement("canvas");
      srcCanvas.width = W; srcCanvas.height = H;
      const srcCtx = srcCanvas.getContext("2d")!;
      await new Promise<void>((res, rej) => {
        const img = new Image();
        img.onload = () => { srcCtx.drawImage(img, 0, 0); res(); };
        img.onerror = () => rej(new Error("No se pudo cargar la imagen"));
        img.src = gardenImage;
      });

      // ② Build binary polygon mask at native resolution
      const maskFull = buildPolygonMask(poly.points, W, H);

      // ③ Compute bbox around polygon + padding
      const bbox = computePolygonBBox(poly.points, W, H, 32);

      // ④ Crop image + mask to bbox
      const croppedImg  = aiCropCanvas(srcCanvas, bbox);
      const croppedMask = aiCropCanvas(maskFull, bbox);

      // ⑤ Resize to AI max dimension
      const imgResized  = aiResizeCanvas(croppedImg, AI_MAX);
      const maskResized = document.createElement("canvas");
      maskResized.width = imgResized.width; maskResized.height = imgResized.height;
      maskResized.getContext("2d")!.drawImage(croppedMask, 0, 0, maskResized.width, maskResized.height);
      const dilated = aiDilateMask(maskResized, 2);

      const imgBase64  = imgResized.toDataURL("image/jpeg", 0.92);
      const maskBase64 = dilated.toDataURL("image/png");

      setApplyMsg(`Aplicando ${mat.name} con IA... (~30-60s)`);

      // ⑥ Call WaveSpeed API
      const data = await wavespeedPost("/api/ai/wavespeed/apply-material", { imageBase64: imgBase64, maskBase64, material: materialId });

      setApplyMsg("Composición final...");

      // ⑦ Load AI result
      const aiCanvas = document.createElement("canvas");
      await new Promise<void>((res, rej) => {
        const img = new Image();
        img.onload = () => {
          aiCanvas.width = img.naturalWidth; aiCanvas.height = img.naturalHeight;
          aiCanvas.getContext("2d")!.drawImage(img, 0, 0);
          res();
        };
        img.onerror = () => rej(new Error("No se pudo cargar el resultado de IA"));
        img.src = data.imageBase64;
      });

      // ⑧ Composite: clip AI result to polygon path, draw over original
      const composited = aiCompositeClip(srcCanvas, aiCanvas, bbox, poly.points);

      // ⑨ Update gardenImage + mark polygon with material + aiApplied flag
      const resultDataUrl = composited.toDataURL("image/jpeg", 0.92);
      pushGardenImageToHistory(resultDataUrl);
      setPolygons(ps => ps.map(p => p.id === polyId ? { ...p, materialId, aiApplied: true } : p));

      // 🧠 Adaptive learning: record material choice (fire-and-forget)
      trackMaterialApplied(materialId);

      // Update bgImg so future operations use the updated image
      const newImg = new Image();
      await new Promise<void>((res) => {
        newImg.onload = () => res();
        newImg.src = resultDataUrl;
      });
      setBgImg(newImg);

      toast({
        title: `${mat.emoji} ${mat.name} aplicado`,
        description: "Textura fotorrealista generada. Ya está visible en el módulo de diseño.",
      });

    } catch (err) {
      console.error("[CAD/AI]", err);
      // Fallback automático: si la IA falla/timeout, intenta aplicar el patrón
      // local pixel-perfect en vez de dejar al usuario sin nada.
      const fallback = applyPatternDirectRef.current;
      if (fallback) {
        toast({
          title: "⚠️ IA tardó demasiado — aplicando patrón local",
          description: "WaveSpeed está lento. Usamos el patrón fotorrealista local como respaldo. Puedes reintentar la IA después.",
          duration: 5000,
        });
        try { await fallback(polyId, materialId); }
        catch (e2) {
          toast({ title: "Error al aplicar textura", description: (e2 as Error).message, variant: "destructive" });
        }
      } else {
        toast({ title: "Error al aplicar textura", description: (err as Error).message, variant: "destructive" });
      }
    } finally {
      setIsApplying(false);
      setApplyingId(null);
      setApplyMsg("");
    }
  }, [bgImg, gardenImage, polygons, getMaterial, pushGardenImageToHistory, setGardenImage, toast, resetMeasurementSystem, isOnline]);

  // ── OPERACIÓN UNIFICADA: aplicar el MISMO material a TODAS las áreas ──────
  // Garantiza resultado pixel-idéntico entre regiones:
  //  • UN SOLO crop de imagen + UNA SOLA máscara que une todos los polígonos
  //  • UNA SOLA inferencia de IA → mismo seed, mismo prompt, mismo guidance
  //  • Composite con clip multi-polígono → bordes duros, sin variación per-zona
  //  • Cero relighting / recálculo independiente por área
  const applyMaterialToAllPolygons = useCallback(async (materialId: string) => {
    resetMeasurementSystem();
    if (!bgImg || !gardenImage) {
      toast({ title: "Sin imagen de terreno", description: "Sube una foto del terreno primero.", variant: "destructive" });
      return;
    }

    // Selecciona TODAS las áreas que ya tienen este material asignado.
    // El usuario asigna material con cualquier botón (color plano, patrón o IA);
    // luego este botón re-aplica todas con UNA SOLA pasada de IA idéntica.
    const targets = polygons.filter(p => p.materialId === materialId && p.points.length >= 3);
    if (targets.length === 0) {
      toast({ title: "Sin áreas con este material", description: "Asigna el material a varias zonas primero (un click cada una).", variant: "destructive" });
      return;
    }
    if (targets.length === 1) {
      // Si solo hay una, delega al flujo single-polígono normal
      await applyMaterialWithAI(targets[0].id, materialId);
      return;
    }

    const mat = getMaterial(materialId);

    // Offline fallback: relleno de color plano UNIFORME en todas las áreas
    if (!isOnline) {
      try {
        const W = bgImg.naturalWidth, H = bgImg.naturalHeight;
        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d")!;
        const img = new Image();
        await new Promise<void>((res, rej) => {
          img.onload = () => { ctx.drawImage(img, 0, 0); res(); };
          img.onerror = () => rej(new Error("img error"));
          img.src = gardenImage;
        });
        const COLOR_MAP: Record<string, string> = {
          grass: "#5a8a3c", "white-stone": "#e8e4d8", "grey-stone": "#9e9e9e",
          "red-stone": "#8b3624", "black-stone": "#2a2a2a", marble: "#f0f0f0",
          gravel: "#a0a0a0", "multi-stone": "#9b72cf", soil: "#6b4226",
          mulch: "#8b6240", concrete: "#9e9e9e",
        };
        const color = (COLOR_MAP[materialId] ?? "#7aaa4e") + "b0";
        ctx.save();
        ctx.beginPath();
        for (const t of targets) {
          ctx.moveTo(t.points[0].x, t.points[0].y);
          for (let i = 1; i < t.points.length; i++) ctx.lineTo(t.points[i].x, t.points[i].y);
          ctx.closePath();
        }
        ctx.clip("nonzero");
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
        const url = canvas.toDataURL("image/jpeg", 0.92);
        pushGardenImageToHistory(url);
        const ids = new Set(targets.map(t => t.id));
        setPolygons(ps => ps.map(p => ids.has(p.id) ? { ...p, materialId, aiApplied: true } : p));
        toast({ title: `${mat.name} aplicado a ${targets.length} áreas (offline)`, duration: 3000 });
      } catch (err) {
        toast({ title: "Error", description: String(err), variant: "destructive" });
      }
      return;
    }

    setIsApplying(true);
    setApplyingId(targets[0].id);
    try {
      setApplyMsg(`Bloqueando material ${mat.name} para ${targets.length} áreas (operación unificada)...`);

      // ① Cargar imagen actual
      const W = bgImg.naturalWidth, H = bgImg.naturalHeight;
      const srcCanvas = document.createElement("canvas");
      srcCanvas.width = W; srcCanvas.height = H;
      const srcCtx = srcCanvas.getContext("2d")!;
      await new Promise<void>((res, rej) => {
        const img = new Image();
        img.onload = () => { srcCtx.drawImage(img, 0, 0); res(); };
        img.onerror = () => rej(new Error("No se pudo cargar la imagen"));
        img.src = gardenImage;
      });

      // ② Máscara COMBINADA (todos los polígonos en una sola imagen)
      const allPts = targets.map(t => t.points);
      const maskFull = buildMultiPolygonMask(allPts, W, H);

      // ③ BBox UNIÓN — un solo crop cubre todas las áreas
      const bbox = computeMultiPolygonBBox(allPts, W, H, 32);

      // ④ Crop + resize del par imagen/máscara
      const croppedImg  = aiCropCanvas(srcCanvas, bbox);
      const croppedMask = aiCropCanvas(maskFull, bbox);
      const imgResized  = aiResizeCanvas(croppedImg, AI_MAX);
      const maskResized = document.createElement("canvas");
      maskResized.width = imgResized.width; maskResized.height = imgResized.height;
      maskResized.getContext("2d")!.drawImage(croppedMask, 0, 0, maskResized.width, maskResized.height);
      const dilated = aiDilateMask(maskResized, 2);

      const imgBase64  = imgResized.toDataURL("image/jpeg", 0.92);
      const maskBase64 = dilated.toDataURL("image/png");

      setApplyMsg(`Aplicando ${mat.name} a ${targets.length} áreas en UNA sola pasada... (~30-60s)`);

      // ⑤ UNA SOLA llamada a IA — el server usa fixedSeed por material → resultado determinista
      const data = await wavespeedPost("/api/ai/wavespeed/apply-material", { imageBase64: imgBase64, maskBase64, material: materialId });

      setApplyMsg("Composición final unificada...");

      // ⑥ Cargar resultado IA
      const aiCanvas = document.createElement("canvas");
      await new Promise<void>((res, rej) => {
        const img = new Image();
        img.onload = () => {
          aiCanvas.width = img.naturalWidth; aiCanvas.height = img.naturalHeight;
          aiCanvas.getContext("2d")!.drawImage(img, 0, 0);
          res();
        };
        img.onerror = () => rej(new Error("No se pudo cargar el resultado de IA"));
        img.src = data.imageBase64;
      });

      // ⑦ Composite multi-polígono — mismo tile aplicado a TODAS las áreas con bordes duros
      const composited = aiCompositeClipMulti(srcCanvas, aiCanvas, bbox, allPts);
      const resultDataUrl = composited.toDataURL("image/jpeg", 0.92);
      pushGardenImageToHistory(resultDataUrl);

      const ids = new Set(targets.map(t => t.id));
      setPolygons(ps => ps.map(p => ids.has(p.id) ? { ...p, materialId, aiApplied: true } : p));

      trackMaterialApplied(materialId);

      const newImg = new Image();
      await new Promise<void>((res) => {
        newImg.onload = () => res();
        newImg.src = resultDataUrl;
      });
      setBgImg(newImg);

      toast({
        title: `${mat.emoji} ${mat.name} aplicado a ${targets.length} áreas`,
        description: "Material idéntico en todas las zonas. Cero variación.",
      });
    } catch (err) {
      console.error("[CAD/AI batch]", err);
      toast({ title: "Error en operación unificada", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsApplying(false);
      setApplyingId(null);
      setApplyMsg("");
    }
  }, [bgImg, gardenImage, polygons, getMaterial, pushGardenImageToHistory, toast, resetMeasurementSystem, isOnline, applyMaterialWithAI, setBgImg, setPolygons]);

  // ── Limpiar terreno: inpainting con máscara de polígono ─────────────────────
  const handleLimpiarTerreno = useCallback(async (polyId: string) => {
    if (!bgImg || !gardenImage) {
      toast({ title: "Sin imagen de terreno", description: "Sube una foto del terreno primero.", variant: "destructive" });
      return;
    }
    const poly = polygons.find(p => p.id === polyId);
    if (!poly || poly.points.length < 3) {
      toast({ title: "Sin zona válida", description: "El polígono necesita al menos 3 puntos.", variant: "destructive" });
      return;
    }

    const W = bgImg.naturalWidth, H = bgImg.naturalHeight;

    // ── Offline fallback: flat neutral-earth fill ─────────────────────────────
    if (!isOnline) {
      try {
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d")!;
        const img = new Image();
        await new Promise<void>((res, rej) => {
          img.onload = () => { ctx.drawImage(img, 0, 0); res(); };
          img.onerror = () => rej(new Error("img error"));
          img.src = gardenImage;
        });
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(poly.points[0].x, poly.points[0].y);
        for (let i = 1; i < poly.points.length; i++) ctx.lineTo(poly.points[i].x, poly.points[i].y);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = "#a08060b0"; // neutral earth tone
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
        const resultUrl = c.toDataURL("image/jpeg", 0.92);
        pushGardenImageToHistory(resultUrl);
        const ni = new Image();
        await new Promise<void>(r => { ni.onload = () => r(); ni.src = resultUrl; });
        setBgImg(ni);
        toast({ title: "Zona limpiada (modo offline)", description: "Relleno simplificado. Reconecta para resultado IA completo.", duration: 3000 });
      } catch (err) {
        toast({ title: "Error en modo offline", description: String(err), variant: "destructive" });
      }
      return;
    }

    setIsApplying(true);
    setApplyingId(polyId);

    try {
      setApplyMsg("Preparando zona para limpiar…");

      // ① Cargar imagen al tamaño nativo
      const srcCanvas = document.createElement("canvas");
      srcCanvas.width = W; srcCanvas.height = H;
      const srcCtx = srcCanvas.getContext("2d")!;
      await new Promise<void>((res, rej) => {
        const img = new Image();
        img.onload = () => { srcCtx.drawImage(img, 0, 0); res(); };
        img.onerror = () => rej(new Error("No se pudo cargar la imagen base"));
        img.src = gardenImage;
      });

      // ② Crear máscara binaria del polígono (blanco = zona a limpiar)
      const maskFull = buildPolygonMask(poly.points, W, H);

      // ③ Recortar bbox con padding
      const bbox = computePolygonBBox(poly.points, W, H, 32);

      // ④ Crop imagen + máscara al bbox
      const croppedImg  = aiCropCanvas(srcCanvas, bbox);
      const croppedMask = aiCropCanvas(maskFull, bbox);

      // ── DETECCIÓN DE TIPO DE SUELO — analiza píxeles dentro del polígono ─────
      // Lee los colores promedio solo en los píxeles blancos de la máscara recortada
      // para identificar qué tipo de suelo tiene el cliente en esa zona.
      setApplyMsg("Detectando tipo de suelo…");
      const detectedSurfacePrompt = (() => {
        const mCtx = croppedMask.getContext("2d")!;
        const iCtx = croppedImg.getContext("2d")!;
        const mData = mCtx.getImageData(0, 0, croppedMask.width, croppedMask.height).data;
        const iData = iCtx.getImageData(0, 0, croppedImg.width, croppedImg.height).data;

        let rSum = 0, gSum = 0, bSum = 0, count = 0;
        // Varianza para detectar texturas mixtas
        const rVals: number[] = [], gVals: number[] = [], bVals: number[] = [];

        for (let i = 0; i < mData.length; i += 4) {
          if (mData[i] > 128) {  // píxel dentro del polígono (máscara blanca)
            const r = iData[i], g = iData[i + 1], b = iData[i + 2];
            rSum += r; gSum += g; bSum += b; count++;
            if (count % 8 === 0) { rVals.push(r); gVals.push(g); bVals.push(b); }
          }
        }
        if (count === 0) return null; // sin datos → sin detección

        const rAvg = rSum / count, gAvg = gSum / count, bAvg = bSum / count;
        const brightness = (rAvg + gAvg + bAvg) / 3;

        // Varianza de canal verde para distinguir textura orgánica vs plana
        const gVariance = gVals.length > 0
          ? gVals.reduce((acc, v) => acc + (v - gAvg) ** 2, 0) / gVals.length
          : 0;

        // ── Clasificación: solo preservar SUPERFICIES DURAS — todo lo blando → tierra ─
        // Pasto, plantas y suelos orgánicos siempre se convierten a tierra neutra
        // para que el diseñador pueda aplicar cualquier material encima (piscina, etc.)

        // Concreto / mármol / piso claro: preservar (ya es inversión del cliente)
        if (brightness > 175 && gVariance < 120 && !(gAvg > rAvg * 1.15)) {
          return {
            label: "concreto/mármol",
            prompt: "Preserve and restore the existing light-colored hardscape surface (concrete, marble, or tile pavement) in this area. Remove all objects while keeping exactly the same smooth floor material, color, and texture as the surroundings. No grass, no dirt.",
          };
        }
        // Tezontle / grava roja volcánica: preservar
        if (rAvg > 130 && bAvg < 90 && brightness < 160 && rAvg > gAvg * 1.15) {
          return {
            label: "tezontle/grava roja",
            prompt: "Preserve and restore the existing red volcanic stone (tezontle) or reddish gravel ground cover in this area. Remove all objects while keeping exactly the same terracotta-red porous stone texture and color as the surroundings. No grass.",
          };
        }
        // Grava / piedritas grises o beige: preservar
        if (brightness > 115 && brightness < 175 && gVariance > 250 && !(gAvg > rAvg * 1.15)) {
          return {
            label: "grava/piedritas",
            prompt: "Preserve and restore the existing gravel or small stone ground cover in this area. Remove all objects while maintaining exactly the same gravel texture, pebble size, and color tones as the surrounding area. No grass, no soil.",
          };
        }
        // Todo lo demás (pasto, plantas, tierra, desconocido) → tierra neutra
        // El diseñador aplicará el material final que el cliente quiera
        return {
          label: "tierra (base de diseño)",
          prompt: "Remove all objects and vegetation from this area and replace with clean flat neutral bare earth soil, ready for landscaping. Natural dark brown earth texture, smooth flat ground surface, seamless with surrounding terrain perspective and lighting. No grass, no plants, no gravel — just clean empty soil as a blank canvas for new design.",
        };
      })();

      const cleanPrompt = detectedSurfacePrompt?.prompt ??
        "Remove all objects from this area while preserving the original ground surface type and texture, seamlessly matching the surrounding terrain. No material substitution.";

      if (detectedSurfacePrompt) {
        setApplyMsg(`Suelo detectado: ${detectedSurfacePrompt.label} — limpiando con IA…`);
      } else {
        setApplyMsg("Limpiando zona con IA…");
      }

      // ⑤ Escalar al max de la IA y dilatar máscara
      const imgResized  = aiResizeCanvas(croppedImg, AI_MAX);
      const maskResized = document.createElement("canvas");
      maskResized.width = imgResized.width; maskResized.height = imgResized.height;
      maskResized.getContext("2d")!.drawImage(croppedMask, 0, 0, maskResized.width, maskResized.height);
      const dilated = aiDilateMask(maskResized, 2);

      const imgBase64  = imgResized.toDataURL("image/jpeg", 0.92);
      const maskBase64 = dilated.toDataURL("image/png");

      // ⑥ Llamar al endpoint /inpaint con prompt adaptado al tipo de suelo detectado
      const data = await wavespeedPost("/api/ai/wavespeed/inpaint", {
        imageBase64: imgBase64,
        maskBase64,
        prompt: cleanPrompt,
        negativePrompt:
          "furniture, chairs, tables, toys, cars, motorcycles, trash cans, umbrellas, flower pots, " +
          "garden ornaments, construction debris, hoses, obstacles, clutter, " +
          "changing ground material, different surface type, grass if not originally grass, " +
          "cartoon, illustration, blur, watermark",
      });

      setApplyMsg("Composición final…");

      // ⑦ Cargar resultado IA
      const aiCanvas = document.createElement("canvas");
      await new Promise<void>((res, rej) => {
        const img = new Image();
        img.onload = () => {
          aiCanvas.width = img.naturalWidth; aiCanvas.height = img.naturalHeight;
          aiCanvas.getContext("2d")!.drawImage(img, 0, 0);
          res();
        };
        img.onerror = () => rej(new Error("No se pudo cargar el resultado de IA"));
        img.src = data!.imageBase64;
      });

      // ⑧ Post-proceso verde→tierra SOLO en el resultado de IA (zona limpiada)
      // CRÍTICO: se aplica aquí (en aiCanvas) antes de componer —
      // si se aplica después destruiría el pasto que el usuario ya puso en otras zonas.
      replaceGrassWithSoil(aiCanvas.getContext("2d")!, aiCanvas.width, aiCanvas.height);

      // ⑨ Componer: clip estricto al polígono, base sólida de tierra para bordes limpios
      const composited = aiCompositeClip(
        srcCanvas, aiCanvas, bbox, poly.points,
        "#8a6030"  // base tierra sólida → garantiza bordes pixel-perfect sin gaps
      );
      const resultDataUrl = composited.toDataURL("image/jpeg", 0.92);

      // ⑨ Guardar en historial y actualizar
      pushGardenImageToHistory(resultDataUrl);
      setPolygons(ps => ps.map(p => p.id === polyId ? { ...p, aiApplied: false } : p));

      const newImg = new Image();
      await new Promise<void>(r => { newImg.onload = () => r(); newImg.src = resultDataUrl; });
      setBgImg(newImg);

      toast({ title: "Zona limpia ✓", description: "Superficie de tierra neutra generada. Lista para diseñar encima." });

    } catch (err) {
      console.error("[CAD/LimpiarTerreno]", err);
      toast({ title: "Error al limpiar zona", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsApplying(false);
      setApplyingId(null);
      setApplyMsg("");
    }
  }, [bgImg, gardenImage, polygons, isOnline, pushGardenImageToHistory, setGardenImage, toast]);

  // ── Sugerir diseño — handlers ─────────────────────────────────────────────

  const handleDiscardSuggestions = useCallback(() => {
    setSuggestions([]);
    setSuggestionPlants([]);
    setSuggestionBOM(null);
    setSuggestionSummary("");
  }, []);

  const handleApplySuggestions = useCallback(() => {
    if (suggestions.length === 0) return;
    // Convert each suggestion zone into a real polygon
    const newPolys: LocalPolygon[] = suggestions.map(sz => ({
      id: nanoid(),
      points: sz.points,
      materialId: sz.materialId,
      closed: true,
      label: sz.label,
      aiApplied: false,
    }));
    setPolygons(prev => [...prev, ...newPolys]);
    // Add suggestion plants as design items (using their image positions as %)
    if (bgImg) {
      const W = bgImg.naturalWidth, H = bgImg.naturalHeight;
      for (const sp of suggestionPlants) {
        addDesignItem({
          inventoryItemId: sp.inventoryItemId,
          name: sp.name,
          imageData: null,
          price: 0,
          quantity: sp.quantity,
          unitPrice: 0,
          source: "suggestion",
          x: sp.x / W,
          y: sp.y / H,
          scale: 1,
          rotation: 0,
        });
      }
    }
    // Apply BOM if present
    if (suggestionBOM && suggestionBOM.length > 0) {
      setDesignBOM(suggestionBOM);
      setBomAddedToQuote(false);
    }
    toast({
      title: `Sugerencia aplicada — ${suggestions.length} zona(s)`,
      description: "Las zonas se convirtieron en polígonos editables. Puedes ajustarlos libremente.",
    });
    // Clear suggestions
    setSuggestions([]);
    setSuggestionPlants([]);
    setSuggestionBOM(null);
    setSuggestionSummary("");
  }, [suggestions, suggestionPlants, suggestionBOM, bgImg, addDesignItem, toast]);

  const handleSuggestDesign = useCallback(async () => {
    if (!bgImg || !gardenImage) {
      toast({ title: "Sin imagen de terreno", description: "Sube una foto del terreno primero.", variant: "destructive" });
      return;
    }

    const W = bgImg.naturalWidth, H = bgImg.naturalHeight;

    // ── Offline: generate rule-based suggestion ─────────────────────────────
    if (!isOnline) {
      const fallbackZones: SuggestionZone[] = [
        {
          id: "sz1",
          label: "Zona pasto central",
          materialId: "grass",
          description: "Área principal para pasto natural",
          points: [
            { x: W * 0.15, y: H * 0.2 },
            { x: W * 0.75, y: H * 0.2 },
            { x: W * 0.75, y: H * 0.65 },
            { x: W * 0.15, y: H * 0.65 },
          ],
        },
        {
          id: "sz2",
          label: "Zona piedra borde",
          materialId: "grey-stone",
          description: "Borde de piedra gris decorativo",
          points: [
            { x: W * 0.05, y: H * 0.1 },
            { x: W * 0.15, y: H * 0.1 },
            { x: W * 0.15, y: H * 0.9 },
            { x: W * 0.05, y: H * 0.9 },
          ],
        },
      ];
      setSuggestions(fallbackZones);
      setSuggestionPlants([]);
      setSuggestionBOM(null);
      setSuggestionSummary("Sugerencia básica generada en modo offline. Reconecta para análisis de IA completo.");
      toast({ title: "Sugerencia offline generada", description: "Zonas básicas propuestas. Ajusta y acepta según tu criterio.", duration: 4000 });
      return;
    }

    setIsSuggesting(true);
    setSuggestions([]);
    setSuggestionPlants([]);
    setSuggestionBOM(null);
    setSuggestionSummary("");

    try {
      setSuggestMsg("Analizando terreno con IA…");

      // Resize image for API
      const tmpCanvas = document.createElement("canvas");
      const MAX = 1024;
      const ratio = Math.min(MAX / W, MAX / H, 1);
      tmpCanvas.width = Math.round(W * ratio);
      tmpCanvas.height = Math.round(H * ratio);
      const tmpCtx = tmpCanvas.getContext("2d")!;
      const srcImg = new Image();
      await new Promise<void>((res, rej) => {
        srcImg.onload = () => { tmpCtx.drawImage(srcImg, 0, 0, tmpCanvas.width, tmpCanvas.height); res(); };
        srcImg.onerror = rej;
        srcImg.src = gardenImage;
      });
      const imgBase64 = tmpCanvas.toDataURL("image/jpeg", 0.88);

      setSuggestMsg("Generando propuesta de diseño…");

      // Fetch inventory
      let inventory: any[] = [];
      try {
        const _tok2 = localStorage.getItem("urbanai_token");
        const invRes = await fetch("/api/inventory", { credentials: "include", headers: _tok2 ? { Authorization: "Bearer " + _tok2 } : {} });
        if (invRes.ok) { const d = await invRes.json(); inventory = d.items ?? d ?? []; }
      } catch { /* non-fatal */ }

      const res = await fetch("/api/ai/suggest-design", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        credentials: "include",
        body: JSON.stringify({
          imageBase64: imgBase64,
          W: tmpCanvas.width,
          H: tmpCanvas.height,
          polygons: polygons.map(p => ({
            id: p.id,
            materialId: p.materialId,
            label: p.label,
            // normalize points to the resized image
            points: p.points.map(pt => ({ x: pt.x * ratio, y: pt.y * ratio })),
          })),
          pixelsPerMeter: ppm ? ppm * ratio : null,
          inventory: inventory.slice(0, 50),
          style: suggestStyle,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error del servidor");

      // Convert normalized coords back to ORIGINAL image pixel coords
      const scale = 1 / ratio;
      const szones: SuggestionZone[] = (data.zones ?? []).map((z: any) => ({
        id: z.id,
        label: z.label,
        materialId: z.materialId,
        description: z.description || "",
        points: z.points.map((p: { nx: number; ny: number }) => ({
          x: p.nx * W,
          y: p.ny * H,
        })),
      }));

      const splants: SuggestionPlant[] = (data.plants ?? []).map((p: any) => ({
        inventoryItemId: p.inventoryItemId,
        name: p.name,
        quantity: p.quantity,
        x: p.nx * W,
        y: p.ny * H,
      }));

      setSuggestions(szones);
      setSuggestionPlants(splants);
      setSuggestionBOM(data.bom ?? null);
      setSuggestionSummary(data.summary ?? "");

      toast({
        title: `${szones.length} zona(s) sugerida(s)`,
        description: data.summary || "Revisa la propuesta y acepta o descarta.",
      });
    } catch (err) {
      console.error("[CAD/SuggestDesign]", err);
      toast({ title: "Error al sugerir diseño", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsSuggesting(false);
      setSuggestMsg("");
    }
  }, [bgImg, gardenImage, polygons, ppm, suggestStyle, isOnline, toast]);

  // ── Generate automatic landscape design with WaveSpeed + Spatial Engine ─────
  const generateAutoDesign = useCallback(async (polyId: string, style: string) => {
    if (!bgImg || !gardenImage) {
      toast({ title: "Sin imagen de terreno", description: "Sube una foto del terreno primero.", variant: "destructive" });
      return;
    }
    const poly = polygons.find(p => p.id === polyId);
    if (!poly || poly.points.length < 3) {
      toast({ title: "Sin zona seleccionada", description: "Selecciona o dibuja un polígono primero.", variant: "destructive" });
      return;
    }

    // ── Offline: use rule-based engine instead of WaveSpeed + GPT-4o ─────
    if (!isOnline) {
      const { generateOfflineDesignPlan } = await import("@/services/offline-design-engine");
      const { getCachedInventory } = await import("@/services/offline-storage");
      const cached = await getCachedInventory();
      if (!cached || cached.length === 0) {
        toast({
          title: "Sin inventario local",
          description: "No hay inventario cacheado. Conéctate a internet al menos una vez para cachear el inventario.",
          variant: "destructive",
        });
        return;
      }
      const areaPx = shoelaceArea(poly.points);
      const areaM2 = ppm ? areaPx / (ppm * ppm) : Math.max(10, areaPx / 900);
      const plan = generateOfflineDesignPlan(areaM2, cached);
      const offlineBOM = plan.suggestions.map(s => ({
        itemId: s.inventoryItemId,
        nombre: s.name,
        categoria: "plant",
        cantidad: s.quantity,
        precio_unitario: s.unitPrice,
        subtotal: s.totalPrice,
      }));
      setDesignBOM(offlineBOM);
      for (const item of offlineBOM) {
        addDesignItem({
          inventoryItemId: item.itemId,
          name: item.nombre,
          imageData: null,
          price: item.subtotal,
          quantity: item.cantidad,
          unitPrice: item.precio_unitario,
          source: "bom",
          x: 0.5, y: 0.5, scale: 1, rotation: 0,
        });
      }
      setBomAddedToQuote(true);
      toast({
        title: `📋 Plan offline generado (${style})`,
        description: `${offlineBOM.length} elementos según reglas hortícolas. ${plan.notes[0]}`,
      });
      return;
    }

    setIsDesigning(true);
    setDesignBOM(null);
    setBomAddedToQuote(false);
    const styleLabels: Record<string, string> = { moderno: "Moderno", tropical: "Tropical", minimalista: "Minimalista", rustico: "Rústico" };

    try {
      // ── PASO 1: Analizando área ────────────────────────────────────────────
      setDesignMsg("Analizando área...");

      const W = bgImg.naturalWidth, H = bgImg.naturalHeight;
      const srcCanvas = document.createElement("canvas");
      srcCanvas.width = W; srcCanvas.height = H;
      const srcCtx = srcCanvas.getContext("2d")!;
      await new Promise<void>((res, rej) => {
        const img = new Image();
        img.onload = () => { srcCtx.drawImage(img, 0, 0); res(); };
        img.onerror = () => rej(new Error("No se pudo cargar la imagen"));
        img.src = gardenImage;
      });

      const maskFull = buildPolygonMask(poly.points, W, H);
      const bbox     = computePolygonBBox(poly.points, W, H, 32);
      const croppedImg  = aiCropCanvas(srcCanvas, bbox);
      const croppedMask = aiCropCanvas(maskFull, bbox);
      const imgResized  = aiResizeCanvas(croppedImg, AI_MAX);
      const maskResized = document.createElement("canvas");
      maskResized.width = imgResized.width; maskResized.height = imgResized.height;
      maskResized.getContext("2d")!.drawImage(croppedMask, 0, 0, maskResized.width, maskResized.height);
      const dilated = aiDilateMask(maskResized, 3);

      const imgBase64  = imgResized.toDataURL("image/jpeg", 0.93);
      const maskBase64 = dilated.toDataURL("image/png");

      // ── PASO 2: Fetch inventory → generate BOM via design-plan ───────────
      setDesignMsg("Planificando diseño con IA (analizando inventario)...");

      const matKw = ["piedra","grava","mármol","marmol","concreto","tezontle","arena","mulch","tierra","madera"];

      // ① Fetch inventory + user profile in parallel (profile non-fatal)
      let fullInventory: any[] = [];
      let userProfile: UserProfile | null = null;
      try {
        const _tok3 = localStorage.getItem("urbanai_token");
        const [invRes, profileRes] = await Promise.all([
          fetch("/api/inventory", { credentials: "include", headers: _tok3 ? { Authorization: "Bearer " + _tok3 } : {} }),
          fetchUserProfile(),
        ]);
        if (invRes.ok) fullInventory = await invRes.json();
        userProfile = profileRes;
      } catch (_) { /* non-fatal */ }

      if (fullInventory.length === 0) {
        throw new Error("El inventario está vacío. Agrega plantas y materiales al inventario antes de generar un diseño automático.");
      }

      // ② Compute area in m² for design-plan
      const areaPxForPlan = shoelaceArea(poly.points);
      const areaM2ForPlan = ppm ? areaPxForPlan / (ppm * ppm) : 20;

      // ③ Call design-plan to get structured BOM (inject learning profile if available)
      const planRes = await fetch("/api/ai/design-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        credentials: "include",
        body: JSON.stringify({
          inventory: fullInventory,
          areaM2: areaM2ForPlan,
          userProfile: userProfile ?? undefined,
        }),
      });
      const planData = await planRes.json();

      if (!planRes.ok) {
        throw new Error(planData.error || "No se pudo generar el plan de diseño.");
      }

      const bom: BOMItem[] = planData.bom ?? [];
      if (bom.length === 0) {
        throw new Error("La IA no generó un plan válido. Revisa que el inventario tenga plantas o materiales usables.");
      }

      // ④ Store BOM for display panel
      setDesignBOM(bom);

      // ⑤ Build inventoryPlants for WaveSpeed prompt context
      const inventoryPlants = fullInventory.map((it: any) => ({
        name: it.name as string,
        category: it.category as string,
        itemType: it.itemType ?? null,
        quantity: Number(it.quantity) || 0,
      }));

      const plantCount = inventoryPlants.filter((p: any) => {
        const s = `${p.name} ${p.category}`.toLowerCase();
        return !matKw.some(kw => s.includes(kw));
      }).length;

      // ── PASO 3: Calculando distribución — spatial engine ─────────────────
      setDesignMsg("Calculando distribución...");

      // Build spatial plant inputs from BOM plant items (BOM quantity overrides inventory)
      const bomPlantIds = new Set(bom.map(b => b.itemId));
      const spatialPlants: SpatialPlantInput[] = fullInventory
        .filter((it: any) => {
          const s = `${it.name} ${it.category}`.toLowerCase();
          return it.category === "plant" && !matKw.some(kw => s.includes(kw));
        })
        .map((it: any) => {
          // Use BOM-specified quantity if available, otherwise inventory quantity
          const bomEntry = bom.find(b => b.itemId === Number(it.id));
          return {
            inventoryItemId: Number(it.id),
            name: String(it.name),
            itemType: it.itemType ?? null,
            quantity: bomEntry ? bomEntry.cantidad : Math.max(0, Math.round(Number(it.quantity) || 0)),
            spacing: it.spacing != null ? Number(it.spacing) : null,
            price: Number(it.price) || 0,
            imageData: it.imageData ?? null,
          };
        });

      // ── PASO 4: Validando posiciones — place spatial design items ─────────
      setDesignMsg("Validando posiciones...");

      let capNotices: string[] = [];
      if (spatialPlants.length > 0) {
        const engineResult = runSpatialEngine(poly.points, ppm, spatialPlants);
        capNotices = buildCapNotices(engineResult.fitResults);

        if (engineResult.placements.length > 0) {
          const withPixels = placementsToPixels(engineResult.placements, poly.points);
          const imgW = bgImg.naturalWidth;
          const imgH = bgImg.naturalHeight;

          for (const placement of withPixels) {
            addDesignItem({
              inventoryItemId: placement.inventoryItemId,
              name: placement.name,
              imageData: placement.imageData,
              price: placement.price,
              x: imgW > 0 ? placement.px / imgW : 0.5,
              y: imgH > 0 ? placement.py / imgH : 0.5,
              scale: placement.densityType === "palm" ? 1.2
                   : placement.densityType === "ground_cover" ? 0.6
                   : 0.9,
              rotation: 0,
            });
          }
        }
      }

      // ── PASO 5: Renderizando — WaveSpeed AI image generation ─────────────
      setDesignMsg(
        plantCount > 0
          ? `Renderizando diseño ${styleLabels[style] ?? style} con tus plantas... (~30-60s)`
          : `Renderizando diseño ${styleLabels[style] ?? style} con IA... (~30-60s)`
      );

      const data = await wavespeedPost("/api/ai/wavespeed/design-auto", { imageBase64: imgBase64, maskBase64, style, inventoryPlants, bom } as Record<string, unknown>);

      setDesignMsg("Renderizando...");

      const aiCanvas = document.createElement("canvas");
      await new Promise<void>((res, rej) => {
        const img = new Image();
        img.onload = () => {
          aiCanvas.width = img.naturalWidth; aiCanvas.height = img.naturalHeight;
          aiCanvas.getContext("2d")!.drawImage(img, 0, 0);
          res();
        };
        img.onerror = () => rej(new Error("No se pudo cargar el resultado"));
        img.src = data.imageBase64;
      });

      const composited = aiCompositeClip(srcCanvas, aiCanvas, bbox, poly.points);
      const resultDataUrl = composited.toDataURL("image/jpeg", 0.93);

      pushGardenImageToHistory(resultDataUrl);
      setPolygons(ps => ps.map(p => p.id === polyId ? { ...p, aiApplied: true } : p));

      const newImg = new Image();
      await new Promise<void>((res) => { newImg.onload = () => res(); newImg.src = resultDataUrl; });
      setBgImg(newImg);

      // ⑥ Auto-add BOM items to quote after successful generation
      for (const item of bom) {
        addDesignItem({
          inventoryItemId: item.itemId,
          name: item.nombre,
          imageData: null,
          price: item.subtotal,
          quantity: item.cantidad,
          unitPrice: item.precio_unitario,
          source: "bom",
          x: 0.5,
          y: 0.5,
          scale: 1,
          rotation: 0,
        });
      }
      setBomAddedToQuote(true);

      toast({
        title: `✨ Diseño ${styleLabels[style] ?? style} generado`,
        description: spatialPlants.length > 0
          ? `${bom.length} elemento${bom.length !== 1 ? "s" : ""} del plan distribuidos espacialmente y agregados a la cotización.`
          : `${bom.length} elemento${bom.length !== 1 ? "s" : ""} del plan agregados a la cotización automáticamente.`,
      });

      // 🧠 Adaptive learning: record this design session (fire-and-forget)
      trackDesignGenerated(style, areaM2ForPlan);
      trackBOMAccepted(
        bom.map(b => ({ itemId: b.itemId, nombre: b.nombre, tipo: b.categoria, cantidad: b.cantidad })),
        areaM2ForPlan
      );

      // Show cap notices as separate toasts (non-blocking)
      for (const notice of capNotices) {
        toast({ title: "Ajuste de capacidad", description: notice });
      }

    } catch (err) {
      console.error("[CAD/design-auto]", err);
      toast({ title: "Error al generar diseño", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsDesigning(false);
      setDesignMsg("");
    }
  }, [bgImg, gardenImage, polygons, ppm, pushGardenImageToHistory, setGardenImage, addDesignItem, toast]);

  // ── Add BOM items to the quote/presupuesto (manual button) ──────────────────
  const addBOMToQuote = useCallback((bom: BOMItem[]) => {
    saveSnapshot(getSnapshot());
    for (const item of bom) {
      addDesignItem({
        inventoryItemId: item.itemId,
        name: item.nombre,
        imageData: null,
        price: item.subtotal,
        quantity: item.cantidad,
        unitPrice: item.precio_unitario,
        source: "bom",
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotation: 0,
      });
    }
    setBomAddedToQuote(true);
    toast({
      title: "Agregado a cotización ✓",
      description: `${bom.length} elemento${bom.length !== 1 ? "s" : ""} del plan de diseño añadidos al presupuesto.`,
    });
  }, [addDesignItem, toast, saveSnapshot, getSnapshot]);

  // ── Apply flat color (instant, no AI) ─────────────────────────────────────
  const applyFlatColor = useCallback((polyId: string, materialId: string) => {
    // FASE 5: limpiar dibujo/medición antes de aplicar material
    resetMeasurementSystem();
    // Bloqueo: si la zona ya tiene un material LOCKED, no se puede reemplazar
    const targetPoly = polygons.find(p => p.id === polyId);
    if (targetPoly) {
      const currentMat = getMaterial(targetPoly.materialId);
      if (currentMat.locked) {
        toast({
          title: `🔒 ${currentMat.name} — Material bloqueado`,
          description: "Este material premium no puede ser reemplazado. Elimina la zona y dibuja una nueva para cambiar el material.",
          variant: "destructive",
        });
        return;
      }
    }
    saveSnapshot(getSnapshot());
    setPolygons(ps => ps.map(p => {
      if (p.id !== polyId) return p;
      const updated = { ...p, materialId };
      return updated;
    }));
    const mat = getMaterial(materialId);
    toast({ title: `${mat.emoji} ${mat.name} (color)`, description: "Vista previa aplicada. Usa 'Textura IA' para resultado fotorrealista." });
  }, [polygons, toast, saveSnapshot, getSnapshot, resetMeasurementSystem]);

  // ── Aplicar patrón directo a gardenImage (pixel-perfect, sin IA) ────────────
  // Bake del patrón SVG directamente sobre la imagen con clip exacto al polígono.
  // Respeta coordenadas exactas sin escalar — igual al código de referencia del usuario.
  const applyPatternDirect = useCallback(async (polyId: string, materialId: string) => {
    if (!bgImg || !gardenImage) {
      toast({ title: "Sin imagen", description: "Sube una foto del terreno primero.", variant: "destructive" });
      return;
    }
    const poly = polygons.find(p => p.id === polyId);
    if (!poly || poly.points.length < 3) return;

    const mat = getMaterial(materialId);
    const W = bgImg.naturalWidth, H = bgImg.naturalHeight;

    try {
      // ① Cargar gardenImage al canvas a tamaño nativo
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d")!;

      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => { ctx.drawImage(img, 0, 0); res(); };
        img.onerror = () => rej(new Error("No se pudo cargar la imagen base"));
        img.src = gardenImage;
      });

      // ② Obtener patrón escalado al 100% de la imagen nativa
      const pattern = getScaledPattern(ctx, mat.id);

      // ③ Clip exacto al polígono — coordenadas directas sin transformación
      ctx.save();
      // FASE 3+4: alpha=1 y source-over garantizados antes del clip+fill
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.shadowColor = "transparent";
      ctx.shadowBlur  = 0;
      ctx.beginPath();
      ctx.moveTo(poly.points[0].x, poly.points[0].y);
      for (let i = 1; i < poly.points.length; i++) {
        ctx.lineTo(poly.points[i].x, poly.points[i].y);
      }
      ctx.closePath();
      ctx.clip();

      // ④ Rellenar solo la zona del polígono con el patrón — sin transparencia
      ctx.globalAlpha = 1;
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      // ⑤ Guardar en historial y actualizar gardenImage + bgImg
      // aiApplied: true → patrón ya integrado en gardenImage, render NO dibuja procedural encima
      const resultUrl = canvas.toDataURL("image/jpeg", 0.93);
      pushGardenImageToHistory(resultUrl);
      setPolygons(ps => ps.map(p => p.id === polyId ? { ...p, materialId, aiApplied: true } : p));

      const newBg = new Image();
      await new Promise<void>(r => { newBg.onload = () => r(); newBg.src = resultUrl; });
      setBgImg(newBg);

      toast({
        title: `✅ ${mat.emoji} ${mat.name} — bordes exactos`,
        description: "Patrón aplicado pixel-perfect al polígono. Mide igual que lo que marcaste.",
        duration: 4000,
      });
    } catch (err) {
      toast({ title: "Error al aplicar patrón", description: (err as Error).message, variant: "destructive" });
    }
  }, [bgImg, gardenImage, polygons, pushGardenImageToHistory, setGardenImage, toast]);

  // Conecta el ref usado por el fallback de applyMaterialWithAI.
  useEffect(() => { applyPatternDirectRef.current = applyPatternDirect; }, [applyPatternDirect]);

  // ── Professional flatten render export ────────────────────────────────────
  const exportImage = useCallback(async () => {
    if (!bgImg && !gardenImage) {
      toast({ title: "Sin imagen", description: "Sube una foto del terreno primero.", variant: "destructive" });
      return;
    }
    setIsExporting(true);
    setExportType("image");
    try {
      const W = bgImg?.naturalWidth ?? 1200;
      const H = bgImg?.naturalHeight ?? 900;
      const dataUrl = await renderFlatExport({
        gardenImage,
        bgImgNaturalWidth: W,
        bgImgNaturalHeight: H,
        polygons,
        designItems,
        getMaterial,
        drawMaterialFill,
        clientName: clientInfo?.name,
        totalProjectCost,
        pixelRatio: 2,
        includeDesignItems: true,
        includeInfoOverlay: false,
      });
      const link = document.createElement("a");
      const slug = (clientInfo?.name ?? "proyecto").replace(/\s+/g, "-").toLowerCase();
      link.download = `paisajismo-${slug}-${new Date().toISOString().slice(0, 10)}.png`;
      link.href = dataUrl;
      link.click();
      toast({ title: "✅ Imagen exportada", description: `${W * 2}×${H * 2} px — calidad profesional` });
    } catch (err) {
      toast({ title: "Error al exportar", description: String(err), variant: "destructive" });
    } finally {
      setIsExporting(false);
      setExportType(null);
    }
  }, [bgImg, gardenImage, polygons, designItems, clientInfo, totalProjectCost, toast]);

  // ── Export project data as JSON ─────────────────────────────────────────────
  const exportProjectData = useCallback(() => {
    if (polygons.length === 0 && designItems.length === 0) {
      toast({ title: "Sin datos", description: "Dibuja zonas o agrega elementos primero.", variant: "destructive" });
      return;
    }
    const estimateMap = new Map(polyEstimates.map(e => [e.polyId, e]));
    const enrichedPolygons = polygons.map(p => {
      const e = estimateMap.get(p.id);
      return { ...p, areaM2: e?.areaM2 ?? null, estimatedQty: e?.qtyAdjusted ?? null, estimatedUnit: e?.unit, estimatedCost: e?.total ?? null };
    });
    const json = buildProjectJSON({
      clientName: clientInfo?.name ?? "Sin nombre",
      clientPhone: clientInfo?.phone,
      clientAddress: clientInfo?.address,
      gardenImage,
      polygons: enrichedPolygons,
      designItems,
      materialCosts,
      totalProjectCost,
    });
    // Enrich with real-time quotation data (IVA, per-zone breakdown)
    const jsonObj = JSON.parse(json);
    jsonObj.cotizacion = {
      zonas: zoneData.filter(z => z.cost !== null).map(z => ({
        material: z.mat.name,
        emoji: z.mat.emoji,
        tipo: z.isLen ? "metro_lineal" : "m2",
        cantidad: z.isLen ? (z.perimeterM ?? 0) : (z.areaM2 ?? 0),
        unidad: z.isLen ? "ml" : "m²",
        precioPorUnidad: z.unitPrice,
        subtotal: z.cost ?? 0,
      })),
      subtotal: totalCost,
      ivaAplicado: applyIVA,
      ivaPorcentaje: 16,
      ivaImporte: ivaAmount,
      total: totalConIVA,
      escala_px_por_metro: ppm ?? null,
    };
    const enrichedJson = JSON.stringify(jsonObj, null, 2);
    const blob = new Blob([enrichedJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const slug = (clientInfo?.name ?? "proyecto").replace(/\s+/g, "-").toLowerCase();
    link.download = `datos-paisajismo-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
    const totalDisplay = applyIVA ? totalConIVA : totalProjectCost;
    toast({ title: "📋 Datos exportados", description: `Zonas: ${polygons.filter(p=>p.closed).length} | Elementos: ${designItems.length} | Total${applyIVA ? " c/IVA" : ""}: $${totalDisplay.toLocaleString("es-MX")}` });
  }, [polygons, designItems, clientInfo, gardenImage, materialCosts, totalProjectCost, toast, polyEstimates, zoneData, applyIVA, ivaAmount, totalConIVA, totalCost, ppm]);

  // ── Export complete (imagen + datos + resumen) ──────────────────────────────
  const exportComplete = useCallback(async () => {
    if (!bgImg && !gardenImage && polygons.length === 0 && designItems.length === 0) {
      toast({ title: "Sin contenido", description: "Agrega zonas o elementos antes de exportar.", variant: "destructive" });
      return;
    }
    setIsExporting(true);
    setExportType("complete");
    try {
      const W = bgImg?.naturalWidth ?? 1200;
      const H = bgImg?.naturalHeight ?? 900;
      const slug = (clientInfo?.name ?? "proyecto").replace(/\s+/g, "-").toLowerCase();
      const date = new Date().toISOString().slice(0, 10);

      // Render high-quality image with info overlay
      const dataUrl = await renderFlatExport({
        gardenImage,
        bgImgNaturalWidth: W,
        bgImgNaturalHeight: H,
        polygons,
        designItems,
        getMaterial,
        drawMaterialFill,
        clientName: clientInfo?.name,
        totalProjectCost,
        pixelRatio: 2,
        includeDesignItems: true,
        includeInfoOverlay: true,
      });

      // Download image
      const imgLink = document.createElement("a");
      imgLink.download = `render-${slug}-${date}.png`;
      imgLink.href = dataUrl;
      imgLink.click();

      // Short pause before JSON download
      await new Promise(r => setTimeout(r, 400));

      // Download JSON (with area + material estimates)
      const estimateMap2 = new Map(polyEstimates.map(e => [e.polyId, e]));
      const enrichedPolys2 = polygons.map(p => {
        const e = estimateMap2.get(p.id);
        return { ...p, areaM2: e?.areaM2 ?? null, estimatedQty: e?.qtyAdjusted ?? null, estimatedUnit: e?.unit, estimatedCost: e?.total ?? null };
      });
      const json = buildProjectJSON({
        clientName: clientInfo?.name ?? "Sin nombre",
        clientPhone: clientInfo?.phone,
        clientAddress: clientInfo?.address,
        gardenImage,
        polygons: enrichedPolys2,
        designItems,
        materialCosts,
        totalProjectCost,
      });
      const jsonObj2 = JSON.parse(json);
      jsonObj2.cotizacion = {
        zonas: zoneData.filter(z => z.cost !== null).map(z => ({
          material: z.mat.name,
          emoji: z.mat.emoji,
          tipo: z.isLen ? "metro_lineal" : "m2",
          cantidad: z.isLen ? (z.perimeterM ?? 0) : (z.areaM2 ?? 0),
          unidad: z.isLen ? "ml" : "m²",
          precioPorUnidad: z.unitPrice,
          subtotal: z.cost ?? 0,
        })),
        subtotal: totalCost,
        ivaAplicado: applyIVA,
        ivaPorcentaje: 16,
        ivaImporte: ivaAmount,
        total: totalConIVA,
        escala_px_por_metro: ppm ?? null,
      };
      const enrichedJson2 = JSON.stringify(jsonObj2, null, 2);
      const blob = new Blob([enrichedJson2], { type: "application/json" });
      const jsonUrl = URL.createObjectURL(blob);
      const jsonLink = document.createElement("a");
      jsonLink.download = `datos-${slug}-${date}.json`;
      jsonLink.href = jsonUrl;
      jsonLink.click();
      URL.revokeObjectURL(jsonUrl);

      toast({
        title: "📦 Exportación completa",
        description: `Render PNG (${W*2}×${H*2}px) + datos JSON con cotización${applyIVA ? " c/IVA" : ""} — listos para cliente.`,
        duration: 5000,
      });
    } catch (err) {
      toast({ title: "Error al exportar", description: String(err), variant: "destructive" });
    } finally {
      setIsExporting(false);
      setExportType(null);
    }
  }, [bgImg, gardenImage, polygons, designItems, clientInfo, materialCosts, totalProjectCost, toast, zoneData, applyIVA, ivaAmount, totalConIVA, totalCost, ppm]);

  // ── Clean Terrain (AI + offline fallback) ─────────────────────────────────
  const handleCleanTerrain = useCallback(async () => {
    if (!gardenImage) {
      toast({ title: "Sin imagen", description: "Sube una foto del terreno primero.", variant: "destructive" });
      return;
    }
    setIsCleaningTerrain(true);

    // ── Offline fallback: green canvas overlay ──────────────────────────────
    if (!isOnline) {
      try {
        const img = new Image();
        img.src = gardenImage;
        await new Promise<void>(r => { img.onload = () => r(); });
        const offCanvas = document.createElement("canvas");
        offCanvas.width = img.naturalWidth;
        offCanvas.height = img.naturalHeight;
        const ctx = offCanvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        // Semi-transparent earth/soil gradient — neutral design base (no grass)
        const grad = ctx.createLinearGradient(0, 0, 0, offCanvas.height);
        grad.addColorStop(0,   "rgba(120, 85, 50, 0.60)");
        grad.addColorStop(0.5, "rgba(100, 68, 35, 0.68)");
        grad.addColorStop(1,   "rgba(80, 52, 22, 0.76)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, offCanvas.width, offCanvas.height);
        pushGardenImageToHistory(offCanvas.toDataURL("image/jpeg", 0.92));
        toast({
          title: "🟤 Terreno simplificado",
          description: "Modo sin conexión: capa base de tierra aplicada. Para IA fotorrealista conéctate a internet.",
        });
      } catch (err) {
        toast({ title: "Error", description: String(err), variant: "destructive" });
      } finally {
        setIsCleaningTerrain(false);
      }
      return;
    }

    // ── Online: WaveSpeed AI clean-terrain ──────────────────────────────────
    try {
      toast({ title: "🔍 Analizando terreno…", description: "La IA está generando la superficie limpia. Puede tomar 30–60 s." });
      const { imageBase64: rawBase64 } = await wavespeedPost("/api/ai/wavespeed/clean-terrain", { imageBase64: gardenImage });
      // Post-proceso pixel-level: pasto → gravilla blanca (100% determinístico)
      setApplyMsg("Eliminando pasto… convirtiendo a gravilla fina…");
      const imageBase64 = await deGrassBase64(rawBase64);
      pushGardenImageToHistory(imageBase64);
      setCleanedTerrainUrl(imageBase64);
      toast({
        title: "✅ Terreno limpio listo",
        description: "Base de gravilla fina generada. Objetos y vegetación eliminados. ¡Ahora diseña encima! Usa el panel de descarga para guardar o re-subir la imagen.",
        duration: 8000,
      });
    } catch (err) {
      toast({ title: "Error al limpiar terreno", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsCleaningTerrain(false);
      setApplyMsg("");
    }
  }, [gardenImage, isOnline, pushGardenImageToHistory, setGardenImage, toast]);

  // ── Agregar pasto automático ───────────────────────────────────────────────
  // Algoritmo:
  //   1. Análisis pixel-level en el cliente: detecta TIERRA (tonos marrón/ocre)
  //      y la separa de carreteras, bardas, concreto, sombras, cielo y vegetación.
  //   2. Construye una máscara binaria (blanco = pintar pasto, negro = preservar).
  //   3. Erosión morfológica para evitar derrames en los bordes de los caminos.
  //   4. Envía imagen + máscara a flux-fill-dev → SOLO modifica dentro de la máscara.
  //      Carreteras, bardas y estructuras quedan literalmente intocables.
  const detectDirtMask = useCallback((img: HTMLImageElement): { imageBase64: string; maskBase64: string; coverage: number } => {
    // Reducir a AI_MAX en la dimensión más larga (igual que flujo manual)
    // para evitar payloads gigantes que rompen el endpoint.
    const srcW = img.naturalWidth, srcH = img.naturalHeight;
    const scale = Math.min(1, AI_MAX / Math.max(srcW, srcH));
    const W = Math.round(srcW * scale);
    const H = Math.round(srcH * scale);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, W, H);
    const imageBase64 = c.toDataURL("image/jpeg", 0.92);
    const src = ctx.getImageData(0, 0, W, H);
    const data = src.data;

    // Paso 1 — clasificar cada píxel como dirt (1) o no-dirt (0)
    // Restricciones GEOMÉTRICAS + COLOR para excluir edificios y cielo:
    //   - SOLO mitad inferior de la imagen (suelo, no edificios ni cielo)
    //   - Tonos de tierra: marrón húmedo, beige seco, ocre, arenoso
    // EXCLUSIONES ESTRICTAS:
    //   - Mitad superior (cielo + edificios) → preservada al 100%
    //   - Carretera/concreto/asfalto: gris desaturado R≈G≈B
    //   - Paredes pintadas claras (cream/beige claro): lum alta + sat baja
    //   - Vegetación verde, cielo azul, blancos puros, negros puros
    // Horizonte al 35% — incluye más del área de suelo aunque el edificio ocupe alto.
    // El edificio queda excluido por color (cream desaturado, sat baja) no por geometría.
    const HORIZON_Y = Math.floor(H * 0.35);
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (y < HORIZON_Y) { mask[p] = 0; continue; }
        const i = p * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
        const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
        const lum = (r * 0.299 + g * 0.587 + b * 0.114);
        // Solo excluir paredes MUY claras Y desaturadas (cream paint pura).
        // La tierra seca brillante tiene sat 0.10-0.30, no se debe excluir.
        const isPaintedWall = lum > 210 && sat < 0.10;
        // Exclusión carretera/asfalto/concreto: muy desaturado
        const isGreyRoad = sat < 0.06;
        // Criterio TIERRA — relajado para tierra seca beige clara
        const isDirt =
          r >= g && g >= b &&
          r - b >= 6 &&
          sat >= 0.06 &&
          sat <= 0.70 &&
          lum >= 40 && lum <= 225 &&
          r >= 65 &&
          !isPaintedWall &&
          !isGreyRoad;
        mask[p] = isDirt ? 1 : 0;
      }
    }

    // Paso 2 — cierre morfológico (dilate 1 + erode 1) para rellenar huecos
    // pequeños dentro de zonas de tierra, después erosión leve solo en bordes
    // duros con NO-tierra para evitar derrames en carreteras.
    const dilated = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const idx = y * W + x;
        if (
          mask[idx] || mask[idx - 1] || mask[idx + 1] ||
          mask[idx - W] || mask[idx + W]
        ) dilated[idx] = 1;
      }
    }
    const eroded = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const idx = y * W + x;
        if (
          dilated[idx] && dilated[idx - 1] && dilated[idx + 1] &&
          dilated[idx - W] && dilated[idx + W]
        ) eroded[idx] = 1;
      }
    }

    // Paso 3a — PRE-PINTAR la imagen original: rellenar las zonas de tierra
    // con verde sólido oscuro (#3d6b1f) antes de enviar al modelo.
    // Esto sesga fuertemente a flux-fill hacia "refinar verde → pasto realista"
    // en vez de "inventar pasto sobre tierra" (que termina promediando
    // colores con el contexto beige/café).
    let count = 0;
    const tintCanvas = document.createElement("canvas");
    tintCanvas.width = W; tintCanvas.height = H;
    const tctx = tintCanvas.getContext("2d", { willReadFrequently: true })!;
    tctx.drawImage(img, 0, 0, W, H);
    const tintData = tctx.getImageData(0, 0, W, H);
    const td = tintData.data;
    const GR = 0x3d, GG = 0x6b, GB = 0x1f; // verde grama profundo
    for (let p = 0, i = 0; p < eroded.length; p++, i += 4) {
      if (eroded[p]) {
        count++;
        // Mezclar 80% verde + 20% original (preserva un poco de iluminación)
        td[i]     = Math.round(GR * 0.80 + td[i]     * 0.20);
        td[i + 1] = Math.round(GG * 0.80 + td[i + 1] * 0.20);
        td[i + 2] = Math.round(GB * 0.80 + td[i + 2] * 0.20);
      }
    }
    tctx.putImageData(tintData, 0, 0);
    const tintedImageBase64 = tintCanvas.toDataURL("image/jpeg", 0.92);

    // Paso 3b — escribir máscara binaria (blanco = pintar, negro = preservar)
    const out = ctx.createImageData(W, H);
    for (let p = 0, i = 0; p < eroded.length; p++, i += 4) {
      const v = eroded[p] ? 255 : 0;
      out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    const coverage = count / eroded.length;
    const maskBase64 = c.toDataURL("image/png");
    console.log(`[autoGrass] resized=${W}x${H} dirt coverage=${(coverage * 100).toFixed(2)}% tintedBytes=${tintedImageBase64.length} maskBytes=${maskBase64.length}`);
    return { imageBase64: tintedImageBase64, maskBase64, coverage };
  }, []);

  const handleAutoGrass = useCallback(async () => {
    const sourceImage = gardenImage;
    if (!sourceImage) {
      toast({ title: "Sin imagen de terreno", description: "Sube una foto del terreno primero.", variant: "destructive" });
      return;
    }
    setIsAutoGrass(true);
    try {
      toast({ title: "🌱 Aplicando pasto Zoysia…", description: "La IA convertirá las zonas de tierra a pasto verde respetando carreteras, bardas y estructuras. 30–60s." });

      // Reducir imagen a AI_MAX antes de enviar (payload manejable).
      // NO se envía máscara — el flujo original (flux-kontext-dev + autoGrassPrompt)
      // hace segmentación semántica y produce pasto verde realista respetando
      // hardscape. Probado y funcionando.
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("No se pudo cargar la imagen del terreno"));
        i.src = sourceImage;
      });
      // Auto-grass: usa resolución más alta que AI_MAX (768) para que el
      // resultado no salga pixelado. flux-kontext-dev devuelve la imagen al
      // mismo tamaño que el input, así que con 1536 obtenemos detalle real.
      const AUTO_GRASS_MAX = 1536;
      const srcW = img.naturalWidth, srcH = img.naturalHeight;
      const scale = Math.min(1, AUTO_GRASS_MAX / Math.max(srcW, srcH));
      const W = Math.round(srcW * scale);
      const H = Math.round(srcH * scale);
      const rc = document.createElement("canvas");
      rc.width = W; rc.height = H;
      rc.getContext("2d")!.drawImage(img, 0, 0, W, H);
      const resizedImg = rc.toDataURL("image/jpeg", 0.95);

      const { imageBase64: raw } = await wavespeedPost("/api/ai/wavespeed/apply-material", {
        imageBase64: resizedImg,
        material: "grass",
      });
      const resultUrl = raw.startsWith("data:") ? raw : `data:image/jpeg;base64,${raw}`;
      pushGardenImageToHistory(resultUrl);
      const newImg = new Image();
      newImg.onload = () => {
        setBgImg(newImg);
        // Centrar la imagen en el canvas inmediatamente con las dimensiones reales
        const canvas = canvasRef.current;
        if (canvas) {
          const s = Math.min(canvas.width / newImg.naturalWidth, canvas.height / newImg.naturalHeight) * 0.92;
          setXform({ scale: s, tx: (canvas.width - newImg.naturalWidth * s) / 2, ty: (canvas.height - newImg.naturalHeight * s) / 2 });
        }
      };
      newImg.src = resultUrl;
      toast({
        title: "✅ Pasto Zoysia aplicado",
        description: "Zoysia cubriendo toda el área libre. Bardas, piscina y estructuras conservadas.",
        duration: 7000,
      });
    } catch (err) {
      toast({ title: "Error al aplicar pasto", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsAutoGrass(false);
    }
  }, [gardenImage, pushGardenImageToHistory, canvasRef, toast]);

  // ── Descargar imagen limpiada ───────────────────────────────────────────────
  const downloadCleanedTerrain = useCallback(() => {
    if (!cleanedTerrainUrl) return;
    const a = document.createElement("a");
    a.href = cleanedTerrainUrl;
    a.download = `terreno-limpio-${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [cleanedTerrainUrl]);

  // ── Re-subir imagen como nueva base ────────────────────────────────────────
  const handleCadImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // FASE 3+5: limpiar toda medición/dibujo en curso antes de cargar nueva imagen
    resetMeasurementSystem();
    // Hornear rotación EXIF en píxeles (mismo fix que design-canvas):
    // FileReader preserva bytes crudos con EXIF → imagen aparece diferente en AI vs canvas
    // Redibujar en canvas normaliza la orientación para todos los módulos
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      const normalized = c.toDataURL("image/jpeg", 0.92);
      URL.revokeObjectURL(objectUrl);
      pushGardenImageToHistory();
      setGardenImage(normalized);
      setBgImg(img);
      setCleanedTerrainUrl(null);
      // Re-center the canvas on every new upload regardless of current zoom/pan
      const canvas = canvasRef.current;
      if (canvas) {
        const s = clampScale(Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight) * 0.92);
        setXform({ scale: s, tx: (canvas.width - img.naturalWidth * s) / 2, ty: (canvas.height - img.naturalHeight * s) / 2 });
      }
      toast({ title: "✅ Imagen cargada", description: "La imagen fue subida como nueva base del diseño." });
    };
    img.onerror = () => URL.revokeObjectURL(objectUrl);
    img.src = objectUrl;
    if (cadImageInputRef.current) cadImageInputRef.current.value = "";
  }, [pushGardenImageToHistory, setGardenImage, toast, resetMeasurementSystem]);

  // ── Save to project ────────────────────────────────────────────────────────
  // gardenImage already has AI textures baked in (via applyMaterialWithAI).
  // We only apply flat fills for zones that have NOT been AI-processed.
  const saveToProject = useCallback(async () => {
    if (polygons.length === 0) {
      toast({ title: "Sin zonas", description: "Dibuja al menos una zona antes de guardar.", variant: "destructive" });
      return;
    }

    // If ALL zones are AI-processed, gardenImage is already the final result.
    // Otherwise, composite flat fills for pending zones on top.
    const pendingZones = polygons.filter(p => p.closed && p.points.length >= 3 && !p.aiApplied);

    let finalUrl = gardenImage;

    if (pendingZones.length > 0 && bgImg) {
      const out = document.createElement("canvas");
      out.width = bgImg.naturalWidth;
      out.height = bgImg.naturalHeight;
      const ctx = out.getContext("2d")!;
      // Base: current gardenImage (has AI textures already)
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, 0, 0); resolve(); };
        img.src = gardenImage ?? "";
      });
      // Only apply flat fills for non-AI zones
      for (const p of pendingZones) {
        const mat = getMaterial(p.materialId);
        drawMaterialFill(ctx, p.points, mat);
        ctx.beginPath();
        ctx.moveTo(p.points[0].x, p.points[0].y);
        for (let i = 1; i < p.points.length; i++) ctx.lineTo(p.points[i].x, p.points[i].y);
        ctx.closePath();
        ctx.strokeStyle = mat.strokeColor;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      finalUrl = out.toDataURL("image/jpeg", 0.92);
      pushGardenImageToHistory(finalUrl);
    }
    // If all zones already AI-applied, gardenImage is already set correctly.

    // Register material costs (supports both area-based and length-based)
    for (const z of zoneData) {
      if (z.cost === null || z.cost === undefined) continue;
      const qty = z.isLen ? (z.perimeterM ?? 0) : (z.areaM2 ?? 0);
      if (qty <= 0) continue;
      addMaterialCost({
        materialId: z.mat.id,
        materialName: `${z.mat.emoji} ${z.mat.name} (CAD)`,
        areaM2: z.areaM2 ?? 0,
        perimeterM: z.perimeterM ?? undefined,
        unitType: z.isLen ? "length" : "area",
        pricePerM2: z.unitPrice,
        total: z.cost,
      });
    }

    const aiCount = polygons.filter(p => p.aiApplied).length;
    toast({
      title: "Diseño guardado ✓",
      description: `${polygons.length} zona${polygons.length > 1 ? "s" : ""} — ${aiCount} con textura IA. Ahora puedes agregar plantas y árboles.`,
    });
    setLocation("/design");
  }, [polygons, bgImg, gardenImage, zoneData, pushGardenImageToHistory, setGardenImage, addMaterialCost, toast, setLocation]);

  // ── Cursor style ──────────────────────────────────────────────────────────
  const cursorStyle = panOrigin ? "grabbing"
    : tool === "draw"      ? "crosshair"
    : tool === "calibrate" ? "crosshair"
    : tool === "delete"    ? "not-allowed"
    : tool === "light"     ? "cell"
    : dragState            ? "grabbing"
    : "default";

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-[100dvh] w-full bg-[#0f1117] text-white overflow-hidden select-none">

      {/* ── TOP BAR ─────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between h-12 px-2 md:px-3 bg-[#161b22] border-b border-white/10 shrink-0 z-20">
        {/* ── Left: back + title ─── */}
        <div className="flex items-center gap-1.5 md:gap-2 min-w-0">
          <button
            onClick={() => setLocation("/design")}
            className="flex items-center gap-1 text-white/60 hover:text-white text-sm px-1.5 py-1 rounded hover:bg-white/10 transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Volver</span>
          </button>
          <span className="text-white/20 hidden sm:inline">|</span>
          <span className="text-sm font-semibold text-white/90 tracking-tight truncate hidden sm:inline">Diseñador CAD</span>
          {ppm && (
            <span className="text-[10px] bg-emerald-900/60 text-emerald-300 px-1.5 py-0.5 rounded-full border border-emerald-700/40 hidden md:inline">
              {ppm.toFixed(0)} px/m ✓
            </span>
          )}
        </div>

        {/* ── Right: actions ─── */}
        <div className="flex items-center gap-1 md:gap-2">
          {/* Undo / Redo — top bar shortcuts */}
          <div className="hidden sm:flex items-center gap-0.5">
            <button
              onClick={() => { const s = undo(getSnapshot()); if (s) restoreSnapshot(s); }}
              disabled={!canUndo}
              title="Deshacer (Ctrl+Z)"
              className="p-1.5 hover:bg-white/10 rounded disabled:opacity-20 disabled:cursor-not-allowed transition-opacity"
            >
              <Undo2 className="w-4 h-4 text-white/70" />
            </button>
            <button
              onClick={() => { const s = redo(getSnapshot()); if (s) restoreSnapshot(s); }}
              disabled={!canRedo}
              title="Rehacer (Ctrl+Shift+Z)"
              className="p-1.5 hover:bg-white/10 rounded disabled:opacity-20 disabled:cursor-not-allowed transition-opacity"
            >
              <Redo2 className="w-4 h-4 text-white/70" />
            </button>
            <span className="text-white/20 mx-1">|</span>
          </div>

          {/* Zoom — hidden on mobile */}
          <div className="hidden md:flex items-center gap-1">
            <button onClick={() => zoomBy(1.25)} className="p-1.5 hover:bg-white/10 rounded" title="Acercar">
              <ZoomIn className="w-4 h-4 text-white/70" />
            </button>
            <button onClick={() => zoomBy(1 / 1.25)} className="p-1.5 hover:bg-white/10 rounded" title="Alejar">
              <ZoomOut className="w-4 h-4 text-white/70" />
            </button>
            <button onClick={resetView} className="p-1.5 hover:bg-white/10 rounded" title="Centrar vista">
              <Maximize2 className="w-4 h-4 text-white/70" />
            </button>
            <span className="text-xs text-white/40 w-10 text-right">{Math.round(xform.scale * 100)}%</span>
            <span className="text-white/20 mx-1">|</span>
          </div>

          {/* ── Terreno Limpio ── */}
          <button
            onClick={handleCleanTerrain}
            disabled={isCleaningTerrain || !gardenImage}
            title={
              !gardenImage
                ? "Sube una imagen del terreno primero"
                : isOnline
                  ? "Limpiar terreno con IA — elimina objetos y vegetación, genera tierra neutra base. Piscinas y pisos conservados."
                  : "Limpiar terreno (sin conexión) — aplica capa base de tierra"
            }
            className="flex items-center gap-1.5 text-sm bg-lime-700/70 hover:bg-lime-600/80 disabled:opacity-40 disabled:cursor-not-allowed text-lime-100 px-2 md:px-3 py-1.5 rounded-lg font-medium border border-lime-500/40 transition-all"
          >
            {isCleaningTerrain
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Leaf className="w-4 h-4" />}
            <span className="hidden lg:inline">
              {isCleaningTerrain ? "Limpiando…" : "Terreno Limpio"}
            </span>
          </button>

          {/* ── Pasto Automático ── */}
          <button
            onClick={handleAutoGrass}
            disabled={isAutoGrass || !gardenImage}
            title={!gardenImage ? "Sube una imagen del terreno primero" : "La IA aplica Zoysia podado a 1 cm en toda la superficie libre, detectando bardas, piscina y estructuras automáticamente"}
            className="flex items-center gap-1.5 text-sm bg-green-700/80 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-green-100 px-2 md:px-3 py-1.5 rounded-lg font-medium border border-green-500/40 transition-all"
          >
            {isAutoGrass
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Wand2 className="w-4 h-4" />}
            <span className="hidden lg:inline">
              {isAutoGrass ? "Aplicando…" : "Pasto Automático"}
            </span>
          </button>

          {/* ── Recorrer jardín 3D ── */}
          <button
            onClick={() => setShowWalkthrough(true)}
            disabled={!gardenImage && designItems.length === 0}
            title={(gardenImage || designItems.length > 0) ? "Recorrer el jardín con los elementos colocados" : "Sube una imagen o coloca elementos primero"}
            className="flex items-center gap-1.5 text-sm bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-2 md:px-3 py-1.5 rounded-lg font-medium border border-emerald-500/40 transition-all"
          >
            <Footprints className="w-4 h-4" />
            <span className="hidden lg:inline">Recorrer jardín</span>
          </button>

          {/* ── Export group ── */}
          <div className="flex items-center gap-1">
            {/* Exportar imagen */}
            <button
              onClick={exportImage}
              disabled={isExporting || (!bgImg && !gardenImage)}
              title="Exportar imagen PNG de alta resolución (todas las capas)"
              className="flex items-center gap-1.5 text-sm text-sky-300 hover:text-sky-100 disabled:opacity-40 disabled:cursor-not-allowed px-2 py-1.5 rounded hover:bg-sky-500/15 border border-sky-500/20 hover:border-sky-400/40 transition-colors"
            >
              {isExporting && exportType === "image"
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Download className="w-4 h-4" />}
              <span className="hidden lg:inline">Imagen</span>
            </button>

            {/* Exportar datos JSON */}
            <button
              onClick={exportProjectData}
              disabled={isExporting}
              title="Exportar datos del proyecto en JSON (zonas, plantas, costos)"
              className="hidden sm:flex items-center gap-1.5 text-sm text-amber-300 hover:text-amber-100 disabled:opacity-40 disabled:cursor-not-allowed px-2 py-1.5 rounded hover:bg-amber-500/15 border border-amber-500/20 hover:border-amber-400/40 transition-colors"
            >
              <FileText className="w-4 h-4" />
              <span className="hidden lg:inline">Datos</span>
            </button>

            {/* Exportar proyecto completo */}
            <button
              onClick={exportComplete}
              disabled={isExporting || (!bgImg && !gardenImage && polygons.length === 0 && designItems.length === 0)}
              title="Exportar imagen HD + datos JSON — paquete completo para cliente"
              className="hidden md:flex items-center gap-1.5 text-sm text-emerald-300 hover:text-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed px-2 py-1.5 rounded hover:bg-emerald-500/15 border border-emerald-500/20 hover:border-emerald-400/40 transition-colors"
            >
              {isExporting && exportType === "complete"
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Package className="w-4 h-4" />}
              <span className="hidden lg:inline">Completo</span>
            </button>
          </div>

          {/* AI applied → go to design */}
          {polygons.some(p => p.aiApplied) && (
            <button
              onClick={saveToProject}
              className="hidden sm:flex items-center gap-1.5 text-sm bg-emerald-500 hover:bg-emerald-400 text-white px-3 py-1.5 rounded-lg font-bold transition-colors animate-pulse"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden md:inline">Ir al diseño IA ✓</span>
            </button>
          )}

          {/* Save — icon+label on sm+, icon-only on xs */}
          <button
            onClick={saveToProject}
            disabled={polygons.length === 0 || isApplying}
            className="flex items-center gap-1.5 text-sm bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed text-white/80 px-2 md:px-4 py-1.5 rounded font-medium transition-colors border border-white/15"
          >
            <Save className="w-4 h-4" />
            <span className="hidden md:inline">{polygons.some(p => p.aiApplied) ? "Guardar todo" : "Guardar"}</span>
          </button>

          {/* Panel toggle — mobile only */}
          {isMobile && (
            <button
              onClick={() => setMobilePanelOpen(o => !o)}
              className="flex items-center gap-1 text-sm bg-white/10 hover:bg-white/20 text-white/80 px-2 py-1.5 rounded font-medium border border-white/15 transition-colors"
            >
              <Palette className="w-4 h-4" />
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT TOOL SIDEBAR — hidden on mobile, shown from md+ ─── */}
        <aside className={`flex-col items-center gap-1 bg-[#161b22] border-r border-white/10 py-3 shrink-0 z-10 ${isMobile ? "hidden" : "flex"} ${isTablet ? "w-12" : "w-14"}`}>
          {([
            { id: "draw",      Icon: Pencil,         label: "Dibujar (D)",   color: "text-emerald-400" },
            { id: "select",    Icon: MousePointer2,  label: "Seleccionar (S)", color: "text-sky-400" },
            { id: "calibrate", Icon: Ruler,           label: "Calibrar (C)",  color: "text-amber-400" },
            { id: "delete",    Icon: Trash2,          label: "Borrar",        color: "text-red-400" },
          ] as const).map(({ id, Icon, label, color }) => (
            <button
              key={id}
              onClick={() => { setTool(id as Tool); if (id !== "draw") setDrawing(null); }}
              title={label}
              className={`
                w-10 h-10 rounded-lg flex items-center justify-center transition-all
                ${tool === id
                  ? `bg-white/15 ring-1 ring-white/30 ${color}`
                  : "text-white/40 hover:text-white/80 hover:bg-white/8"}
              `}
            >
              <Icon className="w-5 h-5" />
            </button>
          ))}

          {/* Light placement tool */}
          <div className="w-8 h-px bg-white/10 mx-auto my-0.5" />
          <button
            onClick={() => { setTool("light"); setDrawing(null); }}
            title={`Agregar luz (${lights.length} colocada${lights.length !== 1 ? "s" : ""})`}
            className={`
              w-10 h-10 rounded-lg flex items-center justify-center transition-all relative
              ${tool === "light"
                ? "bg-white/15 ring-1 ring-white/30 text-yellow-300"
                : "text-white/40 hover:text-white/80 hover:bg-white/8"}
            `}
          >
            <Lightbulb className="w-5 h-5" />
            {lights.length > 0 && (
              <span className="absolute -top-1 -right-1 text-[8px] bg-yellow-500 text-black font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                {lights.length}
              </span>
            )}
          </button>

          {/* SNAP SUAVE toggle */}
          <div className="w-8 h-px bg-white/10 mx-auto my-0.5" />
          <button
            onClick={() => setSoftSnap(v => !v)}
            title={softSnap ? "Snap suave ON (click = libre)" : "Snap suave OFF"}
            className={`
              w-10 h-10 rounded-lg flex flex-col items-center justify-center transition-all gap-0
              ${softSnap
                ? "bg-cyan-500/20 ring-1 ring-cyan-400/50 text-cyan-300"
                : "text-white/30 hover:text-white/70 hover:bg-white/8"}
            `}
          >
            <span className="text-[8px] font-bold leading-tight">SNAP</span>
            <span className={`text-[7px] leading-tight font-semibold ${softSnap ? "text-cyan-400" : "text-white/30"}`}>
              {softSnap ? "ON" : "OFF"}
            </span>
          </button>

          <div className="flex-1" />

          {/* Undo */}
          <button
            onClick={() => { const s = undo(getSnapshot()); if (s) restoreSnapshot(s); }}
            disabled={!canUndo}
            title="Deshacer (Ctrl+Z)"
            className="w-10 h-10 rounded-lg flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/8 disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
          >
            <Undo2 className="w-4 h-4" />
          </button>

          {/* Redo */}
          <button
            onClick={() => { const s = redo(getSnapshot()); if (s) restoreSnapshot(s); }}
            disabled={!canRedo}
            title="Rehacer (Ctrl+Shift+Z)"
            className="w-10 h-10 rounded-lg flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/8 disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
          >
            <Redo2 className="w-4 h-4" />
          </button>

          {/* Layer panel toggle */}
          <button
            onClick={() => setShowLayerPanel(v => !v)}
            title="Panel de capas"
            className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${showLayerPanel ? "bg-sky-600/40 text-sky-300 ring-1 ring-sky-500/40" : "text-white/40 hover:text-white/80 hover:bg-white/8"}`}
          >
            <Layers className="w-4 h-4" />
          </button>

          {/* Mostrar / ocultar nombres */}
          <button
            onClick={() => setShowLabels(!showLabels)}
            title={showLabels ? "Ocultar nombres (solo en hover/selección)" : "Mostrar todos los nombres"}
            className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${showLabels ? "bg-violet-600/40 text-violet-300 ring-1 ring-violet-500/40" : "text-white/40 hover:text-white/80 hover:bg-white/8"}`}
          >
            <Tag className="w-4 h-4" />
          </button>
        </aside>

        {/* ── CANVAS ──────────────────────────────────────────────────── */}
        <div className="flex-1 relative overflow-hidden">
          {!gardenImage && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/40 z-10 pointer-events-none">
              <AlertCircle className="w-10 h-10" />
              <p className="text-sm">Sin imagen de fondo — puedes dibujar zonas libremente</p>
              <button onClick={() => setLocation("/design")} className="mt-2 text-sm underline underline-offset-2 text-white/60 hover:text-white pointer-events-auto">
                Ir al diseño con imagen
              </button>
            </div>
          )}
          {/* ── Panel de descarga/re-subida tras Terreno Limpio ── */}
          {cleanedTerrainUrl && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-slate-900/95 border border-emerald-500/40 rounded-xl px-4 py-2.5 shadow-xl backdrop-blur-sm">
              <span className="text-xs text-emerald-400 font-semibold whitespace-nowrap">Terreno limpio listo</span>
              <div className="w-px h-4 bg-white/20" />
              <button
                onClick={downloadCleanedTerrain}
                className="flex items-center gap-1.5 text-xs text-white/80 hover:text-white bg-emerald-700/60 hover:bg-emerald-600/80 px-3 py-1.5 rounded-lg transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Descargar
              </button>
              <button
                onClick={() => {
                  if (!canUndoImage) return;
                  undoGardenImage();
                  if (imageHistoryCount <= 1) setCleanedTerrainUrl(null);
                }}
                disabled={!canUndoImage}
                className="flex items-center gap-1.5 text-xs text-white/80 hover:text-white bg-orange-700/60 hover:bg-orange-600/80 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title={canUndoImage ? `Restaurar foto (${imageHistoryCount} paso${imageHistoryCount !== 1 ? "s" : ""} atrás)` : "Sin cambios para restaurar"}
              >
                <Undo2 className="w-3.5 h-3.5" />
                Restaurar{imageHistoryCount > 1 && (
                  <span className="bg-orange-500/60 text-white text-[10px] px-1 rounded-full ml-0.5">{imageHistoryCount}</span>
                )}
              </button>
              <button
                onClick={() => cadImageInputRef.current?.click()}
                className="flex items-center gap-1.5 text-xs text-white/80 hover:text-white bg-sky-700/60 hover:bg-sky-600/80 px-3 py-1.5 rounded-lg transition-colors"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                Subir imagen
              </button>
              <button
                onClick={() => setCleanedTerrainUrl(null)}
                className="text-white/30 hover:text-white/70 p-1 rounded-lg transition-colors"
                title="Cerrar"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <input
            ref={cadImageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleCadImageUpload}
          />

          <canvas
            ref={canvasRef}
            className="w-full h-full"
            style={{ cursor: cursorStyle, touchAction: "none" }}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => { setCursor(null); setSnapInfo(null); setPanOrigin(null); setDragState(null); }}
            onDoubleClick={handleDblClick}
            onContextMenu={handleContextMenu}
            onWheel={handleWheel}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          />
          {/* FASE 1 — measurementCanvas: capa exclusiva para líneas de calibración */}
          {/* pointerEvents: none — toda interacción la maneja canvasRef */}
          <canvas
            ref={measureCanvasRef}
            className="absolute inset-0 w-full h-full"
            style={{ pointerEvents: "none", zIndex: 4 }}
          />

          {/* ── HTML overlay: design items with real CSS-3D perspective ── */}
          {layerStates.plants.visible && (
            <div
              className="absolute inset-0 overflow-hidden"
              style={{ pointerEvents: "none", zIndex: 5 }}
            >
              {designItems.map((item, originalIdx) => {
                const hw   = ASSET_BASE * (item.scale ?? 1);
                const sSize = hw * 2 * xform.scale;          // full px on screen
                // item.x / item.y are normalised (0-1) — convert to world-pixels first
                const _iW  = bgImg?.naturalWidth  ?? canvasRef.current?.width  ?? 800;
                const _iH  = bgImg?.naturalHeight ?? canvasRef.current?.height ?? 600;
                const sx   = (item.x * _iW) * xform.scale + xform.tx;
                const sy   = (item.y * _iH) * xform.scale + xform.ty;
                const rotDeg   = ((item.rotation ?? 0) * 180 / Math.PI);
                const tiltXDeg = ((item.tiltX    ?? 0) * 180 / Math.PI);
                const tiltYDeg = ((item.tiltY    ?? 0) * 180 / Math.PI);
                const isSel    = item.id === selectedAssetId;
                const perspDist = Math.round(sSize * 3);      // perspective ∝ size

                return (
                  <div
                    key={item.id}
                    style={{
                      position:  "absolute",
                      left:       sx,
                      top:        sy,
                      width:      sSize,
                      height:     sSize,
                      transformOrigin: "center center",
                      // último colocado adelante; seleccionado siempre al frente
                      zIndex: isSel ? 1000 : 10 + originalIdx,
                      isolation: "isolate",   // evita fusión de filtros entre items
                      transform: [
                        "translate(-50%,-50%)",
                        `rotate(${rotDeg}deg)`,
                        `perspective(${perspDist}px)`,
                        `rotateX(${tiltXDeg}deg)`,
                        `rotateY(${tiltYDeg}deg)`,
                      ].join(" "),
                    }}
                  >
                    {item.imageData ? (
                      <img
                        src={item.imageData}
                        alt={item.name ?? ""}
                        draggable={false}
                        style={{
                          width: "100%", height: "100%",
                          objectFit: "contain", display: "block",
                          // Desvanece el pie hacia transparente → efecto "plantado en el suelo"
                          maskImage: "linear-gradient(to top, transparent 0%, black 20%, black 100%)",
                          WebkitMaskImage: "linear-gradient(to top, transparent 0%, black 20%, black 100%)",
                          filter: isSel
                            ? "brightness(1.15) saturate(1.4) drop-shadow(0 0 6px rgba(255,255,255,0.5))"
                            : "brightness(1.15) saturate(1.4) drop-shadow(0 1px 3px rgba(0,0,0,0.18))",
                        }}
                      />
                    ) : (
                      /* Fallback: coloured circle + initial */
                      <div style={{
                        width: "100%", height: "100%", borderRadius: "50%",
                        background: isSel ? "rgba(34,197,94,0.6)" : "rgba(34,197,94,0.45)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: "#fff",
                        fontWeight: "bold",
                        fontSize: Math.max(10, hw * 0.6 * xform.scale),
                      }}>
                        {(item.name ?? "?")[0].toUpperCase()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Asset Manipulation Toolbar ──────────────────────────── */}
          {selectedAssetId && (() => {
            const selItem = designItems.find(i => i.id === selectedAssetId);
            if (!selItem) return null;
            return (
              <div
                className="absolute bottom-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 bg-gray-900/95 backdrop-blur-sm border border-white/15 rounded-xl px-3 py-2 shadow-2xl"
                onMouseDown={e => e.stopPropagation()}
              >
                {/* Item name badge */}
                <span className="text-xs font-medium text-white/80 max-w-[90px] truncate mr-2 border-r border-white/15 pr-2">
                  {selItem.name}
                </span>

                {/* Mode buttons */}
                {(["move", "rotate", "scale"] as const).map(mode => {
                  const labels = { move: "✥ Mover", rotate: "↻ Rotar", scale: "⤢ Escalar" };
                  const active = assetMode === mode;
                  return (
                    <button
                      key={mode}
                      onClick={() => setAssetMode(mode)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                        active
                          ? "bg-blue-600 text-white shadow-lg"
                          : "text-white/70 hover:bg-white/10 hover:text-white"
                      }`}
                      title={
                        mode === "move"   ? "Arrastrar para mover" :
                        mode === "rotate" ? "Arrastrar para rotar" :
                                           "Rueda del mouse para escalar"
                      }
                    >
                      {labels[mode]}
                    </button>
                  );
                })}

                {/* Scale display + quick scale buttons */}
                <div className="flex items-center gap-1 ml-1 border-l border-white/15 pl-2">
                  <button
                    onClick={() => {
                      const item = designItems.find(i => i.id === selectedAssetId);
                      if (item) updateDesignItem(selectedAssetId, { scale: Math.max(0.1, (item.scale ?? 1) * (1/1.12)) });
                    }}
                    className="w-6 h-6 rounded-md bg-white/10 hover:bg-white/20 text-white text-sm flex items-center justify-center font-bold"
                    title="Reducir tamaño"
                  >−</button>
                  <span className="text-xs text-white/60 w-10 text-center font-mono">
                    {((selItem.scale ?? 1) * 100).toFixed(0)}%
                  </span>
                  <button
                    onClick={() => {
                      const item = designItems.find(i => i.id === selectedAssetId);
                      if (item) updateDesignItem(selectedAssetId, { scale: Math.min(10, (item.scale ?? 1) * 1.12) });
                    }}
                    className="w-6 h-6 rounded-md bg-white/10 hover:bg-white/20 text-white text-sm flex items-center justify-center font-bold"
                    title="Aumentar tamaño"
                  >+</button>
                </div>

                {/* ── Rotación 360° libre ───────────────────────── */}
                <div
                  className="flex items-center gap-1.5 ml-1 border-l border-white/15 pl-3"
                  onMouseDown={e => e.stopPropagation()}
                >
                  <span className="text-xs text-white/50 font-medium select-none">↻</span>

                  {/* Slider 0-360 */}
                  <input
                    type="range"
                    min={0}
                    max={360}
                    step={1}
                    value={Math.round(((selItem.rotation ?? 0) * 180 / Math.PI + 720) % 360)}
                    onChange={e => {
                      const deg = Number(e.target.value);
                      updateDesignItem(selectedAssetId, { rotation: deg * Math.PI / 180 });
                    }}
                    className="w-20 h-1.5 accent-blue-500 cursor-pointer"
                    title="Rotar libremente 0°–360°"
                  />

                  {/* Degree input (editable) */}
                  <input
                    type="number"
                    min={0}
                    max={360}
                    step={1}
                    value={Math.round(((selItem.rotation ?? 0) * 180 / Math.PI + 720) % 360)}
                    onChange={e => {
                      const deg = Math.max(0, Math.min(360, Number(e.target.value) || 0));
                      updateDesignItem(selectedAssetId, { rotation: deg * Math.PI / 180 });
                    }}
                    className="w-10 bg-white/10 border border-white/15 rounded text-xs text-white text-center px-0.5 py-0.5 font-mono focus:outline-none focus:border-blue-400"
                    title="Ángulo en grados"
                  />
                  <span className="text-xs text-white/40 select-none">°</span>

                  {/* Reset a 0° */}
                  <button
                    onClick={() => updateDesignItem(selectedAssetId, { rotation: 0 })}
                    className="text-xs text-white/50 hover:text-white hover:bg-white/10 px-1.5 py-0.5 rounded"
                    title="Restablecer a 0°"
                  >↺</button>
                </div>

                {/* ── Tilt 3D ──────────────────────────────────────────── */}
                <div
                  className="flex items-center gap-1.5 ml-1 border-l border-white/15 pl-3"
                  onMouseDown={e => e.stopPropagation()}
                >
                  {/* tiltX — inclinación adelante/atrás (eje X) */}
                  <span className="text-xs text-white/50 select-none" title="Inclinación adelante/atrás">⤸X</span>
                  <input
                    type="range" min={-90} max={90} step={1}
                    value={Math.round((selItem.tiltX ?? 0) * 180 / Math.PI)}
                    onChange={e => updateDesignItem(selectedAssetId, { tiltX: Number(e.target.value) * Math.PI / 180 })}
                    className="w-16 h-1.5 accent-purple-500 cursor-pointer"
                    title="Inclinar adelante/atrás (–90° a 90°)"
                  />
                  <span className="text-xs text-white/40 font-mono w-6 text-right">
                    {Math.round((selItem.tiltX ?? 0) * 180 / Math.PI)}°
                  </span>

                  {/* tiltY — inclinación lateral (eje Y) */}
                  <span className="text-xs text-white/50 select-none ml-1.5" title="Inclinación lateral">⤹Y</span>
                  <input
                    type="range" min={-90} max={90} step={1}
                    value={Math.round((selItem.tiltY ?? 0) * 180 / Math.PI)}
                    onChange={e => updateDesignItem(selectedAssetId, { tiltY: Number(e.target.value) * Math.PI / 180 })}
                    className="w-16 h-1.5 accent-purple-500 cursor-pointer"
                    title="Inclinar izquierda/derecha (–90° a 90°)"
                  />
                  <span className="text-xs text-white/40 font-mono w-6 text-right">
                    {Math.round((selItem.tiltY ?? 0) * 180 / Math.PI)}°
                  </span>

                  {/* Reset tilt */}
                  <button
                    onClick={() => updateDesignItem(selectedAssetId, { tiltX: 0, tiltY: 0 })}
                    className="text-xs text-white/50 hover:text-white hover:bg-white/10 px-1.5 py-0.5 rounded ml-0.5"
                    title="Restablecer inclinación 3D"
                  >⊡</button>
                </div>

                {/* Delete */}
                <button
                  onClick={() => { removeDesignItem(selectedAssetId); setSelectedAssetId(null); }}
                  className="ml-1 px-2 py-1 rounded-lg text-xs text-red-400 hover:bg-red-500/20 hover:text-red-300 border-l border-white/15 pl-3"
                  title="Eliminar elemento"
                >
                  🗑 Eliminar
                </button>

                {/* Close */}
                <button
                  onClick={() => { setSelectedAssetId(null); setAssetDragOrigin(null); }}
                  className="ml-1 w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 text-white/60 hover:text-white text-sm flex items-center justify-center"
                  title="Cerrar"
                >✕</button>
              </div>
            );
          })()}

          {/* ── Zone Label Overlay (HTML — not on canvas) ───────────── */}
          {layerStates.zones.visible && polygons.filter(p => p.closed && p.points.length >= 3).map(poly => {
            const isSelected = poly.id === selectedId;
            const visible = showLabels || isSelected;
            const mat = getMaterial(poly.materialId);
            const centroid = polygonCentroid(poly.points);
            const screenX = centroid.x * xform.scale + xform.tx;
            const screenY = centroid.y * xform.scale + xform.ty;
            const areaPx = shoelaceArea(poly.points);
            const areaM2 = ppm ? areaPx / (ppm * ppm) : null;
            const label = labelMap[poly.id] ?? mat.name;
            const areaText = areaM2 ? `${areaM2.toFixed(1)} m²` : null;
            return (
              <div
                key={`label-${poly.id}`}
                className="absolute pointer-events-none"
                style={{
                  left: screenX,
                  top: screenY,
                  transform: "translate(-50%, -50%)",
                  opacity: visible ? 1 : 0,
                  transition: "opacity 0.18s ease",
                  zIndex: 15,
                }}
              >
                <div
                  className="flex flex-col items-center gap-0.5"
                  style={{
                    background: "rgba(0,0,0,0.72)",
                    backdropFilter: "blur(6px)",
                    borderRadius: "6px",
                    padding: "3px 8px",
                    border: isSelected ? "1px solid rgba(245,158,11,0.5)" : "1px solid rgba(255,255,255,0.08)",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
                  }}
                >
                  <span className="text-white font-semibold whitespace-nowrap" style={{ fontSize: `${Math.min(14, Math.max(9, 13 * xform.scale))}px` }}>
                    {mat.emoji ?? ""} {label}
                  </span>
                  {areaText && (
                    <span className="text-emerald-300 whitespace-nowrap" style={{ fontSize: `${Math.min(12, Math.max(8, 11 * xform.scale))}px` }}>
                      {areaText}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {/* ── Floating Layer Panel ─────────────────────────────────── */}
          {showLayerPanel && (
            <div className="absolute top-3 left-3 z-30 bg-[#1a1f2e]/95 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl w-52 text-sm select-none">
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                <span className="font-semibold text-white/80 text-xs tracking-wide uppercase">Capas</span>
                <button onClick={() => setShowLayerPanel(false)} className="text-white/30 hover:text-white/70 transition-colors text-xs">✕</button>
              </div>
              <div className="py-1">
                {CAD_LAYERS.map(layer => {
                  const ls = layerStates[layer.id];
                  const isActive = activeLayerId === layer.id;
                  return (
                    <div
                      key={layer.id}
                      onClick={() => setActiveLayerId(layer.id)}
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${isActive ? "bg-white/10" : "hover:bg-white/5"}`}
                    >
                      {/* Visibility toggle */}
                      <button
                        onClick={e => { e.stopPropagation(); toggleLayerVisible(layer.id); }}
                        className="text-white/50 hover:text-white transition-colors shrink-0"
                        title={ls.visible ? "Ocultar capa" : "Mostrar capa"}
                      >
                        {ls.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5 opacity-40" />}
                      </button>

                      {/* Lock toggle */}
                      <button
                        onClick={e => { e.stopPropagation(); toggleLayerLocked(layer.id); }}
                        className="text-white/50 hover:text-white transition-colors shrink-0"
                        title={ls.locked ? "Desbloquear capa" : "Bloquear capa"}
                      >
                        {ls.locked ? <Lock className="w-3.5 h-3.5 text-amber-400" /> : <Unlock className="w-3.5 h-3.5" />}
                      </button>

                      {/* Layer name */}
                      <span className={`flex-1 text-xs truncate ${ls.visible ? "text-white/80" : "text-white/30 line-through"}`}>
                        {layer.name}
                      </span>

                      {/* Active indicator */}
                      {isActive && <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />}
                    </div>
                  );
                })}
              </div>
              <div className="px-3 py-2 border-t border-white/10">
                <p className="text-[10px] text-white/25 leading-tight">Capa activa recibe dibujos nuevos</p>
              </div>
            </div>
          )}

          {/* Drawing hint */}
          {tool === "draw" && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm text-white/80 text-xs px-3 py-1.5 rounded-full pointer-events-none">
              {drawing === null
                ? "Clic para comenzar a dibujar una zona"
                : drawing.length < 3
                  ? `${drawing.length} punto${drawing.length > 1 ? "s" : ""} — sigue haciendo clic`
                  : "Clic al primer punto para cerrar · doble clic para terminar · Shift=ángulo"}
            </div>
          )}
          {tool === "calibrate" && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-amber-950/80 backdrop-blur-sm text-amber-200 text-xs px-3 py-1.5 rounded-full pointer-events-none">
              {calibPhase === "idle" || calibPhase === "picking-start"
                ? "Clic en el inicio de una distancia conocida"
                : calibPhase === "picking-end"
                  ? "Clic al final de la distancia · Shift=línea recta"
                  : "Ingresa la distancia real en metros"}
            </div>
          )}
          {tool === "select" && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm text-white/80 text-xs px-3 py-1.5 rounded-full pointer-events-none">
              Clic para seleccionar · arrastrar vértice para mover · clic derecho para borrar vértice · Supr para borrar zona
            </div>
          )}
          {tool === "delete" && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-red-950/80 backdrop-blur-sm text-red-200 text-xs px-3 py-1.5 rounded-full pointer-events-none">
              Clic sobre una zona para borrarla
            </div>
          )}
        </div>

        {/* ── RIGHT PANEL ─────────────────────────────────────────────── */}
        {/* RIGHT PANEL — hidden on mobile (shown as bottom-sheet), narrow on tablet */}
        <aside className={`bg-[#161b22] border-l border-white/10 flex-col shrink-0 z-10 ${isMobile ? "hidden" : "flex"} ${isTablet ? "w-60" : "w-72"}`}>

          {/* ── SCROLLABLE CONTENT ─── */}
          <div className="flex-1 overflow-y-auto">

          {/* ── PASO 1: Elige material ─── */}
          <div className="px-3 pt-3 pb-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full bg-emerald-700 text-white text-[10px] font-bold flex items-center justify-center shrink-0">1</span>
              <p className="text-[11px] font-semibold text-white/70 uppercase tracking-widest">Elige textura</p>
            </div>

            {/* Aviso cuando la zona seleccionada tiene material bloqueado */}
            {(() => {
              const selPoly = polygons.find(p => p.id === selectedId);
              const selMat  = selPoly ? getMaterial(selPoly.materialId) : null;
              if (!selMat?.locked) return null;
              return (
                <div className="mb-2 flex items-start gap-1.5 px-2 py-1.5 rounded-lg bg-amber-900/30 border border-amber-500/30">
                  <span className="text-amber-400 text-[12px] shrink-0">🔒</span>
                  <p className="text-[10px] text-amber-300/80 leading-tight">
                    <span className="font-semibold">{selMat.name}</span> está bloqueado.<br/>
                    No se puede reemplazar este material premium.
                  </p>
                </div>
              );
            })()}

            <div className="grid grid-cols-2 gap-1.5">
              {getMaterialsByCategory("floor").filter(m => ["grass","white-stone","grey-stone","red-stone","black-stone","multi-stone","gravel"].includes(m.id)).map(m => {
                const isActive = activeMat === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => {
                      setActiveMat(m.id);
                      if (selectedId) applyFlatColor(selectedId, m.id);
                    }}
                    className={`
                      relative flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left transition-all border
                      ${isActive
                        ? "bg-white/15 border-white/30 text-white ring-1 ring-emerald-500/60"
                        : "bg-white/5 border-white/8 text-white/60 hover:bg-white/10 hover:text-white"}
                    `}
                  >
                    <span
                      className="w-4 h-4 rounded-sm shrink-0 border border-black/25 flex-none"
                      style={{ background: solidFill(m.fillColor) }}
                    />
                    <span className="leading-tight truncate text-[11px] flex-1">{m.name}</span>
                    {m.locked && (
                      <span
                        className="shrink-0 text-[9px] leading-none px-1 py-0.5 rounded bg-amber-600/40 text-amber-300 border border-amber-500/30 font-semibold"
                        title="Material premium bloqueado"
                      >
                        🔒
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

          </div>

          {/* ── PASO 2: Dibuja o selecciona zona ─── */}
          <div className="px-3 pt-3 pb-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-5 h-5 rounded-full bg-emerald-700 text-white text-[10px] font-bold flex items-center justify-center shrink-0">2</span>
              <p className="text-[11px] font-semibold text-white/70 uppercase tracking-widest">Dibuja o selecciona</p>
            </div>
            <p className="text-[11px] text-white/40 leading-snug">
              {selectedId
                ? `✔ Zona seleccionada (${getMaterial(polygons.find(p=>p.id===selectedId)?.materialId ?? "grass").name})`
                : polygons.length > 0
                  ? "Clic en una zona del canvas para seleccionarla, o dibuja una nueva"
                  : "Usa la herramienta Lápiz (D) para dibujar el perímetro"}
            </p>
          </div>

          {/* ── MEDICIÓN DE ZONA SELECCIONADA ─── */}
          {(() => {
            if (!selectedId) return null;
            const zd = zoneData.find(z => z.poly.id === selectedId);
            if (!zd) return null;
            const aFmt  = zd.areaM2    !== null ? formatM2(zd.areaM2)           : null;
            const pFmt  = zd.perimeterM !== null ? formatMeters(zd.perimeterM)   : null;
            const activeQtyFmt = zd.isLen ? pFmt : aFmt;
            const activeUnit   = zd.isLen ? "ml" : "m²";
            return (
              <div className="mx-3 mt-2 mb-0 rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
                {/* Header with mode selector */}
                <div className="flex items-center justify-between px-2.5 py-1.5 bg-sky-950/40 border-b border-sky-700/30">
                  <div className="flex items-center gap-1.5">
                    <Ruler size={11} className="text-sky-400 shrink-0" />
                    <span className="text-[10px] font-semibold text-sky-300 uppercase tracking-wider">{zd.mat.name}</span>
                    {zd.isAutoMode && (
                      <span className="text-[8px] text-sky-500/60 italic">auto</span>
                    )}
                  </div>
                  {/* Mode toggle pills */}
                  <div className="flex items-center gap-0.5 bg-white/5 rounded-lg p-0.5">
                    <button
                      onClick={() => setMeasureModeOverrides(prev => ({ ...prev, [selectedId]: "area" }))}
                      className={`px-2 py-0.5 rounded text-[9px] font-bold transition-colors ${
                        !zd.isLen ? "bg-sky-600/80 text-white" : "text-white/35 hover:text-white/60"
                      }`}
                      title="Medición por área (m²)"
                    >
                      m²
                    </button>
                    <button
                      onClick={() => setMeasureModeOverrides(prev => ({ ...prev, [selectedId]: "length" }))}
                      className={`px-2 py-0.5 rounded text-[9px] font-bold transition-colors ${
                        zd.isLen ? "bg-amber-600/80 text-white" : "text-white/35 hover:text-white/60"
                      }`}
                      title="Medición lineal (ml)"
                    >
                      ml
                    </button>
                    {!zd.isAutoMode && (
                      <button
                        onClick={() => setMeasureModeOverrides(prev => { const n = {...prev}; delete n[selectedId]; return n; })}
                        className="px-1 py-0.5 rounded text-[9px] text-white/25 hover:text-white/50 transition-colors"
                        title="Restaurar modo automático"
                      >
                        ↺
                      </button>
                    )}
                  </div>
                </div>

                {/* Main measurement display */}
                {ppm ? (
                  <div className="px-3 py-2.5">
                    {/* Active measurement — large */}
                    <div className={`flex items-baseline gap-1.5 mb-1.5 pb-1.5 border-b border-white/8 ${zd.isLen ? "text-amber-300" : "text-sky-300"}`}>
                      <span className="text-[22px] font-black leading-none">
                        {zd.isLen
                          ? (pFmt?.m ?? "—")
                          : (aFmt?.m2 ?? "—")
                        }
                      </span>
                      <span className="text-[11px] font-semibold opacity-80">{activeUnit}</span>
                      {activeQtyFmt && (
                        <span className="text-[9px] text-white/35 ml-auto self-end">
                          {zd.isLen ? `${pFmt?.cm} cm` : aFmt?.detail}
                        </span>
                      )}
                    </div>

                    {/* Secondary row: both values */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-white/5 rounded-lg px-2 py-1.5">
                        <div className="text-[8px] text-white/30 uppercase tracking-wider mb-0.5">Área</div>
                        <div className="text-[11px] font-bold text-sky-300/80">{aFmt ? `${aFmt.m2} m²` : "—"}</div>
                        {aFmt && <div className="text-[8px] text-white/25">{aFmt.detail}</div>}
                      </div>
                      <div className="bg-white/5 rounded-lg px-2 py-1.5">
                        <div className="text-[8px] text-white/30 uppercase tracking-wider mb-0.5">Perímetro</div>
                        <div className="text-[11px] font-bold text-amber-300/80">{pFmt ? `${pFmt.m} ml` : "—"}</div>
                        {pFmt && <div className="text-[8px] text-white/25">{pFmt.cm} cm</div>}
                      </div>
                    </div>

                    {/* Cost row */}
                    {zd.cost !== null && (
                      <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-white/8">
                        <span className="text-[9px] text-white/35">
                          {(zd.isLen ? pFmt?.m : aFmt?.m2) ?? "—"} {activeUnit} × ${zd.unitPrice.toLocaleString("es-MX")}/{activeUnit}
                        </span>
                        <span className="text-[12px] font-bold text-emerald-300">
                          ${zd.cost.toLocaleString("es-MX", { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="px-3 py-2.5 text-[9px] text-amber-400/80 flex items-center gap-1.5">
                    <Ruler size={10} className="shrink-0" />
                    Calibra la escala (herramienta Regla) para ver medidas reales
                  </div>
                )}
              </div>
            );
          })()}


          {/* ── ESCENA: Modo noche + Luces ─── */}
          <div className="mx-3 mt-2 rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-white/10 bg-white/5">
              {sceneMode === "night" ? <Moon size={11} className="text-indigo-400 shrink-0" /> : <Sun size={11} className="text-yellow-400 shrink-0" />}
              <span className="text-[10px] font-semibold text-white/60 uppercase tracking-wider">Escena</span>
            </div>
            <div className="px-3 py-2 flex flex-col gap-1.5">
              {/* Night mode toggle */}
              <button
                onClick={() => setSceneMode(m => m === "day" ? "night" : "day")}
                className={`flex items-center gap-2 w-full rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                  sceneMode === "night"
                    ? "bg-indigo-700/60 text-indigo-100 hover:bg-indigo-700/80"
                    : "bg-white/8 text-white/70 hover:bg-white/12"
                }`}
              >
                {sceneMode === "night" ? <Moon size={12} /> : <Sun size={12} />}
                {sceneMode === "night" ? "Modo noche activo" : "Modo noche"}
                <span className="ml-auto text-[9px] opacity-60">{sceneMode === "night" ? "ON" : "OFF"}</span>
              </button>

              {/* Light tool shortcut */}
              <button
                onClick={() => { setTool("light"); setDrawing(null); }}
                className={`flex items-center gap-2 w-full rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                  tool === "light"
                    ? "bg-yellow-700/50 text-yellow-200 hover:bg-yellow-700/70"
                    : "bg-white/8 text-white/70 hover:bg-white/12"
                }`}
              >
                <Lightbulb size={12} />
                {tool === "light" ? "Clic en canvas para colocar luz" : "Agregar luces"}
                {lights.length > 0 && <span className="ml-auto text-[9px] opacity-80">{lights.length} luz{lights.length !== 1 ? "es" : ""}</span>}
              </button>

              {/* Clear lights */}
              {lights.length > 0 && (
                <button
                  onClick={() => setLights([])}
                  className="flex items-center gap-1.5 w-full rounded-lg px-3 py-1.5 text-[10px] text-rose-400/80 hover:text-rose-300 hover:bg-rose-950/30 transition-colors"
                >
                  <X size={10} />
                  Borrar {lights.length} luz{lights.length !== 1 ? "es" : ""}
                </button>
              )}
            </div>
          </div>

          {/* ── PASO 3: APLICAR TEXTURA — botón principal ─── */}
          <div className="px-3 pt-3 pb-3 border-b border-white/10">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full bg-emerald-700 text-white text-[10px] font-bold flex items-center justify-center shrink-0">3</span>
              <p className="text-[11px] font-semibold text-white/70 uppercase tracking-widest">Aplica</p>
            </div>

            {/* Loading state */}
            {isApplying && (
              <div className="w-full py-3 rounded-xl bg-emerald-950/60 border border-emerald-700/40 flex flex-col items-center gap-1.5">
                <div className="flex items-center gap-2 text-emerald-300 text-sm font-medium">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generando con IA...
                </div>
                <p className="text-[11px] text-emerald-400/70 text-center px-2">{applyMsg}</p>
              </div>
            )}

            {!isApplying && selectedId ? (
              <div className="flex flex-col gap-1.5">
                {/* UNIFIED: aplica el MISMO material a TODAS las áreas idénticas */}
                {(() => {
                  const sameMat = polygons.filter(p => p.materialId === activeMat && p.points.length >= 3);
                  if (sameMat.length < 2) return null;
                  return (
                    <button
                      onClick={() => applyMaterialToAllPolygons(activeMat)}
                      title="Operación unificada: aplica el MISMO material a TODAS las áreas con UNA SOLA pasada de IA. Color, tono, densidad y escala idénticos. Cero variación entre zonas."
                      className="w-full py-3 rounded-xl bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-violet-900/40 ring-1 ring-violet-300/30"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>{getMaterial(activeMat).emoji}</span>
                      Aplicar a TODAS las áreas ({sameMat.length})
                    </button>
                  );
                })()}
                {/* PRIMARY: AI texture (single polygon) */}
                <button
                  onClick={() => applyMaterialWithAI(selectedId, activeMat)}
                  className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 transition-all text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-900/40"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>{getMaterial(activeMat).emoji}</span>
                  Textura IA — {getMaterial(activeMat).name}
                </button>
                {/* SECONDARY: pixel-perfect pattern bake (no AI, instant, exact polygon) */}
                <button
                  onClick={() => applyPatternDirect(selectedId, activeMat)}
                  className="w-full py-2.5 rounded-lg bg-blue-700/60 hover:bg-blue-600/70 border border-blue-400/30 text-blue-100 hover:text-white text-xs flex items-center justify-center gap-1.5 transition-all font-medium"
                >
                  <Ruler className="w-3.5 h-3.5" />
                  Patrón exacto — respeta medidas
                </button>
                {/* TERTIARY: flat color preview */}
                <button
                  onClick={() => applyFlatColor(selectedId, activeMat)}
                  className="w-full py-2 rounded-lg bg-white/8 hover:bg-white/12 border border-white/15 text-white/60 hover:text-white text-xs flex items-center justify-center gap-1.5 transition-all"
                >
                  <Palette className="w-3.5 h-3.5" />
                  Solo color (sin IA, instantáneo)
                </button>
                {/* LIMPIAR TERRENO */}
                <div className="border-t border-white/10 pt-1.5 mt-0.5">
                  <button
                    onClick={() => handleLimpiarTerreno(selectedId)}
                    className="w-full py-2 rounded-lg bg-amber-950/50 hover:bg-amber-900/60 border border-amber-700/40 hover:border-amber-600/60 text-amber-300 hover:text-amber-200 text-xs flex items-center justify-center gap-1.5 transition-all font-medium"
                    title="Elimina objetos, vegetación y ruido visual solo dentro del polígono — genera tierra neutra lista para diseñar"
                  >
                    <Eraser className="w-3.5 h-3.5" />
                    Limpiar zona — tierra neutra
                  </button>
                </div>
              </div>
            ) : !isApplying && polygons.length > 0 ? (
              <div className="text-[11px] text-white/40 text-center py-2 px-1">
                Selecciona una zona en el canvas<br />
                <button className="text-sky-400 underline underline-offset-2 mt-1 block hover:text-sky-300" onClick={() => setTool("select")}>
                  Activar herramienta selección
                </button>
              </div>
            ) : !isApplying ? (
              <div className="w-full py-3 rounded-xl bg-white/5 border border-white/10 text-white/30 text-sm text-center">
                Dibuja una zona primero
              </div>
            ) : null}
          </div>

          {/* ── PASO 4: Diseño automático con IA ─── */}
          <div className="px-3 pt-3 pb-3 border-b border-white/10">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full bg-violet-700 text-white text-[10px] font-bold flex items-center justify-center shrink-0">4</span>
              <p className="text-[11px] font-semibold text-white/70 uppercase tracking-widest">Diseño Automático IA</p>
            </div>

            {/* Style selector */}
            {!isDesigning && (
              <div className="flex gap-1 mb-2 flex-wrap">
                {(["moderno","tropical","minimalista","rustico"] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setDesignStyle(s)}
                    className={`text-[11px] px-2 py-1 rounded-md border transition-all capitalize ${designStyle === s ? "bg-violet-700/50 border-violet-500/60 text-violet-200" : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10 hover:text-white"}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* Designing state */}
            {isDesigning ? (
              <div className="w-full py-3 rounded-xl bg-violet-950/60 border border-violet-700/40 flex flex-col items-center gap-1.5">
                <div className="flex items-center gap-2 text-violet-300 text-sm font-medium">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generando diseño...
                </div>
                <p className="text-[11px] text-violet-400/70 text-center px-2">{designMsg}</p>
              </div>
            ) : selectedId ? (
              <button
                onClick={() => generateAutoDesign(selectedId, designStyle)}
                className="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-violet-900/40"
              >
                <Wand2 className="w-4 h-4" />
                Generar diseño {designStyle}
              </button>
            ) : (
              <div className="w-full py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/30 text-sm text-center">
                Selecciona una zona primero
              </div>
            )}

            {/* BOM panel */}
            {designBOM && designBOM.length > 0 && !isDesigning && (
              <div className="mt-2 rounded-lg border border-violet-700/30 bg-violet-950/30 overflow-hidden">
                <button
                  onClick={() => setBomExpanded(e => !e)}
                  className="w-full flex items-center justify-between px-2.5 py-2 text-[11px] text-violet-300 font-semibold hover:bg-violet-900/30 transition-colors"
                >
                  <span>Plan de diseño ({designBOM.length} elementos)</span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${bomExpanded ? "rotate-180" : ""}`} />
                </button>
                {bomExpanded && (
                  <div className="px-2 pb-2 flex flex-col gap-1">
                    {designBOM.map((item, i) => (
                      <div key={i} className="flex items-center justify-between text-[11px]">
                        <span className="text-white/70 truncate mr-1">{item.nombre} ×{item.cantidad}</span>
                        <span className="text-emerald-400 shrink-0">${item.subtotal.toLocaleString()}</span>
                      </div>
                    ))}
                    <div className="border-t border-white/10 mt-1 pt-1 flex justify-between text-[11px] font-bold">
                      <span className="text-white/50">Total BOM</span>
                      <span className="text-emerald-400">${designBOM.reduce((a,b) => a + b.subtotal, 0).toLocaleString()}</span>
                    </div>
                    {!bomAddedToQuote && (
                      <button
                        onClick={() => addBOMToQuote(designBOM)}
                        className="mt-1.5 w-full py-1.5 rounded-lg bg-emerald-700/50 hover:bg-emerald-600/60 border border-emerald-600/40 text-emerald-300 text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-all"
                      >
                        <DollarSign className="w-3.5 h-3.5" />
                        Agregar a cotización
                      </button>
                    )}
                    {bomAddedToQuote && (
                      <p className="text-center text-[10px] text-emerald-400/70 mt-1">✓ Agregado a cotización</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Calibration shortcut */}
          {!ppm && (
            <div className="mx-3 mt-2 p-2.5 rounded-lg bg-amber-900/25 border border-amber-700/30 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-[11px] text-amber-300 font-medium">Sin calibración de escala</p>
                <p className="text-[10px] text-amber-400/70 mt-0.5">Activa el m² real con la herramienta de regla.</p>
                <button
                  onClick={() => { setTool("calibrate"); setDrawing(null); }}
                  className="mt-1.5 text-[11px] text-amber-300 underline underline-offset-2 hover:text-amber-200"
                >
                  Calibrar ahora →
                </button>
              </div>
            </div>
          )}

          {/* Zone list */}
          <div className="flex-1 overflow-y-auto px-3 py-2">
            <p className="text-[11px] font-semibold text-white/40 uppercase tracking-widest mb-2">
              Zonas ({zoneData.length})
            </p>

            {zoneData.length === 0 ? (
              <p className="text-xs text-white/30 text-center mt-6">
                Dibuja zonas en el terreno para ver los detalles aquí
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {zoneData.map(({ poly, mat, areaM2, cost }, idx) => (
                  <div
                    key={poly.id}
                    onClick={() => { setSelectedId(poly.id); setTool("select"); }}
                    className={`
                      p-2.5 rounded-lg cursor-pointer transition-all border
                      ${selectedId === poly.id
                        ? "bg-white/12 border-amber-500/50"
                        : "bg-white/5 border-white/8 hover:bg-white/8"}
                    `}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <div
                          className="w-3 h-3 rounded-sm border shrink-0"
                          style={{ backgroundColor: mat.fillColor, borderColor: mat.strokeColor }}
                        />
                        <span className="text-[12px] font-medium text-white/90 truncate">{mat.emoji} {mat.name}</span>
                        {poly.aiApplied && (
                          <span className="shrink-0 text-[9px] bg-emerald-700/60 border border-emerald-500/40 text-emerald-300 px-1.5 py-0.5 rounded-full font-bold tracking-wide">
                            IA ✓
                          </span>
                        )}
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); setPolygons(ps => ps.filter(p => p.id !== poly.id)); if (selectedId === poly.id) setSelectedId(null); }}
                        className="text-white/30 hover:text-red-400 transition-colors shrink-0 ml-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {/* Area + base cost row */}
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[11px] text-white/50">
                        {areaM2 ? `${areaM2.toFixed(2)} m²` : `${(shoelaceArea(poly.points) / 1000).toFixed(0)}k px`}
                      </span>
                      {cost !== null ? (
                        <span className="text-[11px] font-semibold text-emerald-400">{formatCost(cost)}</span>
                      ) : (
                        <span className="text-[11px] text-white/30">sin escala</span>
                      )}
                    </div>

                    {/* Expanded estimate when selected */}
                    {selectedId === poly.id && (() => {
                      const est = polyEstimates.find(e => e.polyId === poly.id);
                      if (!est) return (
                        <p className="text-[10px] text-amber-400/70 mt-2">Calibra la escala para ver estimados</p>
                      );
                      const dm = densityOverrides[poly.id] ?? 1.0;
                      return (
                        <div className="mt-2 pt-2 border-t border-white/8">
                          {/* Quantity + unit */}
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] text-white/40">Cantidad necesaria</span>
                            <span className="text-[11px] font-semibold text-white/80">
                              {est.qtyAdjusted.toFixed(2)} {est.unit}
                            </span>
                          </div>

                          {/* Note */}
                          {est.note && (
                            <p className="text-[10px] text-white/30 mb-1.5">{est.note}</p>
                          )}

                          {/* Density multiplier */}
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-[10px] text-white/40 shrink-0">Factor ajuste</span>
                            <input
                              type="number"
                              min="0.5" max="3" step="0.05"
                              value={dm.toFixed(2)}
                              onClick={e => e.stopPropagation()}
                              onChange={e => {
                                const v = parseFloat(e.target.value);
                                if (!isNaN(v) && v > 0) {
                                  setDensityOverrides(prev => ({ ...prev, [poly.id]: v }));
                                }
                              }}
                              className="w-16 bg-white/10 border border-white/20 rounded px-1.5 py-0.5 text-[11px] text-white text-right focus:outline-none focus:border-emerald-500/60"
                            />
                            <button
                              onClick={e => { e.stopPropagation(); setDensityOverrides(prev => { const n = {...prev}; delete n[poly.id]; return n; }); }}
                              className="text-[10px] text-white/30 hover:text-white/60"
                              title="Restablecer"
                            >↺</button>
                          </div>

                          {/* Unit price + total */}
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] text-white/40">${est.unitPrice.toLocaleString()}/{est.unit}</span>
                            <span className="text-[12px] font-bold text-emerald-400">${est.total.toLocaleString()}</span>
                          </div>

                          {/* Agregar a cotización */}
                          <button
                            onClick={e => { e.stopPropagation(); addPolyToQuote(est); }}
                            className="w-full py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-700/40 hover:bg-emerald-600/60 text-emerald-300 border border-emerald-600/30 transition-colors"
                          >
                            + Agregar a cotización
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Material summary section ────────────────────────── */}
          {materialSummary.length > 0 && (
            <div className="px-3 pb-2 shrink-0">
              <button
                onClick={() => setShowMaterialSummary(v => !v)}
                className="flex items-center justify-between w-full py-1.5 text-[11px] font-bold text-white/50 uppercase tracking-widest hover:text-white/70 transition-colors"
              >
                <span>Resumen de materiales ({materialSummary.length})</span>
                <span className="text-[10px] normal-case tracking-normal">{showMaterialSummary ? "▲" : "▼"}</span>
              </button>
              {showMaterialSummary && (
                <div className="flex flex-col gap-1 mt-1">
                  {materialSummary.map(row => (
                    <div key={row.materialId} className="bg-white/5 rounded-lg px-2 py-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[11px]">{row.emoji}</span>
                          <div className="min-w-0">
                            <p className="text-[11px] font-medium text-white/80 truncate">{row.materialName}</p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className={`text-[8px] px-1.5 py-0 rounded-full font-semibold ${row.unitType === "length" ? "bg-amber-700/40 text-amber-300" : "bg-sky-800/40 text-sky-300"}`}>
                                {row.unitType === "length" ? "ML" : "M²"}
                              </span>
                              <p className="text-[10px] text-white/35">
                                {row.totalQty.toFixed(2)} {row.unit} · ${row.unitPrice.toLocaleString("es-MX")}/{row.unit} · {row.zoneCount} zona{row.zoneCount !== 1 ? "s" : ""}
                              </p>
                            </div>
                          </div>
                        </div>
                        <span className="text-[11px] font-semibold text-emerald-400 shrink-0 ml-2">${row.totalCost.toLocaleString("es-MX", { maximumFractionDigits: 0 })}</span>
                      </div>
                    </div>
                  ))}
                  {/* Agregar todo a cotización */}
                  <button
                    onClick={() => { polyEstimates.forEach(e => addPolyToQuote(e)); }}
                    className="w-full mt-1 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-700/50 hover:bg-emerald-600/70 text-emerald-200 border border-emerald-600/30 transition-colors"
                  >
                    + Agregar todo a cotización
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── PARTIDAS MANUALES ─────────────────────────────────────── */}
          <div className="px-3 pb-2 shrink-0 border-t border-white/10">
            <button
              onClick={() => setShowManualPanel(v => !v)}
              className="flex items-center justify-between w-full py-1.5 text-[11px] font-bold text-white/60 uppercase tracking-widest hover:text-white/80 transition-colors"
            >
              <div className="flex items-center gap-1.5">
                <DollarSign size={11} className="text-amber-400 shrink-0" />
                <span>Partidas manuales{manualEntries.length > 0 ? ` (${manualEntries.length})` : ""}</span>
              </div>
              {showManualPanel ? <ChevronUp size={11} className="text-white/30" /> : <ChevronDown size={11} className="text-white/30" />}
            </button>

            {showManualPanel && (
              <div className="space-y-2">
                {/* Form */}
                <div className="bg-white/[0.04] border border-white/10 rounded-lg p-2 space-y-1.5">
                  {/* Concepto */}
                  <input
                    type="text"
                    placeholder="Concepto (ej. Pasto Zoysia, Adoquín...)"
                    value={manualConcept}
                    onChange={e => setManualConcept(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-amber-500/50"
                  />
                  {/* Cantidad + Unidad */}
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Cantidad"
                      value={manualQty}
                      onChange={e => setManualQty(e.target.value)}
                      className="flex-1 bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-amber-500/50"
                    />
                    <div className="flex rounded-md border border-white/10 overflow-hidden shrink-0">
                      <button
                        onClick={() => setManualUnit("m2")}
                        className={`px-2 py-1 text-[10px] font-bold transition-colors ${manualUnit === "m2" ? "bg-amber-600/70 text-white" : "bg-white/5 text-white/40 hover:bg-white/10"}`}
                      >
                        m²
                      </button>
                      <button
                        onClick={() => setManualUnit("ml")}
                        className={`px-2 py-1 text-[10px] font-bold transition-colors ${manualUnit === "ml" ? "bg-amber-600/70 text-white" : "bg-white/5 text-white/40 hover:bg-white/10"}`}
                      >
                        ml
                      </button>
                    </div>
                  </div>
                  {/* Precio por unidad */}
                  <div className="relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-white/40">$</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder={`Precio por ${manualUnit === "m2" ? "m²" : "ml"}`}
                      value={manualPrice}
                      onChange={e => setManualPrice(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-md pl-5 pr-2 py-1 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-amber-500/50"
                    />
                  </div>
                  {/* Preview total */}
                  {manualQty && manualPrice && parseFloat(manualQty) > 0 && parseFloat(manualPrice) > 0 && (
                    <div className="flex items-center justify-between px-1 text-[10px]">
                      <span className="text-white/40">{parseFloat(manualQty || "0").toFixed(2)} {manualUnit === "m2" ? "m²" : "ml"} × ${parseFloat(manualPrice || "0").toLocaleString("es-MX")}</span>
                      <span className="font-bold text-amber-300">${(parseFloat(manualQty || "0") * parseFloat(manualPrice || "0")).toLocaleString("es-MX", { maximumFractionDigits: 0 })}</span>
                    </div>
                  )}
                  {/* Agregar */}
                  <button
                    onClick={addManualEntry}
                    className="w-full py-1.5 rounded-md text-[11px] font-bold bg-amber-600/60 hover:bg-amber-500/80 text-amber-100 border border-amber-500/30 transition-colors"
                  >
                    + Agregar a cotización
                  </button>
                </div>

                {/* Lista de partidas manuales agregadas */}
                {manualEntries.length > 0 && (
                  <div className="space-y-1">
                    {manualEntries.map(e => (
                      <div key={e.id} className="flex items-center justify-between bg-amber-900/20 border border-amber-700/25 rounded-lg px-2 py-1.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] font-medium text-white/80 truncate">{e.concept}</p>
                          <p className="text-[9px] text-white/35">{e.qty.toFixed(2)} {e.unit === "m2" ? "m²" : "ml"} · ${e.price.toLocaleString("es-MX")}/{e.unit === "m2" ? "m²" : "ml"}</p>
                        </div>
                        <span className="text-[11px] font-bold text-amber-300 ml-2 shrink-0">${e.total.toLocaleString("es-MX", { maximumFractionDigits: 0 })}</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between px-1 pt-0.5">
                      <span className="text-[10px] text-white/35">Subtotal partidas</span>
                      <span className="text-[11px] font-bold text-amber-400">
                        ${manualEntries.reduce((s, e) => s + e.total, 0).toLocaleString("es-MX", { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── COTIZACIÓN EN TIEMPO REAL ─────────────────────────────── */}
          {zoneData.length > 0 && (
            <div className="px-3 pb-2 shrink-0 border-t border-white/10">
              <button
                onClick={() => setShowQuoteSummary(v => !v)}
                className="flex items-center justify-between w-full py-1.5 text-[11px] font-bold text-white/60 uppercase tracking-widest hover:text-white/80 transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <Receipt size={11} className="text-emerald-400 shrink-0" />
                  <span>Cotización ({zoneData.length} zona{zoneData.length !== 1 ? "s" : ""})</span>
                </div>
                {showQuoteSummary ? <ChevronUp size={11} className="text-white/30" /> : <ChevronDown size={11} className="text-white/30" />}
              </button>

              {showQuoteSummary && (
                <div className="space-y-1">
                  {/* Per-zone rows */}
                  {zoneData.map(z => {
                    const isLen = z.isLen;
                    const qty = isLen ? z.perimeterM : z.areaM2;
                    return (
                      <div key={z.poly.id} className="bg-white/[0.03] border border-white/8 rounded-lg px-2.5 py-1.5">
                        <div className="flex items-center justify-between mb-0.5">
                          <div className="flex items-center gap-1 min-w-0">
                            <span className="text-[12px]">{z.mat.emoji}</span>
                            <span className="text-[10px] font-medium text-white/75 truncate">{z.mat.name}</span>
                            <span className={`text-[8px] px-1 rounded-full font-bold shrink-0 ${isLen ? "bg-amber-700/40 text-amber-300" : "bg-sky-800/40 text-sky-300"}`}>
                              {isLen ? "ML" : "M²"}
                            </span>
                          </div>
                          <span className="text-[11px] font-bold text-emerald-300 shrink-0 ml-2">
                            {z.cost !== null ? `$${z.cost.toLocaleString("es-MX", { maximumFractionDigits: 0 })}` : "—"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 text-[9px] text-white/35">
                            <span>{qty !== null ? qty.toFixed(2) : "—"} {isLen ? "ml" : "m²"}</span>
                            <span>·</span>
                            <span>${z.unitPrice.toLocaleString("es-MX")}/{isLen ? "ml" : "m²"}</span>
                          </div>
                          {!ppm && (
                            <span className="text-[8px] text-amber-400/60">Sin escala</span>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* IVA toggle */}
                  <div className="flex items-center justify-between px-1 pt-1">
                    <label htmlFor="iva-toggle" className="text-[10px] text-white/55 cursor-pointer select-none">
                      Aplicar IVA (16%)
                    </label>
                    <button
                      id="iva-toggle"
                      onClick={() => setApplyIVA(v => !v)}
                      className={`relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0 focus:outline-none ${
                        applyIVA ? "bg-emerald-600" : "bg-white/15"
                      }`}
                      aria-pressed={applyIVA}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
                        applyIVA ? "translate-x-4" : "translate-x-0"
                      }`} />
                    </button>
                  </div>

                  {/* Subtotal / IVA / Total */}
                  <div className="bg-white/[0.04] border border-white/10 rounded-xl px-3 py-2.5 space-y-1 mt-1">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-white/45">Subtotal</span>
                      <span className="text-white/70 font-medium">
                        {totalCost > 0 ? `$${totalCost.toLocaleString("es-MX", { maximumFractionDigits: 0 })}` : "—"}
                      </span>
                    </div>
                    {applyIVA && ivaAmount > 0 && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-amber-400/70">IVA 16%</span>
                        <span className="text-amber-300/80 font-medium">
                          +${ivaAmount.toLocaleString("es-MX", { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between pt-1 border-t border-white/10">
                      <span className="text-[11px] font-bold text-white/80">Total{applyIVA ? " c/IVA" : ""}</span>
                      <span className="text-[15px] font-bold text-emerald-400">
                        {totalConIVA > 0 ? `$${totalConIVA.toLocaleString("es-MX", { maximumFractionDigits: 0 })}` : "—"}
                      </span>
                    </div>
                  </div>

                  {/* Add all to quote */}
                  {polyEstimates.length > 0 && (
                    <button
                      onClick={() => { polyEstimates.forEach(e => addPolyToQuote(e)); }}
                      className="w-full mt-0.5 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-700/50 hover:bg-emerald-600/70 text-emerald-200 border border-emerald-600/30 transition-colors flex items-center justify-center gap-1.5"
                    >
                      <Receipt size={10} />
                      Agregar cotización
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Total cost footer */}
          <div className="px-3 py-3 border-t border-white/10 bg-[#0f1117] shrink-0">
            {/* Area + Perimeter totals */}
            <div className="grid grid-cols-2 gap-2 mb-2 text-center">
              <div className="bg-white/5 rounded-lg py-1.5">
                <p className="text-[9px] text-white/35 uppercase tracking-wider">Área total</p>
                <p className="text-[13px] font-bold text-white">{ppm && totalM2 > 0 ? `${totalM2.toFixed(1)} m²` : "—"}</p>
              </div>
              <div className="bg-white/5 rounded-lg py-1.5">
                <p className="text-[9px] text-white/35 uppercase tracking-wider">Perímetro total</p>
                <p className="text-[13px] font-bold text-white">
                  {ppm && zoneData.some(z => z.perimeterM !== null)
                    ? `${zoneData.reduce((s, z) => s + (z.perimeterM ?? 0), 0).toFixed(1)} ml`
                    : "—"}
                </p>
              </div>
            </div>
            {totalEstimatedCost > 0 && (
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-white/50">Total materiales</span>
                <span className="text-sm font-bold text-emerald-400">{formatCost(totalEstimatedCost)}</span>
              </div>
            )}
            {/* Partidas manuales subtotal */}
            {manualEntries.length > 0 && (
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-amber-400/70">Partidas manuales ({manualEntries.length})</span>
                <span className="text-xs font-bold text-amber-300">
                  {formatCost(manualEntries.reduce((s, e) => s + e.total, 0))}
                </span>
              </div>
            )}
            {/* IVA indicator in footer */}
            {applyIVA && (totalCost + manualEntries.reduce((s, e) => s + e.total, 0)) > 0 && (
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-amber-400/60">IVA 16%</span>
                <span className="text-xs text-amber-300/70 font-medium">
                  +{formatCost((totalCost + manualEntries.reduce((s, e) => s + e.total, 0)) * 0.16)}
                </span>
              </div>
            )}
            {(() => {
              const manualTotal = manualEntries.reduce((s, e) => s + e.total, 0);
              const combined = totalCost + manualTotal;
              const combinedIVA = applyIVA ? combined * 0.16 : 0;
              const grandTotal = combined + combinedIVA;
              return (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/50">Total{applyIVA ? " c/IVA" : " estimado"}</span>
                  <span className="text-lg font-bold text-emerald-400">
                    {grandTotal > 0 ? formatCost(grandTotal) : "—"}
                  </span>
                </div>
              );
            })()}
            <p className="text-[10px] text-white/25 mt-1">
              {ppm ? `Escala: ${ppm.toFixed(1)} px/m` : "Calibra la escala para ver costos"}
            </p>
          </div>

          </div>{/* end scrollable */}
        </aside>
      </div>

      {/* ── MOBILE BOTTOM TOOLBAR — visible on mobile only ───────────────────────── */}
      {isMobile && (
        <div className="fixed bottom-0 left-0 right-0 z-30 bg-[#161b22] border-t border-white/10 flex items-center justify-around px-2 py-1.5 safe-area-pb">
          {([
            { id: "draw",      Icon: Pencil,        label: "Dibujar",   color: "text-emerald-400" },
            { id: "select",    Icon: MousePointer2, label: "Selec.",    color: "text-sky-400" },
            { id: "calibrate", Icon: Ruler,         label: "Calibrar",  color: "text-amber-400" },
            { id: "delete",    Icon: Trash2,        label: "Borrar",    color: "text-red-400" },
          ] as const).map(({ id, Icon, label, color }) => (
            <button
              key={id}
              onClick={() => { setTool(id); if (id !== "draw") setDrawing(null); }}
              className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg transition-all ${
                tool === id ? `bg-white/15 ${color}` : "text-white/40 hover:text-white/70"
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}

          {/* SNAP SUAVE toggle — móvil */}
          <button
            onClick={() => setSoftSnap(v => !v)}
            className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg transition-all ${
              softSnap ? "bg-cyan-500/20 text-cyan-300" : "text-white/30"
            }`}
          >
            <span className="text-[11px] font-bold leading-tight">SNAP</span>
            <span className={`text-[9px] font-semibold ${softSnap ? "text-cyan-400" : "text-white/30"}`}>
              {softSnap ? "ON" : "OFF"}
            </span>
          </button>

          {/* Undo */}
          <button
            onClick={() => { setPolygons(ps => ps.slice(0, -1)); setSelectedId(null); }}
            className="flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg text-white/40 hover:text-white/70"
          >
            <Undo2 className="w-5 h-5" />
            <span className="text-[10px] font-medium">Deshacer</span>
          </button>

          {/* Zoom reset */}
          <button
            onClick={resetView}
            className="flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg text-white/40 hover:text-white/70"
          >
            <Maximize2 className="w-5 h-5" />
            <span className="text-[10px] font-medium">Centrar</span>
          </button>
        </div>
      )}

      {/* ── MOBILE BOTTOM SHEET (right panel) ────────────────────────────────────── */}
      {isMobile && mobilePanelOpen && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end">
          {/* backdrop */}
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setMobilePanelOpen(false)} />

          {/* sheet */}
          <div className="relative bg-[#161b22] border-t border-white/15 rounded-t-2xl max-h-[75dvh] flex flex-col overflow-hidden">
            {/* drag handle + close */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
              <div className="w-10 h-1 bg-white/25 rounded-full mx-auto absolute left-1/2 -translate-x-1/2 top-2" />
              <span className="text-sm font-semibold text-white/80">Panel de diseño</span>
              <button onClick={() => setMobilePanelOpen(false)} className="text-white/40 hover:text-white p-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* scrollable content */}
            <div className="flex-1 overflow-y-auto">

              {/* PASO 1: Elige textura */}
              <div className="px-3 pt-3 pb-2 border-b border-white/8">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-5 h-5 rounded-full bg-emerald-700 text-white text-[10px] font-bold flex items-center justify-center shrink-0">1</span>
                  <span className="text-[11px] font-semibold text-white/70 uppercase tracking-widest">Elige textura</span>
                </div>
                {/* Aviso zona bloqueada — mobile */}
                {(() => {
                  const selPoly = polygons.find(p => p.id === selectedId);
                  const selMat  = selPoly ? getMaterial(selPoly.materialId) : null;
                  if (!selMat?.locked) return null;
                  return (
                    <div className="mb-1.5 flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-900/30 border border-amber-500/30">
                      <span className="text-amber-400 text-[11px]">🔒</span>
                      <p className="text-[10px] text-amber-300/80 leading-tight">
                        <strong>{selMat.name}</strong> — material bloqueado
                      </p>
                    </div>
                  );
                })()}
                <div className="grid grid-cols-2 gap-1.5">
                  {getMaterialsByCategory("floor").filter(m => ["grass","white-stone","grey-stone","red-stone","black-stone","multi-stone","gravel"].includes(m.id)).map(m => (
                    <button
                      key={m.id}
                      onClick={() => {
                        setActiveMat(m.id);
                        if (selectedId) applyFlatColor(selectedId, m.id);
                      }}
                      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-left transition-all ${
                        activeMat === m.id
                          ? "bg-white/15 border-white/30 text-white ring-1 ring-emerald-500/60"
                          : "bg-white/5 border-white/8 text-white/60 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      <span
                        className="w-3 h-3 rounded-sm shrink-0 border border-black/20 flex-none"
                        style={{ background: solidFill(m.fillColor) }}
                      />
                      <span className="text-[11px] leading-tight truncate flex-1">{m.name}</span>
                      {m.locked && (
                        <span className="shrink-0 text-[8px] text-amber-400" title="Material premium">🔒</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* PASO 2: Zona seleccionada */}
              <div className="px-3 pt-3 pb-2 border-b border-white/8">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="w-5 h-5 rounded-full bg-emerald-700 text-white text-[10px] font-bold flex items-center justify-center shrink-0">2</span>
                  <span className="text-[11px] font-semibold text-white/70 uppercase tracking-widest">Dibuja o selecciona</span>
                </div>
                <div className={`p-2 rounded-lg border text-xs ${
                  selectedId ? "border-sky-500/30 bg-sky-900/20 text-sky-300" : "border-white/10 bg-white/5 text-white/40"
                }`}>
                  {selectedId
                    ? `✔ Zona: ${getMaterial(polygons.find(p => p.id === selectedId)?.materialId ?? "grass").name}`
                    : polygons.length > 0
                      ? "Toca una zona en el plano para seleccionarla"
                      : "Usa Lápiz (abajo) para dibujar el perímetro"}
                </div>
              </div>

              {/* PASO 3: Aplicar textura IA */}
              <div className="px-3 pt-3 pb-3 border-b border-white/8">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-5 h-5 rounded-full bg-emerald-700 text-white text-[10px] font-bold flex items-center justify-center shrink-0">3</span>
                  <span className="text-[11px] font-semibold text-white/70 uppercase tracking-widest">Aplica</span>
                </div>
                {isApplying ? (
                  <div className="w-full py-3 rounded-xl bg-emerald-950/60 border border-emerald-700/40 flex flex-col items-center gap-1.5">
                    <div className="flex items-center gap-2 text-emerald-300 text-sm font-medium">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generando con IA...
                    </div>
                    <p className="text-[11px] text-emerald-400/70 text-center px-2">{applyMsg}</p>
                  </div>
                ) : selectedId ? (
                  <div className="flex flex-col gap-1.5">
                    <button
                      onClick={() => { applyMaterialWithAI(selectedId, activeMat); setMobilePanelOpen(false); }}
                      className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 transition-all text-white font-bold text-sm flex items-center justify-center gap-2"
                    >
                      <Sparkles className="w-4 h-4" />
                      {getMaterial(activeMat).emoji} Textura IA — {getMaterial(activeMat).name}
                    </button>
                    <button
                      onClick={() => { applyPatternDirect(selectedId, activeMat); setMobilePanelOpen(false); }}
                      className="w-full py-2.5 rounded-lg bg-blue-700/60 hover:bg-blue-600/70 border border-blue-400/30 text-blue-100 hover:text-white text-xs flex items-center justify-center gap-1.5 transition-all font-medium"
                    >
                      <Ruler className="w-3.5 h-3.5" />
                      Patrón exacto — respeta medidas
                    </button>
                    <button
                      onClick={() => { applyFlatColor(selectedId, activeMat); setMobilePanelOpen(false); }}
                      className="w-full py-2 rounded-lg bg-white/8 hover:bg-white/12 border border-white/15 text-white/60 hover:text-white text-xs flex items-center justify-center gap-1.5 transition-all"
                    >
                      <Palette className="w-3.5 h-3.5" />
                      Solo color (sin IA, instantáneo)
                    </button>
                    {/* LIMPIAR TERRENO — mobile */}
                    <div className="border-t border-white/10 pt-1.5">
                      <button
                        onClick={() => { handleLimpiarTerreno(selectedId); setMobilePanelOpen(false); }}
                        className="w-full py-2 rounded-lg bg-amber-950/50 hover:bg-amber-900/60 border border-amber-700/40 text-amber-300 hover:text-amber-200 text-xs flex items-center justify-center gap-1.5 transition-all font-medium"
                      >
                        <Eraser className="w-3.5 h-3.5" />
                        Limpiar zona — tierra neutra
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="w-full py-3 rounded-xl bg-white/5 border border-white/10 text-white/30 text-sm text-center">
                    {polygons.length > 0 ? "Toca una zona en el plano" : "Dibuja una zona primero"}
                  </div>
                )}
              </div>

              {/* PASO 4: Diseño automático IA */}
              <div className="px-3 pt-3 pb-3 border-b border-white/8">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-5 h-5 rounded-full bg-violet-700 text-white text-[10px] font-bold flex items-center justify-center shrink-0">4</span>
                  <span className="text-[11px] font-semibold text-white/70 uppercase tracking-widest">Diseño Automático IA</span>
                </div>
                {!isDesigning && (
                  <div className="flex gap-1 mb-2 flex-wrap">
                    {(["moderno","tropical","minimalista","rustico"] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => setDesignStyle(s)}
                        className={`text-[11px] px-2 py-1 rounded-md border transition-all capitalize ${designStyle === s ? "bg-violet-700/50 border-violet-500/60 text-violet-200" : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10 hover:text-white"}`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
                {isDesigning ? (
                  <div className="w-full py-3 rounded-xl bg-violet-950/60 border border-violet-700/40 flex flex-col items-center gap-1.5">
                    <div className="flex items-center gap-2 text-violet-300 text-sm font-medium">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generando diseño...
                    </div>
                    <p className="text-[11px] text-violet-400/70 text-center px-2">{designMsg}</p>
                  </div>
                ) : selectedId ? (
                  <button
                    onClick={() => { generateAutoDesign(selectedId, designStyle); setMobilePanelOpen(false); }}
                    className="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all text-white font-bold text-sm flex items-center justify-center gap-2"
                  >
                    <Wand2 className="w-4 h-4" />
                    Generar diseño {designStyle}
                  </button>
                ) : (
                  <div className="w-full py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/30 text-sm text-center">
                    Selecciona una zona primero
                  </div>
                )}
              </div>

              {/* Lista de zonas */}
              <div className="px-3 py-3">
                <p className="text-[11px] font-semibold text-white/40 uppercase tracking-widest mb-2">Zonas ({zoneData.length})</p>
                {zoneData.length === 0 ? (
                  <p className="text-xs text-white/30 text-center py-3">Dibuja zonas para ver los detalles aquí</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {zoneData.map(({ poly, mat, areaM2, cost }) => (
                      <div
                        key={poly.id}
                        onClick={() => { setSelectedId(poly.id); setTool("select"); setMobilePanelOpen(false); }}
                        className={`p-2 rounded-lg cursor-pointer border ${selectedId === poly.id ? "bg-white/12 border-amber-500/50" : "bg-white/5 border-white/8"}`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <div className="w-3 h-3 rounded-sm border shrink-0" style={{ backgroundColor: mat.fillColor, borderColor: mat.strokeColor }} />
                            <span className="text-xs font-medium text-white/90">{mat.emoji} {mat.name}</span>
                            {poly.aiApplied && <span className="text-[9px] bg-emerald-700/60 border border-emerald-500/40 text-emerald-300 px-1 py-0.5 rounded-full font-bold">IA ✓</span>}
                          </div>
                          <span className="text-xs font-semibold text-emerald-400">{cost !== null ? formatCost(cost) : "—"}</span>
                        </div>
                        <span className="text-[11px] text-white/40">{areaM2 ? `${areaM2.toFixed(1)} m²` : `${(shoelaceArea(poly.points)/1000).toFixed(0)}k px`}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Cost footer */}
              <div className="px-3 pb-8 pt-2 border-t border-white/10 bg-[#0f1117]">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/50">Costo estimado</span>
                  <span className="text-lg font-bold text-emerald-400">{totalCost > 0 ? formatCost(totalCost) : "—"}</span>
                </div>
                <p className="text-[10px] text-white/25 mt-0.5">{ppm ? `${totalM2.toFixed(1)} m² · ${ppm.toFixed(0)} px/m` : "Calibra la escala para ver costos"}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── CALIBRATION MODAL ──────────────────────────────────────────────── */}
      {showCalibModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-[#1c2333] border border-white/15 rounded-xl p-6 w-80 shadow-2xl">
            <h2 className="text-base font-bold text-white mb-1">Calibrar escala</h2>
            <p className="text-sm text-white/50 mb-4">
              ¿Cuántos metros mide la línea que dibujaste?
            </p>
            {calibStart && calibEnd && (
              <p className="text-xs text-amber-300/80 mb-3">
                Línea: {dist(calibStart, calibEnd).toFixed(0)} px
              </p>
            )}
            <input
              autoFocus
              type="number"
              min="0.01"
              step="0.01"
              placeholder="Ej: 5.00"
              value={calibInput}
              onChange={e => setCalibInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") confirmCalibration(); if (e.key === "Escape") { setShowCalibModal(false); setCalibPhase("idle"); } }}
              className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm placeholder:text-white/30 mb-4 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setShowCalibModal(false); setCalibPhase("idle"); setCalibStart(null); setCalibEnd(null); }}
                className="flex-1 py-2 rounded-lg border border-white/20 text-sm text-white/70 hover:bg-white/10"
              >
                Cancelar
              </button>
              <button
                onClick={confirmCalibration}
                disabled={!calibInput || parseFloat(calibInput) <= 0}
                className="flex-1 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-medium"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 3D Walkthrough overlay ──────────────────────────────────────────── */}
      {showWalkthrough && (
        <GardenWalkthrough
          polygons={polygons.map((p): WTPolygon => ({
            id: p.id,
            points: p.points,
            materialId: p.materialId,
            closed: p.closed,
          }))}
          designItems={designItems}
          gardenImage={gardenImage}
          imageWidth={bgImg?.naturalWidth ?? 1200}
          imageHeight={bgImg?.naturalHeight ?? 800}
          ppm={ppm}
          materials={materials}
          inventoryItems={wtInventory}
          onClose={() => setShowWalkthrough(false)}
        />
      )}
    </div>
  );
}
