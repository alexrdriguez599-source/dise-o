import { Router } from "express";
import { db, inventoryItems } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

// Item shape devuelto en el listado (sin imageData — se carga por /id/image)
type ListItem = Omit<typeof inventoryItems.$inferSelect, "imageData"> & { hasImage: boolean };

function stripImage(item: typeof inventoryItems.$inferSelect): ListItem {
  const { imageData, ...rest } = item;
  return { ...rest, hasImage: !!imageData };
}

// NOTE: Antes existía un caché en memoria por proceso para el listado. En
// despliegues autoscale (varias instancias) ese caché provocaba lecturas
// obsoletas: un POST invalidaba solo el caché de la instancia que lo atendía,
// y un GET posterior en otra instancia devolvía la lista vieja → los ítems
// recién creados "desaparecían" al recargar. Se eliminó: ahora el listado
// siempre lee de la base de datos (proyectando sin image_data para mantener
// la lectura ligera; las imágenes se cargan aparte por /:id/image).

// Columnas del listado (todo menos image_data) + hasImage calculado en SQL.
const listColumns = {
  id: inventoryItems.id,
  userId: inventoryItems.userId,
  name: inventoryItems.name,
  category: inventoryItems.category,
  quantity: inventoryItems.quantity,
  unit: inventoryItems.unit,
  status: inventoryItems.status,
  notes: inventoryItems.notes,
  price: inventoryItems.price,
  itemType: inventoryItems.itemType,
  size: inventoryItems.size,
  spacing: inventoryItems.spacing,
  createdAt: inventoryItems.createdAt,
  updatedAt: inventoryItems.updatedAt,
  hasImage: sql<boolean>`${inventoryItems.imageData} IS NOT NULL`,
} as const;

// Conservado como no-op para no tocar admin.ts (que aún lo importa/llama).
// Ya no hay caché que invalidar: las lecturas siempre van a la base.
export function invalidateInventoryCache(_userId?: number): void {
  /* no-op: el listado ya no usa caché en memoria */
}

// Fields a caller is allowed to update — prevents overwriting userId, createdAt, etc.
const ALLOWED_UPDATE_FIELDS = new Set([
  "name", "category", "quantity", "unit", "status",
  "notes", "price", "imageData", "itemType", "size", "spacing",
]);

function sanitizeItemUpdates(body: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of ALLOWED_UPDATE_FIELDS) {
    if (key in body) safe[key] = body[key];
  }
  return safe;
}

// GET summary
router.get("/summary", async (req, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === "admin";

    let items;
    if (isAdmin) {
      items = await db.select({ category: inventoryItems.category, status: inventoryItems.status, price: inventoryItems.price }).from(inventoryItems);
    } else {
      items = await db
        .select({ category: inventoryItems.category, status: inventoryItems.status, price: inventoryItems.price })
        .from(inventoryItems)
        .where(eq(inventoryItems.userId, userId));
    }

    const byCategory: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let totalValue = 0;

    for (const item of items) {
      const cat = item.category ?? "other";
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      const st = item.status ?? "available";
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      if (item.price) totalValue += Number(item.price);
    }

    res.json({ total: items.length, byCategory, byStatus, totalValue });
  } catch (err) {
    req.log.error({ err }, "Error fetching inventory summary");
    res.status(500).json({ error: "Error interno" });
  }
});

// GET all items
router.get("/", async (req, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === "admin";

    // Siempre desde la base (sin caché en memoria) para consistencia en autoscale.
    let items;
    if (isAdmin) {
      items = await db.select(listColumns).from(inventoryItems);
    } else {
      items = await db
        .select(listColumns)
        .from(inventoryItems)
        .where(eq(inventoryItems.userId, userId));
    }

    res.json({ items });
  } catch (err) {
    req.log.error({ err }, "Error fetching inventory");
    res.status(500).json({ error: "Error interno" });
  }
});

// POST create item
router.post("/", async (req, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === "admin";
    const { name, category, quantity, unit, status, notes, price, imageData, itemType, size, spacing } =
      req.body as Record<string, string | number | undefined>;

    if (!name) {
      res.status(400).json({ error: "name required" });
      return;
    }

    const [item] = await db
      .insert(inventoryItems)
      .values({
        userId: isAdmin ? null : userId,
        name: String(name),
        category: category ? String(category) : "plant",
        quantity: quantity !== undefined ? String(quantity) : "0",
        unit: unit ? String(unit) : "unidad",
        status: status ? String(status) : "available",
        notes: notes ? String(notes) : undefined,
        price: price !== undefined ? String(price) : undefined,
        imageData: imageData ? String(imageData) : undefined,
        itemType: itemType ? String(itemType) : undefined,
        size: size ? String(size) : undefined,
        spacing: spacing !== undefined ? String(spacing) : undefined,
      })
      .returning();

    res.status(201).json({ item: stripImage(item) });
  } catch (err) {
    req.log.error({ err }, "Error creating inventory item");
    res.status(500).json({ error: "Error interno" });
  }
});

// Shared update handler — used by PUT and PATCH
async function handleItemUpdate(req: import("express").Request, res: import("express").Response) {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === "admin";
    const id = Number(req.params.id);
    const updates = sanitizeItemUpdates(req.body as Record<string, unknown>);

    const whereClause = isAdmin
      ? eq(inventoryItems.id, id)
      : and(eq(inventoryItems.id, id), eq(inventoryItems.userId, userId));

    const [item] = await db
      .update(inventoryItems)
      .set(updates)
      .where(whereClause)
      .returning();

    if (!item) {
      res.status(404).json({ error: "Item not found" });
      return;
    }

    res.json({ item: stripImage(item) });
  } catch (err) {
    req.log.error({ err }, "Error updating inventory item");
    res.status(500).json({ error: "Error interno" });
  }
}

// PUT update item
router.put("/:id", handleItemUpdate);

// PATCH update item (alias → same handler)
router.patch("/:id", handleItemUpdate);

// GET /api/inventory/:id/image
router.get("/:id/image", async (req, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === "admin";
    const id = Number(req.params.id);

    const whereClause = isAdmin
      ? eq(inventoryItems.id, id)
      : and(eq(inventoryItems.id, id), eq(inventoryItems.userId, userId));

    const [item] = await db
      .select({ imageData: inventoryItems.imageData })
      .from(inventoryItems)
      .where(whereClause)
      .limit(1);

    if (!item?.imageData) {
      res.status(404).json({ error: "Image not found" });
      return;
    }

    const raw = item.imageData;
    const match = raw.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const mimeType = match[1];
      const base64 = match[2];
      const buffer = Buffer.from(base64, "base64");
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.end(buffer);
    } else {
      const buffer = Buffer.from(raw, "base64");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.end(buffer);
    }
  } catch (err) {
    req.log.error({ err }, "Error serving inventory image");
    res.status(500).json({ error: "Error interno" });
  }
});

// DELETE item
router.delete("/:id", async (req, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === "admin";
    const id = Number(req.params.id);

    const whereClause = isAdmin
      ? eq(inventoryItems.id, id)
      : and(eq(inventoryItems.id, id), eq(inventoryItems.userId, userId));

    await db.delete(inventoryItems).where(whereClause);

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Error deleting inventory item");
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
