import { useState } from 'react';
import { ArrowDown, ArrowUp, CirclePlay, Plus, Trash2, X } from 'lucide-react';
import { id, nodeMeta, type Project, type StoryNode } from '../core/model';
import { ConditionFields, defaultCondition, EffectFields } from './LogicFields';
import { askConfirmation } from './Dialogs';
import CharacterAvatar from './CharacterAvatar';

export default function Inspector({
  node,
  project,
  update,
  remove,
  close,
  run,
  readOnly,
}: {
  node: StoryNode;
  project: Project;
  update: (n: StoryNode) => void;
  remove: () => void;
  close: () => void;
  run: () => void;
  readOnly: boolean;
}) {
  const [tab, setTab] = useState('content');
  const meta = nodeMeta[node.type];
  const updateOption = (
    index: number,
    changes: Partial<Extract<StoryNode, { type: 'choice' }>['options'][number]>,
  ) => {
    if (node.type === 'choice')
      update({ ...node, options: node.options.map((o, i) => (i === index ? { ...o, ...changes } : o)) });
  };
  const move = <T,>(items: T[], index: number, direction: number): T[] => {
    const next = [...items];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    return next;
  };
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">节点详情</span>
          <h2>{meta.label}节点</h2>
        </div>
        <button className="icon-button" title="关闭详情" onClick={close}>
          <X size={17} />
        </button>
      </div>
      <div className="inspector-tabs">
        <button className={tab === 'content' ? 'active' : ''} onClick={async () => setTab('content')}>
          内容
        </button>
        <button className={tab === 'logic' ? 'active' : ''} onClick={async () => setTab('logic')}>
          逻辑
        </button>
      </div>
      <fieldset className="inspector-body" disabled={readOnly}>
        <label className="field">
          节点标题
          <input
            value={node.title}
            maxLength={500}
            onChange={(e) => update({ ...node, title: e.target.value })}
            placeholder="给这段故事起一个名字"
          />
        </label>
        <label className="field">
          内容状态
          <select
            value={node.status}
            onChange={(e) => update({ ...node, status: e.target.value as StoryNode['status'] })}
          >
            <option value="draft">草稿</option>
            <option value="review">待审阅</option>
            <option value="approved">已确认</option>
          </select>
        </label>
        {tab === 'content' && (
          <>
            {'text' in node && (
              <label className="field">
                {node.type === 'choice' ? '选择提示' : '剧情正文'}
                <textarea
                  rows={6}
                  value={node.text}
                  onChange={(e) => update({ ...node, text: e.target.value })}
                  placeholder="写下这一刻发生的事…"
                />
                <span className="field-help">纯文本 · {node.text.length} 字</span>
              </label>
            )}
            {node.type === 'story' && (
              <section className="editor-section">
                <div className="section-heading">
                  <h3>角色对白</h3>
                  <span>{node.lines.length} 句</span>
                </div>
                {node.lines.map((line, i) => (
                  <div className="dialogue-editor" key={line.id}>
                    <div className="field-row">
                      {(() => {
                        const character = project.characters.find((c) => c.id === line.speakerId);
                        return character ? <CharacterAvatar character={character} /> : null;
                      })()}
                      <select
                        aria-label="说话角色"
                        value={line.speakerId ?? ''}
                        onChange={(e) =>
                          update({
                            ...node,
                            lines: node.lines.map((l, j) =>
                              i === j ? { ...l, speakerId: e.target.value || null } : l,
                            ),
                          })
                        }
                      >
                        <option value="">旁白</option>
                        {project.characters.map((c) => (
                          <option value={c.id} key={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="icon-button danger"
                        title="删除对白"
                        onClick={async () => update({ ...node, lines: node.lines.filter((_, j) => j !== i) })}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <textarea
                      aria-label={`对白 ${i + 1}`}
                      rows={3}
                      value={line.text}
                      onChange={(e) =>
                        update({
                          ...node,
                          lines: node.lines.map((l, j) => (i === j ? { ...l, text: e.target.value } : l)),
                        })
                      }
                    />
                  </div>
                ))}
                <button
                  className="text-button small"
                  onClick={async () =>
                    update({
                      ...node,
                      lines: [
                        ...node.lines,
                        { id: id(), speakerId: project.characters[0]?.id ?? null, text: '' },
                      ],
                    })
                  }
                >
                  <Plus size={14} />
                  添加对白
                </button>
              </section>
            )}
            {node.type === 'choice' && (
              <section className="editor-section">
                <div className="section-heading">
                  <h3>玩家选项</h3>
                  <span>出口随选项保留</span>
                </div>
                {node.options.map((o, i) => (
                  <div className="option-editor" key={o.id}>
                    <div className="section-heading">
                      <span>选项 {i + 1}</span>
                      <div className="button-group">
                        <button
                          className="icon-button"
                          disabled={i === 0}
                          title="选项上移"
                          onClick={async () => update({ ...node, options: move(node.options, i, -1) })}
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          className="icon-button"
                          disabled={i === node.options.length - 1}
                          title="选项下移"
                          onClick={async () => update({ ...node, options: move(node.options, i, 1) })}
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          className="icon-button danger"
                          title="删除选项及连线"
                          onClick={async () => {
                            if (await askConfirmation('删除这个选项及其连线？'))
                              update({ ...node, options: node.options.filter((_, j) => j !== i) });
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                    <input
                      aria-label={`选项 ${i + 1} 文案`}
                      value={o.text}
                      onChange={(e) => updateOption(i, { text: e.target.value })}
                    />
                  </div>
                ))}
                <button
                  className="text-button small"
                  onClick={async () =>
                    update({
                      ...node,
                      options: [
                        ...node.options,
                        { id: id(), text: '新的选项', condition: null, effects: [] },
                      ],
                    })
                  }
                >
                  <Plus size={14} />
                  添加选项
                </button>
              </section>
            )}
            {node.type === 'end' && (
              <label className="field">
                结局标识
                <input
                  value={node.endingKey}
                  onChange={(e) => update({ ...node, endingKey: e.target.value })}
                  placeholder="例如 new_journey"
                />
              </label>
            )}
            {node.type === 'start' && (
              <div className="info-block">每个场景有一个起点。右侧的圆点连接故事的第一段。</div>
            )}
            {node.type === 'condition' && (
              <div className="info-block">条件节点自动判断路线。切换到「逻辑」设置判断顺序和兜底出口。</div>
            )}
          </>
        )}
        {node.type === 'jump' && (
          <label className="field">
            跳转目标
            <select
              value={node.targetNodeId ?? ''}
              onChange={(e) => update({ ...node, targetNodeId: e.target.value || null })}
            >
              <option value="">选择目标节点</option>
              {project.boards.map((b) => (
                <optgroup key={b.id} label={b.name}>
                  {project.nodes
                    .filter((n) => n.boardId === b.id && n.id !== node.id)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.title} · {nodeMeta[n.type].label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            <span className="field-help">跳转会保留变量，不会自动返回。</span>
          </label>
        )}
        {tab === 'logic' && (
          <>
            {node.type === 'story' && (
              <section className="editor-section">
                <h3>进入节点时执行</h3>
                <p className="field-help">每次进入都会执行；效果按顺序生效。</p>
                <EffectFields
                  variables={project.variables}
                  value={node.effects}
                  onChange={(effects) => update({ ...node, effects })}
                />
              </section>
            )}
            {node.type === 'choice' &&
              node.options.map((o, i) => (
                <section className="editor-section" key={o.id}>
                  <h3>
                    {i + 1}. {o.text || '未命名选项'}
                  </h3>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      disabled={!project.variables.length}
                      checked={!!o.condition}
                      onChange={(e) =>
                        updateOption(i, {
                          condition: e.target.checked ? defaultCondition(project.variables[0]) : null,
                        })
                      }
                    />
                    设置可见条件
                  </label>
                  {o.condition && (
                    <ConditionFields
                      variables={project.variables}
                      value={o.condition}
                      onChange={(condition) => updateOption(i, { condition })}
                    />
                  )}
                  <p className="field-help">选中后执行：</p>
                  <EffectFields
                    variables={project.variables}
                    value={o.effects}
                    onChange={(effects) => updateOption(i, { effects })}
                  />
                </section>
              ))}
            {node.type === 'condition' && (
              <section className="editor-section">
                <h3>按顺序判断</h3>
                <p className="field-help">只走第一个满足的条件；调整顺序会改变优先级。</p>
                {node.branches.map((b, i) => (
                  <div className="option-editor" key={b.id}>
                    <div className="section-heading">
                      <span>条件 {i + 1}</span>
                      <div className="button-group">
                        <button
                          className="icon-button"
                          disabled={i === 0}
                          title="条件上移"
                          onClick={async () => update({ ...node, branches: move(node.branches, i, -1) })}
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          className="icon-button"
                          disabled={i === node.branches.length - 1}
                          title="条件下移"
                          onClick={async () => update({ ...node, branches: move(node.branches, i, 1) })}
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          className="icon-button danger"
                          title="删除条件及连线"
                          onClick={async () => {
                            if (await askConfirmation('删除这个条件及其连线？'))
                              update({ ...node, branches: node.branches.filter((_, j) => j !== i) });
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                    <ConditionFields
                      variables={project.variables}
                      value={b.condition}
                      onChange={(condition) =>
                        update({
                          ...node,
                          branches: node.branches.map((old, j) => (j === i ? { ...old, condition } : old)),
                        })
                      }
                    />
                  </div>
                ))}
                <button
                  className="text-button small"
                  disabled={!project.variables.length}
                  onClick={async () =>
                    update({
                      ...node,
                      branches: [
                        ...node.branches,
                        { id: id(), condition: defaultCondition(project.variables[0]) },
                      ],
                    })
                  }
                >
                  <Plus size={14} />
                  添加条件
                </button>
                <div className="fallback-label">否则 → 始终保留的兜底出口</div>
              </section>
            )}
            {['start', 'jump', 'end'].includes(node.type) && (
              <p className="field-help">此类型没有变量效果。变量通过剧情或玩家选项修改。</p>
            )}
          </>
        )}
      </fieldset>
      <div className="inspector-footer">
        <button className="secondary-button" onClick={run}>
          <CirclePlay size={15} />
          从这里试跑
        </button>
        <button
          className="icon-button danger"
          disabled={readOnly || node.type === 'start'}
          title={node.type === 'start' ? '场景起点不能单独删除' : '删除节点'}
          onClick={remove}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </aside>
  );
}
