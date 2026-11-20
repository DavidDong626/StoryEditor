import { type Condition, type Effect, type Project, type StoryNode, type Value } from './model';
import { typeMatches } from './check';

export type State = Record<string, Value>;
export interface RunFrame {
  nodeId: string;
  state: State;
  path: string[];
  error?: string;
}
export function evaluate(condition: Condition, state: State): boolean {
  const a = state[condition.variableId],
    b = condition.value;
  if (a === undefined || typeof a !== typeof b) throw new Error('条件变量丢失或类型不一致。');
  switch (condition.operator) {
    case 'eq':
      return a === b;
    case 'neq':
      return a !== b;
    default: {
      if (typeof a !== 'number' || typeof b !== 'number') throw new Error('大小比较只适用于数值。');
      switch (condition.operator) {
        case 'gt':
          return a > b;
        case 'gte':
          return a >= b;
        case 'lt':
          return a < b;
        case 'lte':
          return a <= b;
      }
    }
  }
}
export function applyEffects(p: Project, state: State, effects: Effect[]): State {
  const next = { ...state };
  for (const e of effects) {
    const v = p.variables.find((v) => v.id === e.variableId),
      previous = next[e.variableId];
    if (!v || !typeMatches(v.type, e.value) || previous === undefined || !typeMatches(v.type, previous))
      throw new Error('变量效果的类型或引用无效。');
    if (e.operation === 'set') next[v.id] = e.value;
    else {
      if (typeof previous !== 'number' || typeof e.value !== 'number')
        throw new Error('只有数值变量支持增加和减少。');
      const result = e.operation === 'add' ? previous + e.value : previous - e.value;
      if (!Number.isFinite(result)) throw new Error('数值结果溢出，本组效果未执行。');
      next[v.id] = result;
    }
  }
  return next;
}
const target = (p: Project, nodeId: string, portId: string) => {
  const edges = p.edges.filter((e) => e.sourceNodeId === nodeId && e.sourcePortId === portId);
  if (edges.length !== 1) throw new Error('当前出口没有唯一有效的连线。');
  return edges[0].targetNodeId;
};
export function enter(p: Project, nodeId: string, state: State, path: string[] = []): RunFrame {
  let current = nodeId,
    next = { ...state };
  const trail = [...path];
  for (let steps = 0; steps < 100; steps++) {
    const n = p.nodes.find((n) => n.id === current);
    if (!n) return { nodeId: current, state: next, path: trail, error: '目标节点不存在。' };
    trail.push(n.id);
    try {
      if (n.type === 'start') current = target(p, n.id, n.portId);
      else if (n.type === 'jump') {
        if (!n.targetNodeId) throw new Error('跳转目标尚未指定。');
        current = n.targetNodeId;
      } else if (n.type === 'condition')
        current = target(p, n.id, n.branches.find((b) => evaluate(b.condition, next))?.id ?? n.fallbackId);
      else {
        if (n.type === 'story') next = applyEffects(p, next, n.effects);
        if (n.type === 'choice' && !n.options.some((o) => !o.condition || evaluate(o.condition, next)))
          throw new Error('所有选项均不可用，剧情进入死路。');
        return { nodeId: current, state: next, path: trail };
      }
    } catch (e) {
      return { nodeId: n.id, state: next, path: trail, error: (e as Error).message };
    }
  }
  return {
    nodeId: current,
    state: next,
    path: trail,
    error: '连续自动执行达到 100 步，已暂停。请检查循环路径。',
  };
}
export function initialState(p: Project): State {
  return Object.fromEntries(p.variables.map((v) => [v.id, v.defaultValue]));
}
export function advance(p: Project, frame: RunFrame, optionId?: string): RunFrame {
  const n = p.nodes.find((n) => n.id === frame.nodeId);
  if (!n || frame.error) return frame;
  try {
    if (n.type === 'story') return enter(p, target(p, n.id, n.portId), frame.state, frame.path);
    if (n.type === 'choice') {
      const option = n.options.find((o) => o.id === optionId);
      if (!option || (option.condition && !evaluate(option.condition, frame.state)))
        throw new Error('该选项不可用。');
      const destination = target(p, n.id, option.id);
      const next = applyEffects(p, frame.state, option.effects);
      return enter(p, destination, next, frame.path);
    }
    return frame;
  } catch (e) {
    return { ...frame, error: (e as Error).message };
  }
}
export function visibleOptions(n: StoryNode, state: State) {
  if (n.type !== 'choice') return [];
  return n.options.filter((o) => !o.condition || evaluate(o.condition, state));
}
