/**
 * BrushPage — Herramienta de pincel 2.5D
 *
 * Abre el canvas de pasto sobre la imagen de jardín activa.
 * Traza el área con líneas rectas → genera montaña de pasto.
 * Guarda el resultado de vuelta al diseño.
 */
import React, { useCallback } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Check } from "lucide-react";
import { useAppContext } from "@/context/app-context";
import BrushCanvas from "@/components/brush-canvas";

export default function BrushPage() {
  const { gardenImage, setGardenImage } = useAppContext();
  const [, setLocation] = useLocation();

  // Cuando el usuario exporta, guardamos la imagen y volvemos al diseño
  const handleExport = useCallback((imageData: string) => {
    setGardenImage(imageData);
    setLocation("/design");
  }, [setGardenImage, setLocation]);

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-[#0d1117] overflow-hidden">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="shrink-0 h-12 flex items-center gap-3 px-4 border-b border-white/8 bg-[#161b22]">
        <button
          onClick={() => setLocation("/design")}
          className="flex items-center gap-1.5 text-white/50 hover:text-white/90 text-sm transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Volver al diseño
        </button>
        <div className="flex-1" />
        <span className="text-white/40 text-xs font-mono">Pincel de Terreno 2.5D</span>
      </header>

      {/* ── Canvas ──────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden p-3">
        <BrushCanvas
          backgroundImage={gardenImage}
          height={window.innerHeight - 120}
          onExport={handleExport}
        />
      </div>
    </div>
  );
}
