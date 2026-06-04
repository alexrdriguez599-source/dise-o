/**
 * offline-storage.ts — IndexedDB wrapper for offline-capable storage.
 *
 * Stores:
 *   - inventory cache (JSON, ~50 KB)
 *   - garden images (base64, potentially several MB)
 *   - local project snapshots (full state)
 *   - sync queue (list of project saves to flush when online)
 */

const DB_NAME = 'garden_designer_offline';
const DB_VERSION = 1;

const STORES = {
  inventory: 'inventory',
  images: 'images',
  projects: 'projects',
  syncQueue: 'syncQueue',
} as const;

// ─── DB initialisation ────────────────────────────────────────────────────────

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORES.inventory)) {
        db.createObjectStore(STORES.inventory, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.images)) {
        db.createObjectStore(STORES.images, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.projects)) {
        db.createObjectStore(STORES.projects, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.syncQueue)) {
        db.createObjectStore(STORES.syncQueue, {
          keyPath: 'queueId',
          autoIncrement: true,
        });
      }
    };
    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function txGet<T>(
  store: string,
  key: IDBValidKey
): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      })
  );
}

function txPut(store: string, value: unknown): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).put(value);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      })
  );
}

function txDelete(store: string, key: IDBValidKey): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      })
  );
}

function txGetAll<T>(store: string): Promise<T[]> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
      })
  );
}

// ─── Inventory cache ─────────────────────────────────────────────────────────

export interface CachedInventoryItem {
  id: number;
  name: string;
  category: string;
  subcategory?: string;
  price: string | number;
  unit?: string;
  imageData?: string;
  description?: string;
}

export async function cacheInventory(items: CachedInventoryItem[]): Promise<void> {
  await txPut(STORES.inventory, { key: 'items', data: items, cachedAt: Date.now() });
}

export async function getCachedInventory(): Promise<CachedInventoryItem[] | null> {
  const record = await txGet<{ key: string; data: CachedInventoryItem[]; cachedAt: number }>(
    STORES.inventory,
    'items'
  );
  if (!record) return null;
  return record.data;
}

// ─── Garden image storage ────────────────────────────────────────────────────

export async function saveGardenImage(projectKey: string, dataUrl: string): Promise<void> {
  await txPut(STORES.images, { key: projectKey, dataUrl, savedAt: Date.now() });
}

export async function loadGardenImage(projectKey: string): Promise<string | null> {
  const record = await txGet<{ key: string; dataUrl: string }>(STORES.images, projectKey);
  return record?.dataUrl ?? null;
}

export async function deleteGardenImage(projectKey: string): Promise<void> {
  await txDelete(STORES.images, projectKey);
}

// ─── Local project snapshots ─────────────────────────────────────────────────

export interface LocalProject {
  id: string;
  clientName: string;
  clientPhone: string;
  clientAddress: string;
  designItems: unknown[];
  polygons: unknown[];
  gardenImageKey: string;
  pricePerM2: number;
  grassAreaM2: number;
  materialCosts: unknown[];
  serverProjectId: number | null;
  savedAt: number;
  pendingSync: boolean;
}

export async function saveLocalProject(project: LocalProject): Promise<void> {
  await txPut(STORES.projects, project);
}

export async function loadLocalProject(id: string): Promise<LocalProject | null> {
  const record = await txGet<LocalProject>(STORES.projects, id);
  return record ?? null;
}

export async function listLocalProjects(): Promise<LocalProject[]> {
  return txGetAll<LocalProject>(STORES.projects);
}

// ─── Sync queue ──────────────────────────────────────────────────────────────

export interface SyncQueueEntry {
  queueId?: number;
  localProjectId: string;
  serverProjectId: number | null;
  payload: unknown;
  addedAt: number;
}

export async function enqueueSyncEntry(entry: Omit<SyncQueueEntry, 'queueId'>): Promise<void> {
  await txPut(STORES.syncQueue, entry);
}

export async function getPendingSyncs(): Promise<SyncQueueEntry[]> {
  return txGetAll<SyncQueueEntry>(STORES.syncQueue);
}

export async function removeSyncEntry(queueId: number): Promise<void> {
  await txDelete(STORES.syncQueue, queueId);
}

export async function getPendingSyncCount(): Promise<number> {
  const all = await getPendingSyncs();
  return all.length;
}

// ─── Session cleanup ──────────────────────────────────────────────────────────

/**
 * Clears ALL IndexedDB stores for this app.
 * Called on logout so that no data leaks between users on the same device.
 */
export async function clearAllOfflineData(): Promise<void> {
  try {
    const db = await openDB();
    const storeList = [STORES.inventory, STORES.images, STORES.projects, STORES.syncQueue];
    for (const storeName of storeList) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).clear();
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    }
  } catch {
    // Non-critical: best-effort cleanup
  }
}
