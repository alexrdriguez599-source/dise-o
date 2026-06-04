import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

function getToken(): string | null {
  try { return typeof window !== "undefined" ? localStorage.getItem("urbanai_token") : null; }
  catch { return null; }
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface InventoryItem {
  id: number;
  userId?: number | null;
  name: string;
  category: string;
  quantity: string;
  unit?: string | null;
  status: string;
  notes?: string | null;
  price?: string | null;
  imageData?: string | null;
  itemType?: string | null;
  size?: string | null;
  spacing?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InventorySummary {
  total: number;
  byCategory: Record<string, number>;
  byStatus: Record<string, number>;
  totalValue: number;
}

export interface ProjectItem {
  id: number;
  userId: number;
  clientName: string;
  clientPhone?: string | null;
  clientAddress?: string | null;
  gardenImageData?: string | null;
  designData?: string | null;
  totalEstimate?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Query Keys ─────────────────────────────────────────────────────────────

export const getListInventoryItemsQueryKey = () => ["listInventoryItems"] as const;
export const getGetInventorySummaryQueryKey = () => ["getInventorySummary"] as const;
export const getListProjectsQueryKey = () => ["listProjects"] as const;

// ── Inventory Hooks ────────────────────────────────────────────────────────

export function useListInventoryItems() {
  return useQuery({
    queryKey: getListInventoryItemsQueryKey(),
    queryFn: () =>
      apiFetch<{ items: InventoryItem[] }>("/api/inventory").then((d) => d.items),
    staleTime: 60_000,
    enabled: !!getToken(),
  });
}

export function useGetInventorySummary() {
  return useQuery({
    queryKey: getGetInventorySummaryQueryKey(),
    // Server returns { total, byCategory, byStatus, totalValue } directly (no wrapper)
    queryFn: () =>
      apiFetch<InventorySummary>("/api/inventory/summary"),
    staleTime: 60_000,
    enabled: !!getToken(),
  });
}

// The item-dialog calls: createMutation.mutate({ data: FormValues })
export function useCreateInventoryItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ data }: { data: Record<string, unknown> }) =>
      apiFetch<{ item: InventoryItem }>("/api/inventory", {
        method: "POST",
        body: JSON.stringify(data),
      }).then((d) => d.item),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetInventorySummaryQueryKey() });
    },
  });
}

// The item-dialog calls: updateMutation.mutate({ id: item.id, data: FormValues })
export function useUpdateInventoryItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      apiFetch<{ item: InventoryItem }>(`/api/inventory/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }).then((d) => d.item),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetInventorySummaryQueryKey() });
    },
  });
}

export function useDeleteInventoryItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/inventory/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetInventorySummaryQueryKey() });
    },
  });
}

// ── Project Hooks ──────────────────────────────────────────────────────────

export function useListProjects() {
  return useQuery({
    queryKey: getListProjectsQueryKey(),
    queryFn: () =>
      apiFetch<{ projects: ProjectItem[] }>("/api/projects").then((d) => d.projects),
    staleTime: 60_000,
    enabled: !!getToken(),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<ProjectItem>) =>
      apiFetch<{ project: ProjectItem }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(data),
      }).then((d) => d.project),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<ProjectItem> & { id: number }) =>
      apiFetch<{ project: ProjectItem }>(`/api/projects/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }).then((d) => d.project),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
    },
  });
}
