import { z } from 'zod';

export { id } from './id';
import { id } from './id';
const uuid = z.string().uuid();
const text = z.string().max(100_000);
const scalar = z.union([z.boolean(), z.number().finite(), z.string().max(10_000)]);
export type Value = z.infer<typeof scalar>;
export const conditionSchema = z
  .object({
    variableId: uuid,
    operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
    value: scalar,
  })
  .strict();
export const effectSchema = z
  .object({ variableId: uuid, operation: z.enum(['set', 'add', 'subtract']), value: scalar })
  .strict();
const optionSchema = z
  .object({ id: uuid, text, condition: conditionSchema.nullable(), effects: z.array(effectSchema).max(100) })
  .strict();
const base = {
  id: uuid,
  boardId: uuid,
  title: z.string().max(500),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  status: z.enum(['draft', 'review', 'approved']),
};
export const nodeSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('start'), portId: uuid }).strict(),
  z
    .object({
      ...base,
      type: z.literal('story'),
      portId: uuid,
      text,
      lines: z.array(z.object({ id: uuid, speakerId: uuid.nullable(), text }).strict()).max(1_000),
      effects: z.array(effectSchema).max(100),
    })
    .strict(),
  z.object({ ...base, type: z.literal('choice'), text, options: z.array(optionSchema).max(100) }).strict(),
  z
    .object({
      ...base,
      type: z.literal('condition'),
      branches: z.array(z.object({ id: uuid, condition: conditionSchema }).strict()).max(100),
      fallbackId: uuid,
    })
    .strict(),
  z.object({ ...base, type: z.literal('jump'), targetNodeId: uuid.nullable() }).strict(),
  z.object({ ...base, type: z.literal('end'), text, endingKey: z.string().max(100) }).strict(),
]);
export const relationshipSchema = z
  .object({
    id: uuid,
    title: z.string().max(200),
    sourceCharacterId: uuid,
    targetCharacterId: uuid,
    kind: z.string().max(60),
    direction: z.enum(['mutual', 'directed']),
    affinity: z.number().int().min(-100).max(100),
    description: z.string().max(10000),
    development: z.string().max(10000),
    status: z.enum(['draft', 'review', 'approved']),
  })
  .strict();
const projectV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: uuid,
    name: z.string().min(1).max(100),
    revision: z.number().int().nonnegative(),
    entryNodeId: uuid.nullable(),
    folders: z
      .array(z.object({ id: uuid, name: z.string().max(200) }).strict())
      .min(1)
      .max(1_000),
    boards: z
      .array(z.object({ id: uuid, folderId: uuid, name: z.string().max(200), startNodeId: uuid }).strict())
      .min(1)
      .max(1_000),
    nodes: z.array(nodeSchema).max(20_000),
    edges: z
      .array(
        z
          .object({ id: uuid, boardId: uuid, sourceNodeId: uuid, sourcePortId: uuid, targetNodeId: uuid })
          .strict(),
      )
      .max(50_000),
    characters: z
      .array(
        z
          .object({
            id: uuid,
            name: z.string().max(200),
            description: text,
            color: z.enum(['violet', 'amber', 'teal', 'rose']),
            avatar: z
              .string()
              .max(350000)
              .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
              .optional(),
          })
          .strict(),
      )
      .max(5_000),
    relationships: z.array(relationshipSchema).max(10000),
    variables: z
      .array(
        z
          .object({
            id: uuid,
            key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
            name: z.string().max(200),
            type: z.enum(['boolean', 'number', 'string']),
            defaultValue: scalar,
          })
          .strict(),
      )
      .max(5_000),
  })
  .strict();
// Preserve v1 projects and snapshots; migrations never regenerate object IDs.
export const projectSchema = z.preprocess((value) => {
  if (
    value &&
    typeof value === 'object' &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    !('relationships' in value)
  )
    return { ...value, schemaVersion: 2, relationships: [] };
  return value;
}, projectV2Schema);
export type Project = z.infer<typeof projectSchema>;
export type Relationship = z.infer<typeof relationshipSchema>;
export type StoryNode = z.infer<typeof nodeSchema>;
export type NodeType = StoryNode['type'];
export type Condition = z.infer<typeof conditionSchema>;
export type Effect = z.infer<typeof effectSchema>;
export type Variable = Project['variables'][number];
export type Character = Project['characters'][number];
export type Edge = Project['edges'][number];

export const nodeMeta: Record<NodeType, { label: string; description: string; color: string }> = {
  start: { label: '起点', description: '一个场景的故事入口', color: '#279c87' },
  story: { label: '剧情', description: '叙述、对白与角色行动', color: '#6366d8' },
  choice: { label: '选择', description: '把决定交给玩家', color: '#cf9445' },
  condition: { label: '条件', description: '按变量自动判断路线', color: '#4a8fba' },
  jump: { label: '跳转', description: '前往另一场景或节点', color: '#9a6cc1' },
  end: { label: '结局', description: '结束这一次故事旅程', color: '#c36c7b' },
};

export function createNode(type: NodeType, boardId: string, position = { x: 0, y: 0 }): StoryNode {
  const common = {
    id: id(),
    boardId,
    title: `未命名${nodeMeta[type].label}`,
    position,
    status: 'draft' as const,
  };
  switch (type) {
    case 'start':
      return { ...common, type, title: '场景起点', portId: id() };
    case 'story':
      return { ...common, type, portId: id(), text: '', lines: [], effects: [] };
    case 'choice':
      return {
        ...common,
        type,
        text: '',
        options: [
          { id: id(), text: '选项一', condition: null, effects: [] },
          { id: id(), text: '选项二', condition: null, effects: [] },
        ],
      };
    case 'condition':
      return { ...common, type, branches: [], fallbackId: id() };
    case 'jump':
      return { ...common, type, targetNodeId: null };
    case 'end':
      return { ...common, type, text: '', endingKey: '' };
  }
}

export function ports(node: StoryNode): { id: string; label: string }[] {
  switch (node.type) {
    case 'start':
    case 'story':
      return [{ id: node.portId, label: '继续' }];
    case 'choice':
      return node.options.map((o) => ({ id: o.id, label: o.text || '未命名选项' }));
    case 'condition':
      return [
        ...node.branches.map((b, i) => ({ id: b.id, label: `条件 ${i + 1}` })),
        { id: node.fallbackId, label: '否则' },
      ];
    default:
      return [];
  }
}

export function newProject(name = '未命名故事'): Project {
  const folderId = id(),
    boardId = id();
  const start = createNode('start', boardId, { x: 80, y: 180 });
  return {
    schemaVersion: 2,
    relationships: [],
    id: id(),
    name,
    revision: 0,
    entryNodeId: start.id,
    folders: [{ id: folderId, name: '第一章' }],
    boards: [{ id: boardId, folderId, name: '新的场景', startNodeId: start.id }],
    nodes: [start],
    edges: [],
    characters: [],
    variables: [],
  };
}

export function conditionsOf(node: StoryNode): Condition[] {
  return node.type === 'choice'
    ? node.options.flatMap((o) => (o.condition ? [o.condition] : []))
    : node.type === 'condition'
      ? node.branches.map((b) => b.condition)
      : [];
}
export function effectsOf(node: StoryNode): Effect[] {
  return node.type === 'story'
    ? node.effects
    : node.type === 'choice'
      ? node.options.flatMap((o) => o.effects)
      : [];
}
