import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const source = resolve(process.env.DATABASE_PATH ?? 'data/story-editor.sqlite');
const destination = resolve(
  process.argv[2] ?? `backups/story-editor-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`,
);
if (source === destination) throw new Error('备份不能覆盖当前数据库');
mkdirSync(dirname(destination), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.prepare('VACUUM INTO ?').run(destination);
  console.log('完整备份已生成：' + destination);
} finally {
  db.close();
}
