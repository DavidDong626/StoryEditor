import type { Project } from './model';
export interface Draft {
  id: string;
  project: Project;
  reason: string;
  createdAt: string;
}
async function draftsDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('story-editor-remote-drafts', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('drafts', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function storedDrafts(): Promise<Draft[]> {
  const db = await draftsDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readonly'),
      req = tx.objectStore('drafts').getAll();
    tx.oncomplete = () => {
      resolve(req.result);
      db.close();
    };
    tx.onerror = () => {
      reject(tx.error);
      db.close();
    };
  });
}
export async function keepDraft(draft: Draft) {
  const db = await draftsDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').put(draft);
    tx.oncomplete = () => {
      resolve();
      db.close();
    };
    tx.onerror = () => {
      reject(tx.error);
      db.close();
    };
  });
}
export async function deleteDraft(id: string) {
  const db = await draftsDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').delete(id);
    tx.oncomplete = () => {
      resolve();
      db.close();
    };
    tx.onerror = () => {
      reject(tx.error);
      db.close();
    };
  });
}
