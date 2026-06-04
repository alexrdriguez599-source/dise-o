import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

export const JWT_SECRET = process.env.SESSION_SECRET ?? "urbanai-jwt-secret-2026";
export const COOKIE_NAME = "urbanai_token";
export const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 días

export interface AuthUser {
  id:       number;
  username: string;
  role:     "admin" | "user";
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ── Extraer usuario: cookie httpOnly → fallback Bearer header ─────────────────
export function extractUser(req: Request, _res: Response, next: NextFunction) {
  const cookieToken  = (req.cookies as Record<string, string>)?.[COOKIE_NAME];
  const bearerToken  = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;

  const token = cookieToken ?? bearerToken ?? null;

  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET) as AuthUser;
    } catch {
      // token inválido o expirado — continuar sin usuario
    }
  }
  next();
}

// ── Requerir sesión válida ────────────────────────────────────────────────────
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  next();
}

// ── Requerir rol admin ────────────────────────────────────────────────────────
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== "admin") {
    res.status(403).json({ error: "Acceso denegado — se requiere rol admin" });
    return;
  }
  next();
}

// ── Firmar JWT (7 días de expiración) ─────────────────────────────────────────
export function signToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "7d" });
}
