import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { DndContext, DragOverlay, MouseSensor, pointerWithin, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { ChevronRight, CloudUpload, FolderPlus, Loader2, Menu as MenuIcon, MoreHorizontal, Search, Trash2, X } from "lucide-react";
import { api, media, type Sort, type Video } from "../lib/api";
import { ancestors, childrenOf, keys, useFolders, useMoveVideos, usePurgeVideos, useTrashVideos, useVideoList } from "../lib/queries";
import { isTypingTarget } from "../lib/format";
import { addFiles, useUploads } from "../lib/uploader";
import { SORTS, saveSort, useListQuery, viewPath } from "../lib/view";
import { toastError, useSelection, useUI } from "../state/stores";
import { Sidebar, useFolderDialogs } from "../components/Sidebar";
import { FolderCard, UploadCard, VideoCard, type CardClick } from "../components/cards";
import { SelectionBar } from "../components/SelectionBar";
import { ConfirmSheet, Menu } from "../components/ui";
import { useQueryClient } from "@tanstack/react-query";

export function LibraryPage() {
  const query = useListQuery();
  const { view, folderId } = query;
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const { data: tree } = useFolders();
  const list = useVideoList(query);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;
  const order = useMemo(() => items.map((v) => v.id), [items]);

  const selection = useSelection();
  const selecting = selection.ids.size > 0;
  const { drawerOpen, setDrawer } = useUI();
  const move = useMoveVideos();
  const trash = useTrashVideos();
  const purge = usePurgeVideos();
  const dialogs = useFolderDialogs();
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  // Uploads targeting this view show up as placeholder cards until the real card is in
  // the list (not merely until the upload finishes), so nothing ever blinks out.
  // Finished items leave the upload store after a few seconds, which bounds this.
  const uploads = useUploads((s) => s.items);
  const present = useMemo(() => new Set(order), [order]);
  const placeholders = query.q
    ? []
    : uploads.filter(
        (u) => !present.has(u.videoId) && (view === "all" || (view === "unsorted" && u.folderId == null) || u.folderId === view),
      );

  useEffect(() => selection.clear(), [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCardClick: CardClick = useCallback(
    (id, { shift, meta }) => {
      const s = useSelection.getState();
      if (shift && s.anchor) s.range(order, id);
      else if (shift || meta || s.ids.size > 0) s.toggle(id);
      else navigate(`/watch/${id}?${new URLSearchParams({ from: view, sort: query.sort, q: query.q })}`);
    },
    [order, navigate, view, query.sort, query.q],
  );
  const onLongPress = useCallback((id: string) => useSelection.getState().toggle(id), []);

  // Keyboard: Ctrl/⌘+A select all, Esc clear, Delete → trash.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector("[role=dialog]")) return;
      const s = useSelection.getState();
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        api.videoIds(query).then((r) => s.set(r.ids), toastError);
      } else if (e.key === "Escape") s.clear();
      else if ((e.key === "Delete" || e.key === "Backspace") && s.ids.size && view !== "trash") {
        trash.mutate({ ids: [...s.ids] });
        s.clear();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query, view, trash]);

  // Infinite scroll.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && list.hasNextPage && !list.isFetchingNextPage && list.fetchNextPage(), {
      rootMargin: "1200px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [list]);

  // ---- drag & drop into folders (mouse only; touch uses long-press + "移動") ----
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }));
  const [dragging, setDragging] = useState<string[] | null>(null);
  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    const s = useSelection.getState();
    const ids = s.ids.has(id) ? [...s.ids] : [id];
    if (!s.ids.has(id)) s.set([id], id);
    setDragging(ids);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const ids = dragging ?? [];
    setDragging(null);
    const target = (e.over?.data.current as { view?: string } | undefined)?.view ?? null;
    if (!target || !ids.length || target === "all" || target === view) return;
    if (target === "trash") trash.mutate({ ids });
    else move.mutate({ ids, folderId: target === "unsorted" ? null : target });
    selection.clear();
  };
  const dragPreview = dragging && items.find((v) => v.id === dragging[0]);

  // ---- marquee (rubber-band) selection with the mouse on empty space ----
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const onMarqueeDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-card],a,button,input,select,[data-no-marquee]")) return;
    const startX = e.clientX;
    const startY = e.clientY + window.scrollY;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? new Set(useSelection.getState().ids) : new Set<string>();
    let moved = false;
    const cards = [...document.querySelectorAll<HTMLElement>("[data-card]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.card!, l: r.left, r: r.right, t: r.top + window.scrollY, b: r.bottom + window.scrollY };
    });
    const onMove = (ev: PointerEvent) => {
      const x2 = ev.clientX;
      const y2 = ev.clientY + window.scrollY;
      if (!moved && Math.hypot(x2 - startX, y2 - startY) < 5) return;
      moved = true;
      const l = Math.min(startX, x2), r = Math.max(startX, x2), t = Math.min(startY, y2), b = Math.max(startY, y2);
      setRect({ x: l, y: t - window.scrollY, w: r - l, h: b - t });
      const hit = new Set(base);
      for (const c of cards) if (c.l < r && c.r > l && c.t < b && c.b > t) hit.add(c.id);
      useSelection.getState().set(hit, useSelection.getState().anchor);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setRect(null);
      if (!moved && !additive) useSelection.getState().clear();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ---- page-wide file drop ----
  const [fileOver, setFileOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => hasFiles(e) && (depth++, setFileOver(true));
    const leave = (e: DragEvent) => hasFiles(e) && --depth <= 0 && ((depth = 0), setFileOver(false));
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setFileOver(false);
      if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files, folderId);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [folderId]);

  const upload = () => fileInput.current?.click();
  const currentFolder = folderId ? tree?.folders.find((f) => f.id === folderId) : undefined;
  const crumbs = folderId ? ancestors(tree, folderId) : [];
  const subfolders = view === "all" && !query.q ? childrenOf(tree, null) : folderId ? childrenOf(tree, folderId) : [];
  const title = view === "all" ? "すべて" : view === "unsorted" ? "未分類" : view === "trash" ? "ゴミ箱" : (currentFolder?.name ?? "");

  const [searchOpen, setSearchOpen] = useState(!!query.q);
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-line bg-surface/50 lg:block">
          <Sidebar onUpload={upload} />
        </aside>

        {drawerOpen && (
          <div className="fixed inset-0 z-50 bg-black/60 lg:hidden" onClick={() => setDrawer(false)}>
            <div className="animate-sheet h-full w-[82%] max-w-xs bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <Sidebar
                onUpload={() => {
                  setDrawer(false);
                  upload();
                }}
              />
            </div>
          </div>
        )}

        <main className="min-w-0 flex-1 pb-32" onPointerDown={onMarqueeDown}>
          <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/85 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 backdrop-blur sm:px-5" data-no-marquee>
            <div className="flex h-11 items-center gap-2">
              <button className="grid size-10 shrink-0 place-items-center rounded-lg hover:bg-white/10 lg:hidden" onClick={() => setDrawer(true)} aria-label="フォルダ一覧">
                <MenuIcon size={22} />
              </button>
              <div className={`min-w-0 flex-1 ${searchOpen ? "max-sm:hidden" : ""}`}>
                  {crumbs.length > 1 && (
                    <div className="flex items-center gap-1 overflow-x-auto text-xs text-muted no-scrollbar">
                      {crumbs.slice(0, -1).map((c) => (
                        <span key={c.id} className="flex shrink-0 items-center gap-1">
                          <Link to={viewPath(c.id)} className="hover:text-white">
                            {c.name}
                          </Link>
                          <ChevronRight size={12} />
                        </span>
                      ))}
                    </div>
                  )}
                  <h1 className="truncate text-lg font-bold sm:text-xl">
                    {title}
                    <span className="ml-2 text-sm font-normal text-muted tabular-nums">{list.isLoading ? "" : `${total}本`}</span>
                  </h1>
              </div>
              <div className={`flex items-center gap-1 ${searchOpen ? "flex-1 sm:flex-none" : ""}`}>
                {searchOpen ? (
                  <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 sm:w-64">
                    <Search size={16} className="shrink-0 text-muted" />
                    <input
                      autoFocus={!query.q}
                      defaultValue={query.q}
                      placeholder="タイトルで検索"
                      onChange={(e) => setParam("q", e.target.value)}
                      className="min-w-0 flex-1 bg-transparent text-base outline-none sm:text-sm"
                    />
                    <button
                      onClick={() => {
                        setParam("q", "");
                        setSearchOpen(false);
                      }}
                      aria-label="検索を閉じる"
                    >
                      <X size={16} className="text-muted" />
                    </button>
                  </label>
                ) : (
                  <button className="grid size-10 place-items-center rounded-lg hover:bg-white/10" onClick={() => setSearchOpen(true)} aria-label="検索">
                    <Search size={20} />
                  </button>
                )}
                <select
                  value={query.sort}
                  onChange={(e) => {
                    saveSort(e.target.value as Sort);
                    setParam("sort", e.target.value);
                  }}
                  className="h-9 rounded-lg border border-line bg-surface px-2 text-sm outline-none max-sm:w-[6.5rem]"
                  aria-label="並び順"
                >
                  {SORTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {currentFolder && (
                  <Menu
                    items={dialogs.menuItems(currentFolder)}
                    trigger={(t) => (
                      <button className="grid size-10 place-items-center rounded-lg hover:bg-white/10" onClick={t} aria-label="フォルダメニュー">
                        <MoreHorizontal size={20} />
                      </button>
                    )}
                  />
                )}
              </div>
            </div>
          </header>

          <div className="px-3 pt-3 sm:px-5">
            {view === "trash" && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface px-4 py-3 text-sm text-muted" data-no-marquee>
                ゴミ箱の動画は30日後に自動で完全に削除されます。
                {total > 0 && (
                  <button className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-danger hover:bg-danger/10" onClick={() => setConfirmEmpty(true)}>
                    <Trash2 size={16} /> ゴミ箱を空にする
                  </button>
                )}
              </div>
            )}

            {(subfolders.length > 0 || folderId) && (
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {subfolders.map((f) => (
                  <FolderCard key={f.id} f={f} />
                ))}
                {(folderId || view === "all") && (
                  <button
                    onClick={() => dialogs.createIn(folderId)}
                    className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-line p-3 text-sm text-muted hover:border-accent hover:text-white"
                  >
                    <FolderPlus size={17} /> {folderId ? "サブフォルダ" : "フォルダを作成"}
                  </button>
                )}
              </div>
            )}

            {list.isLoading ? (
              <div className="grid place-items-center py-24 text-muted">
                <Loader2 className="animate-spin" />
              </div>
            ) : list.isError ? (
              <div className="py-24 text-center text-muted">
                読み込めませんでした。
                <button className="ml-2 text-accent" onClick={() => qc.invalidateQueries({ queryKey: keys.videos(query) })}>
                  再読み込み
                </button>
              </div>
            ) : items.length === 0 && placeholders.length === 0 ? (
              <EmptyState view={view} q={query.q} onUpload={upload} />
            ) : (
              <div className="grid grid-cols-2 gap-x-2.5 gap-y-4 sm:grid-cols-3 sm:gap-x-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {placeholders.map((u) => (
                  <UploadCard key={u.key} u={u} />
                ))}
                {items.map((v) => (
                  <VideoCard key={v.id} v={v} selected={selection.ids.has(v.id)} selecting={selecting} onClick={onCardClick} onLongPress={onLongPress} />
                ))}
              </div>
            )}
            <div ref={sentinel} className="h-px" />
            {list.isFetchingNextPage && (
              <div className="grid place-items-center py-6 text-muted">
                <Loader2 className="animate-spin" />
              </div>
            )}
          </div>
        </main>
      </div>

      {!selecting && view !== "trash" && (
        <button
          onClick={upload}
          className="safe-bottom fixed right-4 bottom-5 z-30 flex items-center gap-2 rounded-full bg-accent px-5 py-3.5 font-medium text-white shadow-xl shadow-black/40 active:scale-95 lg:hidden"
          style={{ marginBottom: "env(safe-area-inset-bottom)" }}
        >
          <CloudUpload size={20} /> アップロード
        </button>
      )}

      <SelectionBar query={query} />
      {dialogs.element}

      <input
        ref={fileInput}
        type="file"
        accept="video/*,.mkv,.avi,.wmv,.flv,.ts,.mts,.m2ts"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files, folderId);
          e.target.value = "";
        }}
      />

      {rect && <div className="pointer-events-none fixed z-30 border border-accent bg-accent/15" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />}

      {fileOver && (
        <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center bg-accent/15 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-bg/90 px-10 py-8 text-center">
            <CloudUpload size={40} className="mx-auto mb-2 text-accent" />
            <p className="font-semibold">ドロップしてアップロード</p>
            <p className="mt-1 text-sm text-muted">保存先: {folderId ? title : "未分類"}</p>
          </div>
        </div>
      )}

      {confirmEmpty && (
        <ConfirmSheet
          title="ゴミ箱を空にする"
          danger
          confirmLabel="すべて完全に削除"
          message={`ゴミ箱の${total}本をディスクから完全に削除します。この操作は元に戻せません。`}
          onClose={() => setConfirmEmpty(false)}
          onConfirm={() => api.videoIds(query).then((r) => r.ids.length && purge.mutate({ ids: r.ids }), toastError)}
        />
      )}

      <DragOverlay dropAnimation={null}>
        {dragging && dragPreview ? <DragStack v={dragPreview} count={dragging.length} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function DragStack({ v, count }: { v: Video; count: number }) {
  return (
    <div className="relative w-40 cursor-grabbing">
      {count > 1 && <div className="absolute inset-0 translate-x-2 translate-y-2 rotate-3 rounded-xl bg-surface-2 shadow-xl" />}
      <div className="relative aspect-video overflow-hidden rounded-xl bg-surface-2 shadow-2xl ring-2 ring-accent">
        {v.media_v > 0 && <img src={media.thumb(v.id, v.media_v)} alt="" className="size-full object-cover" />}
      </div>
      <span className="absolute -top-2 -right-2 grid min-w-7 place-items-center rounded-full bg-accent px-1.5 py-0.5 text-sm font-bold text-white shadow">{count}</span>
    </div>
  );
}

function EmptyState({ view, q, onUpload }: { view: string; q: string; onUpload: () => void }) {
  if (q) return <p className="py-24 text-center text-muted">「{q}」に一致する動画はありません</p>;
  if (view === "trash") return <p className="py-24 text-center text-muted">ゴミ箱は空です</p>;
  if (view === "unsorted") return <p className="py-24 text-center text-muted">未分類の動画はありません。すべて整理済みです 🎉</p>;
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center text-muted" data-no-marquee>
      <CloudUpload size={40} className="opacity-60" />
      <p>{view === "all" ? "まだ動画がありません" : "このフォルダは空です"}</p>
      <p className="text-sm">動画をここへドラッグするか、アップロードしてください</p>
      <button onClick={onUpload} className="mt-2 rounded-xl bg-accent px-5 py-2.5 font-medium text-white">
        動画を選ぶ
      </button>
    </div>
  );
}
