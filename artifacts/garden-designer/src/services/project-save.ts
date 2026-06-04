/**
 * project-save.ts — Servicio centralizado de guardado de proyectos.
 *
 * Capas de persistencia:
 *   1. localStorage  — inmediato, backup local siempre disponible
 *   2. API (Postgres) — persistencia real en la base de datos
 *
 * El campo `designData` del API almacena un JSON con TODO el estado del diseño:
 *   designItems, materialCosts, pricePerM2, grassAreaM2, cadPolygons, cadXform
 *
 * La gardenImage (base64, pesada) solo se envía al API en guardado manual,
 * no en cada autosave, para mantener el autoguardado rápido y liviano.
 */

import type {
  DesignItem,
  MaterialCost,
  CadPolygon,
  CadTransform,
  ClientInfo,
} from "@/context/app-context";
import { authHeaders } from "./auth";

// ─── Constantes ───────────────────────────────────────────────────────────────
const LS_BACKUP_KEY  = "urbanai_project_backup";
const LS_VERSION_KEY = "urbanai_project_version";
const API_BASE       = "";

// ─── Tipos ────────────────────────────────────────────────────────────────────
export interface ProjectSavePayload {
  version:    number;
  savedAt:    string;
  projectId:  number | null;

  clientName:    string;
  clientPhone:   string;
  clientAddress: string;

  /** designItems SIN imageData — las imágenes se cargan del inventario */
  designItems:     Array<Omit<DesignItem, "imageData">>;
  materialCosts:   MaterialCost[];
  pricePerM2:      number;
  grassAreaM2:     number;
  activeMaterialId: string;

  cadPolygons: CadPolygon[];
  cadXform:    CadTransform;

  totalProjectCost: number;
}

// ─── Versión ──────────────────────────────────────────────────────────────────
export function getCurrentVersion(): number {
  try {
    return parseInt(localStorage.getItem(LS_VERSION_KEY) ?? "0", 10) || 0;
  } catch {
    return 0;
  }
}

// ─── Serialización ────────────────────────────────────────────────────────────
export function serializeState(params: {
  projectId:        number | null;
  clientInfo:       ClientInfo | null;
  designItems:      DesignItem[];
  materialCosts:    MaterialCost[];
  pricePerM2:       number;
  grassAreaM2:      number;
  activeMaterialId: string;
  cadPolygons:      CadPolygon[];
  cadXform:         CadTransform;
  totalProjectCost: number;
}): ProjectSavePayload {
  return {
    version:          getCurrentVersion() + 1,
    savedAt:          new Date().toISOString(),
    projectId:        params.projectId,
    clientName:       params.clientInfo?.name     ?? "",
    clientPhone:      params.clientInfo?.phone    ?? "",
    clientAddress:    params.clientInfo?.address  ?? "",
    // Strip imageData — puede ser varios MB por elemento
    designItems:      params.designItems.map(({ imageData: _img, ...rest }) => rest),
    materialCosts:    params.materialCosts,
    pricePerM2:       params.pricePerM2,
    grassAreaM2:      params.grassAreaM2,
    activeMaterialId: params.activeMaterialId,
    cadPolygons:      params.cadPolygons,
    cadXform:         params.cadXform,
    totalProjectCost: params.totalProjectCost,
  };
}

// ─── localStorage ─────────────────────────────────────────────────────────────
export function saveToLocalStorage(payload: ProjectSavePayload): void {
  try {
    localStorage.setItem(LS_BACKUP_KEY,  JSON.stringify(payload));
    localStorage.setItem(LS_VERSION_KEY, String(payload.version));
  } catch (err) {
    console.error("[ProjectSave] localStorage error:", err);
  }
}

export function loadFromLocalStorage(): ProjectSavePayload | null {
  try {
    const raw = localStorage.getItem(LS_BACKUP_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ProjectSavePayload;
  } catch {
    return null;
  }
}

// ─── API ──────────────────────────────────────────────────────────────────────
/**
 * Guarda el proyecto en el backend.
 * @param payload   Estado serializado
 * @param gardenImage Base64 de la imagen — solo incluir en guardado manual
 * @returns         El projectId (existente o recién creado)
 */
export async function saveToApi(
  payload:     ProjectSavePayload,
  gardenImage?: string | null
): Promise<number> {
  const designDataJson = JSON.stringify({
    version:          payload.version,
    designItems:      payload.designItems,
    materialCosts:    payload.materialCosts,
    pricePerM2:       payload.pricePerM2,
    grassAreaM2:      payload.grassAreaM2,
    activeMaterialId: payload.activeMaterialId,
    cadPolygons:      payload.cadPolygons,
    cadXform:         payload.cadXform,
  });

  // gardenImageData is optional — only include when explicitly passing an image
  // (Zod schema accepts string | undefined, but NOT null)
  const body: Record<string, unknown> = {
    clientName:    payload.clientName,
    clientPhone:   payload.clientPhone,
    clientAddress: payload.clientAddress,
    designData:    designDataJson,
    totalEstimate: payload.totalProjectCost,
  };
  if (gardenImage) {
    body.gardenImageData = gardenImage;
  }

  if (payload.projectId) {
    const res = await fetch(`${API_BASE}/api/projects/${payload.projectId}`, {
      method:      "PATCH",
      headers:     { "Content-Type": "application/json", ...authHeaders() },
      credentials: "include",
      body:        JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API PATCH /projects error ${res.status}`);
    return payload.projectId;
  } else {
    const res = await fetch(`${API_BASE}/api/projects`, {
      method:      "POST",
      headers:     { "Content-Type": "application/json", ...authHeaders() },
      credentials: "include",
      body:        JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API POST /projects error ${res.status}`);
    const data = await res.json();
    return (data.project?.id ?? data.id) as number;
  }
}

/**
 * Carga el proyecto desde el backend y devuelve el payload deserializado.
 * Devuelve null si el proyecto no existe o falla la red.
 */
export async function loadFromApi(
  projectId: number
): Promise<ProjectSavePayload | null> {
  try {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}`, {
      headers:     authHeaders(),
      credentials: "include",
    });
    if (!res.ok) return null;
    const project = await res.json();

    let dd: any = {};
    try {
      dd = project.designData ? JSON.parse(project.designData) : {};
    } catch { /* malformed JSON — use defaults */ }

    return {
      version:          dd.version         ?? 0,
      savedAt:          project.updatedAt,
      projectId:        project.id,
      clientName:       project.clientName  ?? "",
      clientPhone:      project.clientPhone ?? "",
      clientAddress:    project.clientAddress ?? "",
      designItems:      dd.designItems      ?? [],
      materialCosts:    dd.materialCosts    ?? [],
      pricePerM2:       dd.pricePerM2       ?? 150,
      grassAreaM2:      dd.grassAreaM2      ?? 0,
      activeMaterialId: dd.activeMaterialId ?? "grass",
      cadPolygons:      dd.cadPolygons      ?? [],
      cadXform:         dd.cadXform         ?? { scale: 1, tx: 0, ty: 0 },
      totalProjectCost: Number(project.totalEstimate) ?? 0,
    };
  } catch {
    return null;
  }
}

// ─── Formato tiempo relativo ───────────────────────────────────────────────────
export function formatRelativeTime(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 5)   return "ahora mismo";
  if (diff < 60)  return `hace ${diff}s`;
  const mins = Math.floor(diff / 60);
  if (mins < 60)  return `hace ${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `hace ${hrs}h`;
}
