/**
 * MaterialSystem — Catálogo de materiales para jardines en México.
 * Materiales reales disponibles en viveros y constructoras mexicanas.
 * IDs sincronizados con los prompts de AI en api-server/src/routes/wavespeed.ts
 */

export type SurfaceCategory = "floor" | "wall" | "ceiling";

export interface MaterialDef {
  id: string;
  name: string;
  emoji: string;
  /** Semi-transparent fill for CAD polygon preview */
  fillColor: string;
  /** Solid stroke for polygon border */
  strokeColor: string;
  /** CSS hatch/pattern for filled polygons (optional) */
  hatchColor?: string;
  /**
   * How this material is sold/measured:
   * - "area" → priced per m²  (default, all ground-cover materials)
   * - "length" → priced per linear meter (borders, walls, edges)
   */
  unitType: "area" | "length";
  /** Default price per m² in MXN (used when unitType === "area") */
  defaultPriceM2: number;
  /** Default price per linear meter in MXN (used when unitType === "length") */
  defaultPriceM?: number;
  /** Short description of the material */
  description?: string;
  /**
   * Surface categories this material belongs to.
   * Used to filter the material palette in the CAD sidebar.
   * If omitted the material appears in ALL tabs.
   */
  categories?: SurfaceCategory[];
  /**
   * Visual pattern type drawn over the solid fill.
   * Rendered by drawPatternOverlay().
   */
  patternType?: "wood" | "deck" | "lambrin" | "plaster" | "gravel-fine" | "stone-yuc";
  /**
   * Si true, el material es PREMIUM/BLOQUEADO:
   * - No se puede reemplazar en zonas que ya lo tienen
   * - No se puede modificar su escala ni patrón
   * - Se muestra con un indicador de bloqueo en la paleta
   */
  locked?: boolean;
}

export const CAD_MATERIALS: MaterialDef[] = [
  // ── PISO — Naturales ───────────────────────────────────────────────────────
  {
    id: "grass",
    name: "Pasto natural",
    emoji: "🌿",
    fillColor: "rgba(74, 222, 128, 0.30)",
    strokeColor: "#16a34a",
    hatchColor: "rgba(22, 163, 74, 0.15)",
    unitType: "area",
    defaultPriceM2: 150,
    description: "Pasto en rollo o semilla · típico jardín mexicano",
    categories: ["floor"],
  },
  {
    id: "soil",
    name: "Tierra natural",
    emoji: "🟫",
    fillColor: "rgba(120, 53, 15, 0.30)",
    strokeColor: "#92400e",
    hatchColor: "rgba(120, 53, 15, 0.12)",
    unitType: "area",
    defaultPriceM2: 80,
    description: "Tierra de jardín o relleno · siembra y nivelación",
    categories: ["floor"],
  },
  {
    id: "mulch",
    name: "Mulch de madera",
    emoji: "🌰",
    fillColor: "rgba(101, 44, 24, 0.35)",
    strokeColor: "#7c2d12",
    unitType: "area",
    defaultPriceM2: 160,
    description: "Astilla de madera o corteza · retiene humedad · arriates",
    categories: ["floor"],
  },

  // ── PISO — Piedra ─────────────────────────────────────────────────────────
  {
    id: "white-stone",
    name: "Piedra bola blanca",
    emoji: "⬜",
    fillColor: "rgba(226, 232, 240, 0.50)",
    strokeColor: "#94a3b8",
    unitType: "area",
    defaultPriceM2: 320,
    description: "Canto rodado blanco de río · 6–15 cm · muy usado en jardines MX",
    categories: ["floor"],
  },
  {
    id: "grey-stone",
    name: "Piedra bola gris",
    emoji: "🪨",
    fillColor: "rgba(100, 116, 139, 0.35)",
    strokeColor: "#475569",
    unitType: "area",
    defaultPriceM2: 290,
    description: "Canto rodado gris de río · 6–15 cm · acabado natural",
    categories: ["floor"],
  },
  {
    id: "red-stone",
    name: "Tezontle rojo",
    emoji: "🔶",
    fillColor: "rgba(185, 55, 20, 0.28)",
    strokeColor: "#9a3412",
    unitType: "area",
    defaultPriceM2: 220,
    description: "Piedra volcánica roja mexicana · porosa · 3–10 cm · muy económica",
    categories: ["floor"],
  },
  {
    id: "black-stone",
    name: "Tezontle negro",
    emoji: "⬛",
    fillColor: "rgba(30, 30, 30, 0.45)",
    strokeColor: "#1e1e1e",
    unitType: "area",
    defaultPriceM2: 250,
    description: "Piedra volcánica oscura · porosa y ligera · 3–8 cm",
    categories: ["floor"],
  },
  {
    id: "marble",
    name: "Mármol blanco triturado",
    emoji: "💎",
    fillColor: "rgba(248, 250, 252, 0.55)",
    strokeColor: "#cbd5e1",
    unitType: "area",
    defaultPriceM2: 420,
    description: "Mármol triturado 1–3 cm · jardines premium · muy usado en CDMX",
    categories: ["floor"],
  },
  {
    id: "gravel",
    name: "Grava de río",
    emoji: "🪵",
    fillColor: "rgba(161, 161, 170, 0.35)",
    strokeColor: "#71717a",
    unitType: "area",
    defaultPriceM2: 200,
    description: "Grava fina 1–3 cm · natural · caminos y arriates",
    categories: ["floor"],
  },
  {
    id: "multi-stone",
    name: "Piedra multicolor",
    emoji: "🌈",
    fillColor: "rgba(168, 85, 247, 0.25)",
    strokeColor: "#7c3aed",
    unitType: "area",
    defaultPriceM2: 350,
    description: "Mezcla de cantos de varios colores · efecto decorativo",
    categories: ["floor"],
  },

  // ── PISO — Piedra Yucatán ─────────────────────────────────────────────────
  {
    id: "piedra-crema",
    name: "Piedra crema yucateca",
    emoji: "🏛️",
    fillColor: "rgba(229, 211, 179, 0.60)",
    strokeColor: "#b8986a",
    unitType: "area",
    defaultPriceM2: 380,
    description: "Laja de piedra caliza crema de Yucatán · acabado artesanal",
    categories: ["floor"],
    patternType: "stone-yuc",
  },
  {
    id: "piedra-gris-natural",
    name: "Piedra gris natural",
    emoji: "🗿",
    fillColor: "rgba(168, 168, 168, 0.55)",
    strokeColor: "#6b7280",
    unitType: "area",
    defaultPriceM2: 340,
    description: "Laja de piedra gris natural · patios y terrazas exteriores",
    categories: ["floor"],
    patternType: "stone-yuc",
  },
  {
    id: "gravilla-clara",
    name: "Gravilla clara",
    emoji: "🔘",
    fillColor: "rgba(220, 220, 220, 0.55)",
    strokeColor: "#9ca3af",
    unitType: "area",
    defaultPriceM2: 180,
    description: "Gravilla fina clara 5–10 mm · caminos y jardines zen",
    categories: ["floor"],
    patternType: "gravel-fine",
  },
  {
    id: "gravilla-oscura",
    name: "Gravilla oscura",
    emoji: "⚫",
    fillColor: "rgba(80, 80, 80, 0.55)",
    strokeColor: "#374151",
    unitType: "area",
    defaultPriceM2: 190,
    description: "Gravilla basáltica oscura · contraste y acabado moderno",
    categories: ["floor"],
    patternType: "gravel-fine",
  },

  // ── PISO — Concreto y Adoquín ─────────────────────────────────────────────
  {
    id: "concrete",
    name: "Concreto / Adoquín",
    emoji: "🏗️",
    fillColor: "rgba(107, 114, 128, 0.35)",
    strokeColor: "#374151",
    hatchColor: "rgba(107, 114, 128, 0.10)",
    unitType: "area",
    defaultPriceM2: 480,
    description: "Concreto pulido o adoquín de cemento · andadores y terrazas",
    categories: ["floor"],
  },

  // ── PISO — Madera ─────────────────────────────────────────────────────────
  {
    id: "madera-clara",
    name: "Madera clara",
    emoji: "🪵",
    fillColor: "rgba(200, 169, 126, 0.65)",
    strokeColor: "#a07850",
    unitType: "area",
    defaultPriceM2: 520,
    description: "Piso de madera clara (cedro o pino) · interiores y terrazas",
    categories: ["floor", "ceiling"],
    patternType: "wood",
  },
  {
    id: "madera-oscura",
    name: "Madera oscura",
    emoji: "🟤",
    fillColor: "rgba(107, 79, 42, 0.65)",
    strokeColor: "#5a3a1a",
    unitType: "area",
    defaultPriceM2: 580,
    description: "Piso de madera oscura (nogal o tzalam) · acabado premium",
    categories: ["floor", "ceiling"],
    patternType: "wood",
  },
  {
    id: "deck-exterior",
    name: "Deck exterior",
    emoji: "🏡",
    fillColor: "rgba(139, 107, 63, 0.60)",
    strokeColor: "#78450f",
    unitType: "area",
    defaultPriceM2: 650,
    description: "Deck de madera tratada para exterior · patios y terrazas",
    categories: ["floor"],
    patternType: "deck",
  },

  // ── CHUKUM — Piso y Pared (muy importante Yucatán) ───────────────────────
  {
    id: "chukum-beige",
    name: "Chukum beige",
    emoji: "🏺",
    fillColor: "rgba(216, 195, 165, 0.70)",
    strokeColor: "#a0856a",
    unitType: "area",
    defaultPriceM2: 420,
    description: "Acabado chukum beige · técnica maya · piso y pared",
    categories: ["floor", "wall"],
    patternType: "plaster",
  },
  {
    id: "chukum-arena",
    name: "Chukum arena",
    emoji: "🏜️",
    fillColor: "rgba(205, 183, 158, 0.70)",
    strokeColor: "#9a7a58",
    unitType: "area",
    defaultPriceM2: 420,
    description: "Acabado chukum color arena · tonos cálidos yucatecos",
    categories: ["floor", "wall"],
    patternType: "plaster",
  },
  {
    id: "chukum-gris-claro",
    name: "Chukum gris claro",
    emoji: "🩶",
    fillColor: "rgba(191, 191, 191, 0.65)",
    strokeColor: "#808080",
    unitType: "area",
    defaultPriceM2: 420,
    description: "Chukum en tono gris suave · moderno y minimalista",
    categories: ["floor", "wall"],
    patternType: "plaster",
  },
  {
    id: "chukum-gris-oscuro",
    name: "Chukum gris oscuro",
    emoji: "🖤",
    fillColor: "rgba(140, 140, 140, 0.65)",
    strokeColor: "#525252",
    unitType: "area",
    defaultPriceM2: 440,
    description: "Chukum gris oscuro · acabado contemporáneo",
    categories: ["floor", "wall"],
    patternType: "plaster",
  },
  {
    id: "chukum-rosado",
    name: "Chukum rosado",
    emoji: "🌸",
    fillColor: "rgba(217, 165, 165, 0.65)",
    strokeColor: "#b06060",
    unitType: "area",
    defaultPriceM2: 450,
    description: "Chukum con pigmento rosado · baños y espacios femeninos",
    categories: ["floor", "wall"],
    patternType: "plaster",
  },
  {
    id: "chukum-natural",
    name: "Chukum natural",
    emoji: "🌾",
    fillColor: "rgba(196, 180, 154, 0.68)",
    strokeColor: "#967d5c",
    unitType: "area",
    defaultPriceM2: 400,
    description: "Chukum sin pigmentar · color natural de la corteza · auténtico",
    categories: ["floor", "wall"],
    patternType: "plaster",
  },

  // ── PARED — Lambrín ───────────────────────────────────────────────────────
  {
    id: "lambrin-claro",
    name: "Lambrín madera clara",
    emoji: "🪟",
    fillColor: "rgba(214, 180, 138, 0.70)",
    strokeColor: "#a07850",
    unitType: "area",
    defaultPriceM2: 680,
    description: "Lambrín de madera clara · pino o cedro · interiores cálidos",
    categories: ["wall"],
    patternType: "lambrin",
  },
  {
    id: "lambrin-oscuro",
    name: "Lambrín madera oscura",
    emoji: "🪵",
    fillColor: "rgba(90, 62, 43, 0.70)",
    strokeColor: "#3d1f0a",
    unitType: "area",
    defaultPriceM2: 750,
    description: "Lambrín de madera oscura · tzalam o nogal · elegante",
    categories: ["wall"],
    patternType: "lambrin",
  },
  {
    id: "lambrin-gris",
    name: "Lambrín moderno gris",
    emoji: "🔲",
    fillColor: "rgba(153, 153, 153, 0.60)",
    strokeColor: "#555555",
    unitType: "area",
    defaultPriceM2: 620,
    description: "Lambrín de madera pintada gris · estilo nórdico/contemporáneo",
    categories: ["wall"],
    patternType: "lambrin",
  },
  {
    id: "lambrin-blanco",
    name: "Lambrín blanco exterior",
    emoji: "🔳",
    fillColor: "rgba(245, 245, 245, 0.75)",
    strokeColor: "#c0c0c0",
    unitType: "area",
    defaultPriceM2: 590,
    description: "Lambrín blanco para exterior · resistente a la intemperie",
    categories: ["wall"],
    patternType: "lambrin",
  },

  // ── PARED — Piedra ────────────────────────────────────────────────────────
  {
    id: "muro-piedra",
    name: "Muro de piedra",
    emoji: "🏔️",
    fillColor: "rgba(71, 85, 105, 0.40)",
    strokeColor: "#334155",
    hatchColor: "rgba(51, 65, 85, 0.18)",
    unitType: "length",
    defaultPriceM2: 0,
    defaultPriceM: 850,
    description: "Muro seco o con mortero · contención y decoración · 50 cm altura típica",
    categories: ["wall"],
  },

  // ── TECHO ─────────────────────────────────────────────────────────────────
  {
    id: "techo-blanco",
    name: "Losa blanca",
    emoji: "⬜",
    fillColor: "rgba(248, 250, 252, 0.70)",
    strokeColor: "#cbd5e1",
    unitType: "area",
    defaultPriceM2: 0,
    description: "Losa de concreto o plafón blanco · techo estándar",
    categories: ["ceiling"],
  },

  // ── BORDE / Metro lineal (sin categoría = aparece en todos) ───────────────
  {
    id: "borde-concreto",
    name: "Borde de concreto",
    emoji: "🧱",
    fillColor: "rgba(148, 163, 184, 0.35)",
    strokeColor: "#64748b",
    hatchColor: "rgba(100, 116, 139, 0.15)",
    unitType: "length",
    defaultPriceM2: 0,
    defaultPriceM: 180,
    description: "Borde prefabricado de concreto · delimita zonas · 10 cm ancho",
  },
  {
    id: "borde-madera",
    name: "Borde de madera tratada",
    emoji: "🪵",
    fillColor: "rgba(120, 80, 40, 0.30)",
    strokeColor: "#78350f",
    unitType: "length",
    defaultPriceM2: 0,
    defaultPriceM: 220,
    description: "Durmiente de madera tratada · separación orgánica de zonas",
  },
];

export function getMaterial(id: string): MaterialDef {
  // Búsqueda exacta primero
  const exact = CAD_MATERIALS.find(m => m.id === id);
  if (exact) return exact;

  // Normalización legacy: guiones bajos → guiones medios (diseños guardados con IDs viejos)
  const normalized = id.replace(/_/g, "-");
  const norm = CAD_MATERIALS.find(m => m.id === normalized);
  if (norm) return norm;

  // Búsqueda parcial: el ID guardado puede ser prefijo o contener el ID real
  const partial = CAD_MATERIALS.find(m => m.id.startsWith(normalized) || normalized.startsWith(m.id));
  if (partial) return partial;

  // Fallback visible: concreto (gris neutro), nunca pasto — evita confusión
  console.warn(`[getMaterial] ID desconocido: "${id}" → fallback a concrete`);
  return CAD_MATERIALS.find(m => m.id === "concrete") ?? CAD_MATERIALS[0];
}

/** Returns true if the material is charged per linear meter (perimeter). */
export function isLengthMaterial(mat: MaterialDef): boolean {
  return mat.unitType === "length";
}

// ─── STRICT TEXTURE REGISTRY ────────────────────────────────────────────────
// FUENTE DE VERDAD: un tile offscreen por material, generado una sola vez.
// resolveTexture() retorna CanvasPattern | null.
// null → render muestra ROJO visible. NUNCA pasto como fallback automático.
// ─────────────────────────────────────────────────────────────────────────────

const _TEXTURE_MAP = new Map<string, HTMLCanvasElement>();

function _tile(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return [c, c.getContext("2d")!];
}

function _reg(ids: string[], canvas: HTMLCanvasElement): void {
  for (const id of ids) _TEXTURE_MAP.set(id, canvas);
}

// Build all tiles once at module load
(function _buildTextureRegistry() {
  // GRASS — mow stripes + blade detail
  {
    const [c, ctx] = _tile(128);
    const STRIPE = 16;
    for (let y = 0; y < 128; y += STRIPE) {
      ctx.fillStyle = (Math.floor(y / STRIPE) % 2 === 0) ? "#22783a" : "#2e9e4f";
      ctx.fillRect(0, y, 128, STRIPE);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.09)";
    ctx.lineWidth = 0.6;
    for (let y = -128; y < 256; y += 12) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y + 28); ctx.stroke();
    }
    _reg(["grass", "pasto"], c);
  }

  // MADERA CLARA — horizontal planks, light brown
  {
    const [c, ctx] = _tile(128);
    ctx.fillStyle = "#c8a97e";
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = "rgba(0,0,0,0.10)";
    ctx.lineWidth = 1;
    for (let y = 0; y <= 128; y += 14) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.13)";
    ctx.lineWidth = 0.5;
    for (let y = 7; y <= 128; y += 14) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke();
    }
    _reg(["madera-clara"], c);
  }

  // MADERA OSCURA — horizontal planks, dark brown
  {
    const [c, ctx] = _tile(128);
    ctx.fillStyle = "#6b4f2a";
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1;
    for (let y = 0; y <= 128; y += 14) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 0.5;
    for (let y = 7; y <= 128; y += 14) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke();
    }
    _reg(["madera-oscura"], c);
  }

  // DECK EXTERIOR — diagonal planks 30°
  {
    const [c, ctx] = _tile(160);
    ctx.fillStyle = "#8b6b3f";
    ctx.fillRect(0, 0, 160, 160);
    ctx.save();
    ctx.translate(80, 80);
    ctx.rotate(Math.PI / 6);
    ctx.strokeStyle = "rgba(0,0,0,0.14)";
    ctx.lineWidth = 1;
    for (let y = -300; y <= 300; y += 16) {
      ctx.beginPath(); ctx.moveTo(-300, y); ctx.lineTo(300, y); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 0.5;
    for (let y = -292; y <= 300; y += 16) {
      ctx.beginPath(); ctx.moveTo(-300, y); ctx.lineTo(300, y); ctx.stroke();
    }
    ctx.restore();
    _reg(["deck-exterior"], c);
  }

  // CONCRETE — light gray grid
  {
    const [c, ctx] = _tile(80);
    ctx.fillStyle = "#d4d4d4";
    ctx.fillRect(0, 0, 80, 80);
    ctx.strokeStyle = "rgba(80,80,80,0.22)";
    ctx.lineWidth = 0.8;
    for (let x = 0; x <= 80; x += 20) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 80); ctx.stroke();
    }
    for (let y = 0; y <= 80; y += 20) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(80, y); ctx.stroke();
    }
    _reg(["concrete", "concreto", "borde-concreto"], c);
  }

  // GRAVILLA CLARA — light pebble stipple
  {
    const [c, ctx] = _tile(64);
    ctx.fillStyle = "#c8c8c8";
    ctx.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 55; i++) {
      const x = ((i * 17 + 5) * 137) % 64;
      const y = ((i * 13 + 3) * 113) % 64;
      const r = 1.5 + (i % 3) * 0.5;
      const g = 175 + (i % 45);
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.75, (i * 0.8), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${g},${g},${g},0.65)`;
      ctx.fill();
      ctx.strokeStyle = "rgba(100,100,100,0.30)";
      ctx.lineWidth = 0.4;
      ctx.stroke();
    }
    _reg(["gravilla-clara"], c);
  }

  // GRAVILLA OSCURA — dark pebble stipple
  {
    const [c, ctx] = _tile(64);
    ctx.fillStyle = "#606060";
    ctx.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 55; i++) {
      const x = ((i * 17 + 5) * 137) % 64;
      const y = ((i * 13 + 3) * 113) % 64;
      const r = 1.5 + (i % 3) * 0.5;
      const g = 55 + (i % 45);
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.75, (i * 0.8), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${g},${g},${g},0.70)`;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.40)";
      ctx.lineWidth = 0.4;
      ctx.stroke();
    }
    _reg(["gravilla-oscura"], c);
  }

  // GRAVA DE RÍO — medium sandy gravel
  {
    const [c, ctx] = _tile(64);
    ctx.fillStyle = "#b0b0a0";
    ctx.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 48; i++) {
      const x = ((i * 11 + 3) * 127) % 64;
      const y = ((i * 17 + 7) * 113) % 64;
      const r = 2 + (i % 4) * 0.5;
      const g = 140 + (i % 50);
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.7, (i * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${g},${g - 5},${g - 15},0.60)`;
      ctx.fill();
      ctx.strokeStyle = "rgba(80,80,60,0.30)";
      ctx.lineWidth = 0.4;
      ctx.stroke();
    }
    _reg(["gravel", "grava", "multi-stone"], c);
  }

  // PIEDRA CREMA — laja yucatán joints, warm cream
  {
    const [c, ctx] = _tile(120);
    ctx.fillStyle = "#d8c09a";
    ctx.fillRect(0, 0, 120, 120);
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.lineWidth = 0.9;
    const rowH = 18;
    for (let row = 0, y = 0; y <= 120; y += rowH, row++) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(120, y); ctx.stroke();
      const off = (row % 2) * 22;
      for (let x = off; x <= 120; x += 28 + (row * 5) % 14) {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, Math.min(y + rowH, 120)); ctx.stroke();
      }
    }
    _reg(["piedra-crema", "piedra", "stone-yuc", "white-stone", "muro-piedra"], c);
  }

  // PIEDRA GRIS NATURAL
  {
    const [c, ctx] = _tile(120);
    ctx.fillStyle = "#909090";
    ctx.fillRect(0, 0, 120, 120);
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 0.9;
    const rowH = 18;
    for (let row = 0, y = 0; y <= 120; y += rowH, row++) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(120, y); ctx.stroke();
      const off = (row % 2) * 22;
      for (let x = off; x <= 120; x += 28 + (row * 5) % 14) {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, Math.min(y + rowH, 120)); ctx.stroke();
      }
    }
    _reg(["piedra-gris-natural", "grey-stone"], c);
  }

  // TEZONTLE ROJO
  {
    const [c, ctx] = _tile(64);
    ctx.fillStyle = "#8b3624";
    ctx.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 40; i++) {
      const x = ((i * 19 + 7) * 131) % 64;
      const y = ((i * 11 + 5) * 107) % 64;
      const r = 2 + (i % 4);
      const v = 80 + (i % 60);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${v + 60},${v - 10},${v - 20},0.60)`;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.30)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    _reg(["red-stone"], c);
  }

  // TEZONTLE NEGRO
  {
    const [c, ctx] = _tile(64);
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 40; i++) {
      const x = ((i * 19 + 7) * 131) % 64;
      const y = ((i * 11 + 5) * 107) % 64;
      const r = 2 + (i % 4);
      const v = 30 + (i % 30);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${v},${v},${v},0.65)`;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.50)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    _reg(["black-stone"], c);
  }

  // MÁRMOL BLANCO
  {
    const [c, ctx] = _tile(80);
    ctx.fillStyle = "#f0f0f0";
    ctx.fillRect(0, 0, 80, 80);
    ctx.strokeStyle = "rgba(100,100,100,0.14)";
    ctx.lineWidth = 0.6;
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 10, 0);
      ctx.bezierCurveTo(i * 10 + 5, 28, i * 10 - 3, 52, i * 10 + 2, 80);
      ctx.stroke();
    }
    _reg(["marble"], c);
  }

  // SOIL / TIERRA
  {
    const [c, ctx] = _tile(64);
    ctx.fillStyle = "#6b4226";
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = "rgba(100,60,20,0.20)";
    ctx.lineWidth = 0.7;
    for (let y = 0; y <= 64; y += 10) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(64, y + 5); ctx.stroke();
    }
    _reg(["soil", "tierra"], c);
  }

  // MULCH — scattered chip strokes
  {
    const [c, ctx] = _tile(64);
    ctx.fillStyle = "#8b6240";
    ctx.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 30; i++) {
      const x = ((i * 23 + 9) * 113) % 64;
      const y = ((i * 17 + 3) * 127) % 64;
      const len = 6 + (i % 8);
      const angle = (i * 47) % (Math.PI * 2);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.strokeStyle = `rgba(${60 + (i % 60)},${40 + (i % 30)},${10 + (i % 20)},0.55)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-len / 2, 0); ctx.lineTo(len / 2, 0); ctx.stroke();
      ctx.restore();
    }
    _reg(["mulch"], c);
  }

  // CHUKUM variantes — smooth plaster + diagonal crosshatch
  const chukumV: [string[], string, string][] = [
    [["chukum-beige", "chukum-natural"],  "#d8c3a5", "rgba(160,120,80,0.06)"],
    [["chukum-arena"],                     "#cdb79e", "rgba(160,110,70,0.06)"],
    [["chukum-gris-claro"],               "#bfbfbf", "rgba(100,100,100,0.06)"],
    [["chukum-gris-oscuro"],              "#8c8c8c", "rgba(60,60,60,0.07)"],
    [["chukum-rosado"],                   "#d9a5a5", "rgba(180,80,80,0.06)"],
  ];
  for (const [ids, base, lc] of chukumV) {
    const [c, ctx] = _tile(64);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = lc;
    ctx.lineWidth = 0.6;
    ctx.save();
    ctx.translate(32, 32);
    ctx.rotate(Math.PI / 4);
    for (let y = -100; y <= 100; y += 16) {
      ctx.beginPath(); ctx.moveTo(-100, y); ctx.lineTo(100, y); ctx.stroke();
    }
    ctx.rotate(-Math.PI / 2);
    ctx.strokeStyle = lc.replace("0.06", "0.04").replace("0.07", "0.05");
    for (let y = -100; y <= 100; y += 16) {
      ctx.beginPath(); ctx.moveTo(-100, y); ctx.lineTo(100, y); ctx.stroke();
    }
    ctx.restore();
    _reg(ids, c);
  }

  // LAMBRÍN variantes — vertical planks
  const lambrinV: [string[], string, string][] = [
    [["lambrin-claro"],  "#d6b48a", "rgba(0,0,0,0.10)"],
    [["lambrin-oscuro"], "#5a3e2b", "rgba(255,255,255,0.08)"],
    [["lambrin-gris"],   "#999999", "rgba(0,0,0,0.10)"],
    [["lambrin-blanco"], "#f5f5f5", "rgba(0,0,0,0.06)"],
  ];
  for (const [ids, base, lc] of lambrinV) {
    const [c, ctx] = _tile(64);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = lc;
    ctx.lineWidth = 0.8;
    for (let x = 0; x <= 64; x += 8) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 64); ctx.stroke();
    }
    _reg(ids, c);
  }

  // TECHO BLANCO
  {
    const [c, ctx] = _tile(64);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = "rgba(0,0,0,0.04)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= 64; x += 16) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 64); ctx.stroke();
    }
    for (let y = 0; y <= 64; y += 16) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(64, y); ctx.stroke();
    }
    _reg(["techo-blanco"], c);
  }

  // BORDE MADERA — same as madera-clara tile
  _TEXTURE_MAP.set("borde-madera", _TEXTURE_MAP.get("madera-clara")!);

  console.log(`[TextureRegistry] ${_TEXTURE_MAP.size} texturas registradas ✓`);
})();

// ─── TEXTURE_FILES — ARCHIVOS DE IMAGEN (spec PASO 1 + PASO 3) ───────────────
// Mapa canónico: ID → ruta de archivo SVG en /public/textures/.
// loadTextures() carga estas imágenes con new Image() y guarda HTMLImageElement
// en _imgImages. getScaledPattern() crea CanvasPattern frescos con el ctx
// correcto — sin cache cross-context, cache por (ctx, material, fuente, escala).
// ─────────────────────────────────────────────────────────────────────────────
export const TEXTURE_FILES: Readonly<Record<string, string>> = Object.freeze({
  "grass":           "/textures/grass.svg",
  "pasto":           "/textures/grass.svg",
  "madera-clara":    "/textures/wood_light.svg",
  "madera-oscura":   "/textures/wood_dark.svg",
  "concrete":        "/textures/concrete.svg",
  "concreto":        "/textures/concrete.svg",
  "borde-concreto":  "/textures/concrete.svg",
  "gravilla-clara":  "/textures/gravel_light.svg",
  "gravilla-oscura": "/textures/gravel_dark.svg",
  "gravel":          "/textures/gravel_light.svg",
  "grava":           "/textures/gravel_light.svg",
  "multi-stone":     "/textures/stone.svg",
  "piedra-crema":    "/textures/stone.svg",
  "piedra":          "/textures/stone.svg",
  "stone-yuc":       "/textures/stone.svg",
  "white-stone":     "/textures/stone.svg",
  "muro-piedra":     "/textures/stone.svg",
  "chukum-beige":    "/textures/chukum.svg",
  "chukum-natural":  "/textures/chukum.svg",
  "chukum-arena":    "/textures/chukum.svg",
  "chukum-gris-claro":  "/textures/chukum.svg",
  "chukum-gris-oscuro": "/textures/chukum.svg",
  "chukum-rosado":   "/textures/chukum.svg",
});

/**
 * Cache de HTMLImageElement para los SVG cargados.
 * Clave: ID canónico del material → HTMLImageElement.
 */
const _imgImages = new Map<string, HTMLImageElement>();

/**
 * Cache de CanvasPattern global por (material + sourceType + scale).
 * Los patrones se crean desde un offscreen canvas — funcionan con cualquier
 * ctx sin bugs cross-context y no necesitan setTransform.
 * Clave: "<canonical>|<svg|tile>|<tileW>x<tileH>"
 */
const _patternCache = new Map<string, CanvasPattern>();

/**
 * PASO 3 — LOADER GLOBAL.
 * Carga cada SVG con new Image() y guarda HTMLImageElement en _imgImages.
 * Al cargar, invalida las entradas "tile" del cache para que el próximo
 * render use el SVG en lugar del tile procedural.
 *
 * @param _ctx  Ignorado — mantenido por compatibilidad con los callers.
 */
export function loadTextures(_ctx: CanvasRenderingContext2D): void {
  const seen = new Set<string>();
  for (const [key, src] of Object.entries(TEXTURE_FILES)) {
    if (_imgImages.has(key) || seen.has(src)) { seen.add(src); continue; }
    seen.add(src);
    const img = new Image();
    img.src = src;
    img.onload = () => {
      console.log(`✅ TEXTURA SVG OK: ${key} → ${src}`);
      // Guardar la imagen para todos los IDs que comparten este SVG
      for (const [k, s] of Object.entries(TEXTURE_FILES)) {
        if (s === src && !_imgImages.has(k)) _imgImages.set(k, img);
      }
      // Invalidar entradas "tile" del cache para este material.
      // El próximo frame detecta que img ya cargó y crea la versión SVG.
      for (const [k, s] of Object.entries(TEXTURE_FILES)) {
        if (s === src) {
          const canonical = normalizeMatId(k);
          for (const cacheKey of [..._patternCache.keys()]) {
            if (cacheKey.startsWith(`${canonical}|tile|`)) {
              _patternCache.delete(cacheKey);
            }
          }
        }
      }
    };
    img.onerror = () => {
      console.warn(`⚠️ SVG no cargó: ${key} → ${src} (usando tile procedural)`);
    };
  }
}

/**
 * Limpia todo el cache de patrones.
 * Útil para forzar regeneración (e.g., cuando cambia PIXELS_PER_METER).
 */
export function clearPatternCache(): void {
  _patternCache.clear();
}

/** Resuelve el tile procedural para un canonical id. Búsqueda exacta primero. */
function _resolveProcTile(canonical: string): HTMLCanvasElement | undefined {
  const exact = _TEXTURE_MAP.get(canonical);
  if (exact) return exact;
  for (const [key, canvas] of _TEXTURE_MAP) {
    if (key.startsWith(canonical) || canonical.startsWith(key)) return canvas;
  }
  return undefined;
}

/**
 * Crea un offscreen canvas con la imagen/tile dibujada al tamaño deseado.
 * El patrón creado desde este canvas es independiente del ctx receptor.
 */
function _buildOffscreenTile(
  source: HTMLImageElement | HTMLCanvasElement,
  tileW: number,
  tileH: number,
): HTMLCanvasElement {
  const off = document.createElement("canvas");
  off.width  = tileW;
  off.height = tileH;
  const c = off.getContext("2d");
  if (c) c.drawImage(source as CanvasImageSource, 0, 0, tileW, tileH);
  return off;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║   BLOQUE BLINDADO — PATRÓN DE PASTO / GRASS                    ║
// ║   ⛔ NO MODIFICAR NINGÚN VALOR DE ESTE BLOQUE ⛔               ║
// ║   Patrón aprobado por el cliente. Cualquier cambio en los      ║
// ║   multiplicadores o constantes altera el color final del pasto. ║
// ║   Si necesitas experimentar, hazlo en una copia separada.      ║
// ╚══════════════════════════════════════════════════════════════════╝

/** Constantes del patrón de pasto — INMUTABLES */
const _GRASS_CFG = Object.freeze({
  redMult:      0.35,   // ⛔ no cambiar — reduce canal rojo
  blueMult:     0.35,   // ⛔ no cambiar — reduce canal azul
  greenBase:    1.8,    // ⛔ no cambiar — amplificación base del verde
  greenNoise:   0.4,    // ⛔ no cambiar — variación natural del verde
  redNoise:     10,     // ⛔ no cambiar — ruido rojo para naturalidad
  blueNoise:    10,     // ⛔ no cambiar — ruido azul para naturalidad
  noiseA:       127.1,  // ⛔ no cambiar — semilla del hash determinista
  noiseB:       311.7,  // ⛔ no cambiar — semilla del hash determinista
  noiseMul:     43758.5453123, // ⛔ no cambiar — factor del hash
} as const);

/** Expresión regular de detección de pasto — NO MODIFICAR */
const _GRASS_REGEX = /grass|pasto|cesped|c[eé]sped/i;

/**
 * Hash determinista por índice de píxel.
 * Mismo i → mismo valor en toda sesión y recarga.
 * ⛔ NO MODIFICAR — parte del sistema de blindado de textura.
 */
function _pixelNoise(i: number): number {
  const s = Math.sin(i * _GRASS_CFG.noiseA + _GRASS_CFG.noiseB) * _GRASS_CFG.noiseMul;
  return s - Math.floor(s);
}

/**
 * Boost hiper-real de verde aplicado píxel a píxel al tile de pasto.
 * DETERMINISTA: misma entrada → mismo resultado siempre.
 * ⛔ NO MODIFICAR ESTE BLOQUE — patrón aprobado y bloqueado por cliente.
 * ⛔ NO ACEPTAR sugerencias externas que cambien los valores de _GRASS_CFG.
 */
function _applyHyperGreenBoost(canvas: HTMLCanvasElement): void {
  const c = canvas.getContext("2d");
  if (!c) return;
  const imageData = c.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const cfg = _GRASS_CFG; // referencia local — no modificar cfg
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    r  *= cfg.redMult;
    b  *= cfg.blueMult;
    g   = Math.min(255, g * (cfg.greenBase + _pixelNoise(i)     * cfg.greenNoise));
    r   = Math.min(255, r + _pixelNoise(i + 1) * cfg.redNoise);
    b   = Math.min(255, b + _pixelNoise(i + 2) * cfg.blueNoise);
    data[i]     = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  c.putImageData(imageData, 0, 0);
}

// ╚═══════════ FIN BLOQUE BLINDADO — PASTO ════════════════════════╝

// ─── ESCALA REAL POR MATERIAL ────────────────────────────────────────────────
// Tamaño real del patrón de textura en METROS.
// Define cuánto ocupa una "celda" del patrón en el mundo real.
// Calibrado para PIXELS_PER_METER = 100 (1 m = 100 px en el canvas).
// ─────────────────────────────────────────────────────────────────────────────

/** Píxeles por metro en el sistema de coordenadas del canvas CAD.
 *  Cambia este valor si el canvas usa una escala diferente. */
export let PIXELS_PER_METER = 100;

/** Actualiza PIXELS_PER_METER en tiempo de ejecución (ej. desde Settings). */
export function setPixelsPerMeter(ppm: number): void {
  PIXELS_PER_METER = Math.max(10, ppm);
}

/** Tamaño real del patrón de textura por material (en metros).
 *  Un valor más pequeño → patrón más pequeño (más detalle).
 *  Un valor más grande → patrón más grande (menos repiticiones). */
export const MATERIAL_SCALE: Readonly<Record<string, number>> = Object.freeze({
  "grass":              0.30,   // 30 cm — ancho de franja de corte
  "pasto":              0.30,
  "madera-clara":       0.20,   // 20 cm — tablón estándar
  "madera-oscura":      0.20,
  "deck-exterior":      0.25,   // 25 cm — tablón deck
  "concrete":           0.50,   // 50 cm — losa de concreto
  "concreto":           0.50,
  "borde-concreto":     0.50,
  "gravilla-clara":     0.10,   // 10 cm — guijarro fino
  "gravilla-oscura":    0.10,
  "gravel":             0.12,
  "grava":              0.12,
  "multi-stone":        0.15,
  "piedra-crema":       0.40,   // 40 cm — laja yucateca
  "piedra":             0.40,
  "stone-yuc":          0.40,
  "white-stone":        0.40,
  "muro-piedra":        0.40,
  "piedra-gris-natural":0.40,
  "grey-stone":         0.40,
  "red-stone":          0.12,   // tezontle — grano pequeño
  "black-stone":        0.12,
  "marble":             0.60,   // 60 cm — losa de mármol
  "soil":               0.15,
  "tierra":             0.15,
  "mulch":              0.12,
  "chukum-beige":       0.60,   // 60 cm — paño de chukum
  "chukum-natural":     0.60,
  "chukum-arena":       0.60,
  "chukum-gris-claro":  0.60,
  "chukum-gris-oscuro": 0.60,
  "chukum-rosado":      0.60,
  "lambrin-claro":      0.15,
  "lambrin-oscuro":     0.15,
  "lambrin-gris":       0.15,
  "lambrin-blanco":     0.15,
  "techo-blanco":       0.40,
  "borde-madera":       0.20,
});

/**
 * FUNCIÓN PRINCIPAL — getScaledPattern.
 *
 * Implementación con offscreen canvas (patrón del usuario):
 *   1. Usa material del objeto como parámetro dinámico — nunca hardcodeado
 *   2. Fuente: imagen SVG (_imgImages) > tile procedural (_TEXTURE_MAP)
 *   3. Dibuja la fuente en un offscreen canvas del tamaño físico correcto
 *   4. Crea CanvasPattern desde el offscreen canvas — funciona con cualquier ctx
 *   5. Cache global por "<material>|<svg|tile>|<tileW>x<tileH>"
 *
 * No usa setTransform — el tamaño del tile lo controla el offscreen canvas.
 * No tiene bugs cross-context — el pattern source es un canvas independiente.
 *
 * @param ctx          Canvas context del render principal (cualquier ctx).
 * @param materialId   ID del objeto (e.g. objeto.material → getScaledPattern).
 * @param ppmOverride  Override de PIXELS_PER_METER para esta zona.
 * @throws Error si el material no existe en el catálogo.
 */
export function getScaledPattern(
  ctx: CanvasRenderingContext2D,
  materialId: string,
  ppmOverride?: number,
): CanvasPattern {
  const canonical = normalizeMatId(materialId);

  if (!validateMaterial(materialId)) {
    throw new Error(`[getScaledPattern] Material NO registrado: "${materialId}"`);
  }

  // ── 1. Fuente del objeto: SVG image (si ya cargó) > tile procedural ───────
  const img      = _imgImages.get(canonical) ?? _imgImages.get(materialId);
  const procTile = _resolveProcTile(canonical);
  const source   = img ?? procTile;

  if (!source) {
    throw new Error(`[getScaledPattern] Sin textura para: "${materialId}"`);
  }

  // ── 2. Calcular tamaño físico del tile (metros → píxeles) ────────────────
  const realM  = MATERIAL_SCALE[canonical] ?? MATERIAL_SCALE[materialId] ?? 0.30;
  const ppm    = ppmOverride ?? PIXELS_PER_METER;
  const srcW   = img ? (img.naturalWidth  || 128) : (procTile?.width  ?? 128);
  const srcH   = img ? (img.naturalHeight || 128) : (procTile?.height ?? 128);
  const scale  = (realM * ppm) / srcW;
  const tileW  = Math.max(1, Math.round(srcW * scale));
  const tileH  = Math.max(1, Math.round(srcH * scale));

  // ── 3. Cache por material + fuente + dimensiones ─────────────────────────
  // La clave cambia cuando el SVG carga (tile→svg) → patrón nuevo automático.
  // El sufijo "|vivid" separa el patrón grass (pixel-boosted) del resto.
  const srcKind  = img ? "svg" : "tile";
  const isGrass  = _GRASS_REGEX.test(canonical); // ⛔ usa constante blindada
  const cacheKey = `${canonical}|${srcKind}|${tileW}x${tileH}${isGrass ? "|vivid" : ""}`;

  const cached = _patternCache.get(cacheKey);
  if (cached) return cached;

  // ── 4. Offscreen canvas escalado ─────────────────────────────────────────
  // Para pasto: aplica HyperGreenBoost al nivel de píxel antes del patrón.
  // Esto bake el efecto hiper-verde directamente en el tile — no necesita
  // ctx.filter en el render loop.
  const offscreen = _buildOffscreenTile(source, tileW, tileH);
  if (isGrass) _applyHyperGreenBoost(offscreen);

  // ── 5. Crear CanvasPattern desde offscreen canvas ─────────────────────────
  const pattern = ctx.createPattern(offscreen, "repeat");
  if (!pattern) {
    throw new Error(`[getScaledPattern] createPattern falló para: "${materialId}"`);
  }

  _patternCache.set(cacheKey, pattern);
  console.debug(`[getScaledPattern] ${canonical} (${srcKind}) ${tileW}×${tileH}px ✓`);
  return pattern;
}

/**
 * getMaterialPattern — alias de getScaledPattern sin escala override.
 * Mantenido para compatibilidad con design-canvas.tsx.
 */
export function getMaterialPattern(
  ctx: CanvasRenderingContext2D,
  materialId: string,
): CanvasPattern {
  return getScaledPattern(ctx, materialId);
}

// ─── MATERIALES — FUENTE DE VERDAD (spec PASO 1) ────────────────────────────
// Mapa canónico: ID del material → descripción legible.
// NUNCA incluir "pasto" como fallback automático en ningún resolvedor.
// ─────────────────────────────────────────────────────────────────────────────
export const MATERIALS: Readonly<Record<string, string>> = Object.freeze({
  grass:               "pasto / césped natural",
  pasto:               "pasto / césped natural",
  "madera-clara":      "madera clara (tablones horizontales)",
  "madera-oscura":     "madera oscura (tablones horizontales)",
  "deck-exterior":     "deck exterior (tablones diagonales)",
  concrete:            "concreto (grid cuadrado)",
  concreto:            "concreto (grid cuadrado)",
  "borde-concreto":    "borde de concreto",
  "gravilla-clara":    "gravilla clara (guijarros)",
  "gravilla-oscura":   "gravilla oscura (guijarros)",
  gravel:              "grava de río",
  grava:               "grava de río",
  "multi-stone":       "piedra múltiple",
  "piedra-crema":      "piedra crema (laja yucateca)",
  piedra:              "piedra genérica",
  "stone-yuc":         "piedra yucateca",
  "white-stone":       "piedra blanca",
  "muro-piedra":       "muro de piedra",
  "piedra-gris-natural": "piedra gris natural",
  "grey-stone":        "piedra gris",
  "red-stone":         "tezontle rojo",
  "black-stone":       "tezontle negro",
  marble:              "mármol blanco",
  soil:                "tierra / suelo",
  tierra:              "tierra / suelo",
  mulch:               "mulch orgánico",
  "chukum-beige":      "chukum beige",
  "chukum-natural":    "chukum natural",
  "chukum-arena":      "chukum arena",
  "chukum-gris-claro": "chukum gris claro",
  "chukum-gris-oscuro":"chukum gris oscuro",
  "chukum-rosado":     "chukum rosado",
  "lambrin-claro":     "lambrín claro",
  "lambrin-oscuro":    "lambrín oscuro",
  "lambrin-gris":      "lambrín gris",
  "lambrin-blanco":    "lambrín blanco",
  "techo-blanco":      "techo blanco",
  "borde-madera":      "borde de madera",
});

/**
 * PASO 2 — VALIDADOR (spec).
 * Retorna true si el material está registrado en el TextureRegistry.
 * Loguea error en consola si no existe — NUNCA falla silenciosamente.
 *
 * @param key  ID del material (acepta underscore o guión).
 */
export function validateMaterial(key: string): boolean {
  const canonical = key.replace(/_/g, "-");
  const exists = _TEXTURE_MAP.has(canonical) ||
    [..._TEXTURE_MAP.keys()].some(k => k.startsWith(canonical) || canonical.startsWith(k));
  if (!exists) {
    console.error(`[validateMaterial] TEXTURA NO EXISTE: "${key}" (normalizado: "${canonical}")`);
  }
  return exists;
}

/**
 * Normaliza el ID del material: guión bajo → guión medio.
 * "madera_oscura" → "madera-oscura"
 */
export function normalizeMatId(raw: string): string {
  return raw.replace(/_/g, "-");
}

/**
 * STRICT: Resuelve la textura para un material dado.
 * Retorna CanvasPattern (tile offscreen) o null si el ID es desconocido.
 * NUNCA retorna pasto como fallback. null → render muestra rojo visible.
 *
 * @param materialId  ID canónico o con underscore.
 * @param ctx         Canvas context donde se aplicará el patrón.
 */
export function resolveTexture(
  materialId: string,
  ctx: CanvasRenderingContext2D,
): CanvasPattern | null {
  const canonical = normalizeMatId(materialId);

  // 1. Búsqueda exacta
  let tile = _TEXTURE_MAP.get(canonical);

  // 2. Búsqueda parcial (prefijo o sufijo)
  if (!tile) {
    for (const [key, canvas] of _TEXTURE_MAP) {
      if (key.startsWith(canonical) || canonical.startsWith(key)) {
        tile = canvas;
        break;
      }
    }
  }

  if (!tile) {
    console.error(
      `[resolveTexture] ❌ ID desconocido: "${materialId}" → normalizado: "${canonical}". ` +
      `IDs válidos: ${[..._TEXTURE_MAP.keys()].join(", ")}`,
    );
    return null;
  }

  const pattern = ctx.createPattern(tile, "repeat");
  if (!pattern) {
    console.error(`[resolveTexture] createPattern falló para: "${materialId}"`);
    return null;
  }
  return pattern;
}

/**
 * Returns materials filtered by surface category.
 * "all" returns all materials.
 */
export function getMaterialsByCategory(cat: SurfaceCategory | "all"): MaterialDef[] {
  if (cat === "all") return CAD_MATERIALS;
  return CAD_MATERIALS.filter(
    m => !m.categories || m.categories.includes(cat)
  );
}

/**
 * Draw a hatch pattern into a canvas context for a given polygon.
 * Used to visually distinguish materials beyond color alone.
 */
export function drawHatchPattern(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  mat: MaterialDef,
  spacing = 12
): void {
  if (!mat.hatchColor || pts.length < 3) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = mat.hatchColor;
  ctx.lineWidth = 1;
  const minX = Math.min(...pts.map(p => p.x));
  const maxX = Math.max(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y));
  const maxY = Math.max(...pts.map(p => p.y));
  for (let y = minY; y <= maxY; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(minX, y);
    ctx.lineTo(maxX, y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draw a procedural pattern overlay on top of the material fill.
 * Each patternType draws a different repeating motif inside the clipped polygon.
 */
export function drawPatternOverlay(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  mat: MaterialDef,
): void {
  if (!mat.patternType || pts.length < 3) return;

  const minX = Math.min(...pts.map(p => p.x));
  const maxX = Math.max(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y));
  const maxY = Math.max(...pts.map(p => p.y));
  const cx   = (minX + maxX) / 2;
  const cy   = (minY + maxY) / 2;
  const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2) + 20;

  ctx.save();
  // Clip to polygon
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.clip();

  switch (mat.patternType) {
    case "wood": {
      // Horizontal wood planks — alternating light/dark grain lines
      const spacing = 10;
      const dark = mat.id.includes("oscur"); // "oscura" o "oscuro"
      ctx.strokeStyle = dark ? "rgba(0,0,0,0.14)" : "rgba(0,0,0,0.09)";
      ctx.lineWidth = 0.8;
      for (let y = minY; y <= maxY; y += spacing) {
        ctx.beginPath();
        ctx.moveTo(minX, y);
        ctx.lineTo(maxX, y);
        ctx.stroke();
        // Subtle grain midline
        if (y + spacing / 2 <= maxY) {
          ctx.strokeStyle = dark ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.10)";
          ctx.beginPath();
          ctx.moveTo(minX, y + spacing / 2);
          ctx.lineTo(maxX, y + spacing / 2);
          ctx.stroke();
          ctx.strokeStyle = dark ? "rgba(0,0,0,0.14)" : "rgba(0,0,0,0.09)";
        }
      }
      break;
    }

    case "deck": {
      // Diagonal deck planks at ~30° — wider than wood
      const spacing = 14;
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.lineWidth = 1;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 6);
      for (let y = -diag; y <= diag; y += spacing) {
        ctx.beginPath();
        ctx.moveTo(-diag, y);
        ctx.lineTo(diag, y);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }

    case "lambrin": {
      // Vertical planks — narrower than wood
      const spacing = 8;
      const dark = mat.id.includes("oscuro");
      ctx.strokeStyle = dark
        ? "rgba(255,255,255,0.08)"
        : mat.id.includes("blanco")
          ? "rgba(0,0,0,0.06)"
          : "rgba(0,0,0,0.10)";
      ctx.lineWidth = 0.8;
      for (let x = minX; x <= maxX; x += spacing) {
        ctx.beginPath();
        ctx.moveTo(x, minY);
        ctx.lineTo(x, maxY);
        ctx.stroke();
      }
      break;
    }

    case "plaster": {
      // Subtle diagonal lines — chukum / stucco texture
      const spacing = 16;
      ctx.strokeStyle = "rgba(0,0,0,0.06)";
      ctx.lineWidth = 0.7;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      for (let y = -diag; y <= diag; y += spacing) {
        ctx.beginPath();
        ctx.moveTo(-diag, y);
        ctx.lineTo(diag, y);
        ctx.stroke();
      }
      ctx.restore();
      // Second diagonal — cross-hatch at 90°
      ctx.strokeStyle = "rgba(0,0,0,0.04)";
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-Math.PI / 4);
      for (let y = -diag; y <= diag; y += spacing) {
        ctx.beginPath();
        ctx.moveTo(-diag, y);
        ctx.lineTo(diag, y);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }

    case "gravel-fine": {
      // Stipple dots pattern — deterministic via integer hash
      const step = 6;
      ctx.fillStyle = "rgba(0,0,0,0.09)";
      for (let gx = minX + 3; gx < maxX; gx += step) {
        for (let gy = minY + 3; gy < maxY; gy += step) {
          const jx = (((gx * 13 + gy * 7) & 0xff) % 5) - 2;
          const jy = (((gx * 7 + gy * 11) & 0xff) % 5) - 2;
          ctx.beginPath();
          ctx.arc(gx + jx, gy + jy, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }

    case "stone-yuc": {
      // Irregular laja stone joints — horizontal + staggered verticals
      const rowH = 18;
      ctx.strokeStyle = "rgba(0,0,0,0.14)";
      ctx.lineWidth = 0.9;
      let row = 0;
      for (let y = minY; y <= maxY; y += rowH, row++) {
        // Horizontal joint
        ctx.beginPath(); ctx.moveTo(minX, y); ctx.lineTo(maxX, y); ctx.stroke();
        // Staggered vertical joints
        const offset = (row % 2) * 20;
        for (let x = minX + offset; x <= maxX; x += 28 + ((row * 7) % 12)) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x, Math.min(y + rowH, maxY));
          ctx.stroke();
        }
      }
      break;
    }
  }

  ctx.restore();
}
