/**
 * CadDrawingLayer — Professional CAD polygon drawing tool.
 *
 * Architecture:
 *   DrawingLayer  = this canvas component (visual output)
 *   PolygonManager = polygon-manager.ts (geometry logic)
 *   MaterialSystem = material-system.ts (visual + cost definitions)
 *   DesignEngine  = design-engine.ts (non-AI fill operations)
 *
 * Zero AI dependency. Works completely offline.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { X, Pencil, MousePointer2, Trash2, Check, ChevronDown, ZoomIn, Loader2 } from "lucide-react";
import { nanoid } from "nanoid";
import { CAD_MATERIALS, getMaterial, type MaterialDef } from "@/services/material-system";
import { applyAllFlatFills } from "@/services/design-engine";
import {
  shoelaceArea, polygonCentroid, dist, isPointInPolygon, findClosestEdge,
  type Point, type PolygonData,
} from "@/services/polygon-manager";

// ─── Constants ────────────────────────────────────────────────────────────────
const VERTEX_RADIUS = 9;
const CLOSE_RADIUS = 18;
const EDGE_HIT = 10;

// ─── Props ────────────────────────────────────────────────────────────────────
interface CadDrawingLayerProps {
  backgroundImage: string | null;
  pixelsPerMeter?: number | null;
  initialPolygons?: PolygonData[];
  onClose: () => void;
  /** Called with composited image (flat fills applied) + polygon metadata */
  onApply: (compositedImage: string | null, polygons: PolygonData[]) => void;
}

// ─── Coordinate helpers ───────────────────────────────────────────────────────
function getContainRect(natW: number, natH: number, cW: number, cH: number) {
  const scale = Math.min(cW / natW, cH / natH);
  const w = natW * scale, h = natH * scale;
  return { x: (cW - w) / 2, y: (cH - h) / 2, w, h, scale };
}

function eventPoint(e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement): Point {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  if ("touches" in e) {
    const t = e.touches[0] || e.changedTouches[0];
    return { x: (t.clientX - rect.left) * scaleX, y: (t.clientY - rect.top) * scaleY };
  }
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function CadDrawingLayer({
  backgroundImage, pixelsPerMeter, initialPolygons = [], onClose, onApply,
}: CadDrawingLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLImageElement | null>(null);
  const bgLoaded = useRef(false);

  // ─── State ──────────────────────────────────────────────────────────────────
  const [polygons, setPolygons] = useState<PolygonData[]>(initialPolygons);
  const [inProgress, setInProgress] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [mode, setMode] = useState<"draw" | "select">("draw");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragInfo, setDragInfo] = useState<{ id: string; vtx: number } | null>(null);
  const [activeMat, setActiveMat] = useState<string>("grass");
  const [matMenuOpen, setMatMenuOpen] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });
  const [ppm, setPpm] = useState<number | null>(pixelsPerMeter ?? null);
  const [scaleInput, setScaleInput] = useState("");
  const [applying, setApplying] = useState(false);

  // ─── Background image loader ─────────────────────────────────────────────
  useEffect(() => {
    if (!backgroundImage) { bgLoaded.current = false; bgRef.current = null; return; }
    const img = new Image();
    img.onload = () => { bgRef.current = img; bgLoaded.current = true; redraw(); };
    img.onerror = () => { bgLoaded.current = false; };
    img.src = backgroundImage;
  }, [backgroundImage]);

  // ─── ResizeObserver ──────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        setCanvasSize({ w: Math.round(width), h: Math.round(height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ─── Redraw whenever any visual state changes ────────────────────────────
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    // 1. Background image
    if (bgRef.current && bgLoaded.current) {
      const img = bgRef.current;
      const { x, y, w, h } = getContainRect(img.naturalWidth, img.naturalHeight, W, H);
      ctx.drawImage(img, x, y, w, h);
      // Subtle dark overlay so polygons stand out
      ctx.fillStyle = "rgba(0,0,0,0.08)";
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(0, 0, W, H);
    }

    // 2. Closed polygons
    for (const poly of polygons) {
      if (!poly.closed || poly.points.length < 3) continue;
      const mat = getMaterial(poly.materialId);
      const isSelected = poly.id === selectedId;
      drawClosedPolygon(ctx, poly, mat, isSelected, ppm);
    }

    // 3. In-progress polygon
    if (inProgress.length > 0 && mode === "draw") {
      const mat = getMaterial(activeMat);
      drawInProgress(ctx, inProgress, cursor, mat);
    }

    // 4. Crosshair cursor in draw mode
    if (cursor && mode === "draw") drawCrosshair(ctx, cursor);
  }, [polygons, inProgress, cursor, mode, selectedId, activeMat, ppm]);

  useEffect(() => { redraw(); }, [redraw, canvasSize]);

  // ─── Drawing helpers ─────────────────────────────────────────────────────
  function drawClosedPolygon(
    ctx: CanvasRenderingContext2D, poly: PolygonData, mat: MaterialDef,
    selected: boolean, pixM: number | null
  ) {
    const pts = poly.points;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();

    // Fill
    ctx.fillStyle = mat.fillColor;
    ctx.fill();

    // Hatch lines (grass only)
    if (mat.hatchColor) {
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = mat.hatchColor;
      ctx.lineWidth = 1;
      const minY = Math.min(...pts.map(p => p.y));
      const maxY = Math.max(...pts.map(p => p.y));
      const minX = Math.min(...pts.map(p => p.x));
      const maxX = Math.max(...pts.map(p => p.x));
      for (let y = minY; y <= maxY; y += 14) {
        ctx.beginPath(); ctx.moveTo(minX, y); ctx.lineTo(maxX, y); ctx.stroke();
      }
      ctx.restore();
    }

    // Border
    ctx.strokeStyle = selected ? "#f59e0b" : mat.strokeColor;
    ctx.lineWidth = selected ? 3 : 2;
    ctx.setLineDash([]);
    ctx.stroke();

    // Area label at centroid
    const c = polygonCentroid(pts);
    const areaPx = poly.areaPx;
    const areaLabel = pixM && pixM > 0
      ? `${(areaPx / (pixM * pixM)).toFixed(1)} m²`
      : `${mat.emoji}`;
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(areaLabel).width + 12;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.roundRect(c.x - tw / 2, c.y - 11, tw, 22, 6);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(areaLabel, c.x, c.y);

    // Vertex handles (selected)
    if (selected) {
      for (const pt of pts) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, VERTEX_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = mat.strokeColor;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      // Edge midpoints (insert vertex hint)
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        const mx = (pts[i].x + pts[j].x) / 2;
        const my = (pts[i].y + pts[j].y) / 2;
        ctx.beginPath();
        ctx.arc(mx, my, 4, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fill();
        ctx.strokeStyle = mat.strokeColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawInProgress(
    ctx: CanvasRenderingContext2D, pts: Point[], cur: Point | null, mat: MaterialDef
  ) {
    if (pts.length === 0) return;
    ctx.save();

    // Preview fill (if ≥ 3 pts)
    if (pts.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.forEach(p => ctx.lineTo(p.x, p.y));
      if (cur) ctx.lineTo(cur.x, cur.y);
      ctx.closePath();
      ctx.fillStyle = mat.fillColor.replace(/[\d.]+\)$/, "0.20)");
      ctx.fill();
    }

    // Lines
    ctx.setLineDash([7, 4]);
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (cur) ctx.lineTo(cur.x, cur.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Vertices
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const isFirst = i === 0;
      // Close indicator ring on first point
      if (isFirst && pts.length >= 3) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, CLOSE_RADIUS, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(34,197,94,0.6)";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isFirst ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = isFirst ? "#22c55e" : "#f59e0b";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Counter
    const lbl = `${pts.length} pts`;
    ctx.font = "11px system-ui";
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(lbl, pts[0].x + 10, pts[0].y + 10);

    ctx.restore();
  }

  function drawCrosshair(ctx: CanvasRenderingContext2D, pt: Point) {
    const S = 10;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(pt.x - S, pt.y); ctx.lineTo(pt.x + S, pt.y);
    ctx.moveTo(pt.x, pt.y - S); ctx.lineTo(pt.x, pt.y + S);
    ctx.stroke();
    ctx.restore();
  }

  // ─── Hit testing ─────────────────────────────────────────────────────────
  function findVertexHit(pt: Point, poly: PolygonData): number {
    for (let i = 0; i < poly.points.length; i++) {
      if (dist(pt, poly.points[i]) <= VERTEX_RADIUS + 4) return i;
    }
    return -1;
  }

  function findPolygonHit(pt: Point): PolygonData | null {
    for (let i = polygons.length - 1; i >= 0; i--) {
      const poly = polygons[i];
      if (poly.closed && isPointInPolygon(pt, poly.points)) return poly;
    }
    return null;
  }

  // ─── Polygon mutation helpers ────────────────────────────────────────────
  function closeCurrentPolygon() {
    if (inProgress.length < 3) return;
    const areaPx = shoelaceArea(inProgress);
    const areaM2 = ppm ? areaPx / (ppm * ppm) : null;
    const newPoly: PolygonData = {
      id: nanoid(),
      points: [...inProgress],
      materialId: activeMat,
      closed: true,
      areaPx,
      areaM2,
    };
    setPolygons(prev => [...prev, newPoly]);
    setInProgress([]);
    setSelectedId(newPoly.id);
    setMode("select");
  }

  function updatePolygon(id: string, fn: (p: PolygonData) => PolygonData) {
    setPolygons(prev => prev.map(p => p.id === id ? fn(p) : p));
  }

  // ─── Mouse / Touch handlers ──────────────────────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const pt = eventPoint(e, canvas);
    setCursor(pt);

    if (dragInfo) {
      updatePolygon(dragInfo.id, p => {
        const pts = p.points.map((v, i) => i === dragInfo.vtx ? pt : v);
        const areaPx = shoelaceArea(pts);
        return { ...p, points: pts, areaPx, areaM2: ppm ? areaPx / (ppm * ppm) : p.areaM2 };
      });
    }
  }, [dragInfo, ppm]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const pt = eventPoint(e, canvas);

    if (mode === "select" && selectedId) {
      const selPoly = polygons.find(p => p.id === selectedId);
      if (selPoly) {
        const vtxIdx = findVertexHit(pt, selPoly);
        if (vtxIdx >= 0) {
          setDragInfo({ id: selectedId, vtx: vtxIdx });
          e.preventDefault();
          return;
        }
        // Check edge midpoints for insert
        const edge = findClosestEdge(pt, selPoly.points, EDGE_HIT + 2);
        if (edge) {
          updatePolygon(selectedId, p => {
            const pts = [...p.points];
            pts.splice(edge.edgeIndex + 1, 0, pt);
            const areaPx = shoelaceArea(pts);
            return { ...p, points: pts, areaPx, areaM2: ppm ? areaPx / (ppm * ppm) : p.areaM2 };
          });
          setDragInfo({ id: selectedId, vtx: edge.edgeIndex + 1 });
          return;
        }
      }
    }
  }, [mode, selectedId, polygons, ppm]);

  const handleMouseUp = useCallback(() => {
    setDragInfo(null);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current; if (!canvas) return;
    if (dragInfo) return; // was dragging
    const pt = eventPoint(e, canvas);

    if (mode === "draw") {
      // Close if near first point
      if (inProgress.length >= 3 && dist(pt, inProgress[0]) <= CLOSE_RADIUS) {
        closeCurrentPolygon();
        return;
      }
      setInProgress(prev => [...prev, pt]);
    } else {
      // Select mode: find polygon under click
      const hit = findPolygonHit(pt);
      setSelectedId(hit ? hit.id : null);
    }
  }, [mode, inProgress, dragInfo, ppm, activeMat]);

  const handleDblClick = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current; if (!canvas) return;
    if (mode === "draw" && inProgress.length >= 3) {
      e.preventDefault();
      closeCurrentPolygon();
    }
  }, [mode, inProgress, ppm, activeMat]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (mode === "draw" && inProgress.length > 0) {
      setInProgress(prev => prev.slice(0, -1));
    } else if (mode === "select" && selectedId) {
      const canvas = canvasRef.current; if (!canvas) return;
      const pt = eventPoint(e, canvas);
      const selPoly = polygons.find(p => p.id === selectedId);
      if (selPoly) {
        const vtxIdx = findVertexHit(pt, selPoly);
        if (vtxIdx >= 0 && selPoly.points.length > 3) {
          updatePolygon(selectedId, p => {
            const pts = p.points.filter((_, i) => i !== vtxIdx);
            const areaPx = shoelaceArea(pts);
            return { ...p, points: pts, areaPx, areaM2: ppm ? areaPx / (ppm * ppm) : p.areaM2 };
          });
        }
      }
    }
  }, [mode, inProgress, selectedId, polygons, ppm]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (inProgress.length > 0) setInProgress([]);
      else setSelectedId(null);
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedId && mode === "select") {
        setPolygons(prev => prev.filter(p => p.id !== selectedId));
        setSelectedId(null);
      }
    }
    if (e.key === "Enter" && mode === "draw" && inProgress.length >= 3) {
      closeCurrentPolygon();
    }
    if (e.key === "d" || e.key === "D") setMode("draw");
    if (e.key === "s" || e.key === "S") setMode("select");
  }, [inProgress, selectedId, mode, ppm, activeMat]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // ─── Calibration ─────────────────────────────────────────────────────────
  const handleCalibrate = () => {
    const totalAreaM2 = parseFloat(scaleInput);
    if (!totalAreaM2 || totalAreaM2 <= 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Estimate: if total garden is totalAreaM2 m², and canvas is W×H px
    const canvasAreaPx = canvas.width * canvas.height;
    const estimated = Math.sqrt(canvasAreaPx / totalAreaM2);
    setPpm(estimated);
    setScaleInput("");
    // Recalculate all existing polygons
    setPolygons(prev => prev.map(p => ({
      ...p,
      areaM2: p.areaPx / (estimated * estimated),
    })));
  };

  // ─── Cost calculation ────────────────────────────────────────────────────
  const totalCost = useMemo(() => {
    return polygons.filter(p => p.closed).reduce((acc, p) => {
      const mat = getMaterial(p.materialId);
      const m2 = p.areaM2 ?? (ppm ? p.areaPx / (ppm * ppm) : 0);
      return acc + m2 * mat.defaultPriceM2;
    }, 0);
  }, [polygons, ppm]);

  const currentMat = getMaterial(activeMat);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-slate-900" style={{ touchAction: "none" }}>
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-slate-800 border-b border-slate-700">
        {/* Mode buttons */}
        <button
          onClick={() => setMode("draw")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            mode === "draw" ? "bg-amber-500 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"
          }`}
        >
          <Pencil className="w-3.5 h-3.5" />
          Dibujar <span className="opacity-60 text-[10px]">D</span>
        </button>
        <button
          onClick={() => setMode("select")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            mode === "select" ? "bg-blue-500 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"
          }`}
        >
          <MousePointer2 className="w-3.5 h-3.5" />
          Editar <span className="opacity-60 text-[10px]">S</span>
        </button>

        <div className="w-px h-6 bg-slate-600 mx-1" />

        {/* Material selector */}
        <div className="relative">
          <button
            onClick={() => setMatMenuOpen(v => !v)}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs text-slate-100 transition-colors"
          >
            <span>{currentMat.emoji}</span>
            <span className="font-medium">{currentMat.name}</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>
          {matMenuOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-slate-800 border border-slate-600 rounded-xl shadow-xl min-w-[180px] py-1 max-h-72 overflow-y-auto">
              {CAD_MATERIALS.map(mat => (
                <button
                  key={mat.id}
                  onClick={() => { setActiveMat(mat.id); setMatMenuOpen(false); }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left hover:bg-slate-700 transition-colors ${
                    mat.id === activeMat ? "bg-slate-700 text-white" : "text-slate-300"
                  }`}
                >
                  <span
                    className="w-3 h-3 rounded-full shrink-0 border border-white/20"
                    style={{ background: mat.strokeColor }}
                  />
                  <span>{mat.emoji} {mat.name}</span>
                  <span className="ml-auto text-slate-500 text-[10px]">${mat.defaultPriceM2}/m²</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Status + instructions */}
        <span className="text-xs text-slate-400 hidden md:block">
          {mode === "draw"
            ? inProgress.length === 0
              ? "Haz clic para agregar puntos · Doble clic o ↵ para cerrar"
              : `${inProgress.length} pts · Clic en 🟢 primer punto para cerrar`
            : selectedId
              ? "Arrastra vértices · Clic derecho para borrar vértice · Supr para borrar zona"
              : "Haz clic sobre una zona para seleccionarla"
          }
        </span>

        {/* Cancel draw */}
        {inProgress.length > 0 && (
          <button
            onClick={() => setInProgress([])}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg text-xs"
          >
            <X className="w-3.5 h-3.5" />
            Cancelar
          </button>
        )}

        {/* Apply & Close */}
        <button
          disabled={applying}
          onClick={async () => {
            const closed = polygons.filter(p => p.closed && p.points.length >= 3);
            if (closed.length === 0) { onApply(null, []); return; }
            setApplying(true);
            try {
              const composited = backgroundImage
                ? await applyAllFlatFills(backgroundImage, closed, canvasSize.w, canvasSize.h)
                : null;
              onApply(composited, closed);
            } catch {
              onApply(null, closed);
            } finally {
              setApplying(false);
            }
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
        >
          {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          Aplicar zonas
        </button>
        <button
          onClick={onClose}
          className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-xs transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Main area ─────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Canvas */}
        <div ref={containerRef} className="flex-1 relative overflow-hidden">
          <canvas
            ref={canvasRef}
            width={canvasSize.w}
            height={canvasSize.h}
            className="absolute inset-0 w-full h-full"
            style={{
              cursor: mode === "draw" ? "crosshair" : dragInfo ? "grabbing" : "default",
            }}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onClick={handleClick}
            onDoubleClick={handleDblClick}
            onContextMenu={handleContextMenu}
            onMouseLeave={() => setCursor(null)}
          />
          {/* No-image placeholder */}
          {!backgroundImage && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 pointer-events-none">
              <div className="text-center">
                <ZoomIn className="w-10 h-10 mx-auto mb-2 opacity-40" />
                <p className="text-sm">Carga una imagen del terreno para comenzar</p>
              </div>
            </div>
          )}
        </div>

        {/* ── Right Panel ─────────────────────────────────────────────────── */}
        <div className="w-64 shrink-0 bg-slate-800 border-l border-slate-700 flex flex-col overflow-hidden">
          {/* Zones list */}
          <div className="shrink-0 px-3 pt-3 pb-2 border-b border-slate-700">
            <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Zonas dibujadas ({polygons.filter(p => p.closed).length})
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {polygons.filter(p => p.closed).length === 0 && (
              <p className="text-xs text-slate-500 px-3 py-4 text-center">
                Dibuja tu primera zona haciendo clic en el canvas
              </p>
            )}
            {polygons.filter(p => p.closed).map(poly => {
              const mat = getMaterial(poly.materialId);
              const m2 = poly.areaM2 ?? (ppm ? poly.areaPx / (ppm * ppm) : null);
              const cost = m2 ? m2 * mat.defaultPriceM2 : null;
              const isSelected = poly.id === selectedId;
              return (
                <div
                  key={poly.id}
                  onClick={() => { setSelectedId(poly.id); setMode("select"); }}
                  className={`flex items-start gap-2 px-3 py-2 cursor-pointer transition-colors ${
                    isSelected ? "bg-slate-700" : "hover:bg-slate-700/50"
                  }`}
                >
                  <span
                    className="w-3 h-3 rounded-full mt-0.5 shrink-0 border border-white/20"
                    style={{ background: mat.strokeColor }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-slate-200 truncate">{mat.emoji} {mat.name}</p>
                    <p className="text-[10px] text-slate-400">
                      {m2 ? `${m2.toFixed(1)} m²` : "sin calibrar"}
                      {cost ? ` · $${cost.toLocaleString("es-MX", { maximumFractionDigits: 0 })}` : ""}
                    </p>
                  </div>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      setPolygons(prev => prev.filter(p => p.id !== poly.id));
                      if (selectedId === poly.id) setSelectedId(null);
                    }}
                    className="shrink-0 text-slate-500 hover:text-red-400 transition-colors p-0.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Total cost */}
          {totalCost > 0 && (
            <div className="shrink-0 px-3 py-2.5 border-t border-slate-700 bg-slate-700/50">
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">Total materiales</span>
                <span className="text-sm font-bold text-emerald-400">
                  ${totalCost.toLocaleString("es-MX", { maximumFractionDigits: 0 })}
                </span>
              </div>
            </div>
          )}

          {/* Scale calibration */}
          <div className="shrink-0 px-3 py-3 border-t border-slate-700">
            <p className="text-[10px] text-slate-500 mb-1.5 font-medium uppercase tracking-wider">
              Calibración de escala
            </p>
            {ppm ? (
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-emerald-400">✓ Escala activa</p>
                <button onClick={() => setPpm(null)} className="text-[10px] text-slate-500 hover:text-slate-300">
                  reiniciar
                </button>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <input
                  type="number"
                  placeholder="Área total en m²"
                  value={scaleInput}
                  onChange={e => setScaleInput(e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-2 py-1 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-400"
                />
                <button
                  onClick={handleCalibrate}
                  disabled={!scaleInput}
                  className="px-2 py-1 bg-slate-600 hover:bg-slate-500 disabled:opacity-40 rounded-lg text-[11px] text-white transition-colors"
                >
                  OK
                </button>
              </div>
            )}
            <p className="text-[9px] text-slate-600 mt-1">
              Ingresa el área aproximada del jardín para calcular m² reales
            </p>
          </div>

          {/* Shortcuts hint */}
          <div className="shrink-0 px-3 py-2 border-t border-slate-700">
            <p className="text-[9px] text-slate-600 leading-relaxed">
              <span className="text-slate-500">Atajos:</span> D=dibujar · S=seleccionar<br/>
              ↵=cerrar polígono · Supr=eliminar zona<br/>
              Clic derecho=borrar vértice/deshacer punto
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
