/**
 * mountain-generator.ts
 *
 * Generador de montaña de pasto 2.5D (fake 3D) sobre canvas.
 * Usa gradiente radial + iluminación + ruido para simular volumen.
 *
 * Módulo puro: solo Canvas2D, sin React, sin dependencias externas.
 *
 * Fases:
 *   1. Calcular hull/bounding del área seleccionada
 *   2. Crear clipping region (respeta el área exacta)
 *   3. Gradiente de altura (centro=alto, bordes=bajo)
 *   4. Iluminación: lado superior claro, inferior oscuro
 *   5. Textura de pasto (grass blades con ruido)
 *   6. Sombra de contacto en base
 *   7. Variación de ruido para terreno natural
 */

export interface MPoint { x: number; y: number; }
export interface MLine  { start: MPoint; end: MPoint; }

// ─── Convex hull (Gift Wrapping) ──────────────────────────────────────────────
function cross(o: MPoint, a: MPoint, b: MPoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(pts: MPoint[]): MPoint[] {
  if (pts.length < 3) return pts;
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: MPoint[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: MPoint[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return [...lower, ...upper];
}

// ─── LCG pseudo-random (seed-based, reproducible) ────────────────────────────
function makeLCG(seed: number) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}

// ─── Noise helper (valor continuo 0..1 por posición) ─────────────────────────
function smoothNoise(x: number, y: number, freq: number, rng: () => number): number {
  const ix = Math.floor(x * freq);
  const iy = Math.floor(y * freq);
  const fx = (x * freq) - ix;
  const fy = (y * freq) - iy;
  // simple hash
  const h = (xi: number, yi: number) => {
    const n = Math.sin(xi * 127.1 + yi * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const a = h(ix, iy), b = h(ix + 1, iy);
  const c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ─── Función principal ────────────────────────────────────────────────────────
export function generateMountain(
  canvas: HTMLCanvasElement,
  lines: MLine[],
  seed = 42
): void {
  if (lines.length === 0) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // ── 1. Recopilar todos los puntos ─────────────────────────────────────────
  const allPts: MPoint[] = lines.flatMap(l => [l.start, l.end]);
  if (allPts.length < 2) return;

  const hull = convexHull(allPts);

  // Bounding box
  const minX = Math.min(...allPts.map(p => p.x));
  const maxX = Math.max(...allPts.map(p => p.x));
  const minY = Math.min(...allPts.map(p => p.y));
  const maxY = Math.max(...allPts.map(p => p.y));

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = Math.max((maxX - minX) / 2, 10);
  const ry = Math.max((maxY - minY) / 2, 10);

  const W = maxX - minX;
  const H = maxY - minY;

  const rng = makeLCG(seed);

  // ── 2. Crear Path2D de clipping (hull convexo) ────────────────────────────
  const clipPath = new Path2D();
  if (hull.length >= 3) {
    clipPath.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) clipPath.lineTo(hull[i].x, hull[i].y);
    clipPath.closePath();
  } else {
    // Fallback: elipse
    clipPath.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  }

  ctx.save();
  ctx.clip(clipPath);

  // ── 3. Gradiente de altura: verde oscuro borde → verde medio/claro centro ──
  //   Simula que el centro es más alto (más iluminado)
  const peakY = cy - ry * 0.25; // el pico está un 25% arriba del centro
  const heightGrad = ctx.createRadialGradient(cx, peakY, 0, cx, peakY, Math.max(rx, ry) * 1.1);
  heightGrad.addColorStop(0.00, "#6abf4b"); // cima: verde vivo
  heightGrad.addColorStop(0.25, "#4e9e35"); // flanco alto
  heightGrad.addColorStop(0.55, "#3a7a24"); // flanco medio
  heightGrad.addColorStop(0.80, "#2a5e18"); // base: verde oscuro
  heightGrad.addColorStop(1.00, "#1a3d0d"); // sombra profunda
  ctx.fillStyle = heightGrad;
  ctx.fillRect(minX, minY, W, H);

  // ── 4. Iluminación direccional ─────────────────────────────────────────────
  //   Luz desde arriba-izquierda → lado superior claro, inferior oscuro

  // Highlight superior
  const hlGrad = ctx.createLinearGradient(cx, minY, cx, cy);
  hlGrad.addColorStop(0, "rgba(255,255,220,0.30)");
  hlGrad.addColorStop(1, "rgba(255,255,220,0.00)");
  ctx.fillStyle = hlGrad;
  ctx.fillRect(minX, minY, W, H);

  // Sombra inferior (oscurece los flancos inferiores)
  const shGrad = ctx.createLinearGradient(cx, cy, cx, maxY);
  shGrad.addColorStop(0, "rgba(0,0,0,0.00)");
  shGrad.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = shGrad;
  ctx.fillRect(minX, cy, W, maxY - cy);

  // Sombra lateral izquierda (la luz viene desde la derecha arriba)
  const lsGrad = ctx.createLinearGradient(maxX, cy, minX, cy);
  lsGrad.addColorStop(0, "rgba(0,0,0,0.00)");
  lsGrad.addColorStop(1, "rgba(0,0,0,0.20)");
  ctx.fillStyle = lsGrad;
  ctx.fillRect(minX, minY, W, H);

  // ── 5. Textura de pasto (grass blades) ────────────────────────────────────
  //   Blades de diferente altura/color según posición en el heightmap
  const BLADE_COUNT = Math.min(Math.floor(W * H / 6), 2800);

  for (let i = 0; i < BLADE_COUNT; i++) {
    // Punto aleatorio dentro de la bounding box
    const px = minX + rng() * W;
    const py = minY + rng() * H;

    // Verificar que esté dentro del hull (aproximación con elipse)
    const nx = (px - cx) / rx;
    const ny = (py - cy) / ry;
    if (nx * nx + ny * ny > 0.98) continue;

    // Factor de altura (0 = borde, 1 = cima)
    const distNorm = Math.sqrt(nx * nx + ny * ny);
    const heightFactor = Math.max(0, 1 - distNorm);

    // Perspectiva: blades más cerca del bottom se ven más grandes
    const perspFactor = 0.6 + ((py - minY) / H) * 0.4;

    // Altura del blade: más alto en cima, más bajo en bordes
    const noise1 = smoothNoise(px / W, py / H, 5, rng);
    const bladeH = (4 + heightFactor * 14 + noise1 * 6) * perspFactor;
    const bladeW = 0.4 + rng() * 0.5;

    // Inclinación natural
    const lean = (rng() - 0.5) * bladeH * 0.5;
    const tipX = px + lean;
    const tipY = py - bladeH;

    // Color del blade según heightFactor + noise
    const noise2 = smoothNoise(px / W + 1, py / H + 1, 8, rng);
    const bright  = 0.55 + heightFactor * 0.45 + noise2 * 0.15;
    // Verde vivo en cima, oscuro en base
    const gVal = Math.min(255, Math.floor(90 + bright * 130));
    const rVal = Math.floor(20 + bright * 40);
    const bVal = Math.floor(10 + bright * 20);

    // Sombra por posición (más oscuro en la parte inferior del terreno)
    const shadeFactor = 1 - (py - minY) / H * 0.35;
    const finalR = Math.floor(rVal * shadeFactor);
    const finalG = Math.floor(gVal * shadeFactor);
    const finalB = Math.floor(bVal * shadeFactor);

    ctx.save();
    ctx.globalAlpha = 0.75 + rng() * 0.25;
    ctx.strokeStyle = `rgb(${finalR},${finalG},${finalB})`;
    ctx.lineWidth   = bladeW;
    ctx.lineCap     = "round";
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // Algunos blades tienen una segunda sección (curva)
    if (rng() > 0.65) {
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX + lean * 0.4, tipY - bladeH * 0.2);
      ctx.globalAlpha = 0.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── 6. Ruido de variación del terreno ─────────────────────────────────────
  //   Manchas más claras/oscuras para romper uniformidad
  const PATCHES = 8;
  for (let i = 0; i < PATCHES; i++) {
    const pxc = cx + (rng() - 0.5) * rx * 1.4;
    const pyc = cy + (rng() - 0.5) * ry * 1.0;
    const pr  = 15 + rng() * 35;
    const isLight = rng() > 0.5;

    const patchGrad = ctx.createRadialGradient(pxc, pyc, 0, pxc, pyc, pr);
    if (isLight) {
      patchGrad.addColorStop(0, "rgba(120,200,60,0.18)");
      patchGrad.addColorStop(1, "rgba(120,200,60,0.00)");
    } else {
      patchGrad.addColorStop(0, "rgba(0,30,0,0.22)");
      patchGrad.addColorStop(1, "rgba(0,30,0,0.00)");
    }
    ctx.fillStyle = patchGrad;
    ctx.beginPath();
    ctx.arc(pxc, pyc, pr, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore(); // quitar clip

  // ── 6b. Sombra de contacto (exterior del hull, base de la montaña) ─────────
  //   Oscurece el borde inferior para dar sensación de volumen/elevación
  const shadowBase = ctx.createRadialGradient(
    cx, maxY - ry * 0.15, rx * 0.2,
    cx, maxY - ry * 0.15, rx * 0.85
  );
  shadowBase.addColorStop(0, "rgba(0,0,0,0.00)");
  shadowBase.addColorStop(1, "rgba(0,0,0,0.28)");

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = shadowBase;
  ctx.beginPath();
  // Área de sombra: solo la mitad inferior del hull
  if (hull.length >= 3) {
    ctx.ellipse(cx, maxY - ry * 0.1, rx * 0.9, ry * 0.25, 0, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();

  // ── 7. Borde suavizado (antialiasing manual) ──────────────────────────────
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  // Crear borde feather: dibujar el path con blur fuera
  const FEATHER = 3;
  for (let f = 1; f <= FEATHER; f++) {
    ctx.globalAlpha = 0.08 * f;
    const scale = 1 + (f * 0.008);
    ctx.save();
    ctx.translate(cx * (1 - scale), cy * (1 - scale));
    ctx.scale(scale, scale);
    if (hull.length >= 3) {
      const fp = new Path2D();
      fp.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) fp.lineTo(hull[i].x, hull[i].y);
      fp.closePath();
      ctx.fill(fp);
    }
    ctx.restore();
  }
  ctx.restore();
}
