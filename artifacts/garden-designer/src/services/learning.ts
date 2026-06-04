import { authHeaders } from "./auth";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface LearningEventInput {
  eventType: "design_generated" | "plant_accepted" | "material_applied";
  inventoryItemId?: number | null;
  itemName?: string | null;
  itemType?: string | null;
  materialId?: string | null;
  style?: string | null;
  areaM2?: number | null;
  quantity?: number | null;
}

export interface UserProfile {
  totalDesigns: number;
  topPlants: Array<{ itemId: number; name: string; type: string; usageCount: number }>;
  topStyles: Array<{ style: string; count: number }>;
  topMaterials: Array<{ materialId: string; count: number }>;
  avgDensityPerM2: number | null;
  summary: string;
}

export async function trackEvents(events: LearningEventInput[]): Promise<void> {
  if (!events.length) return;
  try {
    await fetch(`${BASE}/api/learning`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body:    JSON.stringify(events[0]),
    });
  } catch {
    // Non-fatal
  }
}

export function trackDesignGenerated(style: string, areaM2: number): void {
  trackEvents([{ eventType: "design_generated", style, areaM2 }]);
}

export function trackBOMAccepted(
  bom: Array<{ itemId: number; nombre: string; tipo: string; cantidad: number }>,
  areaM2: number,
): void {
  const events: LearningEventInput[] = bom.map((item) => ({
    eventType: "plant_accepted",
    inventoryItemId: item.itemId,
    itemName: item.nombre,
    itemType: item.tipo,
    quantity: item.cantidad,
    areaM2,
  }));
  trackEvents(events);
}

export function trackMaterialApplied(materialId: string): void {
  trackEvents([{ eventType: "material_applied", materialId }]);
}

export async function fetchUserProfile(): Promise<UserProfile | null> {
  try {
    const res = await fetch(`${BASE}/api/learning`, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json() as UserProfile;
  } catch {
    return null;
  }
}
