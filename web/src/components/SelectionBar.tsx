import { useState } from "react";
import { CheckSquare, FolderInput, RotateCcw, Trash2, X } from "lucide-react";
import { api, type ListQuery } from "../lib/api";
import { usePurgeVideos, useRestoreVideos, useTrashVideos } from "../lib/queries";
import { toastError, useSelection, useUI } from "../state/stores";
import { ConfirmSheet } from "./ui";

function Action({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex min-w-14 flex-col items-center gap-0.5 rounded-lg px-2.5 py-1.5 text-[11px] hover:bg-white/10 sm:flex-row sm:gap-1.5 sm:text-sm ${danger ? "text-danger" : ""}`}
    >
      {icon}
      {label}
    </button>
  );
}

export function SelectionBar({ query }: { query: ListQuery }) {
  const { ids, set, clear } = useSelection();
  const openMove = useUI((s) => s.openMove);
  const trash = useTrashVideos();
  const restore = useRestoreVideos();
  const purge = usePurgeVideos();
  const [confirmPurge, setConfirmPurge] = useState(false);
  if (ids.size === 0) return null;
  const list = [...ids];
  const inTrash = query.view === "trash";

  const selectAll = () => api.videoIds(query).then((r) => set(r.ids), toastError);

  return (
    <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 flex justify-center px-2 pt-2 lg:bottom-4" data-no-marquee>
      <div className="animate-sheet flex w-full max-w-2xl items-center gap-1 rounded-2xl border border-line bg-surface-2/95 p-1.5 shadow-2xl backdrop-blur">
        <button className="grid size-10 shrink-0 place-items-center rounded-lg hover:bg-white/10" onClick={clear} aria-label="選択解除">
          <X size={20} />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums">{ids.size}件選択</span>
        <Action icon={<CheckSquare size={18} />} label="全選択" onClick={selectAll} />
        {inTrash ? (
          <>
            <Action
              icon={<RotateCcw size={18} />}
              label="復元"
              onClick={() => {
                restore.mutate({ ids: list });
                clear();
              }}
            />
            <Action icon={<Trash2 size={18} />} label="完全に削除" danger onClick={() => setConfirmPurge(true)} />
          </>
        ) : (
          <>
            <Action icon={<FolderInput size={18} />} label="移動" onClick={() => openMove(list)} />
            <Action
              icon={<Trash2 size={18} />}
              label="ゴミ箱へ"
              danger
              onClick={() => {
                trash.mutate({ ids: list });
                clear();
              }}
            />
          </>
        )}
      </div>
      {confirmPurge && (
        <ConfirmSheet
          title="完全に削除"
          danger
          confirmLabel={`${ids.size}本を削除`}
          message="選択した動画のファイルをディスクから削除します。この操作は元に戻せません。"
          onClose={() => setConfirmPurge(false)}
          onConfirm={() => {
            purge.mutate({ ids: list });
            clear();
          }}
        />
      )}
    </div>
  );
}
