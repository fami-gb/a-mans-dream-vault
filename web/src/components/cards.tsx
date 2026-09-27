import { memo, useRef, useState } from "react";
import { Link } from "react-router";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { AlertTriangle, Check, CloudUpload, Folder as FolderIcon, Loader2, RotateCcw, X } from "lucide-react";
import { api, media, SPRITE_FRAMES, type Folder, type Video } from "../lib/api";
import { bytes, date, duration } from "../lib/format";
import { cancelUpload, retryUpload, type UploadItem } from "../lib/uploader";
import { viewPath } from "../lib/view";
import { toastError } from "../state/stores";
import { dropTarget } from "./Sidebar";

export type CardClick = (id: string, mods: { shift: boolean; meta: boolean }) => void;

const LONG_PRESS_MS = 450;

function Checkbox({ checked, onClick }: { checked: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={checked ? "選択解除" : "選択"}
      className={`grid size-6 place-items-center rounded-full border-2 transition ${
        checked ? "border-accent bg-accent text-white" : "border-white/90 bg-black/30 text-transparent hover:bg-black/50"
      }`}
    >
      <Check size={14} strokeWidth={3} />
    </button>
  );
}

/**
 * Thumbnail card.
 * - mouse: hover scrubs through the preview sprite; click opens, Ctrl/⌘ toggles, Shift selects a range; drag moves.
 * - touch: long-press selects, horizontal swipe on the thumbnail scrubs, tap opens (or toggles while selecting).
 */
export const VideoCard = memo(function VideoCard({
  v,
  selected,
  selecting,
  onClick,
  onLongPress,
}: {
  v: Video;
  selected: boolean;
  selecting: boolean;
  onClick: CardClick;
  onLongPress: (id: string) => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: v.id, disabled: v.trashed_at != null });
  const [frame, setFrame] = useState<number | null>(null);
  const [thumbOk, setThumbOk] = useState(true);
  const touch = useRef<{ x: number; y: number; timer?: number; scrubbing: boolean; suppress: boolean }>({ x: 0, y: 0, scrubbing: false, suppress: false });

  const hasMedia = v.media_v > 0;
  const portrait = v.height > v.width;

  const frameAt = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return Math.min(SPRITE_FRAMES - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * SPRITE_FRAMES)));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") return;
    const t = touch.current;
    t.x = e.clientX;
    t.y = e.clientY;
    t.scrubbing = false;
    t.suppress = false;
    t.timer = window.setTimeout(() => {
      t.suppress = true;
      navigator.vibrate?.(12);
      onLongPress(v.id);
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") {
      if (hasMedia) setFrame(frameAt(e.clientX, e.currentTarget));
      return;
    }
    const t = touch.current;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(t.timer);
    if (!t.scrubbing && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      t.scrubbing = true;
      t.suppress = true;
    }
    if (t.scrubbing && hasMedia) setFrame(frameAt(e.clientX, e.currentTarget));
  };
  const endTouch = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    clearTimeout(touch.current.timer);
    if (touch.current.scrubbing) setTimeout(() => setFrame(null), 700);
  };

  const click = (e: React.MouseEvent) => {
    if (touch.current.suppress) {
      touch.current.suppress = false;
      e.preventDefault();
      return;
    }
    onClick(v.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
  };

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      data-card={v.id}
      onClick={click}
      onKeyDown={(e) => e.key === "Enter" && onClick(v.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })}
      onContextMenu={(e) => {
        if (touch.current.suppress) e.preventDefault();
      }}
      className={`card-cv group relative cursor-pointer select-none outline-none [-webkit-touch-callout:none] ${isDragging ? "opacity-30" : ""}`}
    >
      <div
        className={`relative aspect-video overflow-hidden rounded-xl bg-surface-2 transition-transform duration-150 [touch-action:pan-y] ${
          selected ? "scale-[0.92] ring-[3px] ring-accent" : "group-focus-visible:ring-2 group-focus-visible:ring-white/60"
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endTouch}
        onPointerCancel={endTouch}
        onPointerLeave={(e) => e.pointerType === "mouse" && setFrame(null)}
      >
        {hasMedia && thumbOk ? (
          <img
            src={media.thumb(v.id, v.media_v)}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setThumbOk(false)}
            className={`size-full ${portrait ? "object-contain bg-black" : "object-cover"}`}
          />
        ) : (
          <div className="grid size-full place-items-center text-muted">
            {v.status === "processing" ? <Loader2 className="animate-spin" /> : <FolderIcon className="opacity-0" />}
          </div>
        )}
        {frame !== null && (
          <div
            className="absolute inset-0 bg-black bg-no-repeat"
            style={{
              backgroundImage: `url(${media.sprite(v.id, v.media_v)})`,
              backgroundSize: `${SPRITE_FRAMES * 100}% 100%`,
              backgroundPositionX: `${(frame / (SPRITE_FRAMES - 1)) * 100}%`,
            }}
          >
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
              <div className="h-full bg-accent" style={{ width: `${((frame + 1) / SPRITE_FRAMES) * 100}%` }} />
            </div>
          </div>
        )}

        {v.duration_ms > 0 && frame === null && (
          <span className="absolute right-1.5 bottom-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium tabular-nums">{duration(v.duration_ms)}</span>
        )}
        {v.status === "processing" && (
          <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[11px]">
            <Loader2 size={11} className="animate-spin" /> 処理中
          </span>
        )}
        {v.missing && <span className="absolute bottom-1.5 left-1.5 rounded bg-danger px-1.5 py-0.5 text-[11px] text-white">ファイルなし</span>}
        {v.status === "failed" && !v.missing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-2 text-center text-xs" title={v.error}>
            <span className="flex items-center gap-1 text-danger">
              <AlertTriangle size={14} /> 処理に失敗
            </span>
            <button
              className="flex items-center gap-1 rounded-full bg-white/15 px-3 py-1 hover:bg-white/25"
              onClick={(e) => {
                e.stopPropagation();
                api.retry(v.id).catch(toastError);
              }}
            >
              <RotateCcw size={12} /> 再試行
            </button>
          </div>
        )}
        <div className={`absolute top-1.5 left-1.5 transition-opacity ${selecting || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 max-lg:hidden"}`}>
          <Checkbox
            checked={selected}
            onClick={(e) => {
              e.stopPropagation();
              onClick(v.id, { shift: e.shiftKey, meta: true });
            }}
          />
        </div>
      </div>
      <div className="px-0.5 pt-1.5">
        <p className="line-clamp-2 text-[13px] leading-snug break-all sm:text-sm" title={v.title}>
          {v.title}
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          {date(v.created_at)}
          {v.size_bytes > 0 && <span className="max-sm:hidden"> · {bytes(v.size_bytes)}</span>}
        </p>
      </div>
    </div>
  );
});

/** Optimistic card shown the moment a file is chosen, before the server knows about it. */
export function UploadCard({ u }: { u: UploadItem }) {
  const pct = Math.round(u.progress * 100);
  return (
    <div className="card-cv select-none">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-surface-2">
        {u.preview ? <img src={u.preview} alt="" className="size-full object-cover opacity-60" /> : <div className="size-full animate-pulse bg-surface-2" />}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          {u.status === "error" ? (
            <>
              <span className="flex items-center gap-1 rounded bg-black/70 px-2 py-1 text-xs text-danger">
                <AlertTriangle size={13} /> 失敗
              </span>
              <div className="flex gap-2">
                <button className="rounded-full bg-white/20 px-3 py-1 text-xs hover:bg-white/30" onClick={() => retryUpload(u.key)}>
                  再試行
                </button>
                <button className="rounded-full bg-white/10 p-1 hover:bg-white/30" onClick={() => cancelUpload(u.key)} aria-label="取り消し">
                  <X size={14} />
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="relative size-14">
                <svg viewBox="0 0 36 36" className="size-full -rotate-90">
                  <circle cx="18" cy="18" r="15.5" fill="rgba(0,0,0,.55)" stroke="rgba(255,255,255,.2)" strokeWidth="3" />
                  <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeDasharray={`${u.progress * 97.4} 97.4`} strokeLinecap="round" />
                </svg>
                <span className="absolute inset-0 grid place-items-center text-xs font-semibold tabular-nums">
                  {u.status === "queued" ? <CloudUpload size={16} /> : u.status === "processing" ? <Loader2 size={16} className="animate-spin" /> : `${pct}%`}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="px-0.5 pt-1.5">
        <p className="line-clamp-2 text-[13px] leading-snug break-all sm:text-sm">{u.name}</p>
        <p className="mt-0.5 text-[11px] text-muted">{u.status === "queued" ? "待機中" : u.status === "uploading" ? `アップロード中 · ${bytes(u.size)}` : u.status === "processing" ? "処理中" : ""}</p>
      </div>
    </div>
  );
}

/** Subfolder tile with a cover frame; also a drop target. */
export function FolderCard({ f }: { f: Folder }) {
  const { setNodeRef, isOver } = useDroppable(dropTarget(f.id, "card"));
  return (
    <Link
      ref={setNodeRef}
      to={viewPath(f.id)}
      className={`group relative flex items-center gap-3 overflow-hidden rounded-xl border bg-surface p-2 pr-3 transition hover:bg-surface-2 ${
        isOver ? "border-accent bg-accent/20 ring-2 ring-accent" : "border-line"
      }`}
    >
      <div className="relative aspect-video w-20 shrink-0 overflow-hidden rounded-lg bg-surface-2 sm:w-24">
        {f.cover_id ? (
          <img src={media.thumb(f.cover_id, f.cover_v)} alt="" loading="lazy" draggable={false} className="size-full object-cover" />
        ) : (
          <div className="grid size-full place-items-center">
            <FolderIcon className="text-accent/60" />
          </div>
        )}
        <FolderIcon size={16} className="absolute bottom-1 left-1 fill-accent text-accent drop-shadow" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{f.name}</p>
        <p className="text-xs text-muted">{f.count}本</p>
      </div>
    </Link>
  );
}
