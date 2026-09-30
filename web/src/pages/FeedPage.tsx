import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Folder as FolderIcon,
  FolderInput,
  Inbox,
  Loader2,
  Maximize2,
  Play,
  Repeat,
  RotateCcw,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { media, type ListQuery, type Sort, type Video } from "../lib/api";
import { duration, isTypingTarget } from "../lib/format";
import { playErrorText, store } from "../lib/playback";
import { folderLabel, useFolders, useRestoreVideos, useTrashVideos, useVideoList } from "../lib/queries";
import { savedSort, viewPath } from "../lib/view";
import { useUI } from "../state/stores";

const MUTED_KEY = "vv:feed-muted";

/** Full-screen, one-video-per-screen feed: swipe/scroll vertically to go through the
 *  same list (view, sort, search) the library shows. `?v=<id>` is the current video. */
export function FeedPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const query: ListQuery = { view: sp.get("from") || "all", sort: (sp.get("sort") as Sort) || savedSort(), q: sp.get("q") ?? "" };
  const list = useVideoList(query);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;
  const { data: tree } = useFolders();

  const scroller = useRef<HTMLDivElement>(null);
  const activeVideo = useRef<HTMLVideoElement>(null);
  // -1 until the start position has been found and scrolled to.
  const [active, setActive] = useState(-1);
  const cur = Math.min(active, items.length - 1);
  const [muted, setMuted] = useState(() => store.get(MUTED_KEY) === "1");
  const [autoNext, setAutoNext] = useState(() => store.get("vv:autonext") === "1");

  // Start at ?v=<id>, loading further pages until it shows up.
  const startId = useRef(sp.get("v"));
  useEffect(() => {
    if (active >= 0 || !list.data) return;
    const i = startId.current ? items.findIndex((v) => v.id === startId.current) : 0;
    if (i < 0 && list.hasNextPage) {
      if (!list.isFetchingNextPage) list.fetchNextPage();
      return;
    }
    const start = Math.max(0, i);
    const el = scroller.current;
    if (el) el.scrollTop = start * el.clientHeight;
    setActive(start);
  }, [active, items, list]);

  // Keep a screen's worth of videos loaded ahead.
  useEffect(() => {
    if (active >= 0 && active >= items.length - 5 && list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
  }, [active, items.length, list]);

  // Mirror the current video into the URL so reload / back returns to it.
  const curId = items[cur]?.id;
  useEffect(() => {
    if (!curId || sp.get("v") === curId) return;
    const n = new URLSearchParams(sp);
    n.set("v", curId);
    setSp(n, { replace: true });
  }, [curId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = scroller.current;
    if (!el || active < 0 || !el.clientHeight) return;
    const i = Math.min(items.length - 1, Math.max(0, Math.round(el.scrollTop / el.clientHeight)));
    if (i !== active) setActive(i);
  };
  const scrollTo = (i: number) => {
    const el = scroller.current;
    if (el && i >= 0 && i < items.length) el.scrollTo({ top: i * el.clientHeight, behavior: "smooth" });
  };
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate(viewPath(query.view)));
  const toggleMute = () => {
    setMuted(!muted);
    store.set(MUTED_KEY, muted ? "0" : "1");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[role=dialog]")) return;
      const el = activeVideo.current;
      switch (e.key) {
        case "ArrowDown":
        case "PageDown":
          e.preventDefault();
          scrollTo(cur + 1);
          break;
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          scrollTo(cur - 1);
          break;
        case " ":
        case "k":
          e.preventDefault();
          if (el) void (el.paused ? el.play().catch(() => {}) : el.pause());
          break;
        case "ArrowLeft":
          if (el) el.currentTime = Math.max(0, el.currentTime - 5);
          break;
        case "ArrowRight":
          if (el) el.currentTime = Math.min(el.duration || 0, el.currentTime + 5);
          break;
        case "m":
          toggleMute();
          break;
        case "Escape":
          back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const title =
    query.view === "all" ? "すべて" : query.view === "unsorted" ? "未分類" : query.view === "trash" ? "ゴミ箱" : folderLabel(tree, query.view);
  const empty = list.isSuccess && items.length === 0;

  return (
    <div className="relative h-dvh overflow-hidden bg-black">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="no-scrollbar h-full snap-y snap-mandatory overflow-y-auto overscroll-contain"
      >
        {items.map((v, i) => (
          <section key={v.id} className="relative h-full snap-start snap-always overflow-hidden">
            {active >= 0 && Math.abs(i - cur) <= 1 ? (
              <Slide
                v={v}
                active={i === cur}
                videoRef={i === cur ? activeVideo : undefined}
                muted={muted}
                loop={!autoNext}
                inTrash={query.view === "trash"}
                folderName={folderLabel(tree, v.folder_id)}
                watchHref={`/watch/${v.id}?${new URLSearchParams({ from: query.view, sort: query.sort, q: query.q })}`}
                onToggleMute={toggleMute}
                onAutoplayBlocked={() => setMuted(true)}
                onEnded={() => scrollTo(i + 1)}
              />
            ) : (
              active >= 0 &&
              Math.abs(i - cur) <= 3 &&
              v.media_v > 0 && <img src={media.thumb(v.id, v.media_v)} alt="" className="size-full object-contain" />
            )}
          </section>
        ))}
      </div>

      {(active < 0 || list.isLoading) && !empty && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-muted">
          <Loader2 className="animate-spin" />
        </div>
      )}
      {empty && (
        <div className="absolute inset-0 grid place-items-center text-center text-muted">
          <div>
            <p>動画がありません</p>
            <button onClick={back} className="mt-3 text-accent">
              戻る
            </button>
          </div>
        </div>
      )}

      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 bg-linear-to-b from-black/60 to-transparent px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-6">
        <button className="pointer-events-auto grid size-10 shrink-0 place-items-center rounded-full hover:bg-white/10" onClick={back} aria-label="戻る">
          <ArrowLeft size={22} />
        </button>
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
        {cur >= 0 && total > 0 && (
          <span className="shrink-0 text-xs text-white/70 tabular-nums">
            {cur + 1} / {total}
          </span>
        )}
        <button
          className={`pointer-events-auto grid size-10 shrink-0 place-items-center rounded-full hover:bg-white/10 ${autoNext ? "text-accent" : "text-white/60"}`}
          onClick={() => {
            setAutoNext(!autoNext);
            store.set("vv:autonext", autoNext ? "0" : "1");
          }}
          title={autoNext ? "連続再生: 終わったら次の動画へ" : "ループ再生: 同じ動画を繰り返す"}
          aria-label="連続再生"
          aria-pressed={autoNext}
        >
          <Repeat size={20} />
        </button>
      </header>

      {/* Mouse users: explicit up/down buttons (wheel and arrow keys also work). */}
      <div className="absolute top-1/2 right-4 hidden -translate-y-1/2 flex-col gap-3 lg:flex">
        <button
          onClick={() => scrollTo(cur - 1)}
          disabled={cur <= 0}
          className="grid size-11 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30"
          aria-label="前の動画"
        >
          <ChevronUp size={24} />
        </button>
        <button
          onClick={() => scrollTo(cur + 1)}
          disabled={cur >= items.length - 1}
          className="grid size-11 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30"
          aria-label="次の動画"
        >
          <ChevronDown size={24} />
        </button>
      </div>
    </div>
  );
}

type SlideProps = {
  v: Video;
  active: boolean;
  videoRef?: RefObject<HTMLVideoElement | null>;
  muted: boolean;
  loop: boolean;
  inTrash: boolean;
  folderName: string;
  watchHref: string;
  onToggleMute: () => void;
  onAutoplayBlocked: () => void;
  onEnded: () => void;
};

/** One screen. The neighbours of the active slide are mounted too (paused) so the
 *  next video is already buffering when you swipe to it. */
function Slide({ v, active, videoRef, muted, loop, inTrash, folderName, watchHref, onToggleMute, onAutoplayBlocked, onEnded }: SlideProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState(false);
  const trash = useTrashVideos();
  const restore = useRestoreVideos();
  const openMove = useUI((s) => s.openMove);

  useEffect(() => {
    if (videoRef) videoRef.current = ref.current;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = muted;
    if (!active) {
      el.pause();
      return;
    }
    el.play().catch((e: DOMException) => {
      // Browsers refuse unmuted autoplay without a prior tap; retry muted.
      if (e.name === "NotAllowedError" && !el.muted) onAutoplayBlocked();
    });
  }, [active, muted]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = () => {
    const el = ref.current;
    if (el) void (el.paused ? el.play().catch(() => {}) : el.pause());
  };

  const railBtn = "flex flex-col items-center gap-1 text-[11px] text-white/90";
  const railIcon = "grid size-11 place-items-center rounded-full bg-black/40 backdrop-blur-sm active:scale-95";

  return (
    <>
      <video
        ref={ref}
        src={media.play(v)}
        poster={v.media_v ? media.thumb(v.id, v.media_v) : undefined}
        playsInline
        loop={loop}
        preload={active ? "auto" : "metadata"}
        className="size-full bg-black object-contain"
        onClick={togglePlay}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onEnded={onEnded}
        onError={() => setError(true)}
      />

      {active && paused && !error && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="grid size-20 place-items-center rounded-full bg-black/40">
            <Play size={40} className="ml-1 fill-white" />
          </div>
        </div>
      )}
      {error && <div className="absolute inset-x-4 top-20 rounded-xl bg-black/80 p-4 text-center text-sm">{playErrorText(v)}</div>}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 via-black/30 to-transparent pt-24 pr-20 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pl-4 lg:pr-24">
        <Link
          to={viewPath(v.folder_id ?? "unsorted")}
          className="pointer-events-auto mb-2 inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs backdrop-blur-sm"
        >
          {v.folder_id ? <FolderIcon size={13} /> : <Inbox size={13} />}
          {folderName}
        </Link>
        <p className="line-clamp-2 text-sm leading-snug font-medium break-all drop-shadow">{v.title}</p>
        {v.duration_ms > 0 && <p className="mt-1 text-xs text-white/70">{duration(v.duration_ms)}</p>}
      </div>

      <div className="absolute right-2 bottom-[calc(2rem+env(safe-area-inset-bottom))] flex flex-col items-center gap-4 lg:right-20">
        <button className={railBtn} onClick={onToggleMute} aria-label={muted ? "ミュート解除" : "ミュート"}>
          <span className={railIcon}>{muted ? <VolumeX size={22} /> : <Volume2 size={22} />}</span>
          {muted ? "消音中" : "音声"}
        </button>
        {inTrash ? (
          <button className={railBtn} onClick={() => restore.mutate({ ids: [v.id] })}>
            <span className={railIcon}>
              <RotateCcw size={22} />
            </span>
            復元
          </button>
        ) : (
          <>
            <button className={railBtn} onClick={() => openMove([v.id])}>
              <span className={railIcon}>
                <FolderInput size={22} />
              </span>
              移動
            </button>
            <button className={railBtn} onClick={() => trash.mutate({ ids: [v.id] })}>
              <span className={railIcon}>
                <Trash2 size={22} />
              </span>
              ゴミ箱
            </button>
          </>
        )}
        <Link to={watchHref} className={railBtn}>
          <span className={railIcon}>
            <Maximize2 size={20} />
          </span>
          詳細
        </Link>
      </div>

      {active && <Progress video={ref} />}
    </>
  );
}

/** Thin seek bar along the bottom edge; drag or tap to seek. */
function Progress({ video }: { video: RefObject<HTMLVideoElement | null> }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = video.current;
      if (el && bar.current && el.duration) bar.current.style.width = `${(el.currentTime / el.duration) * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video]);

  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = video.current;
    if (!el || !el.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    el.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * el.duration;
  };

  return (
    <div
      className="group absolute inset-x-0 bottom-0 flex h-5 cursor-pointer touch-none items-end pb-[env(safe-area-inset-bottom)]"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e);
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && seek(e)}
    >
      <div className="h-1 w-full bg-white/20 transition-[height] group-hover:h-1.5 group-active:h-1.5">
        <div ref={bar} className="h-full w-0 bg-white" />
      </div>
    </div>
  );
}
