import { z } from 'zod';
import { checkProject } from './check';
import { id, projectSchema, type Project } from './model';

export const backupSchema = z
  .object({
    format: z.literal('story-editor-backup'),
    schemaVersion: z.literal(1),
    exportedAt: z.string().datetime(),
    project: projectSchema,
  })
  .strict();
export function backup(p: Project) {
  return {
    format: 'story-editor-backup',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    project: p,
  };
}
export function importBackup(content: string): Project {
  if (new TextEncoder().encode(content).length > 20 * 1024 * 1024)
    throw new Error('文件超过 20 MB，无法导入。');
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new Error('无法读取 JSON，请确认文件没有损坏。');
  }
  const parsed = backupSchema.safeParse(json);
  if (!parsed.success) throw new Error('备份格式或版本不支持，或存在无效字段。请使用本应用导出的创作备份。');
  const project = parsed.data.project;
  // Incomplete drafts are valid imports; broken identity/reference/type data is not.
  const fatal = checkProject(project).filter(
    (i) =>
      i.level === 'error' && !['port-count', 'entry', 'choice-empty', 'jump-reference'].includes(i.ruleId),
  );
  if (fatal.length) throw new Error(`备份引用校验失败：${fatal[0].message}`);
  if (
    project.nodes.some(
      (n) => n.type === 'jump' && n.targetNodeId && !project.nodes.some((t) => t.id === n.targetNodeId),
    )
  )
    throw new Error('备份中包含失效的跳转引用。');
  return { ...project, id: id(), revision: 0, name: `${project.name.slice(0, 90)} · 导入` };
}
export function runtimeExport(p: Project) {
  const errors = checkProject(p).filter((i) => i.level === 'error');
  if (errors.length) throw new Error(`请先修复 ${errors.length} 个错误：${errors[0].message}`);
  const sorted = <T extends { id: string }>(items: T[]) =>
    [...items].sort((a, b) => a.id.localeCompare(b.id));
  return {
    format: 'story-editor-runtime',
    schemaVersion: 1,
    projectId: p.id,
    projectRevision: p.revision,
    exportedAt: new Date().toISOString(),
    entryNodeId: p.entryNodeId,
    boards: sorted(p.boards).map(({ id, name, startNodeId }) => ({ id, name, startNodeId })),
    nodes: sorted(p.nodes).map(({ position: _position, status: _status, ...node }) => node),
    edges: sorted(p.edges),
    characters: sorted(p.characters),
    variables: sorted(p.variables),
  };
}
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[<>:"/\\|?*]/g, '_')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
