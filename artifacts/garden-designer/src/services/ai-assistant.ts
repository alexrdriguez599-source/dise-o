/**
 * AIAssistant — OPTIONAL AI module.
 *
 * The design system works 100% without this module.
 * All methods return null/false gracefully when AI is unavailable.
 * Never throws — failures are silent and non-blocking.
 */

import { authHeaders } from "./auth";
import { wavespeedPost } from "./wavespeed-fetch";

const BASE = typeof window !== "undefined"
  ? window.__replco_base_url ?? import.meta.env.BASE_URL?.replace(/\/$/, "") ?? ""
  : "";

export interface AILayoutSuggestion {
  description: string;
  zones: { label: string; percentage: number; material: string }[];
}

export interface AIMaterialResult {
  imageBase64: string; // data URL of AI-processed image
}

export class AIAssistant {
  private static _enabled = true;

  /** Toggle AI on/off (enterprise setting) */
  static setEnabled(v: boolean) { this._enabled = v; }
  static get isEnabled() { return this._enabled; }

  /** True when the browser is online AND AI is enabled */
  static get isAvailable() { return this._enabled && navigator.onLine; }

  /**
   * Check if AI services are reachable.
   * Silently returns false if not available.
   */
  static async ping(): Promise<boolean> {
    if (!this._enabled || !navigator.onLine) return false;
    try {
      const res = await fetch(`${BASE}/api/health`, { method: "GET", signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Apply a photorealistic material texture to a masked area using AI (WaveSpeed).
   * Returns null if AI fails — caller should fall back to flat fill.
   */
  static async applyMaterial(params: {
    imageBase64: string;
    maskBase64: string;
    materialId: string;
    materialPrompt: string;
    materialNegativePrompt?: string;
    onProgress?: (msg: string) => void;
  }): Promise<AIMaterialResult | null> {
    if (!this._enabled || !navigator.onLine) return null;
    try {
      params.onProgress?.("Enviando a IA...");
      const data = await wavespeedPost("/api/ai/wavespeed/inpaint", {
        imageBase64: params.imageBase64,
        maskBase64: params.maskBase64,
        prompt: params.materialPrompt,
      });
      if (!data.imageBase64) return null;
      params.onProgress?.("IA completada.");
      return { imageBase64: data.imageBase64 };
    } catch {
      return null;
    }
  }

  /**
   * Get design layout suggestions from OpenAI.
   * Returns null silently if AI is unavailable.
   * @param imageBase64 - Photo of the garden to analyze
   * @param inventoryContext - Optional JSON string of inventory items for context
   */
  static async suggestLayout(imageBase64: string, inventoryContext?: string): Promise<AILayoutSuggestion | null> {
    if (!this._enabled || !navigator.onLine) return null;
    try {
      const res = await fetch(`${BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          messages: [{
            role: "user",
            content: "Analiza este jardín y sugiere una distribución de zonas en formato JSON: {description, zones:[{label,percentage,material}]}. Solo responde con el JSON.",
          }],
          ...(inventoryContext ? { inventoryContext } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = typeof data.content === "string" ? data.content : data.message ?? "";
      const json = text.match(/\{[\s\S]+\}/)?.[0];
      if (!json) return null;
      return JSON.parse(json) as AILayoutSuggestion;
    } catch {
      return null;
    }
  }

  /**
   * Get plant recommendations from OpenAI for a given zone.
   * Returns empty array silently if AI fails.
   */
  static async recommendPlants(params: { zone: string; climate: string; areaM2: number }): Promise<string[]> {
    if (!this._enabled || !navigator.onLine) return [];
    try {
      const res = await fetch(`${BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          messages: [{
            role: "user",
            content: `Recomienda 5 plantas para una zona de ${params.zone} de ${params.areaM2.toFixed(1)} m² en clima ${params.climate}. Solo nombres en español, en una lista separada por comas.`,
          }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const text = typeof data.content === "string" ? data.content : data.message ?? "";
      return text.split(",").map((s: string) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
}

// Vite env augmentation for __replco_base_url
declare global {
  interface Window { __replco_base_url?: string }
}
