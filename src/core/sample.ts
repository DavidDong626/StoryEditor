import { createNode, id, type Project, type StoryNode } from './model';

export function sampleProject(): Project {
  const folder = id(),
    village = id(),
    warehouse = id(),
    guard = id(),
    key = id(),
    trust = id();
  const start = createNode('start', village, { x: 40, y: 220 });
  start.title = '村庄 · 黄昏';
  const talk = createNode('story', village, { x: 350, y: 220 });
  if (talk.type === 'story') {
    talk.title = '守卫的请求';
    talk.text = '暮色落在村庄门口。守卫挡住了去往仓库的小路，看起来有些疲惫。';
    talk.lines = [{ id: id(), speakerId: guard, text: '仓库里有你要找的东西。不过，你愿意先帮我一个忙吗？' }];
  }
  const choice = createNode('choice', village, { x: 690, y: 205 });
  if (choice.type === 'choice') {
    choice.title = '一个小小的决定';
    choice.text = '是否帮助守卫寻找丢失的灯笼？';
    choice.options[0].text = '答应帮忙';
    choice.options[0].effects = [{ variableId: trust, operation: 'add', value: 1 }];
    choice.options[1].text = '直接前往仓库';
  }
  const help = createNode('story', village, { x: 1030, y: 70 });
  if (help.type === 'story') {
    help.title = '交换来的钥匙';
    help.text = '你在草丛里找到了灯笼。守卫道谢，将一把旧铜钥匙放进你的手心。';
    help.lines = [{ id: id(), speakerId: guard, text: '拿着它。仓库的门一直在等一个值得信任的人。' }];
    help.effects = [{ variableId: key, operation: 'set', value: true }];
  }
  const gate = createNode('condition', village, { x: 1370, y: 220 });
  if (gate.type === 'condition') {
    gate.title = '是否持有钥匙？';
    gate.branches = [{ id: id(), condition: { variableId: key, operator: 'eq', value: true } }];
  }
  const jump = createNode('jump', village, { x: 1710, y: 80 });
  jump.title = '进入旧仓库';
  const locked = createNode('story', village, { x: 1710, y: 370 });
  if (locked.type === 'story') {
    locked.title = '上锁的门';
    locked.text = '铜锁发出沉闷的响声。没有钥匙，似乎无法继续前进。';
  }
  const returnChoice = createNode('choice', village, { x: 2050, y: 350 });
  if (returnChoice.type === 'choice') {
    returnChoice.title = '回头，还是离开？';
    returnChoice.text = '还有机会改变决定。';
    returnChoice.options[0].text = '回去找守卫';
    returnChoice.options[1].text = '离开村庄';
  }
  const leave = createNode('end', village, { x: 2390, y: 450 });
  if (leave.type === 'end') {
    leave.title = '结局 · 擦肩而过';
    leave.text = '你沿着暮色中的道路离开。仓库里的秘密，留给了另一个故事。';
    leave.endingKey = 'leave_village';
  }
  const warehouseStart = createNode('start', warehouse, { x: 50, y: 190 });
  warehouseStart.title = '仓库入口';
  const discovery = createNode('story', warehouse, { x: 380, y: 190 });
  if (discovery.type === 'story') {
    discovery.title = '尘封的地图';
    discovery.text = '门缓缓打开。一张画着陌生群岛的地图，静静地躺在桌上。故事从这里，才真正开始。';
  }
  const ending = createNode('end', warehouse, { x: 720, y: 190 });
  if (ending.type === 'end') {
    ending.title = '结局 · 新的旅程';
    ending.text = '你收起地图，望向远方。';
    ending.endingKey = 'new_journey';
  }
  if (jump.type === 'jump') jump.targetNodeId = warehouseStart.id;
  const edge = (a: StoryNode, b: StoryNode, port?: string) => ({
    id: id(),
    boardId: a.boardId,
    sourceNodeId: a.id,
    sourcePortId: port ?? ('portId' in a ? a.portId : ''),
    targetNodeId: b.id,
  });
  return {
    schemaVersion: 2,
    relationships: [],
    id: id(),
    name: '雾港来信',
    revision: 0,
    entryNodeId: start.id,
    folders: [{ id: folder, name: '第一章 · 暮色中的村庄' }],
    boards: [
      { id: village, folderId: folder, name: '村庄入口', startNodeId: start.id },
      { id: warehouse, folderId: folder, name: '旧仓库', startNodeId: warehouseStart.id },
    ],
    nodes: [
      start,
      talk,
      choice,
      help,
      gate,
      jump,
      locked,
      returnChoice,
      leave,
      warehouseStart,
      discovery,
      ending,
    ].map((n) => ({ ...n, status: 'draft' })),
    edges: [
      edge(start, talk),
      edge(talk, choice),
      edge(choice, help, choice.type === 'choice' ? choice.options[0].id : ''),
      edge(choice, gate, choice.type === 'choice' ? choice.options[1].id : ''),
      edge(help, gate),
      edge(gate, jump, gate.type === 'condition' ? gate.branches[0].id : ''),
      edge(gate, locked, gate.type === 'condition' ? gate.fallbackId : ''),
      edge(locked, returnChoice),
      edge(returnChoice, talk, returnChoice.type === 'choice' ? returnChoice.options[0].id : ''),
      edge(returnChoice, leave, returnChoice.type === 'choice' ? returnChoice.options[1].id : ''),
      edge(warehouseStart, discovery),
      edge(discovery, ending),
    ],
    characters: [
      {
        id: guard,
        name: '守卫 · 林恩',
        description: '村庄的守卫。看似严肃，愿意信任伸出援手的人。',
        color: 'violet',
      },
    ],
    variables: [
      { id: key, key: 'hasKey', name: '持有仓库钥匙', type: 'boolean', defaultValue: false },
      { id: trust, key: 'trust', name: '守卫的信任', type: 'number', defaultValue: 0 },
    ],
  };
}
