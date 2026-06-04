/**
 * auth.ts — Servicio de autenticación.
 *
 * Estrategia dual:
 * 1. Cookie httpOnly (cuando funciona en el entorno)
 * 2. Bearer token en localStorage como fallback confiable
 *
 * El backend acepta ambos; el middleware verifica cookie primero, luego Bearer.
 */

import { clearAllOfflineData } from './offline-storage';

const USER_KEY  = "urbanai_user_info";
const TOKEN_KEY = "urbanai_token";

/** Prefijos de claves localStorage que pertenecen a la sesión de trabajo activa */
const APP_LS_PREFIXES = ["garden_", "crm_"];

export interface AuthUser {
  id:       number;
  username: string;
  role:     "admin" | "user";
  credits:  number;
  status:   "active" | "suspended";
}

// ── Token ─────────────────────────────────────────────────────────────────────
export function getStoredToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function saveToken(token: string) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch {}
}

// ── Perfil en localStorage ────────────────────────────────────────────────────
export function getCachedUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function cacheUser(user: AuthUser) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Limpia TODA la sesión del usuario:
 * - Token JWT y perfil en localStorage
 * - Todas las claves `garden_*` y `crm_*` en localStorage
 * - Caché IndexedDB
 */
export function clearAuth() {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(TOKEN_KEY);

  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && APP_LS_PREFIXES.some(p => key.startsWith(p))) keysToRemove.push(key);
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));

  clearAllOfflineData().catch(() => {});
}

// ── authHeaders — devuelve Bearer token si está disponible ───────────────────
export function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// ── API calls ──────────────────────────────────────────────────────────────────
export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch("/api/auth/login", {
    method:      "POST",
    headers:     { "Content-Type": "application/json" },
    credentials: "include",
    body:        JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Error desconocido" }));
    throw new Error(body.error ?? "Error de autenticación");
  }

  const { token, user } = await res.json();
  if (token) saveToken(token);
  cacheUser(user);
  return user;
}

export async function logout(): Promise<void> {
  const token = getStoredToken();
  await fetch("/api/auth/logout", {
    method:      "POST",
    credentials: "include",
    headers:     token ? { Authorization: `Bearer ${token}` } : {},
  }).catch(() => {});
  clearAuth();
}

export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const token = getStoredToken();
    const res = await fetch("/api/auth/me", {
      credentials: "include",
      headers:     token ? { Authorization: `Bearer ${token}` } : {},
    });

    // 401 = sesión realmente expirada o inválida → limpiar y salir
    if (res.status === 401) {
      clearAuth();
      return null;
    }

    // Cualquier otro error (5xx, red caída, servidor frío) → usar cache local
    // NO borrar el token: el usuario sigue "logueado", solo el servidor está dormido
    if (!res.ok) {
      return getCachedUser();
    }

    const user = await res.json() as AuthUser;
    cacheUser(user);
    return user;
  } catch {
    // Error de red (cold-start, timeout) → usar cache local, NO desloguear
    return getCachedUser();
  }
}
