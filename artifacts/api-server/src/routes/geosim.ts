import { Router } from "express";
import { db, geosimTerrains, geosimPlantCatalog, geosimDesigns, geosimSimulations } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

// Terrains
router.get("/terrains", async (req, res) => {
  try {
    const rows = await db.select().from(geosimTerrains);
    res.json({ terrains: rows });
  } catch (err) {
    req.log.error({ err }, "Error fetching terrains");
    res.status(500).json({ error: "Error interno" });
  }
});

router.post("/terrains", async (req, res) => {
  try {
    const [row] = await db.insert(geosimTerrains).values(req.body).returning();
    res.status(201).json({ terrain: row });
  } catch (err) {
    req.log.error({ err }, "Error creating terrain");
    res.status(500).json({ error: "Error interno" });
  }
});

// Plant catalog
router.get("/plants", async (req, res) => {
  try {
    const rows = await db.select().from(geosimPlantCatalog).where(eq(geosimPlantCatalog.isActive, true));
    res.json({ plants: rows });
  } catch (err) {
    req.log.error({ err }, "Error fetching plants");
    res.status(500).json({ error: "Error interno" });
  }
});

router.post("/plants", async (req, res) => {
  try {
    const [row] = await db.insert(geosimPlantCatalog).values(req.body).returning();
    res.status(201).json({ plant: row });
  } catch (err) {
    req.log.error({ err }, "Error creating plant");
    res.status(500).json({ error: "Error interno" });
  }
});

// Designs
router.get("/designs", async (req, res) => {
  try {
    const rows = await db.select().from(geosimDesigns);
    res.json({ designs: rows });
  } catch (err) {
    req.log.error({ err }, "Error fetching designs");
    res.status(500).json({ error: "Error interno" });
  }
});

router.post("/designs", async (req, res) => {
  try {
    const [row] = await db.insert(geosimDesigns).values(req.body).returning();
    res.status(201).json({ design: row });
  } catch (err) {
    req.log.error({ err }, "Error creating design");
    res.status(500).json({ error: "Error interno" });
  }
});

// Simulations
router.post("/simulate", async (req, res) => {
  try {
    const { designId, years = 5, climateMultiplier = "1.0", plants = [] } = req.body as {
      designId?: number;
      years?: number;
      climateMultiplier?: string;
      plants?: {
        plantId: number;
        quantity: number;
        name: string;
        growthRatePerYear: string;
        initialSizeM: string;
        maxSizeM: string;
        waterNeedLPerDay: string;
        survivalProbability: string;
        pricePerUnit: string;
        maintenanceCostPerYear: string;
      }[];
    };

    const multiplier = parseFloat(climateMultiplier) || 1.0;
    const yearlyResults = [];

    for (let y = 1; y <= years; y++) {
      const plantResults = plants.map((p) => {
        const growth = parseFloat(p.growthRatePerYear) * multiplier;
        const currentSize = Math.min(
          parseFloat(p.initialSizeM) + growth * y,
          parseFloat(p.maxSizeM),
        );
        const survival = Math.pow(parseFloat(p.survivalProbability), y);
        const alive = Math.round(p.quantity * survival);
        const waterTotal = parseFloat(p.waterNeedLPerDay) * alive * 365;
        const maintenance = parseFloat(p.maintenanceCostPerYear) * alive;

        return {
          plantId: p.plantId,
          name: p.name,
          year: y,
          alive,
          dead: p.quantity - alive,
          currentSizeM: parseFloat(currentSize.toFixed(2)),
          waterLPerYear: Math.round(waterTotal),
          maintenanceCostMXN: Math.round(maintenance),
        };
      });

      const totalWater = plantResults.reduce((s, p) => s + p.waterLPerYear, 0);
      const totalMaintenance = plantResults.reduce((s, p) => s + p.maintenanceCostMXN, 0);

      yearlyResults.push({ year: y, plants: plantResults, totalWater, totalMaintenanceMXN: totalMaintenance });
    }

    const results = { years, climateMultiplier, yearly: yearlyResults };

    if (designId) {
      const [row] = await db
        .insert(geosimSimulations)
        .values({ designId, years, climateMultiplier, results })
        .returning();
      res.json({ simulation: row, results });
    } else {
      res.json({ results });
    }
  } catch (err) {
    req.log.error({ err }, "Error running simulation");
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
