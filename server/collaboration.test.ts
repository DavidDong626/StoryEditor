import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollaborationServer } from './index';
import { sampleProject } from '../src/core/sample';
import { diff, touched, type Envelope, type Command } from '../src/core/collaboration';

const origin = 'http://collaboration.test';
type Client = { cookie: string; id: string; userId: string };
describe('真实 HTTP / WebSocket 协作服务', () => {
  const directory = mkdtempSync(join(tmpdir(), 'story-collab-'));
  let service: ReturnType<typeof createCollaborationServer>, url: string;
  let owner: Client, editor: Client, viewer: Client, outsider: Client, extra: Client, last: Client;
  const sockets: WebSocket[] = [];
  async function start() {
    service = createCollaborationServer(join(directory, 'test.sqlite'), origin);
    await new Promise<void>((done) => service.http.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(service.http.address() as { port: number }).port}`;
  }
  async function request(client: Client, path: string, body?: unknown) {
    return fetch(`${url}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        Cookie: client.cookie,
        'Content-Type': 'application/json',
        'X-Story-Client': client.id,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function api<T = any>(client: Client, path: string, body?: unknown): Promise<T> {
    const response = await request(client, path, body);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
  }
  async function register(name: string): Promise<Client> {
    const response = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: 'collaboration-test-password' }),
    });
    expect(response.status).toBe(200);
    const user = await response.json();
    return { cookie: response.headers.getSetCookie()[0].split(';')[0], id: randomUUID(), userId: user.id };
  }
  async function invite(project: string, client: Client, role = 'editor') {
    const invitation = await api(owner, `/projects/${project}/invite`, { role });
    const token = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('invite');
    return api<Envelope>(client, '/join', { token });
  }
  async function connect(client: Client, project: string) {
    const socket = new WebSocket(
      `${url.replace('http:', 'ws:')}/sync?project=${project}&client=${client.id}`,
      { headers: { Origin: origin, Cookie: client.cookie } },
    );
    sockets.push(socket);
    await new Promise<void>((done, fail) => {
      socket.once('message', () => done());
      socket.once('error', fail);
    });
    return socket;
  }
  async function project() {
    const data = await api<Envelope>(owner, '/projects', sampleProject());
    await connect(owner, data.project.id);
    return data;
  }
  async function command(
    client: Client,
    before: Envelope,
    after: Envelope['project'],
    operationId = randomUUID(),
  ): Promise<Command> {
    const changes = diff(before.project, after, before.versions),
      leases = await api(client, `/projects/${before.project.id}/leases`, { keys: touched(changes) });
    return { operationId, epoch: before.epoch, label: '测试修改', changes, leases };
  }
  async function release(client: Client, id: string, cmd: Command) {
    await api(client, `/projects/${id}/leases`, { keys: touched(cmd.changes), release: true });
  }
  beforeAll(async () => {
    await start();
    [owner, editor, viewer, outsider, extra, last] = await Promise.all(
      ['owner', 'editor', 'viewer', 'outsider', 'extra', 'last'].map(register),
    );
  });
  afterAll(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  afterEach(async () => {
    await Promise.all(
      sockets.splice(0).map(
        (socket) =>
          new Promise<void>((done) => {
            if (socket.readyState === WebSocket.CLOSED) return done();
            socket.once('close', () => done());
            socket.close();
          }),
      ),
    );
  });

  it('不同节点的并发修改合并为两个连续版本，并推送给另一客户端', async () => {
    const data = await project(),
      id = data.project.id;
    await invite(id, editor);
    const peer = await connect(editor, id);
    const first = structuredClone(data.project),
      second = structuredClone(data.project);
    first.nodes[1].title = '成员 A';
    second.nodes[2].title = '成员 B';
    const a = await command(owner, data, first),
      b = await command(editor, { ...data, role: 'editor' }, second);
    const received: Promise<Envelope> = new Promise((done) => {
      const listener = (raw: Buffer) => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'state' && event.state.project.revision === 2) {
          peer.off('message', listener);
          done(event.state);
        }
      };
      peer.on('message', listener);
    });
    await Promise.all([
      api(owner, `/projects/${id}/commands`, a),
      api(editor, `/projects/${id}/commands`, b),
    ]);
    const final = await received;
    expect(final.project.nodes[1].title).toBe('成员 A');
    expect(final.project.nodes[2].title).toBe('成员 B');
  });
  it('同一节点占用互斥，释放后旧 fencing token 不能写入', async () => {
    const data = await project(),
      id = data.project.id;
    await invite(id, editor);
    await connect(editor, id);
    const next = structuredClone(data.project);
    next.nodes[1].title = '过期提交';
    const cmd = await command(owner, data, next);
    expect((await request(editor, `/projects/${id}/leases`, { keys: touched(cmd.changes) })).status).toBe(
      409,
    );
    await release(owner, id, cmd);
    await api(editor, `/projects/${id}/leases`, { keys: touched(cmd.changes) });
    expect((await request(owner, `/projects/${id}/commands`, cmd)).status).toBe(409);
  });
  it('相同 operationId 的重试只提交一次，日志和业务数据一致', async () => {
    const data = await project(),
      id = data.project.id,
      next = structuredClone(data.project);
    next.nodes[1].title = '一次';
    const cmd = await command(owner, data, next);
    await api(owner, `/projects/${id}/commands`, cmd);
    await release(owner, id, cmd);
    const repeated = await api<Envelope>(owner, `/projects/${id}/commands`, cmd);
    expect(repeated.project.revision).toBe(1);
    expect((await api(owner, `/projects/${id}/history`)).length).toBe(1);
  });
  it('后续写入与 ABA 修改都使旧版本提交失效', async () => {
    const data = await project(),
      id = data.project.id,
      next = structuredClone(data.project);
    next.nodes[1].title = '中间值';
    const cmd = await command(owner, data, next);
    const updated = await api<Envelope>(owner, `/projects/${id}/commands`, cmd);
    const back = structuredClone(updated.project);
    back.nodes[1].title = data.project.nodes[1].title;
    await api(owner, `/projects/${id}/commands`, await command(owner, updated, back));
    const stale = await command(owner, data, next);
    expect((await request(owner, `/projects/${id}/commands`, stale)).status).toBe(409);
  });
  it('只读权限与未授权读取、订阅、导出在服务端拒绝', async () => {
    const data = await project(),
      id = data.project.id;
    await invite(id, viewer, 'viewer');
    expect(
      (await request(viewer, `/projects/${id}/leases`, { keys: [`nodes:${data.project.nodes[1].id}`] }))
        .status,
    ).toBe(403);
    expect((await request(viewer, `/projects/${id}/export?revision=0`)).status).toBe(403);
    expect((await request(outsider, `/projects/${id}`)).status).toBe(403);
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/sync?project=${id}&client=${outsider.id}`, {
      headers: { Origin: origin, Cookie: outsider.cookie },
    });
    const rejected = await new Promise<number>((done) => {
      socket.on('unexpected-response', (_req, res) => {
        done(res.statusCode!);
        res.resume();
      });
      socket.on('error', () => {});
    });
    expect(rejected).toBe(403);
  });
  it('邀请单次使用，成员上限 5 人，所有者不能被降权', async () => {
    const data = await project(),
      id = data.project.id;
    const invitation = await api(owner, `/projects/${id}/invite`, { role: 'editor' }),
      token = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('invite');
    await api(editor, '/join', { token });
    expect((await request(viewer, '/join', { token })).status).toBe(410);
    await invite(id, viewer, 'viewer');
    await invite(id, outsider);
    await invite(id, extra);
    const full = await api(owner, `/projects/${id}/invite`, { role: 'editor' });
    expect(
      (
        await request(last, '/join', {
          token: new URLSearchParams(new URL(full.url).hash.slice(1)).get('invite'),
        })
      ).status,
    ).toBe(409);
    expect((await request(owner, `/projects/${id}/members/${owner.userId}`, { role: 'viewer' })).status).toBe(
      400,
    );
  });
  it('恢复快照保留安全备份，递增 epoch，拒绝恢复前的操作', async () => {
    const data = await project(),
      id = data.project.id;
    await api(owner, `/projects/${id}/snapshots`, { name: '初始' });
    const next = structuredClone(data.project);
    next.nodes[1].title = '恢复前';
    const cmd = await command(owner, data, next);
    await api(owner, `/projects/${id}/commands`, cmd);
    const snapshots = await api(owner, `/projects/${id}/snapshots`);
    expect(
      (await request(owner, `/projects/${id}/restore`, { id: snapshots[0].id, revision: 0 })).status,
    ).toBe(409);
    const restored = await api<Envelope>(owner, `/projects/${id}/restore`, {
      id: snapshots[0].id,
      revision: 1,
    });
    expect(restored.epoch).toBe(2);
    expect(restored.project.revision).toBe(2);
    expect(restored.project.nodes[1].title).toBe(data.project.nodes[1].title);
    expect((await api(owner, `/projects/${id}/snapshots`)).length).toBe(2);
    expect((await request(owner, `/projects/${id}/commands`, cmd)).status).toBe(409);
  });
  it('撤销仅限自己的未被后续写入触及的对象，保留其他人的修改', async () => {
    const data = await project(),
      id = data.project.id;
    await invite(id, editor);
    await connect(editor, id);
    const first = structuredClone(data.project);
    first.nodes[1].title = '我的修改';
    const a = await command(owner, data, first);
    const updated = await api<Envelope>(owner, `/projects/${id}/commands`, a);
    await release(owner, id, a);
    const other = structuredClone(updated.project);
    other.nodes[2].title = '其他人的修改';
    const b = await command(editor, updated, other);
    await api(editor, `/projects/${id}/commands`, b);
    await release(editor, id, b);
    const undone = await api<Envelope>(owner, `/projects/${id}/undo`, {
      operationId: a.operationId,
      undoId: randomUUID(),
    });
    expect(undone.project.nodes[1].title).toBe(data.project.nodes[1].title);
    expect(undone.project.nodes[2].title).toBe('其他人的修改');
    expect(
      (await request(owner, `/projects/${id}/undo`, { operationId: b.operationId, undoId: randomUUID() }))
        .status,
    ).toBe(409);
    expect(
      (await request(owner, `/projects/${id}/undo`, { operationId: a.operationId, undoId: randomUUID() }))
        .status,
    ).toBe(409);
  });
  it('被移除的成员连接关闭，无法继续读取或写入', async () => {
    const data = await project(),
      id = data.project.id;
    await invite(id, editor);
    const peer = await connect(editor, id);
    const closed = new Promise<number>((done) => peer.once('close', (code) => done(code)));
    await api(owner, `/projects/${id}/members/${editor.userId}`, { role: 'remove' });
    expect(await closed).toBe(4003);
    expect((await request(editor, `/projects/${id}`)).status).toBe(403);
  });
  it('重启服务后项目、账号、快照和日志仍存在，旧租约不可用', async () => {
    const data = await project(),
      id = data.project.id,
      next = structuredClone(data.project);
    next.nodes[1].title = '持久保存';
    const cmd = await command(owner, data, next);
    await api(owner, `/projects/${id}/commands`, cmd);
    await api(owner, `/projects/${id}/snapshots`, { name: '重启前' });
    await service.close();
    await start();
    const restored = await api<Envelope>(owner, `/projects/${id}`);
    expect(restored.project.nodes[1].title).toBe('持久保存');
    expect((await api(owner, `/projects/${id}/snapshots`)).length).toBe(1);
    expect((await api(owner, `/projects/${id}/history`)).length).toBe(1);
    expect(
      (
        await request(owner, `/projects/${id}/commands`, {
          ...cmd,
          operationId: randomUUID(),
          changes: diff(restored.project, { ...restored.project, name: '重启后' }, restored.versions),
        })
      ).status,
    ).toBe(409);
  });
  it('租约 30 秒超时后可重新取得，旧 token 失效', async () => {
    const data = await project(),
      id = data.project.id;
    await invite(id, editor);
    await connect(editor, id);
    const next = structuredClone(data.project);
    next.nodes[1].title = '旧租约';
    const cmd = await command(owner, data, next);
    const now = Date.now(),
      clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31000);
    try {
      await api(editor, `/projects/${id}/leases`, { keys: touched(cmd.changes) });
      expect((await request(owner, `/projects/${id}/commands`, cmd)).status).toBe(409);
    } finally {
      clock.mockRestore();
    }
  });
  it('同账号另一登录会话不能复用旧租约，也不会泄露会话标识', async () => {
    const data = await project(),
      id = data.project.id,
      next = structuredClone(data.project);
    next.nodes[1].title = '跨会话提交';
    const cmd = await command(owner, data, next);
    const response = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'owner', password: 'collaboration-test-password' }),
    });
    const newSession = { ...owner, cookie: response.headers.getSetCookie()[0].split(';')[0] };
    await connect(newSession, id);
    expect((await request(newSession, `/projects/${id}/commands`, cmd)).status).toBe(409);
    expect(await api(owner, '/me')).not.toHaveProperty('session');
    await api(newSession, `/projects/${id}/leases`, { keys: touched(cmd.changes), release: true });
    expect((await request(editor, `/projects/${id}/leases`, { keys: touched(cmd.changes) })).status).toBe(
      403,
    );
    expect((await request(owner, `/projects/${id}/commands`, cmd)).status).toBe(200);
  });
});
