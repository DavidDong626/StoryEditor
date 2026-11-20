import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { readLibrary, replaceProject, writeLibrary } from './storage';
import { id, newProject } from './model';

it('浏览器事务保存多个项目及快照，重新读取保持一致', async () => {
  const library = await readLibrary();
  const second = newProject('存储测试');
  const original = library.projects[0];
  const next = {
    ...library,
    activeId: second.id,
    projects: [...library.projects, second],
    snapshots: [
      { id: id(), name: '修改前', createdAt: new Date().toISOString(), project: structuredClone(original) },
    ],
  };
  await writeLibrary(next);
  expect(await readLibrary()).toEqual(next);
  const updated = { ...second, name: '已保存的修改', revision: 1 };
  await writeLibrary(replaceProject(next, updated));
  const read = await readLibrary();
  expect(read.projects.find((p) => p.id === second.id)).toEqual(updated);
  expect(read.snapshots[0].project).toEqual(original);
});

it('格式损坏时拒绝加载且不覆盖原始记录', async () => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('story-editor', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const corrupt = { version: 99, projects: ['broken'] };
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('library', 'readwrite');
    tx.objectStore('library').put(corrupt, 'current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await expect(readLibrary()).rejects.toThrow('停止写入');
  const preserved = await new Promise((resolve) => {
    const request = database.transaction('library', 'readonly').objectStore('library').get('current');
    request.onsuccess = () => resolve(request.result);
  });
  expect(preserved).toEqual(corrupt);
  database.close();
});
