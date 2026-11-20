import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
} from '@xyflow/react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CirclePlay,
  Copy,
  Download,
  FileJson,
  Folder,
  GitBranch,
  History,
  Layers3,
  LayoutGrid,
  Map as MapIcon,
  MessageSquareText,
  Plus,
  Redo2,
  Search,
  Settings2,
  Sparkles,
  Split,
  Trash2,
  Undo2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import {
  conditionsOf,
  createNode,
  effectsOf,
  id,
  newProject,
  nodeMeta,
  ports,
  projectSchema,
  type Character,
  type NodeType,
  type Project,
  type StoryNode,
  type Variable,
} from './core/model';
import { checkProject } from './core/check';
import { backup, download, importBackup, runtimeExport } from './core/transfer';
import { readLibrary, replaceProject, writeLibrary, type Library } from './core/storage';
import { sampleProject } from './core/sample';
import StoryCard, { type CardNode } from './components/StoryCard';
import Inspector from './components/Inspector';
import Playtest from './components/Playtest';
import { ValueInput } from './components/LogicFields';
import { useDialogFocus } from './components/useDialogFocus';
import { askConfirmation, askText } from './components/Dialogs';
import Collaboration from './components/Collaboration';
import { RemoteClient, type RemoteState } from './core/client';
import type { Envelope } from './core/collaboration';
import { importAvatar } from './core/avatar';
import CharacterAvatar from './components/CharacterAvatar';

const nodeTypes = { storyCard: StoryCard };
type Modal =
  'projects' | 'characters' | 'variables' | 'export' | 'history' | 'about' | 'collaboration' | null;
type HistoryEntry = { id: string; label: string; time: string; revision: number };
function ModalShell({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, close);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" title="关闭窗口" onClick={close}>
            <X size={19} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </section>
    </div>
  );
}

export default function App() {
  const [library, setLibrary] = useState<Library | null>(null),
    [loadError, setLoadError] = useState('');
  const [localWritable, setWritable] = useState(false),
    [saveState, setSaveState] = useState<'saving' | 'saved' | 'error'>('saving');
  const [remoteClient] = useState(() => new RemoteClient());
  const [remoteState, setRemoteState] = useState<RemoteState | null>(null);
  const remoteActive = useRef(false),
    localLibrary = useRef<Library | null>(null);
  const writable = remoteState
    ? remoteState.status === 'online' && remoteState.data?.role !== 'viewer'
    : localWritable;
  const [boardId, setBoardId] = useState(''),
    [selection, setSelection] = useState<string[]>([]);
  const [modal, setModal] = useState<Modal>(null),
    [panel, setPanel] = useState<'issues' | 'history' | null>(null);
  const [charactersExpanded, setCharactersExpanded] = useState(true);
  const [variablesExpanded, setVariablesExpanded] = useState(false);
  const [resourceTarget, setResourceTarget] = useState<string | null>(null);
  const [search, setSearch] = useState(''),
    [typeFilter, setTypeFilter] = useState('all');
  const [nodeMenu, setNodeMenu] = useState(false),
    [toast, setToast] = useState('');
  const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }>>({}),
    [spaceHeld, setSpaceHeld] = useState(false);
  const [measurements, setMeasurements] = useState<Record<string, { width: number; height: number }>>({});
  const [run, setRun] = useState<{ project: Project; startId: string } | null>(null);
  const [undo, setUndo] = useState<Project[]>([]),
    [redo, setRedo] = useState<Project[]>([]),
    [events, setEvents] = useState<HistoryEntry[]>([]);
  const fileRef = useRef<HTMLInputElement>(null),
    libraryRef = useRef<Library | null>(null),
    writeQueue = useRef(Promise.resolve());
  const editGroup = useRef<{ label: string; time: number } | null>(null),
    saveSequence = useRef(0);
  const flow = useReactFlow<CardNode>();

  function openRemote(data: Envelope) {
    if (!remoteActive.current) localLibrary.current = libraryRef.current;
    remoteActive.current = true;
    sessionStorage.setItem('story-remote-project', data.project.id);
    remoteClient.open(data);
    switchBoard(data.project.boards[0].id);
    setUndo([]);
    setRedo([]);
    setEvents([]);
  }
  function returnLocal() {
    remoteClient.close();
    remoteActive.current = false;
    sessionStorage.removeItem('story-remote-project');
    setRemoteState(null);
    if (localLibrary.current) {
      libraryRef.current = localLibrary.current;
      setLibrary(localLibrary.current);
      const p = localLibrary.current.projects.find((p) => p.id === localLibrary.current!.activeId)!;
      switchBoard(p.boards[0].id);
    }
    setUndo([]);
    setRedo([]);
    setSaveState('saved');
  }
  useEffect(() => {
    remoteClient.onChange = (state, replace) => {
      if (!remoteActive.current) return;
      setRemoteState(state);
      setSaveState(state.status === 'conflict' ? 'error' : state.pending ? 'saving' : 'saved');
      if (replace && state.data) {
        const next: Library = {
          version: 1,
          activeId: state.data.project.id,
          projects: [state.data.project],
          snapshots: [],
        };
        libraryRef.current = next;
        setLibrary(next);
        setDragPositions({});
        void remoteClient
          .api(`/projects/${state.data.project.id}/history`)
          .then(setEvents)
          .catch(() => {});
      }
    };
    return () => {
      remoteClient.close();
    };
  }, [remoteClient]);
  useEffect(() => {
    if (remoteState?.editing && remoteState.editing !== `nodes:${selection[0]}`)
      void remoteClient.edit(null).catch((e) => setToast(e.message));
  }, [selection, remoteClient, remoteState?.editing]);

  // Serialize browser writes and reject a second editing tab: local mode is not collaboration.
  useEffect(() => {
    let cancelled = false,
      release: (() => void) | undefined;
    const loaded = readLibrary()
      .then((data) => {
        if (!cancelled) {
          libraryRef.current = data;
          setLibrary(data);
          const active = data.projects.find((p) => p.id === data.activeId)!;
          setBoardId(active.boards[0].id);
          setSaveState('saved');
          const remoteId = sessionStorage.getItem('story-remote-project');
          if (remoteId)
            void remoteClient
              .api<Envelope>(`/projects/${remoteId}`)
              .then((data) => {
                if (!cancelled) openRemote(data);
              })
              .catch((e) => {
                if (!cancelled) setToast(e.message);
              });
          if (location.hash.includes('invite=')) setModal('collaboration');
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError((e as Error).message);
      });
    // Wait for loading before requesting the lock, so React StrictMode's cancelled
    // effect cannot momentarily occupy it and make the real effect read-only.
    void loaded.then(() => {
      if (cancelled || !libraryRef.current) return;
      if (navigator.locks) {
        void navigator.locks.request('story-editor-local-writer', { ifAvailable: true }, async (lock) => {
          if (!lock || cancelled) return;
          setWritable(true);
          await new Promise<void>((resolve) => {
            release = resolve;
            if (cancelled) resolve();
          });
        });
      }
    });
    return () => {
      cancelled = true;
      release?.();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4_500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saveState !== 'saved') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveState]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data === 'saved' && !writable && !remoteActive.current)
        void readLibrary()
          .then((data) => {
            libraryRef.current = data;
            setLibrary(data);
          })
          .catch(() => {});
    };
    const channel = new BroadcastChannel('story-editor-local');
    channel.onmessage = listener;
    return () => channel.close();
  }, [writable]);

  const project = library?.projects.find((p) => p.id === library.activeId);
  const board = project?.boards.find((b) => b.id === boardId) ?? project?.boards[0];
  const issues = useMemo(() => (project ? checkProject(project) : []), [project]);
  const errors = issues.filter((i) => i.level === 'error'),
    warnings = issues.filter((i) => i.level === 'warning');
  const selected = project?.nodes.find((n) => selection.length === 1 && n.id === selection[0]);
  const boardNodes = useMemo(
    () => project?.nodes.filter((n) => n.boardId === board?.id) ?? [],
    [project, board],
  );
  const matches = useCallback(
    (n: StoryNode) => {
      const text = [
        n.title,
        'text' in n ? n.text : '',
        ...(n.type === 'story' ? n.lines.map((l) => l.text) : []),
        ...(n.type === 'choice' ? n.options.map((o) => o.text) : []),
      ]
        .join(' ')
        .toLocaleLowerCase();
      return (
        (!search || text.includes(search.toLocaleLowerCase())) &&
        (typeFilter === 'all' || n.type === typeFilter)
      );
    },
    [search, typeFilter],
  );
  const nodes: CardNode[] = useMemo(
    () =>
      boardNodes.map((n, index) => ({
        id: n.id,
        type: 'storyCard',
        position: dragPositions[n.id] ?? n.position,
        measured: measurements[n.id],
        selected: selection.includes(n.id),
        draggable:
          !remoteState?.locks[`nodes:${n.id}`] ||
          remoteState.locks[`nodes:${n.id}`].clientId === remoteClient.clientId,
        data: {
          story: n,
          index,
          issueCount: issues.filter((i) => i.nodeId === n.id).length,
          dimmed: !matches(n),
        },
      })),
    [boardNodes, selection, issues, matches, dragPositions, measurements, remoteState, remoteClient],
  );
  const edges = useMemo(
    () =>
      project?.edges
        .filter((e) => e.boardId === board?.id)
        .map((e) => {
          const source = project.nodes.find((n) => n.id === e.sourceNodeId);
          const label =
            source && ['choice', 'condition'].includes(source.type)
              ? ports(source).find((p) => p.id === e.sourcePortId)?.label
              : undefined;
          return {
            id: e.id,
            source: e.sourceNodeId,
            sourceHandle: e.sourcePortId,
            target: e.targetNodeId,
            targetHandle: 'in',
            type: 'smoothstep',
            label,
            markerEnd: { type: 'arrowclosed' as const, color: '#a2a9be', width: 18, height: 18 },
            style: { stroke: '#a2a9be', strokeWidth: 1.6 },
            labelStyle: { fill: '#737d93', fontSize: 10 },
            labelBgStyle: { fill: '#f6f7fb' },
            labelBgPadding: [6, 3] as [number, number],
          };
        }) ?? [],
    [project, board],
  );

  function persist(next: Library) {
    if (remoteActive.current) {
      setToast('远程项目请使用协作窗口管理项目和快照。');
      setModal('collaboration');
      return;
    }
    if (!writable) {
      setToast('此标签页为只读。请在原编辑标签页修改。');
      return;
    }
    libraryRef.current = next;
    setLibrary(next);
    setSaveState('saving');
    const seq = ++saveSequence.current;
    writeQueue.current = writeQueue.current
      .catch(() => {})
      .then(() => writeLibrary(next))
      .then(() => {
        if (seq === saveSequence.current) setSaveState('saved');
        const channel = new BroadcastChannel('story-editor-local');
        channel.postMessage('saved');
        channel.close();
      })
      .catch((e) => {
        if (seq === saveSequence.current) {
          setSaveState('error');
          setToast((e as Error).message);
        }
      });
  }
  useEffect(() => {
    if (writable && libraryRef.current && !remoteActive.current) persist(libraryRef.current);
  }, [writable]);
  function change(label: string, transform: (p: Project) => Project) {
    const currentLibrary = libraryRef.current,
      current = currentLibrary?.projects.find((p) => p.id === currentLibrary.activeId);
    if (!current || !currentLibrary || !writable) {
      setToast('当前标签页只能查看。');
      return;
    }
    const result = transform(structuredClone(current));
    if (!projectSchema.safeParse(result).success) {
      setToast('此修改超过字段长度或数据容量限制，尚未保存。');
      return;
    }
    if (JSON.stringify(result) === JSON.stringify(current)) return;
    if (remoteActive.current) {
      try {
        remoteClient.submit(current, result, label);
        const next = replaceProject(currentLibrary, result);
        libraryRef.current = next;
        setLibrary(next);
      } catch (e) {
        setToast((e as Error).message);
      }
      return;
    }
    const now = Date.now(),
      grouped =
        label.startsWith('编辑') &&
        editGroup.current?.label === label &&
        now - editGroup.current.time < 1_200;
    if (!grouped) {
      setUndo((previous) => [...previous.slice(-49), structuredClone(current)]);
      setEvents((previous) => [
        { id: id(), label, time: new Date().toISOString(), revision: current.revision + 1 },
        ...previous.slice(0, 99),
      ]);
    }
    editGroup.current = { label, time: now };
    setRedo([]);
    result.revision = current.revision + 1;
    persist(replaceProject(currentLibrary, result));
  }
  function updateNode(node: StoryNode) {
    change(`编辑节点：${node.id}`, (p) => {
      p.nodes = p.nodes.map((n) => (n.id === node.id ? node : n));
      const validPorts = ports(node).map((p) => p.id);
      p.edges = p.edges.filter((e) => e.sourceNodeId !== node.id || validPorts.includes(e.sourcePortId));
      return p;
    });
  }
  function historyMove(direction: 'undo' | 'redo') {
    if (remoteActive.current) {
      if (direction === 'undo') void remoteClient.undo().catch((e) => setToast(e.message));
      return;
    }
    if (!project || !library || !writable) return;
    const stack = direction === 'undo' ? undo : redo,
      previous = stack[stack.length - 1];
    if (!previous) return;
    if (direction === 'undo') {
      setUndo(undo.slice(0, -1));
      setRedo([...redo, project]);
    } else {
      setRedo(redo.slice(0, -1));
      setUndo([...undo, project]);
    }
    editGroup.current = null;
    persist(replaceProject(library, { ...previous, revision: project.revision + 1 }));
    setEvents((e) => [
      {
        id: id(),
        label: direction === 'undo' ? '撤销自己的修改' : '重做自己的修改',
        time: new Date().toISOString(),
        revision: project.revision + 1,
      },
      ...e,
    ]);
  }
  function switchBoard(id: string) {
    setBoardId(id);
    setSelection([]);
    setNodeMenu(false);
    setDragPositions({});
  }
  function locate(nodeId: string) {
    const node = project?.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (node.boardId !== board?.id) setBoardId(node.boardId);
    setSelection([node.id]);
    setTimeout(() => {
      void flow.setCenter(node.position.x + 130, node.position.y + 100, { zoom: 1, duration: 400 });
    }, 100);
  }
  function addNode(type: NodeType) {
    if (!board || type === 'start') return;
    const bounds = document.querySelector('.canvas-shell')?.getBoundingClientRect();
    const pos = bounds
      ? flow.screenToFlowPosition({
          x: bounds.left + bounds.width / 2 - 100,
          y: bounds.top + bounds.height / 2 - 70,
        })
      : { x: 300, y: 200 };
    const node = createNode(type, board.id, pos);
    change(`新建${nodeMeta[type].label}节点`, (p) => ({ ...p, nodes: [...p.nodes, node] }));
    setSelection([node.id]);
    setNodeMenu(false);
  }
  function connect(c: Connection) {
    if (!project || !board || !c.sourceHandle) return;
    const source = project.nodes.find((n) => n.id === c.source),
      target = project.nodes.find((n) => n.id === c.target);
    if (!source || !target || target.type === 'start' || source.boardId !== target.boardId) {
      setToast('请连接同一场景的有效节点；跨场景使用跳转。');
      return;
    }
    if (project.edges.some((e) => e.sourceNodeId === c.source && e.sourcePortId === c.sourceHandle)) {
      setToast('这个出口已经有连线。请先删除原连线。');
      return;
    }
    change('连接剧情节点', (p) => ({
      ...p,
      edges: [
        ...p.edges,
        {
          id: id(),
          boardId: board.id,
          sourceNodeId: c.source!,
          sourcePortId: c.sourceHandle!,
          targetNodeId: c.target!,
        },
      ],
    }));
  }
  async function deleteNodes() {
    if (!project || !selection.length) return;
    const removable = selection.filter((s) => project.nodes.find((n) => n.id === s)?.type !== 'start');
    if (!removable.length) return;
    const refs = project.nodes.filter(
      (n) => n.type === 'jump' && n.targetNodeId && removable.includes(n.targetNodeId),
    );
    if (refs.length) {
      setToast(`无法删除：${refs.map((n) => n.title).join('、')} 正在跳转到此处。请先修改引用。`);
      return;
    }
    const count = project.edges.filter(
      (e) => removable.includes(e.sourceNodeId) || removable.includes(e.targetNodeId),
    ).length;
    if (!(await askConfirmation(`删除 ${removable.length} 个节点及 ${count} 条关联连线？可以撤销。`))) return;
    change('删除剧情节点', (p) => ({
      ...p,
      nodes: p.nodes.filter((n) => !removable.includes(n.id)),
      edges: p.edges.filter(
        (e) => !removable.includes(e.sourceNodeId) && !removable.includes(e.targetNodeId),
      ),
    }));
    setSelection([]);
  }
  function duplicate() {
    if (!project) return;
    const originals = project.nodes.filter((n) => selection.includes(n.id) && n.type !== 'start');
    if (!originals.length) return;
    const remap = new Map<string, string>();
    for (const n of originals) {
      remap.set(n.id, id());
      for (const p of ports(n)) remap.set(p.id, id());
    }
    const copies = originals.map((original) => {
      const n = structuredClone(original);
      n.id = remap.get(n.id)!;
      n.position = { x: n.position.x + 70, y: n.position.y + 70 };
      n.title += ' · 副本';
      if ('portId' in n) n.portId = remap.get(n.portId)!;
      if (n.type === 'choice') n.options = n.options.map((o) => ({ ...o, id: remap.get(o.id)! }));
      if (n.type === 'condition') {
        n.branches = n.branches.map((b) => ({ ...b, id: remap.get(b.id)! }));
        n.fallbackId = remap.get(n.fallbackId)!;
      }
      if (n.type === 'story') n.lines = n.lines.map((l) => ({ ...l, id: id() }));
      if (n.type === 'jump' && n.targetNodeId && remap.has(n.targetNodeId))
        n.targetNodeId = remap.get(n.targetNodeId)!;
      return n;
    });
    const copyEdges = project.edges
      .filter(
        (e) =>
          originals.some((n) => n.id === e.sourceNodeId) && originals.some((n) => n.id === e.targetNodeId),
      )
      .map((e) => ({
        ...e,
        id: id(),
        sourceNodeId: remap.get(e.sourceNodeId)!,
        sourcePortId: remap.get(e.sourcePortId)!,
        targetNodeId: remap.get(e.targetNodeId)!,
      }));
    change('复制选中子图', (p) => ({
      ...p,
      nodes: [...p.nodes, ...copies],
      edges: [...p.edges, ...copyEdges],
    }));
    setSelection(copies.map((n) => n.id));
    setToast('已复制内部连线；外部连线未复制，跳转引用保留。');
  }
  function startRun(startId = project?.entryNodeId) {
    if (project && startId) {
      setRun({ project: structuredClone(project), startId });
    } else setToast('请先设置正式入口。');
  }
  async function addBoard() {
    if (!project) return;
    const name = await askText('新场景名称', '新的场景');
    if (!name?.trim()) return;
    const newId = id(),
      start = createNode('start', newId, { x: 80, y: 180 });
    change('新建场景', (p) => ({
      ...p,
      boards: [
        ...p.boards,
        {
          id: newId,
          folderId: board?.folderId ?? p.folders[0].id,
          name: name.trim().slice(0, 200),
          startNodeId: start.id,
        },
      ],
      nodes: [...p.nodes, start],
    }));
    switchBoard(newId);
  }
  async function snapshot(name?: string) {
    if (remoteActive.current) {
      setModal('collaboration');
      return;
    }
    if (!project || !library) return;
    const title = name ?? (await askText('快照名称', `${board?.name ?? '剧情'} · 修改前`));
    if (!title?.trim()) return;
    persist({
      ...library,
      snapshots: [
        ...library.snapshots,
        {
          id: id(),
          name: title.trim(),
          createdAt: new Date().toISOString(),
          project: structuredClone(project),
        },
      ],
    });
    setToast('已保存本地快照。');
  }
  function selectProject(p: Project, add = false) {
    if (remoteActive.current) {
      setModal('collaboration');
      return;
    }
    if (!library) return;
    persist({ ...library, activeId: p.id, projects: add ? [...library.projects, p] : library.projects });
    switchBoard(p.boards[0].id);
    setUndo([]);
    setRedo([]);
    setEvents([]);
    setModal(null);
    editGroup.current = null;
  }
  async function importFile(file?: File) {
    if (remoteActive.current) {
      setToast('请先在协作窗口返回本地项目，再导入备份并发布。');
      return;
    }
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，无法导入。');
      const imported = importBackup(await file.text());
      if (
        await askConfirmation(
          `将“${imported.name}”作为新项目导入？\n${imported.boards.length} 个场景 · ${imported.nodes.length} 个节点\n不会覆盖当前项目。`,
        )
      ) {
        selectProject(imported, true);
        setToast('备份已导入为新项目。');
      }
    } catch (e) {
      setToast((e as Error).message);
    }
    if (fileRef.current) fileRef.current.value = '';
  }
  async function exportRuntime() {
    if (!project) return;
    try {
      const result = remoteActive.current
        ? await remoteClient.api(`/projects/${project.id}/export?format=runtime&revision=${project.revision}`)
        : runtimeExport(project);
      if (
        warnings.length &&
        !(await askConfirmation(`仍有 ${warnings.length} 项警告。确认已了解这些问题并继续导出？`))
      )
        return;
      download(`${project.name}-运行数据`, result);
      setToast('运行数据已导出。');
    } catch (e) {
      setPanel('issues');
      setToast((e as Error).message);
    }
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        e.isComposing ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        target.isContentEditable ||
        modal ||
        run ||
        document.querySelector('.confirmation-overlay')
      )
        return;
      if (e.code === 'Space') {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        historyMove(e.shiftKey ? 'redo' : 'undo');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicate();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteNodes();
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        void flow.fitView({
          nodes: selection.length ? selection.map((id) => ({ id })) : undefined,
          duration: 300,
          padding: 0.2,
          maxZoom: 1,
        });
      } else if (e.key === 'Escape') {
        setSelection([]);
        setNodeMenu(false);
      }
    };
    const releaseSpace = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener('keydown', listener);
    window.addEventListener('keyup', releaseSpace);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', listener);
      window.removeEventListener('keyup', releaseSpace);
      window.removeEventListener('blur', blur);
    };
  });

  if (loadError)
    return (
      <div className="loading-screen">
        <BookOpen size={34} />
        <h1>无法打开本地故事</h1>
        <p>{loadError}</p>
        <p>未覆盖原有存储。请保留浏览器数据，以便排查。</p>
        <button className="primary-button" onClick={async () => location.reload()}>
          重试
        </button>
      </div>
    );
  if (!library || !project || !board)
    return (
      <div className="loading-screen">
        <BookOpen size={34} />
        <h1>叙事工坊</h1>
        <p>正在打开你的故事…</p>
      </div>
    );

  return (
    <div className="app">
      <input
        type="file"
        accept="application/json,.json"
        ref={fileRef}
        style={{ display: 'none' }}
        onChange={(e) => {
          void importFile(e.target.files?.[0]);
        }}
      />
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <GitBranch size={21} />
          </div>
          <span>叙事工坊</span>
          <span className="version-tag">ALPHA</span>
        </div>
        <div className="top-divider" />
        <button className="project-switch" onClick={async () => setModal('projects')}>
          <span>{project.name}</span>
          <ChevronDown size={14} />
        </button>
        <div className={`save-status ${saveState}`}>
          <span className="status-dot" />
          {saveState === 'saved'
            ? remoteState
              ? remoteState.status === 'online'
                ? '已保存到服务端'
                : '连接中断'
              : '已保存到本机'
            : saveState === 'saving'
              ? '正在保存…'
              : '保存失败'}
          {saveState === 'error' && (
            <button onClick={async () => (remoteState ? setModal('collaboration') : persist(library))}>
              处理
            </button>
          )}
        </div>
        <div className="topbar-spacer" />
        <button className="local-mode" onClick={async () => setModal('collaboration')}>
          <Users size={15} />
          <span>{remoteState ? `协作 · ${remoteState.online.length} 人在线` : '接入远程协作'}</span>
        </button>
        <button
          className="secondary-button check-button"
          onClick={async () => setPanel(panel === 'issues' ? null : 'issues')}
        >
          <CircleCheck size={15} />
          检查{errors.length > 0 && <span className="error-badge">{errors.length}</span>}
        </button>
        <button className="primary-button" onClick={async () => startRun()}>
          <CirclePlay size={16} />
          试跑剧情
        </button>
        <button className="icon-button export-top" title="导出剧情" onClick={async () => setModal('export')}>
          <Upload size={18} />
        </button>
        <button className="profile-avatar" title="本地创作者" onClick={async () => setModal('about')}>
          创
        </button>
      </header>
      {!writable && (
        <div className="read-only-banner">
          {remoteState
            ? remoteState.error || '当前为查看者，可以浏览和试跑剧情。'
            : '本地模式同一时间仅允许一个标签页编辑。此处可浏览与试跑；编辑请切回原标签页，或关闭原标签页后刷新。'}
          {remoteState && (
            <button className="text-button" onClick={() => setModal('collaboration')}>
              查看协作状态
            </button>
          )}
        </div>
      )}
      <div className="workspace">
        <aside className="sidebar">
          <div className="project-overview">
            <div className="project-emblem">
              <BookOpen size={23} />
            </div>
            <div>
              <strong>{project.name}</strong>
              <span>
                {project.boards.length} 个场景 · {project.nodes.length} 个节点
              </span>
            </div>
            <button className="icon-button" title="项目设置" onClick={async () => setModal('projects')}>
              <Settings2 size={15} />
            </button>
          </div>
          <div className="search-box">
            <Search size={15} />
            <input
              aria-label="搜索剧情"
              placeholder="搜索剧情、对白…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="icon-button" title="清除搜索" onClick={async () => setSearch('')}>
                <X size={12} />
              </button>
            )}
          </div>
          {search ? (
            <div className="search-results">
              <div className="sidebar-heading">
                搜索结果 <span>{project.nodes.filter(matches).length}</span>
              </div>
              {project.nodes.filter(matches).map((n) => (
                <button key={n.id} onClick={async () => locate(n.id)}>
                  <MessageSquareText size={14} />
                  <div>
                    {n.title}
                    <small>{project.boards.find((b) => b.id === n.boardId)?.name}</small>
                  </div>
                </button>
              ))}
              {!project.nodes.some(matches) && <p className="empty-text">没有找到匹配内容。</p>}
            </div>
          ) : (
            <>
              <div className="sidebar-heading">
                <span>故事结构</span>
                <div className="button-group">
                  <button
                    className="icon-button"
                    title="新建章节"
                    disabled={!writable}
                    onClick={async () => {
                      const name = await askText('章节名称', '新的章节');
                      if (!name?.trim()) return;
                      change('新建章节', (p) => ({
                        ...p,
                        folders: [...p.folders, { id: id(), name: name.trim().slice(0, 200) }],
                      }));
                    }}
                  >
                    <Folder size={14} />
                  </button>
                  <button className="icon-button" title="新建场景" disabled={!writable} onClick={addBoard}>
                    <Plus size={15} />
                  </button>
                </div>
              </div>
              <nav className="board-tree">
                {project.folders.map((folder) => (
                  <div key={folder.id}>
                    <div className="folder-title">
                      <ChevronDown size={13} />
                      <Folder size={14} />
                      <span>{folder.name}</span>
                    </div>
                    {project.boards
                      .filter((b) => b.folderId === folder.id)
                      .map((b) => (
                        <button
                          className={`board-item ${board.id === b.id ? 'active' : ''}`}
                          key={b.id}
                          onClick={async () => switchBoard(b.id)}
                        >
                          <MapIcon size={15} />
                          <span>{b.name}</span>
                          <span className="board-node-count">
                            {project.nodes.filter((n) => n.boardId === b.id).length}
                          </span>
                        </button>
                      ))}
                  </div>
                ))}
              </nav>
              <div className="sidebar-heading resources-heading">
                <span>故事资料</span>
                <span className="small-label">LIBRARY</span>
              </div>
              <button
                className="resource-item resource-folder"
                aria-expanded={charactersExpanded}
                aria-controls="sidebar-characters"
                onClick={() => setCharactersExpanded((value) => !value)}
              >
                {charactersExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Users size={16} />
                <span>角色资料</span>
                <span>{project.characters.length}</span>
              </button>
              {charactersExpanded && (
                <div className="resource-children" id="sidebar-characters" role="group" aria-label="角色列表">
                  {project.characters.map((character) => (
                    <button
                      key={character.id}
                      className="resource-child"
                      title={character.description || character.name}
                      onClick={() => {
                        setResourceTarget(character.id);
                        setModal('characters');
                      }}
                    >
                      <span className={`character-avatar ${character.color}`}>
                        {character.avatar ? (
                          <img src={character.avatar} alt={`${character.name}头像`} />
                        ) : (
                          character.name.slice(0, 1)
                        )}
                      </span>
                      <span className="resource-child-text">
                        <strong>{character.name || '未命名角色'}</strong>
                        {character.description && <small>{character.description}</small>}
                      </span>
                    </button>
                  ))}
                  {!project.characters.length && <p className="resource-empty">还没有角色</p>}
                  <button
                    className="resource-child resource-manage"
                    onClick={() => {
                      setResourceTarget(null);
                      setModal('characters');
                    }}
                  >
                    <Settings2 size={13} />
                    <span>管理角色{writable ? ' / 新建' : ''}</span>
                  </button>
                </div>
              )}
              <button
                className="resource-item resource-folder"
                aria-expanded={variablesExpanded}
                aria-controls="sidebar-variables"
                onClick={() => setVariablesExpanded((value) => !value)}
              >
                {variablesExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Split size={16} />
                <span>项目变量</span>
                <span>{project.variables.length}</span>
              </button>
              {variablesExpanded && (
                <div className="resource-children" id="sidebar-variables" role="group" aria-label="变量列表">
                  {project.variables.map((variable) => (
                    <button
                      key={variable.id}
                      className="resource-child variable-child"
                      onClick={() => {
                        setResourceTarget(variable.id);
                        setModal('variables');
                      }}
                    >
                      <Split size={14} />
                      <span className="resource-child-text">
                        <strong>{variable.name}</strong>
                        <small>
                          {variable.key} · {String(variable.defaultValue)}
                        </small>
                      </span>
                    </button>
                  ))}
                  {!project.variables.length && <p className="resource-empty">还没有变量</p>}
                  <button
                    className="resource-child resource-manage"
                    onClick={() => {
                      setResourceTarget(null);
                      setModal('variables');
                    }}
                  >
                    <Settings2 size={13} />
                    <span>管理变量{writable ? ' / 新建' : ''}</span>
                  </button>
                </div>
              )}
            </>
          )}
          <div className="sidebar-bottom">
            <button className="resource-item" onClick={() => setModal('collaboration')}>
              <Users size={16} />
              <span>{remoteState ? '协作与成员' : '远程协作'}</span>
            </button>
            <div className="tip-card">
              <span className="tip-icon">
                <Sparkles size={16} />
              </span>
              <strong>让故事的每条路都清晰</strong>
              <p>从出口拖动连线，连接下一段故事。选择节点后，在右侧编写内容。</p>
            </div>
            <button className="resource-item" onClick={async () => setModal('history')}>
              <History size={16} />
              <span>历史与快照</span>
            </button>
            <button className="resource-item subtle" onClick={async () => setModal('about')}>
              <BookOpen size={15} />
              <span>使用说明</span>
              <ArrowUpRight size={13} />
            </button>
            <div className="local-footnote">
              <span className="status-dot" />
              {remoteState
                ? `协作版本 ${project.revision} · ${remoteState.data?.role === 'viewer' ? '只读' : '服务端保存'}`
                : '本地版本 · 数据保存在此浏览器'}
            </div>
          </div>
        </aside>
        <main className="main-workspace">
          <div className="canvas-toolbar">
            <div className="breadcrumb">
              <Layers3 size={15} />
              <span>{project.folders.find((f) => f.id === board.folderId)?.name}</span>
              <ChevronRight size={13} />
              <strong>{board.name}</strong>
              <button className="icon-button" title="场景设置" onClick={async () => setModal('projects')}>
                <ChevronDown size={13} />
              </button>
            </div>
            <div className="toolbar-actions">
              <button
                className="icon-button"
                disabled={
                  !(remoteState ? remoteState.undoIds.length && !remoteState.pending : undo.length) ||
                  !writable
                }
                title="撤销 Ctrl+Z"
                onClick={async () => historyMove('undo')}
              >
                <Undo2 size={16} />
              </button>
              <button
                className="icon-button"
                disabled={!!remoteState || !redo.length || !writable}
                title="重做 Ctrl+Shift+Z"
                onClick={async () => historyMove('redo')}
              >
                <Redo2 size={16} />
              </button>
              <span className="toolbar-divider" />
              <select
                aria-label="筛选节点类型"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="all">全部类型</option>
                {Object.entries(nodeMeta).map(([type, meta]) => (
                  <option key={type} value={type}>
                    {meta.label}
                  </option>
                ))}
              </select>
              <div className="node-menu-anchor">
                <button
                  className="primary-button small"
                  disabled={!writable}
                  onClick={async () => setNodeMenu(!nodeMenu)}
                >
                  <Plus size={15} />
                  新建节点
                  <ChevronDown size={12} />
                </button>
                {nodeMenu && (
                  <div className="node-menu">
                    {(Object.keys(nodeMeta) as NodeType[])
                      .filter((type) => type !== 'start')
                      .map((type) => (
                        <button key={type} onClick={async () => addNode(type)}>
                          <span className="menu-type-dot" style={{ background: nodeMeta[type].color }} />
                          <div>
                            <strong>{nodeMeta[type].label}</strong>
                            <small>{nodeMeta[type].description}</small>
                          </div>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="canvas-shell">
            <ReactFlow<CardNode>
              key={board.id}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{
                padding: 0.16,
                maxZoom: 0.9,
                nodes: boardNodes.slice(0, 3).map((n) => ({ id: n.id })),
              }}
              minZoom={0.2}
              maxZoom={1.6}
              nodesDraggable={writable}
              nodesConnectable={writable}
              deleteKeyCode={null}
              selectionOnDrag={false}
              selectionKeyCode="Shift"
              panOnDrag={[0, 1, 2]}
              multiSelectionKeyCode="Shift"
              zoomOnDoubleClick={false}
              onNodesChange={(changes) => {
                const sizes = changes.filter((c) => c.type === 'dimensions');
                if (sizes.length)
                  setMeasurements((previous) => {
                    const next = { ...previous };
                    let changed = false;
                    for (const c of sizes) {
                      if (
                        c.type === 'dimensions' &&
                        c.dimensions &&
                        (next[c.id]?.width !== c.dimensions.width ||
                          next[c.id]?.height !== c.dimensions.height)
                      ) {
                        next[c.id] = c.dimensions;
                        changed = true;
                      }
                    }
                    return changed ? next : previous;
                  });
                const selectedChanges = changes.filter((c) => c.type === 'select');
                if (selectedChanges.length)
                  setSelection((previous) => {
                    const result = new Set(previous);
                    selectedChanges.forEach((c) => {
                      if (c.type === 'select') c.selected ? result.add(c.id) : result.delete(c.id);
                    });
                    return [...result];
                  });
              }}
              onNodeClick={(event, node) => {
                if (!event.shiftKey) setSelection([node.id]);
              }}
              onPaneClick={() => {
                setSelection([]);
                setNodeMenu(false);
              }}
              onNodeDrag={(_, _node, dragged) =>
                setDragPositions(Object.fromEntries(dragged.map((n) => [n.id, n.position])))
              }
              onNodeDragStop={(_, _node, dragged) => {
                setDragPositions({});
                change('移动剧情节点', (p) => ({
                  ...p,
                  nodes: p.nodes.map((n) => {
                    const moved = dragged.find((d) => d.id === n.id);
                    return moved ? { ...n, position: moved.position } : n;
                  }),
                }));
              }}
              onConnect={connect}
              onEdgeDoubleClick={async (_, edge) => {
                if (writable && (await askConfirmation('删除这条连线？可以撤销。')))
                  change('删除连线', (p) => ({ ...p, edges: p.edges.filter((e) => e.id !== edge.id) }));
              }}
              onPaneContextMenu={(event) => {
                event.preventDefault();
                if (writable) setNodeMenu(true);
              }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#dce0eb" />
              <MiniMap
                style={{ width: 210, height: 136 }}
                position="bottom-right"
                nodeColor={(n) => nodeMeta[(n.data as CardNode['data']).story.type].color}
                nodeStrokeColor={(n) => (n.selected ? '#302660' : '#ffffff')}
                nodeStrokeWidth={3}
                nodeBorderRadius={6}
                bgColor="#ffffff"
                ariaLabel="剧情小地图：紫色边框表示当前视野，可拖动或滚动定位"
                pannable
                zoomable
                maskColor="rgba(49, 57, 82, 0.14)"
                maskStrokeColor="#7560ce"
                maskStrokeWidth={2}
              />
              <Controls position="bottom-left" showInteractive={false} />
            </ReactFlow>
            <div className="canvas-caption">
              <span className="status-dot" />
              可视化剧情画布<span>左键拖动平移 · Shift 拖动框选 · F 适应画布</span>
            </div>
            {selection.length > 1 && (
              <div className="selection-toolbar">
                <span>已选中 {selection.length} 个节点</span>
                <button className="text-button small" disabled={!writable} onClick={duplicate}>
                  <Copy size={13} />
                  复制子图
                </button>
                <button
                  className="icon-button danger"
                  disabled={!writable}
                  title="删除选中节点"
                  onClick={deleteNodes}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </div>
          <div className="workspace-status">
            <button
              onClick={async () => setPanel(panel === 'issues' ? null : 'issues')}
              className={errors.length ? 'has-errors' : ''}
            >
              <CircleCheck size={13} />
              {errors.length ? `${errors.length} 个错误` : '结构检查通过'}
              {warnings.length > 0 && <span>· {warnings.length} 项提醒</span>}
            </button>
            <span>
              {boardNodes.length} 个节点 · {edges.length} 条连线
            </span>
            <span className="status-right">
              版本 {project.revision}
              <span>
                {remoteState
                  ? remoteState.status === 'online'
                    ? '服务端协作'
                    : '未连接服务端'
                  : '仅本机保存'}
              </span>
            </span>
          </div>
          {panel && (
            <section className="bottom-panel">
              <div className="bottom-panel-heading">
                <div className="button-group">
                  <button
                    className={panel === 'issues' ? 'active' : ''}
                    onClick={async () => setPanel('issues')}
                  >
                    剧情检查 <span>{issues.length}</span>
                  </button>
                  <button
                    className={panel === 'history' ? 'active' : ''}
                    onClick={async () => setPanel('history')}
                  >
                    本次操作
                  </button>
                </div>
                <button className="icon-button" title="关闭底部面板" onClick={async () => setPanel(null)}>
                  <X size={15} />
                </button>
              </div>
              <div className="bottom-panel-list">
                {panel === 'issues' ? (
                  issues.length ? (
                    issues.map((issue, i) => (
                      <button
                        className="issue-row"
                        key={i}
                        onClick={async () => issue.nodeId && locate(issue.nodeId)}
                      >
                        <span className={`issue-level ${issue.level}`}>
                          {issue.level === 'error' ? '错误' : '提醒'}
                        </span>
                        <span>{issue.message}</span>
                        {issue.nodeId && <ArrowUpRight size={13} />}
                      </button>
                    ))
                  ) : (
                    <div className="all-clear">
                      <CircleCheck size={24} />
                      <strong>结构检查通过</strong>
                      <span>继续试跑不同选择，检查条件和剧情体验。</span>
                    </div>
                  )
                ) : events.length ? (
                  events.map((e) => (
                    <div className="history-row" key={e.id}>
                      <span>{e.label.startsWith('编辑节点：') ? '编辑节点内容' : e.label}</span>
                      <small>
                        版本 {e.revision} · {new Date(e.time).toLocaleTimeString('zh-CN')}
                      </small>
                    </div>
                  ))
                ) : (
                  <p className="empty-text">当前会话还没有修改记录。需要长期留存时请创建快照。</p>
                )}
              </div>
            </section>
          )}
        </main>
        {selected ? (
          <div className={`inspector-shell ${!writable ? 'readonly-inspector' : ''}`}>
            {remoteState && (
              <div className="lease-banner">
                {remoteState.editing === `nodes:${selected.id}` ? (
                  <>
                    <span>你正在编辑 · 内容与位置已占用</span>
                    <button
                      className="text-button small"
                      disabled={!!remoteState.pending}
                      onClick={() => void remoteClient.edit(null).catch((e) => setToast(e.message))}
                    >
                      结束编辑
                    </button>
                  </>
                ) : (
                  <>
                    <span>
                      {remoteState.locks[`nodes:${selected.id}`]
                        ? `${remoteState.locks[`nodes:${selected.id}`].name} 正在编辑`
                        : '查看模式 · 开始编辑后占用此节点'}
                    </span>
                    <button
                      className="secondary-button small"
                      disabled={!writable || !!remoteState.locks[`nodes:${selected.id}`]}
                      onClick={() => void remoteClient.edit(selected.id).catch((e) => setToast(e.message))}
                    >
                      开始编辑
                    </button>
                  </>
                )}
              </div>
            )}
            <Inspector
              key={selected.id}
              node={selected}
              project={project}
              readOnly={!writable || (!!remoteState && remoteState.editing !== `nodes:${selected.id}`)}
              update={updateNode}
              remove={deleteNodes}
              close={() => setSelection([])}
              run={() => startRun(selected.id)}
            />
          </div>
        ) : (
          <aside className="inspector inspector-empty">
            <div className="inspector-heading">
              <div>
                <span className="eyebrow">场景概览</span>
                <h2>{board.name}</h2>
              </div>
              <MapIcon size={19} />
            </div>
            <div className="scene-preview">
              <div className="scene-preview-lines">
                <span />
                <span />
                <span />
              </div>
              <GitBranch size={38} />
              <span className="preview-label">SCENE MAP</span>
            </div>
            <div className="scene-summary">
              <span className="eyebrow">当前场景</span>
              <h3>每一个选择，都通向新的故事</h3>
              <p>点击画布上的节点，编写剧情、角色对白和分支逻辑。</p>
              <div className="scene-stats">
                <div>
                  <strong>{boardNodes.length}</strong>
                  <span>剧情节点</span>
                </div>
                <div>
                  <strong>{boardNodes.filter((n) => n.type === 'choice').length}</strong>
                  <span>玩家选择</span>
                </div>
                <div>
                  <strong>{boardNodes.filter((n) => n.type === 'end').length}</strong>
                  <span>结局</span>
                </div>
              </div>
              <button className="secondary-button full" onClick={async () => startRun(board.startNodeId)}>
                <CirclePlay size={16} />
                从当前场景试跑
              </button>
              <div className="legend">
                <h4>节点图例</h4>
                {Object.entries(nodeMeta).map(([type, meta]) => (
                  <div key={type}>
                    <span style={{ background: meta.color }} />
                    {meta.label}
                    <small>{meta.description}</small>
                  </div>
                ))}
              </div>
            </div>
            <div className="inspector-empty-footer">
              <Check size={14} />
              {remoteState ? '修改经服务端确认后同步给成员' : '修改会自动保存到本机'}
            </div>
          </aside>
        )}
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button className="icon-button" title="关闭提示" onClick={async () => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {run && <Playtest project={run.project} startId={run.startId} close={() => setRun(null)} />}
      {modal === 'export' && (
        <ModalShell title="导出你的故事" close={() => setModal(null)}>
          <p className="modal-intro">保留创作过程，或将剧情交给游戏开发。</p>
          <button
            className="export-card"
            onClick={async () => {
              try {
                const data = remoteState
                  ? await remoteClient.api(
                      `/projects/${project.id}/export?format=backup&revision=${project.revision}`,
                    )
                  : backup(project);
                download(`${project.name}-创作备份`, data);
                setToast('创作备份已导出。请妥善保存。');
              } catch (e) {
                setToast((e as Error).message);
              }
            }}
          >
            <div className="export-icon violet">
              <Download size={24} />
            </div>
            <div>
              <strong>创作备份</strong>
              <p>完整剧情、坐标、角色和变量。可导入为新项目，保留未完成的草稿。</p>
              <span>JSON · 编辑器备份</span>
            </div>
            <ArrowDownToLine size={18} />
          </button>
          <button className="export-card" onClick={exportRuntime}>
            <div className="export-icon teal">
              <FileJson size={24} />
            </div>
            <div>
              <strong>游戏运行数据</strong>
              <p>去除画布坐标和创作状态，包含稳定标识与运行逻辑。导出前检查错误。</p>
              <span>JSON · 本项目自定义格式</span>
            </div>
            <ArrowDownToLine size={18} />
          </button>
          <div className="info-block">
            {remoteState
              ? '协作项目保存在服务端，头像随项目同步并包含在 JSON 备份中。建议定期下载独立备份。'
              : '数据和头像保存在此浏览器，并包含在 JSON 备份中。建议定期下载独立备份。'}
          </div>
          <button className="text-button" disabled={!writable} onClick={async () => fileRef.current?.click()}>
            <Upload size={15} />
            导入创作备份为新项目
          </button>
        </ModalShell>
      )}
      {modal === 'characters' && (
        <ModalShell title="角色资料" close={() => setModal(null)} wide>
          <p className="modal-intro">
            集中维护角色设定。头像支持 PNG、JPEG、WebP，原图不超过 5 MB，导入时居中裁为 256 ×
            256。改名后对白引用依然有效。
          </p>
          {resourceTarget && (
            <button className="text-button" onClick={() => setResourceTarget(null)}>
              查看全部角色
            </button>
          )}
          {project.characters
            .filter((c) => !resourceTarget || c.id === resourceTarget)
            .map((c) => (
              <div className="character-editor" key={c.id}>
                <div className="avatar-controls">
                  <CharacterAvatar character={c} className="avatar-preview" />
                  <label className={`avatar-upload secondary-button small ${!writable ? 'disabled' : ''}`}>
                    {c.avatar ? '替换头像' : '导入头像'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      aria-label={`${c.name}的头像图片`}
                      disabled={!writable}
                      onChange={async (e) => {
                        const file = e.currentTarget.files?.[0];
                        e.currentTarget.value = '';
                        if (!file) return;
                        const projectId = project.id;
                        try {
                          const avatar = await importAvatar(file);
                          if (libraryRef.current?.activeId !== projectId) {
                            setToast('已切换项目，本次头像导入已取消。');
                            return;
                          }
                          change('导入角色头像', (p) => ({
                            ...p,
                            characters: p.characters.map((old) =>
                              old.id === c.id ? { ...old, avatar } : old,
                            ),
                          }));
                        } catch (error) {
                          setToast((error as Error).message);
                        }
                      }}
                    />
                  </label>
                  {c.avatar && (
                    <button
                      className="text-button small"
                      disabled={!writable}
                      onClick={() =>
                        change('移除角色头像', (p) => ({
                          ...p,
                          characters: p.characters.map((old) => {
                            if (old.id !== c.id) return old;
                            const { avatar, ...rest } = old;
                            return rest;
                          }),
                        }))
                      }
                    >
                      移除头像
                    </button>
                  )}
                </div>
                <div className="character-fields">
                  <input
                    aria-label="角色名称"
                    disabled={!writable}
                    value={c.name}
                    placeholder="角色名称"
                    onChange={(e) =>
                      change(`编辑角色：${c.id}`, (p) => ({
                        ...p,
                        characters: p.characters.map((old) =>
                          old.id === c.id ? { ...c, name: e.target.value } : old,
                        ),
                      }))
                    }
                  />
                  <textarea
                    aria-label="角色简介"
                    disabled={!writable}
                    rows={3}
                    value={c.description}
                    placeholder="性格、背景与动机…"
                    onChange={(e) =>
                      change(`编辑角色：${c.id}`, (p) => ({
                        ...p,
                        characters: p.characters.map((old) =>
                          old.id === c.id ? { ...c, description: e.target.value } : old,
                        ),
                      }))
                    }
                  />
                </div>
                <button
                  className="icon-button danger"
                  disabled={!writable}
                  title="删除角色"
                  onClick={async () => {
                    const references = project.nodes.filter(
                      (n) => n.type === 'story' && n.lines.some((l) => l.speakerId === c.id),
                    );
                    if (references.length) {
                      setToast(`有 ${references.length} 个节点引用此角色。请先将相关对白改为旁白。`);
                      return;
                    }
                    if (await askConfirmation('删除这个角色？'))
                      change('删除角色', (p) => ({
                        ...p,
                        characters: p.characters.filter((old) => old.id !== c.id),
                      }));
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          <button
            className="secondary-button"
            disabled={!writable}
            onClick={async () => {
              const colors: Character['color'][] = ['violet', 'amber', 'teal', 'rose'];
              setResourceTarget(null);
              change('新建角色', (p) => ({
                ...p,
                characters: [
                  ...p.characters,
                  { id: id(), name: '新的角色', description: '', color: colors[p.characters.length % 4] },
                ],
              }));
            }}
          >
            <Plus size={15} />
            新建角色
          </button>
        </ModalShell>
      )}
      {modal === 'variables' && (
        <ModalShell title="项目变量" close={() => setModal(null)} wide>
          <p className="modal-intro">通过变量记录钥匙、好感度或任务进度。默认值用于每次全新试跑。</p>
          {resourceTarget && (
            <button className="text-button" onClick={() => setResourceTarget(null)}>
              查看全部变量
            </button>
          )}
          {project.variables
            .filter((v) => !resourceTarget || v.id === resourceTarget)
            .map((v) => (
              <div className="variable-editor" key={v.id}>
                <div className="variable-fields">
                  <label className="field">
                    显示名称
                    <input
                      disabled={!writable}
                      value={v.name}
                      onChange={(e) =>
                        change(`编辑变量：${v.id}`, (p) => ({
                          ...p,
                          variables: p.variables.map((old) =>
                            old.id === v.id ? { ...v, name: e.target.value } : old,
                          ),
                        }))
                      }
                    />
                  </label>
                  <label className="field">
                    标识 key
                    <input
                      disabled={!writable}
                      value={v.key}
                      onChange={(e) => {
                        const key = e.target.value;
                        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return;
                        if (project.variables.some((old) => old.id !== v.id && old.key === key)) {
                          setToast('变量标识不能重复。');
                          return;
                        }
                        change(`编辑变量：${v.id}`, (p) => ({
                          ...p,
                          variables: p.variables.map((old) => (old.id === v.id ? { ...v, key } : old)),
                        }));
                      }}
                    />
                  </label>
                  <label className="field">
                    类型
                    <select
                      disabled={!writable}
                      value={v.type}
                      onChange={(e) => {
                        if (
                          project.nodes.some((n) =>
                            [...conditionsOf(n), ...effectsOf(n)].some((x) => x.variableId === v.id),
                          )
                        ) {
                          setToast('变量已被逻辑引用，不能直接改变类型。请先解除引用。');
                          return;
                        }
                        const type = e.target.value as Variable['type'];
                        change('修改变量类型', (p) => ({
                          ...p,
                          variables: p.variables.map((old) =>
                            old.id === v.id
                              ? {
                                  ...v,
                                  type,
                                  defaultValue: type === 'boolean' ? false : type === 'number' ? 0 : '',
                                }
                              : old,
                          ),
                        }));
                      }}
                    >
                      <option value="boolean">布尔</option>
                      <option value="number">数值</option>
                      <option value="string">字符串</option>
                    </select>
                  </label>
                  <label className="field">
                    默认值
                    <div className={!writable ? 'readonly-field' : ''}>
                      <ValueInput
                        disabled={!writable}
                        type={v.type}
                        value={v.defaultValue}
                        onChange={(defaultValue) =>
                          change(`编辑变量：${v.id}`, (p) => ({
                            ...p,
                            variables: p.variables.map((old) =>
                              old.id === v.id ? { ...v, defaultValue } : old,
                            ),
                          }))
                        }
                      />
                    </div>
                  </label>
                </div>
                <button
                  className="icon-button danger"
                  disabled={!writable}
                  title="删除变量"
                  onClick={async () => {
                    if (
                      project.nodes.some((n) =>
                        [...conditionsOf(n), ...effectsOf(n)].some((x) => x.variableId === v.id),
                      )
                    ) {
                      setToast('变量仍被条件或效果引用，请先解除引用。');
                      return;
                    }
                    if (await askConfirmation('删除这个变量？'))
                      change('删除变量', (p) => ({
                        ...p,
                        variables: p.variables.filter((old) => old.id !== v.id),
                      }));
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          <button
            className="secondary-button"
            disabled={!writable}
            onClick={async () => {
              setResourceTarget(null);
              change('新建变量', (p) => {
                let count = p.variables.length + 1;
                while (p.variables.some((v) => v.key === `variable_${count}`)) count++;
                return {
                  ...p,
                  variables: [
                    ...p.variables,
                    {
                      id: id(),
                      key: `variable_${count}`,
                      name: '新的变量',
                      type: 'boolean',
                      defaultValue: false,
                    },
                  ],
                };
              });
            }}
          >
            <Plus size={15} />
            新建变量
          </button>
        </ModalShell>
      )}
      {modal === 'collaboration' && (
        <ModalShell title="远程协作" close={() => setModal(null)} wide>
          <Collaboration
            client={remoteClient}
            state={remoteState}
            project={project}
            open={openRemote}
            local={returnLocal}
          />
        </ModalShell>
      )}
      {modal === 'history' && remoteState && (
        <ModalShell title="协作历史与快照" close={() => setModal(null)}>
          <p>协作修改记录已显示在历史面板。快照由服务端保存。</p>
          <button className="primary-button" onClick={() => setModal('collaboration')}>
            管理服务端快照
          </button>
          <button
            className="text-button"
            onClick={() => {
              setModal(null);
              setPanel('history');
            }}
          >
            查看修改记录
          </button>
        </ModalShell>
      )}
      {modal === 'history' && !remoteState && (
        <ModalShell title="历史与本地快照" close={() => setModal(null)} wide>
          <p className="modal-intro">为关键阶段留一份完整记录。快照保存在本机，独立备份请使用导出。</p>
          <button className="primary-button" disabled={!writable} onClick={async () => snapshot()}>
            <Plus size={15} />
            创建命名快照
          </button>
          <div className="snapshots-list">
            {library.snapshots
              .filter((s) => s.project.id === project.id)
              .reverse()
              .map((s) => (
                <div className="snapshot-row" key={s.id}>
                  <History size={19} />
                  <div>
                    <strong>{s.name}</strong>
                    <small>
                      {new Date(s.createdAt).toLocaleString('zh-CN')} · 版本 {s.project.revision}
                    </small>
                  </div>
                  <button
                    className="secondary-button small"
                    disabled={!writable}
                    onClick={async () => {
                      if (
                        !(await askConfirmation(
                          `恢复“${s.name}”？\n当前项目 ${project.nodes.length} 个节点，快照 ${s.project.nodes.length} 个节点。\n恢复前会自动保留当前版本的快照。`,
                        ))
                      )
                        return;
                      const safety = {
                        id: id(),
                        name: '恢复前自动备份',
                        createdAt: new Date().toISOString(),
                        project: structuredClone(project),
                      };
                      persist({
                        ...replaceProject(library, {
                          ...structuredClone(s.project),
                          revision: project.revision + 1,
                        }),
                        snapshots: [...library.snapshots, safety],
                      });
                      switchBoard(s.project.boards[0].id);
                      setUndo([]);
                      setRedo([]);
                      setEvents([]);
                      setModal(null);
                      setToast('已恢复快照，恢复前的内容也已保留。');
                    }}
                  >
                    恢复
                  </button>
                </div>
              ))}
            {!library.snapshots.some((s) => s.project.id === project.id) && (
              <p className="empty-text">还没有快照。在调整重要分支前，先留一个版本。</p>
            )}
          </div>
          <button
            className="text-button"
            onClick={async () => {
              setModal(null);
              setPanel('history');
            }}
          >
            <History size={15} />
            查看当前会话的操作记录
          </button>
        </ModalShell>
      )}
      {modal === 'projects' && (
        <ModalShell title="项目与场景" close={() => setModal(null)} wide>
          <label className="field">
            当前项目名称
            <input
              disabled={!writable}
              value={project.name}
              onChange={(e) => {
                if (e.target.value.trim())
                  change('编辑项目名称', (p) => ({ ...p, name: e.target.value.slice(0, 100) }));
              }}
            />
          </label>
          <div className="field-row">
            <label className="field">
              当前场景名称
              <input
                disabled={!writable}
                value={board.name}
                onChange={(e) =>
                  change('编辑场景名称', (p) => ({
                    ...p,
                    boards: p.boards.map((b) =>
                      b.id === board.id ? { ...b, name: e.target.value.slice(0, 200) } : b,
                    ),
                  }))
                }
              />
            </label>
            <label className="field">
              所属章节
              <select
                disabled={!writable}
                value={board.folderId}
                onChange={(e) =>
                  change('移动场景章节', (p) => ({
                    ...p,
                    boards: p.boards.map((b) => (b.id === board.id ? { ...b, folderId: e.target.value } : b)),
                  }))
                }
              >
                {project.folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            项目正式入口
            <select
              disabled={!writable}
              value={project.entryNodeId ?? ''}
              onChange={(e) => change('修改正式入口', (p) => ({ ...p, entryNodeId: e.target.value }))}
            >
              {project.boards.map((b) => (
                <option key={b.id} value={b.startNodeId}>
                  {b.name} · 起点
                </option>
              ))}
            </select>
          </label>
          <h3 className="modal-section-heading">本机项目</h3>
          <div className="project-list">
            {library.projects.map((p) => (
              <button
                key={p.id}
                className={p.id === project.id ? 'active' : ''}
                disabled={!writable}
                onClick={async () => selectProject(p)}
              >
                <BookOpen size={18} />
                <div>
                  <strong>{p.name}</strong>
                  <small>
                    {p.boards.length} 个场景 · {p.nodes.length} 个节点
                  </small>
                </div>
                {p.id === project.id && <Check size={17} />}
              </button>
            ))}
          </div>
          <div className="button-group spaced">
            <button
              className="secondary-button"
              disabled={!writable}
              onClick={async () => {
                const name = await askText('项目名称', '新的故事');
                if (name?.trim()) selectProject(newProject(name.trim().slice(0, 100)), true);
              }}
            >
              <Plus size={15} />
              空白项目
            </button>
            <button
              className="secondary-button"
              disabled={!writable}
              onClick={async () => selectProject(sampleProject(), true)}
            >
              <LayoutGrid size={15} />
              新建示例
            </button>
            <button
              className="text-button"
              disabled={!writable}
              onClick={async () => fileRef.current?.click()}
            >
              <Upload size={15} />
              导入备份
            </button>
          </div>
          <button
            className="text-button danger small"
            disabled={!writable || project.boards.length < 2}
            onClick={async () => {
              const boardNodeIds = project.nodes.filter((n) => n.boardId === board.id).map((n) => n.id);
              if (boardNodeIds.includes(project.entryNodeId ?? '')) {
                setToast('当前场景是项目正式入口，请先更换入口。');
                return;
              }
              if (
                project.nodes.some(
                  (n) =>
                    n.boardId !== board.id &&
                    n.type === 'jump' &&
                    n.targetNodeId &&
                    boardNodeIds.includes(n.targetNodeId),
                )
              ) {
                setToast('其他场景仍跳转到此处，请先解除跳转引用。');
                return;
              }
              if (!(await askConfirmation(`删除场景“${board.name}”及其全部内容？可以撤销。`))) return;
              const nextBoard = project.boards.find((b) => b.id !== board.id)!;
              change('删除场景', (p) => ({
                ...p,
                boards: p.boards.filter((b) => b.id !== board.id),
                nodes: p.nodes.filter((n) => n.boardId !== board.id),
                edges: p.edges.filter((e) => e.boardId !== board.id),
              }));
              switchBoard(nextBoard.id);
              setModal(null);
            }}
          >
            <Trash2 size={14} />
            删除当前场景
          </button>
        </ModalShell>
      )}
      {modal === 'about' && (
        <ModalShell title="欢迎来到叙事工坊" close={() => setModal(null)}>
          <p className="modal-intro">用节点组织情节，用连线描绘选择，把故事放到画布上。</p>
          <div className="info-block">
            <strong>当前版本：单人创作 Alpha</strong>
            <p>
              支持本地创作和 2–5
              人远程协作。协作模式提供账号、邀请、权限、节点占用、冲突保护与服务端快照，需要部署协作服务。
            </p>
          </div>
          <div className="help-steps">
            <p>
              <strong>01</strong>点击节点，在右侧编辑正文、对白与逻辑。
            </p>
            <p>
              <strong>02</strong>从右侧出口拖向下一节点的左侧入口。
            </p>
            <p>
              <strong>03</strong>双击连线可删除；跨场景用跳转节点。
            </p>
            <p>
              <strong>04</strong>试跑选择分支，观察变量，再导出备份。
            </p>
          </div>
          <div className="shortcut-grid">
            <span>撤销 / 重做</span>
            <kbd>Ctrl+Z / Ctrl+Shift+Z</kbd>
            <span>复制选区</span>
            <kbd>Ctrl+D</kbd>
            <span>适应画布</span>
            <kbd>F</kbd>
            <span>多选</span>
            <kbd>Shift / 框选</kbd>
          </div>
          <p className="field-help">
            当前数据保存在浏览器 IndexedDB 中。重要内容请导出；操作记录与撤销仅保留在当前会话。
          </p>
        </ModalShell>
      )}
    </div>
  );
}
