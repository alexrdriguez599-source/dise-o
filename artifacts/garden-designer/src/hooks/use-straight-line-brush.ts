/**
 * useStraightLineBrush
 *
 * Hook aislado para dibujo de líneas rectas perfectas.
 * SIN dependencia del módulo CAD.
 *
 * Flujo:
 *   onPointerDown → guarda punto inicial (con snap opcional al borde más cercano)
 *   onPointerMove → preview en tiempo real (línea start → cursor, ambos snapeados)
 *   onPointerUp   → dibuja línea final y guarda el trazo
 *
 * v2: Edge Snapping — cuando snapEnabled=true y edgeMap está disponible,
 *     cada punto del trazo se "pega" automáticamente al borde más cercano
 *     dentro del radio snapRadius (default 15px).
 */

import { useRef, useCallback, useState, useEffect } from "react";
import { type EdgeMap, snapToEdge, interpolateSnapped } from "@/services/edge-detector";

// ─── Tipos ────────────────────────────────────────────────────────────────────
export interface BrushPoint {
  x: number;
  y: number;
}

export interface BrushLine {
  start: BrushPoint;
  end: BrushPoint;
}

export interface StraightLineBrushOptions {
  lineWidth?: number;
  strokeStyle?: string;
  previewStyle?: string;
  lineCap?: CanvasLineCap;
  /** Mapa de bordes para snap (de buildEdgeMapFromImage) */
  edgeMap?: EdgeMap | null;
  /** Activar/desactivar snap a bordes */
  snapEnabled?: boolean;
  /** Radio máximo de snap en píxeles (default 15) */
  snapRadius?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getCanvasPoint(
  e: React.PointerEvent<HTMLCanvasElement>,
  canvas: HTMLCanvasElement
): BrushPoint {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  start: BrushPoint,
  end: BrushPoint,
  style: string,
  width: number,
  cap: CanvasLineCap
) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = cap;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.restore();
}

/** Dibuja un indicador visual de snap (pequeño círculo brillante) */
function drawSnapIndicator(
  ctx: CanvasRenderingContext2D,
  pt: BrushPoint,
  snapped: boolean,
  radius: number
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, radius + 3, 0, Math.PI * 2);
  ctx.fillStyle = snapped ? "#f59e0b" : "#10b981"; // amarillo = snapped, verde = libre
  ctx.shadowColor = snapped ? "#f59e0b" : "#10b981";
  ctx.shadowBlur = 6;
  ctx.fill();
  ctx.restore();
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useStraightLineBrush(options: StraightLineBrushOptions = {}) {
  const {
    lineWidth    = 3,
    strokeStyle  = "#10b981",
    previewStyle = "#10b98180",
    lineCap      = "round",
    edgeMap      = null,
    snapEnabled  = false,
    snapRadius   = 15,
  } = options;

  // Refs para acceso sin re-render dentro de callbacks
  const edgeMapRef     = useRef<EdgeMap | null>(edgeMap);
  const snapEnabledRef = useRef(snapEnabled);
  const snapRadiusRef  = useRef(snapRadius);

  useEffect(() => { edgeMapRef.current = edgeMap; }, [edgeMap]);
  useEffect(() => { snapEnabledRef.current = snapEnabled; }, [snapEnabled]);
  useEffect(() => { snapRadiusRef.current = snapRadius; }, [snapRadius]);

  // Punto de inicio del trazo actual (ya snapeado si aplica)
  const startRef      = useRef<BrushPoint | null>(null);
  const startSnapped  = useRef(false);

  // Snapshot del canvas antes de dibujar el preview
  const savedImageRef = useRef<ImageData | null>(null);

  // Lista de líneas finalizadas
  const [lines, setLines]       = useState<BrushLine[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);

  // ── Snap helper ────────────────────────────────────────────────────────────
  function applySnap(raw: BrushPoint): { pt: BrushPoint; snapped: boolean } {
    const em = edgeMapRef.current;
    if (!snapEnabledRef.current || !em) return { pt: raw, snapped: false };
    const result = snapToEdge(raw.x, raw.y, em, snapRadiusRef.current);
    const blended = interpolateSnapped(raw, result, 0.9);
    return { pt: blended, snapped: result.snapped };
  }

  // ── onPointerDown ──────────────────────────────────────────────────────────
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = e.currentTarget;
      canvas.setPointerCapture(e.pointerId);

      const raw = getCanvasPoint(e, canvas);
      const { pt, snapped } = applySnap(raw);
      startRef.current = pt;
      startSnapped.current = snapped;

      const ctx = canvas.getContext("2d");
      if (ctx) {
        savedImageRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      }

      setIsDrawing(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ── onPointerMove ──────────────────────────────────────────────────────────
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!startRef.current || !savedImageRef.current) return;

      const canvas = e.currentTarget;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const rawEnd = getCanvasPoint(e, canvas);
      const { pt: end, snapped: endSnapped } = applySnap(rawEnd);

      // Restaurar estado pre-preview
      ctx.putImageData(savedImageRef.current, 0, 0);

      // Preview semitransparente
      drawLine(ctx, startRef.current, end, previewStyle, lineWidth, lineCap);

      // Indicadores de snap: inicio y fin
      drawSnapIndicator(ctx, startRef.current, startSnapped.current, lineWidth);
      drawSnapIndicator(ctx, end, endSnapped, lineWidth);
    },
    [lineWidth, previewStyle, lineCap]
  );

  // ── onPointerUp ────────────────────────────────────────────────────────────
  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!startRef.current || !savedImageRef.current) return;

      const canvas = e.currentTarget;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const rawEnd = getCanvasPoint(e, canvas);
      const { pt: end } = applySnap(rawEnd);
      const start = startRef.current;

      // Restaurar estado limpio (sin preview)
      ctx.putImageData(savedImageRef.current, 0, 0);

      // Dibujar línea final solo si tiene longitud mínima
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.sqrt(dx * dx + dy * dy);

      if (len >= 4) {
        drawLine(ctx, start, end, strokeStyle, lineWidth, lineCap);
        setLines(prev => [...prev, { start, end }]);
      }

      startRef.current = null;
      savedImageRef.current = null;
      startSnapped.current = false;
      setIsDrawing(false);
    },
    [lineWidth, strokeStyle, lineCap]
  );

  // ── onPointerCancel ────────────────────────────────────────────────────────
  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!startRef.current || !savedImageRef.current) return;
      const canvas = e.currentTarget;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.putImageData(savedImageRef.current, 0, 0);
      startRef.current = null;
      savedImageRef.current = null;
      startSnapped.current = false;
      setIsDrawing(false);
    },
    []
  );

  // ── Limpiar canvas ─────────────────────────────────────────────────────────
  const clearCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setLines([]);
    },
    []
  );

  return {
    handlers: {
      onPointerDown:   handlePointerDown,
      onPointerMove:   handlePointerMove,
      onPointerUp:     handlePointerUp,
      onPointerCancel: handlePointerCancel,
    },
    isDrawing,
    lines,
    clearCanvas,
  };
}
