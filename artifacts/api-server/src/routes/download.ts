import { Router } from "express";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

// Download proxy for WaveSpeed images (avoids CORS on frontend)
router.get("/image", async (req, res) => {
  const { url } = req.query as { url?: string };

  if (!url) {
    res.status(400).json({ error: "url query param required" });
    return;
  }

  const resp = await fetch(url);
  if (!resp.ok) {
    res.status(502).json({ error: "Failed to fetch image" });
    return;
  }

  const buffer = await resp.arrayBuffer();
  const contentType = resp.headers.get("content-type") ?? "image/png";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", "attachment; filename=garden-render.png");
  res.send(Buffer.from(buffer));
});

export default router;
