import { expect, it } from 'vitest';
import { createCollaborationServer } from './index';
import { sampleProject } from '../src/core/sample';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

it('explicit secondary origins can authenticate and subscribe, while unrelated origins stay denied', async () => {
  const origin = 'http://26.193.206.252:5173';
  const local = 'http://127.0.0.1:5173';
  const service = createCollaborationServer(':memory:', origin, [local]);
  let socket: WebSocket | undefined;
  try {
    await new Promise<void>((done) => service.http.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${(service.http.address() as { port: number }).port}`;
    const registration = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { Origin: local, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'local-origin-test', password: 'local-origin-test-password' }),
    });
    expect(registration.status).toBe(200);
    const cookie = registration.headers.getSetCookie()[0].split(';')[0];
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { Origin: local, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleProject()),
    });
    expect(created.status).toBe(200);
    const data = await created.json();
    socket = new WebSocket(
      `${base.replace('http:', 'ws:')}/sync?project=${data.project.id}&client=${randomUUID()}`,
      { headers: { Origin: local, Cookie: cookie } },
    );
    const first = await new Promise<any>((done, fail) => {
      socket!.once('message', (raw) => done(JSON.parse(raw.toString())));
      socket!.once('error', fail);
    });
    expect(first.type).toBe('state');
    const rejected = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { Origin: 'http://untrusted.test', Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleProject()),
    });
    expect(rejected.status).toBe(403);
  } finally {
    socket?.terminate();
    await service.close();
  }
});
