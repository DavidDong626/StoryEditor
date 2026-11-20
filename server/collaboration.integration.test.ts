import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createCollaborationServer } from './index';
import { sampleProject } from '../src/core/sample';
import { diff, touched, type Envelope } from '../src/core/collaboration';

const origin = 'http://127.0.0.1:5173';
type Account = { cookie: string; id: string; client: string };
describe('durable collaboration API and WebSocket', () => {
  let service: ReturnType<typeof createCollaborationServer>, base: string;
  beforeEach(async () => {
    service = createCollaborationServer(':memory:', origin);
    await new Promise<void>((resolve) => service.http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(service.http.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await service.close();
  });
  async function request(path: string, account?: Account, body?: unknown) {
    const response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(account ? { Cookie: account.cookie, 'X-Story-Client': account.client } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
    };
  }
  async function register(name: string): Promise<Account> {
    const r = await request('/auth/register', undefined, { name, password: 'test-only-long-password' });
    expect(r.status).toBe(200);
    return { id: r.data.id, cookie: r.cookie, client: randomUUID() };
  }
  async function publish(account: Account): Promise<Envelope> {
    const r = await request('/projects', account, sampleProject());
    expect(r.status).toBe(200);
    return r.data;
  }
  async function invite(
    owner: Account,
    project: string,
    member: Account,
    role: 'editor' | 'viewer' = 'editor',
  ) {
    const r = await request(`/projects/${project}/invite`, owner, { role });
    const token = new URLSearchParams(new URL(r.data.url).hash.slice(1)).get('invite');
    const joined = await request('/join', member, { token });
    expect(joined.status, JSON.stringify(joined.data)).toBe(200);
    return token;
  }
  async function socket(account: Account, project: string) {
    const ws = new WebSocket(
      `${base.replace('http:', 'ws:')}/sync?project=${project}&client=${account.client}`,
      { headers: { Origin: origin, Cookie: account.cookie } },
    );
    const received: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data) => {
        const value = JSON.parse(data.toString());
        received.push(value);
        if (value.type === 'state') resolve();
      });
      ws.on('error', reject);
    });
    return { ws, received };
  }
  async function command(account: Account, state: Envelope, nodeId: string, title: string) {
    const next = structuredClone(state.project);
    next.nodes.find((n) => n.id === nodeId)!.title = title;
    const changes = diff(state.project, next, state.versions);
    const lease = await request(`/projects/${state.project.id}/leases`, account, { keys: touched(changes) });
    return {
      operationId: randomUUID(),
      epoch: state.epoch,
      label: '测试节点修改',
      changes,
      leases: lease.data,
    };
  }
  test('legacy projects migrate and relationship cards persist, synchronize and enforce viewer permissions', async () => {
    const owner = await register('relationship-owner'),
      viewer = await register('relationship-viewer');
    const initial = sampleProject();
    initial.characters.push({ id: randomUUID(), name: '旅人', description: '', color: 'teal' });
    const { relationships, ...fields } = initial;
    const legacy = { ...fields, schemaVersion: 1 };
    const created = await request('/projects', owner, legacy);
    expect(created.status).toBe(200);
    const state = created.data as Envelope,
      project = state.project.id;
    // Exercise loading an existing v1 row, not just creating a project through migration.
    service.db
      .prepare('UPDATE projects SET data=? WHERE id=?')
      .run(JSON.stringify({ ...legacy, id: project }), project);
    const migrated = await request(`/projects/${project}`, owner);
    expect(migrated.data.project.schemaVersion).toBe(2);
    expect(migrated.data.project.relationships).toEqual([]);
    await invite(owner, project, viewer, 'viewer');
    await socket(owner, project);
    const peer = await socket(viewer, project);
    const next = structuredClone(migrated.data.project);
    next.relationships.push({
      id: randomUUID(),
      title: '守卫与旅人',
      sourceCharacterId: next.characters[0].id,
      targetCharacterId: next.characters[1].id,
      kind: '盟友',
      direction: 'mutual',
      affinity: 40,
      description: '互相信任',
      development: '共同寻找灯笼',
      status: 'draft',
    });
    const changes = diff(migrated.data.project, next, {}),
      keys = touched(changes);
    const tokens = await request(`/projects/${project}/leases`, owner, { keys });
    const command = {
      operationId: randomUUID(),
      epoch: state.epoch,
      label: '新建角色关系卡片',
      changes,
      leases: tokens.data,
    };
    expect((await request(`/projects/${project}/commands`, viewer, command)).status).toBe(403);
    const committed = await request(`/projects/${project}/commands`, owner, command);
    expect(committed.status, JSON.stringify(committed.data)).toBe(200);
    await new Promise<void>((done) => setTimeout(done, 30));
    expect(
      peer.received.some((message) => message.state?.project.relationships[0]?.title === '守卫与旅人'),
    ).toBe(true);
    const exported = await request(`/projects/${project}/export?revision=1`, owner);
    expect(exported.data.schemaVersion).toBe(2);
    expect(exported.data.project.relationships).toEqual(next.relationships);
    const invalid = structuredClone(committed.data.project);
    invalid.characters.pop();
    const deletion = diff(committed.data.project, invalid, committed.data.versions);
    const deletionTokens = await request(`/projects/${project}/leases`, owner, { keys: touched(deletion) });
    expect(
      (
        await request(`/projects/${project}/commands`, owner, {
          ...command,
          operationId: randomUUID(),
          changes: deletion,
          leases: deletionTokens.data,
        })
      ).status,
    ).toBe(409);
  });
  test('different objects merge, same object is exclusive, retries are idempotent and conflicts reject', async () => {
    const owner = await register('owner'),
      editor = await register('editor');
    const state = await publish(owner),
      project = state.project.id;
    await invite(owner, project, editor);
    const a = await socket(owner, project),
      b = await socket(editor, project);
    const node1 = state.project.nodes[1].id,
      node2 = state.project.nodes[2].id;
    const ca = await command(owner, state, node1, '甲的修改'),
      cb = await command(editor, state, node2, '乙的修改');
    expect((await request(`/projects/${project}/leases`, editor, { keys: [`nodes:${node1}`] })).status).toBe(
      409,
    );
    const first = await request(`/projects/${project}/commands`, owner, ca);
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    expect((await request(`/projects/${project}/commands`, editor, cb)).status).toBe(200);
    const latest = (await request(`/projects/${project}`, owner)).data as Envelope;
    expect(latest.project.nodes.find((n) => n.id === node1)?.title).toBe('甲的修改');
    expect(latest.project.nodes.find((n) => n.id === node2)?.title).toBe('乙的修改');
    expect(latest.project.revision).toBe(2);
    expect((await request(`/projects/${project}/commands`, owner, ca)).data.project.revision).toBe(2);
    const stale = { ...ca, operationId: randomUUID() };
    expect((await request(`/projects/${project}/commands`, owner, stale)).status).toBe(409);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(b.received.some((m) => m.state?.project.revision === 2)).toBe(true);
    expect(a.received.some((m) => m.type === 'presence' && m.online.length === 2)).toBe(true);
  });
  test('viewer cannot mutate, export, invite, snapshot or restore; nonmember cannot read', async () => {
    const owner = await register('owner'),
      viewer = await register('viewer'),
      outsider = await register('outsider');
    const state = await publish(owner),
      project = state.project.id;
    const token = await invite(owner, project, viewer, 'viewer');
    expect((await request('/join', outsider, { token })).status).toBe(410);
    expect((await request(`/projects/${project}`, outsider)).status).toBe(403);
    expect((await request(`/projects/${project}`, viewer)).status).toBe(200);
    expect((await request(`/projects/${project}/leases`, viewer, { keys: ['meta:' + project] })).status).toBe(
      403,
    );
    expect((await request(`/projects/${project}/export?revision=0`, viewer)).status).toBe(403);
    expect((await request(`/projects/${project}/invite`, viewer, { role: 'editor' })).status).toBe(403);
    expect((await request(`/projects/${project}/snapshots`, viewer, { name: 'test' })).status).toBe(403);
    expect(
      (await request(`/projects/${project}/restore`, viewer, { id: randomUUID(), revision: 0 })).status,
    ).toBe(403);
    expect(
      (
        await request(`/projects/${project}/commands`, viewer, {
          operationId: randomUUID(),
          epoch: 1,
          label: 'test',
          changes: [
            {
              collection: 'meta',
              id: project,
              before: { name: state.project.name, entryNodeId: state.project.entryNodeId },
              after: { name: 'bad', entryNodeId: null },
              version: 0,
            },
          ],
          leases: {},
        })
      ).status,
    ).toBe(403);
  });
  test('single-use invites enforce five member capacity, roles take effect immediately', async () => {
    const owner = await register('owner'),
      state = await publish(owner),
      project = state.project.id;
    const users: Account[] = [];
    for (let i = 0; i < 5; i++) users.push(await register(`member${i}`));
    for (const user of users.slice(0, 4)) await invite(owner, project, user);
    const r = await request(`/projects/${project}/invite`, owner, { role: 'editor' });
    if (r.status === 200)
      expect(
        (
          await request('/join', users[4], {
            token: new URLSearchParams(new URL(r.data.url).hash.slice(1)).get('invite'),
          })
        ).status,
      ).toBe(409);
    else expect(r.status).toBe(409);
    expect((await request(`/projects/${project}/members`, owner)).data).toHaveLength(5);
    const peer = await socket(users[0], project);
    const closed = new Promise<number>((resolve) => peer.ws.once('close', (code) => resolve(code)));
    expect(
      (await request(`/projects/${project}/members/${users[0].id}`, owner, { role: 'remove' })).status,
    ).toBe(200);
    expect(await closed).toBe(4003);
    expect((await request(`/projects/${project}`, users[0])).status).toBe(403);
  });
  test('restore keeps backup, changes epoch, rejects old commands; undo rejects another writer', async () => {
    const owner = await register('owner'),
      editor = await register('editor'),
      state = await publish(owner),
      project = state.project.id;
    await invite(owner, project, editor);
    await socket(owner, project);
    await socket(editor, project);
    expect((await request(`/projects/${project}/snapshots`, owner, { name: '初始' })).status).toBe(200);
    const snapshots = (await request(`/projects/${project}/snapshots`, owner)).data;
    const node = state.project.nodes[1].id,
      ca = await command(owner, state, node, '甲');
    const first = await request(`/projects/${project}/commands`, owner, ca);
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    expect(
      (
        await request(`/projects/${project}/undo`, owner, {
          operationId: ca.operationId,
          undoId: randomUUID(),
        })
      ).status,
    ).toBe(200);
    const current = (await request(`/projects/${project}`, owner)).data;
    const restore = await request(`/projects/${project}/restore`, owner, {
      id: snapshots[0].id,
      revision: current.project.revision,
    });
    expect(restore.status).toBe(200);
    expect(restore.data.epoch).toBe(2);
    expect(
      (await request(`/projects/${project}/commands`, owner, { ...ca, operationId: randomUUID() })).status,
    ).toBe(409);
    expect(
      (await request(`/projects/${project}/snapshots`, owner)).data.some(
        (s: any) => s.name === '恢复前自动备份',
      ),
    ).toBe(true);
    const cb = await command(owner, restore.data, node, '新的甲');
    const committed = await request(`/projects/${project}/commands`, owner, cb);
    expect(committed.status).toBe(200);
    await request(`/projects/${project}/leases`, owner, { keys: [`nodes:${node}`], release: true });
    const cc = await command(editor, committed.data, node, '乙后来修改');
    expect((await request(`/projects/${project}/commands`, editor, cc)).status).toBe(200);
    expect(
      (
        await request(`/projects/${project}/undo`, owner, {
          operationId: cb.operationId,
          undoId: randomUUID(),
        })
      ).status,
    ).toBe(409);
  });
  test('old lease token cannot write after release, and untrusted origins are rejected', async () => {
    const owner = await register('owner'),
      state = await publish(owner),
      project = state.project.id;
    await socket(owner, project);
    const ca = await command(owner, state, state.project.nodes[1].id, 'test');
    await request(`/projects/${project}/leases`, owner, { keys: touched(ca.changes), release: true });
    await request(`/projects/${project}/leases`, owner, { keys: touched(ca.changes) });
    expect((await request(`/projects/${project}/commands`, owner, ca)).status).toBe(409);
    const r = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: {
        Origin: 'https://untrusted.example',
        Cookie: owner.cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(state.project),
    });
    expect(r.status).toBe(403);
  });
});
