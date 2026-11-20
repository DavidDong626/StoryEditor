import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt as rawScrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import {
  applyChanges,
  commandSchema,
  keyOf,
  touched,
  validateDraft,
  type Role,
  type RemoteState,
  type Command,
} from '../src/core/collaboration';
import { backup, runtimeExport } from '../src/core/transfer';

const scrypt = promisify(rawScrypt);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type User = { id: string; name: string; session?: string };
type Lease = { client: string; user: string; session: string; name: string; token: string; expires: number };
type Peer = { ws: WebSocket; project: string; user: User; client: string; session: string; alive: boolean };
export function createCollaborationServer(
  filename: string,
  origin = 'http://127.0.0.1:5173',
  additionalOrigins: string[] = [],
) {
  const allowedOrigins = new Set([origin, ...additionalOrigins]);
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL,epoch INTEGER NOT NULL,versions TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(project TEXT REFERENCES projects(id),user TEXT REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(project,user));
    CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,project TEXT REFERENCES projects(id),role TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS operations(project TEXT REFERENCES projects(id),id TEXT,user TEXT,client TEXT,epoch INTEGER,revision INTEGER,label TEXT,changes TEXT,response TEXT,PRIMARY KEY(project,id));
    CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,project TEXT REFERENCES projects(id),name TEXT,createdAt TEXT,data TEXT);
  `);
  if (
    !(db.prepare('PRAGMA table_info(operations)').all() as { name: string }[]).some(
      (c) => c.name === 'createdAt',
    )
  )
    db.exec('ALTER TABLE operations ADD COLUMN createdAt TEXT');
  const app = express(),
    http = createServer(app),
    wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const peers = new Set<Peer>(),
    leases = new Map<string, Map<string, Lease>>();
  const rate = new Map<string, { count: number; until: number }>();
  let fence = 0;
  const fail = (message: string, status = 400): never => {
    throw Object.assign(new Error(message), { status });
  };
  function tx<T>(run: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      db.exec('COMMIT');
      return value;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  function userFromCookie(cookie = ''): { user: User; session: string } | null {
    const token = cookie
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('story_session='))
      ?.slice(14);
    if (!token) return null;
    const row = db
      .prepare(
        'SELECT users.id,users.name,sessions.token FROM sessions JOIN users ON users.id=sessions.user WHERE token=? AND expires>?',
      )
      .get(hash(token), Date.now()) as (User & { token: string }) | undefined;
    return row ? { user: { id: row.id, name: row.name }, session: row.token } : null;
  }
  function role(project: string, user: string): Role {
    const row = db.prepare('SELECT role FROM members WHERE project=? AND user=?').get(project, user) as
      { role: Role } | undefined;
    return row?.role ?? fail('无权访问此项目', 403);
  }
  function state(project: string, user: string): RemoteState {
    const r = role(project, user);
    const row = db.prepare('SELECT * FROM projects WHERE id=?').get(project) as
      { data: string; epoch: number; versions: string } | undefined;
    if (!row) fail('项目不存在', 404);
    return {
      project: JSON.parse(row!.data),
      epoch: row!.epoch,
      versions: JSON.parse(row!.versions),
      role: r,
    };
  }
  function editor(project: string, user: string) {
    if (role(project, user) === 'viewer') fail('只读成员不能进行此操作', 403);
  }
  function owner(project: string, user: string) {
    if (role(project, user) !== 'owner') fail('只有项目所有者可以进行此操作', 403);
  }
  function expire(project: string) {
    const map = leases.get(project);
    if (map) for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
  }
  function presence(project: string) {
    expire(project);
    return {
      type: 'presence',
      online: [
        ...new Map([...peers].filter((p) => p.project === project).map((p) => [p.user.id, p.user])).values(),
      ],
      leases: Object.fromEntries(
        [...(leases.get(project) ?? [])].map(([key, v]) => [
          key,
          { name: v.name, client: v.client, expires: v.expires },
        ]),
      ),
    };
  }
  function broadcast(project: string, message: unknown) {
    for (const p of peers)
      if (p.project === project && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(message));
  }
  function updated(project: string) {
    for (const p of peers)
      if (p.project === project) {
        try {
          p.ws.send(JSON.stringify({ type: 'state', state: state(project, p.user.id) }));
        } catch {
          p.ws.close(4003, '权限已变更');
        }
      }
    broadcast(project, presence(project));
  }
  const authUser = (req: Request): User => {
    const auth = userFromCookie(req.headers.cookie);
    if (!auth) return fail('请先登录', 401);
    return { ...auth.user, session: auth.session };
  };
  const clientId = (req: Request) => z.string().uuid().parse(req.headers['x-story-client']);
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !allowedOrigins.has(req.headers.origin ?? ''))
      return res.status(403).json({ error: '请求来源不受信任' });
    next();
  });
  app.use(express.json({ limit: '20mb' }));
  app.get('/api/health', (_, res) => res.json({ ok: true }));
  app.post('/api/auth/:action', async (req, res, next) => {
    try {
      const address = req.socket.remoteAddress ?? 'unknown',
        now = Date.now();
      const window = rate.get(address);
      if (!window || window.until < now) rate.set(address, { count: 1, until: now + 60_000 });
      else if (++window.count > 20) fail('尝试过于频繁，请稍后重试', 429);
      const { name, password } = z
        .object({ name: z.string().trim().min(2).max(40), password: z.string().min(10).max(200) })
        .parse(req.body);
      let user: User;
      if (req.params.action === 'register') {
        if (process.env.ALLOW_REGISTRATION === 'false') fail('当前服务已关闭注册', 403);
        const salt = randomBytes(16).toString('hex'),
          encoded = (await scrypt(password, salt, 64)) as Buffer;
        user = { id: randomUUID(), name };
        try {
          db.prepare('INSERT INTO users VALUES(?,?,?)').run(
            user.id,
            name,
            `${salt}:${encoded.toString('hex')}`,
          );
        } catch {
          fail('此账号名称已存在', 409);
        }
      } else if (req.params.action === 'login') {
        const row = db.prepare('SELECT * FROM users WHERE name=?').get(name) as
          (User & { password: string }) | undefined;
        const [salt, key] = (row?.password ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
        const encoded = (await scrypt(password, salt, 64)) as Buffer;
        if (!row || !timingSafeEqual(encoded, Buffer.from(key, 'hex'))) fail('账号或密码错误', 401);
        user = { id: row!.id, name: row!.name };
      } else fail('请求无效', 404);
      const token = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), user!.id, Date.now() + 7 * 86400_000);
      res.setHeader(
        'Set-Cookie',
        `story_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${origin.startsWith('https:') ? '; Secure' : ''}`,
      );
      res.json(user!);
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/me', (req, res) => {
    const { id, name } = authUser(req);
    res.json({ id, name });
  });
  app.post('/api/logout', (req, res) => {
    const session = userFromCookie(req.headers.cookie)?.session;
    if (session) {
      db.prepare('DELETE FROM sessions WHERE token=?').run(session);
      for (const p of peers) if (p.session === session) p.ws.close(4001, '已退出');
    }
    res.setHeader('Set-Cookie', 'story_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  });
  app.get('/api/projects', (req, res) => {
    const u = authUser(req);
    res.json(
      db
        .prepare(
          'SELECT projects.id,projects.data,members.role FROM projects JOIN members ON members.project=projects.id WHERE members.user=?',
        )
        .all(u.id)
        .map((r) => ({ id: r.id, name: JSON.parse(r.data as string).name, role: r.role })),
    );
  });
  app.post('/api/projects', (req, res) => {
    const u = authUser(req),
      p = validateDraft(req.body);
    p.id = randomUUID();
    p.revision = 0;
    tx(() => {
      db.prepare('INSERT INTO projects VALUES(?,?,1,?)').run(p.id, JSON.stringify(p), '{}');
      db.prepare('INSERT INTO members VALUES(?,?,?)').run(p.id, u.id, 'owner');
    });
    res.json(state(p.id, u.id));
  });
  app.post('/api/join', (req, res) => {
    const u = authUser(req),
      token = z.string().min(32).max(100).parse(req.body.token);
    const project = tx(() => {
      const invite = db
        .prepare('SELECT * FROM invites WHERE token=? AND expires>?')
        .get(hash(token), Date.now()) as { project: string; role: Role } | undefined;
      if (!invite) fail('邀请已使用或过期', 410);
      if (db.prepare('SELECT 1 FROM members WHERE project=? AND user=?').get(invite!.project, u.id))
        fail('你已经是此项目成员');
      const count = db.prepare('SELECT COUNT(*) AS n FROM members WHERE project=?').get(invite!.project) as {
        n: number;
      };
      if (count.n >= 5) fail('项目人数已达到 5 人上限', 409);
      db.prepare('INSERT INTO members VALUES(?,?,?)').run(invite!.project, u.id, invite!.role);
      db.prepare('DELETE FROM invites WHERE token=?').run(hash(token));
      return invite!.project;
    });
    updated(project);
    res.json(state(project, u.id));
  });
  app.get('/api/projects/:project', (req, res) =>
    res.json(state(String(req.params.project), authUser(req).id)),
  );
  app.use('/api/projects/:project', (req, res, next) => {
    authUser(req);
    role(String(req.params.project), authUser(req).id);
    next();
  });
  app.get('/api/projects/:project/members', (req, res) =>
    res.json(
      db
        .prepare(
          'SELECT users.id,users.name,members.role FROM members JOIN users ON users.id=members.user WHERE project=?',
        )
        .all(String(req.params.project)),
    ),
  );
  app.post('/api/projects/:project/invite', (req, res) => {
    const project = String(req.params.project);
    owner(project, authUser(req).id);
    const r = z.enum(['editor', 'viewer']).parse(req.body.role),
      token = randomBytes(24).toString('hex');
    db.prepare('INSERT INTO invites VALUES(?,?,?,?)').run(hash(token), project, r, Date.now() + 86400_000);
    res.json({
      url: `${origin}/#invite=${token}`,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });
  });
  app.post('/api/projects/:project/members/:user', (req, res) => {
    const project = String(req.params.project),
      user = String(req.params.user);
    owner(project, authUser(req).id);
    if (role(project, user) === 'owner') fail('不能移除或更改唯一所有者');
    const r = z.enum(['editor', 'viewer', 'remove']).parse(req.body.role);
    if (r === 'remove') db.prepare('DELETE FROM members WHERE project=? AND user=?').run(project, user);
    else db.prepare('UPDATE members SET role=? WHERE project=? AND user=?').run(r, project, user);
    for (const [key, v] of leases.get(project) ?? []) if (v.user === user) leases.get(project)!.delete(key);
    updated(project);
    res.json({ ok: true });
  });
  function acquire(project: string, u: User, client: string, keys: string[], release = false) {
    editor(project, u.id);
    if (
      !release &&
      ![...peers].some(
        (p) =>
          p.project === project &&
          p.user.id === u.id &&
          p.client === client &&
          p.ws.readyState === WebSocket.OPEN &&
          p.session === u.session,
      )
    )
      fail('协作连接已断开，请重新连接', 409);
    expire(project);
    const map = leases.get(project) ?? new Map<string, Lease>();
    leases.set(project, map);
    if (release) {
      for (const key of keys)
        if (
          map.get(key)?.client === client &&
          map.get(key)?.user === u.id &&
          map.get(key)?.session === u.session
        )
          map.delete(key);
      broadcast(project, presence(project));
      return {};
    }
    for (const key of keys) {
      const lock = map.get(key);
      if (lock && (lock.client !== client || lock.user !== u.id || lock.session !== u.session))
        fail(`${lock.name} 正在编辑此对象`, 409);
    }
    const result: Record<string, string> = {};
    for (const key of keys) {
      const previous = map.get(key);
      const token = previous?.token ?? `${++fence}:${randomUUID()}`;
      map.set(key, {
        client,
        user: u.id,
        session: u.session!,
        name: u.name,
        token,
        expires: Date.now() + 30_000,
      });
      result[key] = token;
    }
    broadcast(project, presence(project));
    return result;
  }
  app.post('/api/projects/:project/leases', (req, res) => {
    const project = String(req.params.project),
      u = authUser(req),
      client = clientId(req);
    const { keys, release } = z
      .object({ keys: z.array(z.string().min(1).max(100)).max(20000), release: z.boolean().optional() })
      .parse(req.body);
    res.json(acquire(project, u, client, keys, release));
  });
  function commit(project: string, u: User, client: string, command: Command) {
    editor(project, u.id);
    return tx(() => {
      const current = state(project, u.id);
      const previous = db
        .prepare('SELECT user,client,response FROM operations WHERE project=? AND id=?')
        .get(project, command.operationId) as { user: string; client: string; response: string } | undefined;
      if (previous) {
        if (previous.user !== u.id || previous.client !== client) fail('操作标识已使用', 409);
        if (JSON.parse(previous.response).epoch !== current.epoch) fail('项目已恢复版本', 409);
        return current;
      }
      if (current.epoch !== command.epoch) fail('项目已恢复历史版本，旧草稿不能提交', 409);
      expire(project);
      for (const key of touched(command.changes)) {
        const lock = leases.get(project)?.get(key);
        if (
          !lock ||
          lock.client !== client ||
          lock.user !== u.id ||
          lock.session !== u.session ||
          lock.token !== command.leases[key]
        )
          fail('编辑占用已失效，请重新获取', 409);
      }
      let p;
      try {
        p = applyChanges(current.project, current.versions, command.changes);
      } catch (e) {
        fail((e as Error).message, 409);
      }
      const versions = { ...current.versions };
      for (const d of command.changes) versions[keyOf(d)] = (versions[keyOf(d)] ?? 0) + 1;
      const response = { ...current, project: p!, versions };
      db.prepare('UPDATE projects SET data=?,versions=? WHERE id=?').run(
        JSON.stringify(p!),
        JSON.stringify(versions),
        project,
      );
      db.prepare(
        'INSERT INTO operations(project,id,user,client,epoch,revision,label,changes,response,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        project,
        command.operationId,
        u.id,
        client,
        current.epoch,
        p!.revision,
        command.label,
        JSON.stringify(command.changes),
        JSON.stringify({ epoch: current.epoch }),
        new Date().toISOString(),
      );
      return response;
    });
  }
  app.post('/api/projects/:project/commands', (req, res) => {
    const project = String(req.params.project),
      result = commit(project, authUser(req), clientId(req), commandSchema.parse(req.body));
    updated(project);
    res.json(result);
  });
  app.post('/api/projects/:project/undo', (req, res) => {
    const project = String(req.params.project),
      u = authUser(req),
      client = clientId(req);
    editor(project, u.id);
    const operationId = z.string().uuid().parse(req.body.operationId),
      undoId = z.string().uuid().parse(req.body.undoId);
    const current = state(project, u.id),
      event = db
        .prepare('SELECT epoch,changes,label FROM operations WHERE project=? AND id=? AND user=?')
        .get(project, operationId, u.id) as { epoch: number; changes: string; label: string } | undefined;
    if (!event || event.epoch !== current.epoch) fail('此修改不能撤销', 409);
    const changes = JSON.parse(event!.changes) as Command['changes'];
    if (!changes.length) fail('此操作不能撤销', 409);
    for (const change of changes)
      if (current.versions[keyOf(change)] !== change.version + 1) fail('后续修改已触及此对象，不能撤销', 409);
    const inverse = changes.map((c) => ({ ...c, before: c.after, after: c.before, version: c.version + 1 }));
    const keys = touched(inverse),
      held = keys.filter(
        (k) => leases.get(project)?.get(k)?.client === client && leases.get(project)?.get(k)?.user === u.id,
      ),
      tokens = acquire(project, u, client, keys);
    try {
      const result = commit(project, u, client, {
        operationId: undoId,
        epoch: current.epoch,
        label: `撤销：${event!.label}`,
        changes: inverse,
        leases: tokens,
      });
      updated(project);
      res.json(result);
    } finally {
      acquire(
        project,
        u,
        client,
        keys.filter((k) => !held.includes(k)),
        true,
      );
    }
  });
  app.get('/api/projects/:project/history', (req, res) =>
    res.json(
      db
        .prepare(
          'SELECT id,label,revision,epoch,user,createdAt AS time FROM operations WHERE project=? ORDER BY revision DESC LIMIT 100',
        )
        .all(String(req.params.project)),
    ),
  );
  app.get('/api/projects/:project/snapshots', (req, res) =>
    res.json(
      db
        .prepare('SELECT id,name,createdAt,data FROM snapshots WHERE project=? ORDER BY createdAt DESC')
        .all(String(req.params.project))
        .map((r) => ({
          id: r.id,
          name: r.name,
          createdAt: r.createdAt,
          revision: JSON.parse(r.data as string).revision,
        })),
    ),
  );
  app.post('/api/projects/:project/snapshots', (req, res) => {
    const project = String(req.params.project),
      u = authUser(req);
    editor(project, u.id);
    const name = z.string().trim().min(1).max(200).parse(req.body.name),
      p = state(project, u.id).project;
    db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(
      randomUUID(),
      project,
      name,
      new Date().toISOString(),
      JSON.stringify(p),
    );
    res.json({ ok: true });
  });
  app.post('/api/projects/:project/restore', (req, res) => {
    const project = String(req.params.project),
      u = authUser(req);
    owner(project, u.id);
    const snapshotId = z.string().uuid().parse(req.body.id);
    tx(() => {
      const row = db
        .prepare('SELECT data FROM snapshots WHERE id=? AND project=?')
        .get(snapshotId, project) as { data: string } | undefined;
      if (!row) fail('快照不存在', 404);
      const current = state(project, u.id),
        p = validateDraft(JSON.parse(row!.data));
      p.revision = current.project.revision + 1;
      if (z.number().int().parse(req.body.revision) !== current.project.revision)
        fail('项目已更新，请重新确认恢复', 409);
      db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(
        randomUUID(),
        project,
        '恢复前自动备份',
        new Date().toISOString(),
        JSON.stringify(current.project),
      );
      db.prepare('UPDATE projects SET data=?,epoch=epoch+1,versions=? WHERE id=?').run(
        JSON.stringify(p),
        '{}',
        project,
      );
      db.prepare(
        'INSERT INTO operations(project,id,user,client,epoch,revision,label,changes,response,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        project,
        randomUUID(),
        u.id,
        clientId(req),
        current.epoch + 1,
        p.revision,
        '恢复快照',
        '[]',
        JSON.stringify({ ...current, project: p, epoch: current.epoch + 1, versions: {} }),
        new Date().toISOString(),
      );
    });
    leases.delete(project);
    updated(project);
    res.json(state(project, u.id));
  });
  app.get('/api/projects/:project/export', (req, res) => {
    const project = String(req.params.project),
      u = authUser(req);
    editor(project, u.id);
    const p = state(project, u.id).project;
    if (String(p.revision) !== req.query.revision) fail('项目已更新，请重试导出', 409);
    res.json(req.query.format === 'runtime' ? runtimeExport(p) : backup(p));
  });
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: unknown) => {
    res
      .status(err.status ?? 400)
      .json({ error: err instanceof z.ZodError ? '提交的数据格式无效' : err.message });
  });
  if (process.env.NODE_ENV === 'production') app.use(express.static(resolve('dist')));
  http.on('upgrade', (req, socket, head) => {
    try {
      const parsed = new URL(req.url ?? '', origin),
        auth = userFromCookie(req.headers.cookie);
      if (parsed.pathname !== '/sync' || !allowedOrigins.has(req.headers.origin ?? '') || !auth)
        throw new Error();
      const project = z.string().uuid().parse(parsed.searchParams.get('project')),
        client = z.string().uuid().parse(parsed.searchParams.get('client'));
      role(project, auth.user.id);
      if ([...peers].filter((p) => p.user.id === auth.user.id).length >= 10) throw new Error('连接过多');
      wss.handleUpgrade(req, socket, head, (ws) => {
        const peer = { ws, project, client, user: auth.user, session: auth.session, alive: true };
        peers.add(peer);
        ws.on('pong', () => {
          peer.alive = true;
        });
        ws.send(JSON.stringify({ type: 'state', state: state(project, auth.user.id) }));
        broadcast(project, presence(project));
        ws.on('error', () => {});
        ws.on('message', () => {
          ws.close(1008, '仅接受服务端推送');
        });
        ws.on('close', () => {
          peers.delete(peer);
          for (const [key, v] of leases.get(project) ?? [])
            if (v.client === client && v.user === auth.user.id && v.session === auth.session)
              leases.get(project)!.delete(key);
          broadcast(project, presence(project));
        });
      });
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    }
  });
  const ticker = setInterval(() => {
    for (const p of peers) {
      if (!db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires>?').get(p.session, Date.now()))
        p.ws.close(4001, '会话过期');
      else if (!p.alive) p.ws.terminate();
      else {
        p.alive = false;
        p.ws.ping();
      }
    }
    for (const project of leases.keys()) broadcast(project, presence(project));
    for (const [key, v] of rate) if (v.until < Date.now()) rate.delete(key);
  }, 10_000);
  ticker.unref();
  return {
    http,
    db,
    close: async () => {
      clearInterval(ticker);
      for (const p of peers) p.ws.terminate();
      wss.close();
      await new Promise<void>((r) => http.close(() => r()));
      db.close();
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const origin = process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173';
  const additionalOrigins = (process.env.ADDITIONAL_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    process.env.NODE_ENV === 'production' &&
    [origin, ...additionalOrigins].some((value) => !value.startsWith('https://'))
  )
    throw new Error('生产环境 PUBLIC_ORIGIN 必须使用 HTTPS');
  const service = createCollaborationServer(
    process.env.DATABASE_PATH ?? 'data/story-editor.sqlite',
    origin,
    additionalOrigins,
  );
  service.http.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '127.0.0.1', () =>
    console.log('协作服务已启动，端口 ' + (process.env.PORT ?? 3001)),
  );
}
