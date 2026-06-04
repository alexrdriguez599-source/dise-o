import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useMemo,
} from "react";
import html2canvas from "html2canvas";
import { useDeviceType, type DeviceType } from "@/hooks/use-device";
import { wavespeedPost } from "@/services/wavespeed-fetch";

// ── OpenCV.js tipos mínimos (cargado async via script en index.html) ──────────
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cv: any;
  }
}

// ── Plano de perspectiva del suelo ────────────────────────────────────────────
interface GroundPlanePoint { x: number; y: number; }
type GroundPlane = [GroundPlanePoint, GroundPlanePoint, GroundPlanePoint, GroundPlanePoint];

// ── Cache global de bounding-box ajustado al contenido opaco del PNG ──────────
// Valores en fracciones (0..1) del contenedor cuadrado, ya considerando object-contain.
type ContentBBox = { l: number; t: number; r: number; b: number };
const __contentBBoxCache = new Map<string, ContentBBox>();
const FULL_BBOX: ContentBBox = { l: 0, t: 0, r: 1, b: 1 };

function analyzeContentBBox(src: string): Promise<ContentBBox> {
  const cached = __contentBBoxCache.get(src);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      if (!W || !H) { __contentBBoxCache.set(src, FULL_BBOX); resolve(FULL_BBOX); return; }
      const MAX = 256;
      const scale = Math.min(1, MAX / Math.max(W, H));
      const cw = Math.max(1, Math.round(W * scale));
      const ch = Math.max(1, Math.round(H * scale));
      const canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) { __contentBBoxCache.set(src, FULL_BBOX); resolve(FULL_BBOX); return; }
      ctx.drawImage(img, 0, 0, cw, ch);
      let data: Uint8ClampedArray;
      try { data = ctx.getImageData(0, 0, cw, ch).data; }
      catch { __contentBBoxCache.set(src, FULL_BBOX); resolve(FULL_BBOX); return; }
      let minX = cw, minY = ch, maxX = -1, maxY = -1;
      const ALPHA = 24;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          if (data[(y * cw + x) * 4 + 3] > ALPHA) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) { __contentBBoxCache.set(src, FULL_BBOX); resolve(FULL_BBOX); return; }
      // Mapeo a fracciones del contenedor cuadrado considerando object-contain
      const aspect = cw / ch;
      let dispW: number, dispH: number, offX: number, offY: number;
      if (aspect >= 1) { dispW = 1; dispH = 1 / aspect; offX = 0; offY = (1 - dispH) / 2; }
      else             { dispH = 1; dispW = aspect;     offX = (1 - dispW) / 2; offY = 0; }
      const bbox: ContentBBox = {
        l: offX + (minX       / cw) * dispW,
        t: offY + (minY       / ch) * dispH,
        r: offX + ((maxX + 1) / cw) * dispW,
        b: offY + ((maxY + 1) / ch) * dispH,
      };
      __contentBBoxCache.set(src, bbox);
      resolve(bbox);
    };
    img.onerror = () => { __contentBBoxCache.set(src, FULL_BBOX); resolve(FULL_BBOX); };
    img.src = src;
  });
}

/** Espera a que OpenCV.js esté disponible en window.cv */
function waitForOpenCV(timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.cv && window.cv.Mat) { resolve(); return; }
    const start = Date.now();
    const check = setInterval(() => {
      if (window.cv && window.cv.Mat) { clearInterval(check); resolve(); return; }
      if (Date.now() - start > timeoutMs) { clearInterval(check); reject(new Error("OpenCV timeout")); }
    }, 50);
  });
}

/**
 * Detecta automáticamente el horizonte y define el plano del suelo.
 * Usa Canny + HoughLinesP para encontrar la línea de horizonte dominante.
 * Retorna el plano como 4 puntos (0–1 normalizados) y horizonY en %.
 */
async function autoDetectGroundPlane(
  imageEl: HTMLImageElement
): Promise<{ plane: GroundPlane; horizonYPct: number }> {
  await waitForOpenCV();
  const cv = window.cv;

  const src   = cv.imread(imageEl);
  const gray  = new cv.Mat();
  const edges = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.Canny(gray, edges, 50, 150);

  const lines = new cv.Mat();
  cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 80, 100, 50);

  const height = src.rows;
  let horizonY = height * 0.65; // fallback: 65% desde arriba

  for (let i = 0; i < lines.rows; i++) {
    const [x1, y1, x2, y2] = lines.data32S.slice(i * 4, i * 4 + 4);
    const angle = Math.abs(Math.atan2(y2 - y1, x2 - x1));
    if (angle < 0.2) {                       // casi horizontal
      const yAvg = (y1 + y2) / 2;
      if (yAvg < height * 0.8 && yAvg > height * 0.3) {
        horizonY = yAvg;
      }
    }
  }

  src.delete(); gray.delete(); edges.delete(); lines.delete();

  const horizonYPct = (horizonY / height) * 100;

  const plane: GroundPlane = [
    { x: 0.05, y: horizonY / height }, // esquina izq. atrás
    { x: 0.95, y: horizonY / height }, // esquina der. atrás
    { x: 0.98, y: 0.98 },              // esquina der. frente
    { x: 0.02, y: 0.98 },              // esquina izq. frente
  ];

  return { plane, horizonYPct };
}

/**
 * Mapea coordenadas lógicas del plano del suelo (u, v en 0–1)
 * a coordenadas de pantalla (x, y en 0–1) mediante interpolación bilineal.
 *   u = posición horizontal (0=izq, 1=der)
 *   v = profundidad (0=fondo/horizonte, 1=frente/primer plano)
 */
function mapToPerspective(u: number, v: number, plane: GroundPlane): GroundPlanePoint {
  const [p0, p1, p2, p3] = plane;
  return {
    x: (1 - u) * (1 - v) * p0.x + u * (1 - v) * p1.x + u * v * p2.x + (1 - u) * v * p3.x,
    y: (1 - u) * (1 - v) * p0.y + u * (1 - v) * p1.y + u * v * p2.y + (1 - u) * v * p3.y,
  };
}

/**
 * Calcula la escala de perspectiva calibrada al horizonte real detectado.
 *   yPct       = posición vertical del elemento (0–100)
 *   horizonYPct = posición del horizonte en % (detectada por OpenCV, default 65)
 * Resultado: 0.5 en el horizonte → 1.3 al frente
 */
function calcPerspectiveScale(yPct: number, horizonYPct: number): number {
  if (yPct <= horizonYPct) return 0.4; // zona cielo: escala mínima
  return 0.5 + ((yPct - horizonYPct) / (100 - horizonYPct)) * 0.8;
}
import {
  Camera,
  Image as ImageIcon,
  Loader2,
  Eraser,
  Ruler,
  Move,
  Trash2,
  RotateCcw,
  Leaf,
  Layers,
  Pentagon,
  GripVertical,
  Zap,
  X,
  Check,
  Settings,
  ChevronDown,
  DollarSign,
  Sparkles,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import CameraCapture from "@/components/camera-capture";
import { useAppContext, DesignItem } from "@/context/app-context";
import { loadTextures, getMaterialPattern } from "@/services/material-system";

export type CanvasMode = "items" | "mask" | "polygon" | "scale";

interface StrokePath {
  points: { x: number; y: number }[];
  size: number;
}

export interface DesignCanvasRef {
  handleApplyMaterial: (material: string) => Promise<void>;
  /** Combina el fondo (gardenImage con materiales) + todos los items del diseño
   *  en un solo canvas, listo para incluir en PDF o exportar. */
  buildCompositeImage: () => Promise<string | null>;
  /** Captura lo que el usuario ve en pantalla: usa el HTML5 canvas como fondo
   *  (con materiales ya aplicados) + dibuja items en canvas puro sin html2canvas.
   *  Si se pasa customBg, usa esa imagen como fondo en lugar de gardenImage
   *  (misma lógica de coordenadas — todos los items aparecen igual). */
  buildPresentationCapture: (customBg?: string) => Promise<string | null>;
  /** Captura SOLO el fondo (sin plantas/items) — para enviar a la IA sin que
   *  el modelo "corrija" los PNG de plantas. */
  buildBackgroundOnlyCapture: () => Promise<string | null>;
  /** Máscara binaria PNG de las plantas (negro = plantas, blanco = entorno).
   *  Mismas dimensiones que buildPresentationCapture. La IA inpaint usa esta
   *  máscara para regenerar SOLO el blanco (pasto, suelo, paredes) y dejar
   *  las plantas 100% intactas. */
  buildPlantMask: () => Promise<string | null>;
  /** Lista de nombres únicos de todos los items colocados en el diseño. */
  getDesignItemNames: () => string[];
  /** Dimensiones CSS actuales del contenedor del canvas (para compositing externo). */
  getContainerSize: () => { width: number; height: number } | null;
  /** horizonYPct actual (para calcPerspectiveScale en compositing externo). */
  getHorizonY: () => number;
}

export interface DesignCanvasProps {
  /** When true: read-only view — same container dimensions, no interactivity */
  readOnly?: boolean;
}

// ── Pure module-level helper ───────────────────────────────────────
// Computes where an image sits inside a canvas that uses CSS object-contain.
// All pixel sampling / drawing MUST use this rect so coords match what the user sees.
function getContainRect(natW: number, natH: number, cW: number, cH: number) {
  const scale = Math.min(cW / natW, cH / natH);
  const w = natW * scale, h = natH * scale;
  return { x: (cW - w) / 2, y: (cH - h) / 2, w, h };
}

function resizeCanvas(src: HTMLCanvasElement, maxDim: number): HTMLCanvasElement {
  const scale = Math.min(maxDim / src.width, maxDim / src.height, 1);
  if (scale >= 1) return src;
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  out.getContext("2d")!.drawImage(src, 0, 0, w, h);
  return out;
}

const AI_MAX = 1024;

// ─── Pixel-level green → soil transform ───────────────────────────────────────
/** Convierte píxeles verde-pasto a gravilla fina blanca en el canvas (in-place). */
function replaceGrassWithSoilCtx(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const noiseAt = (x: number, y: number, scale: number): number => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return (s - Math.floor(s)) * scale;
  };
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (g > 100 && g > r + 30 && g > b + 30) {
      const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      const px = (i / 4) % w, py = Math.floor((i / 4) / w);
      const n = (noiseAt(px, py, 28) - 14) + (noiseAt(px * 0.06, py * 0.06, 18) - 9);
      d[i]     = Math.min(255, Math.max(0, Math.round(195 + lum * 45 + n)));
      d[i + 1] = Math.min(255, Math.max(0, Math.round(190 + lum * 45 + n * 0.92)));
      d[i + 2] = Math.min(255, Math.max(0, Math.round(180 + lum * 45 + n * 0.78)));
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/** Variante async: acepta base64, aplica green→soil, devuelve base64. */
async function deGrassBase64Design(base64: string): Promise<string> {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("deGrass: imagen no cargó"));
    img.src = base64;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  replaceGrassWithSoilCtx(ctx, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.92);
}

function polygonAreaPx(pts: { x: number; y: number }[]): number {
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    sum += pts[i].x * pts[j].y;
    sum -= pts[j].x * pts[i].y;
  }
  return Math.abs(sum) / 2;
}

function buildPolygonMaskCanvas(
  pts: { x: number; y: number }[],
  w: number,
  h: number
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  if (pts.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.fill();
  }
  return c;
}

function computeMaskBBox(mask: HTMLCanvasElement, padding = 16): { x: number; y: number; w: number; h: number } | null {
  const ctx = mask.getContext("2d")!;
  const data = ctx.getImageData(0, 0, mask.width, mask.height).data;
  let minX = mask.width, minY = mask.height, maxX = 0, maxY = 0;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const i = (y * mask.width + x) * 4;
      if (data[i] > 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return null;
  const px = padding;
  const bx = Math.max(0, minX - px);
  const by = Math.max(0, minY - px);
  const bw = Math.min(mask.width, maxX + px + 1) - bx;
  const bh = Math.min(mask.height, maxY + px + 1) - by;
  return { x: bx, y: by, w: bw, h: bh };
}

function cropCanvas(src: HTMLCanvasElement, box: { x: number; y: number; w: number; h: number }): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = box.w; c.height = box.h;
  c.getContext("2d")!.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return c;
}

function featherMask(mask: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (radius <= 0) return mask;
  const c = document.createElement("canvas");
  c.width = mask.width; c.height = mask.height;
  const ctx = c.getContext("2d")!;
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(mask, 0, 0);
  ctx.filter = "none";
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const orig = mask.getContext("2d")!.getImageData(0, 0, mask.width, mask.height);
  for (let i = 0; i < d.data.length; i += 4) {
    if (orig.data[i] > 250) {
      d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
    }
    d.data[i + 3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

function dilateMask(mask: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (radius <= 0) return mask;
  const W = mask.width, H = mask.height;
  const src = mask.getContext("2d")!.getImageData(0, 0, W, H).data;
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d")!;
  const dst = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      let hit = false;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        for (let dx = -radius; dx <= radius && !hit; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            if (src[(ny * W + nx) * 4] > 128) hit = true;
          }
        }
      }
      const v = hit ? 255 : 0;
      dst.data[idx] = dst.data[idx + 1] = dst.data[idx + 2] = v;
      dst.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(dst, 0, 0);
  return out;
}

/**
 * forceTextureFill — Forced full-coverage pixel compositing.
 *
 * Rules (per spec):
 *   Phase 1 — Binarize mask: alpha > 0 → 255, else → 0. No intermediate values.
 *   Phase 2 — Align: mask drawn at exact W×H (same as original/AI).
 *   Phase 3 — For every pixel:
 *               if mask == 255 → result = AI×0.7 + texture×0.3  (or AI×1.0 if no texture)
 *               else           → result = original  (EXACT copy, no condition on AI content)
 *   Phase 4 — debugOverlay: overlay mask pixels in semi-transparent red for visual verification.
 *
 * NO "if pixel empty" / "if AI black" conditions. The mask is the ONLY decision gate.
 */
function forceTextureFill(
  original: HTMLCanvasElement,      // Full-frame image (AI space, e.g. 1024×422)
  aiResult: HTMLCanvasElement,      // AI output (cropped to bbox)
  mask: HTMLCanvasElement,          // Binary mask, same logical space as original
  bbox: { x: number; y: number; w: number; h: number },
  textureImg: HTMLImageElement | null,
  _featherRadius = 0,
  debugOverlay = false
): HTMLCanvasElement {
  const W = original.width, H = original.height;

  // ── Phase 2: Verify alignment ─────────────────────────────────────────────
  if (mask.width !== W || mask.height !== H) {
    console.warn(`[forceTextureFill] DIMENSION MISMATCH: original=${W}×${H} mask=${mask.width}×${mask.height} — rescaling mask`);
  }

  // ── Phase 1: Binarize mask — draw at W×H, then threshold every pixel ──────
  const bmC = document.createElement("canvas");
  bmC.width = W; bmC.height = H;
  const bmCtx = bmC.getContext("2d", { willReadFrequently: true })!;
  bmCtx.fillStyle = "#000";
  bmCtx.fillRect(0, 0, W, H);
  // Draw mask at exact output size (handles any bilinear interpolation at edges)
  bmCtx.drawImage(mask, 0, 0, W, H);
  const bmData = bmCtx.getImageData(0, 0, W, H);
  // Binarize: any non-zero R channel → 255; else → 0. Sets all channels + alpha.
  for (let i = 0; i < bmData.data.length; i += 4) {
    const v = bmData.data[i] > 0 ? 255 : 0;
    bmData.data[i] = bmData.data[i + 1] = bmData.data[i + 2] = v;
    bmData.data[i + 3] = 255;
  }
  // Write binarized mask back so the canvas is consistent with bmData
  bmCtx.putImageData(bmData, 0, 0);

  // ── AI result: stretch cropped bbox back to full W×H frame ────────────────
  const aiC = document.createElement("canvas");
  aiC.width = W; aiC.height = H;
  const aCtx = aiC.getContext("2d", { willReadFrequently: true })!;
  // Outside bbox: pixels remain (0,0,0,0) — they will ONLY be sampled when mask==255
  // and all mask==255 pixels are guaranteed to be inside bbox (computeMaskBBox wraps tightly)
  aCtx.drawImage(aiResult, 0, 0, aiResult.width, aiResult.height, bbox.x, bbox.y, bbox.w, bbox.h);
  const aiData = aCtx.getImageData(0, 0, W, H);

  // ── Tile texture across full frame (only sampled inside mask) ─────────────
  let texData: ImageData | null = null;
  if (textureImg) {
    const texC = document.createElement("canvas");
    texC.width = W; texC.height = H;
    const texCtx = texC.getContext("2d", { willReadFrequently: true })!;
    const tw = Math.max(1, textureImg.naturalWidth);
    const th = Math.max(1, textureImg.naturalHeight);
    for (let ty = 0; ty < H; ty += th) {
      for (let tx = 0; tx < W; tx += tw) {
        texCtx.drawImage(textureImg, tx, ty);
      }
    }
    texData = texCtx.getImageData(0, 0, W, H);
  }

  // ── Build output ──────────────────────────────────────────────────────────
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(original, 0, 0);
  const origData = ctx.getImageData(0, 0, W, H);
  const outData = ctx.createImageData(W, H);

  // ── Phase 3: Forced write — mask is the ONLY gate ─────────────────────────
  let totalMask = 0, covered = 0;
  for (let i = 0; i < origData.data.length; i += 4) {
    if (bmData.data[i] === 255) {
      // Inside mask: blend AI (70%) + texture (30%). If no texture → 100% AI.
      totalMask++;
      const ai_r = aiData.data[i],     ai_g = aiData.data[i + 1], ai_b = aiData.data[i + 2];
      const tx_r = texData ? texData.data[i]     : ai_r;
      const tx_g = texData ? texData.data[i + 1] : ai_g;
      const tx_b = texData ? texData.data[i + 2] : ai_b;
      outData.data[i]     = Math.round(ai_r * 0.7 + tx_r * 0.3);
      outData.data[i + 1] = Math.round(ai_g * 0.7 + tx_g * 0.3);
      outData.data[i + 2] = Math.round(ai_b * 0.7 + tx_b * 0.3);
      outData.data[i + 3] = 255;
      covered++;
    } else {
      // Outside mask: EXACT original — no condition on AI or pixel content
      outData.data[i]     = origData.data[i];
      outData.data[i + 1] = origData.data[i + 1];
      outData.data[i + 2] = origData.data[i + 2];
      outData.data[i + 3] = 255;
    }
  }
  ctx.putImageData(outData, 0, 0);

  // ── Phase 4: Debug overlay — mask rendered in red to verify coverage ───────
  if (debugOverlay) {
    const dbgData = ctx.createImageData(W, H);
    for (let i = 0; i < bmData.data.length; i += 4) {
      if (bmData.data[i] === 255) {
        // Semi-transparent red over mask area
        dbgData.data[i]     = 255;
        dbgData.data[i + 1] = 0;
        dbgData.data[i + 2] = 0;
        dbgData.data[i + 3] = 120;   // ~47% opacity
      }
      // Non-mask pixels: alpha = 0 → transparent (original shows through)
    }
    // Create a temporary canvas with the red overlay and composite it on top
    const dbgC = document.createElement("canvas");
    dbgC.width = W; dbgC.height = H;
    dbgC.getContext("2d")!.putImageData(dbgData, 0, 0);
    ctx.drawImage(dbgC, 0, 0);
  }

  const coverage = totalMask > 0 ? ((covered / totalMask) * 100).toFixed(1) : "0";
  console.log(
    `[forceTextureFill] ${W}×${H}  mask=${totalMask}px  covered=${covered}px  (${coverage}%)` +
    `  hasTexture=${!!texData}  debug=${debugOverlay}`
  );
  return out;
}

/**
 * compositePolygonClip — Pixel-perfect polygon fill using ctx.clip().
 *
 * Uses the browser's native canvas clipping (exact polygon path, sub-pixel
 * anti-aliased boundary). Guarantees 100% coverage of every pixel inside the
 * polygon with no dependency on mask binarization or pixel-by-pixel logic.
 *
 * Steps:
 *   1. Draw original image as base (everything outside polygon is untouched).
 *   2. ctx.clip() with the exact polygon path in AI space.
 *   3. drawImage(aiResult) stretched to bbox — only visible inside the clip.
 *   4. ctx.restore() — clip removed, original context intact.
 */
function compositePolygonClip(
  originalCanvas: HTMLCanvasElement,
  aiResultCanvas: HTMLCanvasElement,
  bbox: { x: number; y: number; w: number; h: number },
  polygonPtsAI: { x: number; y: number }[]
): HTMLCanvasElement {
  const W = originalCanvas.width, H = originalCanvas.height;
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d")!;

  ctx.drawImage(originalCanvas, 0, 0);

  if (polygonPtsAI.length < 3) return out;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(polygonPtsAI[0].x, polygonPtsAI[0].y);
  for (let i = 1; i < polygonPtsAI.length; i++) {
    ctx.lineTo(polygonPtsAI[i].x, polygonPtsAI[i].y);
  }
  ctx.closePath();
  ctx.clip();

  ctx.drawImage(
    aiResultCanvas,
    0, 0, aiResultCanvas.width, aiResultCanvas.height,
    bbox.x, bbox.y, bbox.w, bbox.h
  );

  ctx.restore();

  console.log(
    `[clipComposite] ${W}×${H}  polygon=${polygonPtsAI.length}pts` +
    `  bbox=${bbox.x},${bbox.y} ${bbox.w}×${bbox.h}` +
    `  aiResult=${aiResultCanvas.width}×${aiResultCanvas.height}`
  );
  return out;
}

function hardClipComposite(
  original: HTMLCanvasElement,
  aiResult: HTMLCanvasElement,
  mask: HTMLCanvasElement,
  bbox: { x: number; y: number; w: number; h: number },
  featherRadius = 3
): HTMLCanvasElement {
  const W = original.width, H = original.height;
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(original, 0, 0);

  const fullMask = document.createElement("canvas");
  fullMask.width = W; fullMask.height = H;
  const mCtx = fullMask.getContext("2d")!;
  mCtx.fillStyle = "#000";
  mCtx.fillRect(0, 0, W, H);
  mCtx.drawImage(mask, 0, 0);
  const feathered = featherMask(fullMask, featherRadius);

  const aiOnFull = document.createElement("canvas");
  aiOnFull.width = W; aiOnFull.height = H;
  const aCtx = aiOnFull.getContext("2d")!;
  aCtx.drawImage(aiResult, 0, 0, aiResult.width, aiResult.height, bbox.x, bbox.y, bbox.w, bbox.h);

  const origData = ctx.getImageData(0, 0, W, H);
  const aiData = aCtx.getImageData(0, 0, W, H);
  const maskData = feathered.getContext("2d")!.getImageData(0, 0, W, H);
  const outData = ctx.createImageData(W, H);

  for (let i = 0; i < origData.data.length; i += 4) {
    const alpha = maskData.data[i] / 255;
    outData.data[i]     = Math.round(aiData.data[i]     * alpha + origData.data[i]     * (1 - alpha));
    outData.data[i + 1] = Math.round(aiData.data[i + 1] * alpha + origData.data[i + 1] * (1 - alpha));
    outData.data[i + 2] = Math.round(aiData.data[i + 2] * alpha + origData.data[i + 2] * (1 - alpha));
    outData.data[i + 3] = 255;
  }

  ctx.putImageData(outData, 0, 0);
  return out;
}

interface TerrainMap {
  soil: HTMLCanvasElement;     // grayscale: white=soil, black=other (sent to AI as mask)
  overlay: HTMLCanvasElement;  // RGBA colored overlay for display
  soilPixels: number;
  imageAreaPx: number;         // actual image area (excludes letterbox bars)
  soilFraction: number;        // soilPixels / imageAreaPx
  soilM2: number | null;       // only set when pixelsPerMeter is calibrated
}

const DesignCanvas = forwardRef<DesignCanvasRef, DesignCanvasProps>(({ readOnly = false }, ref) => {
  const {
    gardenImage,
    setGardenImage,
    pushGardenImageToHistory,
    undoGardenImage,
    canUndo,
    imageHistoryCount,
    designItems,
    addDesignItem,
    updateDesignItem,
    removeDesignItem,
    pricePerM2,
    setPricePerM2,
    grassAreaM2,
    setGrassAreaM2,
    grassCost,
    materials,
    updateMaterial,
    activeMaterialId,
    setActiveMaterialId,
    addMaterialCost,
    materialCosts,
    clearMaterialCosts,
    totalMaterialCost,
    totalProjectCost,
  } = useAppContext();

  const { toast } = useToast();
  const deviceType = useDeviceType();

  const ui = useMemo(() => {
    const isTouch = deviceType !== "desktop";
    return {
      handleSize: isTouch ? 48 : 36,
      handleDotSize: isTouch ? 14 : 10,
      handleDotActiveSize: isTouch ? 18 : 14,
      rotateHandleSize: isTouch ? 48 : 36,
      rotateHandleDotSize: isTouch ? 26 : 20,
      rotateHandleDotActiveSize: isTouch ? 32 : 26,
      deleteButtonSize: isTouch ? 48 : 36,
      deleteIconSize: isTouch ? 30 : 24,
      rotateStalkHeight: isTouch ? 22 : 16,
      rotateStalkTop: isTouch ? "-52px" : "-42px",
      deleteOffset: isTouch ? "-22px" : "-16px",
      boundingBoxInset: isTouch ? "-8px" : "-5px",
      scaleHandleOffset: isTouch ? "-24px" : "-18px",
      isTouch,
    };
  }, [deviceType]);

  // Image source modal
  const [modalOpen, setModalOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState(false);

  // Tick para re-render cuando se calcula un nuevo content-bbox de un PNG
  const [, setBboxTick] = useState(0);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const texturePatternsRef = useRef<Map<string, CanvasPattern>>(new Map());

  // Mode
  const [mode, setMode] = useState<CanvasMode>("items");

  // ── Plano del suelo detectado por OpenCV ─────────────────────────────────
  const [groundPlane, setGroundPlane]   = useState<GroundPlane | null>(null);
  const [horizonYPct, setHorizonYPct]   = useState<number>(65); // default 65%
  const baseImgRef                       = useRef<HTMLImageElement | null>(null);

  // Mask strokes
  const [strokes, setStrokes] = useState<StrokePath[]>([]);
  const [currentStroke, setCurrentStroke] = useState<{ x: number; y: number }[]>([]);
  const [isPainting, setIsPainting] = useState(false);
  const [brushSize, setBrushSize] = useState(40);

  // Scale calibration
  const [scalePoints, setScalePoints] = useState<{ x: number; y: number }[]>([]);
  const [pixelsPerMeter, setPixelsPerMeter] = useState<number | null>(null);
  const [scaleDialogOpen, setScaleDialogOpen] = useState(false);
  const [distanceInput, setDistanceInput] = useState("");

  // Items interaction
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // Cuando se selecciona un item con imagen, dispara análisis de bbox si falta cache.
  useEffect(() => {
    if (!selectedItemId) return;
    const it = designItems.find((d) => d.id === selectedItemId);
    if (!it?.imageData) return;
    if (__contentBBoxCache.has(it.imageData)) return;
    let cancelled = false;
    analyzeContentBBox(it.imageData).then(() => { if (!cancelled) setBboxTick((t) => t + 1); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemId]);

  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [isDraggingItem, setIsDraggingItem] = useState(false);
  const [transformOp, setTransformOp] = useState<"move" | "scale" | "rotate" | null>(null);
  const [activeTransformOp, setActiveTransformOp] = useState<"move" | "scale" | "rotate" | null>(null);
  const [touchFeedbackId, setTouchFeedbackId] = useState<string | null>(null);
  const transformStart = useRef<{ x: number; y: number; scale: number; rotation: number; corner?: string }>({ x: 0, y: 0, scale: 1, rotation: 0 });
  const rafRef = useRef<number | null>(null);
  const pendingUpdate = useRef<Partial<import("../context/app-context").DesignItem> | null>(null);
  const velocityRef = useRef<{ vx: number; vy: number; lastX: number; lastY: number; lastTime: number }>({ vx: 0, vy: 0, lastX: 0, lastY: 0, lastTime: 0 });
  const inertiaRef = useRef<number | null>(null);
  // Alpha-channel hit-test cache: item.id → flat RGBA Uint8ClampedArray at 64×64
  const imageDataCache = useRef<Map<string, Uint8ClampedArray>>(new Map());

  // Processing
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingMsg, setProcessingMsg] = useState("");

  // Surface type detected in mask zone
  const [surfaceType, setSurfaceType] = useState<"soil" | "grass" | "concrete" | "unknown" | null>(null);

  // Auto terrain analysis
  const [terrainMap, setTerrainMap] = useState<TerrainMap | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);

  // Polygon tool
  const [polygonPoints, setPolygonPoints] = useState<{ x: number; y: number }[]>([]);
  const [polygonClosed, setPolygonClosed] = useState(false);
  const [draggingVertex, setDraggingVertex] = useState<number | null>(null);
  const [polygonSideDialog, setPolygonSideDialog] = useState(false);
  const [polygonSideInput, setPolygonSideInput] = useState("");
  const [polygonPxPerMeter, setPolygonPxPerMeter] = useState<number | null>(null);
  const [polygonMeasureSide, setPolygonMeasureSide] = useState<number | null>(null);

  // Materials config panel
  const [showMaterialsConfig, setShowMaterialsConfig] = useState(false);
  const [editingMaterialPrice, setEditingMaterialPrice] = useState<string | null>(null);
  const [materialPriceInput, setMaterialPriceInput] = useState("");
  const activeMaterial = materials.find(m => m.id === activeMaterialId && m.enabled) 
    || materials.find(m => m.enabled) 
    || materials[0];

  useEffect(() => {
    if (activeMaterialId && !materials.find(m => m.id === activeMaterialId && m.enabled)) {
      const firstEnabled = materials.find(m => m.enabled);
      if (firstEnabled) setActiveMaterialId(firstEnabled.id);
    }
  }, [materials, activeMaterialId, setActiveMaterialId]);

  // Obstacle removal (legacy — kept for inpaint brush flow)
  const [obstacleMask, setObstacleMask] = useState<HTMLCanvasElement | null>(null);
  const [obstacleOverlay, setObstacleOverlay] = useState<HTMLCanvasElement | null>(null);
  const [obstaclePreview, setObstaclePreview] = useState(false);
  const [obstacleCount, setObstacleCount] = useState(0);

  const obstacleOverlayUrl = useMemo(() => {
    if (!obstacleOverlay) return null;
    return obstacleOverlay.toDataURL("image/png");
  }, [obstacleOverlay]);


  // Price editing
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceInput, setPriceInput] = useState(String(pricePerM2));

  // ─── Phase 6: Debug visual ────────────────────────────────────
  // debugPt is STATE so drawCanvas re-runs on every input event and
  // the crosshair tracks the finger/mouse in real-time.
  // debugModeRef mirrors the state into a ref so touch/pointer handlers
  // can read the current value without stale-closure issues.
  const [debugMode, setDebugMode] = useState(false);
  const debugModeRef = useRef(false);
  debugModeRef.current = debugMode;
  const [debugPt, setDebugPt] = useState<{ x: number; y: number } | null>(null);

  // ── Alpha-channel image cache — se llena cuando cambian los design items ──
  useEffect(() => {
    const cache = imageDataCache.current;
    const SIZE  = 64;
    const currentIds = new Set(designItems.map(i => i.id));
    // Limpiar entradas obsoletas
    for (const k of cache.keys()) { if (!currentIds.has(k)) cache.delete(k); }
    // Cargar nuevas imágenes
    for (const item of designItems) {
      if (!item.imageData || cache.has(item.id)) continue;
      const img = new window.Image();
      img.onload = () => {
        try {
          const oc  = new OffscreenCanvas(SIZE, SIZE);
          const ctx = oc.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(img, 0, 0, SIZE, SIZE);
          cache.set(item.id, ctx.getImageData(0, 0, SIZE, SIZE).data);
        } catch { /* CORS / security — ignorar */ }
      };
      img.src = item.imageData;
    }
  }, [designItems]);

  // ── Línea de suelo — inclinación real del terreno ────────────────────────
  // leftY/rightY en [0–1]: altura normalizada del piso en el borde izq/der
  const [groundLine, setGroundLine] = useState({ leftY: 0.75, rightY: 0.75 });

  // Interpolación lineal: Y real del suelo en posición X normalizada [0–1]
  const getGroundY = useCallback(
    (xNorm: number): number => {
      const { leftY, rightY } = groundLine;
      return leftY + (rightY - leftY) * xNorm;
    },
    [groundLine]
  );

  // ── Render Final Profesional ──────────────────────────────────
  const [isRenderingFinal, setIsRenderingFinal] = useState(false);
  const [finalRenderUrl, setFinalRenderUrl] = useState<string | null>(null);
  const [showFinalRenderModal, setShowFinalRenderModal] = useState(false);

  const buildCompositeForRender = useCallback(async (): Promise<string> => {
    if (!gardenImage) throw new Error("Sin imagen base");
    const area = document.getElementById("canvas-container");
    if (!area) throw new Error("Canvas container no disponible");

    // ── FASE 1: Captura exacta del DOM — lo que ves = lo que se exporta ──────
    // Guarda y resetea estilos que interfieren con html2canvas
    const el = area as HTMLElement;
    const prevTransform       = el.style.transform;
    const prevTransformOrigin = el.style.transformOrigin;
    const prevOverflow        = el.style.overflow;

    el.style.transform       = "none";
    el.style.transformOrigin = "top left";
    // overflow se deja sin cambiar — captura EXACTA a lo que ve el usuario en pantalla

    const visW = el.offsetWidth;
    const visH = el.offsetHeight;

    let captured: HTMLCanvasElement;
    try {
      captured = await html2canvas(el, {
        useCORS:         true,
        scale:           2,
        backgroundColor: null,
        logging:         false,
        scrollX:         0,
        scrollY:         0,
        width:           visW,
        height:          visH,
        windowWidth:     visW,
        windowHeight:    visH,
      });
    } finally {
      el.style.transform       = prevTransform;
      el.style.transformOrigin = prevTransformOrigin;
      // prevOverflow no se toca — no se cambió
    }

    const W = captured.width;
    const H = captured.height;

    // ── FASE 2: Postproducción profesional en canvas separado ────────────────
    // (NO se aplica sobre el mismo canvas — se usa una copia para evitar taint)
    const post = document.createElement("canvas");
    post.width  = W;
    post.height = H;
    const pCtx = post.getContext("2d")!;
    pCtx.imageSmoothingEnabled = true;
    pCtx.imageSmoothingQuality = "high";

    // Corrección de color — mejora tipo fotografía profesional
    pCtx.filter = "contrast(1.08) brightness(1.03) saturate(1.06)";
    pCtx.drawImage(captured, 0, 0, W, H);
    pCtx.filter = "none";

    // Luz cálida tipo golden-hour / anuncio (rgba 255,220,150 a 6%)
    pCtx.fillStyle = "rgba(255, 220, 150, 0.06)";
    pCtx.fillRect(0, 0, W, H);

    // ── FASE 3: Unsharp mask — box-blur 3×3 real (sin CSS filter) ───────────
    // blur = promedio de los 9 vecinos; sharp = orig + strength × (orig − blur)
    const SHARPEN_STRENGTH = 0.40;
    const srcData = post.getContext("2d")!.getImageData(0, 0, W, H);
    const dstData = new ImageData(W, H);
    const s = srcData.data;
    const d = dstData.data;

    const get = (px: number, py: number, c: number): number => {
      px = Math.max(0, Math.min(W - 1, px));
      py = Math.max(0, Math.min(H - 1, py));
      return s[(py * W + px) * 4 + c];
    };

    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const idx = (py * W + px) * 4;
        for (let c = 0; c < 3; c++) {
          const orig = get(px, py, c);
          const blur = (
            get(px-1,py-1,c) + get(px,py-1,c) + get(px+1,py-1,c) +
            get(px-1,py,  c) + get(px,py,  c) + get(px+1,py,  c) +
            get(px-1,py+1,c) + get(px,py+1,c) + get(px+1,py+1,c)
          ) / 9;
          d[idx + c] = Math.max(0, Math.min(255, orig + SHARPEN_STRENGTH * (orig - blur)));
        }
        d[idx + 3] = s[idx + 3]; // alpha intacto
      }
    }

    // Micro-contraste final en canvas separado (evita taint de self-drawImage)
    const sharpened = document.createElement("canvas");
    sharpened.width  = W;
    sharpened.height = H;
    const sCtx = sharpened.getContext("2d")!;
    sCtx.putImageData(dstData, 0, 0);

    const output = document.createElement("canvas");
    output.width  = W;
    output.height = H;
    const oCtx = output.getContext("2d")!;
    oCtx.imageSmoothingEnabled = true;
    oCtx.imageSmoothingQuality = "high";
    oCtx.filter = "contrast(1.02)";
    oCtx.drawImage(sharpened, 0, 0, W, H);
    oCtx.filter = "none";

    // ── FASE 4: Exportación JPEG máxima calidad ──────────────────────────────
    return output.toDataURL("image/jpeg", 1.0);
  }, [gardenImage, designItems, horizonYPct, getGroundY]);

  // ── Máscara de protección para Render Final ──────────────────────────────
  // Negro = área editable (pasto/piedra/suelo), Blanco = zona protegida (plantas)
  // Convención flux-fill-dev: blanco=editar, negro=preservar → generamos en ese orden
  const buildProtectionMask = useCallback(async (W: number, H: number): Promise<string> => {
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = W;
    maskCanvas.height = H;
    const mCtx = maskCanvas.getContext("2d")!;

    // Fondo blanco = zona editable (grass/stone/soil — IA mejora aquí)
    mCtx.fillStyle = "#ffffff";
    mCtx.fillRect(0, 0, W, H);

    // Dibujar círculos NEGROS en cada elemento = zona protegida (preservar exacto)
    const BASE_SIZE_RENDER = 120;
    for (const item of designItems) {
      const s = item.scale ?? 1;
      const yPct = item.y ?? 50;
      const perspectiveScale = item.lockPosition ? 1.0 : calcPerspectiveScale(yPct, horizonYPct);
      const finalSize = BASE_SIZE_RENDER * s * perspectiveScale;
      const cx = (item.x / 100) * W;
      const cy = (item.y / 100) * H + (item.baseOffset ?? 0);
      const radius = finalSize * 0.65; // ligeramente mayor que el elemento

      mCtx.fillStyle = "#000000";
      mCtx.beginPath();
      mCtx.arc(cx, cy, radius, 0, Math.PI * 2);
      mCtx.fill();
    }

    return maskCanvas.toDataURL("image/png");
  }, [designItems, getGroundY]);

  const handleFinalRender = useCallback(async () => {
    if (!gardenImage) {
      toast({ title: "Sin imagen de diseño", description: "Sube una imagen de terreno primero.", variant: "destructive" });
      return;
    }
    setIsRenderingFinal(true);
    toast({ title: "🎨 Generando render profesional…", description: "Aplicando efectos fotográficos locales…", duration: 4000 });
    try {
      // Pipeline 100% local — sin IA generativa
      // Captura pixel-perfect + sombras + DOF + corrección de color + nitidez
      const compositeBase64 = await buildCompositeForRender();
      setFinalRenderUrl(compositeBase64);
      setShowFinalRenderModal(true);
    } catch (err) {
      toast({ title: "Error en Render Final", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsRenderingFinal(false);
    }
  }, [gardenImage, buildCompositeForRender, toast]);

  const downloadFinalRender = useCallback(() => {
    if (!finalRenderUrl) return;
    const a = document.createElement("a");
    a.href = finalRenderUrl;
    a.download = `render-final-${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [finalRenderUrl]);

  const saveFinalRenderToProject = useCallback(() => {
    if (!finalRenderUrl) return;
    pushGardenImageToHistory(finalRenderUrl);
    setShowFinalRenderModal(false);
    toast({ title: "✅ Render guardado", description: "La imagen se guardó como imagen principal del proyecto." });
  }, [finalRenderUrl, pushGardenImageToHistory, toast]);

  // ─── Canvas resize observer ───────────────────────────────────
  const syncCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    // Use getBoundingClientRect for sub-pixel accuracy; fall back to clientWidth
    const rect = container.getBoundingClientRect();
    const w = Math.round(rect.width) || container.clientWidth;
    const h = Math.round(rect.height) || container.clientHeight;
    if (!w || !h) return; // container not yet laid out — skip
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => syncCanvasSize());
    ro.observe(container);
    // Initial sync — may need one rAF for the browser to complete layout
    syncCanvasSize();
    const rafId = requestAnimationFrame(() => syncCanvasSize());
    return () => { ro.disconnect(); cancelAnimationFrame(rafId); };
  }, [syncCanvasSize]);

  // ─── Texture loader — conecta DesignCanvas al sistema de materiales ────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // loadTextures carga SVGs como HTMLImageElement (no crea CanvasPattern aquí).
    // getMaterialPattern crea patrones frescos con el ctx correcto cada vez.
    loadTextures(ctx);
    // Refrescar patrones cada 200 ms — el nuevo sistema detecta automáticamente
    // cuando un SVG carga (clave "tile" → "svg") y crea el patrón actualizado.
    const interval = setInterval(() => {
      const map = texturePatternsRef.current;
      let changed = false;
      materials.forEach(m => {
        try {
          const pat = getMaterialPattern(ctx, m.id);
          const prev = map.get(m.id);
          if (prev !== pat) { map.set(m.id, pat); changed = true; }
        } catch { /* aún cargando — se reintentará */ }
      });
      if (changed) requestAnimationFrame(drawCanvas);
    }, 200);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials]);

  // ─── Canvas draw ──────────────────────────────────────────────
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw terrain overlay (auto-detected zones)
    if (showOverlay && terrainMap?.overlay) {
      ctx.drawImage(terrainMap.overlay, 0, 0);
    }

    // ── Resolver textura del material activo ─────────────────────────────────
    // textureKey: usa el ID del material activo; fallback → verde UI neutro.
    const _activeMat = activeMaterialId;
    const _texturePattern = _activeMat
      ? (texturePatternsRef.current.get(_activeMat) ?? null)
      : null;
    const _maskFill   = _texturePattern ?? "rgba(34, 197, 94, 0.55)";
    const _polyFill   = _texturePattern ?? "rgba(34, 197, 94, 0.18)";
    if (_activeMat) {
      console.log("[DesignCanvas] material activo:", _activeMat, "patrón cargado:", !!_texturePattern);
    }

    // Draw completed strokes + current stroke
    const allStrokes: StrokePath[] = [
      ...strokes,
      ...(currentStroke.length > 0 ? [{ points: currentStroke, size: brushSize }] : []),
    ];

    for (const stroke of allStrokes) {
      if (stroke.points.length === 0) continue;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(34, 197, 94, 0.55)";
      ctx.fillStyle = _maskFill;
      ctx.globalAlpha = _texturePattern ? 0.75 : 1;
      ctx.lineWidth = stroke.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const pts = stroke.points;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Draw polygon area
    if (polygonPoints.length > 0) {
      ctx.beginPath();
      ctx.moveTo(polygonPoints[0].x, polygonPoints[0].y);
      for (let i = 1; i < polygonPoints.length; i++) ctx.lineTo(polygonPoints[i].x, polygonPoints[i].y);
      if (polygonClosed) {
        ctx.closePath();
        ctx.fillStyle = _polyFill;
        ctx.globalAlpha = _texturePattern ? 0.85 : 0.18;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = "rgba(34, 197, 94, 0.85)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      ctx.stroke();

      // Draw vertices
      polygonPoints.forEach((pt, i) => {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 && !polygonClosed && polygonPoints.length >= 3 ? "#f59e0b" : "#22c55e";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), pt.x, pt.y);
      });

      // Side labels (distances)
      if (polygonPxPerMeter && polygonPoints.length >= 2) {
        const pts = polygonClosed ? [...polygonPoints, polygonPoints[0]] : polygonPoints;
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) / polygonPxPerMeter;
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          ctx.fillStyle = "rgba(0,0,0,0.75)";
          ctx.fillRect(mx - 26, my - 10, 52, 20);
          ctx.fillStyle = "#fff";
          ctx.font = "bold 11px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(`${dist.toFixed(1)}m`, mx, my);
        }
      }

      // Area label in center
      if (polygonClosed && polygonPoints.length >= 3) {
        const areaPx = polygonAreaPx(polygonPoints);
        const ppm = polygonPxPerMeter ?? pixelsPerMeter;
        if (ppm) {
          const areaM2 = areaPx / (ppm * ppm);
          const cx = polygonPoints.reduce((s, p) => s + p.x, 0) / polygonPoints.length;
          const cy = polygonPoints.reduce((s, p) => s + p.y, 0) / polygonPoints.length;
          const label = `${areaM2.toFixed(1)} m²`;
          const costLabel = pricePerM2 > 0 ? `$${(areaM2 * pricePerM2).toLocaleString()}` : "";
          ctx.fillStyle = "rgba(0,0,0,0.8)";
          ctx.fillRect(cx - 55, cy - 22, 110, costLabel ? 44 : 28);
          ctx.fillStyle = "#fff";
          ctx.font = "bold 14px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, cx, cy - 6);
          if (costLabel) {
            ctx.font = "bold 13px sans-serif";
            ctx.fillStyle = "#a3e635";
            ctx.fillText(costLabel, cx, cy + 14);
          }
        }
      }
    }

    // Phase 6 — Debug dot: confirm coordinates hit exactly where input was.
    // Uses debugPt STATE (not a ref) so the overlay re-renders on every move.
    if (debugMode && debugPt) {
      const { x, y } = debugPt;
      ctx.save();
      // Red outer ring
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,0,0,0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
      // Solid center dot (5×5 fillRect as spec'd)
      ctx.fillStyle = "rgba(255, 50, 50, 1)";
      ctx.fillRect(x - 2, y - 2, 5, 5);
      // Crosshair lines for precise visual alignment
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255,50,50,0.8)";
      ctx.lineWidth = 1;
      ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y);
      ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10);
      ctx.stroke();
      ctx.restore();
    }

    // Draw scale points and line — ONLY when actively in scale/calibration mode
    if (mode === "scale" && scalePoints.length > 0) {
      ctx.fillStyle = "#10b981";
      scalePoints.forEach((pt, i) => {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), pt.x, pt.y);
        ctx.fillStyle = "#10b981";
      });

      if (scalePoints.length === 2) {
        ctx.beginPath();
        ctx.strokeStyle = "#10b981";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.moveTo(scalePoints[0].x, scalePoints[0].y);
        ctx.lineTo(scalePoints[1].x, scalePoints[1].y);
        ctx.stroke();
        ctx.setLineDash([]);

        if (pixelsPerMeter) {
          const dx = scalePoints[1].x - scalePoints[0].x;
          const dy = scalePoints[1].y - scalePoints[0].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const meters = dist / pixelsPerMeter;
          const midX = (scalePoints[0].x + scalePoints[1].x) / 2;
          const midY = (scalePoints[0].y + scalePoints[1].y) / 2;
          ctx.fillStyle = "rgba(0,0,0,0.75)";
          ctx.fillRect(midX - 38, midY - 14, 76, 24);
          ctx.fillStyle = "#fff";
          ctx.font = "bold 12px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(`${meters.toFixed(1)} m`, midX, midY);
        }
      }
    }
  }, [strokes, currentStroke, brushSize, scalePoints, pixelsPerMeter, showOverlay, terrainMap, polygonPoints, polygonClosed, polygonPxPerMeter, pricePerM2, debugMode, debugPt, activeMaterialId, mode]);

  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  // ─── Mask helpers ─────────────────────────────────────────────
  const getMaskDataUrl = (): string | null => {
    if (strokes.length === 0) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext("2d");
    if (!ctx) return null;

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, off.width, off.height);

    for (const stroke of strokes) {
      if (stroke.points.length === 0) continue;
      ctx.beginPath();
      ctx.strokeStyle = "#fff";
      ctx.fillStyle = "#fff";
      ctx.lineWidth = stroke.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const pts = stroke.points;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    return off.toDataURL("image/png");
  };

  const getMaskAreaM2 = (): number | null => {
    if (!pixelsPerMeter || strokes.length === 0) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, off.width, off.height);

    for (const stroke of strokes) {
      if (stroke.points.length === 0) continue;
      ctx.beginPath();
      ctx.strokeStyle = "#fff";
      ctx.fillStyle = "#fff";
      ctx.lineWidth = stroke.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const pts = stroke.points;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    const data = ctx.getImageData(0, 0, off.width, off.height).data;
    let white = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 128) white++;
    return Math.max(0.1, white / (pixelsPerMeter * pixelsPerMeter));
  };

  // ─── Auto terrain analysis ────────────────────────────────────
  // Classifies every pixel in the image: soil / concrete / grass / other.
  // Runs automatically when gardenImage changes.
  const analyzeTerrainAuto = useCallback((imageSrc: string, pxPerM: number | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.width, H = canvas.height;
    if (W === 0 || H === 0) return;

    const img = new Image();
    img.onload = () => {
      const cr = getContainRect(img.naturalWidth, img.naturalHeight, W, H);

      // Render image with object-contain layout
      const base = document.createElement("canvas");
      base.width = W; base.height = H;
      const bCtx = base.getContext("2d", { willReadFrequently: true })!;
      bCtx.fillStyle = "#000";
      bCtx.fillRect(0, 0, W, H);
      bCtx.drawImage(img, cr.x, cr.y, cr.w, cr.h);
      const imgData = bCtx.getImageData(0, 0, W, H);

      // Allocate output canvases
      const soilOff = document.createElement("canvas");
      soilOff.width = W; soilOff.height = H;
      const soilCtx = soilOff.getContext("2d")!;
      const soilData = soilCtx.createImageData(W, H);

      const overlayOff = document.createElement("canvas");
      overlayOff.width = W; overlayOff.height = H;
      const overlayCtx = overlayOff.getContext("2d")!;
      const overlayData = overlayCtx.createImageData(W, H);

      let soilPixels = 0;
      const imageAreaPx = Math.round(cr.w * cr.h);

      for (let pi = 0; pi < imgData.data.length; pi += 4) {
        const idx = pi / 4;
        const px = idx % W, py = Math.floor(idx / W);
        const inImage = px >= cr.x && px < cr.x + cr.w && py >= cr.y && py < cr.y + cr.h;

        if (!inImage) {
          // Letterbox area → black mask, transparent overlay
          soilData.data[pi + 3] = 255;
          overlayData.data[pi + 3] = 0;
          continue;
        }

        const r = imgData.data[pi], g = imgData.data[pi + 1], b = imgData.data[pi + 2];
        const brightness = (r + g + b) / 3;
        const grayDiff = Math.max(Math.abs(r - g), Math.abs(r - b), Math.abs(g - b));

        const isConcrete   = grayDiff < 22 && brightness > 145;
        const isGrass      = g > r * 1.18 && g > b * 1.12 && g > 60;
        const isBrightWhite = brightness > 215 && grayDiff < 30;
        const isSoil       = !isConcrete && !isGrass && !isBrightWhite;

        if (isSoil) {
          soilPixels++;
          soilData.data[pi] = soilData.data[pi + 1] = soilData.data[pi + 2] = 255;
          soilData.data[pi + 3] = 255;
          // Green semi-transparent overlay
          overlayData.data[pi]     = 34;
          overlayData.data[pi + 1] = 197;
          overlayData.data[pi + 2] = 94;
          overlayData.data[pi + 3] = 90;
        } else if (isConcrete) {
          soilData.data[pi + 3] = 255; // black mask
          // Gray overlay for concrete
          overlayData.data[pi]     = 156;
          overlayData.data[pi + 1] = 163;
          overlayData.data[pi + 2] = 175;
          overlayData.data[pi + 3] = 55;
        } else {
          soilData.data[pi + 3] = 255; // black mask
          overlayData.data[pi + 3] = 0; // transparent (grass / other)
        }
      }

      soilCtx.putImageData(soilData, 0, 0);
      overlayCtx.putImageData(overlayData, 0, 0);

      const soilFraction = imageAreaPx > 0 ? soilPixels / imageAreaPx : 0;
      const soilM2 = pxPerM ? soilPixels / (pxPerM * pxPerM) : null;

      console.log(`[terrain] soil=${soilPixels}/${imageAreaPx} (${Math.round(soilFraction * 100)}%) soilM2=${soilM2?.toFixed(1) ?? "n/a"}`);
      setTerrainMap({ soil: soilOff, overlay: overlayOff, soilPixels, imageAreaPx, soilFraction, soilM2 });
    };
    img.src = imageSrc;
  }, []);

  // Trigger auto-analysis whenever a new garden image is loaded
  useEffect(() => {
    if (!gardenImage) { setTerrainMap(null); return; }
    setObstacleMask(null);
    setObstacleOverlay(null);
    setObstaclePreview(false);
    setObstacleCount(0);
    const timer = setTimeout(() => analyzeTerrainAuto(gardenImage, pixelsPerMeter), 200);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gardenImage]);

  // ── Auto-detectar plano del suelo con OpenCV cuando carga una imagen ────────
  useEffect(() => {
    if (!gardenImage) { setGroundPlane(null); setHorizonYPct(65); return; }

    let cancelled = false;
    const img = new Image();
    img.onload = async () => {
      if (cancelled) return;
      baseImgRef.current = img;
      try {
        const { plane, horizonYPct: h } = await autoDetectGroundPlane(img);
        if (!cancelled) {
          setGroundPlane(plane);
          setHorizonYPct(h);
          console.log(`[OpenCV] Horizonte detectado en ${h.toFixed(1)}% — plano del suelo listo`);
        }
      } catch {
        // OpenCV no disponible aún o imagen problemática — usar fallback 65%
        if (!cancelled) { setGroundPlane(null); setHorizonYPct(65); }
      }
    };
    img.src = gardenImage;
    return () => { cancelled = true; };
  }, [gardenImage]);

  // Re-compute soilM2 when calibration changes
  useEffect(() => {
    if (!terrainMap || !pixelsPerMeter) return;
    setTerrainMap((prev) =>
      prev ? { ...prev, soilM2: prev.soilPixels / (pixelsPerMeter * pixelsPerMeter) } : prev
    );
  }, [pixelsPerMeter]);

  // ─── Render garden image at AI-safe resolution ────────────────
  // Returns a JPEG ≤ AI_MAX on each side (1024px). Also returns the
  // actual output dimensions so the mask can be resized to match.
  const getCanvasImageForAI = useCallback((): Promise<{ base64: string; w: number; h: number }> => {
    return new Promise((resolve, reject) => {
      const canvas = canvasRef.current;
      if (!canvas || !gardenImage) { reject(new Error("No image")); return; }
      const W = canvas.width, H = canvas.height;
      const img = new Image();
      img.onload = () => {
        // Full canvas render
        const full = document.createElement("canvas");
        full.width = W; full.height = H;
        const fCtx = full.getContext("2d")!;
        const cr = getContainRect(img.naturalWidth, img.naturalHeight, W, H);
        fCtx.fillStyle = "#000";
        fCtx.fillRect(0, 0, W, H);
        fCtx.drawImage(img, cr.x, cr.y, cr.w, cr.h);
        // Downscale if needed
        const resized = resizeCanvas(full, AI_MAX);
        console.log(`[getCanvasImageForAI] canvas=${W}x${H} → AI=${resized.width}x${resized.height}`);
        resolve({ base64: resized.toDataURL("image/jpeg", 0.90), w: resized.width, h: resized.height });
      };
      img.onerror = () => reject(new Error("Cannot render garden image"));
      img.src = gardenImage;
    });
  }, [gardenImage]);

  // ─── Surface detection ────────────────────────────────────────
  // Samples the original image pixels inside the mask and classifies surface type
  const detectSurface = useCallback(
    (imageSrc: string): Promise<"soil" | "grass" | "concrete" | "unknown"> => {
      return new Promise((resolve) => {
        if (strokes.length === 0) { resolve("unknown"); return; }
        const canvas = canvasRef.current;
        if (!canvas) { resolve("unknown"); return; }

        const off = document.createElement("canvas");
        off.width = canvas.width;
        off.height = canvas.height;
        const ctx = off.getContext("2d", { willReadFrequently: true });
        if (!ctx) { resolve("unknown"); return; }

        // Render mask in offscreen
        const maskOff = document.createElement("canvas");
        maskOff.width = canvas.width;
        maskOff.height = canvas.height;
        const mCtx = maskOff.getContext("2d", { willReadFrequently: true });
        if (!mCtx) { resolve("unknown"); return; }
        mCtx.fillStyle = "#000";
        mCtx.fillRect(0, 0, maskOff.width, maskOff.height);
        for (const stroke of strokes) {
          if (!stroke.points.length) continue;
          mCtx.beginPath();
          mCtx.strokeStyle = "#fff";
          mCtx.fillStyle = "#fff";
          mCtx.lineWidth = stroke.size;
          mCtx.lineCap = "round";
          mCtx.lineJoin = "round";
          const pts = stroke.points;
          mCtx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) mCtx.lineTo(pts[i].x, pts[i].y);
          mCtx.stroke();
          mCtx.beginPath();
          mCtx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2);
          mCtx.fill();
        }
        const maskData = mCtx.getImageData(0, 0, maskOff.width, maskOff.height);

        const img = new Image();
        img.onload = () => {
          const cr = getContainRect(img.naturalWidth, img.naturalHeight, off.width, off.height);
          ctx.drawImage(img, cr.x, cr.y, cr.w, cr.h);
          const imgData = ctx.getImageData(0, 0, off.width, off.height);
          let rSum = 0, gSum = 0, bSum = 0, count = 0;
          for (let i = 0; i < maskData.data.length; i += 4) {
            if (maskData.data[i] > 128) {
              rSum += imgData.data[i];
              gSum += imgData.data[i + 1];
              bSum += imgData.data[i + 2];
              count++;
            }
          }
          if (count === 0) { resolve("unknown"); return; }
          const r = rSum / count, g = gSum / count, b = bSum / count;
          const brightness = (r + g + b) / 3;
          const grayDiff = Math.max(Math.abs(r - g), Math.abs(r - b), Math.abs(g - b));
          // Must match thresholds in soilFilterMask exactly
          const isGreenish = g > r * 1.18 && g > b * 1.12 && g > 60;
          const isGrayish  = grayDiff < 22 && brightness > 145;
          if (isGreenish) resolve("grass");
          else if (isGrayish) resolve("concrete");
          else resolve("soil");
        };
        img.onerror = () => resolve("unknown");
        img.src = imageSrc;
      });
    },
    [strokes]
  );

  // ═══════════════════════════════════════════════════════════════
  // BOUNDING-BOX PIPELINE — strict image processing control
  // The AI NEVER sees the full image. Only the cropped bbox is sent.
  // Results are pasted back at pixel-exact coordinates.
  // ═══════════════════════════════════════════════════════════════

  // 1. Build full-resolution mask canvas from user strokes (white=painted, black=rest)
  const buildMaskCanvas = useCallback((): HTMLCanvasElement | null => {
    if (strokes.length === 0) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const W = canvas.width, H = canvas.height;
    const off = document.createElement("canvas");
    off.width = W; off.height = H;
    const ctx = off.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    for (const stroke of strokes) {
      if (!stroke.points.length) continue;
      ctx.beginPath();
      ctx.strokeStyle = "#fff"; ctx.fillStyle = "#fff";
      ctx.lineWidth = stroke.size; ctx.lineCap = "round"; ctx.lineJoin = "round";
      const pts = stroke.points;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2); ctx.fill();
    }
    return off;
  }, [strokes]);

  // 2. Find the tight bounding box of white pixels (+ padding)
  const getMaskBBox = useCallback((
    maskCanvas: HTMLCanvasElement,
    padding = 24
  ): { x: number; y: number; w: number; h: number } | null => {
    const W = maskCanvas.width, H = maskCanvas.height;
    const ctx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
    const data = ctx.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4] > 128) {
          if (x < minX) minX = x; if (y < minY) minY = y;
          if (x > maxX) maxX = x; if (y > maxY) maxY = y;
          found = true;
        }
      }
    }
    if (!found) return null;
    const x = Math.max(0, minX - padding);
    const y = Math.max(0, minY - padding);
    const w = Math.min(W, maxX + padding + 1) - x;
    const h = Math.min(H, maxY + padding + 1) - y;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }, []);

  // 3. Crop the image to bbox coordinates — returns a small data URL (what AI receives)
  const cropImageToBBox = useCallback((
    imageSrc: string,
    bbox: { x: number; y: number; w: number; h: number }
  ): Promise<string> => {
    return new Promise((resolve, reject) => {
      const canvas = canvasRef.current;
      if (!canvas) { reject(new Error("No canvas")); return; }
      const img = new Image();
      img.onload = () => {
        const c = canvasRef.current;
        if (!c) { reject(new Error("No canvas for crop")); return; }
        const W = c.width, H = c.height;
        // First render at full canvas size with object-contain alignment
        const fullOff = document.createElement("canvas");
        fullOff.width = W; fullOff.height = H;
        const fullCtx = fullOff.getContext("2d")!;
        const cr = getContainRect(img.naturalWidth, img.naturalHeight, W, H);
        fullCtx.drawImage(img, cr.x, cr.y, cr.w, cr.h);
        // Then crop to bbox from the full canvas
        const off = document.createElement("canvas");
        off.width = bbox.w; off.height = bbox.h;
        const ctx = off.getContext("2d")!;
        ctx.drawImage(fullOff, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
        resolve(off.toDataURL("image/jpeg", 0.95));
      };
      img.onerror = () => reject(new Error("Cannot load image for crop"));
      img.src = imageSrc;
    });
  }, []);

  // 4. Crop a mask canvas to bbox — returns small PNG data URL
  const cropMaskToBBox = useCallback((
    maskCanvas: HTMLCanvasElement,
    bbox: { x: number; y: number; w: number; h: number }
  ): string => {
    const off = document.createElement("canvas");
    off.width = bbox.w; off.height = bbox.h;
    const ctx = off.getContext("2d")!;
    ctx.drawImage(maskCanvas, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
    return off.toDataURL("image/png");
  }, []);

  // 5. Soil filter: keep only pixels that look like dirt (not concrete / grass / tiles)
  //    Returns a new FULL-SIZE mask canvas, or null if no soil found.
  const soilFilterMask = useCallback((
    imageSrc: string,
    maskCanvas: HTMLCanvasElement
  ): Promise<{ canvas: HTMLCanvasElement; soilCount: number; totalCount: number } | null> => {
    return new Promise((resolve) => {
      const W = maskCanvas.width, H = maskCanvas.height;
      const mCtx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
      const maskData = mCtx.getImageData(0, 0, W, H);
      const img = new Image();
      img.onload = () => {
        const imgOff = document.createElement("canvas");
        imgOff.width = W; imgOff.height = H;
        const iCtx = imgOff.getContext("2d", { willReadFrequently: true })!;
        // Draw image with same object-contain layout as the CSS display
        const cr = getContainRect(img.naturalWidth, img.naturalHeight, W, H);
        iCtx.drawImage(img, cr.x, cr.y, cr.w, cr.h);
        const imgData = iCtx.getImageData(0, 0, W, H);

        const resultOff = document.createElement("canvas");
        resultOff.width = W; resultOff.height = H;
        const rCtx = resultOff.getContext("2d")!;
        const outData = rCtx.createImageData(W, H);

        let soilCount = 0, totalCount = 0;
        let dbGrass = 0, dbBright = 0;
        for (let i = 0; i < maskData.data.length; i += 4) {
          let isSoil = false;
          if (maskData.data[i] > 128) {
            totalCount++;
            const r = imgData.data[i], g = imgData.data[i + 1], b = imgData.data[i + 2];
            const brightness = (r + g + b) / 3;
            const grayDiff = Math.max(Math.abs(r - g), Math.abs(r - b), Math.abs(g - b));
            // Terreno limpiado por IA puede tener grises y cafés variados.
            // Solo excluimos: pasto verde claro y blanco puro — todo lo demás es apto.
            // Existing grass: clearly green channel dominant AND saturated
            const isGrass    = g > r * 1.25 && g > b * 1.2 && g > 80 && (g - Math.max(r, b)) > 25;
            // Near-white surfaces (white tiles, painted white — not beige or gray soil)
            const isBrightWhite = brightness > 230 && grayDiff < 15;
            isSoil = !isGrass && !isBrightWhite;
            if (isSoil) soilCount++;
            else if (isGrass) dbGrass++;
            else dbBright++;
          }
          const val = isSoil ? 255 : 0;
          outData.data[i] = outData.data[i + 1] = outData.data[i + 2] = val;
          outData.data[i + 3] = 255;
        }
        console.log(`[soil-filter] total=${totalCount} soil=${soilCount} grass=${dbGrass} bright=${dbBright}`);
        // Require at least 1% of masked pixels to be soil
        if (soilCount === 0 || soilCount / Math.max(totalCount, 1) < 0.01) { resolve(null); return; }
        rCtx.putImageData(outData, 0, 0);
        resolve({ canvas: resultOff, soilCount, totalCount });
      };
      img.onerror = () => resolve(null);
      img.src = imageSrc;
    });
  }, []);

  // 6. Paste the cropped AI result back at EXACT bbox position.
  //    Only pixels that are white in maskCanvas are replaced — everything else stays original.
  //    No scaling of the final image. No bleed outside the mask.
  const pasteAtBBox = useCallback((
    originalSrc: string,
    croppedResultSrc: string,
    bbox: { x: number; y: number; w: number; h: number },
    maskCanvas: HTMLCanvasElement
  ): Promise<string> => {
    return new Promise((resolve, reject) => {
      const canvas = canvasRef.current;
      if (!canvas) { resolve(croppedResultSrc); return; }
      const W = canvas.width, H = canvas.height;

      const origImg = new Image(), resImg = new Image();
      let loaded = 0;
      const onLoad = () => {
        loaded++;
        if (loaded < 2) return;

        // Full original — draw with object-contain to match the CSS display
        const off = document.createElement("canvas");
        off.width = W; off.height = H;
        const ctx = off.getContext("2d", { willReadFrequently: true })!;
        const cr = getContainRect(origImg.naturalWidth, origImg.naturalHeight, W, H);
        ctx.drawImage(origImg, cr.x, cr.y, cr.w, cr.h);
        const origData = ctx.getImageData(0, 0, W, H);

        // Full mask
        const mCtx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
        const maskData = mCtx.getImageData(0, 0, W, H);

        // Cropped result (at bbox size — no resizing)
        const resOff = document.createElement("canvas");
        resOff.width = bbox.w; resOff.height = bbox.h;
        const resCtx = resOff.getContext("2d", { willReadFrequently: true })!;
        resCtx.drawImage(resImg, 0, 0, bbox.w, bbox.h);
        const resData = resCtx.getImageData(0, 0, bbox.w, bbox.h);

        // Start with original, paste only masked pixels from result
        const outData = ctx.createImageData(W, H);
        for (let i = 0; i < origData.data.length; i++) outData.data[i] = origData.data[i];

        let pastedCount = 0;
        for (let row = 0; row < bbox.h; row++) {
          for (let col = 0; col < bbox.w; col++) {
            const fx = bbox.x + col, fy = bbox.y + row;
            if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
            const fi = (fy * W + fx) * 4;
            if (maskData.data[fi] > 128) {
              const ri = (row * bbox.w + col) * 4;
              outData.data[fi]     = resData.data[ri];
              outData.data[fi + 1] = resData.data[ri + 1];
              outData.data[fi + 2] = resData.data[ri + 2];
              outData.data[fi + 3] = 255;
              pastedCount++;
            }
          }
        }
        console.log(`[pasteAtBBox] canvas=${W}×${H} bbox=${bbox.w}×${bbox.h}@(${bbox.x},${bbox.y}) maskCanvas=${maskCanvas.width}×${maskCanvas.height} resultImg=${resImg.naturalWidth}×${resImg.naturalHeight} pasted=${pastedCount}px`);
        ctx.putImageData(outData, 0, 0);
        resolve(off.toDataURL("image/jpeg", 0.95));
      };
      origImg.onerror = resImg.onerror = () => reject(new Error("Image load failed in pasteAtBBox"));
      origImg.onload = resImg.onload = onLoad;
      origImg.src = originalSrc;
      resImg.src = croppedResultSrc;
    });
  }, []);

  // Auto-detect surface type when user stops painting
  useEffect(() => {
    if (!gardenImage || strokes.length === 0) {
      setSurfaceType(null);
      return;
    }
    const timer = setTimeout(async () => {
      const t = await detectSurface(gardenImage);
      setSurfaceType(t);
    }, 700);
    return () => clearTimeout(timer);
  }, [strokes, gardenImage, detectSurface]);

  // ═══════════════════════════════════════════════════════════════
  // COORDINATE NORMALIZATION — single source of truth
  // Phase 1: rect = canvas.getBoundingClientRect()
  // Phase 2: scaleX = canvas.width / rect.width
  // Phase 3: x = (clientX - rect.left) * scaleX
  // Works for mouse, pointer, and touch events.
  // ═══════════════════════════════════════════════════════════════

  /** Phase 1-3: Convert any viewport client point → canvas-internal pixels */
  const canvasCoords = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: clientX, y: clientY };
    // Phase 1 — real rendered rect (accounts for CSS scaling, zoom, transforms)
    const rect = canvas.getBoundingClientRect();
    // Phase 2 — scale ratio between internal resolution and CSS size
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    // Phase 3 — normalized canvas-space coordinates
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }, []);

  /** From PointerEvent (mouse, stylus, or touch-as-pointer) */
  const getCoords = useCallback((e: React.PointerEvent | PointerEvent): { x: number; y: number } => {
    return canvasCoords(e.clientX, e.clientY);
  }, [canvasCoords]);

  /** Phase 5: From Touch object (touchstart/touchmove native handlers) */
  const getTouchCoords = useCallback((touch: Touch): { x: number; y: number } => {
    return canvasCoords(touch.clientX, touch.clientY);
  }, [canvasCoords]);

  // Vertex hit radius in canvas pixels (18 CSS px × scale)
  const VERTEX_HIT_RADIUS_CSS = 18;
  const getHitRadius = useCallback((): number => {
    const canvas = canvasRef.current;
    if (!canvas) return VERTEX_HIT_RADIUS_CSS;
    const rect = canvas.getBoundingClientRect();
    return VERTEX_HIT_RADIUS_CSS * (canvas.width / rect.width);
  }, []);

  // ─── Internal down/move/up handlers (used by both pointer and touch paths) ───
  const handleInputDown = useCallback((x: number, y: number, captureTarget?: Element, pointerId?: number) => {
    // Phase 6 — live debug dot tracks input in real-time
    if (debugModeRef.current) setDebugPt({ x, y });
    if (mode === "mask") {
      if (captureTarget && pointerId !== undefined) {
        (captureTarget as HTMLElement).setPointerCapture?.(pointerId);
      }
      setIsPainting(true);
      setCurrentStroke([{ x, y }]);
    } else if (mode === "scale") {
      setScalePoints((prev) => {
        const next = prev.length >= 2 ? [{ x, y }] : [...prev, { x, y }];
        if (next.length === 2) setTimeout(() => setScaleDialogOpen(true), 50);
        return next;
      });
    } else if (mode === "polygon") {
      // Clamp to canvas bounds so the polygon mask never extends outside the canvas
      const canvas = canvasRef.current;
      const cx = canvas ? Math.min(Math.max(x, 0), canvas.width  - 1) : x;
      const cy = canvas ? Math.min(Math.max(y, 0), canvas.height - 1) : y;
      const hitRadius = getHitRadius();
      for (let i = 0; i < polygonPoints.length; i++) {
        const dx = cx - polygonPoints[i].x, dy = cy - polygonPoints[i].y;
        if (Math.sqrt(dx * dx + dy * dy) < hitRadius) {
          if (i === 0 && !polygonClosed && polygonPoints.length >= 3) {
            setPolygonClosed(true);
            return;
          }
          if (captureTarget && pointerId !== undefined) {
            (captureTarget as HTMLElement).setPointerCapture?.(pointerId);
          }
          setDraggingVertex(i);
          return;
        }
      }
      if (!polygonClosed) {
        setPolygonPoints((prev) => [...prev, { x: cx, y: cy }]);
      }
    }
  }, [mode, polygonPoints, polygonClosed, getHitRadius]);

  const handleInputMove = useCallback((x: number, y: number) => {
    // Phase 6 — move also updates the live debug dot
    if (debugModeRef.current) setDebugPt({ x, y });
    if (mode === "mask" && isPainting) {
      setCurrentStroke((prev) => [...prev, { x, y }]);
    } else if (mode === "polygon" && draggingVertex !== null) {
      const canvas = canvasRef.current;
      const cx = canvas ? Math.min(Math.max(x, 0), canvas.width  - 1) : x;
      const cy = canvas ? Math.min(Math.max(y, 0), canvas.height - 1) : y;
      setPolygonPoints((prev) => prev.map((p, i) => (i === draggingVertex ? { x: cx, y: cy } : p)));
    }
  }, [mode, isPainting, draggingVertex]);

  const handleInputUp = useCallback(() => {
    if (mode === "mask" && isPainting) {
      setIsPainting(false);
      setCurrentStroke((prev) => {
        if (prev.length > 0) setStrokes((s) => [...s, { points: prev, size: brushSize }]);
        return [];
      });
    } else if (mode === "polygon" && draggingVertex !== null) {
      setDraggingVertex(null);
    }
  }, [mode, isPainting, draggingVertex, brushSize]);

  // ─── Canvas pointer events (PointerEvent API — handles mouse + pen) ──
  const handleCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (mode === "items") return;
    e.preventDefault();
    const { x, y } = getCoords(e);
    handleInputDown(x, y, e.target as Element, e.pointerId);
  }, [mode, getCoords, handleInputDown]);

  const handleCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    if (mode === "items") return;
    e.preventDefault();
    const { x, y } = getCoords(e);
    handleInputMove(x, y);
  }, [mode, getCoords, handleInputMove]);

  const handleCanvasPointerUp = useCallback(() => {
    handleInputUp();
  }, [handleInputUp]);

  // ─── Phase 5: Non-passive touch listeners — prevent scroll during drawing ─
  // Pointer Events (onPointerDown/Move/Up) already handle the actual input for
  // both mouse and touch. We only need native touch listeners to call
  // preventDefault() so the page doesn't scroll while the user is drawing.
  // modeRef is a ref so reading .current is always fresh with no stale closure.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const preventScroll = (e: TouchEvent) => {
      if (["mask", "scale", "polygon"].includes(modeRef.current)) {
        e.preventDefault();
      }
    };
    canvas.addEventListener("touchstart", preventScroll, { passive: false });
    canvas.addEventListener("touchmove", preventScroll, { passive: false });
    return () => {
      canvas.removeEventListener("touchstart", preventScroll);
      canvas.removeEventListener("touchmove", preventScroll);
    };
  // Empty deps: modeRef is a ref and canvasRef never changes identity
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Scale calibration ────────────────────────────────────────
  const handleScaleConfirm = () => {
    const meters = parseFloat(distanceInput);
    if (!meters || meters <= 0 || scalePoints.length < 2) return;
    const dx = scalePoints[1].x - scalePoints[0].x;
    const dy = scalePoints[1].y - scalePoints[0].y;
    const pxDist = Math.sqrt(dx * dx + dy * dy);
    setPixelsPerMeter(pxDist / meters);
    setScaleDialogOpen(false);
    setDistanceInput("");
    setScalePoints([]);
    toast({ title: "Escala calibrada", description: `Referencia: ${meters} m = ${pxDist.toFixed(0)} px` });
  };

  // ─── Inpaint (remove obstacles) — bbox pipeline ───────────────
  const handleInpaint = async () => {
    if (!gardenImage || strokes.length === 0) {
      toast({ title: "Pinta la zona primero", description: "Usa el pincel para marcar el área a borrar.", variant: "destructive" });
      return;
    }

    const maskCanvas = buildMaskCanvas();
    if (!maskCanvas) return;
    const bbox = getMaskBBox(maskCanvas);
    if (!bbox) {
      toast({ title: "Zona vacía", description: "No se detectaron trazos en la máscara.", variant: "destructive" });
      return;
    }

    const originalImage = gardenImage;
    setIsProcessing(true);
    setProcessingMsg("Recortando zona seleccionada...");
    try {
      // Send ONLY the cropped region — AI cannot touch anything outside bbox
      const croppedImage = await cropImageToBBox(originalImage, bbox);
      const croppedMask  = cropMaskToBBox(maskCanvas, bbox);

      setProcessingMsg(`Borrando obstáculo (${bbox.w}×${bbox.h}px)...`);
      const data = await wavespeedPost("/api/ai/wavespeed/inpaint", { imageBase64: croppedImage, maskBase64: croppedMask });

      // Post-proceso: verde→tierra en el resultado de la IA (solo el bbox limpiado)
      setProcessingMsg("Convirtiendo verde a tierra...");
      const cleanedBase64 = await deGrassBase64Design(data.imageBase64);

      // Paste result at exact bbox position — only white-mask pixels replaced
      setProcessingMsg("Pegando resultado en posición exacta...");
      const finalImage = await pasteAtBBox(originalImage, cleanedBase64, bbox, maskCanvas);

      pushGardenImageToHistory(finalImage);
      setStrokes([]); setCurrentStroke([]); setSurfaceType(null);
      toast({ title: "Obstáculo eliminado", description: "Solo el área pintada fue modificada." });
    } catch (err: unknown) {
      toast({ title: "Error al borrar", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsProcessing(false); setProcessingMsg("");
    }
  };

  // ─── Obstacle detection — automatic ─────────────────────────
  const detectObstacles = useCallback((imageSrc: string): Promise<{
    mask: HTMLCanvasElement;
    overlay: HTMLCanvasElement;
    clusterCount: number;
  } | null> => {
    return new Promise((resolve) => {
      const canvas = canvasRef.current;
      if (!canvas) { resolve(null); return; }
      const W = canvas.width, H = canvas.height;
      if (W === 0 || H === 0) { resolve(null); return; }

      const img = new Image();
      img.onload = () => {
        const cr = getContainRect(img.naturalWidth, img.naturalHeight, W, H);

        const base = document.createElement("canvas");
        base.width = W; base.height = H;
        const bCtx = base.getContext("2d", { willReadFrequently: true })!;
        bCtx.fillStyle = "#000";
        bCtx.fillRect(0, 0, W, H);
        bCtx.drawImage(img, cr.x, cr.y, cr.w, cr.h);
        const imgData = bCtx.getImageData(0, 0, W, H);

        const labelMap = new Int32Array(W * H);
        labelMap.fill(-1);
        const imageAreaPx = Math.round(cr.w * cr.h);

        for (let pi = 0; pi < imgData.data.length; pi += 4) {
          const idx = pi / 4;
          const px = idx % W, py = Math.floor(idx / W);
          const inImage = px >= cr.x && px < cr.x + cr.w && py >= cr.y && py < cr.y + cr.h;
          if (!inImage) { labelMap[idx] = -2; continue; }

          const r = imgData.data[pi], g = imgData.data[pi + 1], b = imgData.data[pi + 2];
          const brightness = (r + g + b) / 3;
          const grayDiff = Math.max(Math.abs(r - g), Math.abs(r - b), Math.abs(g - b));

          const isConcrete = grayDiff < 22 && brightness > 145;
          const isGrass = g > r * 1.18 && g > b * 1.12 && g > 60;
          const isBrightWhite = brightness > 215 && grayDiff < 30;
          const isSoil = !isConcrete && !isGrass && !isBrightWhite;

          const isTerrain = isSoil || isConcrete || isGrass || isBrightWhite;

          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const saturation = max === 0 ? 0 : (max - min) / max;
          const isDarkBlob = brightness < 50;
          const isHighSatObject = saturation > 0.35 && !isGrass;
          const isMidtoneObject = grayDiff >= 22 && brightness >= 50 && brightness <= 145 && !isSoil;

          if (!isTerrain || isHighSatObject || isDarkBlob || isMidtoneObject) {
            labelMap[idx] = 0;
          }
        }

        const clusterIds = new Int32Array(W * H);
        clusterIds.fill(0);
        let nextCluster = 1;
        const clusterSizes = new Map<number, number>();

        for (let y = Math.floor(cr.y); y < Math.min(H, cr.y + cr.h); y++) {
          for (let x = Math.floor(cr.x); x < Math.min(W, cr.x + cr.w); x++) {
            const idx = y * W + x;
            if (labelMap[idx] !== 0 || clusterIds[idx] !== 0) continue;

            const cId = nextCluster++;
            let size = 0;
            const stack = [idx];
            while (stack.length > 0) {
              const cur = stack.pop()!;
              if (clusterIds[cur] !== 0) continue;
              if (labelMap[cur] !== 0) continue;
              clusterIds[cur] = cId;
              size++;
              const cx = cur % W, cy = Math.floor(cur / W);
              if (cx > cr.x) stack.push(cur - 1);
              if (cx < cr.x + cr.w - 1) stack.push(cur + 1);
              if (cy > cr.y) stack.push(cur - W);
              if (cy < cr.y + cr.h - 1) stack.push(cur + W);
            }
            clusterSizes.set(cId, size);
          }
        }

        const minClusterPx = Math.max(200, imageAreaPx * 0.001);
        const maxClusterPx = imageAreaPx * 0.35;
        const validClusters = new Set<number>();
        for (const [cId, size] of clusterSizes) {
          if (size >= minClusterPx && size <= maxClusterPx) {
            validClusters.add(cId);
          }
        }

        if (validClusters.size === 0) {
          console.log("[obstacles] No significant obstacles detected");
          resolve(null);
          return;
        }

        const maskOff = document.createElement("canvas");
        maskOff.width = W; maskOff.height = H;
        const mCtx = maskOff.getContext("2d")!;
        const maskImgData = mCtx.createImageData(W, H);

        const overlayOff = document.createElement("canvas");
        overlayOff.width = W; overlayOff.height = H;
        const oCtx = overlayOff.getContext("2d")!;
        const overlayData = oCtx.createImageData(W, H);

        let obstaclePixels = 0;
        for (let i = 0; i < W * H; i++) {
          const pi = i * 4;
          if (validClusters.has(clusterIds[i])) {
            maskImgData.data[pi] = maskImgData.data[pi + 1] = maskImgData.data[pi + 2] = 255;
            maskImgData.data[pi + 3] = 255;
            overlayData.data[pi] = 220;
            overlayData.data[pi + 1] = 38;
            overlayData.data[pi + 2] = 38;
            overlayData.data[pi + 3] = 140;
            obstaclePixels++;
          } else {
            maskImgData.data[pi + 3] = 255;
            overlayData.data[pi + 3] = 0;
          }
        }

        const dilateRadius = 6;
        const dilated = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) {
          if (maskImgData.data[i * 4] > 128) dilated[i] = 1;
        }
        const dilatedResult = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (dilated[y * W + x]) { dilatedResult[y * W + x] = 1; continue; }
            let found = false;
            for (let dy = -dilateRadius; dy <= dilateRadius && !found; dy++) {
              for (let dx = -dilateRadius; dx <= dilateRadius && !found; dx++) {
                const ny = y + dy, nx = x + dx;
                if (ny >= 0 && ny < H && nx >= 0 && nx < W && dilated[ny * W + nx]) {
                  if (dx * dx + dy * dy <= dilateRadius * dilateRadius) {
                    found = true;
                  }
                }
              }
            }
            if (found) dilatedResult[y * W + x] = 1;
          }
        }

        for (let i = 0; i < W * H; i++) {
          const pi = i * 4;
          if (dilatedResult[i]) {
            maskImgData.data[pi] = maskImgData.data[pi + 1] = maskImgData.data[pi + 2] = 255;
            if (!validClusters.has(clusterIds[i])) {
              overlayData.data[pi] = 220;
              overlayData.data[pi + 1] = 38;
              overlayData.data[pi + 2] = 38;
              overlayData.data[pi + 3] = 80;
            }
          }
        }

        mCtx.putImageData(maskImgData, 0, 0);
        oCtx.putImageData(overlayData, 0, 0);

        console.log(`[obstacles] Detected ${validClusters.size} clusters, ${obstaclePixels}px (${(obstaclePixels / imageAreaPx * 100).toFixed(1)}% of image)`);
        resolve({ mask: maskOff, overlay: overlayOff, clusterCount: validClusters.size });
      };
      img.onerror = () => resolve(null);
      img.src = imageSrc;
    });
  }, []);

  const handleDetectObstacles = useCallback(async () => {
    if (!gardenImage) {
      toast({ title: "No hay imagen", description: "Carga una foto del jardin primero.", variant: "destructive" });
      return;
    }
    setIsProcessing(true);
    setProcessingMsg("Analizando imagen para detectar obstaculos...");
    try {
      const result = await detectObstacles(gardenImage);
      if (!result) {
        toast({ title: "No se detectaron obstaculos", description: "La imagen parece limpia.", variant: "default" });
        setIsProcessing(false);
        setProcessingMsg("");
        return;
      }
      setObstacleMask(result.mask);
      setObstacleOverlay(result.overlay);
      setObstacleCount(result.clusterCount);
      setObstaclePreview(true);
      toast({ title: `${result.clusterCount} obstaculo(s) detectado(s)`, description: "Revisa las zonas marcadas en rojo y confirma para eliminar." });
    } catch (err: unknown) {
      toast({ title: "Error en deteccion", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsProcessing(false);
      setProcessingMsg("");
    }
  }, [gardenImage, detectObstacles, toast]);

  const handleRemoveObstacles = useCallback(async () => {
    if (!gardenImage || !obstacleMask) return;

    setObstaclePreview(false);
    setIsProcessing(true);
    setProcessingMsg("Limpiando terreno...");

    try {
      const bbox = getMaskBBox(obstacleMask, 32);
      if (!bbox) throw new Error("No se encontro area en la mascara");

      setProcessingMsg("Recortando zona de obstaculos...");
      const croppedImage = await cropImageToBBox(gardenImage, bbox);
      const croppedMask = cropMaskToBBox(obstacleMask, bbox);

      setProcessingMsg(`Eliminando obstaculos (${bbox.w}x${bbox.h}px)...`);
      const data = await wavespeedPost("/api/ai/wavespeed/inpaint", {
        imageBase64: croppedImage,
        maskBase64: croppedMask,
        prompt: "clean empty ground, natural soil, bare dirt, no objects, no furniture, no debris, no rocks, seamless terrain matching surrounding area",
      });

      // Post-proceso: verde→tierra en el resultado de la IA (solo el bbox limpiado)
      setProcessingMsg("Convirtiendo verde a tierra...");
      const cleanedObstacle = await deGrassBase64Design(data.imageBase64);

      setProcessingMsg("Integrando resultado...");
      const finalImage = await pasteAtBBox(gardenImage, cleanedObstacle, bbox, obstacleMask);

      pushGardenImageToHistory(finalImage);
      setObstacleMask(null);
      setObstacleOverlay(null);
      setObstacleCount(0);
      toast({ title: "Terreno limpio", description: "Los obstaculos fueron eliminados. El terreno esta listo para disenar." });
    } catch (err: unknown) {
      toast({ title: "Error al limpiar", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsProcessing(false);
      setProcessingMsg("");
    }
  }, [gardenImage, obstacleMask, getMaskBBox, cropImageToBBox, cropMaskToBBox, pasteAtBBox, toast, setGardenImage]);

  const handleCancelObstacles = useCallback(() => {
    setObstaclePreview(false);
    setObstacleMask(null);
    setObstacleOverlay(null);
    setObstacleCount(0);
  }, []);


  // ─── Apply material — FULL-IMAGE APPROACH ────────────────────
  // Sends the full canvas image + full mask to AI.
  // No bbox cropping/pasting — gives AI complete context and eliminates
  // all coordinate alignment complexity.
  //
  // Mask sources:
  //   grass, no strokes  → terrainMap.soil (entire auto-detected soil area)
  //   grass, with strokes → soil-filtered user mask (only painted soil pixels)
  //   other material      → raw user strokes mask
  const handleApplyMaterial = useCallback(
    async (material: string) => {
      if (!gardenImage) {
        toast({ title: "No hay imagen", description: "Carga una foto del jardín primero.", variant: "destructive" });
        return;
      }

      const mat = materials.find(m => m.id === material) || materials[0];
      const matLabel = mat.name;
      const isGrass  = mat.type === "grass";

      // ── Capturar estado del polígono en variables locales ANTES de limpiar el overlay ──
      // Los puntos se usan para: (1) buildPolygonMaskCanvas, (2) compositePolygonClip.
      // El overlay visual se limpia INMEDIATAMENTE para no flotar durante los ~60s de IA.
      const polygonPtsCopy = [...polygonPoints];
      const polygonWasClosed = polygonClosed || polygonPtsCopy.length >= 3;

      // ── Limpiar overlay visual de inmediato (antes de enviar a IA) ────────────
      setPolygonPoints([]); setPolygonClosed(false);
      setPolygonPxPerMeter(null); setPolygonMeasureSide(null);
      setScalePoints([]);
      setStrokes([]); setCurrentStroke([]); setSurfaceType(null);

      // ── Determine which mask to use ──────────────────────────
      let maskCanvas: HTMLCanvasElement | null = null;

      if (polygonPtsCopy.length >= 3) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        maskCanvas = buildPolygonMaskCanvas(polygonPtsCopy, canvas.width, canvas.height);
        setIsProcessing(true);
        setProcessingMsg("Usando zona delimitada por polígono...");

      } else if (isGrass && strokes.length === 0) {
        console.log(`[pipeline] AUTO-SOIL MODE: no polygon, no strokes, using terrain detection`);
        // AUTO MODE: use full auto-detected soil area — no painting needed
        if (!terrainMap?.soil) {
          toast({
            title: "Analizando terreno...",
            description: "Espera un momento para que el sistema detecte las zonas de tierra.",
          });
          return;
        }
        maskCanvas = terrainMap.soil;
        setIsProcessing(true);
        setProcessingMsg("Usando zonas de tierra detectadas automáticamente...");

      } else if (isGrass && strokes.length > 0) {
        // MANUAL MODE: user painted area — filter to soil pixels only
        const rawMask = buildMaskCanvas();
        if (!rawMask) {
          toast({ title: "Sin trazos", variant: "destructive" });
          return;
        }
        setIsProcessing(true);
        setProcessingMsg("Verificando superficie pixel a pixel...");
        const soilResult = await soilFilterMask(gardenImage, rawMask);
        if (!soilResult) {
          toast({
            title: "Sin tierra en la zona pintada",
            description: "El área pintada no contiene tierra detectable. El pasto solo se aplica en tierra.",
            variant: "destructive",
          });
          setIsProcessing(false); setProcessingMsg(""); return;
        }
        maskCanvas = soilResult.canvas;
        const pct = Math.round((soilResult.soilCount / soilResult.totalCount) * 100);
        setProcessingMsg(`Tierra detectada: ${pct}% del área pintada...`);

      } else {
        // OTHER MATERIALS: require user to paint
        const rawMask = buildMaskCanvas();
        if (!rawMask) {
          toast({ title: "Pinta la zona primero", description: "Usa el pincel para marcar el área a tratar.", variant: "destructive" });
          return;
        }
        maskCanvas = rawMask;
        setIsProcessing(true);
        setProcessingMsg(`Preparando zona para ${matLabel}...`);
      }

      try {
        setProcessingMsg("Preparando imagen para IA...");

        const { base64: canvasJpeg, w: aiW, h: aiH } = await getCanvasImageForAI();

        const resizedMask = resizeCanvas(maskCanvas!, AI_MAX);
        // exactMask: resolución AI, sin dilatar (referencia; el compositing usa matchMask dilatado)
        const exactMask = document.createElement("canvas");
        exactMask.width = aiW; exactMask.height = aiH;
        exactMask.getContext("2d")!.drawImage(resizedMask, 0, 0, aiW, aiH);
        // matchMask: dilatado 6px → cubre orillas y gaps del soilFilter; se envía a la IA y se usa en compositing
        const matchMask = dilateMask(exactMask, 6);
        console.log(`[pipeline] FASE 2-3: Binary mask ${aiW}x${aiH}, exact+dilated 6px`);

        const originalCanvas = document.createElement("canvas");
        originalCanvas.width = aiW; originalCanvas.height = aiH;
        const origCtx = originalCanvas.getContext("2d")!;
        const origImg = new Image();
        await new Promise<void>((resolve, reject) => {
          origImg.onload = () => { origCtx.drawImage(origImg, 0, 0); resolve(); };
          origImg.onerror = () => reject(new Error("Cannot load image"));
          origImg.src = canvasJpeg;
        });

        setProcessingMsg("Recortando zona seleccionada...");
        const bbox = computeMaskBBox(matchMask, 24);
        if (!bbox) {
          toast({ title: "Sin zona marcada", description: "La máscara no contiene pixeles activos. Marca un área primero.", variant: "destructive" });
          setIsProcessing(false); setProcessingMsg("");
          return;
        }
        const croppedImage = cropCanvas(originalCanvas, bbox);
        const croppedMask = cropCanvas(matchMask, bbox);

        const croppedImgResized = resizeCanvas(croppedImage, AI_MAX);
        const croppedMaskResized = document.createElement("canvas");
        croppedMaskResized.width = croppedImgResized.width;
        croppedMaskResized.height = croppedImgResized.height;
        croppedMaskResized.getContext("2d")!.drawImage(croppedMask, 0, 0, croppedMaskResized.width, croppedMaskResized.height);

        // Texture pre-fill removed: flat SVG tiles create a visible synthetic overlay
        // on photorealistic AI output. The AI prompt alone produces professional results.

        const croppedJpeg = croppedImgResized.toDataURL("image/jpeg", 0.92);
        const croppedMaskPng = croppedMaskResized.toDataURL("image/png");

        console.log(`[pipeline] FASE 4: Sending to AI. full=${aiW}x${aiH} bbox=${bbox.x},${bbox.y} ${bbox.w}x${bbox.h} crop=${croppedImgResized.width}x${croppedImgResized.height} hasTexture=${!!mat.textureUrl}`);
        setProcessingMsg(`Aplicando ${matLabel} con IA... ~60s`);

        const aiPayload = { imageBase64: croppedJpeg, maskBase64: croppedMaskPng, material, prompt: mat.prompt, negativePrompt: mat.negativePrompt };
        const data = await wavespeedPost("/api/ai/wavespeed/apply-material", aiPayload as Record<string, unknown>);

        setProcessingMsg("Composición final sobre el área seleccionada...");
        const aiResultCanvas = document.createElement("canvas");
        const aiImg = new Image();
        await new Promise<void>((resolve, reject) => {
          aiImg.onload = () => {
            aiResultCanvas.width = aiImg.naturalWidth;
            aiResultCanvas.height = aiImg.naturalHeight;
            const aiCtx = aiResultCanvas.getContext("2d")!;
            aiCtx.drawImage(aiImg, 0, 0);
            // ── Grass boost: pasto vivo, saturado, fotorrealista ──────────────
            // Refuerza el verde del resultado de IA sin destruir la textura natural.
            // Solo para grass — no toca otras texturas ni el fondo.
            if (isGrass) {
              const id = aiCtx.getImageData(0, 0, aiResultCanvas.width, aiResultCanvas.height);
              const d  = id.data;
              for (let i = 0; i < d.length; i += 4) {
                const r = d[i], g = d[i+1], b = d[i+2];
                const lum = (r * 0.299 + g * 0.587 + b * 0.114);
                // Canal verde: amplificar fuerte, clampear para no quemar
                const newG = Math.min(255, g * 1.70 + 8);
                // Canal rojo: bajar para saturar el verde
                const newR = Math.min(255, r * 0.38 + lum * 0.05);
                // Canal azul: bajar un poco (pasto real tiene algo de azul)
                const newB = Math.min(255, b * 0.45 + lum * 0.04);
                d[i]   = Math.round(newR);
                d[i+1] = Math.round(newG);
                d[i+2] = Math.round(newB);
              }
              aiCtx.putImageData(id, 0, 0);
            }
            resolve();
          };
          aiImg.onerror = () => reject(new Error("Cannot load AI result"));
          aiImg.src = data.imageBase64;
        });

        let composited: HTMLCanvasElement;
        if (polygonWasClosed && polygonPtsCopy.length >= 3) {
          // POLYGON MODE: use ctx.clip() with exact polygon path — millimeter-precise,
          // 100% coverage guaranteed by browser-native canvas clipping, zero AI dependency.
          const canvasEl = canvasRef.current!;
          const polyScaleX = aiW / canvasEl.width;
          const polyScaleY = aiH / canvasEl.height;
          const polygonPtsAI = polygonPtsCopy.map(p => ({
            x: Math.min(Math.max(p.x * polyScaleX, 0), aiW),
            y: Math.min(Math.max(p.y * polyScaleY, 0), aiH),
          }));
          composited = compositePolygonClip(originalCanvas, aiResultCanvas, bbox, polygonPtsAI);
          console.log(`[pipeline] POLYGON CLIP composite. scale=${polyScaleX.toFixed(3)}×${polyScaleY.toFixed(3)}`);
        } else {
          // MASK MODE: forceTextureFill pixel-by-pixel (brush strokes).
          // matchMask (dilatado 6px) cubre orillas y gaps del soilFilter — igual que lo que recibió la IA.
          composited = forceTextureFill(originalCanvas, aiResultCanvas, matchMask, bbox, null, 0, debugMode);
          console.log(`[pipeline] MASK fill composite (exactMask). ${composited.width}×${composited.height}`);
        }

        pushGardenImageToHistory(composited.toDataURL("image/jpeg", 0.92));

        let areaM2 = 0;
        if (polygonWasClosed && polygonPtsCopy.length >= 3) {
          const ppm = polygonPxPerMeter ?? pixelsPerMeter;
          if (ppm) areaM2 = polygonAreaPx(polygonPtsCopy) / (ppm * ppm);
        } else {
          areaM2 = getMaskAreaM2() ?? (isGrass ? terrainMap?.soilM2 ?? 0 : 0);
        }

        if (isGrass) setGrassAreaM2(areaM2);

        const costEntry = {
          materialId: mat.id,
          materialName: mat.name,
          areaM2,
          pricePerM2: mat.pricePerM2,
          total: areaM2 * mat.pricePerM2,
        };
        addMaterialCost(costEntry);

        const desc = areaM2 > 0
          ? `${areaM2.toFixed(1)} m² · $${costEntry.total.toLocaleString()}`
          : `${matLabel} aplicado en la zona marcada.`;
        toast({ title: `${matLabel} aplicado`, description: desc });
      } catch (err: unknown) {
        console.error("[wavespeed] Error:", (err as Error).message);
        toast({ title: "Error conectando con IA", description: (err as Error).message, variant: "destructive" });
      } finally {
        setIsProcessing(false); setProcessingMsg("");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gardenImage, strokes, terrainMap, pixelsPerMeter, pricePerM2, buildMaskCanvas, soilFilterMask, getCanvasImageForAI, getMaskAreaM2, polygonClosed, polygonPoints, polygonPxPerMeter, materials, addMaterialCost]
  );

  // ── Composite image for PDF export ────────────────────────────────────────
  // Combina el fondo (gardenImage con materiales aplicados) + todos los items
  // del diseño (plantas, elementos) en una sola imagen lista para el PDF.
  // Usa las mismas dimensiones y fórmulas de posición/escala que el canvas visual.
  const buildCompositeImage = useCallback(async (): Promise<string | null> => {
    if (!gardenImage) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const W = canvas.width;
    const H = canvas.height;
    const combined = document.createElement("canvas");
    combined.width = W;
    combined.height = H;
    const ctx = combined.getContext("2d")!;

    // 1. Dibujar fondo con object-contain (igual que el canvas visual)
    const bgImg = await new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("bg load failed"));
      img.src = gardenImage!;
    });
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, W, H);
    const cr = getContainRect(bgImg.naturalWidth, bgImg.naturalHeight, W, H);
    ctx.drawImage(bgImg, cr.x, cr.y, cr.w, cr.h);

    // 2. Dibujar items del diseño (plantas, objetos) — misma lógica que el JSX
    const BASE_SIZE = 120;
    const sorted = [...designItems].sort((a, b) => (a.y ?? 50) - (b.y ?? 50));
    for (const item of sorted) {
      if (!item.imageData) continue;
      try {
        const itemImg = await new Promise<HTMLImageElement>((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = () => rej(new Error("item load failed"));
          img.src = item.imageData!;
        });
        const s = item.scale || 1;
        const perspectiveScale = item.lockPosition ? 1.0 : calcPerspectiveScale(item.y ?? 50, horizonYPct);
        const finalSize = BASE_SIZE * s * perspectiveScale;
        const cx = (item.x / 100) * W;
        const cy = (item.y / 100) * H + (item.baseOffset ?? 0);
        const r = item.rotation || 0;
        // object-contain: preservar aspect ratio igual que el CSS en pantalla
        const nat = itemImg.naturalWidth / itemImg.naturalHeight;
        let dw: number, dh: number;
        if (nat >= 1) { dw = finalSize; dh = finalSize / nat; }
        else           { dh = finalSize; dw = finalSize * nat; }
        ctx.save();
        ctx.translate(cx, cy);
        if (r !== 0) ctx.rotate(r);
        ctx.filter = "brightness(115%) saturate(140%)";
        ctx.drawImage(itemImg, -dw / 2, -dh / 2, dw, dh);
        ctx.filter = "none";
        ctx.restore();
      } catch {
        // item image faltante — saltar sin romper el composite
      }
    }

    return combined.toDataURL("image/jpeg", 0.92);
  }, [gardenImage, designItems, getGroundY]);

  // ── Captura pixel-perfect para la vista de Presentación ───────────────────
  // En readOnly el canvas HTML5 (canvasRef) NO se monta — el fondo se muestra
  // como <img src={gardenImage} object-contain>. Reproducimos esa misma composición
  // usando gardenImage + getContainRect, con las mismas coordenadas CSS que el JSX.
  const buildPresentationCapture = useCallback(async (customBg?: string): Promise<string | null> => {
    if (!gardenImage) return null;
    const container = containerRef.current;
    if (!container)   return null;

    // Dimensiones CSS del contenedor — fallback a getBoundingClientRect si offsetWidth es 0
    const cssW = container.offsetWidth  || container.getBoundingClientRect().width;
    const cssH = container.offsetHeight || container.getBoundingClientRect().height;
    if (!cssW || !cssH) return null;

    // 1. Cargar imagen de fondo ORIGINAL para calcular el rect de contain.
    //    Si hay customBg (fondo de IA), se usa para dibujar pero el cr se
    //    calcula siempre desde gardenImage para mantener coords consistentes.
    const bgImg = await new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image();
      img.onload  = () => res(img);
      img.onerror = () => rej(new Error("bg load failed"));
      img.src = gardenImage!;
    });

    // Canvas de salida = tamaño completo del contenedor a 3× (~4K calidad máxima)
    const EXPORT_SCALE = 3;
    const combined = document.createElement("canvas");
    combined.width  = cssW * EXPORT_SCALE;
    combined.height = cssH * EXPORT_SCALE;
    const ctx = combined.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.scale(EXPORT_SCALE, EXPORT_SCALE);

    // cr basado en gardenImage (coordenadas invariantes para plantas)
    const cr = getContainRect(bgImg.naturalWidth, bgImg.naturalHeight, cssW, cssH);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cssW, cssH);

    if (customBg) {
      // Fondo personalizado (resultado de IA) — ya es el área exacta de cr
      // → se dibuja en la misma posición que el gardenImage original
      const customImg = await new Promise<HTMLImageElement>((res, rej) => {
        const img = new Image();
        img.onload  = () => res(img);
        img.onerror = () => rej(new Error("custom bg load failed"));
        img.src = customBg;
      });
      ctx.drawImage(customImg, cr.x, cr.y, cr.w, cr.h);
    } else {
      ctx.drawImage(bgImg, cr.x, cr.y, cr.w, cr.h);
    }

    // 2. Items — ordenados por Y (perspectiva), idéntico a JSX left:X% top:Y%
    const BASE_SIZE = 120;
    const sorted = [...designItems].sort((a, b) => (a.y ?? 50) - (b.y ?? 50));
    for (const item of sorted) {
      // imageData puede ser null en items restaurados de la API → fallback a URL del inventario
      const imgSrc = item.imageData ?? (typeof item.inventoryItemId === "number"
        ? `/api/inventory/${item.inventoryItemId}/image`
        : null);
      if (!imgSrc) continue;
      try {
        const itemImg = await new Promise<HTMLImageElement>((res, rej) => {
          const img = new Image();
          img.onload  = () => res(img);
          img.onerror = () => rej(new Error("item load failed"));
          img.src = imgSrc;
        });
        const s = item.scale || 1;
        const perspScale = item.lockPosition
          ? 1.0
          : calcPerspectiveScale(item.y ?? 50, horizonYPct);
        const finalSize = BASE_SIZE * s * perspScale;
        const cx = (item.x / 100) * cssW;
        const cy = (item.y / 100) * cssH + (item.baseOffset ?? 0);
        const r  = ((item.rotation || 0) * Math.PI) / 180;
        // object-contain: preservar aspect ratio igual que CSS en pantalla
        const nat = itemImg.naturalWidth / itemImg.naturalHeight;
        let dw: number, dh: number;
        if (nat >= 1) { dw = finalSize; dh = finalSize / nat; }
        else           { dh = finalSize; dw = finalSize * nat; }

        ctx.save();

        // ── SOMBRA DE CONTACTO MINIMALISTA ───────────────────────────────────
        // Una sola elipse pequeña en la base del tronco. Se aplica a TODAS las
        // plantas, así que cualquier exceso aquí se multiplica 8-10×.
        //   - radio máximo 32 px (no escala sin tope con la planta)
        //   - blur 3 px (apenas suaviza el borde)
        //   - opacidad 0.30 en multiply (se funde con el pasto, no lo cubre)
        //   - color verde oscuro, no negro
        const rx = Math.min(dw * 0.20, 32);
        const ry = Math.min(dw * 0.06, 10);
        ctx.globalCompositeOperation = "multiply";
        ctx.filter = "blur(3px)";
        ctx.globalAlpha = 0.30;
        ctx.beginPath();
        ctx.ellipse(cx, cy + 1, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,30,8,1)";
        ctx.fill();
        ctx.filter = "none";
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";

        // Elemento limpio — sin filtro por elemento
        ctx.translate(cx, cy);
        if (r !== 0) ctx.rotate(r);
        ctx.drawImage(itemImg, -dw / 2, -dh / 2, dw, dh);

        ctx.restore();
      } catch {
        // item image faltante — saltar sin romper
      }
    }

    // 3. Color balance global muy sutil
    ctx.filter = "contrast(1.03) brightness(1.02) saturate(1.03)";
    ctx.drawImage(combined, 0, 0, cssW, cssH);
    ctx.filter = "none";

    // 4. Simulación Cámara Real (PRO) — buffer temporal en píxeles físicos
    const cw = combined.width;  // píxeles físicos
    const ch = combined.height;

    // Temp canvas en espacio físico (sin scale)
    const temp = document.createElement("canvas");
    temp.width = cw; temp.height = ch;
    const tctx = temp.getContext("2d")!;
    tctx.drawImage(combined, 0, 0);

    // 4a. Curva fotográfica gamma 0.95
    const curveData = tctx.getImageData(0, 0, cw, ch);
    const cd = curveData.data;
    for (let i = 0; i < cd.length; i += 4) {
      cd[i]   = Math.pow(cd[i]   / 255, 0.95) * 255;
      cd[i+1] = Math.pow(cd[i+1] / 255, 0.95) * 255;
      cd[i+2] = Math.pow(cd[i+2] / 255, 0.95) * 255;
    }
    tctx.putImageData(curveData, 0, 0);

    // 4b. Grano DSLR fino (±2 por canal)
    const grainData = tctx.getImageData(0, 0, cw, ch);
    const gd = grainData.data;
    for (let i = 0; i < gd.length; i += 4) {
      const noise = (Math.random() - 0.5) * 4;
      gd[i]   = Math.max(0, Math.min(255, gd[i]   + noise));
      gd[i+1] = Math.max(0, Math.min(255, gd[i+1] + noise));
      gd[i+2] = Math.max(0, Math.min(255, gd[i+2] + noise));
    }
    tctx.putImageData(grainData, 0, 0);

    // 4c. Micro desenfoque óptico (0.35px) en canvas separado
    const blurC = document.createElement("canvas");
    blurC.width = cw; blurC.height = ch;
    const bctx = blurC.getContext("2d")!;
    bctx.filter = "blur(0.35px)";
    bctx.drawImage(temp, 0, 0);
    bctx.filter = "none";

    // 4d. Volcar al ctx principal — blur base + sharpen óptico (contrast 1.02)
    ctx.drawImage(blurC, 0, 0, cssW, cssH);
    ctx.filter = "contrast(1.02)";
    ctx.drawImage(combined, 0, 0, cssW, cssH);
    ctx.filter = "none";

    // 4e. Viñeta sutil (0→10%) — coordenadas lógicas
    const vignette = ctx.createRadialGradient(
      cssW / 2, cssH / 2, cssW * 0.3,
      cssW / 2, cssH / 2, cssW * 0.9
    );
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.10)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, cssW, cssH);

    // 5. Recortar al área exacta de la imagen (cr) — elimina barras negras laterales/superiores
    //    cr está en coordenadas CSS; multiplicar por EXPORT_SCALE para píxeles físicos.
    const cropped = document.createElement("canvas");
    cropped.width  = Math.round(cr.w * EXPORT_SCALE);
    cropped.height = Math.round(cr.h * EXPORT_SCALE);
    const cctx = cropped.getContext("2d")!;
    cctx.drawImage(
      combined,
      Math.round(cr.x * EXPORT_SCALE), Math.round(cr.y * EXPORT_SCALE),
      Math.round(cr.w * EXPORT_SCALE), Math.round(cr.h * EXPORT_SCALE),
      0, 0,
      cropped.width, cropped.height
    );

    // 6. Auto-recorte de barras negras horneadas en la imagen original.
    //    Escanea filas/columnas y elimina las que sean prácticamente negras
    //    en toda su extensión (umbral de luminancia muy bajo).
    const cw2 = cropped.width;
    const ch2 = cropped.height;
    let imgData: ImageData;
    try { imgData = cctx.getImageData(0, 0, cw2, ch2); }
    catch { return cropped.toDataURL("image/jpeg", 0.98); }
    const px = imgData.data;
    const isDarkRow = (y: number): boolean => {
      let sum = 0; let count = 0;
      for (let x = 0; x < cw2; x += 4) {
        const i = (y * cw2 + x) * 4;
        sum += px[i] + px[i+1] + px[i+2];
        count += 3;
      }
      return (sum / count) < 12;
    };
    const isDarkCol = (x: number): boolean => {
      let sum = 0; let count = 0;
      for (let y = 0; y < ch2; y += 4) {
        const i = (y * cw2 + x) * 4;
        sum += px[i] + px[i+1] + px[i+2];
        count += 3;
      }
      return (sum / count) < 12;
    };
    let top = 0, bottom = ch2 - 1, left = 0, right = cw2 - 1;
    while (top < bottom && isDarkRow(top)) top++;
    while (bottom > top && isDarkRow(bottom)) bottom--;
    while (left < right && isDarkCol(left)) left++;
    while (right > left && isDarkCol(right)) right--;

    const finalW = right - left + 1;
    const finalH = bottom - top + 1;
    if (finalW < cw2 - 4 || finalH < ch2 - 4) {
      const finalC = document.createElement("canvas");
      finalC.width = finalW; finalC.height = finalH;
      const fctx = finalC.getContext("2d")!;
      fctx.drawImage(cropped, left, top, finalW, finalH, 0, 0, finalW, finalH);
      return finalC.toDataURL("image/jpeg", 0.98);
    }

    return cropped.toDataURL("image/jpeg", 0.98);
  }, [gardenImage, designItems, horizonYPct]);

  // ─── buildBackgroundOnlyCapture ───────────────────────────────────────────
  // Igual que buildPresentationCapture pero SIN dibujar ningún item.
  // Se envía a la IA para que renderice solo el fondo fotorrealista.
  const buildBackgroundOnlyCapture = useCallback(async (): Promise<string | null> => {
    if (!gardenImage) return null;
    const container = containerRef.current;
    if (!container) return null;
    const cssW = container.offsetWidth  || container.getBoundingClientRect().width;
    const cssH = container.offsetHeight || container.getBoundingClientRect().height;
    if (!cssW || !cssH) return null;

    const bgImg = await new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image();
      img.onload  = () => res(img);
      img.onerror = () => rej(new Error("bg load"));
      img.src = gardenImage!;
    });

    const EXPORT_SCALE = 2;
    const combined = document.createElement("canvas");
    combined.width  = cssW * EXPORT_SCALE;
    combined.height = cssH * EXPORT_SCALE;
    const ctx = combined.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.scale(EXPORT_SCALE, EXPORT_SCALE);

    const cr = getContainRect(bgImg.naturalWidth, bgImg.naturalHeight, cssW, cssH);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.drawImage(bgImg, cr.x, cr.y, cr.w, cr.h);

    // Sin items — solo fondo

    // Recortar al área de imagen (igual que buildPresentationCapture)
    const cropped = document.createElement("canvas");
    cropped.width  = Math.round(cr.w * EXPORT_SCALE);
    cropped.height = Math.round(cr.h * EXPORT_SCALE);
    const cctx = cropped.getContext("2d")!;
    cctx.drawImage(
      combined,
      Math.round(cr.x * EXPORT_SCALE), Math.round(cr.y * EXPORT_SCALE),
      Math.round(cr.w * EXPORT_SCALE), Math.round(cr.h * EXPORT_SCALE),
      0, 0, cropped.width, cropped.height,
    );
    return cropped.toDataURL("image/jpeg", 0.97);
  }, [gardenImage]);

  // ─── buildPlantMask ───────────────────────────────────────────────────────
  // Genera la máscara binaria que se envía junto con la captura a flux-fill-dev.
  //   ⬛ NEGRO  = silueta exacta de cada planta → la IA NO la toca
  //   ⬜ BLANCO = pasto, suelo, paredes, cielo → la IA regenera fotorrealista
  //
  // Las dimensiones y coordenadas son IDÉNTICAS a buildPresentationCapture
  // (mismo cssW/cssH, mismo EXPORT_SCALE, mismo cr) — así el mask se alinea
  // pixel-perfect con la captura. Cualquier desfase rompería el inpaint.
  const buildPlantMask = useCallback(async (): Promise<string | null> => {
    const container = containerRef.current;
    // Fallback de tamaño: si el contenedor no está montado (drawer abierto,
    // canvas oculto en mobile, etc.) usamos 1280x720 — la IA recibirá una
    // máscara útil aunque el preview no esté visible.
    let cssW = container?.offsetWidth  || container?.getBoundingClientRect().width  || 0;
    let cssH = container?.offsetHeight || container?.getBoundingClientRect().height || 0;
    if (!cssW || !cssH) {
      console.warn(`[plant-mask] container sin medidas (w=${cssW} h=${cssH}) → usando fallback 1280x720`);
      cssW = 1280;
      cssH = 720;
    }

    // Si no hay gardenImage (lienzo procedural), tratamos toda el área del
    // contenedor como el área de imagen → el mask se alinea pixel-perfect con
    // la captura procedural de buildPresentationCapture.
    let cr = { x: 0, y: 0, w: cssW, h: cssH };
    if (gardenImage) {
      try {
        const bgImg = await new Promise<HTMLImageElement>((res, rej) => {
          const img = new Image();
          img.onload  = () => res(img);
          img.onerror = () => rej(new Error("bg load"));
          img.src = gardenImage!;
        });
        cr = getContainRect(bgImg.naturalWidth, bgImg.naturalHeight, cssW, cssH);
      } catch (e) {
        console.warn("[plant-mask] gardenImage falló, usando contenedor completo:", e);
      }
    }

    const EXPORT_SCALE = 3;   // ← debe coincidir con buildPresentationCapture
    const combined = document.createElement("canvas");
    combined.width  = cssW * EXPORT_SCALE;
    combined.height = cssH * EXPORT_SCALE;
    const ctx = combined.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.scale(EXPORT_SCALE, EXPORT_SCALE);

    // Fondo: BLANCO (toda el área será regenerada por la IA)
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, cssW, cssH);

    // Items → silueta NEGRA, mismas coords que buildPresentationCapture
    const BASE_SIZE = 120;
    const sorted = [...designItems].sort((a, b) => (a.y ?? 50) - (b.y ?? 50));
    let drawn = 0, skipped = 0;
    for (const item of sorted) {
      const imgSrc = item.imageData ?? (typeof item.inventoryItemId === "number"
        ? `/api/inventory/${item.inventoryItemId}/image`
        : null);
      if (!imgSrc) continue;
      try {
        const itemImg = await new Promise<HTMLImageElement>((res, rej) => {
          const img = new Image();
          img.onload  = () => res(img);
          img.onerror = () => rej(new Error("item load failed"));
          img.src = imgSrc;
        });
        const s = item.scale || 1;
        const perspScale = item.lockPosition
          ? 1.0
          : calcPerspectiveScale(item.y ?? 50, horizonYPct);
        const finalSize = BASE_SIZE * s * perspScale;
        const cx = (item.x / 100) * cssW;
        const cy = (item.y / 100) * cssH + (item.baseOffset ?? 0);
        const r  = ((item.rotation || 0) * Math.PI) / 180;
        const nat = itemImg.naturalWidth / itemImg.naturalHeight;
        let dw: number, dh: number;
        if (nat >= 1) { dw = finalSize; dh = finalSize / nat; }
        else           { dh = finalSize; dw = finalSize * nat; }

        // 1) Renderizar la planta a un canvas off-screen para extraer alpha
        const off = document.createElement("canvas");
        off.width  = Math.max(1, Math.ceil(dw));
        off.height = Math.max(1, Math.ceil(dh));
        const octx = off.getContext("2d")!;
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = "high";
        octx.drawImage(itemImg, 0, 0, dw, dh);
        // 2) Reemplazar contenido por NEGRO sólido manteniendo el alpha
        octx.globalCompositeOperation = "source-in";
        octx.fillStyle = "#000000";
        octx.fillRect(0, 0, off.width, off.height);

        // 3) Pintar la silueta sobre el mask en la posición correcta
        ctx.save();
        ctx.translate(cx, cy);
        if (r !== 0) ctx.rotate(r);
        ctx.drawImage(off, -dw / 2, -dh, dw, dh);
        ctx.restore();
        drawn++;
      } catch (e) {
        skipped++;
        console.warn("[plant-mask] skip item", item.id, e);
      }
    }
    console.log(`[plant-mask] drawn=${drawn} skipped=${skipped} total=${sorted.length}`);

    // 4) Recortar al área de imagen (igual que buildPresentationCapture) y
    //    aplicar dilatación + binarización para que la IA tenga bordes limpios
    //    sin halo gris alrededor de las plantas.
    const cropped = document.createElement("canvas");
    cropped.width  = Math.round(cr.w * EXPORT_SCALE);
    cropped.height = Math.round(cr.h * EXPORT_SCALE);
    const cctx = cropped.getContext("2d")!;
    // dilatar ~20px → cubre el anti-aliasing + un halo amplio alrededor de
    // cada item (plantas, árboles, vallas, mobiliario) donde la IA puede
    // pintar sombras de contacto, integración con el suelo y bordes naturales.
    // El composite final NO re-pega esos píxeles → las sombras quedan.
    cctx.filter = "blur(20px)";
    cctx.drawImage(
      combined,
      Math.round(cr.x * EXPORT_SCALE), Math.round(cr.y * EXPORT_SCALE),
      Math.round(cr.w * EXPORT_SCALE), Math.round(cr.h * EXPORT_SCALE),
      0, 0, cropped.width, cropped.height,
    );
    cctx.filter = "none";

    // Binarizar: cualquier gris < 200 → negro (planta), resto → blanco
    const id = cctx.getImageData(0, 0, cropped.width, cropped.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] < 200 ? 0 : 255;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    cctx.putImageData(id, 0, 0);

    return cropped.toDataURL("image/png");
  }, [gardenImage, designItems, horizonYPct]);

  // ─── getDesignItemNames ───────────────────────────────────────────────────
  // Retorna lista de nombres únicos de todos los items en el diseño.
  // Se usa para auto-poblar el campo de plantas en el Render Premium.
  const getDesignItemNames = useCallback((): string[] => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const item of designItems) {
      if (item.name && !seen.has(item.name)) {
        seen.add(item.name);
        names.push(item.name);
      }
    }
    return names;
  }, [designItems]);

  // ─── getContainerSize ────────────────────────────────────────────────────
  const getContainerSize = useCallback(() => {
    const el = containerRef.current;
    if (!el) return null;
    const w = el.offsetWidth  || el.getBoundingClientRect().width;
    const h = el.offsetHeight || el.getBoundingClientRect().height;
    if (!w || !h) return null;
    return { width: w, height: h };
  }, []);

  // ─── getHorizonY ─────────────────────────────────────────────────────────
  const getHorizonY = useCallback(() => horizonYPct, [horizonYPct]);

  // Expose to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      handleApplyMaterial,
      buildCompositeImage,
      buildPresentationCapture,
      buildBackgroundOnlyCapture,
      buildPlantMask,
      getDesignItemNames,
      getContainerSize,
      getHorizonY,
    }),
    [handleApplyMaterial, buildCompositeImage, buildPresentationCapture,
     buildBackgroundOnlyCapture, buildPlantMask, getDesignItemNames, getContainerSize, getHorizonY],
  );

  // ─── Items mode drag/transform handlers ──────────────────────
  const handleDragOver = (e: React.DragEvent) => e.preventDefault();

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (mode !== "items") return;
    try {
      const data = JSON.parse(e.dataTransfer.getData("application/json"));
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      addDesignItem({
        inventoryItemId: data.inventoryItemId,
        name:            data.name,
        imageData:       data.imageData,
        price:           data.price,
        x,
        y,
        scale:         1,
        rotation:      0,
        depth:         y,        // profundidad visual = posición y al momento de colocar
        lockPosition:  true,     // posición y escala exactas del usuario — sin auto-ajuste
        hitScale:      0.35,     // hitbox = 35% del ancho (solo base del elemento)
        baseOffset:    0,        // ajuste fino de ancla — 0 = sin corrección
      });
    } catch (_) {}
  };

  const getContainerPct = (e: React.PointerEvent | PointerEvent) => {
    if (!containerRef.current) return { px: 0, py: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    return {
      px: ((e.clientX - rect.left) / rect.width) * 100,
      py: ((e.clientY - rect.top) / rect.height) * 100,
    };
  };

  const flushPendingUpdate = useCallback(() => {
    rafRef.current = null;
    if (pendingUpdate.current && dragItemId) {
      updateDesignItem(dragItemId, pendingUpdate.current);
      pendingUpdate.current = null;
    }
  }, [dragItemId, updateDesignItem]);

  const scheduleUpdate = useCallback((updates: Partial<import("../context/app-context").DesignItem>) => {
    pendingUpdate.current = updates;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(flushPendingUpdate);
    }
  }, [flushPendingUpdate]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (inertiaRef.current) cancelAnimationFrame(inertiaRef.current);
    };
  }, []);

  const pinchRef = useRef<{
    active: boolean;
    startDist: number;
    prevAngle: number;
    startScale: number;
    accRotation: number;
    itemId: string;
  } | null>(null);
  const selectedItemIdRef = useRef(selectedItemId);
  const designItemsRef = useRef(designItems);
  const modeRef = useRef(mode);
  selectedItemIdRef.current = selectedItemId;
  designItemsRef.current = designItems;
  modeRef.current = mode;

  const updateDesignItemRef = useRef(updateDesignItem);
  updateDesignItemRef.current = updateDesignItem;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const getTouchDist = (t1: Touch, t2: Touch) => {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const getTouchAngle = (t1: Touch, t2: Touch) =>
      Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX);
    const normAngle = (a: number) => {
      let r = a % (2 * Math.PI);
      if (r > Math.PI) r -= 2 * Math.PI;
      if (r < -Math.PI) r += 2 * Math.PI;
      return r;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (modeRef.current !== "items") return;
      if (e.touches.length === 2 && selectedItemIdRef.current) {
        e.preventDefault();
        const item = designItemsRef.current.find((i) => i.id === selectedItemIdRef.current);
        if (!item) return;
        pinchRef.current = {
          active: true,
          startDist: getTouchDist(e.touches[0], e.touches[1]),
          prevAngle: getTouchAngle(e.touches[0], e.touches[1]),
          startScale: item.scale ?? 1,
          accRotation: item.rotation ?? 0,
          itemId: item.id,
        };
        setActiveTransformOp("scale");
      }
    };

    let pinchRaf: number | null = null;
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchRef.current?.active) {
        e.preventDefault();
        const dist = getTouchDist(e.touches[0], e.touches[1]);
        const angle = getTouchAngle(e.touches[0], e.touches[1]);
        const ratio = dist / pinchRef.current.startDist;
        const newScale = Math.max(0.2, Math.min(20, pinchRef.current.startScale * ratio));
        const delta = normAngle(angle - pinchRef.current.prevAngle);
        pinchRef.current.prevAngle = angle;
        pinchRef.current.accRotation += (delta * 180) / Math.PI;
        const newRot = pinchRef.current.accRotation;
        const itemId = pinchRef.current.itemId;
        if (!pinchRaf) {
          pinchRaf = requestAnimationFrame(() => {
            pinchRaf = null;
            updateDesignItemRef.current(itemId, { scale: newScale, rotation: newRot });
          });
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (pinchRef.current?.active && e.touches.length < 2) {
        pinchRef.current = null;
        setActiveTransformOp(null);
        if (pinchRaf) { cancelAnimationFrame(pinchRaf); pinchRaf = null; }
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      if (pinchRaf) cancelAnimationFrame(pinchRaf);
    };
  }, []);

  const applyInertia = useCallback((itemId: string, vx: number, vy: number) => {
    const FRICTION = 0.92;
    const MIN_V = 0.05;
    const step = () => {
      vx *= FRICTION;
      vy *= FRICTION;
      if (Math.abs(vx) < MIN_V && Math.abs(vy) < MIN_V) { inertiaRef.current = null; return; }
      const item = designItems.find((i) => i.id === itemId);
      if (!item) { inertiaRef.current = null; return; }
      const nx = Math.max(2, Math.min(98, item.x + vx));
      const ny = Math.max(2, Math.min(98, item.y + vy));
      updateDesignItem(itemId, { x: nx, y: ny });
      inertiaRef.current = requestAnimationFrame(step);
    };
    inertiaRef.current = requestAnimationFrame(step);
  }, [designItems, updateDesignItem]);

  const triggerTouchFeedback = (id: string) => {
    setTouchFeedbackId(id);
    if (navigator.vibrate) navigator.vibrate(8);
    setTimeout(() => setTouchFeedbackId(null), 120);
  };

  const handleItemPointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (inertiaRef.current) { cancelAnimationFrame(inertiaRef.current); inertiaRef.current = null; }
    setSelectedItemId(id);
    setDragItemId(id);
    setIsDraggingItem(true);
    setTransformOp("move");
    setActiveTransformOp("move");
    triggerTouchFeedback(id);
    const item = designItems.find((i) => i.id === id);
    if (item) {
      const { px, py } = getContainerPct(e);
      transformStart.current = { x: px - item.x, y: py - item.y, scale: item.scale ?? 1, rotation: item.rotation ?? 0 };
      velocityRef.current = { vx: 0, vy: 0, lastX: px, lastY: py, lastTime: performance.now() };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleScalePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    const item = designItems.find((i) => i.id === id);
    if (!item) return;
    setSelectedItemId(id);
    setDragItemId(id);
    setIsDraggingItem(true);
    setTransformOp("scale");
    setActiveTransformOp("scale");
    triggerTouchFeedback(id);
    const { px, py } = getContainerPct(e);
    const dx = px - item.x, dy = py - item.y;
    const startDist = Math.sqrt(dx * dx + dy * dy);
    transformStart.current = { x: startDist, y: 0, scale: item.scale ?? 1, rotation: item.rotation ?? 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleRotatePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    const item = designItems.find((i) => i.id === id);
    if (!item) return;
    setSelectedItemId(id);
    setDragItemId(id);
    setIsDraggingItem(true);
    setTransformOp("rotate");
    setActiveTransformOp("rotate");
    triggerTouchFeedback(id);
    const { px, py } = getContainerPct(e);
    const startAngle = Math.atan2(py - item.y, px - item.x);
    transformStart.current = { x: startAngle, y: 0, scale: item.scale ?? 1, rotation: item.rotation ?? 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const normalizeAngle = (a: number) => {
    let r = a % (2 * Math.PI);
    if (r > Math.PI) r -= 2 * Math.PI;
    if (r < -Math.PI) r += 2 * Math.PI;
    return r;
  };

  const handleContainerPointerMove = (e: React.PointerEvent) => {
    if (!isDraggingItem || !dragItemId || !containerRef.current) return;
    const item = designItems.find((i) => i.id === dragItemId);
    if (!item) return;

    if (transformOp === "move") {
      const { px, py } = getContainerPct(e);
      const x = Math.max(2, Math.min(98, px - transformStart.current.x));
      const y = Math.max(2, Math.min(98, py - transformStart.current.y));
      const now = performance.now();
      const dt = now - velocityRef.current.lastTime;
      if (dt > 0) {
        const alpha = 0.3;
        velocityRef.current.vx = alpha * (px - velocityRef.current.lastX) + (1 - alpha) * velocityRef.current.vx;
        velocityRef.current.vy = alpha * (py - velocityRef.current.lastY) + (1 - alpha) * velocityRef.current.vy;
        velocityRef.current.lastX = px;
        velocityRef.current.lastY = py;
        velocityRef.current.lastTime = now;
      }
      scheduleUpdate({ x, y });
    } else if (transformOp === "scale") {
      const { px, py } = getContainerPct(e);
      const dx = px - item.x, dy = py - item.y;
      const nowDist = Math.sqrt(dx * dx + dy * dy);
      const startDist = transformStart.current.x;
      if (startDist > 0) {
        const rawRatio = nowDist / startDist;
        const smoothRatio = 1 + (rawRatio - 1) * 0.7;
        const newScale = Math.max(0.2, Math.min(20, transformStart.current.scale * smoothRatio));
        scheduleUpdate({ scale: newScale });
      }
    } else if (transformOp === "rotate") {
      const { px, py } = getContainerPct(e);
      const nowAngle = Math.atan2(py - item.y, px - item.x);
      const delta = normalizeAngle(nowAngle - transformStart.current.x);
      const newRot = (transformStart.current.rotation ?? 0) + (delta * 180) / Math.PI;
      scheduleUpdate({ rotation: newRot });
    }
  };

  const handleContainerPointerUp = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (pendingUpdate.current && dragItemId) {
      updateDesignItem(dragItemId, pendingUpdate.current);
      pendingUpdate.current = null;
    }
    if (transformOp === "move" && dragItemId) {
      const { vx, vy } = velocityRef.current;
      if (Math.abs(vx) > 0.3 || Math.abs(vy) > 0.3) {
        applyInertia(dragItemId, vx * 0.5, vy * 0.5);
      }
    }
    setIsDraggingItem(false);
    setDragItemId(null);
    setTransformOp(null);
    setActiveTransformOp(null);
  };

  // ── Alpha hit test ────────────────────────────────────────────────────────
  // Devuelve true si el pixel en (normX,normY) ∈ [0,1]² tiene alpha > 20
  const isOpaqueAt = (itemId: string, normX: number, normY: number): boolean => {
    const data = imageDataCache.current.get(itemId);
    if (!data) return true; // cache aún no lista → asumir opaco
    const SIZE = 64;
    const px = Math.max(0, Math.min(SIZE - 1, Math.floor(normX * SIZE)));
    const py = Math.max(0, Math.min(SIZE - 1, Math.floor(normY * SIZE)));
    return data[(py * SIZE + px) * 4 + 3] > 20;
  };

  const handleContainerPointerDown = (e: React.PointerEvent) => {
    if (inertiaRef.current) { cancelAnimationFrame(inertiaRef.current); inertiaRef.current = null; }
    if (mode !== "items") return;
    if (!containerRef.current) { setSelectedItemId(null); return; }

    const rect    = containerRef.current.getBoundingClientRect();
    const clientX = e.clientX;
    const clientY = e.clientY;

    // Items de mayor a menor Z-index (el más encima primero)
    const sorted = [...designItems]
      .map((item, idx) => ({ item, z: item.id === selectedItemId ? 1000 : 10 + idx }))
      .sort((a, b) => b.z - a.z);

    for (const { item } of sorted) {
      const s            = item.scale ?? 1;
      const perspScale   = item.lockPosition ? 1.0 : calcPerspectiveScale(item.y, horizonYPct);
      const finalSize    = 120 * s * perspScale;
      const half         = finalSize / 2;
      const centerX      = rect.left + (item.x / 100) * rect.width;
      const centerY      = rect.top  + (item.y / 100) * rect.height;

      // Relativo al centro del item
      let relX = clientX - centerX;
      let relY = clientY - centerY;

      // Des-rotar para quedar en espacio de imagen
      const r = item.rotation ?? 0;
      if (r !== 0) {
        const rad  = -r * Math.PI / 180;
        const cos  = Math.cos(rad);
        const sin  = Math.sin(rad);
        const rx   = cos * relX - sin * relY;
        const ry   = sin * relX + cos * relY;
        relX = rx; relY = ry;
      }

      // Bounding box — suficiente para selección precisa sin rechazar clics válidos
      if (relX < -half || relX > half || relY < -half || relY > half) continue;

      // ¡Hit! — iniciar drag
      e.preventDefault();
      e.stopPropagation();
      setSelectedItemId(item.id);
      setDragItemId(item.id);
      setIsDraggingItem(true);
      setTransformOp("move");
      setActiveTransformOp("move");
      triggerTouchFeedback(item.id);

      const px = ((clientX - rect.left) / rect.width)  * 100;
      const py = ((clientY - rect.top)  / rect.height) * 100;
      transformStart.current = { x: px - item.x, y: py - item.y, scale: s, rotation: r };
      velocityRef.current    = { vx: 0, vy: 0, lastX: px, lastY: py, lastTime: performance.now() };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    // Ningún item golpeado → deseleccionar
    setSelectedItemId(null);
  };

  // ─── File upload / Camera ─────────────────────────────────────
  // IMPORTANTE: No usar FileReader.readAsDataURL directamente — preserva metadatos EXIF
  // de orientación de fotos de celular, causando que los píxeles y la visualización
  // queden desincronizados con el servidor de IA (que procesa píxeles crudos sin EXIF).
  // Solución: redibujar en canvas al cargar — "hornea" la rotación EXIF en los píxeles
  // y garantiza orientación consistente en todos los módulos y envíos a IA.
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // Dibujar en canvas aplica la rotación EXIF del navegador en los píxeles
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      const normalized = c.toDataURL("image/jpeg", 0.92);
      URL.revokeObjectURL(objectUrl);
      setGardenImage(normalized);
      setModalOpen(false);
    };
    img.onerror = () => URL.revokeObjectURL(objectUrl);
    img.src = objectUrl;
  };

  const handleCapture = (base64: string) => {
    setGardenImage(base64);
    setCameraMode(false);
    setModalOpen(false);
  };

  // ─── Computed ─────────────────────────────────────────────────
  const hasMask = strokes.length > 0;
  const liveAreaM2 = getMaskAreaM2();

  // ─── Render ───────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col relative w-full h-full overflow-hidden bg-stone-100">
      {/* Empty state */}
      {!gardenImage ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-6">
          <div className="w-24 h-24 bg-primary/10 rounded-full flex items-center justify-center">
            <Camera className="w-12 h-12 text-primary" />
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-foreground mb-2">Escanea el jardín</h2>
            <p className="text-muted-foreground max-w-sm">
              Toma una foto del área de trabajo para comenzar a diseñar.
            </p>
          </div>
          <Button size="lg" className="h-14 text-lg px-8 rounded-xl shadow-md" onClick={() => setModalOpen(true)}>
            Cargar imagen
          </Button>
        </div>
      ) : (
        <>
          {/* Mode toolbar — invisible in readOnly (preserves height so containerRef dims match) */}
          <div className={`shrink-0 flex items-center justify-between px-3 py-2 bg-card border-b border-border gap-2${readOnly ? " invisible pointer-events-none select-none" : ""}`}>
            <div className="flex gap-1">
              {(
                [
                  { id: "items", icon: Move, label: "Elementos" },
                  { id: "mask", icon: Eraser, label: "Pintar zona" },
                ] as const
              ).map(({ id, icon: Icon, label }) => (
                <Button
                  key={id}
                  size="sm"
                  variant={mode === id ? "default" : "outline"}
                  className="h-9 gap-1.5 rounded-lg text-xs"
                  onClick={() => setMode(id)}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{label}</span>
                </Button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              {import.meta.env.DEV && (
                <Button
                  size="sm"
                  variant={debugMode ? "default" : "ghost"}
                  className={`h-9 text-xs gap-1.5 ${debugMode ? "bg-red-500 text-white hover:bg-red-600" : ""}`}
                  onClick={() => setDebugMode((v) => !v)}
                  title="Phase 6: Debug coords"
                >
                  <GripVertical className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Debug</span>
                </Button>
              )}
              {canUndo && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 text-xs gap-1.5 border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                  onClick={() => {
                    undoGardenImage();
                    toast({ title: "Foto restaurada", description: `Paso ${imageHistoryCount} deshecho.` });
                  }}
                  title={`Deshacer ${imageHistoryCount} cambio(s) de IA`}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Restaurar foto</span>
                  {imageHistoryCount > 1 && (
                    <span className="bg-amber-200 text-amber-800 text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                      {imageHistoryCount}
                    </span>
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* Canvas area — in readOnly: same ref+dims, no event handlers */}
          <div
            ref={containerRef}
            id="canvas-container"
            className="flex-1 relative overflow-hidden design-canvas-area"
            onDragOver={readOnly ? undefined : handleDragOver}
            onDrop={readOnly ? undefined : handleDrop}
            onPointerDown={readOnly ? undefined : handleContainerPointerDown}
            onPointerMove={readOnly ? undefined : handleContainerPointerMove}
            onPointerUp={readOnly ? undefined : handleContainerPointerUp}
          >
            {/* Garden image */}
            <img
              src={gardenImage}
              alt="Jardín"
              className="absolute inset-0 w-full h-full object-contain"
              draggable={false}
            />

            {/* Drawing / scale canvas — hidden in readOnly */}
            {!readOnly && (
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
                style={{
                  pointerEvents: mode !== "items" ? "auto" : "none",
                  cursor: mode === "mask" ? "crosshair" : "default",
                  touchAction: "none",
                }}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
              />
            )}

            {/* Design items — always rendered; readOnly strips all interaction */}
            {(readOnly || mode === "items") &&
              [...designItems]
                .map((item, originalIdx) => ({ item, originalIdx }))
                .sort((a, b) => (a.item.y ?? 50) - (b.item.y ?? 50))
                .map(({ item, originalIdx }, sortIdx) => {
                const isSelected = !readOnly && selectedItemId === item.id;
                const isBeingTransformed = isSelected && activeTransformOp !== null;
                const hasFeedback = !readOnly && touchFeedbackId === item.id;
                const s = item.scale || 1;
                const r = item.rotation || 0;
                const tXdeg = Math.round((item.tiltX ?? 0) * 180 / Math.PI);
                const tYdeg = Math.round((item.tiltY ?? 0) * 180 / Math.PI);
                const hasTilt = tXdeg !== 0 || tYdeg !== 0;
                const BASE_SIZE = 120;
                const size = BASE_SIZE * s;
                const perspectiveScale = item.lockPosition ? 1.0 : calcPerspectiveScale(item.y, horizonYPct);
                const finalSize = size * perspectiveScale;
                const shadowBlur = Math.round(6 + s * 4);
                const shadowOffsetY = Math.round(4 + s * 3);
                const shadowOpacity = 0.25 + (item.y / 100) * 0.15;
                const perspDist = Math.round(finalSize * 3);
                return (
                  <div
                    key={item.id}
                    className="absolute select-none"
                    style={{
                      left: `${item.x}%`,
                      top: `${item.y}%`,
                      width: `${finalSize}px`,
                      height: `${finalSize}px`,
                      transform: [
                        "translate(-50%,-50%)",
                        `rotate(${r}deg)`,
                        ...(hasTilt ? [
                          `perspective(${perspDist}px)`,
                          `rotateX(${tXdeg}deg)`,
                          `rotateY(${tYdeg}deg)`,
                        ] : []),
                        ...(hasFeedback ? ["scale(1.06)"] : []),
                      ].join(" "),
                      touchAction: readOnly ? "none" : "none",
                      // pointer-events: none → el contenedor maneja el hit-test por alpha
                      // Los handles (scale/rotate/delete) tienen pointer-events: auto propios
                      pointerEvents: "none",
                      // originalIdx = orden de inserción → último colocado siempre adelante
                      zIndex: isSelected ? 1000 : 10 + originalIdx,
                      isolation: "isolate",       // evita fusión de filtros entre items
                      willChange: isBeingTransformed ? "transform, filter" : "auto",
                      transition: isBeingTransformed ? "none" : "transform 0.12s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                    }}
                  >
                    {/* Main item — drag to move */}
                    <div
                      className={`w-full h-full relative${readOnly ? "" : " cursor-grab active:cursor-grabbing"}`}
                      style={{
                        filter: isSelected
                          ? `brightness(1.15) saturate(1.4) drop-shadow(0 1px 4px rgba(0,0,0,0.20)) drop-shadow(0 0 8px rgba(255,255,255,0.4))`
                          : `brightness(1.15) saturate(1.4) drop-shadow(0 1px 3px rgba(0,0,0,${shadowOpacity * 0.4}))`,
                        transition: isBeingTransformed ? "none" : "filter 0.2s ease-out",
                      }}
                    >
                      {item.imageData ? (
                        <img
                          src={item.imageData}
                          alt={item.name}
                          className="w-full h-full object-contain"
                          draggable={false}
                          style={{
                            // Desvanece el pie del elemento hacia transparente → efecto "plantado en el suelo"
                            maskImage: "linear-gradient(to top, transparent 0%, black 20%, black 100%)",
                            WebkitMaskImage: "linear-gradient(to top, transparent 0%, black 20%, black 100%)",
                          }}
                        />
                      ) : (
                        <div className="w-full h-full rounded-xl bg-primary/90 flex items-center justify-center shadow-lg">
                          <span className="text-white font-bold" style={{ fontSize: `${Math.max(14, s * 20)}px` }}>
                            {item.name.charAt(0).toUpperCase()}
                          </span>
                        </div>
                      )}
                    </div>


                    {/* Selection bounding box + controls — pointer-events:auto para operar sobre parent:none */}
                    {isSelected && (() => {
                      const bbox = item.imageData ? (__contentBBoxCache.get(item.imageData) ?? FULL_BBOX) : FULL_BBOX;
                      // Pequeño padding visual (1.5% del contenedor) para que el borde no toque la silueta.
                      const PAD = 0.015;
                      const bl = Math.max(0, bbox.l - PAD);
                      const bt = Math.max(0, bbox.t - PAD);
                      const br = Math.min(1, bbox.r + PAD);
                      const bb = Math.min(1, bbox.b + PAD);
                      return (
                      <div
                        className="absolute"
                        style={{
                          pointerEvents: "auto",
                          left:   `${bl * 100}%`,
                          top:    `${bt * 100}%`,
                          width:  `${(br - bl) * 100}%`,
                          height: `${(bb - bt) * 100}%`,
                        }}
                      >
                        <div
                          className="absolute inset-0 pointer-events-none"
                          style={{
                            border: "2px solid rgba(255,255,255,0.9)",
                            borderRadius: "8px",
                            boxShadow: "0 0 0 1px rgba(14,165,233,0.6), 0 0 16px rgba(14,165,233,0.2), inset 0 0 0 1px rgba(255,255,255,0.3)",
                          }}
                        />

                        {[
                          { cx: ui.scaleHandleOffset, cy: ui.scaleHandleOffset, cursor: "nwse-resize" },
                          { cx: `calc(100% - ${parseInt(ui.scaleHandleOffset) * -1}px)`, cy: ui.scaleHandleOffset, cursor: "nesw-resize" },
                          { cx: ui.scaleHandleOffset, cy: `calc(100% - ${parseInt(ui.scaleHandleOffset) * -1}px)`, cursor: "nesw-resize" },
                          { cx: `calc(100% - ${parseInt(ui.scaleHandleOffset) * -1}px)`, cy: `calc(100% - ${parseInt(ui.scaleHandleOffset) * -1}px)`, cursor: "nwse-resize" },
                        ].map((h, i) => (
                          <div
                            key={`sh${i}`}
                            className="absolute flex items-center justify-center z-20"
                            style={{ width: `${ui.handleSize}px`, height: `${ui.handleSize}px`, left: h.cx, top: h.cy, cursor: h.cursor, touchAction: "none" }}
                            onPointerDown={(e) => handleScalePointerDown(e, item.id)}
                          >
                            <div
                              className="rounded-[3px] pointer-events-none"
                              style={{
                                width: `${activeTransformOp === "scale" ? ui.handleDotActiveSize : ui.handleDotSize}px`,
                                height: `${activeTransformOp === "scale" ? ui.handleDotActiveSize : ui.handleDotSize}px`,
                                background: activeTransformOp === "scale" ? "#0ea5e9" : "white",
                                border: "2px solid #0ea5e9",
                                boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                                transition: "all 0.1s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                              }}
                            />
                          </div>
                        ))}

                        <div
                          className="absolute z-20 flex flex-col items-center"
                          style={{ left: "50%", top: ui.rotateStalkTop, transform: "translateX(-50%)", touchAction: "none" }}
                        >
                          <div
                            className="pointer-events-none"
                            style={{ width: "1.5px", height: `${ui.rotateStalkHeight}px`, background: "rgba(255,255,255,0.8)", boxShadow: "0 0 2px rgba(14,165,233,0.5)" }}
                          />
                          <div
                            className="rounded-full flex items-center justify-center cursor-grab"
                            style={{ width: `${ui.rotateHandleSize}px`, height: `${ui.rotateHandleSize}px` }}
                            onPointerDown={(e) => handleRotatePointerDown(e, item.id)}
                          >
                            <div
                              className="rounded-full flex items-center justify-center pointer-events-none"
                              style={{
                                width: `${activeTransformOp === "rotate" ? ui.rotateHandleDotActiveSize : ui.rotateHandleDotSize}px`,
                                height: `${activeTransformOp === "rotate" ? ui.rotateHandleDotActiveSize : ui.rotateHandleDotSize}px`,
                                background: activeTransformOp === "rotate" ? "#0ea5e9" : "white",
                                border: "2px solid #0ea5e9",
                                boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
                                transition: "all 0.1s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                              }}
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={activeTransformOp === "rotate" ? "white" : "#0ea5e9"} strokeWidth="3" strokeLinecap="round">
                                <path d="M21 12a9 9 0 1 1-6.2-8.56" />
                                <path d="M21 3v5h-5" />
                              </svg>
                            </div>
                          </div>
                        </div>

                        <div
                          className="absolute z-20"
                          style={{ right: ui.deleteOffset, top: ui.deleteOffset }}
                        >
                          <button
                            className="rounded-full flex items-center justify-center"
                            style={{ width: `${ui.deleteButtonSize}px`, height: `${ui.deleteButtonSize}px`, transition: "transform 0.1s ease-out" }}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              if (navigator.vibrate) navigator.vibrate(12);
                              removeDesignItem(item.id);
                              setSelectedItemId(null);
                            }}
                          >
                            <div
                              className="rounded-full text-white flex items-center justify-center pointer-events-none"
                              style={{
                                width: `${ui.deleteIconSize}px`,
                                height: `${ui.deleteIconSize}px`,
                                background: "linear-gradient(135deg, #ef4444, #dc2626)",
                                boxShadow: "0 2px 6px rgba(239,68,68,0.4)",
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </div>
                          </button>
                        </div>

                        {/* ── 3D Tilt panel ── floating below item ───── */}
                        <div
                          className="absolute left-1/2 flex flex-col items-center gap-1.5 z-30"
                          style={{
                            bottom: "-88px",
                            transform: "translateX(-50%)",
                            background: "rgba(10,12,24,0.92)",
                            backdropFilter: "blur(8px)",
                            border: "1px solid rgba(255,255,255,0.12)",
                            borderRadius: "12px",
                            padding: "8px 12px",
                            whiteSpace: "nowrap",
                            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
                            minWidth: "220px",
                          }}
                          onPointerDown={e => e.stopPropagation()}
                        >
                          <span className="text-[10px] text-white/40 uppercase tracking-wide font-semibold select-none">Inclinación 3D</span>
                          <div className="flex items-center gap-2 w-full">
                            <span className="text-[10px] text-purple-300 w-14 shrink-0 select-none">⤸ Eje X</span>
                            <input
                              type="range" min={-90} max={90} step={1}
                              value={tXdeg}
                              onChange={e => updateDesignItem(item.id, { tiltX: Number(e.target.value) * Math.PI / 180 })}
                              className="flex-1 h-1.5 accent-purple-500 cursor-pointer"
                            />
                            <span className="text-[10px] text-white/50 font-mono w-8 text-right select-none">{tXdeg}°</span>
                          </div>
                          <div className="flex items-center gap-2 w-full">
                            <span className="text-[10px] text-purple-300 w-14 shrink-0 select-none">⤹ Eje Y</span>
                            <input
                              type="range" min={-90} max={90} step={1}
                              value={tYdeg}
                              onChange={e => updateDesignItem(item.id, { tiltY: Number(e.target.value) * Math.PI / 180 })}
                              className="flex-1 h-1.5 accent-purple-500 cursor-pointer"
                            />
                            <span className="text-[10px] text-white/50 font-mono w-8 text-right select-none">{tYdeg}°</span>
                          </div>
                          {(tXdeg !== 0 || tYdeg !== 0) && (
                            <button
                              className="text-[10px] text-white/40 hover:text-white/80 transition-colors mt-0.5"
                              onClick={() => updateDesignItem(item.id, { tiltX: 0, tiltY: 0 })}
                            >⊡ Reset 3D</button>
                          )}
                        </div>
                      </div>
                    ); })()}
                  </div>
                );
              })}

            {/* Obstacle preview overlay */}
            {obstaclePreview && obstacleOverlayUrl && (
              <div className="absolute inset-0" style={{ zIndex: 25 }}>
                <img
                  src={obstacleOverlayUrl}
                  alt=""
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                  draggable={false}
                />
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/80 backdrop-blur-md rounded-2xl px-5 py-3 shadow-2xl">
                  <div className="text-white text-sm font-medium mr-2">
                    {obstacleCount} obstaculo(s) detectado(s)
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-10 gap-1.5 text-sm rounded-xl"
                    onClick={handleRemoveObstacles}
                  >
                    <Check className="w-4 h-4" />
                    Eliminar todo
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-10 gap-1.5 text-sm rounded-xl bg-white/10 border-white/30 text-white hover:bg-white/20 hover:text-white"
                    onClick={handleCancelObstacles}
                  >
                    <X className="w-4 h-4" />
                    Cancelar
                  </Button>
                </div>
              </div>
            )}

            {/* Processing overlay */}
            {isProcessing && (
              <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-4 z-30 backdrop-blur-sm">
                <div className="w-16 h-16 rounded-2xl bg-white/10 flex items-center justify-center">
                  <Loader2 className="w-8 h-8 text-white animate-spin" />
                </div>
                <p className="text-white font-semibold text-lg text-center px-4">{processingMsg}</p>
                <p className="text-white/60 text-sm">Esto puede tardar 30-90 segundos</p>
              </div>
            )}
          </div>

          {/* Mask mode toolbar */}
          {mode === "mask" && (
            <div className="shrink-0 bg-card border-t border-border px-3 py-2 flex flex-col gap-2">

              {/* Terrain info banner */}
              {terrainMap && (
                <div className="flex items-center gap-2 text-xs bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-1.5 flex-wrap">
                  <div className="flex items-center gap-1.5 text-emerald-700 font-medium">
                    <div className="w-2.5 h-2.5 rounded-sm bg-emerald-400 opacity-70" />
                    Tierra detectada: <strong>{Math.round(terrainMap.soilFraction * 100)}%</strong>
                    {terrainMap.soilM2 != null && <> · <strong>{terrainMap.soilM2.toFixed(1)} m²</strong></>}
                  </div>
                  <button
                    className={`ml-auto text-xs px-2 py-0.5 rounded-full border transition-colors ${showOverlay ? "bg-emerald-600 text-white border-emerald-600" : "border-emerald-300 text-emerald-600"}`}
                    onClick={() => setShowOverlay((v) => !v)}
                  >
                    {showOverlay ? "Ocultar mapa" : "Ver mapa"}
                  </button>
                </div>
              )}

              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-1 min-w-[160px]">
                  <span className="text-xs text-muted-foreground shrink-0">Pincel</span>
                  <Slider
                    value={[brushSize]}
                    onValueChange={([v]) => setBrushSize(v)}
                    min={10}
                    max={100}
                    step={5}
                    className="flex-1"
                  />
                  <span className="text-xs font-mono w-7 text-right">{brushSize}</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 gap-1.5 text-xs"
                  onClick={() => { setStrokes([]); setCurrentStroke([]); }}
                  disabled={!hasMask}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Limpiar
                </Button>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground shrink-0">Material:</span>
                <div className="flex gap-1 flex-wrap flex-1">
                  {materials.filter(m => m.enabled).map(m => {
                    const stoneSwatches: Record<string, string> = {
                      "white-stone":  "#e8e4de",
                      "grey-stone":   "#8a8a8a",
                      "red-stone":    "#b03a2e",
                      "black-stone":  "#222222",
                      "multi-stone":  "linear-gradient(135deg,#e8e4de 25%,#8a8a8a 25%,#8a8a8a 50%,#b03a2e 50%,#b03a2e 75%,#222 75%)",
                    };
                    const swatch = stoneSwatches[m.id];
                    return (
                      <button
                        key={m.id}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                          activeMaterialId === m.id
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background border-border hover:bg-accent text-foreground"
                        }`}
                        onClick={() => setActiveMaterialId(m.id)}
                      >
                        {swatch && (
                          <span
                            className="w-3 h-3 rounded-sm shrink-0 border border-black/10"
                            style={{ background: swatch }}
                          />
                        )}
                        {m.name}
                      </button>
                    );
                  })}
                  <button
                    className="px-2 py-1.5 rounded-lg text-xs text-muted-foreground border border-dashed border-border hover:bg-accent"
                    onClick={() => setShowMaterialsConfig(true)}
                  >
                    <Settings className="w-3 h-3" />
                  </button>
                </div>
              </div>

              <div className="flex gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-10 gap-1.5 text-sm"
                  onClick={handleInpaint}
                  disabled={!hasMask || isProcessing}
                >
                  <Eraser className="w-4 h-4" />
                  Borrar objeto
                </Button>
                <Button
                  size="sm"
                  className="h-10 gap-1.5 text-sm flex-1 bg-emerald-700 hover:bg-emerald-800 text-white"
                  onClick={() => handleApplyMaterial(activeMaterialId)}
                  disabled={isProcessing || (!gardenImage) || (!hasMask && activeMaterial.type !== "grass")}
                  title={`Diseñar en área seleccionada · ${activeMaterial.name} · $${activeMaterial.pricePerM2}/m²`}
                >
                  <Layers className="w-4 h-4" />
                  Diseñar en área seleccionada
                </Button>
              </div>

              {!hasMask && !terrainMap && (
                <p className="text-xs text-muted-foreground text-center">
                  Pinta el area para borrar objetos o aplicar materiales
                </p>
              )}

              {surfaceType && surfaceType !== "unknown" && hasMask && (
                <div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-1.5 font-medium ${
                  surfaceType === "concrete"
                    ? "bg-orange-50 text-orange-700"
                    : surfaceType === "grass"
                    ? "bg-blue-50 text-blue-700"
                    : "bg-emerald-50 text-emerald-700"
                }`}>
                  <div className={`w-2 h-2 rounded-full ${
                    surfaceType === "concrete" ? "bg-orange-500" : surfaceType === "grass" ? "bg-blue-500" : "bg-emerald-500"
                  }`} />
                  Zona pintada:&nbsp;
                  <strong>
                    {surfaceType === "concrete" ? "Concreto — no apto" : surfaceType === "grass" ? "Pasto existente" : "Tierra — apta para pasto"}
                  </strong>
                </div>
              )}

            </div>
          )}

          {/* [Polygon mode removed — use CAD Pro] */}
          {false && (
            <div className="shrink-0 bg-card border-t border-border px-3 py-2 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-xs flex-wrap">
                {!polygonClosed ? (
                  <span className="text-muted-foreground">
                    {polygonPoints.length === 0
                      ? "Toca puntos sobre la imagen para crear el polígono"
                      : polygonPoints.length < 3
                      ? `${polygonPoints.length} punto(s) — necesitas al menos 3`
                      : `${polygonPoints.length} puntos — toca el punto 1 (amarillo) para cerrar`}
                  </span>
                ) : (
                  <span className="text-emerald-700 font-medium">
                    Polígono cerrado con {polygonPoints.length} puntos — arrastra los vértices para ajustar
                  </span>
                )}
              </div>

              {polygonClosed && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground shrink-0">Material:</span>
                  <div className="flex gap-1 flex-wrap flex-1">
                    {materials.filter(m => m.enabled).map(m => (
                      <button
                        key={m.id}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                          activeMaterialId === m.id
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background border-border hover:bg-accent text-foreground"
                        }`}
                        onClick={() => setActiveMaterialId(m.id)}
                      >
                        {m.name}
                      </button>
                    ))}
                    <button
                      className="px-2 py-1.5 rounded-lg text-xs text-muted-foreground border border-dashed border-border hover:bg-accent"
                      onClick={() => setShowMaterialsConfig(true)}
                    >
                      <Settings className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )}

              <div className="flex gap-2 flex-wrap">
                {polygonPoints.length >= 3 && !polygonClosed && (
                  <Button
                    size="sm"
                    className="h-10 gap-1.5 text-sm bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => setPolygonClosed(true)}
                  >
                    <Pentagon className="w-4 h-4" />
                    Cerrar poligono
                  </Button>
                )}

                {polygonClosed && (
                  <Button
                    size="sm"
                    className="h-10 gap-1.5 text-sm"
                    variant="outline"
                    onClick={() => {
                      if (polygonPoints.length < 2) return;
                      setPolygonMeasureSide(0);
                      setPolygonSideInput("");
                      setPolygonSideDialog(true);
                    }}
                  >
                    <Ruler className="w-4 h-4" />
                    {polygonPxPerMeter ? "Recalibrar lado" : "Medir un lado"}
                  </Button>
                )}

                {polygonClosed && (
                  <Button
                    size="sm"
                    className="h-10 gap-1.5 text-sm bg-emerald-700 hover:bg-emerald-800 text-white flex-1"
                    onClick={() => handleApplyMaterial(activeMaterialId)}
                    disabled={isProcessing}
                  >
                    <Layers className="w-4 h-4" />
                    Diseñar en área seleccionada
                  </Button>
                )}

                <Button
                  size="sm"
                  variant="outline"
                  className="h-10 gap-1.5 text-sm ml-auto"
                  onClick={() => { setPolygonPoints([]); setPolygonClosed(false); setPolygonPxPerMeter(null); setPolygonMeasureSide(null); }}
                  disabled={polygonPoints.length === 0}
                >
                  <RotateCcw className="w-4 h-4" />
                  Limpiar
                </Button>
              </div>

              {polygonClosed && polygonPoints.length >= 3 && (() => {
                const ppm = polygonPxPerMeter ?? pixelsPerMeter;
                if (!ppm) return (
                  <div className="text-xs text-orange-600 bg-orange-50 rounded-lg px-3 py-1.5">
                    Calibra la escala: usa "Medir un lado" para calcular m² y costo
                  </div>
                );
                const areaPx = polygonAreaPx(polygonPoints);
                const areaM2 = areaPx / (ppm! * ppm!);
                const cost = areaM2 * pricePerM2;
                return (
                  <div className="flex items-center gap-4 text-sm bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-emerald-600">Área:</span>
                      <strong className="text-emerald-800 text-base">{areaM2.toFixed(1)} m²</strong>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-emerald-600">Precio/m²:</span>
                      <strong className="text-emerald-800">${pricePerM2.toLocaleString()}</strong>
                    </div>
                    <div className="flex items-center gap-1.5 ml-auto">
                      <span className="text-emerald-600">Total:</span>
                      <strong className="text-emerald-900 text-lg">${cost.toLocaleString()}</strong>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* [Scale mode removed — use CAD Pro] */}

          {/* Stats bar — materials cost breakdown */}
          <div className="shrink-0 bg-stone-50 border-t border-border px-3 py-2 flex items-center gap-3 text-xs flex-wrap">
            <span className="text-muted-foreground">Material activo:</span>
            <span className="font-semibold text-foreground">{activeMaterial.name}</span>
            <span className="text-muted-foreground">·</span>
            <span className="font-medium text-emerald-700">${activeMaterial.pricePerM2}/m²</span>

            {materialCosts.length > 0 && (
              <>
                <span className="text-muted-foreground ml-3">Materiales:</span>
                <span className="font-bold text-primary">${totalMaterialCost.toLocaleString()}</span>
                {totalProjectCost > totalMaterialCost && (
                  <>
                    <span className="text-muted-foreground">+</span>
                    <span className="text-muted-foreground">Plantas: ${(totalProjectCost - totalMaterialCost).toLocaleString()}</span>
                  </>
                )}
                <span className="text-muted-foreground ml-2">Total:</span>
                <span className="font-bold text-lg text-primary">${totalProjectCost.toLocaleString()}</span>
                <button
                  className="text-[10px] text-red-500 underline ml-auto"
                  onClick={clearMaterialCosts}
                >
                  Limpiar costos
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* Image source dialog */}
      <Dialog open={modalOpen} onOpenChange={(o) => { setModalOpen(o); if (!o) setCameraMode(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Cargar imagen del jardín</DialogTitle>
            <DialogDescription>Usa la cámara o selecciona un archivo</DialogDescription>
          </DialogHeader>
          {cameraMode ? (
            <CameraCapture onCapture={handleCapture} onCancel={() => setCameraMode(false)} />
          ) : (
            <div className="flex flex-col gap-3 py-2">
              <Button className="h-14 gap-3 text-base rounded-xl" onClick={() => setCameraMode(true)}>
                <Camera className="w-5 h-5" /> Tomar foto
              </Button>
              <label className="cursor-pointer">
                <Button variant="outline" className="h-14 gap-3 text-base rounded-xl w-full" asChild>
                  <span>
                    <ImageIcon className="w-5 h-5" /> Seleccionar archivo
                  </span>
                </Button>
                <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
              </label>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {/* Materials configuration dialog */}
      <Dialog open={showMaterialsConfig} onOpenChange={setShowMaterialsConfig}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Configurar materiales</DialogTitle>
            <DialogDescription>
              Edita precios por m² y activa o desactiva materiales del catalogo.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-2">
            {materials.map(m => (
              <div
                key={m.id}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors ${
                  m.enabled ? "bg-background border-border" : "bg-muted/50 border-border/50 opacity-60"
                }`}
              >
                <button
                  className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    m.enabled ? "bg-primary border-primary" : "bg-background border-border"
                  }`}
                  onClick={() => updateMaterial(m.id, { enabled: !m.enabled })}
                >
                  {m.enabled && <Check className="w-3 h-3 text-primary-foreground" />}
                </button>

                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{m.name}</div>
                  <div className="text-[10px] text-muted-foreground">{m.type}</div>
                </div>

                {editingMaterialPrice === m.id ? (
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const val = parseFloat(materialPriceInput);
                      if (val > 0) updateMaterial(m.id, { pricePerM2: val });
                      setEditingMaterialPrice(null);
                    }}
                  >
                    <span className="text-xs text-muted-foreground">$</span>
                    <input
                      autoFocus
                      className="w-20 border border-border rounded px-1.5 py-0.5 text-xs bg-background"
                      value={materialPriceInput}
                      onChange={(e) => setMaterialPriceInput(e.target.value)}
                      type="number"
                      min="1"
                    />
                    <Button size="sm" type="submit" className="h-6 text-[10px] px-2">OK</Button>
                  </form>
                ) : (
                  <button
                    className="text-sm font-semibold text-emerald-700 hover:underline shrink-0"
                    onClick={() => { setEditingMaterialPrice(m.id); setMaterialPriceInput(String(m.pricePerM2)); }}
                  >
                    ${m.pricePerM2}/m²
                  </button>
                )}
              </div>
            ))}
          </div>

          {materialCosts.length > 0 && (
            <div className="border-t border-border pt-3 mt-1">
              <div className="text-xs font-semibold text-muted-foreground mb-2">Desglose de costos aplicados</div>
              <div className="flex flex-col gap-1">
                {materialCosts.map((c, i) => (
                  <div key={i} className="flex items-center justify-between text-xs px-2 py-1 bg-stone-50 rounded-lg">
                    <span>{c.materialName}</span>
                    <span className="text-muted-foreground">
                      {c.areaM2 > 0 ? `${c.areaM2.toFixed(1)} m² × $${c.pricePerM2}` : "—"}
                    </span>
                    <span className="font-semibold">${c.total.toLocaleString()}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between text-sm font-bold px-2 py-1.5 border-t border-border mt-1">
                  <span>Total materiales</span>
                  <span className="text-primary">${totalMaterialCost.toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button onClick={() => setShowMaterialsConfig(false)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
});

DesignCanvas.displayName = "DesignCanvas";
export default DesignCanvas;

