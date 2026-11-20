import { useEffect, useState } from 'react';
import type { Project } from '../core/model';
import type { Envelope, Role } from '../core/collaboration';
import type { RemoteClient, RemoteState } from '../core/client';
import { backup, download } from '../core/transfer';
import { askConfirmation, askText } from './Dialogs';
import { storedDrafts, deleteDraft, type Draft } from '../core/remote';

const roleName = { owner: '所有者', editor: '编辑者', viewer: '查看者' };
export default function Collaboration({
  client,
  state,
  project,
  open,
  local,
}: {
  client: RemoteClient;
  state: RemoteState | null;
  project: Project;
  open: (data: Envelope) => void;
  local: () => void;
}) {
  const [user, setUser] = useState<{ name: string } | null>(null);
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [name, setName] = useState('');
  const [register, setRegister] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string; role: Role }[]>([]);
  const [members, setMembers] = useState<{ id: string; name: string; email: string; role: Role }[]>([]);
  const [snapshots, setSnapshots] = useState<
    { id: string; name: string; createdAt: string; revision: number }[]
  >([]);
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor'),
    [inviteLink, setInviteLink] = useState('');
  const [joinToken, setJoinToken] = useState(new URLSearchParams(location.hash.slice(1)).get('invite') ?? '');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  useEffect(() => {
    void storedDrafts()
      .then(setDrafts)
      .catch(() => {});
  }, []);
  const projectId = state?.data?.project.id;
  async function refresh() {
    setProjects(await client.api('/projects'));
    if (projectId) {
      setMembers(await client.api(`/projects/${projectId}/members`));
      setSnapshots(await client.api(`/projects/${projectId}/snapshots`));
    }
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void client
      .api('/me')
      .then(async (value) => {
        setUser(value);
        await refresh();
      })
      .catch(() => {});
  }, [projectId]);
  const blocked = !!state?.pending || state?.status === 'conflict';
  return (
    <div className="collaboration-panel">
      <p className="modal-intro">
        同一个协作服务上的成员可一起编辑。每个项目最多 5 人，邀请链接有效 24 小时且只能使用一次。
      </p>
      {error && (
        <p role="alert" className="collab-error">
          {error}
        </p>
      )}
      {!!drafts.length && (
        <div className="collab-status">
          <strong>保留的本机草稿</strong>
          <p>可下载后手动合并，不会自动覆盖服务端。</p>
          {drafts.map((draft) => (
            <div className="collab-row" key={draft.id}>
              <span>
                {draft.project.name} · {draft.reason}
              </span>
              <button
                className="secondary-button small"
                onClick={() => download(`${draft.project.name}-保留草稿`, backup(draft.project))}
              >
                下载
              </button>
              <button
                className="text-button small"
                onClick={() =>
                  void perform(async () => {
                    if (await askConfirmation('删除这份本机草稿？请确认已经下载或不再需要。')) {
                      await deleteDraft(draft.id);
                      setDrafts(await storedDrafts());
                    }
                  })
                }
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
      {!user ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              const result = await client.api(`/auth/${register ? 'register' : 'login'}`, {
                name: email,
                password,
              });
              setUser(result);
              setPassword('');
              await refresh();
            });
          }}
        >
          <h3>{register ? '创建账号' : '登录协作服务'}</h3>
          <label>
            账号名称（2–40 个字符）
            <input
              autoComplete="username"
              required
              minLength={2}
              maxLength={40}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            密码（至少 10 位）
            <input
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              minLength={10}
              maxLength={200}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className="primary-button" disabled={busy}>
            {register ? '注册并登录' : '登录'}
          </button>
          <button type="button" className="text-button" onClick={() => setRegister(!register)}>
            {register ? '已有账号，登录' : '创建新账号'}
          </button>
          <p className="empty-text">账号保存在你部署的服务中。此版本暂不提供找回密码。</p>
        </form>
      ) : (
        <>
          <div className="collab-row">
            <strong>{user.name}</strong>
            <button
              className="text-button"
              disabled={busy || blocked}
              onClick={() =>
                void perform(async () => {
                  await client.api('/logout', {});
                  local();
                  setUser(null);
                })
              }
            >
              退出登录
            </button>
          </div>
          {state && (
            <div className="collab-status">
              <strong>
                {state.status === 'online'
                  ? '已连接'
                  : state.status === 'conflict'
                    ? '需要合并草稿'
                    : '连接中断'}{' '}
                · {roleName[state.data!.role]}
              </strong>
              <p>
                {state.error || `在线：${state.online.map((member) => member.name).join('、') || '正在获取'}`}
              </p>
              {(state.status === 'conflict' || state.status === 'offline') && (
                <>
                  <button
                    className="secondary-button"
                    onClick={() => download(`${project.name}-未保存草稿`, backup(project))}
                  >
                    下载当前草稿
                  </button>
                  <button
                    className="secondary-button"
                    disabled={state.pending > 0}
                    onClick={() =>
                      void perform(async () => {
                        if (
                          await askConfirmation(
                            '重新加载服务端版本？请先下载需要保留的草稿，当前未保存内容会从画布移除。',
                          )
                        )
                          await client.reload();
                      })
                    }
                  >
                    重新加载服务端版本
                  </button>
                </>
              )}
              <button className="text-button" disabled={blocked} onClick={local}>
                返回本地项目
              </button>
            </div>
          )}
          {!state && (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (await askConfirmation(`将“${project.name}”发布为协作项目？会建立独立的服务端副本。`)) {
                    open(await client.api('/projects', project));
                  }
                })
              }
            >
              将当前本地项目发布到协作服务
            </button>
          )}
          <h3>我的协作项目</h3>
          <button className="text-button" disabled={busy} onClick={() => void perform(refresh)}>
            刷新列表
          </button>
          {projects.map((item) => (
            <div className="collab-row" key={item.id}>
              <span>
                {item.name} · {roleName[item.role]}
              </span>
              <button
                className="secondary-button small"
                disabled={busy || blocked}
                onClick={() => void perform(async () => open(await client.api(`/projects/${item.id}`)))}
              >
                打开
              </button>
            </div>
          ))}
          {!projects.length && <p className="empty-text">还没有协作项目。</p>}
          <h3>加入项目</h3>
          <label>
            邀请链接或邀请码
            <input value={joinToken} onChange={(e) => setJoinToken(e.target.value)} />
          </label>
          <button
            className="secondary-button"
            disabled={busy || !joinToken || blocked}
            onClick={() =>
              void perform(async () => {
                let token = joinToken.trim();
                if (token.includes('#')) token = new URLSearchParams(token.split('#')[1]).get('invite') ?? '';
                open(await client.api('/join', { token }));
                setJoinToken('');
                history.replaceState(null, '', location.pathname);
              })
            }
          >
            接受邀请
          </button>
          {state && (
            <>
              <h3>项目成员（{members.length}/5）</h3>
              {members.map((member) => (
                <div className="collab-row" key={member.id}>
                  <span>
                    {member.name} · {roleName[member.role]}
                  </span>
                  {state.data?.role === 'owner' && member.role !== 'owner' && (
                    <>
                      <select
                        aria-label={`${member.name}的权限`}
                        value={member.role}
                        disabled={busy}
                        onChange={(e) =>
                          void perform(async () => {
                            await client.api(`/projects/${projectId}/members/${member.id}`, {
                              role: e.target.value,
                            });
                            await refresh();
                          })
                        }
                      >
                        <option value="editor">编辑者</option>
                        <option value="viewer">查看者</option>
                      </select>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            if (await askConfirmation(`移除 ${member.name}？对方将立即失去项目访问权限。`)) {
                              await client.api(`/projects/${projectId}/members/${member.id}`, {
                                role: 'remove',
                              });
                              await refresh();
                            }
                          })
                        }
                      >
                        移除
                      </button>
                    </>
                  )}
                </div>
              ))}
              {state.data?.role === 'owner' && (
                <>
                  <div className="collab-row">
                    <select
                      aria-label="邀请权限"
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as 'editor' | 'viewer')}
                    >
                      <option value="editor">邀请编辑者</option>
                      <option value="viewer">邀请查看者</option>
                    </select>
                    <button
                      className="secondary-button"
                      disabled={busy || members.length >= 5}
                      onClick={() =>
                        void perform(async () => {
                          const result = await client.api(`/projects/${projectId}/invite`, {
                            role: inviteRole,
                          });
                          setInviteLink(result.url);
                        })
                      }
                    >
                      生成邀请链接
                    </button>
                  </div>
                  {inviteLink && (
                    <label>
                      复制此链接发送给成员
                      <input
                        aria-label="邀请链接"
                        readOnly
                        value={inviteLink}
                        onFocus={(e) => e.target.select()}
                      />
                    </label>
                  )}
                </>
              )}
              <h3>服务端快照</h3>
              <button
                className="secondary-button"
                disabled={busy || blocked || state.data?.role === 'viewer'}
                onClick={() =>
                  void perform(async () => {
                    const name = await askText('快照名称', '阶段版本');
                    if (name?.trim()) {
                      await client.api(`/projects/${projectId}/snapshots`, { name: name.trim() });
                      await refresh();
                    }
                  })
                }
              >
                创建快照
              </button>
              {snapshots.map((item) => (
                <div className="collab-row" key={item.id}>
                  <span>
                    {item.name} · 版本 {item.revision}
                  </span>
                  <button
                    className="secondary-button small"
                    disabled={busy || blocked || state.data?.role !== 'owner'}
                    onClick={() =>
                      void perform(async () => {
                        if (
                          await askConfirmation(
                            `恢复“${item.name}”？服务端会先备份当前内容，所有成员重新获取最新版本。`,
                          )
                        ) {
                          const data = await client.api(`/projects/${projectId}/restore`, {
                            id: item.id,
                            revision: state.data!.project.revision,
                          });
                          open(data);
                          await refresh();
                        }
                      })
                    }
                  >
                    恢复
                  </button>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
