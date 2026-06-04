/**
 * edge-detector.ts
 *
 * Detección de bordes (Sobel) y snap de puntos al borde más cercano.
 * Puro TypeScript, sin dependencias externas.
 *
 * Pipeline:
 *   1. Convertir imagen a escala de grises
 *   2. Blur Gaussiano 3×3 para reducir ruido
 *   3. Filtro Sobel → mapa de magnitud de gradiente
 *   4. Umbral → mapa binario de bordes (EdgeMap)
 *   5. snapToEdge() busca el píxel de borde más cercano en radio dado
 */

export interface EdgeMap {
  /** Mapa binario: 1 = borde, 0 = no borde */
  edges: Uint8Array;
  width: number;
  height: number;
}

// ─── buildEdgeMap ──────────────────────────────────────────────────────────────
/**
 * Construye el EdgeMap a partir de los pixels de una imagen.
 * @param imageData   ImageData de un canvas (RGBA)
 * @param threshold   Umbral de magnitud Sobel (default 25). Menor → más bordes.
 */
export function buildEdgeMap(imageData: ImageData, threshold = 25): EdgeMap {
  const { data, width, height } = imageData;
  const N = width * height;

  // ── 1. Escala de grises (luma BT.601) ────────────────────────────────────
  const gray = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    gray[i] =
      0.299 * data[i * 4] +
      0.587 * data[i * 4 + 1] +
      0.114 * data[i * 4 + 2];
  }

  // ── 2. Blur Gaussiano 3×3 (reduce ruido antes de Sobel) ──────────────────
  const blurred = new Float32Array(N);
  // kernel: [1,2,1 / 2,4,2 / 1,2,1] ÷ 16
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      blurred[y * width + x] = (
        gray[(y - 1) * width + (x - 1)] +
        2 * gray[(y - 1) * width + x] +
        gray[(y - 1) * width + (x + 1)] +
        2 * gray[y * width + (x - 1)] +
        4 * gray[y * width + x] +
        2 * gray[y * width + (x + 1)] +
        gray[(y + 1) * width + (x - 1)] +
        2 * gray[(y + 1) * width + x] +
        gray[(y + 1) * width + (x + 1)]
      ) / 16;
    }
  }

  // ── 3. Sobel → magnitud de gradiente ─────────────────────────────────────
  const edges = new Uint8Array(N);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx =
        -blurred[(y - 1) * width + (x - 1)] -
        2 * blurred[y * width + (x - 1)] -
        blurred[(y + 1) * width + (x - 1)] +
        blurred[(y - 1) * width + (x + 1)] +
        2 * blurred[y * width + (x + 1)] +
        blurred[(y + 1) * width + (x + 1)];

      const gy =
        -blurred[(y - 1) * width + (x - 1)] -
        2 * blurred[(y - 1) * width + x] -
        blurred[(y - 1) * width + (x + 1)] +
        blurred[(y + 1) * width + (x - 1)] +
        2 * blurred[(y + 1) * width + x] +
        blurred[(y + 1) * width + (x + 1)];

      const mag = Math.sqrt(gx * gx + gy * gy);
      edges[y * width + x] = mag > threshold ? 1 : 0;
    }
  }

  return { edges, width, height };
}

// ─── buildEdgeMapFromImage ─────────────────────────────────────────────────────
/**
 * Atajo: dibuja la imagen en un canvas offscreen y extrae el EdgeMap.
 * @param img     HTMLImageElement cargado
 * @param canvasW Ancho del canvas destino (coordenadas de snap)
 * @param canvasH Alto  del canvas destino
 */
export function buildEdgeMapFromImage(
  img: HTMLImageElement,
  canvasW: number,
  canvasH: number,
  threshold = 25
): EdgeMap {
  const tmp = document.createElement("canvas");
  tmp.width = canvasW;
  tmp.height = canvasH;
  const ctx = tmp.getContext("2d")!;
  ctx.drawImage(img, 0, 0, canvasW, canvasH);
  const imgData = ctx.getImageData(0, 0, canvasW, canvasH);
  return buildEdgeMap(imgData, threshold);
}

// ─── snapToEdge ───────────────────────────────────────────────────────────────
/**
 * Busca el píxel de borde más cercano al punto (x, y) dentro de `radius` píxeles.
 * Si no encuentra ninguno, devuelve el punto original.
 *
 * @param x        Coordenada X en espacio canvas
 * @param y        Coordenada Y en espacio canvas
 * @param edgeMap  EdgeMap calculado con buildEdgeMap()
 * @param radius   Radio máximo de búsqueda en píxeles (default 15)
 * @returns        Punto ajustado (o el mismo si no hay borde cerca)
 */
export function snapToEdge(
  x: number,
  y: number,
  edgeMap: EdgeMap,
  radius = 15
): { x: number; y: number; snapped: boolean } {
  const { edges, width, height } = edgeMap;
  const cx = Math.round(x);
  const cy = Math.round(y);
  const r = Math.ceil(radius);

  let bestDist = Infinity;
  let bx = x;
  let by = y;

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!edges[ny * width + nx]) continue;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bx = nx;
        by = ny;
      }
    }
  }

  const snapped = bestDist < Infinity;
  return { x: snapped ? bx : x, y: snapped ? by : y, snapped };
}

// ─── interpolateSnapped ────────────────────────────────────────────────────────
/**
 * Suaviza la transición entre un punto raw y uno snapped aplicando
 * una mezcla lineal controlada por `strength` (0 = raw, 1 = totalmente snapped).
 */
export function interpolateSnapped(
  raw: { x: number; y: number },
  snapped: { x: number; y: number; snapped: boolean },
  strength = 0.8
): { x: number; y: number } {
  if (!snapped.snapped) return raw;
  return {
    x: raw.x + (snapped.x - raw.x) * strength,
    y: raw.y + (snapped.y - raw.y) * strength,
  };
}
