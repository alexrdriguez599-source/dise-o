/**
 * admin-panel.tsx
 * Módulo INDEPENDIENTE de administración accesible desde la pantalla de login.
 * Usa cookies httpOnly — no maneja tokens directamente.
 */

import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Shield, X, UserPlus, Trash2, Loader2,
  User, Lock, Eye, EyeOff,
} from "lucide-react";

type Screen = "login" | "panel";

interface UserRow {
  id:        number;
  username:  string;
  role:      string;
  createdAt: string;
}

interface AdminPanelProps {
  onClose:       () => void;
  onAdminLogin?: () => void; // notificar al contexto padre que el admin inició sesión
}

// ── Helpers de fetch con credenciales (cookies) ───────────────────────────────
const apiFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, credentials: "include" });

// ── Componente principal ──────────────────────────────────────────────────────
export default function AdminPanel({ onClose, onAdminLogin }: AdminPanelProps) {
  const [screen, setScreen] = useState<Screen>("login");

  const handleAdminLogin = useCallback(async (inputUser: string, inputPass: string) => {
    // Login en el backend — el servidor valida credenciales y rol
    const res = await apiFetch("/api/auth/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ username: inputUser, password: inputPass }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Acceso denegado");
    }
    // Verificar que el usuario autenticado es admin
    const meRes = await apiFetch("/api/auth/me");
    const me = await meRes.json().catch(() => ({}));
    if (me?.role !== "admin") {
      // No es admin — cerrar sesión inmediatamente
      await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
      throw new Error("Acceso denegado — se requiere rol de administrador");
    }
    setScreen("panel");
    onAdminLogin?.();
  }, [onAdminLogin]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="w-full max-w-md">
        {screen === "login" ? (
          <AdminLoginScreen onLogin={handleAdminLogin} onClose={onClose} />
        ) : (
          <AdminManageScreen onClose={onClose} />
        )}
      </div>
    </div>
  );
}

// ── Pantalla de login admin ───────────────────────────────────────────────────
function AdminLoginScreen({
  onLogin,
  onClose,
}: {
  onLogin: (u: string, p: string) => Promise<void>;
  onClose: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd,  setShowPwd]  = useState(false);
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onLogin(username, password);
    } catch (err: any) {
      setError(err?.message ?? "Acceso denegado");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-2xl border border-border overflow-hidden">
      <div className="bg-stone-900 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <div>
            <p className="text-white font-semibold text-sm">Administrador</p>
            <p className="text-white/50 text-xs">Acceso restringido</p>
          </div>
        </div>
        <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="p-6 space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Usuario administrador
          </label>
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Usuario"
              autoComplete="off"
              autoFocus
              className="h-11 rounded-xl pl-9"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Contraseña
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              type={showPwd ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Contraseña"
              autoComplete="off"
              className="h-11 rounded-xl pl-9 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPwd(!showPwd)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-center font-medium">
            {error}
          </div>
        )}

        <Button
          type="submit"
          disabled={!username || !password || loading}
          className="w-full h-11 rounded-xl bg-stone-900 hover:bg-stone-800 text-white font-semibold gap-2"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
          {loading ? "Verificando..." : "Acceder al panel"}
        </Button>
      </form>
    </div>
  );
}

// ── Diálogo de confirmación estilizado ────────────────────────────────────────
function ConfirmDialog({
  username,
  onConfirm,
  onCancel,
  loading,
}: {
  username: string;
  onConfirm: () => void;
  onCancel:  () => void;
  loading:   boolean;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-border w-full max-w-sm p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
            <Trash2 className="w-5 h-5 text-red-600" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground text-sm">
              ¿Eliminar usuario?
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Estás a punto de eliminar la cuenta{" "}
              <span className="font-medium text-foreground">@{username}</span>.
              <br />
              El usuario no podrá iniciar sesión.
            </p>
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <Button
            variant="outline"
            className="flex-1 h-10 rounded-xl"
            onClick={onCancel}
            disabled={loading}
          >
            Cancelar
          </Button>
          <Button
            className="flex-1 h-10 rounded-xl bg-red-600 hover:bg-red-700 text-white font-semibold gap-1.5"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            {loading ? "Eliminando..." : "Sí, eliminar"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Pantalla de gestión de usuarios ──────────────────────────────────────────
function AdminManageScreen({ onClose }: { onClose: () => void }) {
  const [users,    setUsers]    = useState<UserRow[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [newUser,  setNewUser]  = useState({ username: "", password: "" });
  const [showPwd,  setShowPwd]  = useState(false);
  const [creating, setCreating] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  // Estado del diálogo de confirmación
  const [confirmTarget, setConfirmTarget] = useState<{ id: number; username: string } | null>(null);
  const [deleting,      setDeleting]      = useState(false);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/admin/users");
      if (res.ok) {
        const body = await res.json();
        setUsers(Array.isArray(body) ? body : (body.data ?? body.users ?? []));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const showFeedback = (type: "ok" | "err", msg: string) => {
    setFeedback({ type, msg });
    setTimeout(() => setFeedback(null), 3500);
  };

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUser.username.trim() || !newUser.password.trim()) return;
    setCreating(true);
    try {
      const res = await apiFetch("/api/admin/users", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ username: newUser.username.trim(), password: newUser.password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Error al crear usuario");
      showFeedback("ok", `Usuario @${newUser.username} creado correctamente`);
      setNewUser({ username: "", password: "" });
      loadUsers();
    } catch (err: any) {
      showFeedback("err", err.message);
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = (id: number, username: string) => {
    setConfirmTarget({ id, username });
  };

  const executeDelete = async () => {
    if (!confirmTarget) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/admin/users/${confirmTarget.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Error al eliminar");
      showFeedback("ok", `Usuario @${confirmTarget.username} eliminado`);
      setConfirmTarget(null);
      loadUsers();
    } catch (err: any) {
      showFeedback("err", err.message);
      setConfirmTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const regularUsers = users.filter(u => u.role !== "admin");

  return (
    <div className="bg-white rounded-2xl shadow-2xl border border-border overflow-hidden max-h-[85vh] flex flex-col">
      <div className="bg-stone-900 px-6 py-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <div>
            <p className="text-white font-semibold text-sm">Panel de Administración</p>
            <p className="text-white/50 text-xs">Gestión de usuarios Atria</p>
          </div>
        </div>
        <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="overflow-y-auto flex-1 p-6 space-y-5">
        {feedback && (
          <div className={`rounded-xl px-4 py-3 text-sm font-medium text-center border ${
            feedback.type === "ok"
              ? "bg-green-50 border-green-200 text-green-700"
              : "bg-red-50 border-red-200 text-red-600"
          }`}>
            {feedback.msg}
          </div>
        )}

        {/* Crear usuario */}
        <div className="border border-border rounded-xl p-4 space-y-3">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-primary" />
            Crear nuevo usuario
          </h2>
          <form onSubmit={createUser} className="space-y-3">
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Nombre de usuario"
                value={newUser.username}
                onChange={(e) => setNewUser(u => ({ ...u, username: e.target.value }))}
                className="h-10 rounded-lg pl-9"
                autoComplete="off"
                required
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                type={showPwd ? "text" : "password"}
                placeholder="Contraseña"
                value={newUser.password}
                onChange={(e) => setNewUser(u => ({ ...u, password: e.target.value }))}
                className="h-10 rounded-lg pl-9 pr-10"
                autoComplete="new-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPwd(!showPwd)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <Button
              type="submit"
              disabled={creating || !newUser.username.trim() || !newUser.password.trim()}
              className="w-full h-10 rounded-lg font-semibold gap-2"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              {creating ? "Creando..." : "CREAR USUARIO"}
            </Button>
          </form>
        </div>

        {/* Lista de usuarios */}
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-stone-50 border-b border-border flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">Usuarios registrados</span>
            {!loading && (
              <span className="text-xs text-muted-foreground">
                {regularUsers.length} usuario{regularUsers.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : regularUsers.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No hay usuarios creados aún
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {regularUsers.map((u) => (
                <li key={u.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-7 h-7 rounded-full bg-stone-100 flex items-center justify-center shrink-0">
                    <User className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">@{u.username}</p>
                    <p className="text-xs text-muted-foreground">
                      Creado {new Date(u.createdAt).toLocaleDateString("es-MX")}
                    </p>
                  </div>
                  <button
                    onClick={() => confirmDelete(u.id, u.username)}
                    className="text-muted-foreground hover:text-red-500 transition-colors p-1.5 rounded-lg hover:bg-red-50 group"
                    title={`Eliminar @${u.username}`}
                  >
                    <Trash2 className="w-4 h-4 group-hover:scale-110 transition-transform" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs text-muted-foreground text-center leading-relaxed">
          Cada usuario tiene su propio inventario y proyectos separados.<br />
          Las contraseñas se guardan cifradas con bcrypt.
        </p>
      </div>

      {/* Diálogo de confirmación de eliminación */}
      {confirmTarget && (
        <ConfirmDialog
          username={confirmTarget.username}
          onConfirm={executeDelete}
          onCancel={() => setConfirmTarget(null)}
          loading={deleting}
        />
      )}
    </div>
  );
}
