import React, { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useAppContext } from "@/context/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Leaf, Plus, Users, FolderOpen, ChevronRight, Search,
  Clock, DollarSign, Loader2, X, Pencil,
} from "lucide-react";
import {
  getAllClients, getProjectsByClient, saveClient, saveProject,
  type CRMClient, type CRMProject,
} from "@/services/crm-db";
import { nanoid } from "nanoid";

interface ClientWithProjects extends CRMClient {
  projects: CRMProject[];
}

export default function ClientFormPage() {
  const { setClientInfo, clientInfo } = useAppContext();
  const [, setLocation] = useLocation();

  const [clients, setClients]       = useState<ClientWithProjects[]>([]);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState("");
  const [mode, setMode]             = useState<"list" | "new-client" | "client-detail">("list");
  const [selected, setSelected]     = useState<ClientWithProjects | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [saving, setSaving]         = useState(false);

  // New client form
  const [nombre, setNombre]     = useState("");
  const [telefono, setTelefono] = useState("");
  const [email, setEmail]       = useState("");
  const [direccion, setDireccion] = useState("");
  const [notas, setNotas]       = useState("");

  // New project form
  const [proyNombre, setProyNombre] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const all = await getAllClients();
      const withProjs = await Promise.all(
        all.map(async (c) => ({
          ...c,
          projects: await getProjectsByClient(c.id),
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
    (c) =>
      c.nombre.toLowerCase().includes(search.toLowerCase()) ||
      c.telefono.includes(search) ||
      c.email.toLowerCase().includes(search.toLowerCase()),
  );

  // ── Create new client ──────────────────────────────────────────────────────
  const handleCreateClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nombre.trim() || !telefono.trim()) return;
    setSaving(true);
    const now = new Date().toISOString();
    const client: CRMClient = {
      id: nanoid(),
      nombre: nombre.trim(),
      telefono: telefono.trim(),
      email: email.trim(),
      direccion: direccion.trim(),
      notas: notas.trim(),
      createdAt: now,
      updatedAt: now,
    };
    await saveClient(client);
    setSaving(false);
    await reload();
    // Auto-select to start project
    const withProjs: ClientWithProjects = { ...client, projects: [] };
    setSelected(withProjs);
    setMode("client-detail");
    setShowNewProject(true);
    setNombre(""); setTelefono(""); setEmail(""); setDireccion(""); setNotas("");
  };

  // ── Load existing project into design ─────────────────────────────────────
  const openProject = (client: ClientWithProjects, project: CRMProject) => {
    setClientInfo({
      name: client.nombre,
      phone: client.telefono,
      address: client.direccion,
    });
    // Store active CRM IDs for saving
    localStorage.setItem("crm_activeClientId", client.id);
    localStorage.setItem("crm_activeProjectId", project.id);
    setLocation("/design");
  };

  // ── Create new project ────────────────────────────────────────────────────
  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !proyNombre.trim()) return;
    setSaving(true);
    const now = new Date().toISOString();
    const project: CRMProject = {
      id: nanoid(),
      clienteId: selected.id,
      nombre: proyNombre.trim(),
      fecha: now,
      totalCotizacion: 0,
      createdAt: now,
      updatedAt: now,
    };
    await saveProject(project);
    setClientInfo({
      name: selected.nombre,
      phone: selected.telefono,
      address: selected.direccion,
    });
    localStorage.setItem("crm_activeClientId", selected.id);
    localStorage.setItem("crm_activeProjectId", project.id);
    setSaving(false);
    setLocation("/design");
  };

  // ── Quick-continue: si ya hay sesión activa, volver directo al diseño ────────
  useEffect(() => {
    if (clientInfo) setLocation("/design");
  }, [clientInfo, setLocation]);

  if (clientInfo) return null;

  // ──────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">

      {/* Header */}
      <header className="shrink-0 border-b border-border bg-card/80 backdrop-blur px-4 md:px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shadow-md">
            <Leaf className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <p className="font-bold text-sm text-foreground leading-tight">Atria</p>
            <p className="text-[10px] text-muted-foreground">Diseño de Espacios</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation("/clientes")}
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Users className="w-3.5 h-3.5" />
          CRM Completo
        </Button>
      </header>

      {/* ── LIST MODE ─────────────────────────────────────────────────────── */}
      {mode === "list" && (
        <div className="flex-1 max-w-2xl w-full mx-auto px-4 py-6 flex flex-col gap-4">

          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-foreground">Clientes</h1>
              <p className="text-sm text-muted-foreground">Selecciona un cliente o crea uno nuevo</p>
            </div>
            <Button onClick={() => setMode("new-client")} className="rounded-xl gap-1.5 shadow-sm">
              <Plus className="w-4 h-4" />
              Nuevo
            </Button>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar cliente por nombre, teléfono o email…"
              className="pl-9 rounded-xl"
            />
          </div>

          {loading ? (
            <div className="flex-1 flex items-center justify-center py-16">
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-16 gap-4 text-center">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Users className="w-8 h-8 text-primary" />
              </div>
              <div>
                <p className="font-semibold text-foreground">
                  {search ? "Sin resultados" : "Sin clientes aún"}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {search ? "Intenta con otra búsqueda" : "Crea tu primer cliente para empezar"}
                </p>
              </div>
              {!search && (
                <Button onClick={() => setMode("new-client")} className="rounded-xl gap-2">
                  <Plus className="w-4 h-4" />
                  Crear primer cliente
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map(client => (
                <button
                  key={client.id}
                  onClick={() => { setSelected(client); setMode("client-detail"); }}
                  className="w-full text-left bg-card border border-border rounded-2xl p-4 hover:border-primary/40 hover:bg-primary/5 transition-all group"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground truncate">{client.nombre}</p>
                      <p className="text-sm text-muted-foreground truncate">{client.telefono} {client.email ? `· ${client.email}` : ""}</p>
                      <p className="text-xs text-muted-foreground/70 truncate mt-0.5">{client.direccion}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">
                        {client.projects.length} proyecto{client.projects.length !== 1 ? "s" : ""}
                      </span>
                      <ChevronRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-primary transition-colors" />
                    </div>
                  </div>
                  {client.projects.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border/50 flex items-center gap-1.5">
                      <Clock className="w-3 h-3 text-muted-foreground/50" />
                      <span className="text-[11px] text-muted-foreground/70">
                        Último: {client.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.nombre}
                      </span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── NEW CLIENT FORM ──────────────────────────────────────────────── */}
      {mode === "new-client" && (
        <div className="flex-1 max-w-lg w-full mx-auto px-4 py-6">
          <div className="flex items-center gap-3 mb-6">
            <button onClick={() => setMode("list")} className="text-muted-foreground hover:text-foreground p-1 rounded-lg hover:bg-muted transition-colors">
              <X className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-lg font-bold text-foreground">Nuevo Cliente</h1>
              <p className="text-sm text-muted-foreground">Ingresa los datos del cliente</p>
            </div>
          </div>
          <form onSubmit={handleCreateClient} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-sm font-medium">Nombre completo *</Label>
                <Input value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Ej. María García" className="rounded-xl" required />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Teléfono *</Label>
                <Input value={telefono} onChange={e => setTelefono(e.target.value)} placeholder="555 123 4567" type="tel" className="rounded-xl" required />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Email</Label>
                <Input value={email} onChange={e => setEmail(e.target.value)} placeholder="correo@ejemplo.com" type="email" className="rounded-xl" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-sm font-medium">Dirección del proyecto *</Label>
                <Input value={direccion} onChange={e => setDireccion(e.target.value)} placeholder="Av. Principal 123, Col. Centro" className="rounded-xl" required />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-sm font-medium">Notas</Label>
                <textarea
                  value={notas}
                  onChange={e => setNotas(e.target.value)}
                  placeholder="Observaciones, referencias, preferencias del cliente…"
                  rows={3}
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                />
              </div>
            </div>
            <Button type="submit" disabled={saving || !nombre.trim() || !telefono.trim() || !direccion.trim()} className="w-full h-12 rounded-xl text-base gap-2">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Crear cliente y continuar
            </Button>
          </form>
        </div>
      )}

      {/* ── CLIENT DETAIL — project selector ─────────────────────────────── */}
      {mode === "client-detail" && selected && (
        <div className="flex-1 max-w-2xl w-full mx-auto px-4 py-6 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <button onClick={() => { setMode("list"); setSelected(null); setShowNewProject(false); }} className="text-muted-foreground hover:text-foreground p-1 rounded-lg hover:bg-muted transition-colors">
              <X className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-foreground truncate">{selected.nombre}</h1>
              <p className="text-sm text-muted-foreground">{selected.telefono} {selected.email ? `· ${selected.email}` : ""}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setShowNewProject(true); setProyNombre(""); }}
              className="ml-auto rounded-xl shrink-0 gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Nuevo proyecto
            </Button>
          </div>

          {/* New project form */}
          {showNewProject && (
            <div className="bg-primary/5 border border-primary/20 rounded-2xl p-4">
              <p className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-primary" />
                Nombre del nuevo proyecto
              </p>
              <form onSubmit={handleCreateProject} className="flex gap-2">
                <Input
                  autoFocus
                  value={proyNombre}
                  onChange={e => setProyNombre(e.target.value)}
                  placeholder="Ej. Jardín trasero, Terrazas planta alta…"
                  className="rounded-xl flex-1"
                />
                <Button type="submit" disabled={saving || !proyNombre.trim()} className="rounded-xl shrink-0 gap-1.5">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Leaf className="w-4 h-4" />}
                  Diseñar
                </Button>
              </form>
            </div>
          )}

          {/* Existing projects */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">
              Proyectos ({selected.projects.length})
            </p>
            {selected.projects.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">Sin proyectos aún</p>
                <p className="text-xs mt-1">Crea el primer proyecto para este cliente</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {[...selected.projects]
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                  .map(project => (
                    <button
                      key={project.id}
                      onClick={() => openProject(selected, project)}
                      className="w-full text-left bg-card border border-border rounded-2xl p-4 hover:border-primary/40 hover:bg-primary/5 transition-all group"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground truncate flex items-center gap-2">
                            <FolderOpen className="w-4 h-4 text-primary shrink-0" />
                            {project.nombre}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {new Date(project.fecha).toLocaleDateString("es-MX", { day: "2-digit", month: "long", year: "numeric" })}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {project.totalCotizacion > 0 && (
                            <span className="text-sm font-bold text-emerald-600 flex items-center gap-1">
                              <DollarSign className="w-3.5 h-3.5" />
                              ${project.totalCotizacion.toLocaleString()}
                            </span>
                          )}
                          <ChevronRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-primary transition-colors" />
                        </div>
                      </div>
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
