import { z } from 'zod';
import { projectSchema, type Project } from './model';
import { sampleProject } from './sample';

const librarySchema = z.object({
  version: z.literal(1),
  activeId: z.string(),
  projects: z.array(projectSchema),
  snapshots: z.array(
    z.object({ id: z.string(), name: z.string(), createdAt: z.string(), project: projectSchema }),
  ),
});
export type Library = z.infer<typeof librarySchema>;
export type Snapshot = Library['snapshots'][number];
let database: Promise<IDBDatabase> | undefined;
function db() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('story-editor', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('library');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('浏览器存储不可用。请检查浏览器隐私设置。'));
  });
  return database;
}
export async function readLibrary(): Promise<Library> {
  const database = await db();
  const stored = await new Promise<unknown>((resolve, reject) => {
    const tx = database.transaction('library', 'readonly'),
      request = tx.objectStore('library').get('current');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (stored !== undefined) {
    const result = librarySchema.safeParse(stored);
    if (
      !result.success ||
      !result.data.projects.length ||
      !result.data.projects.some((p) => p.id === result.data.activeId)
    )
      throw new Error('本地数据格式异常，已停止写入以保护原始数据。');
    return result.data;
  }
  const sample = sampleProject();
  return { version: 1, activeId: sample.id, projects: [sample], snapshots: [] };
}
export async function writeLibrary(library: Library): Promise<void> {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('library', 'readwrite');
    tx.objectStore('library').put(library, 'current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error('本地保存失败，可能是存储空间不足。请导出备份。'));
    tx.onabort = () => reject(new Error('本地保存中断。请重试或导出备份。'));
  });
}
export function replaceProject(library: Library, p: Project): Library {
  return { ...library, projects: library.projects.map((old) => (old.id === p.id ? p : old)) };
}
