import React, { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { MapContainer, TileLayer, Polygon, CircleMarker, Popup, useMapEvents, Polyline } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import {
  ChevronLeft, Map, Leaf, TrendingUp, DollarSign, Plus, Trash2,
  Save, Play, RotateCcw, Info, ChevronRight, Loader2, TreePine, Flower2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar
} from "recharts";

// Fix Leaflet default icon (Vite asset bundling issue)
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png", iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png", shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png" });

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api/geosim`;

// ─── Types ───────────────────────────────────────────────────────────────────
interface LatLng { lat: number; lng: number }
interface PlantCatalog {
  id: number; name: string; nameScientific: string; category: string;
  initialSizeM: number; maxSizeM: number; growthRatePerYear: number;
  pricePerUnit: number; maintenanceCostPerYear: number; waterNeedLPerDay: number;
  survivalProbability: number; iconEmoji: string; color: string;
}
interface PlacedPlant { id: string; plantId: number; lat: number; lng: number; quantity: number }
interface SimResult {
  year: number;
  plants: { plantId: number; name: string; emoji: string; color: string; year: number; quantity: number; survivingCount: number; currentSizeM: number; coverageM2: number }[];
}
interface CostProjection { year: number; maintenance: number; total: number; cumulative: number }
interface SimOutput {
  years: number; climateZone: string; climateMultiplier: number;
  results: SimResult[];
  costs: { initialCost: number; yearlyMaintenance: number; waterDailyL: number; projections: CostProjection[] };
}
interface Terrain { id: number; name: string; coordinates: number[][]; areaM2: number | null; centerLat: number | null; centerLng: number | null }

// ─── Map click handler ───────────────────────────────────────────────────────
function MapClickHandler({ onMapClick }: { onMapClick: (latlng: LatLng) => void }) {
  useMapEvents({ click: (e) => onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

// ─── Shoelace area in m² from lat/lng points ─────────────────────────────────
function polygonAreaM2(pts: LatLng[]): number {
  if (pts.length < 3) return 0;
  const R = 6371000;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const xi = (pts[i].lng * Math.PI) / 180 * R * Math.cos((pts[i].lat * Math.PI) / 180);
    const yi = (pts[i].lat * Math.PI) / 180 * R;
    const xj = (pts[j].lng * Math.PI) / 180 * R * Math.cos((pts[j].lat * Math.PI) / 180);
    const yj = (pts[j].lat * Math.PI) / 180 * R;
    area += xi * yj - xj * yi;
  }
  return Math.abs(area / 2);
}

// ─── Main Module ─────────────────────────────────────────────────────────────
type Module = "terrain" | "design" | "simulate" | "costs";

export default function GeoSimPage() {
  const [, setLocation] = useLocation();
  const [activeModule, setActiveModule] = useState<Module>("terrain");

  // Terrain
  const [drawingPolygon, setDrawingPolygon] = useState(false);
  const [polygonPts, setPolygonPts] = useState<LatLng[]>([]);
  const [polygonClosed, setPolygonClosed] = useState(false);
  const [terrainName, setTerrainName] = useState("");
  const [savedTerrains, setSavedTerrains] = useState<Terrain[]>([]);
  const [selectedTerrain, setSelectedTerrain] = useState<Terrain | null>(null);

  // Design
  const [catalog, setCatalog] = useState<PlantCatalog[]>([]);
  const [selectedPlant, setSelectedPlant] = useState<PlantCatalog | null>(null);
  const [placedPlants, setPlacedPlants] = useState<PlacedPlant[]>([]);
  const [mapCenter, setMapCenter] = useState<[number, number]>([20.6597, -103.3496]);

  // Simulation
  const [simYears, setSimYears] = useState(3);
  const [simResult, setSimResult] = useState<SimOutput | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [currentYear, setCurrentYear] = useState(0);

  // Saving
  const [saving, setSaving] = useState(false);
  const [designName, setDesignName] = useState("Diseño principal");

  // Load catalog and terrains
  useEffect(() => {
    fetch(`${API}/plants/catalog`).then(r => r.json()).then(setCatalog).catch(console.error);
    fetch(`${API}/terrains`).then(r => r.json()).then(setSavedTerrains).catch(console.error);
  }, []);

  // ── Map click ──────────────────────────────────────────────────────────────
  const handleMapClick = useCallback((latlng: LatLng) => {
    if (activeModule === "terrain" && drawingPolygon) {
      if (polygonPts.length >= 3 && !polygonClosed) {
        const first = polygonPts[0];
        const dist = Math.sqrt((latlng.lat - first.lat) ** 2 + (latlng.lng - first.lng) ** 2);
        if (dist < 0.0003) { setPolygonClosed(true); setDrawingPolygon(false); return; }
      }
      setPolygonPts(prev => [...prev, latlng]);
    } else if (activeModule === "design" && selectedPlant) {
      setPlacedPlants(prev => [...prev, { id: `${Date.now()}`, plantId: selectedPlant.id, lat: latlng.lat, lng: latlng.lng, quantity: 1 }]);
    }
  }, [activeModule, drawingPolygon, polygonPts, polygonClosed, selectedPlant]);

  // ── Save terrain ───────────────────────────────────────────────────────────
  const saveTerrain = async () => {
    if (polygonPts.length < 3 || !terrainName) return;
    setSaving(true);
    try {
      const coords = polygonPts.map(p => [p.lat, p.lng]);
      const center = { lat: polygonPts.reduce((s, p) => s + p.lat, 0) / polygonPts.length, lng: polygonPts.reduce((s, p) => s + p.lng, 0) / polygonPts.length };
      const areaM2 = polygonAreaM2(polygonPts);
      const res = await fetch(`${API}/terrains`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: terrainName, coordinates: coords, areaM2, centerLat: center.lat, centerLng: center.lng }) });
      const data = await res.json();
      setSavedTerrains(prev => [...prev, data]);
      setSelectedTerrain(data);
      setTerrainName("");
    } finally { setSaving(false); }
  };

  // ── Run simulation ─────────────────────────────────────────────────────────
  const runSimulation = async () => {
    if (placedPlants.length === 0) return;
    setSimLoading(true);
    try {
      const res = await fetch(`${API}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plants: placedPlants.map(p => ({ plantId: p.plantId, lat: p.lat, lng: p.lng, quantity: p.quantity })),
          years: simYears,
          centerLat: selectedTerrain?.centerLat ?? mapCenter[0],
        }),
      });
      const data = await res.json();
      setSimResult(data);
      setCurrentYear(0);
    } finally { setSimLoading(false); }
  };

  // ── Derived ────────────────────────────────────────────────────────────────
  const currentSnapshots = simResult?.results.find(r => r.year === currentYear)?.plants ?? [];
  const terrainAreaM2 = polygonClosed ? polygonAreaM2(polygonPts) : selectedTerrain?.areaM2 ?? null;
  const totalPlants = placedPlants.length;
  const plantsByType = catalog.reduce((acc, p) => { acc[p.id] = p; return acc; }, {} as Record<number, PlantCatalog>);

  const modules: { id: Module; label: string; icon: React.ElementType }[] = [
    { id: "terrain", label: "Terreno", icon: Map },
    { id: "design", label: "Diseño", icon: Leaf },
    { id: "simulate", label: "Simulación", icon: TrendingUp },
    { id: "costs", label: "Costos", icon: DollarSign },
  ];

  return (
    <div className="flex flex-col h-[100dvh] bg-slate-950 text-white overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="h-14 shrink-0 border-b border-slate-800 bg-slate-900/90 backdrop-blur flex items-center justify-between px-4 z-50">
        <div className="flex items-center gap-3">
          <button onClick={() => setLocation("/")} className="text-slate-400 hover:text-white transition-colors">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center">
              <TreePine className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-sm font-bold tracking-tight leading-none">GeoSim</div>
              <div className="text-[10px] text-slate-400 leading-none">Landscape Intelligence</div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {simResult && (
            <Badge variant="outline" className="text-emerald-400 border-emerald-700 bg-emerald-950/50 text-[11px]">
              {simResult.climateZone} · {simResult.climateMultiplier}× crecimiento
            </Badge>
          )}
          <Button size="sm" variant="outline" className="h-8 text-xs border-slate-700 bg-slate-800 hover:bg-slate-700" onClick={() => setLocation("/")}>
            Salir
          </Button>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside className="w-56 shrink-0 border-r border-slate-800 bg-slate-900 flex flex-col">
          <div className="p-3 border-b border-slate-800">
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">Módulos</div>
            <nav className="space-y-0.5">
              {modules.map(m => {
                const Icon = m.icon as React.ComponentType<{ className?: string }>;
                return (
                <button
                  key={m.id}
                  onClick={() => setActiveModule(m.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${activeModule === m.id ? "bg-emerald-600/20 text-emerald-400 border border-emerald-700/40" : "text-slate-400 hover:text-white hover:bg-slate-800"}`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {m.label}
                  {m.id === "design" && totalPlants > 0 && (
                    <span className="ml-auto text-[10px] bg-emerald-700 text-white rounded-full px-1.5 py-0.5">{totalPlants}</span>
                  )}
                </button>
                );
              })}
            </nav>
          </div>

          {/* Module-specific sidebar content */}
          <div className="flex-1 overflow-y-auto p-3">

            {/* TERRAIN sidebar */}
            {activeModule === "terrain" && (
              <div className="space-y-3">
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Terrenos guardados</div>
                {savedTerrains.length === 0 ? (
                  <div className="text-xs text-slate-500 text-center py-4">Sin terrenos aún</div>
                ) : savedTerrains.map(t => (
                  <button key={t.id} onClick={() => { setSelectedTerrain(t); if (t.centerLat && t.centerLng) setMapCenter([t.centerLat, t.centerLng]); }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border text-xs transition-all ${selectedTerrain?.id === t.id ? "border-emerald-600 bg-emerald-900/20 text-emerald-300" : "border-slate-700 bg-slate-800/50 text-slate-300 hover:border-slate-600"}`}>
                    <div className="font-medium truncate">{t.name}</div>
                    {t.areaM2 && <div className="text-slate-500 mt-0.5">{(t.areaM2 / 10000).toFixed(2)} ha</div>}
                  </button>
                ))}
                {terrainAreaM2 && polygonClosed && (
                  <div className="bg-emerald-900/20 border border-emerald-700/40 rounded-lg p-3 text-xs">
                    <div className="text-emerald-400 font-medium">Área del polígono</div>
                    <div className="text-emerald-300 text-base font-bold mt-1">{terrainAreaM2.toFixed(0)} m²</div>
                    <div className="text-slate-400">{(terrainAreaM2 / 10000).toFixed(4)} ha</div>
                  </div>
                )}
              </div>
            )}

            {/* DESIGN sidebar */}
            {activeModule === "design" && (
              <div className="space-y-2">
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Catálogo de plantas</div>
                {catalog.map(p => (
                  <button key={p.id} onClick={() => setSelectedPlant(prev => prev?.id === p.id ? null : p)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg border text-xs transition-all ${selectedPlant?.id === p.id ? "border-emerald-600 bg-emerald-900/20" : "border-slate-700 bg-slate-800/50 hover:border-slate-600"}`}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-base">{p.iconEmoji}</span>
                      <div>
                        <div className="font-medium text-slate-200 truncate">{p.name}</div>
                        <div className="text-slate-500">${p.pricePerUnit.toLocaleString()}/ud</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* SIMULATE sidebar */}
            {activeModule === "simulate" && (
              <div className="space-y-4">
                <div>
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">Plantas colocadas</div>
                  {placedPlants.length === 0 ? (
                    <div className="text-xs text-slate-500 text-center py-3">Ve al módulo Diseño y coloca plantas en el mapa</div>
                  ) : (
                    <div className="space-y-1.5">
                      {Object.entries(placedPlants.reduce((acc, p) => { acc[p.plantId] = (acc[p.plantId] || 0) + p.quantity; return acc; }, {} as Record<number, number>)).map(([id, qty]) => {
                        const plant = plantsByType[Number(id)];
                        return plant ? (
                          <div key={id} className="flex items-center justify-between text-xs bg-slate-800 rounded-lg px-2.5 py-1.5">
                            <span>{plant.iconEmoji} {plant.name}</span>
                            <span className="text-emerald-400 font-medium">{qty} ud</span>
                          </div>
                        ) : null;
                      })}
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">Período ({simYears} años)</div>
                  <input type="range" min={1} max={10} value={simYears} onChange={e => setSimYears(Number(e.target.value))}
                    className="w-full accent-emerald-500" />
                  <div className="flex justify-between text-[10px] text-slate-500 mt-1"><span>1 año</span><span>10 años</span></div>
                </div>
                <Button onClick={runSimulation} disabled={simLoading || placedPlants.length === 0} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white h-9 text-sm">
                  {simLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                  Simular {simYears} años
                </Button>
              </div>
            )}

            {/* COSTS sidebar */}
            {activeModule === "costs" && simResult && (
              <div className="space-y-3">
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Resumen financiero</div>
                <div className="space-y-2">
                  {[
                    { label: "Costo inicial", value: `$${simResult.costs.initialCost.toLocaleString()}`, color: "text-emerald-400" },
                    { label: "Mantenimiento/año", value: `$${simResult.costs.yearlyMaintenance.toLocaleString()}`, color: "text-blue-400" },
                    { label: "Agua diaria", value: `${simResult.costs.waterDailyL.toFixed(0)} L/día`, color: "text-cyan-400" },
                  ].map(item => (
                    <div key={item.label} className="bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2.5">
                      <div className="text-[10px] text-slate-500">{item.label}</div>
                      <div className={`text-base font-bold ${item.color}`}>{item.value}</div>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mt-2">Proyección total</div>
                {simResult.costs.projections.filter(p => [1,3,5].includes(p.year)).map(p => (
                  <div key={p.year} className="flex justify-between items-center text-xs bg-slate-800 rounded-lg px-3 py-2">
                    <span className="text-slate-400">{p.year} {p.year === 1 ? "año" : "años"}</span>
                    <span className="font-bold text-white">${p.total.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}

          </div>
        </aside>

        {/* ── Map ────────────────────────────────────────────────────────────── */}
        <div className="flex-1 relative flex flex-col overflow-hidden">
          {/* Map controls overlay */}
          <div className="absolute top-3 left-3 z-[1000] flex flex-col gap-2">
            {activeModule === "terrain" && (
              <div className="bg-slate-900/95 backdrop-blur border border-slate-700 rounded-xl p-3 shadow-xl min-w-[220px]">
                <div className="text-xs font-semibold text-slate-300 mb-2">Seleccionar terreno</div>
                {!drawingPolygon && !polygonClosed ? (
                  <Button size="sm" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white h-8 text-xs" onClick={() => { setDrawingPolygon(true); setPolygonPts([]); setPolygonClosed(false); }}>
                    <Plus className="w-3 h-3 mr-1" /> Dibujar polígono
                  </Button>
                ) : drawingPolygon ? (
                  <div className="space-y-2">
                    <div className="text-[11px] text-slate-400">
                      {polygonPts.length < 3 ? `Haz clic para agregar vértices (${polygonPts.length}/3 mínimo)` : "Clic al primer punto para cerrar"}
                    </div>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" className="flex-1 h-7 text-[11px] border-slate-600 text-slate-300" onClick={() => { if (polygonPts.length >= 3) { setPolygonClosed(true); setDrawingPolygon(false); } }}>
                        Cerrar
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-[11px] border-red-700 text-red-400" onClick={() => { setPolygonPts([]); setDrawingPolygon(false); }}>
                        <RotateCcw className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ) : polygonClosed ? (
                  <div className="space-y-2">
                    <div className="text-[11px] text-emerald-400">✓ Polígono cerrado · {terrainAreaM2?.toFixed(0)} m²</div>
                    <input value={terrainName} onChange={e => setTerrainName(e.target.value)} placeholder="Nombre del terreno..." className="w-full bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-white placeholder:text-slate-500 outline-none focus:border-emerald-500" />
                    <div className="flex gap-1.5">
                      <Button size="sm" className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white h-7 text-[11px]" disabled={!terrainName || saving} onClick={saveTerrain}>
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3 mr-1" />} Guardar
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-[11px] border-slate-600 text-slate-400" onClick={() => { setPolygonPts([]); setPolygonClosed(false); setDrawingPolygon(false); }}>
                        <RotateCcw className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {activeModule === "design" && (
              <div className="bg-slate-900/95 backdrop-blur border border-slate-700 rounded-xl p-3 shadow-xl min-w-[200px]">
                {selectedPlant ? (
                  <div>
                    <div className="text-xs font-semibold text-emerald-400 mb-1">{selectedPlant.iconEmoji} {selectedPlant.name}</div>
                    <div className="text-[11px] text-slate-400">Haz clic en el mapa para colocar</div>
                    <div className="flex gap-2 mt-2 text-[10px] text-slate-500">
                      <span>Max {selectedPlant.maxSizeM}m</span>
                      <span>·</span>
                      <span>${selectedPlant.pricePerUnit}/ud</span>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-slate-400">Selecciona una planta del panel izquierdo</div>
                )}
                {placedPlants.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-slate-700 flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">{placedPlants.length} elementos</span>
                    <button onClick={() => setPlacedPlants([])} className="text-[11px] text-red-400 hover:text-red-300">Limpiar todo</button>
                  </div>
                )}
              </div>
            )}

            {activeModule === "simulate" && simResult && (
              <div className="bg-slate-900/95 backdrop-blur border border-slate-700 rounded-xl p-3 shadow-xl min-w-[220px]">
                <div className="text-[10px] text-slate-500 mb-1">AÑO DE SIMULACIÓN</div>
                <div className="text-2xl font-bold text-emerald-400">{currentYear}</div>
                <div className="text-xs text-slate-400 mt-1">
                  {currentSnapshots.reduce((s, p) => s + (p?.coverageM2 ?? 0), 0).toFixed(0)} m² cubiertos
                </div>
                <div className="mt-2 space-y-1">
                  {currentSnapshots.slice(0, 4).map((s, i) => s ? (
                    <div key={i} className="flex items-center justify-between text-[10px]">
                      <span className="text-slate-400">{s.emoji} {s.name.split(" ")[0]}</span>
                      <span style={{ color: s.color || "#4ade80" }} className="font-medium">{s.currentSizeM}m · {s.survivingCount} vivas</span>
                    </div>
                  ) : null)}
                </div>
              </div>
            )}
          </div>

          {/* The map */}
          <div className="flex-1 relative">
            <MapContainer
              center={mapCenter}
              zoom={16}
              className="w-full h-full"
              style={{ background: "#1e293b" }}
              zoomControl={false}
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='© <a href="https://www.openstreetmap.org/">OpenStreetMap</a>'
                className="map-tiles-dark"
              />
              <MapClickHandler onMapClick={handleMapClick} />

              {/* Drawing polygon in progress */}
              {polygonPts.length > 0 && (
                <>
                  <Polyline
                    positions={polygonPts.map(p => [p.lat, p.lng])}
                    pathOptions={{ color: "#10b981", weight: 2, dashArray: "6,4" }}
                  />
                  {polygonPts.map((p, i) => (
                    <CircleMarker key={i} center={[p.lat, p.lng]} radius={i === 0 ? 8 : 5}
                      pathOptions={{ color: i === 0 ? "#f59e0b" : "#10b981", fillColor: i === 0 ? "#f59e0b" : "#10b981", fillOpacity: 1, weight: 2 }} />
                  ))}
                </>
              )}

              {/* Closed polygon */}
              {polygonClosed && polygonPts.length >= 3 && (
                <Polygon
                  positions={polygonPts.map(p => [p.lat, p.lng])}
                  pathOptions={{ color: "#10b981", fillColor: "#10b981", fillOpacity: 0.15, weight: 2 }}
                />
              )}

              {/* Saved terrain polygons */}
              {savedTerrains.map(t => (
                <Polygon key={t.id}
                  positions={t.coordinates.map(c => [c[0], c[1]] as [number, number])}
                  pathOptions={{ color: selectedTerrain?.id === t.id ? "#3b82f6" : "#6b7280", fillColor: selectedTerrain?.id === t.id ? "#3b82f6" : "#6b7280", fillOpacity: 0.1, weight: 1.5 }}
                >
                  <Popup className="leaflet-popup-dark">{t.name}{t.areaM2 && ` · ${t.areaM2.toFixed(0)} m²`}</Popup>
                </Polygon>
              ))}

              {/* Placed plants */}
              {placedPlants.map(pp => {
                const plant = plantsByType[pp.plantId];
                if (!plant) return null;
                const simData = currentSnapshots.find(s => s?.plantId === pp.plantId);
                const radius = simData ? Math.max(5, simData.currentSizeM * 4) : 8;
                return (
                  <CircleMarker key={pp.id} center={[pp.lat, pp.lng]} radius={radius}
                    pathOptions={{ color: plant.color, fillColor: plant.color, fillOpacity: 0.6, weight: 2 }}
                    eventHandlers={{ click: () => {} }}
                  >
                    <Popup>
                      <div className="text-xs">
                        <div className="font-bold">{plant.iconEmoji} {plant.name}</div>
                        {simData && <div className="mt-1">Tamaño: {simData.currentSizeM}m · Vivas: {simData.survivingCount}</div>}
                        <button className="text-red-500 mt-1 text-[10px]" onClick={() => setPlacedPlants(prev => prev.filter(p => p.id !== pp.id))}>Eliminar</button>
                      </div>
                    </Popup>
                  </CircleMarker>
                );
              })}
            </MapContainer>
          </div>

          {/* ── Time slider (bottom, visible in simulate mode) ──────────────── */}
          {activeModule === "simulate" && simResult && (
            <div className="h-16 shrink-0 bg-slate-900/95 backdrop-blur border-t border-slate-800 flex items-center px-6 gap-4">
              <div className="text-xs text-slate-400 font-medium w-14">Año {currentYear}</div>
              <div className="flex-1">
                <input type="range" min={0} max={simResult.years} step={1} value={currentYear}
                  onChange={e => setCurrentYear(Number(e.target.value))}
                  className="w-full accent-emerald-500 cursor-pointer" />
                <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
                  {Array.from({ length: simResult.years + 1 }, (_, i) => (
                    <span key={i}>{i}</span>
                  ))}
                </div>
              </div>
              <div className="text-xs text-slate-400 font-medium w-14 text-right">Año {simResult.years}</div>
            </div>
          )}

          {/* ── Cost dashboard (visible in costs mode) ─────────────────────── */}
          {activeModule === "costs" && (
            <div className="h-64 shrink-0 bg-slate-900 border-t border-slate-800 overflow-y-auto">
              {!simResult ? (
                <div className="flex items-center justify-center h-full text-sm text-slate-500">
                  Ejecuta una simulación primero para ver los costos
                </div>
              ) : (
                <div className="flex h-full">
                  <div className="flex-1 p-3">
                    <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">Proyección de costo acumulado</div>
                    <ResponsiveContainer width="100%" height={180}>
                      <LineChart data={simResult.costs.projections} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="year" tick={{ fill: "#94a3b8", fontSize: 10 }} tickFormatter={v => `Año ${v}`} />
                        <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
                        <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 11 }} formatter={(v: number) => `$${v.toLocaleString()}`} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Line type="monotone" dataKey="total" stroke="#10b981" strokeWidth={2} dot={{ fill: "#10b981", r: 3 }} name="Total acumulado" />
                        <Line type="monotone" dataKey="maintenance" stroke="#3b82f6" strokeWidth={2} dot={{ fill: "#3b82f6", r: 3 }} name="Solo mantenimiento" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="w-72 border-l border-slate-800 p-3">
                    <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">Costo por planta</div>
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart data={Object.entries(placedPlants.reduce((acc, p) => { const plant = plantsByType[p.plantId]; if (plant) { acc[plant.name] = (acc[plant.name] || 0) + plant.pricePerUnit * p.quantity; } return acc; }, {} as Record<string, number>)).map(([name, cost]) => ({ name: name.split(" ")[0], cost }))} margin={{ top: 4, right: 4, left: 8, bottom: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 9 }} angle={-25} textAnchor="end" />
                        <YAxis tick={{ fill: "#94a3b8", fontSize: 9 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
                        <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 11 }} formatter={(v: number) => `$${v.toLocaleString()}`} />
                        <Bar dataKey="cost" fill="#10b981" name="Costo inicial" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right detail panel ──────────────────────────────────────────── */}
        <aside className="w-72 shrink-0 border-l border-slate-800 bg-slate-900 flex flex-col overflow-y-auto">
          <div className="p-3 border-b border-slate-800">
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
              {activeModule === "terrain" ? "Información del terreno" : activeModule === "design" ? "Detalle del diseño" : activeModule === "simulate" ? "Resultados — Año " + currentYear : "Dashboard financiero"}
            </div>
          </div>

          <div className="flex-1 p-3 space-y-3">
            {/* TERRAIN detail */}
            {activeModule === "terrain" && (
              <div className="space-y-3">
                {terrainAreaM2 ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: "Área", value: `${terrainAreaM2.toFixed(0)} m²` },
                        { label: "Hectáreas", value: `${(terrainAreaM2 / 10000).toFixed(4)}` },
                        { label: "Vértices", value: `${polygonPts.length}` },
                        { label: "Estado", value: polygonClosed ? "✓ Cerrado" : "En dibujo" },
                      ].map(kv => (
                        <div key={kv.label} className="bg-slate-800/50 border border-slate-700 rounded-lg p-2.5">
                          <div className="text-[10px] text-slate-500">{kv.label}</div>
                          <div className="text-sm font-semibold text-white mt-0.5">{kv.value}</div>
                        </div>
                      ))}
                    </div>
                    <div className="bg-slate-800/30 border border-slate-700/50 rounded-lg p-3 text-xs text-slate-400">
                      <Info className="w-3 h-3 inline mr-1.5 text-blue-400" />
                      La medición usa la fórmula Shoelace sobre coordenadas geográficas reales (WGS-84), proyectadas en metros. Precisión submétrica.
                    </div>
                  </>
                ) : selectedTerrain ? (
                  <div className="space-y-2">
                    <div className="text-sm font-semibold text-emerald-400">{selectedTerrain.name}</div>
                    {selectedTerrain.areaM2 && <div className="text-xs text-slate-400">Área: {selectedTerrain.areaM2.toFixed(0)} m²</div>}
                    {selectedTerrain.centerLat && <div className="text-xs text-slate-500">Centro: {Number(selectedTerrain.centerLat).toFixed(5)}, {Number(selectedTerrain.centerLng).toFixed(5)}</div>}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 text-center py-8">
                    Dibuja un polígono en el mapa para seleccionar el área del terreno
                  </div>
                )}
              </div>
            )}

            {/* DESIGN detail */}
            {activeModule === "design" && (
              <div className="space-y-3">
                {selectedPlant && (
                  <div className="bg-slate-800/50 border border-emerald-700/30 rounded-xl p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-2xl">{selectedPlant.iconEmoji}</span>
                      <div>
                        <div className="text-sm font-semibold text-white">{selectedPlant.name}</div>
                        <div className="text-[10px] text-slate-400 italic">{selectedPlant.nameScientific}</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                      {[
                        { label: "Precio", value: `$${selectedPlant.pricePerUnit.toLocaleString()}` },
                        { label: "Mantenimiento/año", value: `$${selectedPlant.maintenanceCostPerYear.toLocaleString()}` },
                        { label: "Tamaño inicial", value: `${selectedPlant.initialSizeM}m` },
                        { label: "Tamaño máximo", value: `${selectedPlant.maxSizeM}m` },
                        { label: "Crecimiento/año", value: `+${selectedPlant.growthRatePerYear}m` },
                        { label: "Sobrevivencia", value: `${(selectedPlant.survivalProbability * 100).toFixed(0)}%` },
                        { label: "Agua/día", value: `${selectedPlant.waterNeedLPerDay}L` },
                        { label: "Categoría", value: selectedPlant.category },
                      ].map(kv => (
                        <div key={kv.label} className="bg-slate-900/60 rounded-lg px-2 py-1.5">
                          <div className="text-[9px] text-slate-500">{kv.label}</div>
                          <div className="text-white font-medium">{kv.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {placedPlants.length > 0 ? (
                  <div>
                    <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">Colocados en mapa</div>
                    <div className="space-y-1.5 max-h-60 overflow-y-auto">
                      {placedPlants.map((pp, i) => {
                        const p = plantsByType[pp.plantId];
                        return p ? (
                          <div key={pp.id} className="flex items-center justify-between bg-slate-800/50 rounded-lg px-2.5 py-1.5 text-xs">
                            <span className="text-slate-300">{p.iconEmoji} {p.name.split(" ")[0]}</span>
                            <button onClick={() => setPlacedPlants(prev => prev.filter(x => x.id !== pp.id))} className="text-slate-600 hover:text-red-400 ml-2">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        ) : null;
                      })}
                    </div>
                    <div className="mt-3 text-xs text-slate-500">
                      Costo inicial estimado: <span className="text-emerald-400 font-semibold">${placedPlants.reduce((s, pp) => s + (plantsByType[pp.plantId]?.pricePerUnit ?? 0) * pp.quantity, 0).toLocaleString()}</span>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 text-center py-4">Selecciona una planta y haz clic en el mapa</div>
                )}
              </div>
            )}

            {/* SIMULATE detail */}
            {activeModule === "simulate" && simResult && (
              <div className="space-y-2">
                <div className="bg-slate-800/30 border border-slate-700/50 rounded-lg p-2.5">
                  <div className="text-[10px] text-slate-500">Zona climática</div>
                  <div className="text-sm font-semibold text-white">{simResult.climateZone}</div>
                  <div className="text-[10px] text-emerald-400 mt-0.5">Multiplicador: {simResult.climateMultiplier}×</div>
                </div>
                <div className="space-y-1.5">
                  {currentSnapshots.map((s, i) => s ? (
                    <div key={i} className="bg-slate-800/50 rounded-lg px-3 py-2 text-xs border border-slate-700/50">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-white">{s.emoji} {s.name}</span>
                        <span className="text-emerald-400 text-[11px]">{s.currentSizeM}m ∅</span>
                      </div>
                      <div className="flex gap-3 mt-1 text-[10px] text-slate-400">
                        <span>Vivas: <span className="text-white">{s.survivingCount}/{s.quantity}</span></span>
                        <span>Cobertura: <span className="text-white">{s.coverageM2.toFixed(1)}m²</span></span>
                      </div>
                      <div className="mt-1.5 bg-slate-700 rounded-full h-1 overflow-hidden">
                        <div className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                          style={{ width: `${Math.min(100, (s.currentSizeM / (plantsByType[s.plantId]?.maxSizeM ?? (s.currentSizeM || 1))) * 100)}%` }} />
                      </div>
                    </div>
                  ) : null)}
                </div>
              </div>
            )}

            {/* COSTS detail */}
            {activeModule === "costs" && simResult && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <div className="bg-emerald-900/20 border border-emerald-700/30 rounded-xl p-3">
                    <div className="text-[10px] text-emerald-400 font-semibold uppercase tracking-widest">Inversión inicial</div>
                    <div className="text-2xl font-bold text-white mt-1">${simResult.costs.initialCost.toLocaleString()}</div>
                  </div>
                  <div className="bg-blue-900/20 border border-blue-700/30 rounded-xl p-3">
                    <div className="text-[10px] text-blue-400 font-semibold uppercase tracking-widest">Mantenimiento anual</div>
                    <div className="text-xl font-bold text-white mt-1">${simResult.costs.yearlyMaintenance.toLocaleString()}</div>
                    <div className="text-[10px] text-slate-400">${(simResult.costs.yearlyMaintenance / 12).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}/mes</div>
                  </div>
                  <div className="bg-cyan-900/20 border border-cyan-700/30 rounded-xl p-3">
                    <div className="text-[10px] text-cyan-400 font-semibold uppercase tracking-widest">Agua diaria requerida</div>
                    <div className="text-xl font-bold text-white mt-1">{simResult.costs.waterDailyL.toFixed(0)} L</div>
                  </div>
                </div>
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Proyección por año</div>
                <div className="space-y-1">
                  {simResult.costs.projections.map(p => (
                    <div key={p.year} className="flex items-center gap-2 text-xs">
                      <span className="text-slate-500 w-10">Año {p.year}</span>
                      <div className="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.min(100, (p.total / (simResult.costs.projections.at(-1)?.total || 1)) * 100)}%` }} />
                      </div>
                      <span className="text-white font-medium w-24 text-right">${p.total.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Empty state for simulate */}
            {activeModule === "simulate" && !simResult && (
              <div className="text-center py-8 space-y-3">
                <TrendingUp className="w-10 h-10 text-slate-600 mx-auto" />
                <div className="text-xs text-slate-500">Coloca plantas en el módulo <strong className="text-slate-400">Diseño</strong> y luego ejecuta la simulación</div>
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 text-xs" onClick={() => { setActiveModule("design"); }}>
                  Ir a Diseño <ChevronRight className="w-3 h-3 ml-1" />
                </Button>
              </div>
            )}

            {activeModule === "costs" && !simResult && (
              <div className="text-center py-8 space-y-3">
                <DollarSign className="w-10 h-10 text-slate-600 mx-auto" />
                <div className="text-xs text-slate-500">Ejecuta una simulación primero para calcular costos</div>
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 text-xs" onClick={() => setActiveModule("simulate")}>
                  Ir a Simulación <ChevronRight className="w-3 h-3 ml-1" />
                </Button>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
