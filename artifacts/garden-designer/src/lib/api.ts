import { authHeaders } from "@/services/auth";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Fetch wrapper que agrega automáticamente:
 * - BASE_URL prefix en las URLs que empiezan con /api/
 * - Authorization: Bearer <token> header
 */
export async function apiFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const fullUrl = url.startsWith("/") ? `${BASE}${url}` : url;
  return fetch(fullUrl, {
    ...init,
    credentials: "include",
    headers: {
      ...authHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

export { BASE };
