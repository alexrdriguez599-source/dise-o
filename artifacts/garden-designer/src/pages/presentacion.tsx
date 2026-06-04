import React, { useRef } from "react";
import { useLocation } from "wouter";
import { useAppContext, type DesignItem } from "@/context/app-context";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft, Save, Loader2, CheckCircle2, Package, Leaf,
  Download, Sparkles, X, ImageDown,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authHeaders } from "@/services/auth";
import { wavespeedPost } from "@/services/wavespeed-fetch";
import { useToast } from "@/hooks/use-toast";
import { useDeviceType } from "@/hooks/use-device";
import DesignCanvas, { type DesignCanvasRef } from "@/components/design-canvas";

// ─── Utilidades de compositing (copiadas de design-canvas para evitar closures) ───

function _getContainRect(natW: number, natH: number, cW: number, cH: number) {
  const scale = Math.min(cW / natW, cH / natH);
  const w = natW * scale, h = natH * scale;
  return { x: (cW - w) / 2, y: (cH - h) / 2, w, h };
}

function _calcPerspScale(yPct: number, horizonYPct: number): number {
  if (yPct <= horizonYPct) return 0.4;
  return 0.5 + ((yPct - horizonYPct) / (100 - horizonYPct)) * 0.8;
}

async function _loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("img load fail: " + src.slice(0, 40)));
    img.src = src;
  });
}

interface CompositePlantsArgs {
  aiBg: string;
  gardenImage: string;
  designItems: DesignItem[];
  containerSize: { width: number; height: number } | null;
  horizonYPct: number;
}

// Carga una imagen con múltiples fuentes de fallback (nunca lanza si alguna funciona)
async function _loadImageRobust(sources: string[]): Promise<HTMLImageElement | null> {
  for (const src of sources) {
    try {
      return await _loadImage(src);
    } catch {
      /* probar siguiente fuente */
    }
  }
  return null;
}

// ── REMOCIÓN DE FONDO BLANCO ──────────────────────────────────────────────────
// Algoritmo flood-fill desde las 4 esquinas: identifica el color de fondo real
// (blanco, gris claro, o cualquier color uniforme en las esquinas) y lo hace
// transparente. Más preciso que un threshold global — no toca flores blancas
// que estén en el centro del PNG.
const _removedBgCache = new Map<string, HTMLCanvasElement>();

function _removeWhiteBg(img: HTMLImageElement): HTMLCanvasElement {
  const cacheKey = img.src.slice(0, 80);
  if (_removedBgCache.has(cacheKey)) return _removedBgCache.get(cacheKey)!;

  const W = img.naturalWidth, H = img.naturalHeight;
  const off = document.createElement("canvas");
  off.width = W; off.height = H;
  const ctx = off.getContext("2d")!;
  ctx.drawImage(img, 0, 0, W, H);

  const id = ctx.getImageData(0, 0, W, H);
  const d  = id.data;

  // Muestrear color de las 4 esquinas para detectar color de fondo
  const corners = [
    [d[0], d[1], d[2]],                              // top-left
    [d[(W-1)*4], d[(W-1)*4+1], d[(W-1)*4+2]],        // top-right
    [d[(H-1)*W*4], d[(H-1)*W*4+1], d[(H-1)*W*4+2]], // bottom-left
    [d[((H-1)*W+W-1)*4], d[((H-1)*W+W-1)*4+1], d[((H-1)*W+W-1)*4+2]], // bottom-right
  ];
  const avgBg = corners.reduce((acc, c) => [acc[0]+c[0], acc[1]+c[1], acc[2]+c[2]], [0,0,0])
    .map(v => v / 4);
  const bgBrightness = (avgBg[0] + avgBg[1] + avgBg[2]) / 3;

  // Solo aplicar remoción si el fondo es claro (blanco/gris)
  // Si el fondo es oscuro o colorido, los PNGs ya tienen transparencia correcta
  if (bgBrightness < 200) {
    _removedBgCache.set(cacheKey, off);
    return off;
  }

  // Flood fill desde las 4 esquinas para marcar píxeles de fondo
  const TOLERANCE = 28; // margen de variación del color de fondo
  const visited   = new Uint8Array(W * H);
  const queue: number[] = [];

  const isBg = (idx: number): boolean => {
    const r = d[idx], g = d[idx+1], b = d[idx+2];
    return (
      Math.abs(r - avgBg[0]) < TOLERANCE &&
      Math.abs(g - avgBg[1]) < TOLERANCE &&
      Math.abs(b - avgBg[2]) < TOLERANCE
    );
  };

  // Seed desde las 4 esquinas
  const seeds = [0, W-1, (H-1)*W, (H-1)*W+W-1];
  for (const s of seeds) {
    if (!visited[s] && isBg(s*4)) { queue.push(s); visited[s] = 1; }
  }

  // BFS flood fill
  while (queue.length > 0) {
    const pos = queue.pop()!;
    const x = pos % W, y = Math.floor(pos / W);
    // Hacer transparente con gradiente suave
    const idx = pos * 4;
    const r = d[idx], g = d[idx+1], b = d[idx+2];
    const diff = (Math.abs(r-avgBg[0]) + Math.abs(g-avgBg[1]) + Math.abs(b-avgBg[2])) / 3;
    const alpha = Math.min(1, diff / (TOLERANCE * 0.6));
    d[idx+3] = Math.round(d[idx+3] * alpha);

    // Vecinos 4-conectados
    const neighbors = [
      x > 0   ? pos - 1 : -1,
      x < W-1 ? pos + 1 : -1,
      y > 0   ? pos - W : -1,
      y < H-1 ? pos + W : -1,
    ];
    for (const n of neighbors) {
      if (n >= 0 && !visited[n] && isBg(n*4)) {
        visited[n] = 1;
        queue.push(n);
      }
    }
  }

  ctx.putImageData(id, 0, 0);
  _removedBgCache.set(cacheKey, off);
  return off;
}

async function compositePlantsOnAiBg({
  aiBg,
  gardenImage,
  designItems,
  containerSize,
  horizonYPct,
}: CompositePlantsArgs): Promise<string | null> {
  // ── Derivar containerSize si el DOM no lo reportó ─────────────────────
  // Si el canvas no respondió, usamos el tamaño natural del gardenImage
  // escalado a un ancho estándar de 1200px (relación de aspecto preservada).
  let cssW: number;
  let cssH: number;

  if (containerSize && containerSize.width > 0 && containerSize.height > 0) {
    cssW = containerSize.width;
    cssH = containerSize.height;
  } else {
    // Fallback: cargar gardenImage y derivar un contenedor 1200px wide
    try {
      const bgFb = await _loadImage(gardenImage);
      cssW = 1200;
      cssH = Math.round(1200 * (bgFb.naturalHeight / bgFb.naturalWidth));
    } catch {
      console.error("[compositePlantsOnAiBg] No se puede derivar containerSize — abortar");
      return null;
    }
  }

  console.log("[compositePlantsOnAiBg] cssW=", cssW, "cssH=", cssH,
    "items=", designItems.length, "horizonY=", horizonYPct);

  const bgImg = await _loadImage(gardenImage);
  const cr = _getContainRect(bgImg.naturalWidth, bgImg.naturalHeight, cssW, cssH);

  const EXPORT_SCALE = 2;
  const combined = document.createElement("canvas");
  combined.width  = cssW * EXPORT_SCALE;
  combined.height = cssH * EXPORT_SCALE;
  const ctx = combined.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.scale(EXPORT_SCALE, EXPORT_SCALE);

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cssW, cssH);

  // Dibujar fondo IA
  try {
    const aiBgImg = await _loadImage(aiBg);
    ctx.drawImage(aiBgImg, cr.x, cr.y, cr.w, cr.h);
  } catch {
    // Si el AI bg falla, usar gardenImage original
    ctx.drawImage(bgImg, cr.x, cr.y, cr.w, cr.h);
  }

  // ── Compositar TODAS las plantas en posiciones exactas ────────────────
  const BASE_SIZE = 120;
  const sorted = [...designItems].sort((a, b) => (a.y ?? 50) - (b.y ?? 50));
  let drawn = 0;
  let skipped = 0;

  for (const item of sorted) {
    // Fuentes de imagen en orden de prioridad:
    // 1) imageData en memoria (fresco, proyectos nuevos)
    // 2) /api/inventory/:id/image (proyectos guardados/restaurados)
    const sources: string[] = [];
    if (item.imageData) sources.push(item.imageData);
    if (typeof item.inventoryItemId === "number") {
      sources.push(`/api/inventory/${item.inventoryItemId}/image`);
    }
    if (sources.length === 0) { skipped++; continue; }

    const itemImg = await _loadImageRobust(sources);
    if (!itemImg) { skipped++; console.warn("[composite] sin imagen para", item.name); continue; }

    const s = item.scale || 1;
    const perspScale = item.lockPosition
      ? 1.0
      : _calcPerspScale(item.y ?? 50, horizonYPct);
    const finalSize = BASE_SIZE * s * perspScale;
    const cx = (item.x / 100) * cssW;
    const cy = (item.y / 100) * cssH + (item.baseOffset ?? 0);
    const r  = ((item.rotation || 0) * Math.PI) / 180;
    const nat = itemImg.naturalWidth / itemImg.naturalHeight;
    let dw: number, dh: number;
    if (nat >= 1) { dw = finalSize; dh = finalSize / nat; }
    else           { dh = finalSize; dw = finalSize * nat; }

    // Remover fondo blanco del PNG antes de dibujarlo
    const cleanImg = _removeWhiteBg(itemImg);

    ctx.save();
    // Sombra sutil al pie de la planta
    ctx.globalAlpha = 0.10;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 2, dw * 0.25, dw * 0.08, 0, 0, Math.PI * 2);
    ctx.fillStyle = "black";
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.translate(cx, cy);
    ctx.rotate(r);
    ctx.drawImage(cleanImg, -dw / 2, -dh, dw, dh);
    ctx.restore();
    drawn++;
    console.log("[composite] ✓", item.name, "at", cx.toFixed(0), cy.toFixed(0), dw.toFixed(0), "×", dh.toFixed(0));
  }

  console.log(`[composite] TOTAL: ${drawn} dibujados, ${skipped} sin imagen`);
  return _applyVFX(combined);
}

// ── VFX profesional encima del composite ─────────────────────────────────────
function _applyVFX(src: HTMLCanvasElement): string {
  const W = src.width, H = src.height;
  const clamp = (v: number) => Math.max(0, Math.min(255, v));

  const g = document.createElement("canvas"); g.width=W; g.height=H;
  const gc = g.getContext("2d")!;
  gc.filter="contrast(1.10) brightness(1.00) saturate(1.12)";
  gc.drawImage(src,0,0,W,H); gc.filter="none";

  // Warm toning en highlights (luz solar dorada)
  const id=gc.getImageData(0,0,W,H); const d=id.data;
  for (let i=0;i<d.length;i+=4) {
    const lum=(d[i]*0.2126+d[i+1]*0.7152+d[i+2]*0.0722)/255;
    const hT=Math.max(0,(lum-0.55)/0.45)*0.22;
    d[i]=clamp(d[i]+hT*24); d[i+1]=clamp(d[i+1]+hT*8); d[i+2]=clamp(d[i+2]-hT*14);
  }
  gc.putImageData(id,0,0);

  // Unsharp mask 3×3
  const SHARPEN=0.35; const sd=gc.getImageData(0,0,W,H);
  const dd=new ImageData(W,H); const s=sd.data,d2=dd.data;
  const get=(px:number,py:number,c:number)=>{
    px=Math.max(0,Math.min(W-1,px));py=Math.max(0,Math.min(H-1,py));
    return s[(py*W+px)*4+c];
  };
  for(let py=0;py<H;py++)for(let px=0;px<W;px++){
    const idx=(py*W+px)*4;
    for(let c=0;c<3;c++){const o=get(px,py,c);
      const b=(get(px-1,py-1,c)+get(px,py-1,c)+get(px+1,py-1,c)+
               get(px-1,py,c)+o+get(px+1,py,c)+
               get(px-1,py+1,c)+get(px,py+1,c)+get(px+1,py+1,c))/9;
      d2[idx+c]=clamp(o+SHARPEN*(o-b));} d2[idx+3]=s[idx+3];}
  const sharp=document.createElement("canvas");sharp.width=W;sharp.height=H;
  sharp.getContext("2d")!.putImageData(dd,0,0);

  const out=document.createElement("canvas");out.width=W;out.height=H;
  const oc=out.getContext("2d")!;oc.imageSmoothingQuality="high";
  oc.drawImage(sharp,0,0,W,H);

  // Viñeta
  const vign=oc.createRadialGradient(W*.5,H*.5,H*.28,W*.5,H*.5,H*.85);
  vign.addColorStop(0,"rgba(0,0,0,0)");vign.addColorStop(.70,"rgba(0,0,0,0)");
  vign.addColorStop(1,"rgba(0,0,0,0.26)");
  oc.fillStyle=vign;oc.fillRect(0,0,W,H);

  // Haze atmosférico
  const haze=oc.createLinearGradient(0,0,0,H*.38);
  haze.addColorStop(0,"rgba(218,228,238,0.12)");haze.addColorStop(1,"rgba(218,228,238,0)");
  oc.fillStyle=haze;oc.fillRect(0,0,W,H*.38);

  // Warm ambient
  oc.save();oc.globalCompositeOperation="soft-light";oc.globalAlpha=0.11;
  oc.fillStyle="rgba(255,195,90,1)";oc.fillRect(0,0,W,H);oc.restore();

  return out.toDataURL("image/jpeg",0.97);
}

// ─── Fin utilidades de compositing ───────────────────────────────────────────

/** Redimensiona un data-URI base64 a maxW píxeles de ancho manteniendo aspect ratio. */
async function resizeBase64(dataUri: string, maxW: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth <= maxW) { resolve(dataUri); return; }
      const scale = maxW / img.naturalWidth;
      const w = maxW;
      const h = Math.round(img.naturalHeight * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

export default function PresentacionPage() {
  const {
    clientInfo,
    gardenImage,
    designItems,
    totalEstimate,
    projectId,
    setProjectId,
    pricePerM2,
    grassAreaM2,
    grassCost,
  } = useAppContext();

  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const deviceType = useDeviceType();
  const designCanvasRef = useRef<DesignCanvasRef>(null);

  const queryClient = useQueryClient();
  const API_BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

  const createProject = useMutation({
    mutationFn: async ({ data }: { data: Record<string, unknown> }) => {
      const res = await fetch(`${API_BASE_URL}/api/projects`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Create failed');
      return res.json();
    },
  });

  const updateProject = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Record<string, unknown> }) => {
      const res = await fetch(`${API_BASE_URL}/api/projects/${id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Update failed');
      return res.json();
    },
  });

  // ── Descarga JPG normal ───────────────────────────────────────────────────
  const [isDownloading, setIsDownloading] = React.useState(false);

  // ── Panel Render Premium IA ───────────────────────────────────────────────
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [aiLoading, setAiLoading] = React.useState(false);
  const [aiImage, setAiImage] = React.useState<string | null>(null);
  const [aiStep, setAiStep] = React.useState("");

  if (!clientInfo) {
    setLocation("/");
    return null;
  }

  const handleConfirm = () => {
    const data = {
      clientName: clientInfo.name,
      clientPhone: clientInfo.phone,
      clientAddress: clientInfo.address,
      gardenImageData: gardenImage || null,
      designData: JSON.stringify(designItems),
      totalEstimate,
    };

    if (projectId) {
      updateProject.mutate({ id: projectId, data }, {
        onSuccess: () => {
          toast({
            title: "¡Proyecto confirmado!",
            description: "El diseño se ha guardado correctamente.",
            action: <CheckCircle2 className="w-5 h-5 text-green-500" />,
          });
        },
        onError: () => {
          toast({ title: "Error", description: "No se pudo confirmar el proyecto.", variant: "destructive" });
        },
      });
    } else {
      createProject.mutate({ data }, {
        onSuccess: (res) => {
          setProjectId(res.id);
          toast({
            title: "¡Proyecto confirmado!",
            description: "El diseño se ha guardado correctamente.",
            action: <CheckCircle2 className="w-5 h-5 text-green-500" />,
          });
        },
        onError: () => {
          toast({ title: "Error", description: "No se pudo confirmar el proyecto.", variant: "destructive" });
        },
      });
    }
  };

  const isPending = createProject.isPending || updateProject.isPending;
  const showInventorySide = deviceType === "desktop";

  // ── Pipeline descarga BLINDADO (1:1, sin alterar nada) ───────────────
  // Descarga la captura del lienzo EXACTAMENTE como se ve en pantalla.
  // - NO escala (antes 2× hacía ver las plantas "orejonas")
  // - NO aplica filtros de color / brillo / saturación
  // - Solo re-encoda a JPEG de alta calidad para el archivo descargado
  const applyRenderProPipeline = (sourceDataUrl: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const final = document.createElement("canvas");
        final.width = img.width;
        final.height = img.height;
        const ctx = final.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        resolve(final.toDataURL("image/jpeg", 0.95));
      };
      img.onerror = reject;
      img.src = sourceDataUrl;
    });

  const handleDownloadJpg = async () => {
    if (!designCanvasRef.current) return;
    setIsDownloading(true);
    try {
      const raw = await designCanvasRef.current.buildPresentationCapture();
      if (!raw) return;
      const dataUrl = await applyRenderProPipeline(raw);
      const link = document.createElement("a");
      link.download = `diseno-${clientInfo?.name ?? "jardin"}-${Date.now()}.jpg`;
      link.href = dataUrl;
      link.click();
    } catch {
      /* silencioso */
    } finally {
      setIsDownloading(false);
    }
  };

  // ── Render Premium IA — dos pasos con compositing exacto ─────────────
  // Prompt blindado — ESTRICTO pixel-perfect.
  // REGLA: prompt corto (<40 palabras), SIN lista de plantas = máxima adherencia al input.
  const buildNanaBananaPrompt = (): string => {
    // LECCIÓN CRÍTICA: prompt < 40 palabras = adherencia máxima al input.
    // CLAVE: usar verbos ACTIVOS ("Transform/Convert into a photograph") para que el
    // modelo RENDERICE de verdad. Frases pasivas ("unchanged... add photorealism only")
    // hacen que el modelo solo devuelva una copia casi igual al input (sin realismo).
    // NUNCA agregar lista de plantas, reglas largas ni múltiples instrucciones.
    if (renderMode === "creativo") {
      // Cinematográfico: transformación dramática y super real, sin inventar nada.
      return "Transform this design into a cinematic 8K HDR photograph. Warm afternoon sunlight, dramatic realistic shadows, depth of field. Keep every object's exact color, material and position — furniture keeps its original color. Recolor nothing, move nothing, invent nothing.";
    }
    // Conservador: hiperrealista de día — foto DSLR real, textura fina, luz clara, sombras suaves.
    return "Convert this design into a hyperrealistic 8K DSLR photo. Bright clear daylight, soft long shadows, realistic grass and leaf texture, sharp natural detail. Keep every object's exact color, material and position. Recolor nothing, invent nothing.";
  };

  const [aiAdvanced, setAiAdvanced] = React.useState(false);
  const [aiCustomPrompt, setAiCustomPrompt] = React.useState("");
  const [aiRefImage, setAiRefImage] = React.useState<string | null>(null);
  const [renderMode, setRenderMode] = React.useState<"conservador" | "creativo">("conservador");
  const [retryToken, setRetryToken] = React.useState<string | null>(null);
  const [canFreeRetry, setCanFreeRetry] = React.useState(false);
  const aiFileInputRef = React.useRef<HTMLInputElement>(null);

  // Auto-detectar nombres de plantas del diseño al abrir el panel
  // Usamos designItems del AppContext directamente (siempre actualizado, sin closures)
  const [aiPlants, setAiPlants] = React.useState("");
  const autoFillPlants = React.useCallback(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const item of designItems) {
      if (item.name && !seen.has(item.name)) {
        seen.add(item.name);
        names.push(item.name);
      }
    }
    if (names.length > 0) setAiPlants(names.join("\n"));
  }, [designItems]);

  const handleAiImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setAiRefImage(ev.target?.result as string);
      setAiImage(null);
    };
    reader.readAsDataURL(file);
  };

  const handleMagazineRender = async (isFreeRetry = false) => {
    setAiLoading(true);
    setAiImage(null);
    setAiStep("");
    const tokenToSend = isFreeRetry ? retryToken : null;
    setRetryToken(null);
    setCanFreeRetry(false);
    try {
      const canvas = designCanvasRef.current;

      // ── UN SOLO PASO: lienzo completo → google/nano-banana-pro/edit ───────
      // LECCIÓN 3: Pipeline simple > multi-paso. No composite de íconos encima.
      // LECCIÓN 1: NO aplicar postproducción al output — nano-banana ya entrega foto terminada.
      setAiStep("Generando render fotorrealista… (60-90 s)");

      const prompt = (aiAdvanced && aiCustomPrompt.trim())
        ? aiCustomPrompt.trim()
        : buildNanaBananaPrompt();

      // Imagen: referencia manual del usuario, o captura completa del lienzo (con plantas).
      const rawImage = aiRefImage ?? (canvas ? await canvas.buildPresentationCapture() : null);

      // Redimensionar a máx 1280px de ancho para no exceder límites de la API.
      const fullImage = rawImage ? await resizeBase64(rawImage, 1280) : null;

      const body: Record<string, string> = { prompt };
      if (fullImage) body.imageBase64 = fullImage;
      if (tokenToSend) body.retryToken = tokenToSend;

      const data = await wavespeedPost("/api/ai/wavespeed/magazine-render", body);

      if (data.imageBase64) {
        // Mostrar el resultado directo — sin postproducción local (LECCIÓN 1).
        setAiImage(data.imageBase64);
        if (data.retryToken) {
          setRetryToken(data.retryToken);
          setCanFreeRetry(true);
        }
      } else {
        toast({ title: "Error IA", description: "Sin resultado del servidor.", variant: "destructive" });
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      const isCredits = /insufficient credits|cr[eé]dit/i.test(raw);
      toast({
        title: isCredits ? "Sin créditos de IA" : "Error",
        description: isCredits
          ? "La cuenta de WaveSpeed se quedó sin créditos. Recarga saldo en wavespeed.ai para volver a generar renders."
          : (raw || "Error de conexión con el servidor."),
        variant: "destructive",
      });
    } finally {
      setAiLoading(false);
      setAiStep("");
    }
  };

  const handleDownloadAi = () => {
    if (!aiImage) return;
    const link = document.createElement("a");
    link.download = `render-premium-${clientInfo?.name ?? "jardin"}-${Date.now()}.jpg`;
    link.href = aiImage;
    link.click();
  };

  return (
    <div className="flex flex-col h-[100dvh] w-full overflow-hidden relative">

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <header className="h-14 md:h-16 shrink-0 z-50 flex items-center justify-between px-4 md:px-6 bg-black/80 backdrop-blur border-b border-white/10">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/design")}
            className="text-white hover:bg-white/10 rounded-full"
          >
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Leaf className="w-5 h-5 text-primary-foreground" />
          </div>
          <div className="hidden sm:flex flex-col">
            <span className="font-semibold text-sm text-white leading-tight">{clientInfo.name}</span>
            <span className="text-xs text-white/50 truncate max-w-[200px]">{clientInfo.address}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setLocation("/design")}
            className="h-9 rounded-xl text-xs border-white/20 text-white bg-white/10 hover:bg-white/20 hidden sm:flex"
          >
            Editar Diseño
          </Button>

          {/* Descarga normal — tal cual está */}
          <Button
            variant="outline"
            onClick={handleDownloadJpg}
            disabled={isDownloading}
            className="h-9 rounded-xl text-xs border-white/20 text-white bg-white/10 hover:bg-white/20 gap-1.5"
          >
            {isDownloading
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Download className="w-4 h-4" />}
            <span className="hidden sm:inline">Descargar JPG</span>
          </Button>

          {/* Nuevo botón Render Premium IA */}
          <Button
            onClick={() => { setPanelOpen(true); setAiImage(null); autoFillPlants(); }}
            className="h-9 rounded-xl text-xs gap-1.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white border-0 shadow-lg shadow-violet-900/40"
          >
            <Sparkles className="w-4 h-4" />
            <span className="hidden sm:inline">Render IA Premium</span>
          </Button>

          <Button
            onClick={handleConfirm}
            disabled={isPending}
            className="h-9 rounded-xl text-xs shadow-lg shadow-primary/20"
          >
            {isPending
              ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
              : <Save className="w-4 h-4 mr-1.5" />}
            Confirmar
          </Button>
        </div>
      </header>

      {/* ── Layout principal ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* Canvas — en desktop tiene el mismo ancho que en el editor (344px de sidebar derecho) */}
        <main className="flex-1 relative flex flex-col min-w-0 bg-black">
          <DesignCanvas readOnly ref={designCanvasRef} />
        </main>

        {/* ── Sidebar presupuesto — SOLO DESKTOP (w-[344px] = right+left sidebar del editor) ── */}
        {showInventorySide && (
          <aside className="w-[344px] shrink-0 flex flex-col bg-card border-l border-white/10 overflow-y-auto">
            <div className="p-5 flex flex-col gap-4 flex-1">

              <div>
                <h2 className="text-lg font-bold tracking-tight mb-0.5 truncate">{clientInfo.name}</h2>
                <p className="text-xs text-muted-foreground truncate">{clientInfo.address}</p>
              </div>

              <div className="bg-background/50 rounded-2xl p-3 flex-1 overflow-y-auto">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Package className="w-3.5 h-3.5" /> Desglose del presupuesto
                </h3>
                {designItems.length === 0 && grassAreaM2 === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-2">Sin elementos</p>
                ) : (
                  <ul className="space-y-1.5">
                    {designItems.map((item, idx) => (
                      <li key={idx} className="flex justify-between items-center text-sm">
                        <span className="truncate pr-3 font-medium">
                          {item.name}
                          {item.quantity != null && item.unitPrice != null && (
                            <span className="text-xs text-muted-foreground font-normal ml-1">
                              ({item.quantity} × ${item.unitPrice.toLocaleString()})
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-primary font-semibold">${item.price.toLocaleString()}</span>
                      </li>
                    ))}
                    {grassAreaM2 > 0 && (
                      <li className="flex justify-between items-center text-sm border-t border-border/40 pt-1.5 mt-1">
                        <span className="font-medium text-emerald-700">
                          Pasto ({grassAreaM2.toFixed(1)} m² × ${pricePerM2.toLocaleString()}/m²)
                        </span>
                        <span className="shrink-0 text-emerald-700 font-semibold">${grassCost.toLocaleString()}</span>
                      </li>
                    )}
                  </ul>
                )}
              </div>

              <div className="flex items-end justify-between">
                <div>
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Total Estimado</span>
                  <div className="text-3xl font-bold text-primary tracking-tight">
                    ${(totalEstimate + grassCost).toLocaleString()}
                  </div>
                </div>
                {grassAreaM2 > 0 && (
                  <div className="text-right">
                    <span className="text-xs text-muted-foreground block">Incl. pasto IA</span>
                    <span className="text-sm text-emerald-700 font-semibold">{grassAreaM2.toFixed(1)} m²</span>
                  </div>
                )}
              </div>

              <Button
                onClick={handleConfirm}
                disabled={isPending}
                className="h-11 rounded-xl text-sm shadow-lg shadow-primary/20 w-full"
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Save className="w-4 h-4 mr-1.5" />}
                Confirmar Proyecto
              </Button>
            </div>
          </aside>
        )}
      </div>

      {/* ── Panel presupuesto flotante — SOLO MOBILE ─────────────────────────── */}
      {!showInventorySide && (
        <div className="absolute bottom-6 left-4 right-4 bg-card/95 backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl p-5 z-50 text-card-foreground">
          <div className="mb-3">
            <h2 className="text-lg font-bold tracking-tight mb-0.5 truncate">{clientInfo.name}</h2>
            <p className="text-xs text-muted-foreground truncate">{clientInfo.address}</p>
          </div>

          <div className="flex items-end justify-between mb-3">
            <div>
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Total Estimado</span>
              <div className="text-2xl font-bold text-primary tracking-tight">
                ${(totalEstimate + grassCost).toLocaleString()}
              </div>
            </div>
            {grassAreaM2 > 0 && (
              <div className="text-right">
                <span className="text-xs text-muted-foreground block">Incl. pasto IA</span>
                <span className="text-sm text-emerald-700 font-semibold">{grassAreaM2.toFixed(1)} m²</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              onClick={() => setLocation("/design")}
              className="h-11 rounded-xl text-sm bg-background/50 border-border"
            >
              Editar
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={isPending}
              className="h-11 rounded-xl text-sm shadow-lg shadow-primary/20"
            >
              {isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Save className="w-4 h-4 mr-1.5" />}
              Confirmar
            </Button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          PANEL RENDER PREMIUM IA
          Aparece como overlay al hacer clic en "Render IA Premium".
          Módulo completamente independiente — no afecta nada de lo existente.
      ══════════════════════════════════════════════════════════════════════ */}
      {panelOpen && (
        <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center">
          {/* Fondo oscuro */}
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => { if (!aiLoading) setPanelOpen(false); }}
          />

          {/* Panel */}
          <div className="relative w-full sm:max-w-2xl max-h-[92dvh] overflow-y-auto bg-[#0f0f14] border border-violet-500/30 rounded-t-3xl sm:rounded-3xl shadow-2xl shadow-violet-900/40 flex flex-col">

            {/* Header del panel */}
            <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-white/10">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center shadow-lg">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-white">Render Premium IA</h2>
                  <p className="text-xs text-white/50">Fotografía arquitectónica hiperrealista</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => { if (!aiLoading) setPanelOpen(false); }}
                className="text-white/50 hover:text-white hover:bg-white/10 rounded-full"
                disabled={aiLoading}
              >
                <X className="w-5 h-5" />
              </Button>
            </div>

            <div className="px-6 py-5 flex flex-col gap-5">

              {/* Zona de imagen de referencia */}
              <div className="flex flex-col gap-2">
                <label className="text-xs font-semibold text-white/70 uppercase tracking-wider flex items-center gap-1.5">
                  <span>1.</span> Imagen de referencia
                  <span className="text-white/30 font-normal normal-case tracking-normal">(se captura automático si no subes una)</span>
                </label>
                <input
                  ref={aiFileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAiImageUpload}
                />
                {aiRefImage ? (
                  <div className="relative rounded-2xl overflow-hidden border border-violet-500/40 group cursor-pointer"
                    onClick={() => aiFileInputRef.current?.click()}>
                    <img src={aiRefImage} alt="Referencia" className="w-full max-h-48 object-cover" />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <p className="text-white text-xs font-semibold">Cambiar imagen</p>
                    </div>
                    <div className="absolute top-2 right-2">
                      <button
                        onClick={e => { e.stopPropagation(); setAiRefImage(null); }}
                        className="bg-black/60 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs hover:bg-black/80"
                      >×</button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => aiFileInputRef.current?.click()}
                    disabled={aiLoading}
                    className="border-2 border-dashed border-white/15 hover:border-violet-500/50 rounded-2xl p-6 flex flex-col items-center gap-2 text-white/40 hover:text-violet-400 transition-all disabled:opacity-50"
                  >
                    <ImageDown className="w-7 h-7" />
                    <span className="text-xs">Haz clic para subir la captura de tu diseño</span>
                    <span className="text-[11px] text-white/25">Sin imagen: se usa tu diseño actual automáticamente</span>
                  </button>
                )}
              </div>

              {/* ── Plantas detectadas automáticamente del inventario ── */}
              {!aiAdvanced && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white/70 uppercase tracking-wider flex items-center gap-1.5">
                      <span>2.</span> Plantas detectadas en tu diseño
                    </span>
                    <button
                      onClick={autoFillPlants}
                      disabled={aiLoading}
                      className="text-[11px] font-semibold px-3 py-1 rounded-full border border-white/15 text-white/40 hover:border-violet-500/40 hover:text-violet-400 transition-all disabled:opacity-40"
                    >
                      ↺ Actualizar
                    </button>
                  </div>

                  {/* Chips de plantas */}
                  {aiPlants.trim() ? (
                    <div className="flex flex-wrap gap-2 p-3 bg-white/5 rounded-2xl border border-white/10 min-h-[60px]">
                      {aiPlants.trim().split("\n").filter(n => n.trim()).map((name, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[12px] font-medium"
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                          {name.trim()}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="p-4 bg-white/5 rounded-2xl border border-white/10 flex items-center gap-3 text-white/30">
                      <span className="text-xl">🌿</span>
                      <p className="text-[12px]">No hay plantas en el diseño todavía. Coloca plantas desde el inventario y vuelve aquí.</p>
                    </div>
                  )}

                  {/* Explicación del flujo */}
                  <div className="flex gap-2 p-3 bg-violet-500/8 rounded-xl border border-violet-500/20">
                    <span className="text-violet-400 text-sm shrink-0">✦</span>
                    <p className="text-[11px] text-violet-300/70 leading-relaxed">
                      <strong className="text-violet-300">Plantas 100% intactas.</strong> La IA solo renderiza el fondo (pasto, paredes, cielo). Tus plantas originales se compositan encima exactamente donde las colocaste — sin moverlas ni cambiarlas.
                    </p>
                  </div>
                </div>
              )}

              {/* Toggle Conservador / Creativo */}
              {!aiAdvanced && (
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-white/70 uppercase tracking-wider flex items-center gap-1.5">
                    <span>3.</span> Modo de render
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setRenderMode("conservador")}
                      disabled={aiLoading}
                      className={`h-16 rounded-2xl flex flex-col items-center justify-center gap-1 border transition-all disabled:opacity-40 ${
                        renderMode === "conservador"
                          ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                          : "border-white/10 bg-white/5 text-white/40 hover:border-white/20 hover:text-white/60"
                      }`}
                    >
                      <span className="text-lg">🎯</span>
                      <span className="text-[11px] font-semibold">Conservador</span>
                      <span className="text-[10px] opacity-60">Fiel al diseño</span>
                    </button>
                    <button
                      onClick={() => setRenderMode("creativo")}
                      disabled={aiLoading}
                      className={`h-16 rounded-2xl flex flex-col items-center justify-center gap-1 border transition-all disabled:opacity-40 ${
                        renderMode === "creativo"
                          ? "border-amber-500/60 bg-amber-500/15 text-amber-300"
                          : "border-white/10 bg-white/5 text-white/40 hover:border-white/20 hover:text-white/60"
                      }`}
                    >
                      <span className="text-lg">✨</span>
                      <span className="text-[11px] font-semibold">Creativo</span>
                      <span className="text-[10px] opacity-60">Más cinematográfico</span>
                    </button>
                  </div>
                  <p className="text-[11px] text-white/30 px-1">
                    {renderMode === "conservador"
                      ? "La IA respeta el fondo exacto y no agrega elementos."
                      : "La IA interpreta con más libertad — posible atmósfera más dramática."}
                  </p>
                </div>
              )}

              {/* Toggle modo avanzado */}
              <div className="flex justify-end">
                <button
                  onClick={() => setAiAdvanced(v => !v)}
                  disabled={aiLoading}
                  className={`text-[11px] font-semibold px-3 py-1 rounded-full border transition-all disabled:opacity-40 ${
                    aiAdvanced
                      ? "border-violet-500/60 text-violet-300 bg-violet-500/15"
                      : "border-white/15 text-white/40 hover:border-violet-500/40 hover:text-violet-400 bg-transparent"
                  }`}
                >
                  {aiAdvanced ? "✦ Prompt personalizado ON" : "Prompt personalizado (avanzado)"}
                </button>
              </div>

              {/* Modo avanzado — prompt completo personalizado */}
              {aiAdvanced && (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={aiCustomPrompt}
                    onChange={e => setAiCustomPrompt(e.target.value)}
                    rows={8}
                    disabled={aiLoading}
                    placeholder="Pega aquí tu prompt completo en inglés o español…"
                    className="w-full bg-white/5 border border-violet-500/30 rounded-2xl px-4 py-3 text-sm text-white placeholder:text-white/20 resize-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all disabled:opacity-50 leading-relaxed font-mono"
                  />
                  <p className="text-[11px] text-violet-400/60 px-1">
                    ✦ Prompt avanzado — tienes control total sobre lo que la IA recibe.
                  </p>
                </div>
              )}

              {/* Botón generar */}
              <Button
                onClick={() => handleMagazineRender()}
                disabled={aiLoading}
                className="h-12 rounded-2xl text-sm font-semibold gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white border-0 shadow-lg shadow-violet-900/50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {aiLoading
                  ? <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      {aiStep || "Generando render… puede tomar 1-2 min"}
                    </>
                  : <>
                      <Sparkles className="w-5 h-5" />
                      Generar Render Hiperrealista
                    </>
                }
              </Button>

              {/* Resultado */}
              {aiImage && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-px bg-white/10" />
                    <span className="text-xs text-white/40 px-2">Resultado</span>
                    <div className="flex-1 h-px bg-white/10" />
                  </div>

                  {/* Imagen generada */}
                  <div className="relative rounded-2xl overflow-hidden border border-violet-500/30 shadow-xl shadow-violet-900/30">
                    <img
                      src={aiImage}
                      alt="Render Premium IA"
                      className="w-full object-cover"
                    />
                    {/* Badge premium */}
                    <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-sm border border-violet-500/40 rounded-full px-3 py-1 flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 text-violet-400" />
                      <span className="text-[10px] text-violet-300 font-semibold tracking-wide">RENDER IA PREMIUM</span>
                    </div>
                  </div>

                  {/* Botones de acción */}
                  <div className="grid grid-cols-2 gap-3">
                    <Button
                      onClick={handleDownloadAi}
                      className="h-11 rounded-2xl text-sm gap-2 bg-white text-black hover:bg-white/90 font-semibold"
                    >
                      <ImageDown className="w-4 h-4" />
                      Descargar Render
                    </Button>
                    {canFreeRetry ? (
                      <Button
                        onClick={() => handleMagazineRender(true)}
                        variant="outline"
                        className="h-11 rounded-2xl text-sm gap-2 border-amber-500/50 text-amber-300 hover:bg-amber-500/10 font-semibold"
                      >
                        ↺ Regenerar gratis
                      </Button>
                    ) : (
                      <Button
                        onClick={() => { setAiImage(null); }}
                        variant="outline"
                        className="h-11 rounded-2xl text-sm gap-2 border-white/20 text-white hover:bg-white/10"
                      >
                        Generar otro
                      </Button>
                    )}
                  </div>
                  {canFreeRetry && (
                    <p className="text-center text-[11px] text-amber-400/60">
                      ✦ 1 regeneración gratis disponible — expira en 5 min
                    </p>
                  )}
                </div>
              )}

            </div>
          </div>
        </div>
      )}

    </div>
  );
}
