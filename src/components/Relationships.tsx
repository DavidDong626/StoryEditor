import { useId, useState } from 'react';
import { ArrowLeftRight, ChevronDown, ChevronRight, Plus, Trash2, Users } from 'lucide-react';
import { id, type Project, type Relationship } from '../core/model';
import CharacterAvatar from './CharacterAvatar';
import { askConfirmation } from './Dialogs';

const statusNames = { draft: '草稿', review: '待审阅', approved: '已确认' };
export default function Relationships({
  project,
  readOnly,
  change,
  initialCharacterId,
  manageCharacters,
}: {
  project: Project;
  readOnly: boolean;
  change: (label: string, transform: (p: Project) => Project) => void;
  initialCharacterId: string | null;
  manageCharacters: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState(initialCharacterId ?? '');
  const [search, setSearch] = useState('');
  const kindList = useId();
  const relationships = project.relationships ?? [];
  const character = (characterId: string) => project.characters.find((c) => c.id === characterId);
  const visible = relationships.filter(
    (relation) =>
      (!filter || relation.sourceCharacterId === filter || relation.targetCharacterId === filter) &&
      [
        relation.title,
        relation.kind,
        relation.description,
        relation.development,
        character(relation.sourceCharacterId)?.name,
        character(relation.targetCharacterId)?.name,
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  function update(relationId: string, patch: Partial<Relationship>) {
    change(`编辑角色关系：${relationId}`, (p) => ({
      ...p,
      relationships: (p.relationships ?? []).map((old) =>
        old.id === relationId ? { ...old, ...patch } : old,
      ),
    }));
  }
  function create() {
    if (readOnly || project.characters.length < 2) return;
    const source = character(filter) ?? project.characters[0];
    const target = project.characters.find((c) => c.id !== source.id)!;
    const relation: Relationship = {
      id: id(),
      title: '新的关系设定',
      sourceCharacterId: source.id,
      targetCharacterId: target.id,
      kind: '待定义',
      direction: 'mutual',
      affinity: 0,
      description: '',
      development: '',
      status: 'draft',
    };
    change('新建角色关系卡片', (p) => ({ ...p, relationships: [...(p.relationships ?? []), relation] }));
    setExpanded(relation.id);
    setSearch('');
  }
  return (
    <div className="relationships-panel">
      <div className="relationship-intro">
        <div>
          <span className="eyebrow">CHARACTER RELATIONSHIPS</span>
          <h3>把人物之间的牵绊，写成故事的起点</h3>
          <p>记录关系、动机与变化。这些是创作设定；剧情中的好感度变化仍通过项目变量设计。</p>
        </div>
        <ArrowLeftRight size={32} />
      </div>
      <div className="relationship-toolbar">
        <input
          aria-label="搜索角色关系"
          placeholder="搜索角色、关系或剧情备注…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label="按角色筛选关系" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">全部角色</option>
          {project.characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || '未命名角色'}
            </option>
          ))}
        </select>
        <button
          className="primary-button"
          disabled={readOnly || project.characters.length < 2}
          onClick={create}
        >
          <Plus size={15} />
          新建关系卡片
        </button>
      </div>
      {project.characters.length < 2 && (
        <div className="info-block">
          至少需要两个角色才能设计关系。
          <button className="text-button" disabled={readOnly} onClick={manageCharacters}>
            添加角色
          </button>
        </div>
      )}
      <div className="relationship-count">
        {filter || search ? `找到 ${visible.length} 张卡片` : `共 ${relationships.length} 张关系卡片`}
        <span>同一对角色可以拥有多种关系设定</span>
      </div>
      <datalist id={kindList}>
        {['朋友', '家人', '恋人', '师徒', '盟友', '对手', '上下级', '秘密关联'].map((kind) => (
          <option key={kind} value={kind} />
        ))}
      </datalist>
      {!visible.length && (
        <div className="relationship-empty">
          <Users size={28} />
          <h3>{relationships.length ? '没有符合条件的关系' : '还没有角色关系卡片'}</h3>
          <p>
            {relationships.length
              ? '调整筛选或搜索词，再看看其他人物的关系。'
              : '选择两位角色，记录他们的牵绊、冲突和未来的转折。'}
          </p>
        </div>
      )}
      {visible.map((relation) => {
        const source = character(relation.sourceCharacterId),
          target = character(relation.targetCharacterId);
        const isExpanded = expanded === relation.id;
        return (
          <article
            className={`relationship-card ${isExpanded ? 'expanded' : ''}`}
            key={relation.id}
            aria-label={`关系卡片：${relation.title || relation.kind}`}
          >
            <div className="relationship-card-header">
              <button
                className="relationship-summary"
                aria-expanded={isExpanded}
                onClick={() => setExpanded(isExpanded ? null : relation.id)}
              >
                <span className="relationship-pair">
                  <span>
                    {source && <CharacterAvatar character={source} />}
                    <strong>{source?.name || '角色不存在'}</strong>
                  </span>
                  <span
                    className="relationship-arrow"
                    aria-label={relation.direction === 'mutual' ? '双向关系' : '从左侧角色指向右侧角色'}
                  >
                    {relation.direction === 'mutual' ? '↔' : '→'}
                    <small>{relation.kind || '待定义'}</small>
                  </span>
                  <span>
                    {target && <CharacterAvatar character={target} />}
                    <strong>{target?.name || '角色不存在'}</strong>
                  </span>
                </span>
                <span className="relationship-card-caption">
                  <strong>{relation.title || '未命名关系'}</strong>
                  <span>
                    {statusNames[relation.status]} · 亲疏 {relation.affinity > 0 ? '+' : ''}
                    {relation.affinity}
                  </span>
                </span>
                {isExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
              </button>
              <button
                className="icon-button danger"
                title={`删除关系：${relation.title || relation.kind}`}
                disabled={readOnly}
                onClick={async () => {
                  if (
                    await askConfirmation(
                      `删除“${relation.title || relation.kind}”关系卡片？两个角色及其对白都会保留。`,
                    )
                  ) {
                    change('删除角色关系卡片', (p) => ({
                      ...p,
                      relationships: (p.relationships ?? []).filter((r) => r.id !== relation.id),
                    }));
                    if (isExpanded) setExpanded(null);
                  }
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
            {!isExpanded && relation.description && (
              <p className="relationship-preview">{relation.description}</p>
            )}
            {isExpanded && (
              <fieldset className="relationship-form" disabled={readOnly}>
                <label className="field relationship-full">
                  卡片标题
                  <input
                    value={relation.title}
                    maxLength={200}
                    onChange={(e) => update(relation.id, { title: e.target.value })}
                    placeholder="例如：互相信任，却各有隐瞒"
                  />
                </label>
                <label className="field">
                  角色 A
                  <select
                    value={relation.sourceCharacterId}
                    onChange={(e) => update(relation.id, { sourceCharacterId: e.target.value })}
                  >
                    {project.characters.map((c) => (
                      <option key={c.id} disabled={c.id === relation.targetCharacterId} value={c.id}>
                        {c.name || '未命名角色'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  角色 B
                  <select
                    value={relation.targetCharacterId}
                    onChange={(e) => update(relation.id, { targetCharacterId: e.target.value })}
                  >
                    {project.characters.map((c) => (
                      <option key={c.id} disabled={c.id === relation.sourceCharacterId} value={c.id}>
                        {c.name || '未命名角色'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  关系类型
                  <input
                    value={relation.kind}
                    maxLength={60}
                    list={kindList}
                    placeholder="选择或填写关系类型"
                    onChange={(e) => update(relation.id, { kind: e.target.value })}
                  />
                </label>
                <label className="field">
                  关系方向
                  <select
                    value={relation.direction}
                    onChange={(e) =>
                      update(relation.id, { direction: e.target.value as Relationship['direction'] })
                    }
                  >
                    <option value="mutual">双向 · A ↔ B</option>
                    <option value="directed">单向 · A → B</option>
                  </select>
                </label>
                <label className="field">
                  亲疏程度：{relation.affinity}
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    step={1}
                    value={relation.affinity}
                    onChange={(e) => update(relation.id, { affinity: Number(e.target.value) })}
                  />
                  <span className="relationship-scale">
                    <span>−100 敌对</span>
                    <span>0 中立</span>
                    <span>+100 亲密</span>
                  </span>
                </label>
                <label className="field">
                  设定状态
                  <select
                    value={relation.status}
                    onChange={(e) =>
                      update(relation.id, { status: e.target.value as Relationship['status'] })
                    }
                  >
                    {Object.entries(statusNames).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field relationship-full">
                  关系设定
                  <textarea
                    rows={3}
                    value={relation.description}
                    maxLength={10000}
                    onChange={(e) => update(relation.id, { description: e.target.value })}
                    placeholder="他们如何相识？彼此想得到什么？有什么共同秘密或冲突？"
                  />
                </label>
                <label className="field relationship-full">
                  变化与剧情用途
                  <textarea
                    rows={3}
                    value={relation.development}
                    maxLength={10000}
                    onChange={(e) => update(relation.id, { development: e.target.value })}
                    placeholder="哪件事会改变这段关系？在哪个场景揭露、升温或决裂？"
                  />
                </label>
              </fieldset>
            )}
          </article>
        );
      })}
    </div>
  );
}
