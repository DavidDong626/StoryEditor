import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Flag, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import type { Project, Value } from '../core/model';
import { advance, enter, initialState, visibleOptions } from '../core/runtime';
import { ValueInput } from './LogicFields';
import { useDialogFocus } from './useDialogFocus';
import CharacterAvatar from './CharacterAvatar';

export default function Playtest({
  project,
  startId,
  close,
}: {
  project: Project;
  startId: string;
  close: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, close);
  // Project is a deep copy supplied on opening; edits do not alter this run.
  const [frame, setFrame] = useState(() => enter(project, startId, initialState(project)));
  const [history, setHistory] = useState<(typeof frame)[]>([]),
    [debug, setDebug] = useState(true);
  const node = project.nodes.find((n) => n.id === frame.nodeId);
  const board = project.boards.find((b) => b.id === node?.boardId);
  const forward = (optionId?: string) => {
    const next = advance(project, frame, optionId);
    setHistory([...history, structuredClone(frame)]);
    setFrame(next);
  };
  const back = () => {
    setFrame(history[history.length - 1]);
    setHistory(history.slice(0, -1));
  };
  const changeVariable = (variableId: string, value: Value) => {
    setFrame({ ...frame, state: { ...frame.state, [variableId]: value } });
  };
  let options: ReturnType<typeof visibleOptions> = [];
  try {
    if (node && !frame.error) options = visibleOptions(node, frame.state);
  } catch {
    /* runtime reports invalid expressions */
  }
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="playtest-modal"
        role="dialog"
        aria-modal="true"
        aria-label="剧情试跑"
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">PLAYTEST · 剧情试跑</span>
            <h2>{project.name}</h2>
          </div>
          <div className="button-group">
            <span className="revision-badge">版本 {project.revision}</span>
            <button
              className={`icon-button ${debug ? 'active' : ''}`}
              title="变量调试面板"
              onClick={() => setDebug(!debug)}
            >
              <SlidersHorizontal size={18} />
            </button>
            <button className="icon-button" title="关闭试跑" onClick={close}>
              <X size={20} />
            </button>
          </div>
        </header>
        <div className="playtest-body">
          <div className="story-reader">
            <div className="reader-breadcrumb">
              {board?.name ?? '未知场景'} <span>/</span> {node?.type === 'end' ? '结局' : '故事进行中'}
            </div>
            {frame.error ? (
              <div className="run-error">
                <h2>剧情在这里暂停了</h2>
                <p>{frame.error}</p>
                <small>关闭试跑后，可以在画布中检查当前路径。</small>
              </div>
            ) : (
              <>
                {node?.type === 'end' && <Flag className="ending-symbol" size={30} />}
                <h1>{node?.title}</h1>
                {node && 'text' in node && <p className="reader-text">{node.text || '这一段还没有正文。'}</p>}
                {node?.type === 'story' &&
                  node.lines.map((line) => (
                    <div className="reader-dialogue" key={line.id}>
                      <div className="dialogue-speaker">
                        {(() => {
                          const character = project.characters.find((c) => c.id === line.speakerId);
                          return character ? (
                            <>
                              <CharacterAvatar character={character} />
                              <span>{character.name}</span>
                            </>
                          ) : (
                            <span>旁白</span>
                          );
                        })()}
                      </div>
                      <p>{line.text}</p>
                    </div>
                  ))}
                <div className="reader-options">
                  {node?.type === 'story' && (
                    <button onClick={() => forward()}>
                      继续故事
                      <ArrowRight size={16} />
                    </button>
                  )}
                  {node?.type === 'choice' &&
                    options.map((o, i) => (
                      <button key={o.id} onClick={() => forward(o.id)}>
                        <span className="option-number">{String(i + 1).padStart(2, '0')}</span>
                        {o.text}
                        <ArrowRight size={16} />
                      </button>
                    ))}
                  {node?.type === 'end' && (
                    <div className="ending-caption">本次故事已结束 · {node.endingKey || '未命名结局'}</div>
                  )}
                </div>
              </>
            )}
            <div className="reader-navigation">
              <button className="text-button small" disabled={!history.length} onClick={back}>
                <ArrowLeft size={14} />
                退回上一步
              </button>
              <button
                className="text-button small"
                onClick={() => {
                  setFrame(enter(project, startId, initialState(project)));
                  setHistory([]);
                }}
              >
                <RotateCcw size={14} />
                重新开始
              </button>
            </div>
          </div>
          {debug && (
            <aside className="debug-panel">
              <h3>
                <SlidersHorizontal size={15} />
                变量调试
              </h3>
              <p className="field-help">修改仅影响本次试跑，不改项目默认值。当前段落的进入效果不会重跑。</p>
              {project.variables.length ? (
                project.variables.map((v) => (
                  <label className="field" key={v.id}>
                    {v.name}
                    <span className="variable-key">{v.key}</span>
                    <ValueInput
                      label={`调试 ${v.key}`}
                      type={v.type}
                      value={frame.state[v.id]}
                      onChange={(value) => changeVariable(v.id, value)}
                    />
                  </label>
                ))
              ) : (
                <p className="field-help">项目尚未定义变量。</p>
              )}
              <h3 className="path-title">经过的路径</h3>
              <ol className="run-path">
                {frame.path.slice(-100).map((nodeId, i) => (
                  <li key={`${nodeId}-${i}`}>
                    {project.nodes.find((n) => n.id === nodeId)?.title ?? '失效节点'}
                  </li>
                ))}
              </ol>
              <p className="field-help">固定版本试跑 · {history.length} 次选择/继续</p>
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}
