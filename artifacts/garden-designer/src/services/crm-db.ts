/**
 * CRM Database — IndexedDB offline-first para clientes y proyectos.
 *
 * AISLAMIENTO POR USUARIO:
 * La base de datos se nomina `urbanai_crm_${userId}` para que cada usuario
 * tenga su propio almacenamiento completamente independiente.
 * Llama a `setCRMUser(userId)` al iniciar sesión y `clearCRMUser()` al salir.
 */

export interface CRMClient {
  id: string;
  nombre: string;
  telefono: string;
  email: string;
  direccion: string;
  notas: string;
  createdAt: string;
  updatedAt: string;
}

export interface CRMProject {
  id: string;
  clienteId: string;
  nombre: string;
  fecha: string;
  totalCotizacion: number;
  gardenImageData?: string;
  pdfData?: string;
  zonas?: string;
  plantas?: string;
  updatedAt: string;
  createdAt: string;
}

// ── Scope de usuario ─────────────────────────────────────────────────────────

let _userId: number | null = null;

/** Debe llamarse justo después del login o validación de sesión. */
export function setCRMUser(userId: number): void {
  _userId = userId;
}

/** Debe llamarse al cerrar sesión. */
export function clearCRMUser(): void {
  _userId = null;
}

function getDBName(): string {
  if (_userId === null) {
    // Nunca debería ocurrir en producción, pero evita acceso a datos compartidos
    throw new Error("CRM: usuario no inicializado. Llama setCRMUser() al hacer login.");
  }
  return `urbanai_crm_${_userId}`;
}

const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(getDBName(), DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("clients")) {
        db.createObjectStore("clients", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("projects")) {
        const ps = db.createObjectStore("projects", { keyPath: "id" });
        ps.createIndex("clienteId", "clienteId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Clients ───────────────────────────────────────────────────────────────────

export async function getAllClients(): Promise<CRMClient[]> {
  const db = await openDB();
  return tx<CRMClient[]>(db, "clients", "readonly", s => s.getAll());
}

export async function getClient(id: string): Promise<CRMClient | undefined> {
  const db = await openDB();
  return tx<CRMClient | undefined>(db, "clients", "readonly", s => s.get(id));
}

export async function saveClient(client: CRMClient): Promise<void> {
  const db = await openDB();
  await tx(db, "clients", "readwrite", s => s.put(client));
}

export async function deleteClient(id: string): Promise<void> {
  const db = await openDB();
  await tx(db, "clients", "readwrite", s => s.delete(id));
  const projects = await getProjectsByClient(id);
  for (const p of projects) await deleteProject(p.id);
}

// ── Projects ──────────────────────────────────────────────────────────────────

export async function getAllProjects(): Promise<CRMProject[]> {
  const db = await openDB();
  return tx<CRMProject[]>(db, "projects", "readonly", s => s.getAll());
}

export async function getProjectsByClient(clienteId: string): Promise<CRMProject[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction("projects", "readonly");
    const s = t.objectStore("projects");
    const idx = s.index("clienteId");
    const req = idx.getAll(clienteId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getProject(id: string): Promise<CRMProject | undefined> {
  const db = await openDB();
  return tx<CRMProject | undefined>(db, "projects", "readonly", s => s.get(id));
}

export async function saveProject(project: CRMProject): Promise<void> {
  const db = await openDB();
  await tx(db, "projects", "readwrite", s => s.put(project));
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDB();
  await tx(db, "projects", "readwrite", s => s.delete(id));
}
