import {
  getPendingSyncs,
  removeSyncEntry,
  saveLocalProject,
  loadLocalProject,
  loadGardenImage,
  type SyncQueueEntry,
} from './offline-storage';
import { authHeaders } from './auth';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface SyncResult {
  synced: number;
  failed: number;
  errors: string[];
}

export async function runSync(): Promise<SyncResult> {
  if (!navigator.onLine) return { synced: 0, failed: 0, errors: ['Sin conexión'] };

  const queue = await getPendingSyncs();
  if (queue.length === 0) return { synced: 0, failed: 0, errors: [] };

  const result: SyncResult = { synced: 0, failed: 0, errors: [] };

  for (const entry of queue) {
    try {
      await syncEntry(entry);
      await removeSyncEntry(entry.queueId!);
      if (entry.localProjectId) {
        const proj = await loadLocalProject(entry.localProjectId);
        if (proj) {
          await saveLocalProject({ ...proj, pendingSync: false });
        }
      }
      result.synced++;
    } catch (err) {
      result.failed++;
      result.errors.push(String(err));
    }
  }

  return result;
}

async function syncEntry(entry: SyncQueueEntry): Promise<void> {
  const payload = entry.payload as Record<string, unknown>;

  if (entry.localProjectId) {
    const imageData = await loadGardenImage(entry.localProjectId);
    if (imageData) {
      payload.gardenImageData = imageData;
    }
  }

  const method = entry.serverProjectId ? 'PATCH' : 'POST';
  const url = entry.serverProjectId
    ? `${BASE}/api/projects/${entry.serverProjectId}`
    : `${BASE}/api/projects`;

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}
