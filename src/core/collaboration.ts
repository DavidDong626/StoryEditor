import { z } from 'zod';
import { projectSchema, type Project } from './model';
import { checkProject } from './check';

export const collections = ['folders', 'boards', 'nodes', 'edges', 'characters', 'variables'] as const;
export type Collection = (typeof collections)[number];
export type Role = 'owner' | 'editor' | 'viewer';
export interface RemoteState {
  project: Project;
  epoch: number;
  versions: Record<string, number>;
  role: Role;
}
export type Envelope = RemoteState;
export const deltaSchema = z
  .object({
    collection: z.enum([...collections, 'meta']),
    id: z.string(),
    before: z.unknown(),
    after: z.unknown(),
    version: z.number().int().nonnegative(),
  })
  .strict();
export type Delta = z.infer<typeof deltaSchema>;
export const commandSchema = z
  .object({
    operationId: z.string().uuid(),
    epoch: z.number().int().positive(),
    label: z.string().min(1).max(200),
    changes: z.array(deltaSchema).min(1).max(20000),
    leases: z.record(z.string()),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export const keyOf = (d: Pick<Delta, 'collection' | 'id'>) => `${d.collection}:${d.id}`;
export const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const meta = (p: Project) => ({ name: p.name, entryNodeId: p.entryNodeId });
export function diff(before: Project, after: Project, versions: Record<string, number>): Delta[] {
  const result: Delta[] = [];
  for (const collection of collections) {
    const old = new Map(before[collection].map((v) => [v.id, v]));
    const next = new Map(after[collection].map((v) => [v.id, v]));
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      const a = old.get(id) ?? null,
        b = next.get(id) ?? null;
      if (!equal(a, b))
        result.push({ collection, id, before: a, after: b, version: versions[`${collection}:${id}`] ?? 0 });
    }
  }
  if (!equal(meta(before), meta(after)))
    result.push({
      collection: 'meta',
      id: before.id,
      before: meta(before),
      after: meta(after),
      version: versions[`meta:${before.id}`] ?? 0,
    });
  return result;
}
export function applyChanges(current: Project, versions: Record<string, number>, changes: Delta[]): Project {
  const next = structuredClone(current);
  const seen = new Set<string>();
  for (const d of changes) {
    const key = keyOf(d);
    if (seen.has(key)) throw new Error('重复修改对象');
    seen.add(key);
    const existing =
      d.collection === 'meta' ? meta(next) : (next[d.collection].find((o) => o.id === d.id) ?? null);
    if ((versions[key] ?? 0) !== d.version || !equal(existing, d.before))
      throw new Error('对象已被其他修改更新，请保留草稿并重新打开');
    if (d.collection === 'meta') {
      if (d.id !== current.id) throw new Error('项目标识无效');
      const parsed = z
        .object({ name: z.string(), entryNodeId: z.string().uuid().nullable() })
        .strict()
        .parse(d.after);
      Object.assign(next, parsed);
    } else {
      const values = next[d.collection] as { id: string }[];
      const index = values.findIndex((o) => o.id === d.id);
      if (d.after === null) {
        if (index >= 0) values.splice(index, 1);
      } else {
        if (!d.after || typeof d.after !== 'object' || !('id' in d.after) || d.after.id !== d.id)
          throw new Error('对象标识无效');
        if (index >= 0) values[index] = d.after as { id: string };
        else values.push(d.after as { id: string });
      }
    }
  }
  next.revision = current.revision + 1;
  return validateDraft(next);
}
export function validateDraft(value: unknown): Project {
  const p = projectSchema.parse(value);
  const fatal = checkProject(p).find(
    (i) =>
      i.level === 'error' && !['port-count', 'entry', 'choice-empty', 'jump-reference'].includes(i.ruleId),
  );
  if (fatal) throw new Error(fatal.message);
  if (
    p.nodes.some((n) => n.type === 'jump' && n.targetNodeId && !p.nodes.some((t) => t.id === n.targetNodeId))
  )
    throw new Error('跳转目标已不存在');
  if (!p.boards.length || !p.folders.length) throw new Error('项目至少需要一个章节和场景');
  if (
    p.edges.some(
      (e) =>
        p.edges.filter(
          (other) => other.sourceNodeId === e.sourceNodeId && other.sourcePortId === e.sourcePortId,
        ).length > 1,
    )
  )
    throw new Error('一个出口只能连接一个目标');
  return p;
}
// Structural writes also occupy both endpoints, so removing a node/port cannot race a new edge.
export function touched(changes: Delta[]): string[] {
  const keys = new Set(changes.map(keyOf));
  for (const d of changes)
    if (d.collection === 'edges')
      for (const value of [d.before, d.after]) {
        const edge = value as { sourceNodeId?: string; targetNodeId?: string } | null;
        if (edge?.sourceNodeId) keys.add(`nodes:${edge.sourceNodeId}`);
        if (edge?.targetNodeId) keys.add(`nodes:${edge.targetNodeId}`);
      }
  return [...keys].sort();
}
