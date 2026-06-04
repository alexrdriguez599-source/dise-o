/**
 * export-engine.ts — Professional flatten render for garden designer exports.
 *
 * Renders ALL layers at native image resolution with 2× pixel ratio:
 *   1. Base garden image (gardenImage has AI textures baked in)
 *   2. Flat-fill polygons for zones NOT yet AI-processed
 *   3. Polygon borders + labels
 *   4. Design items (plants) from the Design module
 *   5. Optional info overlay (project name, costs)
 *
 * Polygon points are stored in native image coordinates (no xform applied).
 * Design item x/y are percentages (0-100) of the container — converted here
 * to native image coordinates via (x/100*W, y/100*H).
 */

import type { DesignItem, Material, MaterialCost } from '../context/app-context';
import type { Point } from './polygon-manager';

export interface ExportPolygon {
  id: string;
  points: Point[];
  closed: boolean;
  materialId: string;
  aiApplied?: boolean;
  /** Computed area in m² (available when scale is calibrated) */
  areaM2?: number | null;
  /** Material quantity estimate */
  estimatedQty?: number | null;
  estimatedUnit?: string;
  estimatedCost?: number | null;
}

export interface ExportMaterial {
  id: string;
  name: string;
  type: string;
  fillColor: string;   // hex — computed from type
  strokeColor: string;
}

export interface ExportOptions {
  gardenImage: string | null;
  bgImgNaturalWidth: number;
  bgImgNaturalHeight: number;
  polygons: ExportPolygon[];
  designItems: DesignItem[];
  getMaterial: (id: string) => { id: string; name: string; type?: string; fillColor: string; strokeColor: string; emoji: string };
  drawMaterialFill: (ctx: CanvasRenderingContext2D, pts: Point[], mat: ReturnType<ExportOptions['getMaterial']>) => void;
  clientName?: string;
  totalProjectCost?: number;
  materialCosts?: MaterialCost[];
  pixelRatio?: number;
  includeDesignItems?: boolean;
  includeInfoOverlay?: boolean;
}

/**
 * Renders a complete flat PNG of the current garden design.
 * Returns a PNG data URL at native image resolution × pixelRatio.
 */
export async function renderFlatExport(opts: ExportOptions): Promise<string> {
  const {
    gardenImage,
    bgImgNaturalWidth: W,
    bgImgNaturalHeight: H,
    polygons,
    designItems,
    getMaterial,
    drawMaterialFill,
    clientName,
    totalProjectCost,
    pixelRatio = 2,
    includeDesignItems = true,
    includeInfoOverlay = false,
  } = opts;

  if (!gardenImage && !W) throw new Error('No hay imagen de terreno para exportar.');

  const out = document.createElement('canvas');
  out.width  = W * pixelRatio;
  out.height = H * pixelRatio;
  const ctx = out.getContext('2d')!;
  ctx.scale(pixelRatio, pixelRatio);

  // ─── 1. Base image ─────────────────────────────────────────────────────────
  if (gardenImage) {
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload  = () => { ctx.drawImage(img, 0, 0, W, H); resolve(); };
      img.onerror = () => reject(new Error('No se pudo cargar la imagen base.'));
      img.src = gardenImage;
    });
  } else {
    ctx.fillStyle = '#1a2e1a';
    ctx.fillRect(0, 0, W, H);
  }

  // ─── 2. Polygons (flat fill for non-AI zones) ──────────────────────────────
  for (const poly of polygons) {
    if (!poly.closed || poly.points.length < 3) continue;
    const mat = getMaterial(poly.materialId);

    // AI-applied zones already have textures baked into gardenImage; only
    // draw polygon borders so the zone boundaries are visible.
    if (!poly.aiApplied) {
      drawMaterialFill(ctx, poly.points, mat);
    }

    // Border
    ctx.beginPath();
    ctx.moveTo(poly.points[0].x, poly.points[0].y);
    for (let i = 1; i < poly.points.length; i++) ctx.lineTo(poly.points[i].x, poly.points[i].y);
    ctx.closePath();
    ctx.strokeStyle = poly.aiApplied ? 'rgba(255,255,255,0.25)' : mat.strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Zone label (small pill)
    if (!poly.aiApplied) {
      const cx = poly.points.reduce((s, p) => s + p.x, 0) / poly.points.length;
      const cy = poly.points.reduce((s, p) => s + p.y, 0) / poly.points.length;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = `${mat.emoji ?? ''} ${mat.name}`;
      const tw = ctx.measureText(label).width;
      ctx.beginPath();
      roundRect(ctx, cx - tw / 2 - 8, cy - 11, tw + 16, 22, 6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, cx, cy);
      ctx.restore();
    }
  }

  // ─── 3. Design items (plants) ──────────────────────────────────────────────
  if (includeDesignItems && designItems.length > 0) {
    for (const item of designItems) {
      const nx = (item.x / 100) * W;
      const ny = (item.y / 100) * H;
      const baseSize = Math.max(30, Math.min(80, W * 0.045)) * (item.scale ?? 1);

      ctx.save();
      ctx.translate(nx, ny);
      if (item.rotation) ctx.rotate((item.rotation * Math.PI) / 180);

      if (item.imageData) {
        // Draw plant image
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, -baseSize / 2, -baseSize / 2, baseSize, baseSize);
            resolve();
          };
          img.onerror = () => {
            drawPlantFallback(ctx, item.name, baseSize);
            resolve();
          };
          img.src = item.imageData!;
        });
      } else {
        drawPlantFallback(ctx, item.name, baseSize);
      }

      // Plant name labels intentionally omitted in exported image (clean presentation view).
      ctx.restore();
    }
  }

  // ─── 4. Info overlay (optional) ────────────────────────────────────────────
  if (includeInfoOverlay && clientName) {
    const pad = 16;
    const lineH = 22;
    const lines = [
      `📋 Proyecto: ${clientName}`,
      totalProjectCost ? `💰 Estimado: $${totalProjectCost.toLocaleString('es-MX')} MXN` : '',
      `🌿 Elementos: ${designItems.length} | Zonas: ${polygons.filter(p => p.closed).length}`,
    ].filter(Boolean);

    const boxH = lines.length * lineH + pad * 2;
    ctx.save();
    ctx.fillStyle = 'rgba(15,23,42,0.82)';
    roundRect(ctx, 16, 16, W * 0.42, boxH, 10);
    ctx.fill();
    ctx.fillStyle = '#f1f5f9';
    ctx.font = 'bold 13px system-ui, sans-serif';
    lines.forEach((line, i) => {
      ctx.fillText(line, pad + 16, 16 + pad + i * lineH + 4);
    });
    ctx.restore();
  }

  return out.toDataURL('image/png');
}

/**
 * Serialise all project data to a downloadable JSON blob.
 */
export function buildProjectJSON(params: {
  clientName: string;
  clientPhone?: string;
  clientAddress?: string;
  gardenImage: string | null;
  polygons: ExportPolygon[];
  designItems: DesignItem[];
  materialCosts: MaterialCost[];
  totalProjectCost: number;
  exportedAt?: string;
}): string {
  return JSON.stringify(
    {
      version: '2.0',
      exportedAt: params.exportedAt ?? new Date().toISOString(),
      client: {
        name: params.clientName,
        phone: params.clientPhone ?? '',
        address: params.clientAddress ?? '',
      },
      garden: {
        hasImage: !!params.gardenImage,
      },
      polygons: params.polygons
        .filter(p => p.closed)
        .map(p => ({
          id: p.id,
          materialId: p.materialId,
          aiApplied: p.aiApplied ?? false,
          areaM2: p.areaM2 ?? null,
          estimatedQty: p.estimatedQty ?? null,
          estimatedUnit: p.estimatedUnit ?? "m²",
          estimatedCost: p.estimatedCost ?? null,
          points: p.points,
        })),
      designItems: params.designItems.map(d => ({
        id: d.id,
        inventoryItemId: d.inventoryItemId,
        name: d.name,
        price: d.price,
        quantity: d.quantity ?? 1,
        x: d.x,
        y: d.y,
        scale: d.scale,
        rotation: d.rotation,
      })),
      costs: {
        designItemsTotal: params.designItems.reduce((s, d) => s + (d.price ?? 0), 0),
        materialCosts: params.materialCosts,
        totalProjectCost: params.totalProjectCost,
      },
    },
    null,
    2
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function drawPlantFallback(ctx: CanvasRenderingContext2D, name: string, size: number) {
  ctx.beginPath();
  ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(34,197,94,0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.font = `bold ${Math.max(9, size * 0.3)}px system-ui`;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.slice(0, 2).toUpperCase(), 0, 0);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
