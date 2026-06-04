/**
 * DesignEngine — Core design logic. ZERO AI dependency.
 *
 * Handles non-AI design operations:
 * - Flat material fills on polygons (CSS canvas patterns)
 * - Element placement, move, scale
 * - Design export to image
 */

import type { PolygonData } from "./polygon-manager";
import { getMaterial } from "./material-system";

export interface PlacedElement {
  id: string;
  type: "plant" | "decoration";
  label: string;
  emoji: string;
  x: number; // 0–1 relative to canvas width
  y: number; // 0–1 relative to canvas height
  scale: number; // 1 = default size
  rotation: number; // degrees
}

// ─── Flat Material Fill ────────────────────────────────────────────────────
/**
 * Apply a flat material fill to a polygon on a canvas.
 * No AI involved. Returns a new data URL with the fill applied.
 */
export function applyFlatFill(
  baseDataURL: string,
  polygon: PolygonData,
  canvasW: number,
  canvasH: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const mat = getMaterial(polygon.materialId);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = canvasW;
      c.height = canvasH;
      const ctx = c.getContext("2d")!;

      // Draw base image (contained)
      const scale = Math.min(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = (canvasW - dw) / 2;
      const dy = (canvasH - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);

      // Draw polygon fill
      if (polygon.points.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(polygon.points[0].x, polygon.points[0].y);
        for (let i = 1; i < polygon.points.length; i++) {
          ctx.lineTo(polygon.points[i].x, polygon.points[i].y);
        }
        ctx.closePath();

        // Flat fill — no AI
        ctx.fillStyle = mat.fillColor.replace(/[\d.]+\)$/, "0.55)"); // more opaque for render
        ctx.fill();

        // Stroke
        ctx.strokeStyle = mat.strokeColor;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      resolve(c.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = () => reject(new Error("No se pudo cargar la imagen base"));
    img.src = baseDataURL;
  });
}

/**
 * Apply all polygons as flat fills onto the base image.
 * Returns the composited image as a data URL.
 */
export async function applyAllFlatFills(
  baseDataURL: string,
  polygons: PolygonData[],
  canvasW: number,
  canvasH: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const closed = polygons.filter(p => p.closed && p.points.length >= 3);
    if (closed.length === 0) { resolve(baseDataURL); return; }

    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = canvasW;
      c.height = canvasH;
      const ctx = c.getContext("2d")!;

      // Base image
      const scale = Math.min(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = (canvasW - dw) / 2;
      const dy = (canvasH - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);

      // All polygon fills
      for (const poly of closed) {
        const mat = getMaterial(poly.materialId);
        ctx.beginPath();
        ctx.moveTo(poly.points[0].x, poly.points[0].y);
        for (let i = 1; i < poly.points.length; i++) ctx.lineTo(poly.points[i].x, poly.points[i].y);
        ctx.closePath();
        ctx.fillStyle = mat.fillColor.replace(/[\d.]+\)$/, "0.55)");
        ctx.fill();
        ctx.strokeStyle = mat.strokeColor;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      resolve(c.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = () => reject(new Error("No se pudo cargar imagen"));
    img.src = baseDataURL;
  });
}

// ─── Area Helpers ────────────────────────────────────────────────────────
export function formatArea(areaPx: number, pixelsPerMeter: number | null): string {
  if (!pixelsPerMeter || pixelsPerMeter <= 0) return `~${Math.round(areaPx / 1000)} u`;
  const m2 = areaPx / (pixelsPerMeter * pixelsPerMeter);
  return `${m2.toFixed(1)} m²`;
}

export function pixelAreaToM2(areaPx: number, pixelsPerMeter: number): number {
  return areaPx / (pixelsPerMeter * pixelsPerMeter);
}
