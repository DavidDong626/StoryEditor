import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import {
  ArrowUpRight,
  CirclePlay,
  Flag,
  GitBranch,
  MessageSquareText,
  Split,
  type LucideIcon,
} from 'lucide-react';
import { nodeMeta, ports, type StoryNode } from '../core/model';

const icons: Record<StoryNode['type'], LucideIcon> = {
  start: CirclePlay,
  story: MessageSquareText,
  choice: GitBranch,
  condition: Split,
  jump: ArrowUpRight,
  end: Flag,
};
export type CardNode = Node<
  { story: StoryNode; index: number; issueCount: number; dimmed: boolean },
  'storyCard'
>;
function StoryCard({ data, selected }: NodeProps<CardNode>) {
  const n = data.story,
    meta = nodeMeta[n.type],
    Icon = icons[n.type];
  const summary =
    'text' in n
      ? n.text
      : n.type === 'condition'
        ? `${n.branches.length} 个条件 · 首个命中`
        : n.type === 'jump'
          ? '跳转至另一个场景或节点'
          : '故事从这里开始';
  return (
    <div
      className={`story-card ${selected ? 'selected' : ''} ${data.dimmed ? 'dimmed' : ''}`}
      style={{ '--node-color': meta.color } as React.CSSProperties}
    >
      {n.type !== 'start' && <Handle type="target" position={Position.Left} id="in" />}
      <div className="card-heading">
        <span className="node-kind">
          <Icon size={13} />
          {meta.label}
        </span>
        <span className="card-number">{String(data.index + 1).padStart(2, '0')}</span>
      </div>
      <h3>{n.title || '未命名节点'}</h3>
      <p className="card-summary">{summary || '添加剧情内容…'}</p>
      {n.type === 'story' && n.lines.length > 0 && (
        <div className="card-dialogue">
          <MessageSquareText size={12} />
          {n.lines.length} 句对白
        </div>
      )}
      {['choice', 'condition'].includes(n.type) && (
        <div className="card-ports">
          {ports(n).map((port) => (
            <div key={port.id} className="port-row">
              <span>{port.label}</span>
              <Handle type="source" position={Position.Right} id={port.id} style={{ top: '50%' }} />
            </div>
          ))}
        </div>
      )}
      <div className="card-footer">
        <span className={`status-dot ${n.status}`} />
        {n.status === 'draft' ? '草稿' : n.status === 'review' ? '待审阅' : '已确认'}
        {data.issueCount > 0 && <span className="card-issue">{data.issueCount} 个问题</span>}
      </div>
      {(n.type === 'start' || n.type === 'story') && (
        <Handle type="source" position={Position.Right} id={n.portId} />
      )}
    </div>
  );
}
export default memo(StoryCard);
