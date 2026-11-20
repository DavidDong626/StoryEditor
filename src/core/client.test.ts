import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteClient } from './client';
import { storedDrafts, deleteDraft } from './remote';
import { sampleProject } from './sample';
import { applyChanges, keyOf, type Envelope, type Command } from './collaboration';

class Socket {
  static current: Socket;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  constructor() {
    Socket.current = this;
  }
  close() {}
  message(state: Envelope) {
    this.onmessage?.({ data: JSON.stringify({ type: 'state', state }) });
  }
}
let client: RemoteClient, server: Envelope;
beforeEach(async () => {
  for (const draft of await storedDrafts()) await deleteDraft(draft.id);
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
  server = { project: sampleProject(), epoch: 1, versions: {}, role: 'owner' };
  client = new RemoteClient();
  client.open(structuredClone(server));
  Socket.current.message(server);
});
afterEach(() => {
  client.close();
  vi.unstubAllGlobals();
});
function transport(reject = false) {
  const commands: Command[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, options: { body: string }) => {
      const body = JSON.parse(options.body);
      if ('keys' in body)
        return Response.json(Object.fromEntries(body.keys.map((key: string) => [key, 'token'])));
      commands.push(body);
      if (reject) return Response.json({ error: '并发冲突' }, { status: 409 });
      const command = body as Command;
      server.project = applyChanges(server.project, server.versions, command.changes);
      for (const change of command.changes) server.versions[keyOf(change)] = change.version + 1;
      return Response.json(server);
    }),
  );
  return commands;
}
it('连续输入按顺序提交，自己的待确认版本正确递增，不产生错误冲突', async () => {
  const commands = transport(),
    before = structuredClone(server.project),
    first = structuredClone(before),
    second = structuredClone(before);
  first.nodes[1].title = '第一笔';
  second.nodes[1].title = '第二笔';
  client.submit(before, first, '修改标题');
  client.submit(first, second, '修改标题');
  await vi.waitFor(() => expect(client.state.pending).toBe(0));
  expect(client.state.status).toBe('online');
  expect(server.project.nodes[1].title).toBe('第二笔');
  expect(commands.map((c) => c.changes[0].version)).toEqual([0, 1]);
  await vi.waitFor(async () => expect(await storedDrafts()).toHaveLength(0));
});
it('冲突保留最新完整草稿，包括失败操作之后的输入，停止继续提交', async () => {
  const commands = transport(true),
    before = structuredClone(server.project),
    first = structuredClone(before),
    second = structuredClone(before);
  first.nodes[1].title = '第一笔';
  second.nodes[1].title = '最后一笔';
  client.submit(before, first, '修改标题');
  client.submit(first, second, '修改标题');
  await vi.waitFor(() => expect(client.state.pending).toBe(0));
  expect(client.state.status).toBe('conflict');
  expect(commands).toHaveLength(1);
  const drafts = await storedDrafts();
  expect(drafts).toHaveLength(1);
  expect(drafts[0].project.nodes[1].title).toBe('最后一笔');
});
it('断线立即禁用保存，接收到恢复后的版本不会自动重放旧草稿', async () => {
  Socket.current.onclose?.({ code: 1006 });
  expect(client.state.status).toBe('offline');
  expect(() => client.submit(server.project, { ...server.project, name: '离线修改' }, '重命名')).toThrow();
  const updated = structuredClone(server);
  updated.epoch = 2;
  updated.project.revision = 1;
  Socket.current.message(updated);
  expect(client.state.status).toBe('online');
  expect(client.state.data?.epoch).toBe(2);
});
