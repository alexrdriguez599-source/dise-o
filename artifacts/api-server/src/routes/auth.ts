import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, signToken, COOKIE_NAME, COOKIE_MAX_AGE } from "../middlewares/auth";

const router = Router();

const IS_PROD = process.env.NODE_ENV === "production";

function setAuthCookie(res: import("express").Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: "lax",
    maxAge:   COOKIE_MAX_AGE,
    path:     "/",
  });
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const { username, password } = req.body ?? {};

  if (!username || !password) {
    res.status(400).json({ error: "Usuario y contraseña requeridos" });
    return;
  }

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, String(username)));

    if (!user || user.isDeleted) {
      res.status(401).json({ error: "Credenciales incorrectas" });
      return;
    }

    if (user.status === "suspended") {
      res.status(403).json({ error: "Cuenta suspendida. Contacta al administrador." });
      return;
    }

    const valid = await bcrypt.compare(String(password), user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Credenciales incorrectas" });
      return;
    }

    const payload = {
      id:       user.id,
      username: user.username,
      role:     user.role as "admin" | "user",
    };

    const token = signToken(payload);
    setAuthCookie(res, token);

    res.json({
      token,
      user: {
        ...payload,
        credits: user.credits,
        status:  user.status,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Error en login");
    res.status(500).json({ error: "Error interno" });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// ── GET /api/auth/me ── retorna datos frescos desde DB ────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  try {
    const [user] = await db
      .select({ id: users.id, username: users.username, role: users.role, credits: users.credits, status: users.status })
      .from(users)
      .where(eq(users.id, req.user!.id));

    if (!user) {
      res.status(401).json({ error: "Sesión inválida" });
      return;
    }

    res.json(user);
  } catch (err) {
    req.log.error({ err }, "Error en /me");
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
