import { describe, expect, it } from 'vitest';
import { id, projectSchema, type Project, type Relationship } from './model';
import { sampleProject } from './sample';
import { backup, importBackup, runtimeExport } from './transfer';
import { checkProject } from './check';
import { applyChanges, diff, keyOf, touched } from './collaboration';

function fixture() {
  const project = sampleProject();
  project.characters.push({ id: id(), name: '旅人', description: '来访的旅人', color: 'teal' });
  const relation: Relationship = {
    id: id(),
    title: '互相试探的盟友',
    sourceCharacterId: project.characters[0].id,
    targetCharacterId: project.characters[1].id,
    kind: '盟友',
    direction: 'directed',
    affinity: 25,
    description: '双方各有隐瞒',
    development: '找到灯笼后建立信任',
    status: 'draft',
  };
  project.relationships.push(relation);
  return { project, relation };
}
describe('角色关系设计卡片', () => {
  it('v1 项目与创作备份迁移到 v2，保留全部内部标识和已有数据', () => {
    const current = sampleProject();
    const { relationships, ...rest } = current;
    const legacy = { ...rest, schemaVersion: 1 };
    const migrated = projectSchema.parse(legacy);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.relationships).toEqual([]);
    expect(migrated.id).toBe(current.id);
    expect(migrated.nodes).toEqual(current.nodes);
    expect(migrated.characters).toEqual(current.characters);
    const imported = importBackup(
      JSON.stringify({
        format: 'story-editor-backup',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        project: legacy,
      }),
    );
    expect(imported.schemaVersion).toBe(2);
    expect(imported.relationships).toEqual([]);
    expect(imported.nodes).toEqual(current.nodes);
    expect(projectSchema.safeParse({ ...legacy, unknownField: true }).success).toBe(false);
  });
  it('关系卡片随备份往返，运行数据和剧情执行格式保持独立', () => {
    const { project, relation } = fixture();
    const imported = importBackup(JSON.stringify(backup(project)));
    expect(imported.relationships).toEqual([relation]);
    expect(backup(project).schemaVersion).toBe(2);
    expect(checkProject(project).filter((i) => i.level === 'error')).toEqual([]);
    const runtime = runtimeExport(project);
    expect(runtime.schemaVersion).toBe(1);
    expect(runtime).not.toHaveProperty('relationships');
  });
  it('失效角色、自指向、重复标识与非法亲疏数值无法提交', () => {
    const { project, relation } = fixture();
    const removed = structuredClone(project);
    removed.characters.pop();
    expect(checkProject(removed).some((i) => i.ruleId === 'relationship-reference')).toBe(true);
    expect(() => importBackup(JSON.stringify(backup(removed)))).toThrow('校验');
    const self = structuredClone(project);
    self.relationships[0].targetCharacterId = relation.sourceCharacterId;
    expect(checkProject(self).some((i) => i.ruleId === 'relationship-self')).toBe(true);
    const duplicate = structuredClone(project);
    duplicate.relationships[0].id = project.characters[0].id;
    expect(checkProject(duplicate).some((i) => i.ruleId === 'duplicate-id')).toBe(true);
    expect(
      projectSchema.safeParse({ ...project, relationships: [{ ...relation, affinity: 101 }] }).success,
    ).toBe(false);
    expect(
      projectSchema.safeParse({ ...project, relationships: [{ ...relation, affinity: 1.5 }] }).success,
    ).toBe(false);
  });
  it('两个不同关系对象可以按对象版本合并；修改同一关系会冲突', () => {
    const { project, relation } = fixture();
    project.relationships.push({ ...relation, id: id(), title: '秘密关联' });
    const first = structuredClone(project),
      second = structuredClone(project);
    first.relationships[0].affinity = 60;
    second.relationships[1].description = '独立的秘密';
    const a = diff(project, first, {}),
      b = diff(project, second, {}),
      afterA = applyChanges(project, {}, a);
    const versions = { [keyOf(a[0])]: 1 };
    const merged = applyChanges(afterA, versions, b);
    expect(merged.relationships[0].affinity).toBe(60);
    expect(merged.relationships[1].description).toBe('独立的秘密');
    expect(() => applyChanges(merged, versions, a)).toThrow('更新');
    expect(touched(a)).toEqual(
      expect.arrayContaining([
        `relationships:${relation.id}`,
        `characters:${relation.sourceCharacterId}`,
        `characters:${relation.targetCharacterId}`,
      ]),
    );
  });
  it('服务端合并校验阻止删除仍有关系引用的角色，原数据保持完整', () => {
    const { project } = fixture();
    const removed = structuredClone(project);
    removed.characters.pop();
    expect(() => applyChanges(project, {}, diff(project, removed, {}))).toThrow('角色');
    expect(project.characters).toHaveLength(2);
    expect(project.relationships).toHaveLength(1);
  });
});
