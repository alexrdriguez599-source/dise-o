/**
 * useAutoSave — Autoguardado inteligente del proyecto.
 *
 * Flujo:
 *   1. Cada vez que cambia el estado relevante → programa timer de 5 s
 *   2. Al vencer el timer → guarda en localStorage (inmediato) + API (sin imagen)
 *   3. En guardado manual → guarda también la gardenImage en API
 *   4. Si la API falla → dato seguro en localStorage, status = 'error'
 *   5. Si se crea proyecto nuevo → devuelve newProjectId para setProjectId()
 *
 * Status:
 *   idle    — sin cambios pendientes
 *   pending — cambios sin guardar (timer activo)
 *   saving  — guardando ahora
 *   saved   — guardado correctamente
 *   error   — API falló (localStorage aún tiene backup)
 */

import { useEffect, useRef, useCallback, useState } from "react";
import {
  serializeState,
  saveToLocalStorage,
  saveToApi,
  getCurrentVersion,
  formatRelativeTime,
  type ProjectSavePayload,
} from "@/services/project-save";
import type {
  DesignItem,
  MaterialCost,
  CadPolygon,
  CadTransform,
  ClientInfo,
} from "@/context/app-context";

// ─── Tipos ────────────────────────────────────────────────────────────────────
export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export interface AutoSaveState {
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
  gardenImage:      string | null;
}

export interface UseAutoSaveOptions {
  /** ms de debounce (default 5000 = 5 s) */
  debounceMs?: number;
  /** Desactivar autosave (p.ej. sin clientInfo) */
  enabled?: boolean;
  /** Callback cuando se crea un proyecto nuevo (para actualizar projectId en contexto) */
  onNewProject?: (newId: number) => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useAutoSave(
  state:   AutoSaveState,
  options: UseAutoSaveOptions = {}
) {
  const {
    debounceMs  = 5000,
    enabled     = true,
    onNewProject,
  } = options;

  const [status, setStatus]         = useState<SaveStatus>("idle");
  const [lastSaved, setLastSaved]   = useState<Date | null>(null);
  const [savedVersion, setSavedVersion] = useState<number>(getCurrentVersion);
  const [lastSavedLabel, setLastSavedLabel] = useState<string>("");

  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const labelTimer  = useRef<ReturnType<typeof setInterval> | null>(null);
  const stateRef    = useRef(state);
  const isSaving    = useRef(false);

  // Mantener stateRef siempre actualizado
  useEffect(() => { stateRef.current = state; }, [state]);

  // ── Actualizar etiqueta de tiempo relativo ──────────────────────────────────
  useEffect(() => {
    if (!lastSaved) return;
    setLastSavedLabel(formatRelativeTime(lastSaved));
    const id = setInterval(() => {
      setLastSavedLabel(formatRelativeTime(lastSaved));
    }, 15_000);
    labelTimer.current = id;
    return () => clearInterval(id);
  }, [lastSaved]);

  // ── Función de guardado ─────────────────────────────────────────────────────
  const doSave = useCallback(async (includeImage: boolean): Promise<ProjectSavePayload | null> => {
    if (isSaving.current) return null;
    isSaving.current = true;
    setStatus("saving");

    const s = stateRef.current;
    const payload = serializeState(s);

    // 1. localStorage — inmediato, nunca falla visiblemente
    saveToLocalStorage(payload);

    // 2. API
    try {
      const savedId = await saveToApi(
        payload,
        includeImage ? s.gardenImage : undefined
      );

      // Si era proyecto nuevo, notificar al padre
      if (!payload.projectId && savedId) {
        payload.projectId = savedId;
        saveToLocalStorage({ ...payload, projectId: savedId });
        onNewProject?.(savedId);
      }

      setStatus("saved");
      setLastSaved(new Date());
      setSavedVersion(payload.version);
      isSaving.current = false;
      return payload;
    } catch (err) {
      console.error("[AutoSave] API error:", err);
      setStatus("error");
      isSaving.current = false;
      return payload; // datos seguros en localStorage
    }
  }, [onNewProject]);

  // ── Guardado manual (con imagen) ────────────────────────────────────────────
  const manualSave = useCallback(async (): Promise<ProjectSavePayload | null> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return doSave(true);
  }, [doSave]);

  // ── Programar autoguardado ──────────────────────────────────────────────────
  const scheduleAutoSave = useCallback(() => {
    if (!enabled || !stateRef.current.clientInfo) return;
    setStatus("pending");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      doSave(false);
      timerRef.current = null;
    }, debounceMs);
  }, [enabled, debounceMs, doSave]);

  // ── Detectar cambios relevantes y disparar autoguardado ────────────────────
  const prevFingerprint = useRef("");

  useEffect(() => {
    // Fingerprint liviano — evita re-saves por re-renders sin cambio real
    const fp = [
      state.designItems.length,
      state.materialCosts.length,
      state.pricePerM2,
      state.grassAreaM2,
      state.cadPolygons.length,
      state.totalProjectCost,
      state.activeMaterialId,
    ].join("|");

    if (fp !== prevFingerprint.current && state.clientInfo) {
      prevFingerprint.current = fp;
      scheduleAutoSave();
    }
  }, [
    state.designItems,
    state.materialCosts,
    state.pricePerM2,
    state.grassAreaM2,
    state.cadPolygons,
    state.totalProjectCost,
    state.activeMaterialId,
    state.clientInfo,
    scheduleAutoSave,
  ]);

  // ── Guardar al cerrar la pestaña (beforeunload) ─────────────────────────────
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (status === "pending" && stateRef.current.clientInfo) {
        const payload = serializeState(stateRef.current);
        saveToLocalStorage(payload);
        // Nota: no podemos hacer fetch async en beforeunload de forma confiable
        // pero localStorage garantiza que los datos no se pierden
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [status]);

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (labelTimer.current) clearInterval(labelTimer.current);
    };
  }, []);

  return {
    status,
    lastSaved,
    savedVersion,
    lastSavedLabel,
    manualSave,
  };
}
