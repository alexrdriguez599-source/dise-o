import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authHeaders } from '@/services/auth';
import { useAppContext } from '@/context/app-context';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Search, Plus, Loader2, RefreshCw, WifiOff,
  Trash2, ImagePlus, Package, Leaf, X, Check, ExternalLink
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from 'wouter';

/* ─────────────── Constants ─────────────────────────────────────────────── */
const LS_PLANTS_CACHE = "urbanai_inventory_cache";
const LS_DECORATIONS  = "urbanai_decorations_v1";

/* ─────────────── Types ──────────────────────────────────────────────────── */
interface DecoItem {
  id: string;
  name: string;
  price: number;
  imageData?: string;
  note?: string;
}

/* ─────────────── Helpers ────────────────────────────────────────────────── */
function loadCachedInventory(): any[] {
  try { return JSON.parse(localStorage.getItem(LS_PLANTS_CACHE) ?? "[]"); }
  catch { return []; }
}
function loadDecorations(): DecoItem[] {
  try { return JSON.parse(localStorage.getItem(LS_DECORATIONS) ?? "[]"); }
  catch { return []; }
}
function uid() { return `${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }

/* Guard a nivel de módulo: evita que la migración corra dos veces en el mismo
   ciclo de página (p.ej. doble montaje de React StrictMode en desarrollo). */
let decorationsMigrationStarted = false;

/* ─────────────── Shared item card ──────────────────────────────────────── */
function ItemCard({
  id, name, price, imageData, hasImage, itemType,
  onDragStart, onTap, onDelete
}: {
  id: string; name: string; price: number;
  imageData?: string; hasImage?: boolean; itemType?: string;
  onDragStart: (e: React.DragEvent) => void;
  onTap: () => void;
  onDelete?: () => void;
}) {
  const imgSrc = imageData ?? (hasImage ? `/api/inventory/${id}/image` : null);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onTap}
      className="relative bg-card border border-border rounded-2xl p-3 flex flex-col items-center text-center cursor-pointer hover:border-primary/50 transition-colors shadow-sm active:scale-95 group"
    >
      {onDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete(); }}
          className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-destructive/90 text-white rounded-full w-5 h-5 flex items-center justify-center z-10"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      )}
      {imgSrc ? (
        <img src={imgSrc} alt={name} className="w-14 h-14 object-cover rounded-full mb-3 shadow-inner bg-muted" />
      ) : (
        <div className="w-14 h-14 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xl font-bold mb-3 shadow-inner">
          {name.charAt(0).toUpperCase()}
        </div>
      )}
      <span className="text-xs font-semibold text-foreground line-clamp-2 leading-tight mb-1">{name}</span>
      {itemType && <span className="text-[10px] text-muted-foreground mb-1">{itemType}</span>}
      <span className="text-xs font-bold text-primary mt-auto">${(price || 0).toLocaleString('es-MX')}</span>
    </div>
  );
}

/* ─────────────── Add-decoration form ───────────────────────────────────── */
function AddDecoForm({ onAdd }: { onAdd: (item: DecoItem) => void }) {
  const [open, setOpen]       = useState(false);
  const [name, setName]       = useState('');
  const [price, setPrice]     = useState('');
  const [note, setNote]       = useState('');
  const [imgData, setImgData] = useState<string | undefined>();
  const fileRef               = useRef<HTMLInputElement>(null);

  const reset = () => { setName(''); setPrice(''); setNote(''); setImgData(undefined); setOpen(false); };

  const handleImg = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setImgData(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleSave = () => {
    if (!name.trim()) return;
    onAdd({ id: uid(), name: name.trim(), price: parseFloat(price) || 0, note: note.trim() || undefined, imageData: imgData });
    reset();
  };

  if (!open) return (
    <button
      onClick={() => setOpen(true)}
      className="mx-4 my-3 w-[calc(100%-2rem)] flex items-center justify-center gap-2 border-2 border-dashed border-border rounded-xl py-3 text-sm text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors"
    >
      <Plus className="w-4 h-4" /> Agregar accesorio
    </button>
  );

  return (
    <div className="mx-4 my-3 bg-card border border-border rounded-2xl p-4 space-y-3 shadow-md">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">Nuevo accesorio</span>
        <button onClick={reset} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
      </div>

      {/* Image preview / pick */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => fileRef.current?.click()}
          className="w-14 h-14 rounded-full bg-muted flex items-center justify-center border-2 border-dashed border-border hover:border-primary/50 transition-colors overflow-hidden shrink-0"
        >
          {imgData
            ? <img src={imgData} alt="preview" className="w-full h-full object-cover" />
            : <ImagePlus className="w-5 h-5 text-muted-foreground" />}
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleImg} />
        <div className="flex-1 space-y-1.5">
          <Input
            placeholder="Nombre del accesorio *"
            value={name}
            onChange={e => setName(e.target.value)}
            className="h-8 text-xs"
          />
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground shrink-0">$</span>
            <Input
              type="number" min="0" step="1"
              placeholder="Precio MXN"
              value={price}
              onChange={e => setPrice(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        </div>
      </div>

      <Input
        placeholder="Nota opcional (ej: color, tamaño)"
        value={note}
        onChange={e => setNote(e.target.value)}
        className="h-8 text-xs"
      />

      <Button size="sm" className="w-full gap-2" onClick={handleSave} disabled={!name.trim()}>
        <Check className="w-3.5 h-3.5" /> Guardar accesorio
      </Button>
    </div>
  );
}

/* ─────────────── Main component ─────────────────────────────────────────── */
export default function InventoryPanel() {
  const { data: apiItems, isLoading, isError, refetch, isFetching, failureCount } = useQuery({
    queryKey: ['listInventoryItems'],
    queryFn: async () => {
      const res = await fetch('/api/inventory', { credentials: 'include', headers: authHeaders() });
      if (!res.ok) throw new Error('Failed to fetch inventory');
      const body = await res.json();
      return Array.isArray(body) ? body : (body.items ?? body.data ?? []);
    },
  });
  const isStartingUp = isFetching && failureCount > 0 && failureCount <= 3;
  const queryClient                 = useQueryClient();
  const [search, setSearch]         = useState('');
  const { addDesignItem }           = useAppContext();
  const [cachedItems, setCachedItems] = useState<any[]>([]);

  /* ── bootstrap ── */
  useEffect(() => { setCachedItems(loadCachedInventory()); }, []);

  /* ── migración única: decoraciones viejas en localStorage → base de datos
        (category="material"). Diseñada para no perder ni duplicar datos:
        - espera a tener el inventario de la DB para deduplicar por nombre,
        - omite los que ya existen como material (idempotente ante reintentos),
        - solo marca "migrado" si TODOS los envíos tuvieron éxito; si alguno
          falla, reintenta en la próxima carga (sin perder datos). ── */
  useEffect(() => {
    if (decorationsMigrationStarted) return;
    if (localStorage.getItem("urbanai_decorations_migrated_v1")) return;
    if (!apiItems) return; // esperar el inventario actual para poder deduplicar
    const old = loadDecorations();
    if (old.length === 0) { localStorage.setItem("urbanai_decorations_migrated_v1", "1"); return; }
    decorationsMigrationStarted = true;
    (async () => {
      const existingNames = new Set(
        (apiItems as any[])
          .filter(i => (i.category ?? '').toLowerCase() === 'material')
          .map(i => String(i.name).toLowerCase().trim())
      );
      let failures = 0;
      for (const d of old) {
        const key = String(d.name).toLowerCase().trim();
        if (existingNames.has(key)) continue; // ya migrado antes → evita duplicados
        try {
          const res = await fetch('/api/inventory', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
              name: d.name, price: d.price, category: 'material',
              notes: d.note, imageData: d.imageData,
              quantity: 1, unit: 'u', status: 'available',
            }),
          });
          if (!res.ok) { failures++; continue; }
          existingNames.add(key);
        } catch { failures++; }
      }
      if (failures === 0) {
        localStorage.setItem("urbanai_decorations_migrated_v1", "1");
      } else {
        decorationsMigrationStarted = false; // permite reintentar en la próxima carga
      }
      queryClient.invalidateQueries({ queryKey: ['listInventoryItems'] });
    })();
  }, [apiItems, queryClient]);

  useEffect(() => {
    if (apiItems && apiItems.length >= 0) {
      try { localStorage.setItem(LS_PLANTS_CACHE, JSON.stringify(apiItems)); }
      catch { /* quota */ }
    }
  }, [apiItems]);

  /* ── computed ── */
  const displayItems = apiItems ?? cachedItems;
  const isCached     = !apiItems && cachedItems.length > 0;

  const plantItems = displayItems.filter((i: any) => {
    const cat = (i.category ?? '').toLowerCase();
    const type = (i.itemType ?? '').toLowerCase();
    const matchCat = cat === 'plant' || cat === 'plants' || cat === 'planta' || cat === 'plantas';
    const matchType = type.includes('plant') || type.includes('plant') || type.includes('árbol') || type.includes('arbol');
    return matchCat || matchType;
  });

  const filteredPlants = plantItems.filter((i: any) =>
    i.name.toLowerCase().includes(search.toLowerCase())
  );

  const materialItems = displayItems.filter((i: any) => {
    const cat = (i.category ?? '').toLowerCase();
    return cat === 'material' || cat === 'materiales' || cat === 'materials';
  });

  const filteredMaterials = materialItems.filter((i: any) =>
    i.name.toLowerCase().includes(search.toLowerCase())
  );

  /* ── drag/tap helpers ── */
  const makeDragStartAPI = (item: any) => (e: React.DragEvent) => {
    const imgData = item.imageData ?? (item.hasImage ? `/api/inventory/${item.id}/image` : null);
    e.dataTransfer.setData('application/json', JSON.stringify({
      inventoryItemId: item.id, name: item.name, imageData: imgData, price: item.price || 0,
    }));
  };

  const makeTapAPI = (item: any) => () => {
    const imgData = item.imageData ?? (item.hasImage ? `/api/inventory/${item.id}/image` : null);
    addDesignItem({ inventoryItemId: item.id, name: item.name, imageData: imgData, price: item.price || 0,
      x: 45 + Math.random() * 10, y: 45 + Math.random() * 10, scale: 1, rotation: 0 });
  };

  const createMaterial = useMutation({
    mutationFn: async (item: DecoItem) => {
      const res = await fetch('/api/inventory', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          name: item.name, price: item.price, category: 'material',
          notes: item.note, imageData: item.imageData,
          quantity: 1, unit: 'u', status: 'available',
        }),
      });
      if (!res.ok) throw new Error('Create failed');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['listInventoryItems'] }),
  });

  const deleteMaterial = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/inventory/${id}`, {
        method: 'DELETE', credentials: 'include', headers: authHeaders(),
      });
      if (!res.ok) throw new Error('Delete failed');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['listInventoryItems'] }),
  });

  const showLoading = isLoading && cachedItems.length === 0;

  return (
    <div className="w-full md:w-[320px] lg:w-[380px] flex flex-col bg-background/50 backdrop-blur border-r border-border h-full">
      {/* Header */}
      <div className="p-4 border-b border-border bg-card/80 shrink-0 space-y-3">
        <h2 className="font-semibold text-lg">Elementos</h2>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 h-10 bg-background rounded-xl border-border"
          />
        </div>

        {isStartingUp && (
          <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600 shrink-0" />
            <span className="text-[11px] text-blue-700 font-medium">Iniciando servidor…</span>
          </div>
        )}

        {isError && !isStartingUp && (
          <div className="flex items-center justify-between gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] text-amber-700 font-medium">
              <WifiOff className="w-3.5 h-3.5 shrink-0" />
              {isCached ? "Datos guardados localmente" : "Sin conexión"}
            </div>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="text-[11px] text-amber-700 hover:text-amber-900 flex items-center gap-1 font-medium"
            >
              {isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Reintentar
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="plantas" className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="w-full grid grid-cols-2 rounded-none border-b border-border h-12 bg-transparent px-0 shrink-0">
          <TabsTrigger
            value="plantas"
            className="flex items-center gap-2 rounded-none data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-emerald-500 data-[state=active]:text-emerald-600 font-medium"
          >
            <Leaf className="w-4 h-4" />
            Plantas
          </TabsTrigger>
          <TabsTrigger
            value="materiales"
            className="flex items-center gap-2 rounded-none data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-sky-500 data-[state=active]:text-sky-600 font-medium"
          >
            <Package className="w-4 h-4" />
            Materiales
          </TabsTrigger>
        </TabsList>

        {/* ── PLANTAS ── */}
        <TabsContent value="plantas" className="m-0 border-none outline-none flex-1 flex flex-col overflow-hidden">
          <div className="px-4 pt-2 pb-1 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Leaf className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <p className="text-xs text-muted-foreground">Catálogo de plantas</p>
            </div>
            <Link href="/inventario">
              <span className="text-xs font-medium text-emerald-600 hover:text-emerald-700 cursor-pointer flex items-center gap-0.5">
                <Plus className="w-3 h-3" />
                Gestionar
              </span>
            </Link>
          </div>
          <ScrollArea className="flex-1">
            {showLoading ? (
              <div className="p-8 text-center text-muted-foreground text-sm flex flex-col items-center gap-2">
                <Loader2 className="w-6 h-6 animate-spin" />
                Cargando plantas...
              </div>
            ) : filteredPlants.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <Leaf className="w-8 h-8 text-muted-foreground/40 mx-auto" />
                <p className="text-sm text-muted-foreground">
                  {search ? "Sin coincidencias" : "Sin plantas en el catálogo"}
                </p>
                <p className="text-xs text-muted-foreground/70">
                  Agrega plantas desde Inventario → categoría "Planta"
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 p-4">
                {filteredPlants.map((item: any) => (
                  <ItemCard
                    key={item.id}
                    id={item.id}
                    name={item.name}
                    price={item.price || 0}
                    imageData={item.imageData}
                    hasImage={item.hasImage}
                    itemType={item.itemType}
                    onDragStart={makeDragStartAPI(item)}
                    onTap={makeTapAPI(item)}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </TabsContent>

        {/* ── MATERIALES / DECORACIÓN ── */}
        <TabsContent value="materiales" className="m-0 border-none outline-none flex-1 flex flex-col overflow-hidden">
          <ScrollArea className="flex-1">
            {/* Subtitle */}
            <div className="px-4 pt-3 pb-1 flex items-center gap-2">
              <Package className="w-3.5 h-3.5 text-sky-500 shrink-0" />
              <p className="text-xs text-muted-foreground">
                Tu inventario de decoración — arrastra al diseño o toca para colocar
              </p>
            </div>

            {/* Add form */}
            <AddDecoForm onAdd={(item) => createMaterial.mutate(item)} />

            {/* Items grid */}
            {showLoading ? (
              <div className="p-8 text-center text-muted-foreground text-sm flex flex-col items-center gap-2">
                <Loader2 className="w-6 h-6 animate-spin" />
                Cargando materiales...
              </div>
            ) : filteredMaterials.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <Package className="w-8 h-8 text-muted-foreground/40 mx-auto" />
                <p className="text-sm text-muted-foreground">
                  {search ? "Sin coincidencias" : "Sin materiales aún"}
                </p>
                <p className="text-xs text-muted-foreground/70">
                  Usa el botón de arriba para agregar tus materiales
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 px-4 pb-4">
                {filteredMaterials.map((item: any) => (
                  <ItemCard
                    key={item.id}
                    id={item.id}
                    name={item.name}
                    price={item.price || 0}
                    imageData={item.imageData}
                    hasImage={item.hasImage}
                    itemType={item.notes || item.itemType || 'Material'}
                    onDragStart={makeDragStartAPI(item)}
                    onTap={makeTapAPI(item)}
                    onDelete={() => deleteMaterial.mutate(item.id)}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
