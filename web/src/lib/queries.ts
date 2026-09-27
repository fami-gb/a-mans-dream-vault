import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { api, uuidv7, type Folder, type FolderTree, type ListQuery, type Video, type VideoPage } from "./api";
import { toast, toastError } from "../state/stores";

export const keys = {
  folders: ["folders"] as const,
  videos: (q: ListQuery) => ["videos", q.view, q.sort, q.q] as const,
  ids: (q: ListQuery) => ["ids", q.view, q.sort, q.q] as const,
  video: (id: string) => ["video", id] as const,
  status: ["status"] as const,
};

export const useFolders = () => useQuery({ queryKey: keys.folders, queryFn: api.folders });

export const useVideoList = (q: ListQuery) =>
  useInfiniteQuery({
    queryKey: keys.videos(q),
    queryFn: ({ pageParam }) => api.videos(q, pageParam || undefined),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

export const useVideoIds = (q: ListQuery, enabled = true) =>
  useQuery({ queryKey: keys.ids(q), queryFn: () => api.videoIds(q).then((r) => r.ids), enabled });

export const useVideo = (id: string) => useQuery({ queryKey: keys.video(id), queryFn: () => api.video(id) });

export const useStatus = () =>
  useQuery({
    queryKey: keys.status,
    queryFn: api.status,
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && (d.jobs.queued + d.jobs.running > 0 || d.scanning) ? 5000 : 60000;
    },
  });

// ---------------------------------------------------------------------------
// Optimistic cache editing
// ---------------------------------------------------------------------------

type Lists = InfiniteData<VideoPage, string>;

/** Snapshot every cache entry a mutation may touch; the returned function restores them. */
async function snapshot(qc: QueryClient) {
  const roots = ["videos", "folders", "video", "ids"];
  await Promise.all(roots.map((r) => qc.cancelQueries({ queryKey: [r] })));
  const saved: [QueryKey, unknown][] = roots.flatMap((r) => qc.getQueriesData({ queryKey: [r] }));
  return () => saved.forEach(([k, d]) => qc.setQueryData(k, d));
}

function knownVideos(qc: QueryClient, ids: Set<string>): Map<string, Video> {
  const found = new Map<string, Video>();
  for (const [, data] of qc.getQueriesData<Lists>({ queryKey: ["videos"] }))
    data?.pages.forEach((p) => p.items.forEach((v) => ids.has(v.id) && found.set(v.id, v)));
  for (const id of ids) {
    const v = qc.getQueryData<Video>(keys.video(id));
    if (v && !found.has(id)) found.set(id, v);
  }
  return found;
}

/** Does video v belong in list view `view`? */
function belongs(v: Video, view: string): boolean {
  if (view === "trash") return v.trashed_at != null;
  if (v.trashed_at != null) return false;
  if (view === "all") return true;
  if (view === "unsorted") return v.folder_id == null;
  return v.folder_id === view;
}

/** Apply `change` to the given videos in every cached list and detail entry, adding or
 *  removing them from each list according to where they now belong. */
function rewrite(qc: QueryClient, before: Map<string, Video>, change: (v: Video) => Video) {
  const after = new Map([...before].map(([id, v]) => [id, change(v)]));
  for (const [key, data] of qc.getQueriesData<Lists>({ queryKey: ["videos"] })) {
    if (!data) continue;
    const view = key[1] as string;
    let pages = data.pages.map((p) => ({
      ...p,
      items: p.items.flatMap((v) => {
        const nv = after.get(v.id);
        if (!nv) return [v];
        return belongs(nv, view) ? [nv] : [];
      }),
    }));
    const present = new Set(pages.flatMap((p) => p.items.map((v) => v.id)));
    const incoming = [...after.values()].filter((v) => !present.has(v.id) && belongs(v, view));
    if (incoming.length && pages.length) pages = [{ ...pages[0], items: [...incoming, ...pages[0].items] }, ...pages.slice(1)];
    const delta = pages.reduce((n, p) => n + p.items.length, 0) - data.pages.reduce((n, p) => n + p.items.length, 0);
    pages = pages.map((p) => ({ ...p, total: p.total + delta }));
    qc.setQueryData<Lists>(key, { ...data, pages });
  }
  for (const [id, v] of after) if (qc.getQueryData(keys.video(id))) qc.setQueryData(keys.video(id), v);
  // Folder counters
  qc.setQueryData<FolderTree>(keys.folders, (t) => {
    if (!t) return t;
    const counts = new Map(t.folders.map((f) => [f.id, f.count]));
    let { all, unsorted, trash } = t;
    const bump = (v: Video, d: number) => {
      if (v.trashed_at != null) return void (trash += d);
      all += d;
      if (v.folder_id == null) unsorted += d;
      else counts.set(v.folder_id, (counts.get(v.folder_id) ?? 0) + d);
    };
    for (const [id, v] of before) {
      bump(v, -1);
      bump(after.get(id)!, +1);
    }
    return { all, unsorted, trash, folders: t.folders.map((f) => ({ ...f, count: counts.get(f.id) ?? 0 })) };
  });
  qc.removeQueries({ queryKey: ["ids"] });
}

function settle(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["videos"] });
  qc.invalidateQueries({ queryKey: ["folders"] });
  qc.invalidateQueries({ queryKey: ["ids"] });
}

// ---------------------------------------------------------------------------
// Video mutations
// ---------------------------------------------------------------------------

export function folderLabel(tree: FolderTree | undefined, id: string | null): string {
  if (id == null) return "未分類";
  return tree?.folders.find((f) => f.id === id)?.name ?? "フォルダ";
}

export function useMoveVideos() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: ({ ids, folderId }: { ids: string[]; folderId: string | null; silent?: boolean }) => api.move(ids, folderId),
    onMutate: async ({ ids, folderId, silent }) => {
      const rollback = await snapshot(qc);
      const before = knownVideos(qc, new Set(ids));
      rewrite(qc, before, (v) => ({ ...v, folder_id: folderId }));
      if (!silent) {
        // Undo moves each video back to where it was.
        const origin = new Map<string | null, string[]>();
        before.forEach((v) => origin.set(v.folder_id, [...(origin.get(v.folder_id) ?? []), v.id]));
        const name = folderLabel(qc.getQueryData(keys.folders), folderId);
        toast(`${ids.length}本を「${name}」へ移動しました`, {
          label: "元に戻す",
          run: () => origin.forEach((vids, fid) => m.mutate({ ids: vids, folderId: fid, silent: true })),
        });
      }
      return { rollback };
    },
    onError: (e, _v, ctx) => {
      ctx?.rollback();
      toastError(e);
    },
    onSettled: () => settle(qc),
  });
  return m;
}

export function useTrashVideos() {
  const qc = useQueryClient();
  const restore = useRestoreVideos();
  return useMutation({
    mutationFn: ({ ids }: { ids: string[] }) => api.trash(ids),
    onMutate: async ({ ids }) => {
      const rollback = await snapshot(qc);
      rewrite(qc, knownVideos(qc, new Set(ids)), (v) => ({ ...v, trashed_at: Date.now() }));
      toast(`${ids.length}本をゴミ箱へ移動しました`, { label: "元に戻す", run: () => restore.mutate({ ids, silent: true }) });
      return { rollback };
    },
    onError: (e, _v, ctx) => {
      ctx?.rollback();
      toastError(e);
    },
    onSettled: () => settle(qc),
  });
}

export function useRestoreVideos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids }: { ids: string[]; silent?: boolean }) => api.restore(ids),
    onMutate: async ({ ids, silent }) => {
      const rollback = await snapshot(qc);
      rewrite(qc, knownVideos(qc, new Set(ids)), (v) => ({ ...v, trashed_at: null }));
      if (!silent) toast(`${ids.length}本を元に戻しました`);
      return { rollback };
    },
    onError: (e, _v, ctx) => {
      ctx?.rollback();
      toastError(e);
    },
    onSettled: () => settle(qc),
  });
}

export function usePurgeVideos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids }: { ids: string[] }) => api.purge(ids),
    onMutate: async ({ ids }) => {
      const rollback = await snapshot(qc);
      const set = new Set(ids);
      for (const [key, data] of qc.getQueriesData<Lists>({ queryKey: ["videos"] })) {
        if (!data) continue;
        qc.setQueryData<Lists>(key, {
          ...data,
          pages: data.pages.map((p) => ({ ...p, items: p.items.filter((v) => !set.has(v.id)) })),
        });
      }
      qc.setQueryData<FolderTree>(keys.folders, (t) => t && { ...t, trash: Math.max(0, t.trash - ids.length) });
      return { rollback };
    },
    onSuccess: (r) => toast(`${r.deleted}本を完全に削除しました`),
    onError: (e, _v, ctx) => {
      ctx?.rollback();
      toastError(e);
    },
    onSettled: () => settle(qc),
  });
}

export function useRenameVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.updateVideo(id, title),
    onMutate: async ({ id, title }) => {
      const rollback = await snapshot(qc);
      rewrite(qc, knownVideos(qc, new Set([id])), (v) => ({ ...v, title }));
      return { rollback };
    },
    onError: (e, _v, ctx) => {
      ctx?.rollback();
      toastError(e);
    },
    onSettled: () => settle(qc),
  });
}

// ---------------------------------------------------------------------------
// Folder mutations (client-generated ids make optimistic creation exact)
// ---------------------------------------------------------------------------

function editTree(qc: QueryClient, fn: (t: FolderTree) => FolderTree) {
  qc.setQueryData<FolderTree>(keys.folders, (t) => (t ? fn(t) : t));
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (f: { id: string; name: string; parent_id: string | null }) => api.createFolder(f),
    onMutate: async (f) => {
      const rollback = await snapshot(qc);
      const folder: Folder = { ...f, sort_order: 1e9, created_at: Date.now(), count: 0, cover_id: null, cover_v: 0 };
      editTree(qc, (t) => ({ ...t, folders: [...t.folders, folder] }));
      return { rollback };
    },
    onError: (e, _v, ctx) => {
      ctx?.rollback();
      toastError(e);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.folders }),
  });
}

export const newFolder = (name: string, parent_id: string | null) => ({ id: uuidv7(), name, parent_id });

export function useUpdateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; parent_id?: string | null } }) => api.updateFolder(id, patch),
    onMutate: async ({ id, patch }) => {
      const rollback = await snapshot(qc);
      editTree(qc, (t) => ({ ...t, folders: t.folders.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));
      return { rollback };
    },
    onError: (e, _v, ctx) => {
      ctx?.rollback();
      toastError(e);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.folders }),
  });
}

export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteFolder(id),
    onMutate: async (id) => {
      const rollback = await snapshot(qc);
      editTree(qc, (t) => {
        const f = t.folders.find((x) => x.id === id);
        return {
          ...t,
          unsorted: f?.parent_id == null ? t.unsorted + (f?.count ?? 0) : t.unsorted,
          folders: t.folders
            .filter((x) => x.id !== id)
            .map((x) =>
              x.parent_id === id ? { ...x, parent_id: f?.parent_id ?? null } : x.id === f?.parent_id ? { ...x, count: x.count + f.count } : x,
            ),
        };
      });
      return { rollback };
    },
    onError: (e, _v, ctx) => {
      ctx?.rollback();
      toastError(e);
    },
    onSettled: () => settle(qc),
  });
}

// ---------------------------------------------------------------------------
// Folder tree helpers
// ---------------------------------------------------------------------------

export function childrenOf(tree: FolderTree | undefined, parent: string | null): Folder[] {
  return (tree?.folders ?? [])
    .filter((f) => f.parent_id === parent)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ja"));
}

export function ancestors(tree: FolderTree | undefined, id: string): Folder[] {
  const byId = new Map((tree?.folders ?? []).map((f) => [f.id, f]));
  const out: Folder[] = [];
  for (let f = byId.get(id); f && out.length < 50; f = f.parent_id ? byId.get(f.parent_id) : undefined) out.unshift(f);
  return out;
}

export function descendantIds(tree: FolderTree | undefined, id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of tree?.folders ?? [])
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
  }
  return out;
}
