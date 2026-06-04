import { Router } from "express";
import { db, projects } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

// Fields a client is allowed to write — prevents overwriting userId, createdAt, etc.
const ALLOWED_UPDATE_FIELDS = new Set([
  "clientName",
  "clientPhone",
  "clientAddress",
  "gardenImageData",
  "designData",
  "totalEstimate",
]);

function sanitizeUpdates(body: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of ALLOWED_UPDATE_FIELDS) {
    if (key in body) safe[key] = body[key];
  }
  safe.updatedAt = new Date();
  return safe;
}

// GET all projects for user
router.get("/", async (req, res) => {
  try {
    const userId = req.user!.id;
    const allProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.userId, userId))
      .orderBy(desc(projects.updatedAt));

    res.json({ projects: allProjects });
  } catch (err) {
    req.log.error({ err }, "Error fetching projects");
    res.status(500).json({ error: "Error interno" });
  }
});

// GET single project
router.get("/:id", async (req, res) => {
  try {
    const userId = req.user!.id;
    const id = Number(req.params.id);

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.json({ project });
  } catch (err) {
    req.log.error({ err }, "Error fetching project");
    res.status(500).json({ error: "Error interno" });
  }
});

// POST create project
router.post("/", async (req, res) => {
  try {
    const userId = req.user!.id;
    const { clientName, clientPhone, clientAddress, gardenImageData, designData, totalEstimate } =
      req.body as Record<string, string | undefined>;

    if (!clientName) {
      res.status(400).json({ error: "clientName required" });
      return;
    }

    const [project] = await db
      .insert(projects)
      .values({
        userId,
        clientName,
        clientPhone,
        clientAddress,
        gardenImageData,
        designData,
        totalEstimate: totalEstimate ?? "0",
      })
      .returning();

    res.status(201).json({ project });
  } catch (err) {
    req.log.error({ err }, "Error creating project");
    res.status(500).json({ error: "Error interno" });
  }
});

// Shared update handler — used by both PUT and PATCH
async function handleUpdate(req: import("express").Request, res: import("express").Response) {
  try {
    const userId = req.user!.id;
    const id = Number(req.params.id);
    const updates = sanitizeUpdates(req.body as Record<string, unknown>);

    const [project] = await db
      .update(projects)
      .set(updates)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .returning();

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.json({ project });
  } catch (err) {
    req.log.error({ err }, "Error updating project");
    res.status(500).json({ error: "Error interno" });
  }
}

// PUT update project
router.put("/:id", handleUpdate);

// PATCH update project (alias → same handler, no duplication)
router.patch("/:id", handleUpdate);

// DELETE project
router.delete("/:id", async (req, res) => {
  try {
    const userId = req.user!.id;
    const id = Number(req.params.id);

    await db
      .delete(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)));

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Error deleting project");
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
