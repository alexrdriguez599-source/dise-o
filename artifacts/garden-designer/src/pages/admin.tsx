import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import {
  UserPlus, Trash2, Shield, User, Loader2, ArrowLeft,
  CreditCard, Ban, CheckCircle, ChevronRight, Coins,
  Receipt, Activity, RefreshCw, Lock, TrendingUp,
  Package, DollarSign, Users, Leaf, Search,
  ChevronLeft, ChevronRight as ChevRight,
} from "lucide-react";

interface UserRow {
  id:        number;
  username:  string;
  role:      "admin" | "user";
  credits:   number;
  status:    "active" | "suspended";
  createdAt: string;
}

interface UserDetail extends UserRow {
  totalSpent:         number;
  totalCreditsBought: number;
  totalCreditsUsed:   number;
}

interface PaymentRow {
  id:           number;
  amount:       string;
  creditsAdded: number;
  method:       string;
  note:         string | null;
  createdAt:    string;
}

interface UsageRow {
  id:          number;
  action:      string;
  creditsUsed: number;
  createdAt:   string;
}

interface PlatformStats {
  totalUsers:   number;
  activeUsers:  number;
  totalRevenue: number;
  totalCredits: number;
  catalogItems: number;
}

interface PagedUsers {
  data:       UserRow[];
  total:      number;
  page:       number;
  limit:      number;
  totalPages: number;
}

type AdminView = "list" | "detail";

const PAGE_SIZE = 50;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const fmtMXN = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(n);

function StatusBadge({ status }: { status: "active" | "suspended" }) {
  return status === "active"
    ? <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full"><CheckCircle className="w-3 h-3" />Activo</span>
    : <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full"><Ban className="w-3 h-3" />Suspendido</span>;
}

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white border border-border rounded-2xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-2">{icon}<span className="text-xs text-muted-foreground font-medium">{label}</span></div>
      <p className="text-2xl font-bold text-foreground leading-none">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

export default function AdminPage() {
  const { isAdmin } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [view,       setView]       = useState<AdminView>("list");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // list + pagination
  const [paged,      setPaged]      = useState<PagedUsers | null>(null);
  const [stats,      setStats]      = useState<PlatformStats | null>(null);
  const [listLoad,   setListLoad]   = useState(true);
  const [page,       setPage]       = useState(1);
  const [search,     setSearch]     = useState("");
  const [searchInput,setSearchInput]= useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [newUser,  setNewUser]  = useState({ username: "", password: "", initialCredits: "" });
  const [creating, setCreating] = useState(false);
  const [syncing,  setSyncing]  = useState(false);

  // detail
  const [detail,       setDetail]       = useState<UserDetail | null>(null);
  const [detailLoad,   setDetailLoad]   = useState(false);
  const [activeTab,    setActiveTab]    = useState<"payments" | "usage">("payments");
  const [payHistory,   setPayHistory]   = useState<PaymentRow[]>([]);
  const [usageHistory, setUsageHistory] = useState<UsageRow[]>([]);
  const [histLoad,     setHistLoad]     = useState(false);

  // credit form
  const [creditsToAdd, setCreditsToAdd] = useState("");
  const [addingCred,   setAddingCred]   = useState(false);

  // payment form
  const [payForm,   setPayForm]   = useState({ amount: "", credits_added: "", method: "efectivo", note: "" });
  const [savingPay, setSavingPay] = useState(false);

  // password form
  const [newPassword,  setNewPassword]  = useState("");
  const [changingPass, setChangingPass] = useState(false);
  const [showPassForm, setShowPassForm] = useState(false);

  useEffect(() => {
    if (!isAdmin) { navigate("/"); return; }
    loadStats();
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    loadUsers(page, search);
  }, [page, search, isAdmin]);

  // debounce search input
  function handleSearchInput(val: string) {
    setSearchInput(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearch(val);
      setPage(1);
    }, 400);
  }

  async function loadUsers(p: number, q: string) {
    setListLoad(true);
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(PAGE_SIZE) });
      if (q) params.set("search", q);
      const res = await fetch(`/api/admin/users?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error();
      setPaged(await res.json());
    } catch {
      toast({ title: "Error", description: "No se pudieron cargar los usuarios", variant: "destructive" });
    } finally {
      setListLoad(false);
    }
  }

  async function loadStats() {
    try {
      const res = await fetch("/api/admin/stats", { credentials: "include" });
      if (!res.ok) return;
      setStats(await res.json());
    } catch { /* silencioso */ }
  }

  const loadDetail = useCallback(async (id: number) => {
    setDetailLoad(true);
    try {
      const res = await fetch(`/api/admin/users/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error();
      setDetail(await res.json());
    } catch {
      toast({ title: "Error", description: "No se pudo cargar el usuario", variant: "destructive" });
    } finally {
      setDetailLoad(false);
    }
  }, [toast]);

  const loadHistory = useCallback(async (id: number, tab: "payments" | "usage") => {
    setHistLoad(true);
    try {
      const endpoint = tab === "payments" ? `/api/admin/users/${id}/payments` : `/api/admin/users/${id}/usage`;
      const res = await fetch(endpoint, { credentials: "include" });
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (tab === "payments") setPayHistory(data);
      else setUsageHistory(data);
    } catch {
      toast({ title: "Error", description: "No se pudo cargar el historial", variant: "destructive" });
    } finally {
      setHistLoad(false);
    }
  }, [toast]);

  function openDetail(id: number) {
    setSelectedId(id);
    setView("detail");
    setActiveTab("payments");
    setCreditsToAdd("");
    setPayForm({ amount: "", credits_added: "", method: "efectivo", note: "" });
    setNewPassword("");
    setShowPassForm(false);
    loadDetail(id);
    loadHistory(id, "payments");
  }

  function switchTab(tab: "payments" | "usage") {
    setActiveTab(tab);
    if (selectedId) loadHistory(selectedId, tab);
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    if (!newUser.username || !newUser.password) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newUser.username,
          password: newUser.password,
          initialCredits: newUser.initialCredits ? parseInt(newUser.initialCredits, 10) : 0,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Error");
      const catalogMsg = body.catalogCopied > 0 ? ` · ${body.catalogCopied} plantas copiadas` : "";
      toast({ title: "Usuario creado", description: `@${newUser.username} listo${catalogMsg}` });
      setNewUser({ username: "", password: "", initialCredits: "" });
      loadUsers(1, search);
      loadStats();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  async function deleteUser(id: number, username: string) {
    if (!confirm(`¿Eliminar @${username}? Esta acción no se puede deshacer.`)) return;
    try {
      const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error ?? "Error"); }
      toast({ title: "Usuario eliminado" });
      loadUsers(page, search);
      loadStats();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  async function syncCatalog() {
    setSyncing(true);
    try {
      const res = await fetch("/api/admin/sync-catalog", { method: "POST", credentials: "include" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Error");
      toast({ title: "Catálogo sincronizado", description: body.message });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }

  async function addCredits(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !creditsToAdd) return;
    setAddingCred(true);
    try {
      const res = await fetch(`/api/admin/users/${selectedId}/credits`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credits_to_add: parseInt(creditsToAdd, 10) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Error");
      toast({ title: "Créditos agregados", description: `Saldo actual: ${body.credits} créditos` });
      setCreditsToAdd("");
      loadDetail(selectedId);
      loadUsers(page, search);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setAddingCred(false);
    }
  }

  async function registerPayment(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setSavingPay(true);
    try {
      const res = await fetch(`/api/admin/users/${selectedId}/payments`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payForm),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Error");
      toast({ title: "Pago registrado", description: `Saldo actual: ${body.credits} créditos` });
      setPayForm({ amount: "", credits_added: "", method: "efectivo", note: "" });
      loadDetail(selectedId);
      loadHistory(selectedId, "payments");
      loadUsers(page, search);
      loadStats();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSavingPay(false);
    }
  }

  async function toggleStatus() {
    if (!selectedId || !detail) return;
    const action = detail.status === "suspended" ? "activar" : "suspender";
    if (!confirm(`¿${action.charAt(0).toUpperCase() + action.slice(1)} a @${detail.username}?`)) return;
    try {
      const res = await fetch(`/api/admin/users/${selectedId}/status`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Error");
      toast({ title: body.status === "suspended" ? "Usuario suspendido" : "Usuario activado" });
      loadDetail(selectedId);
      loadUsers(page, search);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !newPassword) return;
    setChangingPass(true);
    try {
      const res = await fetch(`/api/admin/users/${selectedId}/password`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Error");
      toast({ title: "Contraseña actualizada" });
      setNewPassword("");
      setShowPassForm(false);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setChangingPass(false);
    }
  }

  if (!isAdmin) return null;

  const costPerCredit = payForm.amount && payForm.credits_added && Number(payForm.credits_added) > 0
    ? (Number(payForm.amount) / Number(payForm.credits_added)).toFixed(2)
    : null;

  const nonAdmin = (paged?.data ?? []).filter(u => u.role !== "admin");

  // ── LIST VIEW ──────────────────────────────────────────────────────────────
  if (view === "list") {
    return (
      <div className="min-h-[100dvh] bg-stone-50">
        {/* Top bar */}
        <div className="bg-white border-b border-border px-4 md:px-8 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate("/")} className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors">
              <ArrowLeft className="w-4 h-4 text-muted-foreground" />
            </button>
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <div>
                <h1 className="text-base font-bold text-foreground leading-none">Panel de Administración</h1>
                <p className="text-xs text-muted-foreground mt-0.5">Atria · Diseño de Espacios</p>
              </div>
            </div>
          </div>
          <button
            onClick={syncCatalog} disabled={syncing}
            className="flex items-center gap-1.5 text-xs font-medium bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 px-3 py-2 rounded-xl transition-colors disabled:opacity-50"
          >
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Leaf className="w-3.5 h-3.5" />}
            Sincronizar catálogo
          </button>
        </div>

        <div className="max-w-5xl mx-auto p-4 md:p-8 space-y-6">

          {/* Platform stats */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatCard icon={<Users className="w-4 h-4 text-primary" />}         label="Usuarios totales"  value={stats.totalUsers.toLocaleString("es-MX")} sub={`${stats.activeUsers} activos`} />
              <StatCard icon={<Ban className="w-4 h-4 text-red-500" />}           label="Suspendidos"       value={stats.totalUsers - stats.activeUsers} />
              <StatCard icon={<DollarSign className="w-4 h-4 text-emerald-600" />} label="Ingresos totales"  value={fmtMXN(stats.totalRevenue)} />
              <StatCard icon={<Coins className="w-4 h-4 text-amber-600" />}       label="Créditos vendidos" value={stats.totalCredits.toLocaleString("es-MX")} />
              <StatCard icon={<Package className="w-4 h-4 text-violet-600" />}    label="Items catálogo"    value={stats.catalogItems} sub="globales" />
            </div>
          )}

          {/* Create user */}
          <div className="bg-white border border-border rounded-2xl shadow-sm p-6">
            <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-primary" />Nuevo usuario
            </h2>
            <form onSubmit={createUser} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <Input placeholder="Nombre de usuario" value={newUser.username}
                onChange={e => setNewUser(u => ({ ...u, username: e.target.value }))}
                className="rounded-xl h-10" required />
              <Input type="password" placeholder="Contraseña" value={newUser.password}
                onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))}
                className="rounded-xl h-10" required />
              <Input type="number" min="0" placeholder="Créditos iniciales" value={newUser.initialCredits}
                onChange={e => setNewUser(u => ({ ...u, initialCredits: e.target.value }))}
                className="rounded-xl h-10" />
              <Button type="submit" disabled={creating || !newUser.username || !newUser.password} className="h-10 rounded-xl">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Crear usuario"}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground mt-2">Al crear un usuario, recibe automáticamente el catálogo de plantas con sus propios precios editables.</p>
          </div>

          {/* Users table */}
          <div className="bg-white border border-border rounded-2xl shadow-sm overflow-hidden">
            {/* Table header + search */}
            <div className="px-6 py-4 border-b border-border flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-center gap-2 flex-1">
                <User className="w-4 h-4 text-primary" />
                <h2 className="text-sm font-semibold">Usuarios registrados</h2>
                {paged && (
                  <span className="text-xs text-muted-foreground">
                    — {paged.total.toLocaleString("es-MX")} en total
                  </span>
                )}
              </div>
              <div className="relative w-full sm:w-56">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Buscar usuario…"
                  value={searchInput}
                  onChange={e => handleSearchInput(e.target.value)}
                  className="w-full h-9 pl-9 pr-3 text-sm rounded-xl border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <button onClick={() => loadUsers(page, search)} className="p-2 rounded-lg hover:bg-stone-100 text-muted-foreground transition-colors" title="Actualizar">
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {listLoad ? (
              <div className="flex items-center justify-center py-14">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : nonAdmin.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">
                {search ? `Sin resultados para "${search}"` : "Sin usuarios registrados"}
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-stone-50">
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground">Usuario</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Fecha alta</th>
                        <th className="text-center px-4 py-3 text-xs font-medium text-muted-foreground">Créditos</th>
                        <th className="text-center px-4 py-3 text-xs font-medium text-muted-foreground">Estado</th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-muted-foreground">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {nonAdmin.map(u => (
                        <tr key={u.id} className="hover:bg-stone-50 transition-colors">
                          <td className="px-6 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                <User className="w-3.5 h-3.5 text-primary" />
                              </div>
                              <span className="font-medium">@{u.username}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(u.createdAt)}</td>
                          <td className="px-4 py-3 text-center">
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                              <Coins className="w-3 h-3" />{u.credits}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center"><StatusBadge status={u.status} /></td>
                          <td className="px-6 py-3">
                            <div className="flex items-center justify-end gap-2">
                              <button onClick={() => openDetail(u.id)}
                                className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors">
                                Gestionar <ChevronRight className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => deleteUser(u.id, u.username)}
                                className="p-1.5 text-muted-foreground hover:text-destructive transition-colors rounded-lg hover:bg-red-50">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {paged && paged.totalPages > 1 && (
                  <div className="px-6 py-4 border-t border-border flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      Página {paged.page} de {paged.totalPages} · {paged.total.toLocaleString("es-MX")} usuarios
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page <= 1}
                        className="p-1.5 rounded-lg border border-border hover:bg-stone-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      {Array.from({ length: Math.min(5, paged.totalPages) }, (_, i) => {
                        const start = Math.max(1, Math.min(page - 2, paged.totalPages - 4));
                        const p = start + i;
                        return (
                          <button key={p} onClick={() => setPage(p)}
                            className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${p === page ? "bg-primary text-primary-foreground" : "border border-border hover:bg-stone-100 text-muted-foreground"}`}>
                            {p}
                          </button>
                        );
                      })}
                      <button
                        onClick={() => setPage(p => Math.min(paged.totalPages, p + 1))}
                        disabled={page >= paged.totalPages}
                        className="p-1.5 rounded-lg border border-border hover:bg-stone-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── DETAIL VIEW ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-[100dvh] bg-stone-50">
      <div className="bg-white border-b border-border px-4 md:px-8 py-4 flex items-center gap-4">
        <button onClick={() => setView("list")} className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors">
          <ArrowLeft className="w-4 h-4 text-muted-foreground" />
        </button>
        <div>
          <h1 className="text-base font-bold text-foreground leading-none">
            {detailLoad ? "Cargando…" : `@${detail?.username}`}
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">Gestión de usuario</p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-4 md:p-8 space-y-5">
        {detailLoad || !detail ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Info card */}
            <div className="bg-white border border-border rounded-2xl shadow-sm p-6">
              <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0">
                  <User className="w-7 h-7 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-xl font-bold text-foreground">@{detail.username}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Alta el {fmtDate(detail.createdAt)}</p>
                  <div className="grid grid-cols-3 gap-3 mt-4">
                    <div className="text-center bg-amber-50 border border-amber-100 rounded-xl p-3">
                      <p className="text-lg font-bold text-amber-700">{detail.credits}</p>
                      <p className="text-xs text-amber-600">Créditos actuales</p>
                    </div>
                    <div className="text-center bg-emerald-50 border border-emerald-100 rounded-xl p-3">
                      <p className="text-lg font-bold text-emerald-700">{fmtMXN(detail.totalSpent)}</p>
                      <p className="text-xs text-emerald-600">Total pagado</p>
                    </div>
                    <div className="text-center bg-blue-50 border border-blue-100 rounded-xl p-3">
                      <p className="text-lg font-bold text-blue-700">{detail.totalCreditsUsed}</p>
                      <p className="text-xs text-blue-600">Créditos usados</p>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <StatusBadge status={detail.status} />
                  <button onClick={toggleStatus}
                    className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl border transition-colors ${
                      detail.status === "suspended"
                        ? "border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                        : "border-red-300 text-red-700 bg-red-50 hover:bg-red-100"
                    }`}>
                    {detail.status === "suspended"
                      ? <><CheckCircle className="w-3.5 h-3.5" />Activar</>
                      : <><Ban className="w-3.5 h-3.5" />Suspender</>}
                  </button>
                  <button onClick={() => setShowPassForm(v => !v)}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl border border-stone-300 text-stone-700 bg-stone-50 hover:bg-stone-100 transition-colors">
                    <Lock className="w-3.5 h-3.5" />Cambiar clave
                  </button>
                </div>
              </div>

              {showPassForm && (
                <form onSubmit={changePassword} className="mt-4 pt-4 border-t border-border flex gap-3">
                  <Input type="password" placeholder="Nueva contraseña (mín. 4 caracteres)"
                    value={newPassword} onChange={e => setNewPassword(e.target.value)}
                    className="rounded-xl h-9 flex-1" minLength={4} required />
                  <Button type="submit" disabled={changingPass || newPassword.length < 4} size="sm" className="rounded-xl px-4 h-9">
                    {changingPass ? <Loader2 className="w-4 h-4 animate-spin" /> : "Guardar"}
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="rounded-xl h-9"
                    onClick={() => { setShowPassForm(false); setNewPassword(""); }}>
                    Cancelar
                  </Button>
                </form>
              )}
            </div>

            {/* Credits & Payment */}
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-white border border-border rounded-2xl shadow-sm p-6">
                <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                  <Coins className="w-4 h-4 text-amber-600" />Agregar créditos
                </h3>
                <form onSubmit={addCredits} className="flex gap-3">
                  <Input type="number" min="1" placeholder="Cantidad de créditos"
                    value={creditsToAdd} onChange={e => setCreditsToAdd(e.target.value)}
                    className="rounded-xl h-10" required />
                  <Button type="submit" disabled={addingCred || !creditsToAdd} className="h-10 rounded-xl px-5 shrink-0">
                    {addingCred ? <Loader2 className="w-4 h-4 animate-spin" /> : "Agregar"}
                  </Button>
                </form>
              </div>

              <div className="bg-white border border-border rounded-2xl shadow-sm p-6">
                <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                  <CreditCard className="w-4 h-4 text-primary" />Registrar pago + créditos
                </h3>
                <form onSubmit={registerPayment} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Monto (MXN)</label>
                      <Input type="number" min="1" placeholder="500"
                        value={payForm.amount} onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
                        className="rounded-xl h-9" required />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Créditos a dar</label>
                      <Input type="number" min="1" placeholder="10"
                        value={payForm.credits_added} onChange={e => setPayForm(f => ({ ...f, credits_added: e.target.value }))}
                        className="rounded-xl h-9" required />
                    </div>
                  </div>
                  {costPerCredit && (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5">
                      <TrendingUp className="w-3.5 h-3.5" />
                      <span><strong>${costPerCredit} MXN</strong> por crédito</span>
                    </div>
                  )}
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Método de pago</label>
                    <select value={payForm.method} onChange={e => setPayForm(f => ({ ...f, method: e.target.value }))}
                      className="w-full h-9 rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                      <option value="efectivo">Efectivo</option>
                      <option value="transferencia">Transferencia</option>
                      <option value="tarjeta">Tarjeta</option>
                      <option value="otro">Otro</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Nota / referencia</label>
                    <Input placeholder="Número de comprobante, concepto…"
                      value={payForm.note} onChange={e => setPayForm(f => ({ ...f, note: e.target.value }))}
                      className="rounded-xl h-9" />
                  </div>
                  <Button type="submit" disabled={savingPay || !payForm.amount || !payForm.credits_added} className="w-full h-10 rounded-xl">
                    {savingPay ? <Loader2 className="w-4 h-4 animate-spin" /> : "Guardar pago y créditos"}
                  </Button>
                </form>
              </div>
            </div>

            {/* History tabs */}
            <div className="bg-white border border-border rounded-2xl shadow-sm overflow-hidden">
              <div className="flex border-b border-border">
                {([
                  { key: "payments", label: "Historial de pagos", icon: <Receipt className="w-3.5 h-3.5" /> },
                  { key: "usage",    label: "Uso de créditos",   icon: <Activity className="w-3.5 h-3.5" /> },
                ] as const).map(tab => (
                  <button key={tab.key} onClick={() => switchTab(tab.key)}
                    className={`flex items-center gap-1.5 px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
                      activeTab === tab.key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}>
                    {tab.icon}{tab.label}
                  </button>
                ))}
                <button onClick={() => selectedId && loadHistory(selectedId, activeTab)}
                  className="ml-auto mr-4 my-auto p-1.5 rounded-lg hover:bg-stone-100 text-muted-foreground transition-colors">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>

              {histLoad ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : activeTab === "payments" ? (
                payHistory.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-10">Sin pagos registrados</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-stone-50">
                          <th className="text-left px-6 py-2 text-xs font-medium text-muted-foreground">Fecha</th>
                          <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground">Monto</th>
                          <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground">Créditos</th>
                          <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground">$/créd.</th>
                          <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Método</th>
                          <th className="text-left px-6 py-2 text-xs font-medium text-muted-foreground">Nota</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {payHistory.map(p => {
                          const cp = Number(p.creditsAdded) > 0 ? (Number(p.amount) / Number(p.creditsAdded)).toFixed(0) : "—";
                          return (
                            <tr key={p.id} className="hover:bg-stone-50">
                              <td className="px-6 py-2.5 text-xs text-muted-foreground">{fmtDateTime(p.createdAt)}</td>
                              <td className="px-4 py-2.5 text-right font-medium text-emerald-700">{fmtMXN(Number(p.amount))}</td>
                              <td className="px-4 py-2.5 text-right">
                                <span className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">+{p.creditsAdded}</span>
                              </td>
                              <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">${cp}</td>
                              <td className="px-4 py-2.5 text-xs capitalize">{p.method}</td>
                              <td className="px-6 py-2.5 text-xs text-muted-foreground truncate max-w-[140px]">{p.note ?? "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              ) : (
                usageHistory.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-10">Sin actividad registrada</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-stone-50">
                          <th className="text-left px-6 py-2 text-xs font-medium text-muted-foreground">Fecha</th>
                          <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Acción</th>
                          <th className="text-right px-6 py-2 text-xs font-medium text-muted-foreground">Créditos</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {usageHistory.map(u => (
                          <tr key={u.id} className="hover:bg-stone-50">
                            <td className="px-6 py-2.5 text-xs text-muted-foreground">{fmtDateTime(u.createdAt)}</td>
                            <td className="px-4 py-2.5 text-xs">{u.action}</td>
                            <td className="px-6 py-2.5 text-right">
                              <span className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full">-{u.creditsUsed}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
