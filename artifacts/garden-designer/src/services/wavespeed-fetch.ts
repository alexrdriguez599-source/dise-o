import { authHeaders } from "./auth";

const BASE =
  typeof window !== "undefined"
    ? ((window as Window & { __replco_base_url?: string }).__replco_base_url ??
       import.meta.env.BASE_URL?.replace(/\/$/, "") ??
       "")
    : "";

/**
 * POST to a WaveSpeed endpoint and transparently handle the async job pattern.
 *
 * - If the server returns { imageBase64 } directly → returns it immediately.
 * - If the server returns { jobId, status: "pending" } → polls
 *   GET /api/ai/wavespeed/status/:jobId every 3 s until completed or failed.
 *
 * Each individual HTTP request stays well under the Replit proxy 120 s limit.
 */
export async function wavespeedPost(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ imageBase64: string; retryToken?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders(),
  };

  const startRes = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
    signal,
  });

  if (!startRes.ok) {
    const err = await startRes
      .json()
      .catch(() => ({ error: "Error del servidor" })) as { error?: string };
    throw new Error(err.error || `HTTP ${startRes.status}`);
  }

  const startData = await startRes.json() as {
    imageBase64?: string;
    jobId?: string;
    status?: string;
    error?: string;
    retryToken?: string;
  };

  if (startData.imageBase64) {
    return { imageBase64: startData.imageBase64, retryToken: startData.retryToken };
  }

  if (!startData.jobId) {
    throw new Error(startData.error || "Respuesta inesperada del servidor");
  }

  const { jobId } = startData;
  const deadline = Date.now() + 300_000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Cancelado");
    await new Promise<void>((r) => setTimeout(r, 3000));

    let statusData: { status: string; imageBase64?: string; error?: string; retryToken?: string };
    try {
      const statusRes = await fetch(
        `${BASE}/api/ai/wavespeed/status/${jobId}`,
        { credentials: "include", headers: authHeaders(), signal },
      );
      if (!statusRes.ok) continue;
      statusData = await statusRes.json() as typeof statusData;
    } catch {
      continue;
    }

    if (statusData.status === "completed" && statusData.imageBase64) {
      return { imageBase64: statusData.imageBase64, retryToken: statusData.retryToken };
    }
    if (statusData.status === "failed") {
      throw new Error(statusData.error || "El procesamiento falló");
    }
  }

  throw new Error("Tiempo de espera agotado. Intenta con una imagen más pequeña.");
}
