/**
 * BrushCanvas — Componente de pincel de línea recta con Edge Snapping.
 *
 * Comportamiento:
 *   1. Presionar  → guarda punto inicial (snapeado al borde si está activo)
 *   2. Arrastrar  → preview en tiempo real con puntos ajustados
 *   3. Soltar     → dibuja línea final perfectamente pegada al borde
 *   4. [Generar Montaña] → crea montaña de pasto fake-3D dentro del área
 *
 * Edge Snapping:
 *   - Toggle "Snap a bordes" ON/OFF en la barra de herramientas
 *   - Cuando ON: cada punto se busca el borde más cercano (radio 15px)
 *   - Indicadores: punto amarillo = snapeado, verde = libre
 *   - Si no hay borde cercano → usa trazo normal (seguro)
 */

import React, { useRef, useEffect, useCallback, useState } from "react";
import { Trash2, Minus, Plus, Mountain, Undo2, Magnet, Loader2 } from "lucide-react";
import { useStraightLineBrush } from "@/hooks/use-straight-line-brush";
import { generateMountain } from "@/services/mountain-generator";
import { buildEdgeMapFromImage, type EdgeMap } from "@/services/edge-detector";

// ─── Props ────────────────────────────────────────────────────────────────────
export interface BrushCanvasProps {
  backgroundImage?: string | null;
  height?: number;
  color?: string;
  strokeWidth?: number;
  onLineDrawn?: (start: { x: number; y: number }, end: { x: number; y: number }) => void;
  onExport?: (imageDataUrl: string) => void;
}

// ─── Colores disponibles ──────────────────────────────────────────────────────
const BRUSH_COLORS = [
  { label: "Verde",    value: "#10b981" },
  { label: "Blanco",   value: "#ffffff" },
  { label: "Amarillo", value: "#f59e0b" },
  { label: "Azul",     value: "#3b82f6" },
  { label: "Rojo",     value: "#ef4444" },
  { label: "Negro",    value: "#1f2937" },
];

// ─── Componente ───────────────────────────────────────────────────────────────
export default function BrushCanvas({
  backgroundImage = null,
  height = 400,
  color: initialColor = "#10b981",
  strokeWidth: initialStrokeWidth = 3,
  onLineDrawn,
  onExport,
}: BrushCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const bgRef        = useRef<HTMLImageElement | null>(null);

  const historyRef = useRef<ImageData[]>([]);

  const [color, setColor]               = useState(initialColor);
  const [strokeWidth, setStrokeWidth]   = useState(initialStrokeWidth);
  const [mountainSeed, setMountainSeed] = useState(42);
  const [hasMountain, setHasMountain]   = useState(false);
  const [historyLen, setHistoryLen]     = useState(0);

  // ── Edge Snap state ────────────────────────────────────────────────────────
  const [snapEnabled, setSnapEnabled]   = useState(false);
  const [edgeMap, setEdgeMap]           = useState<EdgeMap | null>(null);
  const [buildingEdges, setBuildingEdges] = useState(false);

  // ── Hook de pincel ────────────────────────────────────────────────────────
  const { handlers, isDrawing, lines, clearCanvas } = useStraightLineBrush({
    strokeStyle:  color,
    previewStyle: color + "80",
    lineWidth:    strokeWidth,
    lineCap:      "round",
    edgeMap:      snapEnabled ? edgeMap : null,
    snapEnabled,
    snapRadius:   15,
  });

  // ── Guardar snapshot ──────────────────────────────────────────────────────
  const saveSnapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
    historyRef.current = [...historyRef.current.slice(-9), snap];
    setHistoryLen(historyRef.current.length);
  }, []);

  // ── Cargar imagen de fondo + construir EdgeMap ────────────────────────────
  useEffect(() => {
    if (!backgroundImage) {
      bgRef.current = null;
      setEdgeMap(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      bgRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Construir EdgeMap en background (non-blocking con setTimeout)
      setBuildingEdges(true);
      setTimeout(() => {
        try {
          const map = buildEdgeMapFromImage(img, canvas.width, canvas.height, 25);
          setEdgeMap(map);
        } catch (err) {
          console.error("[EdgeSnap] Error construyendo EdgeMap:", err);
        } finally {
          setBuildingEdges(false);
        }
      }, 0);
    };
    img.src = backgroundImage;
  }, [backgroundImage]);

  // ── Notificar al padre de trazos ──────────────────────────────────────────
  const prevLineCount = useRef(0);
  useEffect(() => {
    if (lines.length > prevLineCount.current && onLineDrawn) {
      const last = lines[lines.length - 1];
      onLineDrawn(last.start, last.end);
    }
    prevLineCount.current = lines.length;
  }, [lines, onLineDrawn]);

  // ── Limpiar canvas ────────────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    clearCanvas(canvasRef.current);
    if (bgRef.current && canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) ctx.drawImage(bgRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    historyRef.current = [];
    setHistoryLen(0);
    setHasMountain(false);
  }, [clearCanvas]);

  // ── Deshacer ──────────────────────────────────────────────────────────────
  const handleUndo = useCallback(() => {
    const history = historyRef.current;
    if (history.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const prev = history[history.length - 1];
    ctx.putImageData(prev, 0, 0);
    historyRef.current = history.slice(0, -1);
    setHistoryLen(historyRef.current.length);
    if (historyRef.current.length === 0) setHasMountain(false);
  }, []);

  // ── Exportar ──────────────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !onExport) return;
    onExport(canvas.toDataURL("image/png"));
  }, [onExport]);

  // ── Generar Montaña ───────────────────────────────────────────────────────
  const handleGenerateMountain = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || lines.length === 0) return;
    saveSnapshot();
    const newSeed = Math.floor(Math.random() * 99999);
    setMountainSeed(newSeed);
    generateMountain(canvas, lines, newSeed);
    setHasMountain(true);
  }, [lines, saveSnapshot]);

  // ── Toggle snap ───────────────────────────────────────────────────────────
  const handleToggleSnap = useCallback(() => {
    setSnapEnabled(prev => !prev);
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-2 select-none" ref={containerRef}>

      {/* ── Toolbar principal ───────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-[#161b22] rounded-xl border border-white/10 flex-wrap">

        {/* Paleta de colores */}
        {BRUSH_COLORS.map(c => (
          <button
            key={c.value}
            title={c.label}
            onClick={() => setColor(c.value)}
            className={`w-6 h-6 rounded-full border-2 transition-transform ${
              color === c.value ? "border-white scale-110" : "border-transparent hover:scale-105"
            }`}
            style={{ backgroundColor: c.value }}
          />
        ))}

        <div className="w-px h-5 bg-white/15 mx-1" />

        {/* Grosor */}
        <button
          onClick={() => setStrokeWidth(w => Math.max(1, w - 1))}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/60 hover:bg-white/10 hover:text-white"
          title="Reducir grosor"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <span className="text-white/60 text-xs font-mono w-4 text-center">{strokeWidth}</span>
        <button
          onClick={() => setStrokeWidth(w => Math.min(20, w + 1))}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/60 hover:bg-white/10 hover:text-white"
          title="Aumentar grosor"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>

        <div className="w-px h-5 bg-white/15 mx-1" />

        {/* ══ TOGGLE SNAP A BORDES ══ */}
        <button
          onClick={handleToggleSnap}
          disabled={buildingEdges || !edgeMap}
          title={
            buildingEdges
              ? "Analizando bordes de la imagen..."
              : !edgeMap
              ? "Carga una imagen de jardín primero"
              : snapEnabled
              ? "Snap a bordes: ON — clic para desactivar"
              : "Snap a bordes: OFF — clic para activar"
          }
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all duration-200 ${
            snapEnabled && edgeMap
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40 shadow-sm shadow-amber-500/20"
              : buildingEdges
              ? "bg-white/5 text-white/30 cursor-wait"
              : !edgeMap
              ? "bg-white/5 text-white/20 cursor-not-allowed"
              : "bg-white/8 text-white/50 border border-white/10 hover:bg-white/12 hover:text-white/80"
          }`}
        >
          {buildingEdges ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Magnet className="w-3.5 h-3.5" />
          )}
          {buildingEdges
            ? "Analizando…"
            : snapEnabled && edgeMap
            ? "Snap ON"
            : "Snap OFF"}
        </button>

        <div className="flex-1" />

        {/* Contador + estado */}
        <span className="text-white/30 text-xs font-mono">
          {lines.length} {lines.length === 1 ? "trazo" : "trazos"}
        </span>

        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors ${
          isDrawing
            ? "bg-emerald-500/20 text-emerald-400"
            : "bg-white/5 text-white/30"
        }`}>
          {isDrawing ? "Dibujando…" : "Listo"}
        </span>

        {/* Deshacer */}
        <button
          onClick={handleUndo}
          disabled={historyLen === 0}
          title="Deshacer último paso"
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-amber-400 hover:bg-amber-400/10 disabled:opacity-20 disabled:cursor-not-allowed"
        >
          <Undo2 className="w-3.5 h-3.5" />
        </button>

        {/* Limpiar */}
        <button
          onClick={handleClear}
          title="Limpiar canvas"
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-red-400 hover:bg-red-400/10"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Toolbar de acciones ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-[#0d1117] rounded-xl border border-white/8 flex-wrap">

        <button
          onClick={handleGenerateMountain}
          disabled={lines.length === 0}
          title={lines.length === 0 ? "Dibuja el área primero" : "Generar montaña de pasto 3D dentro del área"}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-semibold transition-all duration-200 ${
            lines.length > 0
              ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-900/40 active:scale-95"
              : "bg-white/5 text-white/20 cursor-not-allowed"
          }`}
        >
          <Mountain className="w-4 h-4" />
          Generar Montaña
        </button>

        {lines.length === 0 && (
          <span className="text-white/30 text-xs italic">
            Traza el borde del área primero
          </span>
        )}
        {lines.length > 0 && !hasMountain && (
          <span className="text-emerald-500/60 text-xs">
            {lines.length} trazos → área lista ✓
          </span>
        )}
        {hasMountain && (
          <span className="text-emerald-400/70 text-xs">
            Montaña generada · seed {mountainSeed}
          </span>
        )}

        {/* Leyenda de snap */}
        {snapEnabled && edgeMap && (
          <div className="flex items-center gap-2 text-[10px] text-white/40 ml-1">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
              pegado al borde
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
              libre
            </span>
          </div>
        )}

        <div className="flex-1" />

        {hasMountain && (
          <button
            onClick={handleGenerateMountain}
            title="Regenerar con variación diferente"
            className="px-2.5 py-1 rounded-lg text-xs font-medium bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80 transition-colors"
          >
            Variar
          </button>
        )}

        {onExport && (
          <button
            onClick={handleExport}
            title="Guardar resultado en el canvas de diseño"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white shadow-md shadow-violet-900/40 active:scale-95 transition-all"
          >
            Guardar en Diseño
          </button>
        )}
      </div>

      {/* ── Canvas principal ────────────────────────────────────────────── */}
      <div
        className="relative rounded-xl overflow-hidden border border-white/10"
        style={{ height }}
      >
        <canvas
          ref={canvasRef}
          width={containerRef.current?.clientWidth ?? 800}
          height={height}
          className="w-full h-full bg-[#0d1117] touch-none"
          style={{ cursor: "crosshair" }}
          {...handlers}
        />

        {/* Instrucciones cuando el canvas está vacío */}
        {lines.length === 0 && !isDrawing && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-white/20">
              <Mountain className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">Traza el contorno del área</p>
              <p className="text-xs mt-1 text-white/15">
                Presiona + arrastra → líneas rectas
              </p>
              {edgeMap && (
                <p className="text-xs mt-1 text-amber-500/40">
                  <Magnet className="w-3 h-3 inline mr-1" />
                  Activa Snap para pegarte a los bordes
                </p>
              )}
              <p className="text-xs mt-0.5 text-white/15">
                Luego presiona <span className="text-emerald-500/50">Generar Montaña</span>
              </p>
            </div>
          </div>
        )}

        {/* Banner de snap activo (esquina) */}
        {snapEnabled && edgeMap && (
          <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-amber-500/15 border border-amber-500/30 rounded-lg px-2 py-1 pointer-events-none">
            <Magnet className="w-3 h-3 text-amber-400" />
            <span className="text-[10px] text-amber-400 font-semibold">Snap activo</span>
          </div>
        )}
      </div>
    </div>
  );
}
