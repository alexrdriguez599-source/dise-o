/**
 * useCadHistory — Undo/Redo profesional para el diseñador CAD.
 *
 * Estrategia:
 *  - historyRef  : pila de estados ANTERIORES al cursor actual (undo)
 *  - redoRef     : pila de estados FUTUROS  (redo)
 *  - Cada mutación llama saveSnapshot(snapshotAntes) → empuja a historyRef y vacía redoRef
 *  - undo(current) → pop historyRef, push current a redoRef, devuelve snap anterior
 *  - redo(current) → pop redoRef,    push current a historyRef, devuelve snap siguiente
 *
 * Los snapshots se serializan como JSON para clonar profundamente sin referencias.
 * imageData se excluye del snapshot para evitar objetos de varios MB.
 */

import { useRef, useState, useCallback } from "react";

// ─── Snapshot type ────────────────────────────────────────────────────────────
export interface PolygonSnap {
  id: string;
  points: { x: number; y: number }[];
  materialId: string;
  closed: boolean;
  label: string;
  aiApplied?: boolean;
  poolType?: "pool";
  poolDepth?: number;
}

export interface DesignItemSnap {
  id: string;
  inventoryItemId: number | string;
  name: string;
  price: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  tiltX?: number;
  tiltY?: number;
  quantity?: number;
  unitPrice?: number;
  source?: string;
}

export interface CadSnapshot {
  polygons: PolygonSnap[];
  designItems: DesignItemSnap[];
  ppm: number | null;
  labelMap: Record<string, string>;
  /** Per-polygon measurement mode overrides ("area" | "length"). Optional for backward compat. */
  measureModeOverrides?: Record<string, "area" | "length">;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_HISTORY = 50;

// ─── Serialisation helpers ────────────────────────────────────────────────────
function serialize(snap: CadSnapshot): string {
  return JSON.stringify(snap);
}

function deserialize(str: string): CadSnapshot {
  return JSON.parse(str) as CadSnapshot;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useCadHistory() {
  // Stacks stored as serialised strings to guarantee deep cloning
  const historyRef = useRef<string[]>([]);
  const redoRef    = useRef<string[]>([]);

  // UI flags — only these cause re-renders
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const refreshFlags = useCallback(() => {
    setCanUndo(historyRef.current.length > 0);
    setCanRedo(redoRef.current.length   > 0);
  }, []);

  /**
   * Call BEFORE every mutation with the current state.
   * Clears redo stack (new action kills future).
   */
  const saveSnapshot = useCallback((snap: CadSnapshot) => {
    const serialised = serialize(snap);

    // Skip duplicate (e.g. spurious mouseup without real move)
    const last = historyRef.current.at(-1);
    if (last === serialised) return;

    historyRef.current.push(serialised);

    // Enforce max limit (drop oldest)
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current.shift();
    }

    // Any new action discards the future
    redoRef.current = [];
    refreshFlags();
  }, [refreshFlags]);

  /**
   * Undo: pass the *current* state so it can be pushed to redoRef.
   * Returns the previous snapshot to restore, or null if nothing to undo.
   */
  const undo = useCallback((current: CadSnapshot): CadSnapshot | null => {
    if (historyRef.current.length === 0) return null;

    const prev = historyRef.current.pop()!;
    redoRef.current.push(serialize(current));

    // Cap redo stack too
    if (redoRef.current.length > MAX_HISTORY) {
      redoRef.current.shift();
    }

    refreshFlags();
    return deserialize(prev);
  }, [refreshFlags]);

  /**
   * Redo: pass the *current* state so it can be pushed back to historyRef.
   * Returns the next snapshot to restore, or null if nothing to redo.
   */
  const redo = useCallback((current: CadSnapshot): CadSnapshot | null => {
    if (redoRef.current.length === 0) return null;

    const next = redoRef.current.pop()!;
    historyRef.current.push(serialize(current));

    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current.shift();
    }

    refreshFlags();
    return deserialize(next);
  }, [refreshFlags]);

  /** Clear both stacks (e.g. on project reset). */
  const clearHistory = useCallback(() => {
    historyRef.current = [];
    redoRef.current    = [];
    refreshFlags();
  }, [refreshFlags]);

  return { saveSnapshot, undo, redo, canUndo, canRedo, clearHistory };
}
