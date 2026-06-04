import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { users, payments, usageLogs, inventoryItems } from "@workspace/db/schema";
import { eq, and, desc, isNull, ne, sql } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { invalidateInventoryCache } from "./inventory";

const router = Router();

router.use(requireAuth, requireAdmin);

// ── helpers ───────────────────────────────────────────────────────────────────
async function copyCatalogToUser(userId: number) {
  const catalog = await db.select().from(inventoryItems).where(isNull(inventoryItems.userId));
  if (catalog.length === 0) return 0;

  const existing = await db
    .select({ name: inventoryItems.name })
    .from(inventoryItems)
    .where(eq(inventoryItems.userId, userId));
  const existingNames = new Set(existing.map(e => e.name.toLowerCase().trim()));

  const toInsert = catalog.filter(c => !existingNames.has(c.name.toLowerCase().trim()));
  if (toInsert.length === 0) return 0;

  await db.insert(inventoryItems).values(
    toInsert.map(c => ({
      userId,
      name:      c.name,
      category:  c.category,
      quantity:  c.quantity ?? "0",
      unit:      c.unit,
      status:    c.status,
      notes:     c.notes ?? null,
      price:     c.price ?? "0",
      imageData: c.imageData ?? null,
      itemType:  c.itemType ?? null,
      size:      c.size ?? null,
      spacing:   c.spacing ?? null,
    }))
  );
  return toInsert.length;
}

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const [usersCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.isDeleted, false), ne(users.role, "admin")));

    const [activeCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.isDeleted, false), ne(users.role, "admin"), eq(users.status, "active")));

    const [revenueRow] = await db
      .select({ total: sql<string>`coalesce(sum(amount), 0)` })
      .from(payments);

    const [creditsRow] = await db
      .select({ total: sql<number>`coalesce(sum(credits_added), 0)` })
      .from(payments);

    const [catalogCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(inventoryItems)
      .where(isNull(inventoryItems.userId));

    res.json({
      totalUsers:    Number(usersCount.count),
      activeUsers:   Number(activeCount.count),
      totalRevenue:  Number(revenueRow.total),
      totalCredits:  Number(creditsRow.total),
      catalogItems:  Number(catalogCount.count),
    });
  } catch (err) {
    req.log.error({ err }, "Error obteniendo stats");
    res.status(500).json({ error: "Error interno" });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get("/users", async (req, res) => {
  const page   = Math.max(1, parseInt(String(req.query.page  ?? "1"),  10) || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const search = String(req.query.search ?? "").trim();
  const offset = (page - 1) * limit;

  try {
    const baseWhere = search
      ? and(eq(users.isDeleted, false), sql`${users.username} ILIKE ${"%" + search + "%"}`)
      : eq(users.isDeleted, false);

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(baseWhere);

    const rows = await db
      .select({
        id:        users.id,
        username:  users.username,
        role:      users.role,
        credits:   users.credits,
        status:    users.status,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(baseWhere)
      .orderBy(users.createdAt)
      .limit(limit)
      .offset(offset);

    res.json({
      data:       rows.map(u => ({ ...u, createdAt: u.createdAt?.toISOString() ?? null })),
      total:      Number(countRow.count),
      page,
      limit,
      totalPages: Math.ceil(Number(countRow.count) / limit),
    });
  } catch (err) {
    req.log.error({ err }, "Error listando usuarios");
    res.status(500).json({ error: "Error interno" });
  }
});

// ── GET /api/admin/users/:id ──────────────────────────────────────────────────
router.get("/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  try {
    const [user] = await db
      .select({ id: users.id, username: users.username, role: users.role, credits: users.credits, status: users.status, createdAt: users.createdAt })
      .from(users)
      .where(and(eq(users.id, id), eq(users.isDeleted, false)));

    if (!user) { res.status(404).json({ error: "Usuario no encontrado" }); return; }

    // Run the three aggregate queries in parallel for speed
    const [totalSpentRow, totalCreditsBoughtRow, totalCreditsUsedRow] = await Promise.all([
      db.select({ total: sql<string>`coalesce(sum(amount), 0)` }).from(payments).where(eq(payments.userId, id)),
      db.select({ total: sql<number>`coalesce(sum(credits_added), 0)` }).from(payments).where(eq(payments.userId, id)),
      db.select({ total: sql<number>`coalesce(sum(credits_used), 0)` }).from(usageLogs).where(eq(usageLogs.userId, id)),
    ]);

    res.json({
      ...user,
      createdAt:          user.createdAt?.toISOString() ?? null,
      totalSpent:         Number(totalSpentRow[0].total),
      totalCreditsBought: Number(totalCreditsBoughtRow[0].total),
      totalCreditsUsed:   Number(totalCreditsUsedRow[0].total),
    });
  } catch (err) {
    req.log.error({ err }, "Error obteniendo usuario");
    res.status(500).json({ error: "Error interno" });
  }
});

// ── POST /api/admin/users ──────────────────────────────────────────────────────
router.post("/users", async (req, res) => {
  const { username, password, initialCredits } = req.body ?? {};

  if (!username || !password) {
    res.status(400).json({ error: "Usuario y contraseña requeridos" });
    return;
  }

  try {
    const [existing] = await db
      .select({ id: users.id, isDeleted: users.isDeleted })
      .from(users)
      .where(eq(users.username, String(username)));

    if (existing && !existing.isDeleted) {
      res.status(409).json({ error: "El usuario ya existe" });
      return;
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const credits = parseInt(String(initialCredits ?? "0"), 10) || 0;

    let newUserId: number;

    if (existing?.isDeleted) {
      const [updated] = await db
        .update(users)
        .set({ passwordHash, isDeleted: false, credits, status: "active" })
        .where(eq(users.id, existing.id))
        .returning({ id: users.id, username: users.username, role: users.role, credits: users.credits, status: users.status });
      newUserId = existing.id;
      const copied = await copyCatalogToUser(newUserId);
      invalidateInventoryCache(newUserId);
      res.status(201).json({ ...updated, catalogCopied: copied });
    } else {
      const [created] = await db
        .insert(users)
        .values({ username: String(username), passwordHash, role: "user", credits, status: "active" })
        .returning({ id: users.id, username: users.username, role: users.role, credits: users.credits, status: users.status });
      newUserId = created.id;
      const copied = await copyCatalogToUser(newUserId);
      invalidateInventoryCache(newUserId);
      res.status(201).json({ ...created, catalogCopied: copied });
    }
  } catch (err) {
    req.log.error({ err }, "Error creando usuario");
    res.status(500).json({ error: "Error al crear usuario" });
  }
});

// ── POST /api/admin/users/:id/password ───────────────────────────────────────
router.post("/users/:id/password", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const { password } = req.body ?? {};
  if (!password || String(password).length < 4) {
    res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres" });
    return;
  }

  try {
    const [target] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, id));
    if (!target) { res.status(404).json({ error: "Usuario no encontrado" }); return; }

    const passwordHash = await bcrypt.hash(String(password), 10);
    await db.update(users).set({ passwordHash }).where(eq(users.id, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Error cambiando contraseña");
    res.status(500).json({ error: "Error al cambiar contraseña" });
  }
});

// ── POST /api/admin/users/:id/credits ── atomic increment to prevent races ────
router.post("/users/:id/credits", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const creditsToAdd = parseInt(String(req.body?.credits_to_add ?? "0"), 10);
  if (!creditsToAdd || creditsToAdd <= 0) {
    res.status(400).json({ error: "Ingresa una cantidad válida de créditos" });
    return;
  }

  try {
    // Atomic increment — avoids read-then-write race condition under concurrent requests.
    const [updated] = await db
      .update(users)
      .set({ credits: sql`credits + ${creditsToAdd}` })
      .where(and(eq(users.id, id), eq(users.isDeleted, false)))
      .returning({ id: users.id, credits: users.credits });

    if (!updated) { res.status(404).json({ error: "Usuario no encontrado" }); return; }

    res.json({ success: true, credits: updated.credits });
  } catch (err) {
    req.log.error({ err }, "Error agregando créditos");
    res.status(500).json({ error: "Error al agregar créditos" });
  }
});

// ── POST /api/admin/users/:id/payments ── registrar pago manual ──────────────
router.post("/users/:id/payments", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const { amount, credits_added, method, note } = req.body ?? {};

  if (!amount || !credits_added) {
    res.status(400).json({ error: "Monto y créditos son requeridos" });
    return;
  }

  const creditsAdded = parseInt(String(credits_added), 10);
  if (creditsAdded <= 0) {
    res.status(400).json({ error: "Los créditos deben ser mayor a 0" });
    return;
  }

  try {
    await db.transaction(async tx => {
      await tx.insert(payments).values({
        userId:       id,
        amount:       String(amount),
        creditsAdded,
        method:       String(method ?? "efectivo"),
        notes:        note ? String(note) : null,
      });
      // Atomic increment inside transaction — safe under concurrent payment registrations
      await tx.update(users)
        .set({ credits: sql`credits + ${creditsAdded}` })
        .where(eq(users.id, id));
    });

    const [updated] = await db.select({ credits: users.credits }).from(users).where(eq(users.id, id));
    res.json({ success: true, credits: updated.credits });
  } catch (err) {
    req.log.error({ err }, "Error registrando pago");
    res.status(500).json({ error: "Error al registrar pago" });
  }
});

// ── POST /api/admin/users/:id/status ─────────────────────────────────────────
router.post("/users/:id/status", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  if (req.user?.id === id) {
    res.status(400).json({ error: "No puedes suspenderte a ti mismo" });
    return;
  }

  try {
    const [target] = await db.select({ status: users.status, role: users.role }).from(users).where(eq(users.id, id));
    if (!target) { res.status(404).json({ error: "Usuario no encontrado" }); return; }
    if (target.role === "admin") { res.status(403).json({ error: "No se puede suspender al administrador" }); return; }

    const newStatus = target.status === "suspended" ? "active" : "suspended";
    await db.update(users).set({ status: newStatus }).where(eq(users.id, id));

    res.json({ success: true, status: newStatus });
  } catch (err) {
    req.log.error({ err }, "Error cambiando estado");
    res.status(500).json({ error: "Error al cambiar estado" });
  }
});

// ── GET /api/admin/users/:id/payments ────────────────────────────────────────
router.get("/users/:id/payments", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  try {
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.userId, id))
      .orderBy(desc(payments.createdAt))
      .limit(100);

    res.json(rows.map(r => ({ ...r, createdAt: r.createdAt?.toISOString() ?? null })));
  } catch (err) {
    req.log.error({ err }, "Error obteniendo pagos");
    res.status(500).json({ error: "Error interno" });
  }
});

// ── GET /api/admin/users/:id/usage ───────────────────────────────────────────
router.get("/users/:id/usage", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  try {
    const rows = await db
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.userId, id))
      .orderBy(desc(usageLogs.createdAt))
      .limit(100);

    res.json(rows.map(r => ({ ...r, createdAt: r.createdAt?.toISOString() ?? null })));
  } catch (err) {
    req.log.error({ err }, "Error obteniendo historial de uso");
    res.status(500).json({ error: "Error interno" });
  }
});

// ── DELETE /api/admin/users/:id ── soft delete ────────────────────────────────
router.delete("/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  if (req.user?.id === id) {
    res.status(400).json({ error: "No puedes eliminar tu propia cuenta" });
    return;
  }

  try {
    const [target] = await db
      .select({ id: users.id, role: users.role, isDeleted: users.isDeleted })
      .from(users)
      .where(eq(users.id, id));

    if (!target) { res.status(404).json({ error: "Usuario no encontrado" }); return; }
    if (target.role === "admin") { res.status(403).json({ error: "No se puede eliminar al administrador principal" }); return; }
    if (target.isDeleted) { res.status(409).json({ error: "El usuario ya fue eliminado" }); return; }

    await db.update(users).set({ isDeleted: true }).where(eq(users.id, id));
    res.json({ success: true, message: "Usuario eliminado correctamente" });
  } catch (err) {
    req.log.error({ err }, "Error eliminando usuario");
    res.status(500).json({ error: "Error al eliminar usuario" });
  }
});

// ── POST /api/admin/sync-catalog ── parallelized per-user catalog sync ────────
router.post("/sync-catalog", async (req, res) => {
  try {
    const catalog = await db.select().from(inventoryItems).where(isNull(inventoryItems.userId));
    if (catalog.length === 0) {
      res.json({ synced: 0, message: "El catálogo está vacío" });
      return;
    }

    const allUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isDeleted, false), ne(users.role, "admin")));

    // Run all per-user copies in parallel instead of sequentially (O(N) vs O(N×M))
    const results = await Promise.allSettled(
      allUsers.map(user => copyCatalogToUser(user.id))
    );

    let totalSynced = 0;
    const errors: number[] = [];

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        const count = result.value;
        if (count > 0) {
          invalidateInventoryCache(allUsers[i]!.id);
          totalSynced += count;
        }
      } else {
        errors.push(allUsers[i]!.id);
        req.log.error({ err: result.reason, userId: allUsers[i]!.id }, "Error syncing catalog to user");
      }
    });

    res.json({
      success: errors.length === 0,
      usersUpdated: allUsers.length - errors.length,
      itemsSynced: totalSynced,
      failedUsers: errors,
      message: `${totalSynced} items nuevos enviados a ${allUsers.length - errors.length} usuarios`,
    });
  } catch (err) {
    req.log.error({ err }, "Error sincronizando catálogo");
    res.status(500).json({ error: "Error al sincronizar catálogo" });
  }
});

export default router;
