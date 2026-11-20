import { conditionsOf, effectsOf, ports, type Project, type Value } from './model';

export interface Issue {
  ruleId: string;
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
}
export const typeMatches = (type: string, value: Value) =>
  typeof value === type && (typeof value !== 'number' || Number.isFinite(value));

export function checkProject(p: Project): Issue[] {
  const issues: Issue[] = [];
  const push = (ruleId: string, level: Issue['level'], message: string, nodeId?: string) =>
    issues.push({ ruleId, level, message, nodeId });
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  const variables = new Map(p.variables.map((v) => [v.id, v]));
  const folders = new Set(p.folders.map((f) => f.id));
  const boards = new Map(p.boards.map((b) => [b.id, b]));
  // IDs are globally unique inside a project, including ports and dialogue lines.
  const seen = new Set<string>();
  for (const objectId of [
    ...p.folders,
    ...p.boards,
    ...p.nodes,
    ...p.edges,
    ...p.characters,
    ...p.variables,
    ...(p.relationships ?? []),
  ]
    .map((o) => o.id)
    .concat(
      p.nodes.flatMap((n) => [
        ...ports(n).map((port) => port.id),
        ...(n.type === 'story' ? n.lines.map((l) => l.id) : []),
      ]),
    )) {
    if (seen.has(objectId)) push('duplicate-id', 'error', '项目内存在重复标识，请修复导入数据。');
    seen.add(objectId);
  }
  if (!p.entryNodeId || !nodes.has(p.entryNodeId) || nodes.get(p.entryNodeId)?.type !== 'start')
    push('entry', 'error', '项目缺少有效的正式起点。');
  const characterIds = new Set(p.characters.map((character) => character.id));
  for (const relation of p.relationships ?? []) {
    if (!characterIds.has(relation.sourceCharacterId) || !characterIds.has(relation.targetCharacterId))
      push('relationship-reference', 'error', `关系“${relation.title || relation.kind}”引用了不存在的角色。`);
    if (relation.sourceCharacterId === relation.targetCharacterId)
      push('relationship-self', 'error', '角色关系必须连接两个不同角色。');
  }
  for (const b of p.boards) {
    if (!folders.has(b.folderId)) push('folder', 'error', `场景“${b.name}”的章节不存在。`);
    const starts = p.nodes.filter((n) => n.boardId === b.id && n.type === 'start');
    if (starts.length !== 1 || starts[0]?.id !== b.startNodeId)
      push('board-start', 'error', `场景“${b.name}”必须有且仅有一个有效起点。`, b.startNodeId);
  }
  const keys = new Set<string>();
  for (const v of p.variables) {
    if (keys.has(v.key)) push('variable-key', 'error', `变量 key“${v.key}”重复。`);
    keys.add(v.key);
    if (!typeMatches(v.type, v.defaultValue))
      push('variable-type', 'error', `变量“${v.name}”默认值与类型不一致。`);
  }
  const outgoing = new Map<string, string[]>();
  const addPath = (from: string, to: string) => outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  for (const edge of p.edges) {
    const source = nodes.get(edge.sourceNodeId),
      target = nodes.get(edge.targetNodeId);
    if (!source || !target) {
      push('edge-reference', 'error', '存在连接到已丢失节点的连线。', source?.id);
      continue;
    }
    if (source.boardId !== target.boardId || edge.boardId !== source.boardId)
      push('cross-board', 'error', '跨场景必须通过跳转节点连接。', source.id);
    if (target.type === 'start') push('start-target', 'error', '普通连线不能指向起点。', source.id);
    if (!ports(source).some((port) => port.id === edge.sourcePortId))
      push('port-reference', 'error', '连线引用的出口不存在。', source.id);
    addPath(source.id, target.id);
  }
  for (const n of p.nodes) {
    if (!boards.has(n.boardId)) push('board-reference', 'error', '节点所属的场景不存在。', n.id);
    for (const port of ports(n)) {
      const count = p.edges.filter((e) => e.sourceNodeId === n.id && e.sourcePortId === port.id).length;
      if (count !== 1)
        push(
          'port-count',
          'error',
          count === 0 ? `“${n.title}”的“${port.label}”尚未连接。` : `“${n.title}”的一个出口连接了多个目标。`,
          n.id,
        );
    }
    if (n.type === 'jump') {
      if (!n.targetNodeId || !nodes.has(n.targetNodeId))
        push('jump-reference', 'error', `“${n.title}”没有有效跳转目标。`, n.id);
      else addPath(n.id, n.targetNodeId);
    }
    if (n.type === 'choice') {
      if (!n.options.length) push('choice-empty', 'error', `“${n.title}”没有选项。`, n.id);
      else if (n.options.every((o) => o.condition))
        push('choice-fallback', 'warning', `“${n.title}”没有无条件选项，可能出现无路可走的情况。`, n.id);
      if (n.options.some((o) => !o.text.trim()))
        push('choice-text', 'warning', `“${n.title}”包含空选项文案。`, n.id);
    }
    if (
      (n.type === 'story' && !n.text.trim() && !n.lines.some((l) => l.text.trim())) ||
      (n.type === 'end' && !n.text.trim())
    )
      push('empty-text', 'warning', `“${n.title}”还没有正文。`, n.id);
    if (n.type === 'story')
      for (const line of n.lines) {
        if (line.speakerId && !p.characters.some((c) => c.id === line.speakerId))
          push('character-reference', 'error', '对白引用的角色不存在。', n.id);
      }
    for (const condition of conditionsOf(n)) {
      const v = variables.get(condition.variableId);
      if (
        !v ||
        !typeMatches(v.type, condition.value) ||
        (v.type !== 'number' && !['eq', 'neq'].includes(condition.operator))
      )
        push('condition-type', 'error', `“${n.title}”的条件类型或变量引用无效。`, n.id);
    }
    for (const effect of effectsOf(n)) {
      const v = variables.get(effect.variableId);
      if (!v || !typeMatches(v.type, effect.value) || (effect.operation !== 'set' && v.type !== 'number'))
        push('effect-type', 'error', `“${n.title}”的变量效果类型或引用无效。`, n.id);
    }
  }
  const reachable = new Set<string>(),
    pending = p.entryNodeId ? [p.entryNodeId] : [];
  while (pending.length) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  for (const n of p.nodes)
    if (!reachable.has(n.id)) push('unreachable', 'warning', `“${n.title}”从正式入口按图结构不可达。`, n.id);
  const reverse = new Map<string, string[]>();
  outgoing.forEach((targets, source) =>
    targets.forEach((target) => reverse.set(target, [...(reverse.get(target) ?? []), source])),
  );
  const toEnd = new Set<string>(),
    ends = p.nodes.filter((n) => n.type === 'end').map((n) => n.id);
  while (ends.length) {
    const current = ends.pop()!;
    if (toEnd.has(current)) continue;
    toEnd.add(current);
    ends.push(...(reverse.get(current) ?? []));
  }
  for (const n of p.nodes)
    if (reachable.has(n.id) && !toEnd.has(n.id))
      push('no-ending', 'warning', `“${n.title}”没有通向结局的结构路径。`, n.id);
  const color = new Map<string, number>();
  let cycleFound = false;
  for (const n of p.nodes) {
    if (color.has(n.id) || cycleFound) continue;
    const stack = [{ nodeId: n.id, index: 0 }];
    color.set(n.id, 1);
    while (stack.length && !cycleFound) {
      const frame = stack[stack.length - 1],
        targets = outgoing.get(frame.nodeId) ?? [];
      if (frame.index >= targets.length) {
        color.set(frame.nodeId, 2);
        stack.pop();
        continue;
      }
      const next = targets[frame.index++];
      if (color.get(next) === 1) {
        push(
          'cycle',
          'warning',
          '图中存在返回循环，请试跑验证玩家是否能够退出。循环不会自动判为错误。',
          next,
        );
        cycleFound = true;
      } else if (!color.has(next)) {
        color.set(next, 1);
        stack.push({ nodeId: next, index: 0 });
      }
    }
  }
  return issues;
}
