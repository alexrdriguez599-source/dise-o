import { Router } from "express";
import { db, learningEvents } from "@workspace/db";
import { desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const events = await db
      .select()
      .from(learningEvents)
      .orderBy(desc(learningEvents.createdAt))
      .limit(200);

    res.json({ events });
  } catch (err) {
    req.log.error({ err }, "Error fetching learning events");
    res.status(500).json({ error: "Error interno" });
  }
});

router.post("/", async (req, res) => {
  try {
    const {
      eventType,
      inventoryItemId,
      itemName,
      itemType,
      materialId,
      style,
      areaM2,
      quantity,
    } = req.body as {
      eventType?: string;
      inventoryItemId?: number;
      itemName?: string;
      itemType?: string;
      materialId?: string;
      style?: string;
      areaM2?: string;
      quantity?: number;
    };

    if (!eventType) {
      res.status(400).json({ error: "eventType required" });
      return;
    }

    const [event] = await db
      .insert(learningEvents)
      .values({ eventType, inventoryItemId, itemName, itemType, materialId, style, areaM2, quantity })
      .returning();

    res.status(201).json({ event });
  } catch (err) {
    req.log.error({ err }, "Error creating learning event");
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
