import React, { useState, useRef, useEffect } from "react";
import AppLayout from "@/components/app-layout";
import { useQuery } from "@tanstack/react-query";
import { authHeaders } from "@/services/auth";
import InventoryList from "@/components/inventory/inventory-list";
import SummaryCards from "@/components/inventory/summary-cards";
import { Button } from "@/components/ui/button";
import { Plus, Search, Download, Upload, Loader2, CheckCircle2, RefreshCw, WifiOff } from "lucide-react";
import ItemDialog from "@/components/inventory/item-dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const LS_CACHE_KEY = "urbanai_inventory_cache";

function loadCachedInventory(): any[] {
  try {
    const raw = localStorage.getItem(LS_CACHE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveCachedInventory(items: any[]) {
  try {
    localStorage.setItem(LS_CACHE_KEY, JSON.stringify(items));
  } catch { /* quota */ }
}

export default function Inventario() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const {
    data: items,
    isLoading,
    isError,
    refetch,
    isFetching,
    failureCount,
  } = useQuery({
    queryKey: ['listInventoryItems'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/inventory`, { credentials: 'include', headers: authHeaders() });
      if (!res.ok) throw new Error('Failed');
      const body = await res.json();
      return Array.isArray(body) ? body : (body.items ?? body.data ?? []);
    },
  });

  // Durante los primeros reintentos (cold-start del servidor) mostramos
  // un mensaje suave en lugar del banner de error alarmante.
  // isError solo es true DESPUÉS de agotar todos los reintentos.
  const isStartingUp = isFetching && failureCount > 0 && failureCount <= 3;

  const { data: summary } = useQuery({
    queryKey: ['getInventorySummary'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/inventory/summary`, { credentials: 'include', headers: authHeaders() });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
  });

  const cachedItems = loadCachedInventory();
  const displayItems = items ?? cachedItems;
  const isCached = !items && cachedItems.length > 0;

  useEffect(() => {
    if (items && items.length >= 0) {
      saveCachedInventory(items);
    }
  }, [items]);

  const inventoryContext = displayItems.length > 0
    ? JSON.stringify(displayItems.map((item: any) => ({
        name: item.name, category: item.category,
        quantity: item.quantity, unit: item.unit, status: item.status,
      })))
    : null;

  const filteredItems = displayItems.filter((item: any) =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.notes?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const openNewDialog = () => { setSelectedItem(null); setDialogOpen(true); };
  const openEditDialog = (item: any) => { setSelectedItem(item); setDialogOpen(true); };

  const handleExport = async () => {
    setExporting(true);
    try {
      const _expTok = localStorage.getItem("urbanai_token");
      const res = await fetch(`${API_BASE}/api/inventory/export`, { credentials: "include", headers: _expTok ? { Authorization: "Bearer " + _expTok } : {} });
      if (!res.ok) throw new Error("Error al exportar");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "inventario-urbanai.json";
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Inventario exportado", description: `${displayItems.length} artículos descargados`, action: <CheckCircle2 className="w-5 h-5 text-green-500" /> });
    } catch {
      toast({ title: "Error al exportar", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error("Formato inválido");
      const _impTok = localStorage.getItem("urbanai_token");
      const res = await fetch(`${API_BASE}/api/inventory/import`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(_impTok ? { Authorization: "Bearer " + _impTok } : {}) },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Error al importar");
      await queryClient.invalidateQueries({ queryKey: ["listInventoryItems"] });
      await queryClient.invalidateQueries({ queryKey: ["getInventorySummary"] });
      toast({
        title: "Importación completada",
        description: result.message,
        action: <CheckCircle2 className="w-5 h-5 text-green-500" />,
      });
    } catch (err: any) {
      toast({ title: "Error al importar", description: err.message ?? "Archivo inválido", variant: "destructive" });
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = "";
    }
  };

  return (
    <AppLayout inventoryContext={inventoryContext}>
      <div className="flex-1 flex flex-col p-4 md:p-8 max-w-7xl mx-auto w-full gap-8">

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Inventario</h1>
            <p className="text-muted-foreground mt-1">Gestiona plantas, materiales y herramientas</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={exporting || displayItems.length === 0}
              className="rounded-xl h-9 gap-1.5"
            >
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Exportar
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => importRef.current?.click()}
              disabled={importing}
              className="rounded-xl h-9 gap-1.5"
            >
              {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              Importar
            </Button>
            <input
              ref={importRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={handleImportFile}
            />

            <Button onClick={openNewDialog} size="sm" className="rounded-xl h-9 gap-1.5">
              <Plus className="w-4 h-4" />
              Nuevo Artículo
            </Button>
          </div>
        </div>

        {isStartingUp && (
          <div className="flex items-center gap-3 bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600 shrink-0" />
            <span className="text-sm text-blue-700 font-medium">
              Iniciando servidor… esto tarda unos segundos la primera vez.
            </span>
          </div>
        )}

        {isError && !isCached && !isStartingUp && (
          <div className="flex items-center justify-between gap-3 bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-destructive font-medium">
              <WifiOff className="w-4 h-4 shrink-0" />
              No se pudo conectar al servidor. Verifica tu conexión.
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="rounded-lg h-8 gap-1.5 shrink-0"
            >
              {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Reintentar
            </Button>
          </div>
        )}

        {isError && isCached && (
          <div className="flex items-center justify-between gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-amber-700 font-medium">
              <WifiOff className="w-4 h-4 shrink-0" />
              Mostrando datos guardados localmente. Sin conexión al servidor.
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="rounded-lg h-8 gap-1.5 shrink-0"
            >
              {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Reintentar
            </Button>
          </div>
        )}

        {summary && <SummaryCards summary={summary} />}

        <div className="flex flex-col gap-4 bg-card p-4 md:p-6 rounded-2xl border border-border shadow-sm">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar artículos..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 bg-background h-10 rounded-xl"
              />
            </div>
          </div>

          <InventoryList
            items={filteredItems}
            isLoading={isLoading && cachedItems.length === 0}
            onEdit={openEditDialog}
          />
        </div>

        <ItemDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          item={selectedItem}
        />
      </div>
    </AppLayout>
  );
}
