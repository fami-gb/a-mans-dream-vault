import { useMemo, useState } from "react";
import { Folder as FolderIcon, FolderPlus, Inbox, Search } from "lucide-react";
import { Sheet } from "./ui";
import { childrenOf, newFolder, useCreateFolder, useFolders, useMoveVideos } from "../lib/queries";
import { useSelection, useUI } from "../state/stores";
import type { Folder } from "../lib/api";

type Props = {
  title: string;
  rootLabel: string; // "未分類" when moving videos, "トップ階層" when moving folders
  exclude?: Set<string>;
  current?: string | null;
  onPick: (folderId: string | null) => void;
  onClose: () => void;
};

/** Destination chooser with search and "create folder here" for one-step filing. */
export function FolderPicker({ title, rootLabel, exclude, current, onPick, onClose }: Props) {
  const { data: tree } = useFolders();
  const create = useCreateFolder();
  const [q, setQ] = useState("");
  const [newName, setNewName] = useState<string | null>(null);

  const rows = useMemo(() => {
    const out: { f: Folder; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const f of childrenOf(tree, parent)) {
        if (exclude?.has(f.id)) continue;
        out.push({ f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    const needle = q.trim().toLowerCase();
    return needle ? out.filter((r) => r.f.name.toLowerCase().includes(needle)).map((r) => ({ ...r, depth: 0 })) : out;
  }, [tree, exclude, q]);

  const createAndPick = () => {
    const name = newName?.trim();
    if (!name) return;
    const f = newFolder(name, null);
    // The folder shows up immediately (optimistic); the move waits for the server
    // to know the folder so it cannot race ahead of the create request.
    create.mutateAsync(f).then(() => onPick(f.id), () => {});
    onClose();
  };

  const Row = ({ id, label, icon, depth = 0, count }: { id: string | null; label: string; icon: React.ReactNode; depth?: number; count?: number }) => (
    <button
      disabled={id === current}
      onClick={() => {
        onPick(id);
        onClose();
      }}
      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/5 disabled:opacity-40"
      style={{ paddingLeft: 16 + depth * 20 }}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && <span className="text-xs text-muted">{count}</span>}
      {id === current && <span className="text-xs text-muted">現在地</span>}
    </button>
  );

  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        newName === null ? (
          <button className="mb-1 flex w-full items-center justify-center gap-2 rounded-lg bg-surface-2 py-2.5 hover:bg-white/10" onClick={() => setNewName("")}>
            <FolderPlus size={18} /> 新しいフォルダを作って移動
          </button>
        ) : (
          <div className="mb-1 flex gap-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && createAndPick()}
              placeholder="フォルダ名"
              className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-base outline-none focus:border-accent"
            />
            <button className="rounded-lg bg-accent px-4 font-medium text-white disabled:opacity-40" disabled={!newName.trim()} onClick={createAndPick}>
              作成して移動
            </button>
          </div>
        )
      }
    >
      {(tree?.folders.length ?? 0) > 8 && (
        <div className="sticky top-0 z-10 bg-surface px-4 pt-3 pb-2">
          <label className="flex items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2">
            <Search size={16} className="text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="フォルダを検索" className="min-w-0 flex-1 bg-transparent text-base outline-none" />
          </label>
        </div>
      )}
      {!q && <Row id={null} label={rootLabel} icon={<Inbox size={18} className="text-muted" />} />}
      {rows.map(({ f, depth }) => (
        <Row key={f.id} id={f.id} label={f.name} depth={depth} count={f.count} icon={<FolderIcon size={18} className="text-accent" />} />
      ))}
      {rows.length === 0 && q && <p className="px-4 py-6 text-center text-sm text-muted">見つかりません</p>}
    </Sheet>
  );
}

/** App-level picker for moving the videos in useUI().moving. */
export function MoveVideosPicker() {
  const { moving, closeMove } = useUI();
  const move = useMoveVideos();
  const clear = useSelection((s) => s.clear);
  if (!moving) return null;
  return (
    <FolderPicker
      title={`${moving.length}本の移動先`}
      rootLabel="未分類"
      onPick={(folderId) => {
        move.mutate({ ids: moving, folderId });
        clear();
      }}
      onClose={closeMove}
    />
  );
}
