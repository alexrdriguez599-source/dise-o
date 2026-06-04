import { Router } from "express";
import authRouter from "./auth";
import adminRouter from "./admin";
import aiRouter from "./ai";
import wavespeedRouter from "./wavespeed";
import inventoryRouter from "./inventory";
import projectsRouter from "./projects";
import geosimRouter from "./geosim";
import learningRouter from "./learning";
import downloadRouter from "./download";

const router = Router();

router.use("/auth", authRouter);
router.use("/admin", adminRouter);
router.use("/ai", aiRouter);
router.use("/ai/wavespeed", wavespeedRouter);
router.use("/inventory", inventoryRouter);
router.use("/projects", projectsRouter);
router.use("/geosim", geosimRouter);
router.use("/learning", learningRouter);
router.use("/download", downloadRouter);

router.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

export default router;
