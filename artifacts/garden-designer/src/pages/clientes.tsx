import React, { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useAppContext } from "@/context/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft, Plus, Users, FolderOpen, Trash2, Pencil, Download,
  ChevronDown, ChevronRight, Loader2, FileText, DollarSign,
  Calendar, Phone, Mail, MapPin, StickyNote, Search, Check, X,
} from "lucide-react";
import {
  getAllClients, getProjectsByClient, saveClient, saveProject,
  deleteClient, deleteProject, getProject,
  type CRMClient, type CRMProject,
} from "@/services/crm-db";
import { generateProjectPDF, type PDFProjectData } from "@/services/pdf-generator";
import { nanoid } from "nanoid";

interface ClientWithProjects extends CRMClient {
  projects: CRMProject[];
  expanded: boolean;
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

function fmtMXN(n: number) {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export default function ClientesPage() {
  const { setClientInfo, totalProjectCost, gardenImage, materialCosts, designItems } = useAppContext();
  const [, setLocation] = useLocation();

  const [clients, setClients]     = useState<ClientWithProjects[]>([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState("");
  const [editingClient, setEditingClient] = useState<CRMClient | null>(null);
  const [showNewClient, setShowNewClient] = useState(false);
  const [saving, setSaving]       = useState(false);
  const [generatingPDF, setGeneratingPDF] = useState<string | null>(null);

  // New/edit client form state
  const [fNombre, setFNombre]     = useState("");
  const [fTelefono, setFTelefono] = useState("");
  const [fEmail, setFEmail]       = useState("");
  const [fDireccion, setFDireccion] = useState("");
  const [fNotas, setFNotas]       = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const all = await getAllClients();
      const withProjs = await Promise.all(
        all.map(async (c) => ({
          ...c,
          projects: (await getProjectsByClient(c.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          expanded: false,
        })),
      );
      withProjs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setClients(withProjs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const filtered = clients.filter(
    c =>
      c.nombre.toLowerCase().includes(search.toLowerCase()) ||
      c.telefono.includes(search) ||
      c.email.toLowerCase().includes(search.toLowerCase()),
  );

  const toggleExpand = (id: string) =>
    setClients(prev => prev.map(c => c.id === id ? { ...c, expanded: !c.expanded } : c));

  // ── Form helpers ──────────────────────────────────────────────────────────
  const resetForm = () => {
    setFNombre(""); setFTelefono(""); setFEmail(""); setFDireccion(""); setFNotas("");
    setEditingClient(null); setShowNewClient(false);
  };

  const startEdit = (client: CRMClient) => {
    setEditingClient(client);
    setFNombre(client.nombre);
    setFTelefono(client.telefono);
    setFEmail(client.email);
    setFDireccion(client.direccion);
    setFNotas(client.notas);
    setShowNewClient(false);
  };

  const startNew = () => {
    resetForm();
    setShowNewClient(true);
  };

  const handleSaveClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fNombre.trim() || !fTelefono.trim()) return;
    setSaving(true);
    const now = new Date().toISOString();
    const client: CRMClient = editingClient
      ? { ...editingClient, nombre: fNombre.trim(), telefono: fTelefono.trim(), email: fEmail.trim(), direccion: fDireccion.trim(), notas: fNotas.trim(), updatedAt: now }
      : { id: nanoid(), nombre: fNombre.trim(), telefono: fTelefono.trim(), email: fEmail.trim(), direccion: fDireccion.trim(), notas: fNotas.trim(), createdAt: now, updatedAt: now };
    await saveClient(client);
    setSaving(false);
    resetForm();
    reload();
  };

  const handleDeleteClient = async (id: string) => {
    if (!confirm("¿Eliminar este cliente y todos sus proyectos? Esta acción no se puede deshacer.")) return;
    await deleteClient(id);
    reload();
  };

  const handleDeleteProject = async (projectId: string, clientId: string) => {
    if (!confirm("¿Eliminar este proyecto?")) return;
    await deleteProject(projectId);
    setClients(prev => prev.map(c =>
      c.id === clientId ? { ...c, projects: c.projects.filter(p => p.id !== projectId) } : c,
    ));
  };

  // ── Open project in designer ──────────────────────────────────────────────
  const openProject = (client: ClientWithProjects, project: CRMProject) => {
    setClientInfo({ name: client.nombre, phone: client.telefono, address: client.direccion });
    localStorage.setItem("crm_activeClientId", client.id);
    localStorage.setItem("crm_activeProjectId", project.id);
    setLocation("/design");
  };

  // ── New project for client ────────────────────────────────────────────────
  const createAndOpenProject = async (client: ClientWithProjects) => {
    const nombre = prompt(`Nombre del nuevo proyecto para ${client.nombre}:`);
    if (!nombre?.trim()) return;
    const now = new Date().toISOString();
    const project: CRMProject = {
      id: nanoid(), clienteId: client.id, nombre: nombre.trim(),
      fecha: now, totalCotizacion: 0, createdAt: now, updatedAt: now,
    };
    await saveProject(project);
    openProject(client, project);
  };

  // ── Generate & download PDF ───────────────────────────────────────────────
  const handleGeneratePDF = async (client: ClientWithProjects, project: CRMProject) => {
    setGeneratingPDF(project.id);
    try {
      const pdfData: PDFProjectData = {
        clienteNombre: client.nombre,
        clienteTelefono: client.telefono,
        clienteEmail: client.email,
        clienteDireccion: client.direccion,
        proyectoNombre: project.nombre,
        proyectoFecha: project.fecha,
        zonas: (project.zonas ? JSON.parse(project.zonas) : []),
        plantas: (project.plantas ? JSON.parse(project.plantas) : []),
        totalCotizacion: project.totalCotizacion,
        gardenImageData: project.gardenImageData,
        notas: client.notas || undefined,
      };
      const uri = await generateProjectPDF(pdfData);
      // Save PDF to project record
      const now = new Date().toISOString();
      await saveProject({ ...project, pdfData: uri, updatedAt: now });
      // Download
      const link = document.createElement("a");
      link.href = uri;
      link.download = `cotizacion-${client.nombre.replace(/\s+/g, "-")}-${project.nombre.replace(/\s+/g, "-")}.pdf`;
      link.click();
    } catch (err) {
      console.error("PDF error:", err);
      alert("Error al generar PDF. Intenta de nuevo.");
    } finally {
      setGeneratingPDF(null);
    }
  };

  const handleDownloadExistingPDF = (client: ClientWithProjects, project: CRMProject) => {
    if (!project.pdfData) return;
    const link = document.createElement("a");
    link.href = project.pdfData;
    link.download = `cotizacion-${client.nombre.replace(/\s+/g, "-")}-${project.nombre.replace(/\s+/g, "-")}.pdf`;
    link.click();
  };

  // ── Totals ────────────────────────────────────────────────────────────────
  const totalClients = clients.length;
  const totalProjects = clients.reduce((s, c) => s + c.projects.length, 0);
  const totalRevenue = clients.reduce((s, c) => s + c.projects.reduce((sp, p) => sp + p.totalCotizacion, 0), 0);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">

      {/* Header */}
      <header className="shrink-0 border-b border-border bg-card/80 backdrop-blur px-4 md:px-6 py-3 flex items-center gap-3">
        <button onClick={() => setLocation("/")} className="text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-muted transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="font-bold text-foreground text-base">CRM — Clientes y Proyectos</h1>
          <p className="text-xs text-muted-foreground">Gestión completa · datos guardados localmente</p>
        </div>
        <Button onClick={startNew} className="rounded-xl gap-1.5 shadow-sm h-9">
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Nuevo cliente</span>
        </Button>
      </header>

      {/* Stats bar */}
      <div className="shrink-0 bg-card/60 border-b border-border/50 px-4 md:px-6 py-2.5 flex items-center gap-6 overflow-x-auto">
        {[
          { label: "Clientes", value: totalClients, Icon: Users },
          { label: "Proyectos", value: totalProjects, Icon: FolderOpen },
          { label: "Cotizaciones", value: fmtMXN(totalRevenue), Icon: DollarSign },
        ].map(({ label, value, Icon }) => (
          <div key={label} className="flex items-center gap-2 shrink-0">
            <Icon className="w-4 h-4 text-primary" />
            <span className="text-sm font-bold text-foreground">{value}</span>
            <span className="text-xs text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>

      <div className="flex-1 max-w-3xl w-full mx-auto px-4 py-5 flex flex-col gap-4">

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre, teléfono o email…" className="pl-9 rounded-xl" />
        </div>

        {/* New / Edit client form */}
        {(showNewClient || editingClient) && (
          <div className="bg-primary/5 border border-primary/20 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-foreground">{editingClient ? "Editar cliente" : "Nuevo cliente"}</h2>
              <button onClick={resetForm} className="text-muted-foreground hover:text-foreground p-1 rounded-lg hover:bg-muted transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveClient} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2 space-y-1">
                <Label className="text-xs font-medium">Nombre completo *</Label>
                <Input value={fNombre} onChange={e => setFNombre(e.target.value)} placeholder="María García" className="rounded-xl" required />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">Teléfono *</Label>
                <Input value={fTelefono} onChange={e => setFTelefono(e.target.value)} placeholder="555 123 4567" type="tel" className="rounded-xl" required />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">Email</Label>
                <Input value={fEmail} onChange={e => setFEmail(e.target.value)} placeholder="correo@ejemplo.com" type="email" className="rounded-xl" />
              </div>
              <div className="sm:col-span-2 space-y-1">
                <Label className="text-xs font-medium">Dirección</Label>
                <Input value={fDireccion} onChange={e => setFDireccion(e.target.value)} placeholder="Av. Principal 123" className="rounded-xl" />
              </div>
              <div className="sm:col-span-2 space-y-1">
                <Label className="text-xs font-medium">Notas</Label>
                <textarea value={fNotas} onChange={e => setFNotas(e.target.value)} placeholder="Referencias, preferencias…" rows={2}
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none" />
              </div>
              <div className="sm:col-span-2 flex gap-2 justify-end">
                <Button type="button" variant="outline" onClick={resetForm} className="rounded-xl">Cancelar</Button>
                <Button type="submit" disabled={saving || !fNombre.trim() || !fTelefono.trim()} className="rounded-xl gap-1.5">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  {editingClient ? "Guardar cambios" : "Crear cliente"}
                </Button>
              </div>
            </form>
          </div>
        )}

        {/* Client list */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center py-16">
            <Loader2 className="w-7 h-7 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">{search ? "Sin resultados" : "Sin clientes aún"}</p>
            <p className="text-sm mt-1">{search ? "Prueba con otra búsqueda" : "Crea tu primer cliente"}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map(client => (
              <div key={client.id} className="bg-card border border-border rounded-2xl overflow-hidden">

                {/* Client header */}
                <div className="flex items-start gap-3 p-4">
                  <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <Users className="w-4.5 h-4.5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-foreground truncate">{client.nombre}</p>
                      <span className="text-[11px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium shrink-0">
                        {client.projects.length} proyecto{client.projects.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Phone className="w-3 h-3" />{client.telefono}
                      </span>
                      {client.email && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Mail className="w-3 h-3" />{client.email}
                        </span>
                      )}
                      {client.direccion && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1 truncate max-w-[180px]">
                          <MapPin className="w-3 h-3 shrink-0" />{client.direccion}
                        </span>
                      )}
                    </div>
                    {client.notas && (
                      <p className="text-xs text-muted-foreground/70 mt-1 flex items-start gap-1">
                        <StickyNote className="w-3 h-3 shrink-0 mt-0.5" />
                        <span className="line-clamp-1">{client.notas}</span>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => createAndOpenProject(client)} title="Nuevo proyecto" className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
                      <Plus className="w-4 h-4" />
                    </button>
                    <button onClick={() => startEdit(client)} title="Editar cliente" className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDeleteClient(client.id)} title="Eliminar cliente" className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => toggleExpand(client.id)} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                      {client.expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Projects list (expandable) */}
                {client.expanded && (
                  <div className="border-t border-border/50 bg-muted/20">
                    {client.projects.length === 0 ? (
                      <div className="px-4 py-4 text-center">
                        <p className="text-sm text-muted-foreground">Sin proyectos</p>
                        <button onClick={() => createAndOpenProject(client)} className="text-sm text-primary underline underline-offset-2 mt-1 hover:text-primary/80">
                          Crear primer proyecto →
                        </button>
                      </div>
                    ) : (
                      <div className="divide-y divide-border/50">
                        {client.projects.map(project => (
                          <div key={project.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                            <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">{project.nombre}</p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-xs text-muted-foreground flex items-center gap-1">
                                  <Calendar className="w-3 h-3" />{fmtDate(project.fecha)}
                                </span>
                                {project.totalCotizacion > 0 && (
                                  <span className="text-xs font-semibold text-emerald-600 flex items-center gap-0.5">
                                    <DollarSign className="w-3 h-3" />{fmtMXN(project.totalCotizacion)}
                                  </span>
                                )}
                                {project.pdfData && (
                                  <span className="text-[10px] bg-sky-500/10 text-sky-600 px-1.5 py-0.5 rounded font-medium">PDF</span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => openProject(client, project)}
                                title="Abrir en diseñador"
                                className="px-2.5 py-1 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground transition-colors"
                              >
                                Abrir
                              </button>
                              {project.pdfData ? (
                                <button
                                  onClick={() => handleDownloadExistingPDF(client, project)}
                                  title="Descargar PDF guardado"
                                  className="p-1.5 rounded-lg text-sky-500 hover:bg-sky-500/10 transition-colors"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleGeneratePDF(client, project)}
                                  disabled={generatingPDF === project.id}
                                  title="Generar PDF cotización"
                                  className="p-1.5 rounded-lg text-muted-foreground hover:text-sky-500 hover:bg-sky-500/10 transition-colors disabled:opacity-50"
                                >
                                  {generatingPDF === project.id
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    : <FileText className="w-3.5 h-3.5" />}
                                </button>
                              )}
                              <button
                                onClick={() => handleDeleteProject(project.id, client.id)}
                                title="Eliminar proyecto"
                                className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Add project quick button */}
                    <div className="px-4 py-2 border-t border-border/30">
                      <button onClick={() => createAndOpenProject(client)} className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 font-medium transition-colors">
                        <Plus className="w-3.5 h-3.5" />
                        Nuevo proyecto para {client.nombre.split(" ")[0]}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
