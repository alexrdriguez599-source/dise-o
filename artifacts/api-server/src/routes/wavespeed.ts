import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { users, usageLogs } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// ── Free retry token store — single-use, 5-min TTL ───────────────────────────
const retryTokens = new Map<string, number>(); // token → expiry ms
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of retryTokens) if (exp <= now) retryTokens.delete(t);
}, 60_000);

const BASE = "https://api.wavespeed.ai/api/v3";
const KEY = () => process.env.WAVESPEED_API_KEY;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function startJob(
  modelPath: string,
  body: Record<string, unknown>
): Promise<{ id?: string; status?: string; outputs?: string[] }> {
  logger.info(`[wavespeed] startJob POST ${BASE}/${modelPath}`);
  const res = await fetch(`${BASE}/${modelPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as {
    code: number;
    message: string;
    data: { id?: string; status?: string; outputs?: string[] };
  };
  if (data.code !== 200) {
    logger.error(`[wavespeed] startJob error: code=${data.code} message=${data.message}`);
    throw new Error(data.message || `WaveSpeed error: ${data.code}`);
  }
  logger.info(`[wavespeed] startJob success: id=${data.data?.id} status=${data.data?.status}`);
  return data.data;
}

async function pollResult(taskId: string, maxMs = 180_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(3000);
    const res = await fetch(`${BASE}/predictions/${taskId}/result`, {
      headers: { Authorization: `Bearer ${KEY()}` },
    });
    const data = (await res.json()) as {
      code: number;
      data: { status: string; outputs?: string[]; error?: string };
    };
    const status = data.data?.status;
    if (status === "completed") {
      const output = data.data?.outputs?.[0];
      if (!output) throw new Error("No output from WaveSpeed");
      return output;
    }
    if (status === "failed") {
      throw new Error(data.data?.error || "WaveSpeed task failed");
    }
  }
  throw new Error("WaveSpeed timeout after 180s");
}

async function urlToBase64(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const ct = res.headers.get("content-type") || "image/png";
  return `data:${ct};base64,${Buffer.from(buf).toString("base64")}`;
}

async function resolveOutput(job: {
  id?: string;
  status?: string;
  outputs?: string[];
}): Promise<string> {
  if (job.status === "completed" && job.outputs?.[0]) {
    return job.outputs[0];
  }
  if (job.id) {
    return pollResult(job.id);
  }
  throw new Error("No job ID or immediate output from WaveSpeed");
}

async function checkOnce(taskId: string): Promise<{ status: string; outputs?: string[]; error?: string }> {
  const res = await fetch(`${BASE}/predictions/${taskId}/result`, {
    headers: { Authorization: `Bearer ${KEY()}` },
  });
  const data = (await res.json()) as {
    code: number;
    data: { status: string; outputs?: string[]; error?: string };
  };
  return data.data ?? { status: "unknown" };
}

async function quickPollOrJobId(
  job: { id?: string; status?: string; outputs?: string[] },
  quickMs = 12_000,
): Promise<{ done: true; url: string } | { done: false; jobId: string }> {
  if (job.status === "completed" && job.outputs?.[0]) {
    return { done: true, url: job.outputs[0] };
  }
  if (!job.id) throw new Error("No job ID or immediate output from WaveSpeed");
  const deadline = Date.now() + quickMs;
  while (Date.now() < deadline) {
    await sleep(2500);
    const check = await checkOnce(job.id);
    if (check.status === "completed" && check.outputs?.[0]) {
      return { done: true, url: check.outputs[0] };
    }
    if (check.status === "failed") {
      throw new Error(check.error || "WaveSpeed job failed");
    }
  }
  return { done: false, jobId: job.id };
}

// ── Async job status — no credits charged ─────────────────────────────────
router.get("/status/:jobId", requireAuth, async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  const { jobId } = req.params as { jobId: string };
  try {
    const check = await checkOnce(jobId);
    if (check.status === "completed" && check.outputs?.[0]) {
      logger.info(`[wavespeed/status] COMPLETED jobId=${jobId} outputUrl=${check.outputs[0].substring(0, 80)}...`);
      const imageBase64 = await urlToBase64(check.outputs[0]);
      logger.info(`[wavespeed/status] base64 length=${imageBase64.length}`);
      res.json({ status: "completed", imageBase64 });
    } else if (check.status === "failed") {
      logger.info(`[wavespeed/status] FAILED jobId=${jobId} error=${check.error}`);
      res.json({ status: "failed", error: check.error || "Job failed" });
    } else {
      res.json({ status: "pending" });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ status: "failed", error: msg });
  }
});

// ── Verificar créditos antes de cualquier operación AI ────────────────────────
// Admin siempre puede usar la IA sin límite.
// Usuarios normales necesitan créditos > 0; se descuenta 1 al inicio del request.
router.use(requireAuth, async (req, res, next) => {
  logger.info(`[wavespeed/auth] userId=${req.user?.id} role=${req.user?.role} path=${req.path}`);
  if (req.user?.role === "admin") { next(); return; }

  // Free retry token — magazine-render only, single-use, 5-min TTL
  if (req.path === "/magazine-render" && typeof req.body?.retryToken === "string") {
    const expiry = retryTokens.get(req.body.retryToken);
    if (expiry && expiry > Date.now()) {
      retryTokens.delete(req.body.retryToken);
      next();
      return;
    }
  }

  const userId = req.user!.id;
  try {
    await db.transaction(async tx => {
      const [u] = await tx
        .select({ credits: users.credits, status: users.status })
        .from(users)
        .where(eq(users.id, userId));

      logger.info(`[wavespeed/credits] userId=${userId} credits=${u?.credits} status=${u?.status}`);
      if (!u) throw Object.assign(new Error("Usuario no encontrado"), { status: 404 });
      if (u.status === "suspended")
        throw Object.assign(new Error("Cuenta suspendida. Contacta al administrador."), { status: 403 });
      if (u.credits <= 0)
        throw Object.assign(new Error("Sin créditos disponibles. Contacta al administrador para recargar."), { status: 402 });

      await tx.update(users).set({ credits: u.credits - 1 }).where(eq(users.id, userId));
      await tx.insert(usageLogs).values({
        userId,
        action:      `wavespeed:${req.path.replace(/^\//, "")}`,
        creditsUsed: 1,
      });
    });
    next();
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    res.status(e.status ?? 500).json({ error: e.message ?? "Error interno" });
  }
});

/**
 * POST /api/ai/wavespeed/inpaint
 * Body: { imageBase64, maskBase64, prompt? }
 * Returns: { imageBase64 }
 */
router.post("/inpaint", async (req, res) => {
  try {
    const {
      imageBase64,
      maskBase64,
      prompt = "clean natural ground surface, bare soil or dirt, empty area, seamless background fill matching surrounding terrain, no objects, no furniture, no people, no shadows",
      negativePrompt,
    } = req.body as {
      imageBase64?: string;
      maskBase64?: string;
      prompt?: string;
      negativePrompt?: string;
    };

    if (!imageBase64 || !maskBase64) {
      res.status(400).json({ error: "imageBase64 and maskBase64 are required" });
      return;
    }

    const resolvedNegative = negativePrompt ??
      "chairs, tables, furniture, trash, objects, plants, trees, flowers, people, animals, shadows of objects, text, watermark";

    const job = await startJob("wavespeed-ai/z-image/turbo-inpaint", {
      image: imageBase64,
      mask_image: maskBase64,
      prompt,
      negative_prompt: resolvedNegative,
    });

    const outcome = await quickPollOrJobId(job);
    if (outcome.done) {
      const result = await urlToBase64(outcome.url);
      res.json({ imageBase64: result });
    } else {
      res.json({ jobId: outcome.jobId, status: "pending" });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[wavespeed/inpaint] ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/ai/wavespeed/apply-material
 * Body: { imageBase64, maskBase64, material, prompt? }
 * Returns: { imageBase64 }
 */
router.post("/apply-material", async (req, res) => {
  try {
    const { imageBase64, maskBase64, material = "grass", prompt, negativePrompt: clientNegative } = req.body as {
      imageBase64?: string;
      maskBase64?: string;
      material?: string;
      prompt?: string;
      negativePrompt?: string;
    };

    logger.info(`[wavespeed/apply-material] Request received. material=${material} hasMask=${!!maskBase64} imageLen=${imageBase64?.length ?? 0}`);

    if (!imageBase64) {
      res.status(400).json({ error: "imageBase64 is required" });
      return;
    }

    // ── Mexican landscaping material prompts ─────────────────────────────────
    // Stones are sized/described as they actually appear in Mexican nurseries.
    const materialPrompts: Record<string, { positive: string; negative: string }> = {

      // ── VEGETACIÓN ────────────────────────────────────────────────────────
      grass: {
        positive:
          "((VIVID EMERALD GREEN GRASS LAWN)), ((bright saturated green color)), ((healthy living Zoysia grass)), ((rich kelly green color)), " +
          "Professional DSLR garden photo of a lush GREEN Zoysia grass lawn, COLOR IS VIVID EMERALD GREEN. " +
          "Ultra-dense carpet of short dark-green blades uniformly mowed at 1 cm. Rich saturated green color fills the entire ground area. " +
          "Compact carpet-like surface with no individual tall blade stalks. Same green texture from foreground to background. " +
          "Warm Mexican sunlight, photorealistic quality. ((Color: #2d7a2d emerald green, NOT brown, NOT tan, NOT beige, NOT dirt)).",
        negative:
          "((brown ground)), ((tan dirt)), ((beige soil)), ((dirt color)), ((bare earth)), ((unchanged dirt)), ((empty lot)), ((dry ground)), " +
          "yellow grass, yellow, golden, amber, straw, wheat, ochre, tan, beige, brown grass, dry grass, dead grass, burnt grass, drought, dormant grass, yellowish green, pale green, " +
          "artificial turf, synthetic, fake, plastic, cartoon, illustration, painting, digital art, 3D render, CGI, " +
          "concrete, stone, gravel, dirt, mud, soil showing through, raw earth, brown patches, " +
          "neon green, oversaturated, blur, watermark, text, " +
          "tall grass, long grass, uncut, overgrown, patchy, individual visible stalks, foreground tall blades, upright blade tips, perspective elongation",
      },

      // ── PIEDRAS DE RÍO (CANTOS RODADOS) ──────────────────────────────────
      // White river rocks — most common decorative stone in Mexico, 6-15cm
      "white-stone": {
        positive:
          "Photorealistic ground cover of smooth round white river stones (piedra bola blanca / canto rodado blanco), each stone naturally polished by water, 6–14 cm diameter per individual stone, densely packed with tiny gaps between them, subtle drop shadows on contact points, warm Mexican garden daylight, shot from above at 45°. Individual stones are clearly visible and distinct. Ultra-sharp macro photo, no digital art, no filters.",
        negative:
          "grass, plants, concrete, tile, flat texture, uniform white, illustration, blur, cartoon, painting, digital art, single big stone, pebbles smaller than 5cm, gravel dust, oversaturated, watermark, text",
      },
      // Gray river rocks — 6-15cm
      "grey-stone": {
        positive:
          "Photorealistic ground cover of smooth round gray river stones (piedra bola gris / canto rodado gris), naturally water-polished, 6–14 cm diameter per stone, medium gray with slight natural color variation (charcoal, silver, slate), densely packed, realistic shadows between stones, Mexican garden outdoor sunlight. Each stone individually visible. Ultra-sharp photo quality, no filters.",
        negative:
          "grass, plants, concrete, tile, flat texture, illustration, blur, cartoon, painting, digital art, white stones, black stones, pebbles smaller than 5cm, gravel, oversaturated, watermark",
      },

      // ── TEZONTLE (PIEDRA VOLCÁNICA MEXICANA) ─────────────────────────────
      // Red tezontle — iconic volcanic rock of Mexico, very affordable, 3-10cm
      "red-stone": {
        positive:
          "Photorealistic ground cover of red tezontle volcanic stone (tezontle rojo), iconic Mexican volcanic rock, irregular rough chunks 3–10 cm each, deep terracotta-red to dark rust-red porous surface, naturally matte finish, densely packed, warm outdoor Mexican garden sunlight. Ultra-realistic photo, individual pieces clearly distinguishable. No flat illustration, no digital art.",
        negative:
          "grass, plants, concrete, smooth stones, river rocks, polished stones, neon red, pink, flat overlay, illustration, blur, cartoon, painting, digital art, oversaturated, gravel dust, watermark",
      },
      // Black tezontle — dark volcanic stone
      "black-stone": {
        positive:
          "Photorealistic ground cover of black tezontle volcanic stone (tezontle negro / basalto volcánico), Mexican dark volcanic rock, rough porous irregular chunks 3–8 cm each, very dark gray to matte black color, lightly textured surface, densely packed, outdoor garden lighting with natural highlights. Ultra-realistic photo, individual pieces visible. No flat illustration.",
        negative:
          "grass, plants, concrete, smooth polished stones, colored stones, flat overlay, illustration, blur, cartoon, painting, digital art, oversaturated, river rocks, shiny, metallic, watermark",
      },

      // ── MÁRMOL TRITURADO ──────────────────────────────────────────────────
      // Crushed white marble — premium Mexican garden material, 1-3cm angular chips
      marble: {
        positive:
          "Photorealistic ground cover of crushed white marble chips (mármol blanco triturado), angular and sharp-edged pieces 1–3 cm each, bright white with subtle gray veins and translucent quality, densely and uniformly packed, luxury upscale Mexican garden, bright outdoor sunlight creating sparkle and micro-shadows. Ultra-sharp macro photo, premium clean look. No flat illustration.",
        negative:
          "grass, plants, concrete, round smooth stones, river rocks, gravel, soil, yellow, beige, flat overlay, illustration, blur, cartoon, painting, digital art, oversaturated, dirty, watermark",
      },

      // ── GRAVA FINA ────────────────────────────────────────────────────────
      // Fine river gravel — 1-3cm, garden paths and beds
      gravel: {
        positive:
          "Photorealistic ground cover of fine river gravel (grava de río fina), small rounded pebbles 1–3 cm diameter, natural sandy-beige and gray tones with warm color variation, uniformly and tightly packed, smooth natural garden path texture, warm outdoor Mexican sunlight. Ultra-sharp photo quality, seamless texture.",
        negative:
          "grass, plants, concrete, large rocks, tile, flat overlay, illustration, blur, cartoon, painting, digital art, oversaturated, dust, mud, watermark",
      },

      // ── TIERRA / SUELO ────────────────────────────────────────────────────
      soil: {
        positive:
          "Photorealistic natural garden soil filling the masked area, clean slightly moist dark brown earth, flat garden ground ready for planting, realistic soil texture with small natural crumbles, warm Mexican outdoor light. Seamless with surroundings. No objects on surface.",
        negative:
          "grass, concrete, gravel, stone, mud puddles, indoor, furniture, illustration, blur, painting, oversaturated, watermark",
      },

      // ── MULCH DE MADERA ───────────────────────────────────────────────────
      mulch: {
        positive:
          "Photorealistic natural wood chip mulch ground cover filling the masked area, organic brown bark chips and wood shavings 3–8 cm, warm earthy brown tones with natural variation, garden bed surface, realistic outdoor Mexican garden lighting. Ultra-sharp photo quality.",
        negative:
          "concrete, grass, stone, indoor, furniture, illustration, blur, painting, oversaturated, colored mulch, watermark",
      },

      // ── CONCRETO / ADOQUÍN ────────────────────────────────────────────────
      concrete: {
        positive:
          "Photorealistic smooth clean light gray concrete floor filling the masked area, flat and uniform hardscape surface, modern Mexican garden patio or walkway, slightly textured concrete finish, outdoor ambient lighting matching surroundings. Ultra-sharp photo quality, no cracks.",
        negative:
          "grass, dirt, gravel, stone, indoor, furniture, objects, illustration, blur, painting, oversaturated, cracks, watermark",
      },

      // ── LEGACY ALIAS ──────────────────────────────────────────────────────
      "multi-stone": {
        positive:
          "Photorealistic ground cover of mixed colored river stones (canto rodado multicolor), smooth naturally-rounded stones in white, beige, tan, gray and warm brown tones, 6–14 cm diameter each, densely packed, natural outdoor sunlight with soft shadows. Ultra-sharp photo quality.",
        negative:
          "grass, plants, concrete, tile, flat overlay, single color, illustration, blur, cartoon, painting, digital art, oversaturated, watermark",
      },
    };

    const materialDef = materialPrompts[material] ?? materialPrompts.grass;

    // Auto-grass (no mask): prompt EXTREMADAMENTE estricto.
    // La IA debe DETECTAR semánticamente la diferencia entre TIERRA y CARRETERA/CAMINO
    // y SOLO convertir áreas de tierra/suelo desnudo a pasto. NUNCA tocar superficies
    // pavimentadas (asfalto, concreto, adoquín, banquetas, accesos vehiculares).
    // PROMPT CORTO BLINDADO — regla del skill: <70 palabras = máxima adherencia.
    // Si el prompt es largo el modelo "promedia" instrucciones y desobedece.
    const autoGrassPrompt =
      "Realistic photo edit. Turn ONLY brown dirt and bare soil into natural green Zoysia lawn. " +
      "Keep all roads, asphalt, concrete, sidewalks, paths, pavers, curbs, buildings and structures 100% identical to the input. " +
      "Grass stops at pavement edge. Natural green, not neon. Nothing else changes.";

    // Negative corto — solo lo crítico.
    const autoGrassNegative =
      "grass on road, grass on pavement, grass on concrete, grass on sidewalk, grass on path, " +
      "covering road, covering pavement, covering walkway, covering driveway, " +
      "neon green, fluorescent, cartoon, artificial turf, plastic, " +
      "yellow grass, dead grass, brown grass, " +
      "added trees, added plants, new objects, changed buildings, changed sky";

    const resolvedPrompt = !maskBase64 && material === "grass"
      ? (prompt ?? autoGrassPrompt)
      : (prompt ?? materialDef.positive);
    const resolvedNegative = clientNegative ?? (
      !maskBase64 && material === "grass" ? autoGrassNegative : materialDef.negative
    );

    // Fixed seeds per material → same input always produces same output style
    const materialSeeds: Record<string, number> = {
      grass:       3394821,
      "white-stone": 3341872,
      "grey-stone":  5509234,
      "red-stone":   9182734,
      "black-stone": 2847391,
      marble:        6612847,
      gravel:        4423891,
      soil:          1182934,
      mulch:         8834512,
      concrete:      3312789,
      "multi-stone": 7123490,
    };
    const fixedSeed = materialSeeds[material] ?? 1234567;

    // flux-fill-dev acepta guidance_scale en rango [28, 35].
    // Para grass con máscara GRANDE usamos el MÁXIMO permitido (35) para
    // forzar al modelo a obedecer el prompt verde y no "promediar" con el
    // contexto color tierra de los alrededores.
    // flux-kontext-dev (sin máscara): rango distinto, 7 óptimo.
    const guidanceScale = maskBase64
      ? (material === "grass" ? 35 : 28)
      : 7;

    const body: Record<string, unknown> = {
      image: imageBase64,
      prompt: resolvedPrompt,
      negative_prompt: resolvedNegative,
      num_images: 1,
      num_inference_steps: material === "grass" ? 50 : 30,
      guidance_scale: guidanceScale,
      seed: fixedSeed,
    };

    if (maskBase64) {
      body.mask_image = maskBase64;
    } else {
      // Sin máscara (flux-kontext-dev): strength=0.35 — ULTRA conservador.
      // Bajado de 0.42 → 0.35 para que el modelo altere MENOS la imagen y
      // tenga menos margen de invadir carreteras/caminos/pavimento. La IA
      // solo modifica donde detecta tierra desnuda; lo demás queda casi
      // pixel-perfect. Si baja más (≤0.30) el pasto no se aplica.
      body.strength = 0.35;
    }

    const modelPath = maskBase64
      ? "wavespeed-ai/flux-fill-dev"
      : "wavespeed-ai/flux-kontext-dev";

    logger.info(`[wavespeed/apply-material] Calling WaveSpeed model=${modelPath} guidance=${body.guidance_scale}`);
    const job = await startJob(modelPath, body);
    logger.info(`[wavespeed/apply-material] Job started. id=${job.id} status=${job.status}`);
    const outcome = await quickPollOrJobId(job);
    if (outcome.done) {
      const result = await urlToBase64(outcome.url);
      logger.info(`[wavespeed/apply-material] Success. base64 length=${result.length}`);
      res.json({ imageBase64: result });
    } else {
      logger.info(`[wavespeed/apply-material] Job pending, returning jobId=${outcome.jobId}`);
      res.json({ jobId: outcome.jobId, status: "pending" });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[wavespeed/apply-material] ERROR: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/ai/wavespeed/design-auto
 * Body: { imageBase64, maskBase64, style? }
 * Returns: { imageBase64 }
 *
 * Uses WaveSpeed flux-fill-dev to generate a complete professional
 * landscape design inside the masked polygon area. Style can be
 * "moderno", "tropical" or "minimalista".
 */
router.post("/design-auto", async (req, res) => {
  try {
    const {
      imageBase64,
      maskBase64,
      style = "moderno",
      inventoryPlants = [],
    } = req.body as {
      imageBase64?: string;
      maskBase64?: string;
      style?: string;
      inventoryPlants?: { name: string; category: string; itemType?: string | null; quantity?: number }[];
    };

    if (!imageBase64 || !maskBase64) {
      res.status(400).json({ error: "imageBase64 and maskBase64 are required" });
      return;
    }

    // ── Build plant list from inventory ────────────────────────────────────────
    // Filter to vegetation only (exclude hardscape materials)
    const materialKeywords = ["piedra","grava","mármol","marmol","concreto","adoquin","adoquín","madera","tezontle","arena","mulch","tierra","suelo","cemento","tabique"];
    const vegetationItems = inventoryPlants.filter(item => {
      const combined = `${item.name} ${item.category} ${item.itemType ?? ""}`.toLowerCase();
      return !materialKeywords.some(kw => combined.includes(kw));
    });

    // Build a concise plant mention string (max 12 plants to keep prompt tight)
    const plantMention = vegetationItems.slice(0, 12).map(p => {
      const qty = p.quantity && p.quantity > 0 ? ` (${p.quantity})` : "";
      return `${p.name}${qty}`;
    }).join(", ");

    // ── Style base prompts ─────────────────────────────────────────────────────
    const stylePrompts: Record<string, { positive: string; negative: string }> = {
      moderno: {
        positive:
          "Photorealistic professional modern luxury Mexican garden design filling only the masked area. Contemporary landscaping with clean architectural lines, white marble gravel ground cover (mármol triturado), polished stepping stones, precision-trimmed hedges, ornamental grasses. Warm golden-hour afternoon Mexican sunlight, ultra-sharp professional landscape photography, seamlessly blends with surrounding terrain.",
        negative:
          "cartoon, illustration, painting, digital art, blur, oversaturated, unrealistic, people, animals, cars, indoor furniture, text, watermark, artificial turf, ugly weeds",
      },
      tropical: {
        positive:
          "Photorealistic lush vibrant tropical Mexican garden design filling only the masked area. Dense layered tropical vegetation, river stone pathways, rich dark organic mulch, layered canopy, warm humid daylight. Ultra-sharp professional landscape photography, seamlessly blends with surrounding terrain.",
        negative:
          "cartoon, illustration, painting, digital art, blur, oversaturated, unrealistic, people, animals, concrete slabs, text, watermark, dead plants, trash",
      },
      minimalista: {
        positive:
          "Photorealistic minimalist zen garden design filling only the masked area. Japanese-Mexican fusion: raked white marble gravel, intentionally placed smooth river stones (piedra bola), perfect symmetry and balance, lots of negative space, serene premium aesthetic. Soft diffused outdoor light, ultra-sharp professional photography, seamlessly blends with surrounding terrain.",
        negative:
          "cartoon, illustration, painting, digital art, blur, oversaturated, unrealistic, people, animals, dense vegetation, busy layout, text, watermark, bright colors, cluttered, grass lawn",
      },
      rustico: {
        positive:
          "Photorealistic rustic natural Mexican garden design filling only the masked area. Red tezontle volcanic stone paths, terracotta pots, wildflower ground cover, rough stone edging, warm terracotta and earth tones. Bright Mexican midday sun, ultra-sharp professional landscape photography, seamlessly blends with surrounding terrain.",
        negative:
          "cartoon, illustration, painting, digital art, blur, oversaturated, unrealistic, people, animals, modern concrete, text, watermark, artificial materials, vines, climbing plants, enredaderas",
      },
    };

    const def = stylePrompts[style] ?? stylePrompts.moderno;

    // ── Inject client's inventory plants into the positive prompt ──────────────
    let finalPrompt = def.positive;
    if (plantMention.length > 0) {
      finalPrompt =
        `${def.positive} ` +
        `MANDATORY: The design MUST visually include these specific plants from the client's inventory: ${plantMention}. ` +
        `These exact plant species must be clearly recognizable and prominently featured in the composition.`;
    }

    logger.info(`[wavespeed/design-auto] style=${style} plants="${plantMention}" imageLen=${imageBase64?.length ?? 0}`);

    const job = await startJob("wavespeed-ai/flux-fill-dev", {
      image: imageBase64,
      mask_image: maskBase64,
      prompt: finalPrompt,
      negative_prompt: def.negative,
      num_images: 1,
      num_inference_steps: 30,
      guidance_scale: 30,
    });

    logger.info(`[wavespeed/design-auto] Job started. id=${job.id} status=${job.status}`);
    const outcome = await quickPollOrJobId(job);
    if (outcome.done) {
      const result = await urlToBase64(outcome.url);
      logger.info(`[wavespeed/design-auto] Success. base64 length=${result.length}`);
      res.json({ imageBase64: result });
    } else {
      logger.info(`[wavespeed/design-auto] Job pending, returning jobId=${outcome.jobId}`);
      res.json({ jobId: outcome.jobId, status: "pending" });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[wavespeed/design-auto] ERROR: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/ai/wavespeed/clean-terrain
 * Body: { imageBase64: string }
 * Returns: { imageBase64: string }
 *
 * Uses WaveSpeed flux-kontext-dev to remove all clutter from the terrain
 * and generate a clean uniform lawn surface preserving perspective and geometry.
 */
/**
 * POST /api/ai/wavespeed/render-final
 * Body: { imageBase64, maskBase64? }
 * Returns: { imageBase64 }
 * Converts a composed design scene into a hyper-realistic professional render.
 * When maskBase64 is provided (black=protect plants, white=edit background),
 * uses flux-fill-dev inpainting so plants are physically blocked from modification.
 * Without mask, falls back to flux-kontext-dev image-to-image.
 */
router.post("/render-final", async (req, res) => {
  try {
    const { imageBase64, maskBase64 } = req.body as { imageBase64?: string; maskBase64?: string };
    if (!imageBase64) {
      res.status(400).json({ error: "imageBase64 is required" });
      return;
    }

    const hasMask = !!maskBase64;
    logger.info(`[wavespeed/render-final] Request received. imageLen=${imageBase64.length} hasMask=${hasMask}`);

    // ── Render Final — Fórmula profesional: Estilo + Sujeto + Entorno + Luz + Calidad ──
    const enhancePrompt = hasMask
      // Con máscara: mejora sólo áreas de fondo (plantas ya bloqueadas por mask)
      ? "Imagen hiperrealista fotorealista, render profesional de arquitectura de paisajismo, " +
        "calidad fotográfica como tomada con cámara DSLR. " +
        "SOLO mejorar las áreas de suelo editables: " +
        "grava blanca fina o piedra bola blanca con cada piedra individual visible, bordes nítidos y micro-sombras de contacto, " +
        "variación natural de color sutil, textura de suelo de jardín mexicano premium. " +
        "Iluminación natural de día soleado con sombras suaves y realistas. " +
        "Alta resolución, 8K, detalles fotográficos precisos, calidad de revista de arquitectura."
      // Sin máscara: render fotorrealista completo
      : "Imagen hiperrealista fotorealista de un patio o jardín diseñado profesionalmente, " +
        "render profesional de arquitectura de paisajismo 3D de máxima calidad, " +
        "MANTÉN exactamente el mismo layout, composición y posición de todos los elementos del diseño. " +
        "Vista amplia desde un ángulo ligeramente elevado, perspectiva a 45 grados, profundidad de campo completa todo nítido. " +
        "Suelo completamente cubierto de grava blanca fina o piedra bola blanca con cada piedra visible individualmente, micro-sombras realistas de contacto. " +
        "Plantas y palmeras con frondas ultra-nítidas, textura de tronco orgánica, translucidez natural de hojas. " +
        "Agua cristalina azul turquesa con reflejos realistas y causticas de luz en el fondo de la piscina si existe. " +
        "Muebles de exterior con materiales y texturas realistas, sombras de oclusión correctas. " +
        "Paredes blancas de estuco con textura sutil y profundidad. " +
        "Iluminación natural de día soleado con sombras suaves y realistas, luz tropical cálida de mañana-mediodía, " +
        "cielo azul claro con relleno de luz ambiente suave. " +
        "Grado de color profesional: luces cálidas doradas, sombras frescas azuladas, saturación rica y natural. " +
        "Alta resolución, 8K, detalles fotográficos precisos, calidad cinematográfica, " +
        "estilo render profesional de revista de arquitectura de paisajismo de lujo. " +
        "El resultado debe ser indistinguible de una fotografía real tomada en sitio con cámara Sony A7R IV.";

    const negativePrompt =
      "cartoon, ilustración, pintura, dibujo, arte digital, boceto, plano arquitectónico, " +
      "render CGI genérico, videojuego, superficies plásticas, aspecto sintético, " +
      "iluminación artificial de estudio, flash duro, cielo sobreexpuesto, " +
      "colores planos, desaturado, baja calidad, desenfoque, ruido, artefactos jpeg, " +
      "saturación excesiva, colores neón, marca de agua, texto, logo, personas, animales, autos, " +
      "cambiar posición de elementos, mover plantas, cambiar composición";

    const modelPath = hasMask ? "wavespeed-ai/flux-fill-dev" : "wavespeed-ai/flux-kontext-dev";
    const body: Record<string, unknown> = {
      image: imageBase64,
      prompt: enhancePrompt,
      negative_prompt: negativePrompt,
      num_images: 1,
      num_inference_steps: 50,           // máxima calidad
      guidance_scale: hasMask ? 30 : 18, // 18 = adhiere composición + alta calidad fotorrealista
      seed: Math.floor(Math.random() * 999999),
    };
    if (hasMask) body.mask_image = maskBase64;

    logger.info(`[wavespeed/render-final] Using model=${modelPath}`);
    const job = await startJob(modelPath, body);

    logger.info(`[wavespeed/render-final] Job started. id=${job.id} status=${job.status}`);
    const outcome = await quickPollOrJobId(job);
    if (outcome.done) {
      const result = await urlToBase64(outcome.url);
      logger.info(`[wavespeed/render-final] Success. base64 length=${result.length}`);
      res.json({ imageBase64: result });
    } else {
      logger.info(`[wavespeed/render-final] Job pending, returning jobId=${outcome.jobId}`);
      res.json({ jobId: outcome.jobId, status: "pending" });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[wavespeed/render-final] ERROR: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/ai/wavespeed/magazine-render
 * Body: { prompt, imageBase64? }
 *
 * Módulo independiente de render profesional.
 * - Con imagen: usa flux-kontext-dev (imagen como referencia de composición)
 *   guidance_scale=12 → sigue la composición pero aplica calidad fotorrealista
 * - Sin imagen: usa flux-dev (genera desde cero con el prompt)
 */
router.post("/magazine-render", async (req, res) => {
  try {
    const { prompt: userPrompt = "", imageBase64 } = req.body as {
      prompt?: string;
      imageBase64?: string;
    };

    if (!userPrompt.trim()) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    // imageBase64 es OBLIGATORIO — sin imagen el modelo genera desde cero
    // y destruye la composición del diseño (LECCIÓN crítica).
    if (!imageBase64) {
      res.status(400).json({ error: "imageBase64 is required. The design canvas image must be provided." });
      return;
    }

    logger.info(`[wavespeed/magazine-render] img2img mode. imageLen=${imageBase64.length} prompt="${userPrompt.substring(0, 100)}..."`);

    // ── Render fotorrealista — Google Nano-Banana Pro (UN solo paso) ───────
    // Modelo: google/nano-banana-pro/edit (Gemini 2.5 Flash Image, edit mode)
    // Recibe el lienzo completo con todas las plantas ya incluidas.
    // NO acepta: strength, guidance_scale, negative_prompt, seed, num_steps.
    // El modelo respeta la composición del input y devuelve JPEG ~2048px.
    // LECCIÓN VALIDADA: prompt corto <70 palabras = máxima adherencia al input.
    const job = await startJob("google/nano-banana-pro/edit", {
      images: [imageBase64],
      prompt: userPrompt.trim(),
      output_format: "jpeg",
    });

    logger.info(`[wavespeed/magazine-render] Job started. id=${job.id}`);
    const outcome = await quickPollOrJobId(job);
    if (outcome.done) {
      const result = await urlToBase64(outcome.url);
      logger.info(`[wavespeed/magazine-render] Success. base64 length=${result.length}`);
      const retryToken = randomUUID();
      retryTokens.set(retryToken, Date.now() + 5 * 60_000);
      res.json({ imageBase64: result, retryToken });
    } else {
      logger.info(`[wavespeed/magazine-render] Job pending, returning jobId=${outcome.jobId}`);
      res.json({ jobId: outcome.jobId, status: "pending" });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[wavespeed/magazine-render] ERROR: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

router.post("/clean-terrain", async (req, res) => {
  try {
    const { imageBase64 } = req.body as { imageBase64?: string };
    if (!imageBase64) {
      res.status(400).json({ error: "imageBase64 is required" });
      return;
    }

    logger.info(`[wavespeed/clean-terrain] Request received. imageLen=${imageBase64.length}`);

    const job = await startJob("wavespeed-ai/flux-kontext-dev", {
      image: imageBase64,
      prompt:
        "TASK: Professional terrain clearance for landscape design. " +
        "ERASE AND REMOVE COMPLETELY every single object visible on the ground, no exceptions: " +
        "cardboard boxes, discarded boxes, abandoned boxes, trash bags, garbage, litter, waste, debris, " +
        "chairs, tables, sofas, benches, outdoor furniture, broken furniture, " +
        "flower pots, plant pots, ceramic pots, plastic containers, buckets, barrels, " +
        "toys, balls, bicycles, motorcycles, cars, vehicles, " +
        "construction materials, bricks, pipes, cables, hoses, wires, tarps, " +
        "tools, machinery, equipment, ladders, " +
        "bags, sacks, pallets, wooden planks, metal sheets, " +
        "umbrellas, parasols, awnings lying on ground, " +
        "ANY and ALL objects that do NOT belong to the permanent terrain structure. " +
        "After removing every object, fill ALL exposed soft ground (grass, weeds, vegetation, dirt patches, bare earth) " +
        "with clean flat neutral bare earth soil — natural dark brown earth texture, smooth flat soil, " +
        "seamlessly blended with surrounding ground, same perspective and lighting. " +
        "PRESERVE UNCHANGED: swimming pools, water features, built-in concrete floors, tile floors, marble floors, " +
        "stone paving, decorative gravel beds, built walls, brick walls, fences, gates, " +
        "steps, stairs, retaining walls, pergolas, built-in planters, fixed structural elements. " +
        "Keep EXACT same camera angle, perspective, vanishing point, lighting direction, and shadow patterns. " +
        "Result: completely empty clean terrain with bare soil — zero objects, zero clutter, zero vegetation. " +
        "Photorealistic professional DSLR photograph, natural Mexican outdoor daylight.",
      negative_prompt:
        "boxes, cardboard boxes, trash, garbage, litter, clutter, debris, junk, waste, " +
        "furniture, chairs, tables, pots, toys, cars, vehicles, hoses, cables, wires, pipes, " +
        "construction materials, bags, sacks, tools, equipment, machinery, " +
        "grass, green grass, lawn, weeds, bushes, shrubs, plants, vegetation, " +
        "missing pool, removed pool, removed concrete, removed paving, removed walls, " +
        "cartoon, illustration, CGI, painting, digital art, blur, oversaturated, " +
        "text, watermark, changed perspective, distorted proportions, wrong angle",
      num_images: 1,
      num_inference_steps: 35,
      guidance_scale: 6.0,
      seed: 5544332,
    });

    logger.info(`[wavespeed/clean-terrain] Job started. id=${job.id} status=${job.status}`);
    const outcome = await quickPollOrJobId(job);
    if (outcome.done) {
      const result = await urlToBase64(outcome.url);
      logger.info(`[wavespeed/clean-terrain] Success. base64 length=${result.length}`);
      res.json({ imageBase64: result });
    } else {
      logger.info(`[wavespeed/clean-terrain] Job pending, returning jobId=${outcome.jobId}`);
      res.json({ jobId: outcome.jobId, status: "pending" });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[wavespeed/clean-terrain] ERROR: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

export default router;
