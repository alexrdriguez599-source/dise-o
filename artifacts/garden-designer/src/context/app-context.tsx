import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { nanoid } from 'nanoid';
import { useOnlineStatus } from '../hooks/use-online-status';
import {
  cacheInventory,
  getCachedInventory,
  saveGardenImage,
  saveLocalProject,
  enqueueSyncEntry,
  type CachedInventoryItem,
} from '../services/offline-storage';

export interface DesignItem {
  id: string;
  inventoryItemId: number | string;
  name: string;
  imageData: string | null;
  price: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  /** 3-D tilt: inclinación en eje X (adelante/atrás), en radianes. 0 = plano. */
  tiltX?: number;
  /** 3-D tilt: inclinación en eje Y (izquierda/derecha), en radianes. 0 = plano. */
  tiltY?: number;
  /** BOM quantity (number of units). Present when item was added from a design plan. */
  quantity?: number;
  /** BOM unit price (price per individual unit). Present when item was added from a design plan. */
  unitPrice?: number;
  /** Source tag — 'bom' when auto-added from design-plan BOM, undefined otherwise. */
  source?: "bom" | string;
  /** Profundidad visual (solo referencia — igual a y en el momento de colocar). */
  depth?: number;
  /** Si true: posición y escala son exactamente las del usuario — sin auto-ajuste. */
  lockPosition?: boolean;
  /** Fracción del ancho para la hitbox de selección (default 0.35). */
  hitScale?: number;
  /** Offset vertical en px — ajuste fino para PNGs mal recortados. */
  baseOffset?: number;
}

export interface ClientInfo {
  name: string;
  phone: string;
  address: string;
}

export interface Material {
  id: string;
  name: string;
  type: string;
  prompt: string;
  negativePrompt: string;
  pricePerM2: number;
  enabled: boolean;
  textureUrl?: string;
  /** Matches inventory item name (case-insensitive) to sync pricePerM2 from inventory */
  inventorySlug?: string;
}

export interface MaterialCost {
  materialId: string;
  materialName: string;
  areaM2: number;
  /** Perimeter in metres (for length-based materials) */
  perimeterM?: number;
  /** "area" = per m², "length" = per linear metre */
  unitType?: "area" | "length";
  pricePerM2: number;
  total: number;
}

// ── Materiales reales disponibles en México ───────────────────────────────────
// Precios aproximados en MXN/m². Basado en viveros y constructoras de CDMX/GDL/MTY.
const DEFAULT_MATERIALS: Material[] = [
  {
    id: "grass",
    name: "Pasto natural",
    type: "grass",
    prompt: "Photorealistic lush green Mexican garden lawn filling the masked area only. Well-maintained mowed grass, rich varied green tones, warm afternoon sunlight casting soft shadows, realistic natural grass texture at ground level. Seamlessly blends with surrounding environment. Ultra-sharp photo quality.",
    negativePrompt: "concrete, pavement, tiles, stone, gravel, dirt, mud, artificial turf, furniture, objects, blur, illustration, painting, oversaturated, cartoon, watermark",
    pricePerM2: 150,
    enabled: true,
  },
  {
    // Piedra bola blanca / canto rodado blanco — muy común en jardines MX, 6-14cm
    id: "white-stone",
    name: "Piedra bola blanca",
    type: "stone",
    prompt: "Photorealistic ground cover of smooth round white river stones (piedra bola blanca / canto rodado blanco), each stone naturally polished by water, 6–14 cm diameter per individual stone, densely packed with tiny gaps between them, subtle drop shadows on contact points, warm Mexican garden daylight, shot from above at 45°. Individual stones clearly visible and distinct. Ultra-sharp macro photo, no digital art, no filters.",
    negativePrompt: "grass, plants, concrete, tile, flat texture, uniform white, illustration, blur, cartoon, painting, digital art, single big stone, pebbles smaller than 5cm, gravel dust, oversaturated, watermark",
    pricePerM2: 320,
    enabled: true,
    inventorySlug: "piedra bola blanca",
  },
  {
    // Piedra bola gris / canto rodado gris — 6-14cm
    id: "grey-stone",
    name: "Piedra bola gris",
    type: "stone",
    prompt: "Photorealistic ground cover of smooth round gray river stones (piedra bola gris / canto rodado gris), naturally water-polished, 6–14 cm diameter per stone, medium gray with slight natural color variation (charcoal, silver, slate), densely packed, realistic shadows between stones, Mexican garden outdoor sunlight. Each stone individually visible. Ultra-sharp photo quality, no filters.",
    negativePrompt: "grass, plants, concrete, tile, flat texture, illustration, blur, cartoon, painting, digital art, white stones, black stones, pebbles smaller than 5cm, gravel, oversaturated, watermark",
    pricePerM2: 290,
    enabled: true,
    inventorySlug: "piedra bola gris",
  },
  {
    // Tezontle rojo — piedra volcánica icónica de México, muy económica, 3-10cm
    id: "red-stone",
    name: "Tezontle rojo",
    type: "stone",
    prompt: "Photorealistic ground cover of red tezontle volcanic stone (tezontle rojo), iconic Mexican volcanic rock, irregular rough chunks 3–10 cm each, deep terracotta-red to dark rust-red porous surface, naturally matte finish, densely packed, warm outdoor Mexican garden sunlight. Ultra-realistic photo, individual pieces clearly distinguishable. No flat illustration, no digital art.",
    negativePrompt: "grass, plants, concrete, smooth stones, river rocks, polished stones, neon red, pink, flat overlay, illustration, blur, cartoon, painting, digital art, oversaturated, gravel dust, watermark",
    pricePerM2: 220,
    enabled: true,
    inventorySlug: "tezontle rojo",
  },
  {
    // Tezontle negro — volcánico oscuro mexicano, 3-8cm
    id: "black-stone",
    name: "Tezontle negro",
    type: "stone",
    prompt: "Photorealistic ground cover of black tezontle volcanic stone (tezontle negro / basalto volcánico), Mexican dark volcanic rock, rough porous irregular chunks 3–8 cm each, very dark gray to matte black color, lightly textured surface, densely packed, outdoor garden lighting with natural highlights. Ultra-realistic photo, individual pieces visible. No flat illustration.",
    negativePrompt: "grass, plants, concrete, smooth polished stones, colored stones, flat overlay, illustration, blur, cartoon, painting, digital art, oversaturated, river rocks, shiny, metallic, watermark",
    pricePerM2: 250,
    enabled: true,
    inventorySlug: "tezontle negro",
  },
  {
    // Mármol blanco triturado — muy popular en jardines de lujo en México, 1-3cm
    id: "marble",
    name: "Mármol blanco triturado",
    type: "stone",
    prompt: "Photorealistic ground cover of crushed white marble chips (mármol blanco triturado), angular and sharp-edged pieces 1–3 cm each, bright white with subtle gray veins and translucent quality, densely and uniformly packed, luxury upscale Mexican garden, bright outdoor sunlight creating sparkle and micro-shadows. Ultra-sharp macro photo, premium clean look. No flat illustration.",
    negativePrompt: "grass, plants, concrete, round smooth stones, river rocks, gravel, soil, yellow, beige, flat overlay, illustration, blur, cartoon, painting, digital art, oversaturated, dirty, watermark",
    pricePerM2: 420,
    enabled: true,
    inventorySlug: "marmol blanco",
  },
  {
    // Grava de río fina — 1-3cm, caminos y arriates
    id: "gravel",
    name: "Grava de río",
    type: "gravel",
    prompt: "Photorealistic ground cover of fine river gravel (grava de río fina), small rounded pebbles 1–3 cm diameter, natural sandy-beige and gray tones with warm color variation, uniformly and tightly packed, smooth natural garden path texture, warm outdoor Mexican sunlight. Ultra-sharp photo quality, seamless texture.",
    negativePrompt: "grass, plants, concrete, large rocks, tile, flat overlay, illustration, blur, cartoon, painting, digital art, oversaturated, dust, mud, watermark",
    pricePerM2: 200,
    enabled: true,
    inventorySlug: "grava",
  },
  {
    id: "soil",
    name: "Tierra natural",
    type: "soil",
    prompt: "Photorealistic natural garden soil filling the masked area, clean slightly moist dark brown earth, flat garden ground ready for planting, realistic soil texture with small natural crumbles, warm Mexican outdoor light. Seamless with surroundings. No objects on surface.",
    negativePrompt: "grass, concrete, gravel, stone, mud puddles, indoor, furniture, illustration, blur, painting, oversaturated, watermark",
    pricePerM2: 80,
    enabled: true,
  },
  {
    id: "mulch",
    name: "Mulch de madera",
    type: "mulch",
    prompt: "Photorealistic natural wood chip mulch ground cover filling the masked area, organic brown bark chips and wood shavings 3–8 cm, warm earthy brown tones with natural variation, garden bed surface, realistic outdoor Mexican garden lighting. Ultra-sharp photo quality.",
    negativePrompt: "concrete, grass, stone, indoor, furniture, illustration, blur, painting, oversaturated, colored mulch, watermark",
    pricePerM2: 160,
    enabled: true,
  },
  {
    id: "concrete",
    name: "Concreto / Adoquín",
    type: "concrete",
    prompt: "Photorealistic smooth clean light gray concrete floor filling the masked area, flat and uniform hardscape surface, modern Mexican garden patio or walkway, slightly textured concrete finish, outdoor ambient lighting matching surroundings. Ultra-sharp photo quality, no cracks.",
    negativePrompt: "grass, dirt, gravel, stone, indoor, furniture, objects, illustration, blur, painting, oversaturated, cracks, watermark",
    pricePerM2: 480,
    enabled: true,
  },
];

// ── CAD persistent state types ────────────────────────────────────────────────
/** Polygon zone drawn in the CAD canvas. Mirrors LocalPolygon in cad-designer.tsx. */
export interface CadPolygon {
  id: string;
  points: { x: number; y: number }[];
  materialId: string;
  closed: boolean;
  label: string;
  aiApplied?: boolean;
  poolType?: "pool";
  poolDepth?: number;
  parentZoneId?: string;
}

/** Camera transform (zoom + pan) for the CAD canvas. */
export interface CadTransform {
  scale: number;
  tx: number;
  ty: number;
}

export interface AppState {
  clientInfo: ClientInfo | null;
  setClientInfo: (info: ClientInfo | null) => void;
  gardenImage: string | null;
  setGardenImage: (img: string | null) => void;
  /** Push current gardenImage onto the undo stack AND set the new result image.
   *  Pass newImage to atomically save-old + set-new without clearing history. */
  pushGardenImageToHistory: (newImage?: string) => void;
  /** Undo: restore the previous gardenImage from history */
  undoGardenImage: () => void;
  /** Restore: jump all the way back to the very first (original) image */
  restoreOriginalImage: () => void;
  /** True when there are images to undo back to */
  canUndo: boolean;
  /** Number of steps available to undo */
  imageHistoryCount: number;
  designItems: DesignItem[];
  addDesignItem: (item: Omit<DesignItem, 'id'>) => void;
  removeDesignItem: (id: string) => void;
  updateDesignItem: (id: string, updates: Partial<DesignItem>) => void;
  clearDesignItems: () => void;
  restoreDesignItems: (items: Omit<DesignItem, 'imageData'>[]) => void;
  projectId: number | null;
  setProjectId: (id: number | null) => void;
  totalEstimate: number;
  pricePerM2: number;
  setPricePerM2: (price: number) => void;
  grassAreaM2: number;
  setGrassAreaM2: (area: number) => void;
  grassCost: number;
  materials: Material[];
  setMaterials: (materials: Material[]) => void;
  updateMaterial: (id: string, updates: Partial<Material>) => void;
  activeMaterialId: string;
  setActiveMaterialId: (id: string) => void;
  materialCosts: MaterialCost[];
  addMaterialCost: (cost: MaterialCost) => void;
  clearMaterialCosts: () => void;
  totalMaterialCost: number;
  totalProjectCost: number;
  isOnline: boolean;
  cachedInventory: CachedInventoryItem[];
  inventoryLoading: boolean;
  saveProjectLocally: () => Promise<void>;
  /** Global toggle: show plant/zone names always vs. only on hover/select */
  showLabels: boolean;
  setShowLabels: (v: boolean) => void;
  /** CAD canvas: polygon zones — persisted globally so they survive module navigation */
  cadPolygons: CadPolygon[];
  setCadPolygons: React.Dispatch<React.SetStateAction<CadPolygon[]>>;
  /** CAD canvas: zoom/pan transform — persisted globally so view is restored on return */
  cadXform: CadTransform;
  setCadXform: React.Dispatch<React.SetStateAction<CadTransform>>;
}

const AppContext = createContext<AppState | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  // One-time migration: remove old persisted designItems that lack imageData (caused phantom boxes)
  React.useEffect(() => {
    localStorage.removeItem('garden_designItems');
  }, []);
  const { isOnline } = useOnlineStatus();
  const [cachedInventory, setCachedInventory] = useState<CachedInventoryItem[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [showLabels, setShowLabelsState] = useState<boolean>(() => {
    try { return localStorage.getItem("garden_showLabels") !== "false"; } catch { return true; }
  });
  const setShowLabels = useCallback((v: boolean) => {
    setShowLabelsState(v);
    try { localStorage.setItem("garden_showLabels", String(v)); } catch { /* noop */ }
  }, []);

  const [clientInfo, setClientInfoState] = useState<ClientInfo | null>(null);

  // gardenImage is stored in IndexedDB (never in localStorage — too large for quota).
  // Always start fresh; image is restored when the user loads a project from the API.
  const [gardenImage, setGardenImageState] = useState<string | null>(null);

  // ─── Image undo history (in-memory only — images are too large for localStorage) ───
  const [imageHistory, setImageHistory] = useState<string[]>([]);

  const pushGardenImageToHistory = useCallback((newImage?: string) => {
    setGardenImageState(current => {
      if (current) {
        setImageHistory(prev => [...prev.slice(-9), current]); // keep up to 10 steps
      }
      // If a newImage is provided, set it atomically — history is NOT cleared.
      // This lets AI operations be undoable via undoGardenImage().
      return newImage !== undefined ? newImage : current;
    });
  }, []);

  const undoGardenImage = useCallback(() => {
    setImageHistory(prev => {
      if (prev.length === 0) return prev;
      const previous = prev[prev.length - 1];
      setGardenImageState(previous);
      return prev.slice(0, -1);
    });
  }, []);

  const restoreOriginalImage = useCallback(() => {
    setImageHistory(prev => {
      if (prev.length === 0) return prev; // already at original
      const original = prev[0]; // oldest push = original photo
      setGardenImageState(original);
      return []; // clear all history — we're back at the start
    });
  }, []);

  const setGardenImage = useCallback((img: string | null) => {
    // A fresh image upload/clear resets history
    setImageHistory([]);
    setGardenImageState(img);
  }, []);

  // designItems are NOT persisted — they strip imageData on save making them useless (phantom boxes)
  const [designItems, setDesignItemsState] = useState<DesignItem[]>([]);

  // CAD canvas state — persisted in memory so zones and view survive module navigation
  const [cadPolygons, setCadPolygons] = useState<CadPolygon[]>([]);
  const [cadXform, setCadXform] = useState<CadTransform>({ scale: 1, tx: 0, ty: 0 });

  const [projectId, setProjectIdState] = useState<number | null>(() => {
    const saved = localStorage.getItem('garden_projectId');
    return saved ? Number(saved) : null;
  });

  const [pricePerM2, setPricePerM2State] = useState<number>(() => {
    const saved = localStorage.getItem('garden_pricePerM2');
    return saved ? Number(saved) : 150;
  });

  const [grassAreaM2, setGrassAreaM2State] = useState<number>(() => {
    const saved = localStorage.getItem('garden_grassAreaM2');
    return saved ? Number(saved) : 0;
  });

  const [materials, setMaterialsState] = useState<Material[]>(() => {
    const saved = localStorage.getItem('garden_materials');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Material[];
        const existingIds = new Set(parsed.map(m => m.id));
        const merged = [...parsed];
        let added = false;
        for (const dm of DEFAULT_MATERIALS) {
          if (!existingIds.has(dm.id)) { merged.push(dm); added = true; }
        }
        for (const m of merged) {
          const def = DEFAULT_MATERIALS.find(d => d.id === m.id);
          if (def && def.textureUrl && m.textureUrl !== def.textureUrl) m.textureUrl = def.textureUrl;
          if (def && m.prompt !== def.prompt) m.prompt = def.prompt;
          if (def && m.negativePrompt !== def.negativePrompt) m.negativePrompt = def.negativePrompt;
          if (def && def.inventorySlug !== undefined && m.inventorySlug !== def.inventorySlug) m.inventorySlug = def.inventorySlug;
        }
        try { localStorage.setItem('garden_materials', JSON.stringify(merged)); } catch { /**/ }
        return merged;
      } catch { return DEFAULT_MATERIALS; }
    }
    return DEFAULT_MATERIALS;
  });

  const [activeMaterialId, setActiveMaterialIdState] = useState<string>(() => {
    return localStorage.getItem('garden_activeMaterial') || 'grass';
  });

  const [materialCosts, setMaterialCosts] = useState<MaterialCost[]>(() => {
    const saved = localStorage.getItem('garden_materialCosts');
    return saved ? JSON.parse(saved) : [];
  });

  const safeSave = (key: string, value: string) => {
    try { localStorage.setItem(key, value); } catch { /* quota exceeded — skip silently */ }
  };

  // ─── Sync material prices from inventory ───────────────────────
  // Online: fetch from API, cache to IndexedDB.
  // Offline: serve from IndexedDB cache.
  useEffect(() => {
    const applyInventoryPrices = (items: CachedInventoryItem[]) => {
      setCachedInventory(items);
      setMaterialsState(prev => prev.map(mat => {
        if (!mat.inventorySlug) return mat;
        const slug = mat.inventorySlug.toLowerCase();
        const inv = items.find(i =>
          i.category === 'material' && i.name.toLowerCase().includes(slug)
        );
        if (!inv || !inv.price) return mat;
        const price = Number(inv.price);
        if (!price || price === mat.pricePerM2) return mat;
        return { ...mat, pricePerM2: price };
      }));
    };

    if (navigator.onLine) {
      setInventoryLoading(true);
      fetch('/api/inventory', { credentials: 'include', headers: ((): Record<string, string> => { const t = localStorage.getItem("urbanai_token"); const h: Record<string, string> = {}; if (t) h.Authorization = "Bearer " + t; return h; })() })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
        .then(async (body: any) => {
          // API returns { items: [...] } — extract the array defensively
          const items: CachedInventoryItem[] | null = body
            ? (Array.isArray(body) ? body : (body.items ?? body.data ?? []))
            : null;
          if (!items) {
            const cached = await getCachedInventory();
            if (cached) applyInventoryPrices(cached);
          } else {
            applyInventoryPrices(items);
            cacheInventory(items).catch(() => {});
          }
        })
        .finally(() => setInventoryLoading(false));
    } else {
      getCachedInventory().then(cached => {
        if (cached) applyInventoryPrices(cached);
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (clientInfo) safeSave('garden_clientInfo', JSON.stringify(clientInfo));
    else localStorage.removeItem('garden_clientInfo');
  }, [clientInfo]);

  useEffect(() => {
    // gardenImage is too large for localStorage; persist to IndexedDB instead.
    // Uses a stable key based on projectId (or 'current' for unsaved projects).
    const key = projectId !== null ? `project_${projectId}` : 'current';
    if (gardenImage) {
      saveGardenImage(key, gardenImage).catch(() => {});
    }
  }, [gardenImage, projectId]);

  // designItems intentionally not persisted — imageData stripped = phantom boxes on reload

  useEffect(() => {
    if (projectId !== null) safeSave('garden_projectId', projectId.toString());
    else localStorage.removeItem('garden_projectId');
  }, [projectId]);

  useEffect(() => {
    safeSave('garden_pricePerM2', pricePerM2.toString());
  }, [pricePerM2]);

  useEffect(() => {
    safeSave('garden_grassAreaM2', grassAreaM2.toString());
  }, [grassAreaM2]);

  useEffect(() => {
    safeSave('garden_materials', JSON.stringify(materials));
  }, [materials]);

  useEffect(() => {
    safeSave('garden_activeMaterial', activeMaterialId);
  }, [activeMaterialId]);

  useEffect(() => {
    safeSave('garden_materialCosts', JSON.stringify(materialCosts));
  }, [materialCosts]);

  const addDesignItem = (item: Omit<DesignItem, 'id'>) => {
    setDesignItemsState(prev => [...prev, { ...item, id: nanoid() }]);
  };

  const removeDesignItem = (id: string) => {
    setDesignItemsState(prev => prev.filter(i => i.id !== id));
  };

  const updateDesignItem = (id: string, updates: Partial<DesignItem>) => {
    setDesignItemsState(prev => prev.map(i => i.id === id ? { ...i, ...updates } : i));
  };

  const clearDesignItems = () => {
    setDesignItemsState([]);
  };

  const restoreDesignItems = (items: Omit<DesignItem, 'imageData'>[]) => {
    setDesignItemsState(items.map(i => ({ ...i, imageData: null })));
  };

  const updateMaterial = useCallback((id: string, updates: Partial<Material>) => {
    setMaterialsState(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m));
  }, []);

  const addMaterialCost = useCallback((cost: MaterialCost) => {
    setMaterialCosts(prev => [...prev, cost]);
  }, []);

  const clearMaterialCosts = useCallback(() => {
    setMaterialCosts([]);
  }, []);

  // ─── Save project locally for offline access ─────────────────────────────
  const saveProjectLocally = useCallback(async () => {
    const localId = projectId ? `project_${projectId}` : `local_${nanoid()}`;

    const localProject = {
      id: localId,
      clientName: clientInfo?.name ?? '',
      clientPhone: clientInfo?.phone ?? '',
      clientAddress: clientInfo?.address ?? '',
      designItems,
      polygons: [],
      gardenImageKey: localId,
      pricePerM2,
      grassAreaM2,
      materialCosts,
      serverProjectId: projectId,
      savedAt: Date.now(),
      pendingSync: !navigator.onLine,
    };

    await saveLocalProject(localProject);

    if (!navigator.onLine) {
      await enqueueSyncEntry({
        localProjectId: localId,
        serverProjectId: projectId,
        payload: {
          clientName: clientInfo?.name,
          clientPhone: clientInfo?.phone,
          clientAddress: clientInfo?.address,
          designData: JSON.stringify(designItems),
        },
        addedAt: Date.now(),
      });
    }
  }, [clientInfo, designItems, projectId, pricePerM2, grassAreaM2, materialCosts]);

  const totalEstimate = designItems.reduce((acc, item) => acc + (Number(item.price) || 0), 0);
  const grassCost = grassAreaM2 * pricePerM2;
  const totalMaterialCost = materialCosts.reduce((acc, c) => acc + c.total, 0);
  const totalProjectCost = totalEstimate + totalMaterialCost;

  return (
    <AppContext.Provider value={{
      clientInfo,
      setClientInfo: setClientInfoState,
      gardenImage,
      setGardenImage,
      pushGardenImageToHistory,
      undoGardenImage,
      restoreOriginalImage,
      canUndo: imageHistory.length > 0,
      imageHistoryCount: imageHistory.length,
      designItems,
      addDesignItem,
      removeDesignItem,
      updateDesignItem,
      clearDesignItems,
      restoreDesignItems,
      projectId,
      setProjectId: setProjectIdState,
      totalEstimate,
      pricePerM2,
      setPricePerM2: setPricePerM2State,
      grassAreaM2,
      setGrassAreaM2: setGrassAreaM2State,
      grassCost,
      materials,
      setMaterials: setMaterialsState,
      updateMaterial,
      activeMaterialId,
      setActiveMaterialId: setActiveMaterialIdState,
      materialCosts,
      addMaterialCost,
      clearMaterialCosts,
      totalMaterialCost,
      totalProjectCost,
      isOnline,
      cachedInventory,
      inventoryLoading,
      saveProjectLocally,
      showLabels,
      setShowLabels,
      cadPolygons,
      setCadPolygons,
      cadXform,
      setCadXform,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
}
