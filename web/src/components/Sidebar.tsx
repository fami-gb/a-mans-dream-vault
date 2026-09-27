import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { useDroppable } from "@dnd-kit/core";
import {
  ChevronRight,
  CloudUpload,
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  Inbox,
  LayoutGrid,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api, type Folder } from "../lib/api";
import { childrenOf, descendantIds, newFolder, useCreateFolder, useDeleteFolder, useFolders, useStatus, useUpdateFolder } from "../lib/queries";
import { useListQuery, viewPath } from "../lib/view";
import { toast, toastError, useUI } from "../state/stores";
import { ConfirmSheet, Menu, PromptSheet, type MenuItem } from "./ui";
import { FolderPicker } from "./FolderPicker";

const EXPANDED_KEY = "vv:expanded";
function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** Drop targets carry the view they file into; ids must be unique per element
 *  (the same folder is a target both in the sidebar and as a folder card). */
export const dropTarget = (view: string, where: string) => ({ id: `drop:${where}:${view}`, data: { view } });

function DropRow({ view, children, className }: { view: string; children: ReactNode; className?: string }) {
  const { setNodeRef, isOver, active } = useDroppable(dropTarget(view, "nav"));
  return (
    <div ref={setNodeRef} className={`${className ?? ""} rounded-lg transition ${isOver ? "bg-accent/25 ring-2 ring-accent" : active ? "ring-1 ring-white/10" : ""}`}>
      {children}
    </div>
  );
}

function NavItem({ to, icon, label, count, view }: { to: string; icon: ReactNode; label: string; count?: number; view: string }) {
  const setDrawer = useUI((s) => s.setDrawer);
  return (
    <DropRow view={view}>
      <NavLink
        to={to}
        onClick={() => setDrawer(false)}
        className={({ isActive }) =>
          `flex items-center gap-3 rounded-lg px-3 py-2 text-[15px] ${isActive ? "bg-accent/15 font-medium text-white" : "text-[#c8cedb] hover:bg-white/5"}`
        }
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count != null && <span className="text-xs text-muted tabular-nums">{count}</span>}
      </NavLink>
    </DropRow>
  );
}

type Dialog =
  | { kind: "create"; parent: string | null }
  | { kind: "rename"; folder: Folder }
  | { kind: "delete"; folder: Folder }
  | { kind: "move"; folder: Folder }
  | null;

export function useFolderDialogs() {
  const [dialog, setDialog] = useState<Dialog>(null);
  const { data: tree } = useFolders();
  const create = useCreateFolder();
  const update = useUpdateFolder();
  const remove = useDeleteFolder();
  const navigate = useNavigate();
  const { view } = useListQuery();
  const close = () => setDialog(null);

  const element =
    dialog?.kind === "create" ? (
      <PromptSheet title="新しいフォルダ" placeholder="フォルダ名" confirmLabel="作成" onClose={close} onSubmit={(name) => create.mutate(newFolder(name, dialog.parent))} />
    ) : dialog?.kind === "rename" ? (
      <PromptSheet title="名前を変更" initial={dialog.folder.name} confirmLabel="変更" onClose={close} onSubmit={(name) => update.mutate({ id: dialog.folder.id, patch: { name } })} />
    ) : dialog?.kind === "delete" ? (
      <ConfirmSheet
        title="フォルダを削除"
        danger
        confirmLabel="削除"
        message={<>「{dialog.folder.name}」を削除します。中の動画とサブフォルダは1つ上の階層へ移動します（動画は削除されません）。</>}
        onClose={close}
        onConfirm={() => {
          remove.mutate(dialog.folder.id);
          if (view === dialog.folder.id) navigate(dialog.folder.parent_id ? viewPath(dialog.folder.parent_id) : "/all");
        }}
      />
    ) : dialog?.kind === "move" ? (
      <FolderPicker
        title={`「${dialog.folder.name}」の移動先`}
        rootLabel="トップ階層"
        exclude={descendantIds(tree, dialog.folder.id)}
        current={dialog.folder.parent_id}
        onPick={(parent) => update.mutate({ id: dialog.folder.id, patch: { parent_id: parent } })}
        onClose={close}
      />
    ) : null;

  const menuItems = (f: Folder) => [
    { label: "サブフォルダを作成", icon: <FolderPlus size={16} />, onSelect: () => setDialog({ kind: "create", parent: f.id }) },
    { label: "名前を変更", icon: <Pencil size={16} />, onSelect: () => setDialog({ kind: "rename", folder: f }) },
    { label: "フォルダを移動", icon: <FolderInput size={16} />, onSelect: () => setDialog({ kind: "move", folder: f }) },
    { label: "削除", icon: <Trash2 size={16} />, danger: true, onSelect: () => setDialog({ kind: "delete", folder: f }) },
  ];

  return { element, menuItems, createIn: (parent: string | null) => setDialog({ kind: "create", parent }) };
}

function TreeNode({ folder, depth, expanded, toggle, menuItems }: { folder: Folder; depth: number; expanded: Set<string>; toggle: (id: string) => void; menuItems: (f: Folder) => MenuItem[] }) {
  const { data: tree } = useFolders();
  const kids = childrenOf(tree, folder.id);
  const open = expanded.has(folder.id);
  const setDrawer = useUI((s) => s.setDrawer);
  return (
    <>
      <DropRow view={folder.id} className="group">
        <div className="flex items-center" style={{ paddingLeft: depth * 14 }}>
          <button
            className={`grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-white/10 ${kids.length ? "" : "invisible"}`}
            onClick={() => toggle(folder.id)}
            aria-label={open ? "閉じる" : "開く"}
          >
            <ChevronRight size={14} className={`transition ${open ? "rotate-90" : ""}`} />
          </button>
          <NavLink
            to={viewPath(folder.id)}
            onClick={() => setDrawer(false)}
            className={({ isActive }) =>
              `flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-[15px] ${isActive ? "bg-accent/15 font-medium text-white" : "text-[#c8cedb] hover:bg-white/5"}`
            }
          >
            <FolderIcon size={17} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            <span className="text-xs text-muted tabular-nums group-hover:hidden">{folder.count}</span>
          </NavLink>
          <div className="hidden group-hover:block max-lg:block">
            <Menu
              items={menuItems(folder)}
              trigger={(toggleMenu) => (
                <button className="grid size-7 place-items-center rounded text-muted hover:bg-white/10 hover:text-white" onClick={toggleMenu} aria-label="フォルダメニュー">
                  <MoreHorizontal size={16} />
                </button>
              )}
            />
          </div>
        </div>
      </DropRow>
      {open && kids.map((k) => <TreeNode key={k.id} folder={k} depth={depth + 1} expanded={expanded} toggle={toggle} menuItems={menuItems} />)}
    </>
  );
}

export function Sidebar({ onUpload }: { onUpload: () => void }) {
  const { data: tree } = useFolders();
  const { data: status } = useStatus();
  const [expanded, setExpanded] = useState(loadExpanded);
  const dialogs = useFolderDialogs();
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...n]));
      } catch {
        /* ignore */
      }
      return n;
    });
  const pending = status ? status.jobs.queued + status.jobs.running : 0;

  return (
    <nav className="flex h-full flex-col gap-1 overflow-y-auto p-3 no-scrollbar">
      <div className="flex items-center gap-2 px-2 pt-1 pb-3">
        <img src="/icon.svg" alt="" className="size-7" />
        <span className="text-lg font-bold tracking-tight">VideoVault</span>
      </div>
      <button onClick={onUpload} className="mb-3 flex items-center justify-center gap-2 rounded-xl bg-accent py-2.5 font-medium text-white shadow-lg shadow-accent/20 hover:bg-accent-strong">
        <CloudUpload size={19} /> アップロード
      </button>
      <NavItem to="/all" view="all" icon={<LayoutGrid size={18} className="text-muted" />} label="すべて" count={tree?.all} />
      <NavItem to="/unsorted" view="unsorted" icon={<Inbox size={18} className="text-muted" />} label="未分類" count={tree?.unsorted} />

      <div className="mt-4 mb-1 flex items-center justify-between px-3 text-xs font-medium tracking-wide text-muted">
        フォルダ
        <button className="grid size-6 place-items-center rounded hover:bg-white/10 hover:text-white" onClick={() => dialogs.createIn(null)} aria-label="フォルダを作成">
          <FolderPlus size={15} />
        </button>
      </div>
      {childrenOf(tree, null).map((f) => (
        <TreeNode key={f.id} folder={f} depth={0} expanded={expanded} toggle={toggle} menuItems={dialogs.menuItems} />
      ))}
      {tree && tree.folders.length === 0 && (
        <button className="mx-2 rounded-lg border border-dashed border-line px-3 py-3 text-left text-sm text-muted hover:border-accent hover:text-white" onClick={() => dialogs.createIn(null)}>
          ＋ 最初のフォルダを作成
        </button>
      )}

      <div className="mt-4">
        <NavItem to="/trash" view="trash" icon={<Trash2 size={18} className="text-muted" />} label="ゴミ箱" count={tree?.trash} />
      </div>

      <div className="mt-auto space-y-2 px-2 pt-6 text-xs text-muted">
        {pending > 0 && (
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> 処理中 {pending}件
          </div>
        )}
        {(status?.jobs.failed ?? 0) > 0 && <div className="text-danger">処理失敗 {status!.jobs.failed}件</div>}
        <button
          className="flex items-center gap-2 hover:text-white disabled:opacity-50"
          disabled={status?.scanning}
          onClick={() => api.scan().then(() => toast("ライブラリをスキャンしています…"), toastError)}
        >
          <RefreshCw size={14} className={status?.scanning ? "animate-spin" : ""} /> ライブラリを再スキャン
        </button>
      </div>
      {dialogs.element}
    </nav>
  );
}
