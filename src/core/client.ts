import { diff, touched, keyOf, type Envelope } from './collaboration';
import { keepDraft, deleteDraft } from './remote';
import { id, type Project } from './model';
export type RemoteState = {
  data: Envelope | null;
  status: 'offline' | 'connecting' | 'online' | 'conflict';
  error: string;
  online: { id: string; name: string }[];
  locks: Record<string, { clientId: string; name: string; expiresAt: number }>;
  editing: string | null;
  pending: number;
  undoIds: string[];
};
export class RemoteClient {
  readonly clientId = id();
  state: RemoteState = {
    data: null,
    status: 'offline',
    error: '',
    online: [],
    locks: {},
    editing: null,
    pending: 0,
    undoIds: [],
  };
  onChange = (_state: RemoteState, _replace: boolean) => {};
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = true;
  private queue = Promise.resolve();
  private generation = 0;
  private editGeneration = 0;
  private ownVersions: Record<string, { version: number; revision: number }> = {};
  private latestDraft?: Project;
  private draftId = id();
  private draftQueue = Promise.resolve();
  async api<T = any>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Story-Client': this.clientId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('协作服务没有响应，请检查服务是否启动');
    }
    if (!response.ok) throw Object.assign(new Error(result.error ?? '请求失败'), { status: response.status });
    return result as T;
  }
  private emit(replace = false) {
    this.state = { ...this.state, undoIds: [...this.state.undoIds] };
    this.onChange(this.state, replace);
  }
  open(data: Envelope) {
    this.close();
    this.stopped = false;
    this.generation++;
    this.ownVersions = {};
    this.latestDraft = undefined;
    this.draftId = id();
    this.state = {
      data,
      status: 'connecting',
      error: '',
      locks: {},
      online: [],
      editing: null,
      pending: 0,
      undoIds: [],
    };
    this.emit(true);
    this.connect();
    this.heartbeat = setInterval(() => {
      if (this.state.editing && this.state.status === 'online')
        void this.lease([this.state.editing]).catch((e) => {
          this.state.editing = null;
          this.state.error = e.message;
          this.emit();
        });
    }, 10000);
  }
  private connect() {
    if (this.stopped || !this.state.data) return;
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/sync?project=${this.state.data.project.id}&client=${this.clientId}`,
    );
    this.socket = socket;
    socket.onmessage = (e) => {
      if (this.socket !== socket) return;
      const message = JSON.parse(e.data);
      if (message.state) {
        if (this.state.data && message.state.epoch !== this.state.data.epoch && this.state.pending) {
          void this.conflict('项目已恢复快照，旧草稿不能提交');
        }
        if (!this.state.data || message.state.project.revision >= this.state.data.project.revision) {
          if (message.state.epoch !== this.state.data?.epoch) {
            this.state.editing = null;
            this.state.undoIds = [];
          }
          this.state.data = message.state;
        }
      }
      if (message.type === 'presence') {
        this.state.online = message.online;
        this.state.locks = Object.fromEntries(
          Object.entries(
            message.leases as Record<string, { name: string; client: string; expires: number }>,
          ).map(([key, value]) => [
            key,
            { name: value.name, clientId: value.client, expiresAt: value.expires },
          ]),
        );
        if (this.state.editing && this.state.locks[this.state.editing]?.clientId !== this.clientId)
          this.state.editing = null;
      }
      if (this.state.status !== 'conflict') {
        this.state.status = 'online';
        this.state.error = '';
      }
      if (this.state.data?.role === 'viewer') this.state.editing = null;
      this.emit(this.state.pending === 0 && this.state.status !== 'conflict');
    };
    socket.onclose = (e) => {
      if (this.socket !== socket || this.stopped) return;
      this.state.editing = null;
      if (this.state.status !== 'conflict') this.state.status = 'offline';
      this.state.error = e.code === 4003 ? '访问权限已撤销或登录已过期' : '连接断开，正在重新连接';
      this.emit();
      if (e.code !== 4003 && e.code !== 4001) this.retry = setTimeout(() => this.connect(), 2000);
    };
    socket.onerror = () => {};
  }
  async lease(keys: string[], release = false): Promise<Record<string, string>> {
    if (!this.state.data) throw new Error('未打开远程项目');
    return this.api(`/projects/${this.state.data.project.id}/leases`, { keys, release });
  }
  async edit(nodeId: string | null) {
    const editGeneration = ++this.editGeneration;
    await this.queue;
    if (editGeneration !== this.editGeneration || this.stopped) return;
    const old = this.state.editing;
    this.state.editing = null;
    this.emit();
    if (old) await this.lease([old], true).catch(() => {});
    if (nodeId) {
      if (this.state.status !== 'online' || this.state.data?.role === 'viewer')
        throw new Error('当前不能取得编辑权限');
      await this.lease([`nodes:${nodeId}`]);
      if (editGeneration !== this.editGeneration || this.stopped) {
        await this.lease([`nodes:${nodeId}`], true).catch(() => {});
        return;
      }
      this.state.editing = `nodes:${nodeId}`;
      this.emit();
    }
  }
  private async conflict(reason: string) {
    this.state.status = 'conflict';
    this.state.error = `${reason}。未保存内容已留在画布，请下载草稿后重新加载。`;
    this.emit();
    if (this.latestDraft) {
      const draft = {
        id: this.draftId,
        project: this.latestDraft,
        reason,
        createdAt: new Date().toISOString(),
      };
      this.draftQueue = this.draftQueue.catch(() => {}).then(() => keepDraft(draft));
      await this.draftQueue.catch(() => {
        this.state.error += ' 本机草稿存储失败，请立即下载。';
        this.emit();
      });
    }
  }
  submit(before: Project, after: Project, label: string) {
    if (!this.state.data || this.state.status !== 'online' || this.state.data.role === 'viewer')
      throw new Error('连接恢复并取得编辑权限后才能保存');
    const base = structuredClone(this.state.data),
      changes = diff(before, after, base.versions);
    if (!changes.length) return;
    this.latestDraft = structuredClone(after);
    const draftId = this.draftId,
      draft = {
        id: draftId,
        project: structuredClone(after),
        reason: '等待服务端确认',
        createdAt: new Date().toISOString(),
      };
    this.draftQueue = this.draftQueue.catch(() => {}).then(() => keepDraft(draft));
    const savedDraft = this.draftQueue;
    const operationId = id(),
      generation = this.generation;
    this.state.pending++;
    this.emit();
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation || this.state.status === 'conflict') return;
        const keys = touched(changes);
        try {
          await savedDraft;
          for (const change of changes) {
            const own = this.ownVersions[keyOf(change)];
            if (own && own.revision > base.project.revision) change.version = own.version;
          }
          const leases = await this.lease(keys);
          const command = { operationId, epoch: base.epoch, label, changes, leases };
          let data: Envelope;
          try {
            data = await this.api(`/projects/${before.id}/commands`, command);
          } catch (e) {
            if (!(e as { status?: number }).status)
              data = await this.api(`/projects/${before.id}/commands`, command);
            else throw e;
          }
          if (generation !== this.generation) return;
          for (const change of changes)
            this.ownVersions[keyOf(change)] = {
              version: change.version + 1,
              revision: data.project.revision,
            };
          if (!this.state.data || data.project.revision >= this.state.data.project.revision)
            this.state.data = data;
          this.state.undoIds.push(operationId);
        } catch (e) {
          if (generation === this.generation) await this.conflict((e as Error).message);
        } finally {
          await this.api(`/projects/${before.id}/leases`, {
            keys: keys.filter((k) => k !== this.state.editing),
            release: true,
          }).catch(() => {});
        }
      })
      .finally(() => {
        if (generation === this.generation) {
          this.state.pending--;
          if (this.state.pending === 0 && this.state.status !== 'conflict') {
            this.draftQueue = this.draftQueue.catch(() => {}).then(() => deleteDraft(draftId));
          }
          this.emit(this.state.pending === 0 && this.state.status !== 'conflict');
        }
      });
  }
  async undo() {
    if (this.state.status !== 'online' || this.state.data?.role === 'viewer')
      throw new Error('当前不能撤销远程修改');
    if (!this.state.data || this.state.pending) throw new Error('请等待保存完成');
    const operationId = this.state.undoIds.at(-1);
    if (!operationId) return;
    const data = await this.api<Envelope>(`/projects/${this.state.data.project.id}/undo`, {
      operationId,
      undoId: id(),
    });
    this.state.data = data;
    this.state.undoIds.pop();
    this.emit(true);
  }
  async reload() {
    if (!this.state.data) return;
    const data = await this.api<Envelope>(`/projects/${this.state.data.project.id}`);
    this.open(data);
  }
  close() {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.editGeneration++;
    this.socket?.close();
    this.socket = undefined;
    this.queue = Promise.resolve();
  }
}
