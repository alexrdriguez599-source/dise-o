import { Router } from "express";
import { db, users, usageLogs } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

async function deductCredit(userId: number, action: string, cost = 1): Promise<boolean> {
  const [user] = await db
    .select({ credits: users.credits, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) return false;
  if ((user as { role: string }).role === "admin") return true;
  if (user.credits < cost) return false;

  await db
    .update(users)
    .set({ credits: sql`${users.credits} - ${cost}` })
    .where(eq(users.id, userId));

  await db.insert(usageLogs).values({ userId, action, creditsUsed: cost });
  return true;
}

// Chat — paisajista IA
router.post("/chat", async (req, res) => {
  const { messages } = req.body as {
    messages?: { role: string; content: string }[];
    systemPrompt?: string;
  };

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: "messages array required" });
    return;
  }

  const ok = await deductCredit(req.user!.id, "ai_chat", 1);
  if (!ok) {
    res.status(402).json({ error: "Sin créditos disponibles. Contacta al administrador." });
    return;
  }

  res.json({
    reply:
      "El asistente de IA está disponible próximamente. Por ahora usa las herramientas de diseño y render premium.",
  });
});

// Identificar planta
router.post("/identify-plant", async (req, res) => {
  const { imageBase64 } = req.body as { imageBase64?: string };

  if (!imageBase64) {
    res.status(400).json({ error: "imageBase64 required" });
    return;
  }

  const ok = await deductCredit(req.user!.id, "plant_identify", 1);
  if (!ok) {
    res.status(402).json({ error: "Sin créditos disponibles." });
    return;
  }

  res.json({ plant: { nombre: "Identificación no disponible en este momento" } });
});

// Sugerir diseño — layout de zonas y plantas para el CAD
router.post("/suggest-design", async (req, res) => {
  const ok = await deductCredit(req.user!.id, "suggest_design", 2);
  if (!ok) {
    res.status(402).json({ error: "Sin créditos disponibles." });
    return;
  }
  res.json({
    zones: [],
    plants: [],
    bom: null,
    summary: "El asistente de sugerencias estará disponible próximamente. Por ahora dibuja las zonas manualmente y asigna materiales del catálogo.",
  });
});

// Plan de diseño — genera lista de materiales (BOM) desde inventario
router.post("/design-plan", async (req, res) => {
  const { inventory = [], areaM2 = 20 } = req.body as {
    inventory?: Array<{ id: number; name: string; category: string; quantity: number; unitPrice?: number }>;
    areaM2?: number;
  };

  const ok = await deductCredit(req.user!.id, "design_plan", 2);
  if (!ok) {
    res.status(402).json({ error: "Sin créditos disponibles." });
    return;
  }

  const usableItems = (inventory as Array<{ id: number; name: string; category: string; quantity: number; unitPrice?: number }>).slice(0, 10);
  if (usableItems.length === 0) {
    res.status(400).json({ error: "El inventario está vacío. Agrega plantas y materiales antes de generar un plan." });
    return;
  }

  const perItem = Math.max(1, Math.round((areaM2 as number) / usableItems.length));
  const bom = usableItems.map((item) => ({
    itemId: item.id,
    name: item.name,
    category: item.category,
    quantity: Math.min(perItem, item.quantity || perItem),
    unitPrice: item.unitPrice ?? 0,
    total: (item.unitPrice ?? 0) * Math.min(perItem, item.quantity || perItem),
  }));

  res.json({ bom });
});

// Analizar jardín
router.post("/analyze-garden", async (req, res) => {
  const { imageBase64 } = req.body as {
    imageBase64?: string;
    projectDetails?: string;
  };

  if (!imageBase64) {
    res.status(400).json({ error: "imageBase64 required" });
    return;
  }

  const ok = await deductCredit(req.user!.id, "garden_analyze", 2);
  if (!ok) {
    res.status(402).json({ error: "Sin créditos disponibles." });
    return;
  }

  res.json({ analysis: { raw: "Análisis no disponible en este momento" } });
});

export default router;
