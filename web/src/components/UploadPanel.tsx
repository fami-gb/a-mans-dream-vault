import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, CloudUpload, Loader2, AlertTriangle, X } from "lucide-react";
import { useUploads, cancelUpload, retryUpload } from "../lib/uploader";
import { useSelection } from "../state/stores";

/** Floating progress panel for all uploads (all views, all pages). */
export function UploadPanel() {
  const { items, clearFinished } = useUploads();
  const selecting = useSelection((s) => s.ids.size > 0);
  const [open, setOpen] = useState(true);
  const active = items.filter((i) => i.status === "queued" || i.status === "uploading");
  const allDone = items.length > 0 && items.every((i) => i.status === "done");

  useEffect(() => {
    if (!allDone) return;
    const t = setTimeout(clearFinished, 5000);
    return () => clearTimeout(t);
  }, [allDone, clearFinished]);

  if (!items.length || selecting) return null;
  const sent = active.reduce((n, i) => n + i.progress * i.size, 0);
  const total = active.reduce((n, i) => n + i.size, 0);

  return (
    <div className="fixed right-3 bottom-24 z-30 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl lg:bottom-4">
      <button className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium" onClick={() => setOpen((o) => !o)}>
        {active.length ? <CloudUpload size={17} className="text-accent" /> : <CheckCircle2 size={17} className="text-emerald-400" />}
        <span className="flex-1">{active.length ? `アップロード中 ${active.length}件 · ${total ? Math.round((sent / total) * 100) : 0}%` : "アップロード完了"}</span>
        <ChevronDown size={17} className={`transition ${open ? "" : "rotate-180"}`} />
        {!active.length && (
          <span
            role="button"
            className="rounded p-0.5 hover:bg-white/10"
            onClick={(e) => {
              e.stopPropagation();
              clearFinished();
            }}
          >
            <X size={16} />
          </span>
        )}
      </button>
      {open && (
        <ul className="max-h-60 overflow-y-auto border-t border-line text-sm">
          {items.map((u) => (
            <li key={u.key} className="flex items-center gap-3 px-4 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate">{u.name}</p>
                {u.status === "uploading" && (
                  <div className="mt-1 h-1 overflow-hidden rounded bg-white/10">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${u.progress * 100}%` }} />
                  </div>
                )}
                {u.status === "error" && <p className="truncate text-xs text-danger">{u.error}</p>}
                {u.status === "processing" && <p className="text-xs text-muted">変換・サムネイル作成中</p>}
                {u.status === "queued" && <p className="text-xs text-muted">待機中</p>}
              </div>
              {u.status === "uploading" && <span className="text-xs tabular-nums text-muted">{Math.round(u.progress * 100)}%</span>}
              {u.status === "processing" && <Loader2 size={15} className="animate-spin text-muted" />}
              {u.status === "done" && <CheckCircle2 size={16} className="text-emerald-400" />}
              {u.status === "error" && (
                <button className="text-xs text-accent" onClick={() => retryUpload(u.key)}>
                  <AlertTriangle size={14} className="mr-1 inline" />
                  再試行
                </button>
              )}
              {(u.status === "queued" || u.status === "uploading" || u.status === "error") && (
                <button className="rounded p-0.5 text-muted hover:bg-white/10 hover:text-white" onClick={() => cancelUpload(u.key)} aria-label="取り消し">
                  <X size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
