import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Folder as FolderIcon, GalleryVerticalEnd, FolderInput, Inbox, Loader2, Pencil, Repeat, RotateCcw, Trash2 } from "lucide-react";
import { media, type ListQuery, type Sort } from "../lib/api";
import { bytes, date, duration, isTypingTarget } from "../lib/format";
import { folderLabel, useFolders, useRenameVideo, useRestoreVideos, useTrashVideos, useVideo, useVideoIds } from "../lib/queries";
import { store, playErrorText } from "../lib/playback";
import { viewPath } from "../lib/view";
import { useUI } from "../state/stores";

const posKey = (id: string) => `vv:pos:${id}`;

export function WatchPage() {
  const { id = "" } = useParams();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const { data: v, isError } = useVideo(id);
  const { data: tree } = useFolders();
  const ctx: ListQuery = {
    view: sp.get("from") || (v ? (v.trashed_at ? "trash" : (v.folder_id ?? "unsorted")) : "all"),
    sort: (sp.get("sort") as Sort) || "new",
    q: sp.get("q") ?? "",
  };
  const { data: ids } = useVideoIds(ctx, !!v);
  const idx = ids?.indexOf(id) ?? -1;
  const prevId = idx > 0 ? ids![idx - 1] : null;
  const nextId = idx >= 0 && idx < (ids?.length ?? 0) - 1 ? ids![idx + 1] : null;

  const videoRef = useRef<HTMLVideoElement>(null);
  const [rate, setRate] = useState(() => Number(store.get("vv:rate")) || 1);
  const [autoNext, setAutoNext] = useState(() => store.get("vv:autonext") === "1");
  const [playError, setPlayError] = useState(false);
  const [editing, setEditing] = useState(false);
  const rename = useRenameVideo();
  const trash = useTrashVideos();
  const restore = useRestoreVideos();
  const openMove = useUI((s) => s.openMove);

  const go = (target: string | null) => target && navigate(`/watch/${target}?${sp}`, { replace: true });
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate(viewPath(ctx.view)));

  useEffect(() => setPlayError(false), [id]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
    store.set("vv:rate", String(rate));
  }, [rate, id]);

  // Keyboard shortcuts (native controls keep their own arrow-key seeking when focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[role=dialog]")) return;
      const el = videoRef.current;
      if (!el) return;
      switch (e.key) {
        case " ":
        case "k":
          if (e.target === el) return;
          e.preventDefault();
          if (el.paused) el.play();
          else el.pause();
          break;
        case "ArrowLeft":
          if (e.target !== el) go(prevId);
          break;
        case "ArrowRight":
          if (e.target !== el) go(nextId);
          break;
        case "j":
          el.currentTime = Math.max(0, el.currentTime - 10);
          break;
        case "l":
          el.currentTime = Math.min(el.duration || 0, el.currentTime + 10);
          break;
        case "f":
          if (document.fullscreenElement) document.exitFullscreen();
          else el.requestFullscreen?.();
          break;
        case "m":
          el.muted = !el.muted;
          break;
        case "Escape":
          if (!document.fullscreenElement) back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Swipe left/right on the stage for prev/next (phones).
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    swipe.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    const h = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Ignore gestures that start on the bottom control strip (seek bar).
    if (s.y > h.bottom - 64) return;
    if (Date.now() - s.t < 500 && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) go(dx < 0 ? nextId : prevId);
  };

  if (isError)
    return (
      <div className="grid min-h-dvh place-items-center text-muted">
        <div className="text-center">
          <p>動画が見つかりません</p>
          <Link to="/all" className="mt-3 inline-block text-accent">
            一覧へ戻る
          </Link>
        </div>
      </div>
    );

  return (
    <div className="flex min-h-dvh flex-col bg-black">
      <header className="flex items-center gap-2 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <button className="grid size-10 shrink-0 place-items-center rounded-full hover:bg-white/10" onClick={back} aria-label="戻る">
          <ArrowLeft size={22} />
        </button>
        <p className="min-w-0 flex-1 truncate text-sm text-[#c8cedb]">{v?.title}</p>
        {ids && idx >= 0 && <span className="shrink-0 px-2 text-xs text-muted tabular-nums">{idx + 1} / {ids.length}</span>}
      </header>

      <div className="group relative flex flex-1 items-center justify-center" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {v ? (
          <video
            key={v.id}
            ref={videoRef}
            src={media.play(v)}
            poster={v.media_v ? media.thumb(v.id, v.media_v) : undefined}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="max-h-[calc(100dvh-11rem)] w-full bg-black object-contain lg:max-h-[calc(100dvh-8rem)]"
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              el.playbackRate = rate;
              const saved = Number(store.get(posKey(v.id)));
              if (saved > 5 && saved < el.duration - 5) el.currentTime = saved;
            }}
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              if (Math.floor(t) % 2 === 0) store.set(posKey(v.id), t > 5 ? String(Math.floor(t)) : null);
            }}
            onEnded={() => {
              store.set(posKey(v.id), null);
              if (autoNext) go(nextId);
            }}
            onError={() => setPlayError(true)}
          />
        ) : (
          <Loader2 className="animate-spin text-muted" />
        )}
        {playError && v && (
          <div className="absolute inset-x-4 top-4 rounded-xl bg-black/80 p-4 text-center text-sm">
            {playErrorText(v)}
          </div>
        )}
        {prevId && (
          <button
            onClick={() => go(prevId)}
            className="absolute top-1/2 left-2 hidden size-12 -translate-y-1/2 place-items-center rounded-full bg-black/50 opacity-0 transition group-hover:opacity-100 hover:bg-black/80 sm:grid"
            aria-label="前の動画"
          >
            <ChevronLeft size={28} />
          </button>
        )}
        {nextId && (
          <button
            onClick={() => go(nextId)}
            className="absolute top-1/2 right-2 hidden size-12 -translate-y-1/2 place-items-center rounded-full bg-black/50 opacity-0 transition group-hover:opacity-100 hover:bg-black/80 sm:grid"
            aria-label="次の動画"
          >
            <ChevronRight size={28} />
          </button>
        )}
      </div>

      {v && (
        <section className="safe-bottom mx-auto w-full max-w-5xl px-4 pt-3">
          {editing ? (
            <input
              autoFocus
              defaultValue={v.title}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base outline-none focus:border-accent"
              onBlur={(e) => {
                setEditing(false);
                const t = e.target.value.trim();
                if (t && t !== v.title) rename.mutate({ id: v.id, title: t });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <button className="group/t flex w-full items-start gap-2 text-left" onClick={() => setEditing(true)}>
              <h1 className="min-w-0 flex-1 text-base font-semibold break-all sm:text-lg">{v.title}</h1>
              <Pencil size={15} className="mt-1.5 shrink-0 text-muted opacity-60 group-hover/t:opacity-100" />
            </button>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <Link to={viewPath(v.folder_id ?? "unsorted")} className="flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[#c8cedb] hover:bg-white/10">
              {v.folder_id ? <FolderIcon size={13} className="text-accent" /> : <Inbox size={13} />}
              {folderLabel(tree, v.folder_id)}
            </Link>
            {v.duration_ms > 0 && <span>{duration(v.duration_ms)}</span>}
            {v.width > 0 && <span>{v.width}×{v.height}</span>}
            {v.size_bytes > 0 && <span>{bytes(v.size_bytes)}</span>}
            <span>{date(v.created_at)}</span>
            {v.status === "processing" && (
              <span className="flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" /> 処理中
              </span>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 pb-2">
            {v.trashed_at ? (
              <button className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-sm hover:bg-white/10" onClick={() => restore.mutate({ ids: [v.id] })}>
                <RotateCcw size={16} /> 復元
              </button>
            ) : (
              <>
                <button className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-strong" onClick={() => openMove([v.id])}>
                  <FolderInput size={16} /> 移動
                </button>
                <button
                  className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-sm text-danger hover:bg-white/10"
                  onClick={() => {
                    trash.mutate({ ids: [v.id] });
                    if (nextId) go(nextId);
                    else back();
                  }}
                >
                  <Trash2 size={16} /> ゴミ箱へ
                </button>
              </>
            )}
            <a href={media.original(v.id)} className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-sm hover:bg-white/10">
              <Download size={16} /> ダウンロード
            </a>
            <Link
              to={`/feed?${new URLSearchParams({ from: ctx.view, sort: ctx.sort, q: ctx.q, v: v.id })}`}
              replace
              className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-sm hover:bg-white/10"
            >
              <GalleryVerticalEnd size={16} /> 縦スクロール
            </Link>
            <div className="ml-auto flex items-center gap-2">
              <button
                className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm ${autoNext ? "bg-accent/20 text-accent" : "bg-surface-2 text-muted"}`}
                onClick={() => {
                  setAutoNext(!autoNext);
                  store.set("vv:autonext", autoNext ? "0" : "1");
                }}
                title="終わったら次の動画を再生"
              >
                <Repeat size={16} /> 連続再生
              </button>
              <select value={rate} onChange={(e) => setRate(Number(e.target.value))} className="h-9 rounded-lg bg-surface-2 px-2 text-sm outline-none" aria-label="再生速度">
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                  <option key={r} value={r}>
                    {r}x
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="hidden pb-3 text-[11px] text-muted/70 lg:block">←/→ 前後の動画 · Space 再生/停止 · J/L 10秒戻る/進む · F 全画面 · M ミュート</p>
        </section>
      )}
    </div>
  );
}
