import React, { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useAppContext } from "@/context/app-context";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft, Save, Loader2, Package, PenTool, X, MonitorPlay,
  FileText, Users, CheckCircle2, Trash2, Undo2, Mountain,
  CloudOff, Clock, AlertCircle,
} from "lucide-react";
import InventoryPanel from "@/components/inventory-panel";
import DesignCanvas, { type DesignCanvasRef } from "@/components/design-canvas";
import { useToast } from "@/hooks/use-toast";
import { useDeviceType, useOrientation } from "@/hooks/use-device";
import { getProject, saveProject } from "@/services/crm-db";
import { generateProjectPDF } from "@/services/pdf-generator";
import { useAutoSave, type SaveStatus } from "@/hooks/use-auto-save";

// ─── Indicador de estado de guardado ──────────────────────────────────────────
function SaveIndicator({ status, label, version }: { status: SaveStatus; label: string; version: number }) {
  if (status === "idle") return null;

  const cfg: Record<SaveStatus, { icon: React.ReactNode; text: string; cls: string }> = {
    idle:    { icon: null, text: "", cls: "" },
    pending: {
      icon: <Clock className="w-3 h-3" />,
      text: "Cambios sin guardar",
      cls:  "text-amber-600 bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800",
    },
    saving: {
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
      text: "Guardando...",
      cls:  "text-blue-600 bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800",
    },
    saved: {
      icon: <CheckCircle2 className="w-3 h-3" />,
      text: label ? `Guardado ${label}` : "Guardado",
      cls:  "text-emerald-600 bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800",
    },
    error: {
      icon: <AlertCircle className="w-3 h-3" />,
      text: "Sin conexión — backup local OK",
      cls:  "text-orange-600 bg-orange-50 border-orange-200 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800",
    },
  };

  const { icon, text, cls } = cfg[status];
  if (!text) return null;

  return (
    <div className={`hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] font-medium transition-all duration-300 ${cls}`}>
      {icon}
      <span>{text}</span>
      {status === "saved" && version > 0 && (
        <span className="opacity-60 ml-0.5">v{version}</span>
      )}
    </div>
  );
}

// ─── Página de diseño ──────────────────────────────────────────────────────────
export default function DesignPage() {
  const {
    clientInfo,
    setClientInfo,
    totalProjectCost,
    gardenImage,
    setGardenImage,
    projectId,
    setProjectId,
    isOnline,
    materialCosts,
    designItems,
    clearDesignItems,
    clearMaterialCosts,
    undoGardenImage,
    canUndo,
    pricePerM2,
    grassAreaM2,
    activeMaterialId,
    cadPolygons,
    cadXform,
  } = useAppContext();

  const [, setLocation]   = useLocation();
  const { toast }         = useToast();
  const deviceType        = useDeviceType();
  const orientation       = useOrientation();
  const canvasRef         = useRef<DesignCanvasRef>(null);

  const [mobilePanel, setMobilePanel] = useState<"inventory" | null>(null);
  const [crmSaving, setCrmSaving]     = useState(false);
  const [crmSaved, setCrmSaved]       = useState(false);
  const [pdfLoading, setPdfLoading]   = useState(false);

  const crmClientId  = localStorage.getItem("crm_activeClientId");
  const crmProjectId = localStorage.getItem("crm_activeProjectId");

  // ── Auto-guardado ───────────────────────────────────────────────────────────
  const { status: saveStatus, lastSavedLabel, savedVersion, manualSave } = useAutoSave(
    {
      projectId,
      clientInfo,
      designItems,
      materialCosts,
      pricePerM2,
      grassAreaM2,
      activeMaterialId,
      cadPolygons,
      cadXform,
      totalProjectCost,
      gardenImage,
    },
    {
      debounceMs:   5000,
      enabled:      !!clientInfo,
      onNewProject: (newId) => {
        setProjectId(newId);
      },
    }
  );

  // ── Ctrl+S: guardado manual ─────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleManualSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Redirigir si no hay cliente ─────────────────────────────────────────────
  useEffect(() => {
    if (!clientInfo) setLocation("/");
  }, [clientInfo, setLocation]);

  if (!clientInfo) return null;

  // ── Guardado manual (botón + Ctrl+S) ───────────────────────────────────────
  const handleManualSave = async () => {
    if (!isOnline) {
      toast({
        title: "Sin conexión",
        description: "Datos guardados localmente. Se sincronizarán cuando vuelva internet.",
      });
      return;
    }
    try {
      const result = await manualSave();
      if (result) {
        toast({
          title: "Proyecto guardado ✓",
          description: `Versión ${result.version} — ${new Date().toLocaleTimeString("es-MX")}`,
        });
      }
    } catch {
      toast({ title: "Error al guardar", variant: "destructive" });
    }
  };

  // ── Guardar en CRM (IndexedDB) ───────────────────────────────────────────────
  const handleCrmSave = async () => {
    if (!crmProjectId) {
      toast({
        title: "Sin proyecto CRM activo",
        description: "Abre el proyecto desde el panel de clientes.",
        variant: "destructive",
      });
      return;
    }
    setCrmSaving(true);
    try {
      const existing = await getProject(crmProjectId);
      if (!existing) throw new Error("Proyecto no encontrado");
      const now = new Date().toISOString();
      const zonas = materialCosts.map(c => ({
        nombre: c.materialName, material: c.materialName,
        areaM2: c.areaM2, perimeterM: c.perimeterM,
        unitType: c.unitType, pricePerM2: c.pricePerM2, total: c.total,
      }));
      const plantas = designItems.map(d => ({
        nombre: d.name, cantidad: d.quantity ?? 1,
        precioUnitario: d.unitPrice ?? d.price,
        subtotal: (d.quantity ?? 1) * (d.unitPrice ?? d.price),
      }));
      await saveProject({
        ...existing,
        totalCotizacion: totalProjectCost,
        gardenImageData: gardenImage ?? undefined,
        zonas:   JSON.stringify(zonas),
        plantas: JSON.stringify(plantas),
        updatedAt: now,
      });
      setCrmSaved(true);
      setTimeout(() => setCrmSaved(false), 3000);
      toast({ title: "Guardado en CRM ✓", description: "Proyecto actualizado en el historial del cliente." });
    } catch (err) {
      console.error(err);
      toast({ title: "Error al guardar en CRM", variant: "destructive" });
    } finally {
      setCrmSaving(false);
    }
  };

  // ── Generar PDF ──────────────────────────────────────────────────────────────
  const handleGeneratePDF = async () => {
    setPdfLoading(true);
    try {
      const zonas = materialCosts.map(c => ({
        nombre: c.materialName, material: c.materialName,
        areaM2: c.areaM2, perimeterM: c.perimeterM,
        unitType: c.unitType, pricePerM2: c.pricePerM2, total: c.total,
      }));
      const plantas = designItems.map(d => ({
        nombre: d.name, cantidad: d.quantity ?? 1,
        precioUnitario: d.unitPrice ?? d.price,
        subtotal: (d.quantity ?? 1) * (d.unitPrice ?? d.price),
      }));

      let compositeImageData = gardenImage ?? undefined;
      if (canvasRef.current) {
        try {
          const composite = await canvasRef.current.buildCompositeImage();
          if (composite) compositeImageData = composite;
        } catch { /* fallback a gardenImage */ }
      }

      const pdfDataUri = await generateProjectPDF({
        clienteNombre:    clientInfo.name,
        clienteTelefono:  clientInfo.phone,
        clienteEmail:     "",
        clienteDireccion: clientInfo.address,
        proyectoNombre:   (crmProjectId ? (await getProject(crmProjectId))?.nombre : null) ?? "Proyecto",
        proyectoFecha:    new Date().toISOString(),
        zonas,
        plantas,
        totalCotizacion:  totalProjectCost,
        gardenImageData:  compositeImageData,
      });

      if (crmProjectId) {
        const existing = await getProject(crmProjectId);
        if (existing) {
          await saveProject({ ...existing, pdfData: pdfDataUri, updatedAt: new Date().toISOString() });
        }
      }
      const link = document.createElement("a");
      link.href     = pdfDataUri;
      link.download = `cotizacion-${clientInfo.name.replace(/\s+/g, "-")}.pdf`;
      link.click();
      toast({ title: "PDF generado ✓", description: "Cotización descargada correctamente." });
    } catch (err) {
      console.error(err);
      toast({ title: "Error al generar PDF", variant: "destructive" });
    } finally {
      setPdfLoading(false);
    }
  };

  // ── Terminar trabajo ─────────────────────────────────────────────────────────
  const handleFinishWork = () => {
    if (!confirm(`¿Terminar el trabajo con ${clientInfo?.name}?\n\nSe limpiará la sesión actual y volverás al selector de clientes. El historial en CRM queda guardado.`)) return;
    clearDesignItems();
    clearMaterialCosts();
    setGardenImage(null);
    setClientInfo(null);
    setProjectId(null);
    localStorage.removeItem("crm_activeClientId");
    localStorage.removeItem("crm_activeProjectId");
    localStorage.removeItem("garden_gardenImage");
    setLocation("/");
  };

  const isSavingManual = saveStatus === "saving";
  const isMobile       = deviceType === "mobile";
  const isTablet       = deviceType === "tablet";
  const isDesktop      = deviceType === "desktop";
  const showDesktopSide  = isDesktop;
  const showTabletSide   = isTablet && orientation === "landscape";
  const showInventorySide = showDesktopSide || showTabletSide;

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-background overflow-hidden">

      {/* ── HEADER ──────────────────────────────────────────────────────────── */}
      <header className="h-14 md:h-16 shrink-0 border-b border-border bg-card/80 backdrop-blur z-20
                         flex items-center justify-between px-3 md:px-4 gap-2">

        {/* Left: back + client info */}
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/")} className="shrink-0 w-9 h-9 md:hidden">
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLocation("/")} className="shrink-0 hidden md:flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <ChevronLeft className="w-4 h-4" />
            Volver
          </Button>
          <div className="flex flex-col min-w-0">
            <span className="font-semibold text-sm md:text-base text-foreground truncate">{clientInfo.name}</span>
            <span className="text-[10px] md:text-xs text-muted-foreground truncate hidden sm:block">{clientInfo.address}</span>
          </div>
        </div>

        {/* Center: save status indicator */}
        <div className="flex-1 flex justify-center">
          <SaveIndicator
            status={saveStatus}
            label={lastSavedLabel}
            version={savedVersion}
          />
        </div>

        {/* Right: action buttons */}
        <div className="flex items-center gap-1 md:gap-1.5 shrink-0">

          {/* Total — desktop */}
          {showInventorySide && (
            <div className="hidden md:flex flex-col items-end mr-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Total</span>
              <span className="text-lg font-bold text-primary">${totalProjectCost.toLocaleString()}</span>
            </div>
          )}

          {/* CAD Pro */}
          <Button
            variant="outline"
            onClick={() => setLocation("/cad")}
            disabled={!gardenImage}
            title={gardenImage ? "Diseñador CAD profesional — medir y trazar zonas" : "Sube una imagen primero"}
            className="h-9 md:h-10 rounded-xl text-xs md:text-sm px-2.5 md:px-3 border-violet-500 text-violet-700 bg-violet-50/60 hover:bg-violet-100 dark:bg-violet-900/20 dark:text-violet-300 dark:hover:bg-violet-900/30 disabled:opacity-40 font-semibold"
          >
            <PenTool className="w-4 h-4 shrink-0" />
            <span className="ml-1.5">CAD</span>
          </Button>

          {/* Pincel / Montaña */}
          <Button
            variant="outline"
            onClick={() => setLocation("/brush")}
            disabled={!gardenImage}
            title={gardenImage ? "Pincel de terreno — genera montañas de pasto 2.5D" : "Sube una imagen primero"}
            className="h-9 md:h-10 rounded-xl text-xs md:text-sm px-2.5 md:px-3 border-emerald-500 text-emerald-700 bg-emerald-50/60 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30 disabled:opacity-40 font-semibold"
          >
            <Mountain className="w-4 h-4 shrink-0" />
            <span className="ml-1.5 hidden sm:inline">Montaña</span>
          </Button>

          {/* Restaurar */}
          <Button
            variant="outline"
            onClick={undoGardenImage}
            disabled={!canUndo}
            title="Restaurar imagen anterior"
            className="h-9 md:h-10 rounded-xl text-xs md:text-sm px-2 md:px-3 border-orange-400 text-orange-600 hover:bg-orange-50 dark:text-orange-300 dark:hover:bg-orange-900/20 disabled:opacity-30"
          >
            <Undo2 className="w-4 h-4" />
            <span className="hidden lg:inline ml-1.5">Restaurar</span>
          </Button>

          {/* Guardar (manual + imagen) */}
          <Button
            onClick={handleManualSave}
            disabled={isSavingManual}
            title="Guardar proyecto completo (Ctrl+S)"
            className="h-9 md:h-10 rounded-xl text-xs md:text-sm px-2.5 md:px-4"
          >
            {isSavingManual
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : saveStatus === "error"
              ? <CloudOff className="w-4 h-4" />
              : <Save className="w-4 h-4" />}
            <span className="hidden sm:inline ml-1.5">Guardar</span>
          </Button>

          {/* PDF */}
          <Button
            variant="outline"
            onClick={handleGeneratePDF}
            disabled={pdfLoading}
            title="Generar PDF cotización para el cliente"
            className="h-9 md:h-10 rounded-xl text-xs md:text-sm px-2 md:px-3 border-sky-400 text-sky-600 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-900/20 hidden sm:flex"
          >
            {pdfLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            <span className="hidden lg:inline ml-1.5">PDF</span>
          </Button>

          {/* CRM save */}
          {crmProjectId && (
            <Button
              variant="outline"
              onClick={handleCrmSave}
              disabled={crmSaving}
              title="Guardar en CRM"
              className={`h-9 md:h-10 rounded-xl text-xs md:text-sm px-2 md:px-3 hidden sm:flex transition-all ${
                crmSaved
                  ? "border-emerald-400 text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20"
                  : "border-violet-400 text-violet-600 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-900/20"
              }`}
            >
              {crmSaving
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : crmSaved
                ? <CheckCircle2 className="w-4 h-4" />
                : <Users className="w-4 h-4" />}
              <span className="hidden lg:inline ml-1.5">{crmSaved ? "Guardado" : "CRM"}</span>
            </Button>
          )}

          {/* Presentación */}
          <Button
            variant="secondary"
            onClick={() => setLocation("/presentacion")}
            className="h-9 md:h-10 rounded-xl text-xs md:text-sm px-2 md:px-3 hidden sm:flex"
            title="Presentación para el cliente"
          >
            <MonitorPlay className="w-4 h-4" />
            <span className="hidden md:inline ml-1.5">Presentación</span>
          </Button>

          {/* Terminar trabajo */}
          <Button
            variant="ghost"
            onClick={handleFinishWork}
            title="Terminar trabajo con este cliente"
            className="h-9 md:h-10 rounded-xl px-2 md:px-3 text-destructive hover:bg-destructive/10 hover:text-destructive border border-destructive/30"
          >
            <Trash2 className="w-4 h-4" />
            <span className="hidden lg:inline text-xs ml-1.5">Terminar</span>
          </Button>
        </div>
      </header>

      {/* ── MAIN LAYOUT ─────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* Desktop sidebar */}
        {showDesktopSide && (
          <div className="hidden md:block shrink-0">
            <InventoryPanel />
          </div>
        )}

        {/* Tablet landscape sidebar */}
        {showTabletSide && (
          <div className="w-[280px] shrink-0 border-r border-border">
            <InventoryPanel />
          </div>
        )}

        {/* Canvas area */}
        <main className="flex-1 relative flex flex-col min-w-0 bg-stone-100/50 overflow-hidden">

          {/* Mobile / tablet-portrait info bar */}
          {!showInventorySide && (
            <div className="flex items-center justify-between px-3 py-1.5 bg-card border-b border-border shrink-0">
              <div className="flex flex-col leading-tight">
                <span className="text-[10px] text-muted-foreground font-medium uppercase">Total</span>
                <span className="text-sm font-bold text-primary">${totalProjectCost.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={undoGardenImage}
                  disabled={!canUndo}
                  className="p-1.5 rounded-lg border border-orange-300 text-orange-500 hover:bg-orange-50 disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Restaurar imagen anterior"
                >
                  <Undo2 className="w-4 h-4" />
                </button>
                {pdfLoading
                  ? <Loader2 className="w-4 h-4 animate-spin text-sky-500" />
                  : <button onClick={handleGeneratePDF} className="p-1.5 rounded-lg border border-sky-300 text-sky-600 hover:bg-sky-50" title="Generar PDF">
                      <FileText className="w-4 h-4" />
                    </button>}
                {crmProjectId && (
                  crmSaving
                    ? <Loader2 className="w-4 h-4 animate-spin text-violet-500" />
                    : <button
                        onClick={handleCrmSave}
                        className={`p-1.5 rounded-lg border transition-colors ${crmSaved ? "border-emerald-400 text-emerald-600 bg-emerald-50" : "border-violet-300 text-violet-600 hover:bg-violet-50"}`}
                        title="Guardar en CRM"
                      >
                        {crmSaved ? <CheckCircle2 className="w-4 h-4" /> : <Users className="w-4 h-4" />}
                      </button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setLocation("/presentacion")}
                  className="rounded-lg h-7 text-[11px] px-2"
                >
                  Presentación
                </Button>
              </div>
            </div>
          )}

          <DesignCanvas ref={canvasRef} />
        </main>

        {/* Floating Inventory Panel — mobile / tablet-portrait */}
        {!showInventorySide && mobilePanel === "inventory" && (
          <div className="absolute inset-0 z-40 flex">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setMobilePanel(null)} />
            <div className={`relative z-10 bg-card shadow-2xl flex flex-col ${
              isMobile
                ? "w-full h-[72vh] mt-auto rounded-t-2xl animate-in slide-in-from-bottom duration-200"
                : "w-[360px] h-full border-r border-border animate-in slide-in-from-left duration-200"
            }`}>
              <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <Package className="w-4 h-4 text-emerald-600" />
                  <span className="font-semibold text-sm">Catálogo</span>
                </div>
                <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => setMobilePanel(null)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex-1 overflow-hidden">
                <InventoryPanel />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Catálogo FAB — mobile / tablet-portrait */}
      {!showInventorySide && !mobilePanel && (
        <div className="absolute bottom-4 right-4 z-30">
          <button
            onClick={() => setMobilePanel("inventory")}
            className="w-12 h-12 md:w-14 md:h-14 rounded-full bg-card text-foreground border border-border shadow-lg flex items-center justify-center active:scale-95 transition-transform"
            title="Abrir catálogo"
            style={{ boxShadow: "0 4px 14px rgba(0,0,0,0.15)" }}
          >
            <Package className="w-5 h-5 md:w-6 md:h-6" />
          </button>
        </div>
      )}

    </div>
  );
}
