import { describe, expect, it } from 'vitest';
import { sampleProject } from './sample';
import { advance, applyEffects, enter, initialState, evaluate } from './runtime';
import { checkProject } from './check';
import { backup, importBackup, runtimeExport } from './transfer';
import { createNode, id, ports, type Project } from './model';

function node(p: Project, title: string) {
  return p.nodes.find((n) => n.title === title)!;
}
describe('剧情运行语义', () => {
  it('示例没有结构错误，合法返回循环仅提示警告', () => {
    const issues = checkProject(sampleProject());
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(issues.map((i) => i.ruleId)).toEqual(['cycle']);
  });
  it('帮助守卫取得钥匙，保留变量跳转到仓库', () => {
    const p = sampleProject(),
      state = initialState(p);
    let frame = enter(p, p.entryNodeId!, state);
    expect(frame.nodeId).toBe(node(p, '守卫的请求').id);
    frame = advance(p, frame);
    const choice = node(p, '一个小小的决定');
    if (choice.type !== 'choice') throw Error();
    frame = advance(p, frame, choice.options[0].id);
    const key = p.variables.find((v) => v.key === 'hasKey')!,
      trust = p.variables.find((v) => v.key === 'trust')!;
    expect(frame.state[key.id]).toBe(true);
    expect(frame.state[trust.id]).toBe(1);
    frame = advance(p, frame);
    expect(frame.nodeId).toBe(node(p, '尘封的地图').id);
    expect(frame.state[key.id]).toBe(true);
    expect(frame.error).toBeUndefined();
    expect(state[key.id]).toBe(false);
    frame = advance(p, frame);
    expect(frame.nodeId).toBe(node(p, '结局 · 新的旅程').id);
  });
  it('不帮忙时走上锁路线，可以返回或离开', () => {
    const p = sampleProject(),
      choice = node(p, '一个小小的决定');
    if (choice.type !== 'choice') throw Error();
    let frame = enter(p, choice.id, initialState(p));
    frame = advance(p, frame, choice.options[1].id);
    expect(frame.nodeId).toBe(node(p, '上锁的门').id);
    frame = advance(p, frame);
    const returnChoice = node(p, '回头，还是离开？');
    if (returnChoice.type !== 'choice') throw Error();
    expect(advance(p, frame, returnChoice.options[0].id).nodeId).toBe(node(p, '守卫的请求').id);
    expect(advance(p, frame, returnChoice.options[1].id).nodeId).toBe(node(p, '结局 · 擦肩而过').id);
  });
  it('条件节点只选择第一个命中分支', () => {
    const p = sampleProject(),
      gate = node(p, '是否持有钥匙？');
    if (gate.type !== 'condition') throw Error();
    gate.branches.push({ id: id(), condition: { ...gate.branches[0].condition } });
    p.edges.push({
      id: id(),
      boardId: gate.boardId,
      sourceNodeId: gate.id,
      sourcePortId: gate.branches[1].id,
      targetNodeId: node(p, '上锁的门').id,
    });
    const state = initialState(p);
    state[p.variables.find((v) => v.key === 'hasKey')!.id] = true;
    expect(enter(p, gate.id, state).nodeId).toBe(node(p, '尘封的地图').id);
  });
  it('效果组发生溢出后原始状态不变', () => {
    const p = sampleProject(),
      trust = p.variables.find((v) => v.key === 'trust')!,
      key = p.variables.find((v) => v.key === 'hasKey')!;
    const state = initialState(p);
    state[trust.id] = Number.MAX_VALUE;
    expect(() =>
      applyEffects(p, state, [
        { variableId: key.id, operation: 'set', value: true },
        { variableId: trust.id, operation: 'add', value: Number.MAX_VALUE },
      ]),
    ).toThrow('溢出');
    expect(state[key.id]).toBe(false);
    expect(state[trust.id]).toBe(Number.MAX_VALUE);
  });
  it('重复进入剧情会再次执行效果，而保存的历史帧可原样恢复', () => {
    const p = sampleProject(),
      help = node(p, '交换来的钥匙');
    if (help.type !== 'story') throw Error();
    const trust = p.variables.find((v) => v.key === 'trust')!;
    help.effects = [{ variableId: trust.id, operation: 'add', value: 1 }];
    const before = enter(p, help.id, initialState(p)),
      frozen = structuredClone(before);
    expect(enter(p, help.id, before.state).state[trust.id]).toBe(2);
    advance(p, before);
    expect(frozen.state[trust.id]).toBe(1);
    expect(before).toEqual(frozen);
  });
  it('自动循环最多运行 100 步', () => {
    const p = sampleProject(),
      jump = createNode('jump', p.boards[0].id);
    if (jump.type !== 'jump') throw Error();
    jump.targetNodeId = jump.id;
    p.nodes.push(jump);
    const frame = enter(p, jump.id, initialState(p));
    expect(frame.error).toContain('100');
    expect(frame.path.length).toBe(100);
  });
  it('所有选择条件为假时停止，不假装到达结局', () => {
    const p = sampleProject(),
      choice = node(p, '一个小小的决定');
    if (choice.type !== 'choice') throw Error();
    choice.options.forEach((o) => {
      o.condition = { variableId: p.variables[0].id, operator: 'eq', value: true };
    });
    expect(enter(p, choice.id, initialState(p)).error).toContain('死路');
  });
  it('条件比较拒绝类型混用，字符串仅允许相等比较', () => {
    const variableId = id();
    expect(() => evaluate({ variableId, operator: 'eq', value: 1 }, { [variableId]: '1' })).toThrow();
    expect(() => evaluate({ variableId, operator: 'gt', value: 'a' }, { [variableId]: 'z' })).toThrow();
  });
});
describe('数据校验与交付', () => {
  it('文案/顺序变化不改变选择出口标识', () => {
    const p = sampleProject(),
      choice = node(p, '一个小小的决定');
    if (choice.type !== 'choice') throw Error();
    const firstId = choice.options[0].id,
      destination = p.edges.find((e) => e.sourcePortId === firstId)!.targetNodeId;
    choice.options.reverse();
    choice.options[1].text = '新的文案';
    expect(ports(choice)[1].id).toBe(firstId);
    expect(p.edges.find((e) => e.sourcePortId === firstId)!.targetNodeId).toBe(destination);
    expect(checkProject(p).filter((i) => i.level === 'error')).toEqual([]);
  });
  it('备份导入保持内部引用和运行结果，创建新项目', () => {
    const p = sampleProject(),
      imported = importBackup(JSON.stringify(backup(p)));
    expect(imported.id).not.toBe(p.id);
    expect(imported.nodes).toEqual(p.nodes);
    expect(imported.edges).toEqual(p.edges);
    expect(checkProject(imported).filter((i) => i.level === 'error')).toEqual([]);
    expect(enter(imported, imported.entryNodeId!, initialState(imported))).toEqual(
      enter(p, p.entryNodeId!, initialState(p)),
    );
  });
  it('允许未连接草稿备份，禁止导出为运行数据', () => {
    const p = sampleProject();
    p.edges.pop();
    expect(importBackup(JSON.stringify(backup(p))).nodes).toEqual(p.nodes);
    expect(() => runtimeExport(p)).toThrow('修复');
  });
  it('导入拒绝未知版本、任意字段及重复标识', () => {
    const p = sampleProject(),
      data = backup(p);
    expect(() => importBackup(JSON.stringify({ ...data, schemaVersion: 99 }))).toThrow('格式');
    expect(() => importBackup(JSON.stringify({ ...data, token: 'secret' }))).toThrow('格式');
    p.nodes[1].id = p.nodes[0].id;
    expect(() => importBackup(JSON.stringify(backup(p)))).toThrow('校验');
  });
  it('失效角色、数值条件错误、跨场景普通连线均阻止交付', () => {
    const p = sampleProject(),
      talk = node(p, '守卫的请求');
    if (talk.type !== 'story') throw Error();
    talk.lines[0].speakerId = id();
    p.edges[0].targetNodeId = p.boards[1].startNodeId;
    const gate = node(p, '是否持有钥匙？');
    if (gate.type !== 'condition') throw Error();
    gate.branches[0].condition.operator = 'gt';
    expect(checkProject(p).map((i) => i.ruleId)).toEqual(
      expect.arrayContaining(['character-reference', 'cross-board', 'condition-type']),
    );
    expect(() => runtimeExport(p)).toThrow();
  });
  it('运行数据剥离坐标和创作状态，按标识稳定排序', () => {
    const p = sampleProject(),
      data = runtimeExport(p);
    expect(data.nodes[0]).not.toHaveProperty('position');
    expect(data.nodes[0]).not.toHaveProperty('status');
    expect(data.nodes.map((n) => n.id)).toEqual(
      [...p.nodes.map((n) => n.id)].sort((a, b) => a.localeCompare(b)),
    );
  });
});
