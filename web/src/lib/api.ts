export type Video = {
  id: string;
  folder_id: string | null;
  title: string;
  duration_ms: number;
  width: number;
  height: number;
  size_bytes: number;
  status: "processing" | "ready" | "failed";
  error: string;
  missing: boolean;
  media_v: number;
  created_at: number;
  trashed_at: number | null;
  ext: string;
};

export type Folder = {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  created_at: number;
  count: number;
  cover_id: string | null;
  cover_v: number;
};

export type FolderTree = { folders: Folder[]; all: number; unsorted: number; trash: number };
export type VideoPage = { items: Video[]; total: number; next_cursor: string | null };
export type Sort = "new" | "old" | "name" | "long" | "short";
/** "all" | "unsorted" | "trash" | folder id */
export type View = string;
export type ListQuery = { view: View; sort: Sort; q: string };

/** UUIDv7 using getRandomValues, which (unlike randomUUID) also works over plain-HTTP LAN. */
export function uuidv7(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const ts = Date.now();
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ts / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Identifies this tab so it can ignore server events caused by its own requests. */
export const clientId = uuidv7();

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "X-Client-Id": clientId, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "サーバーに接続できません");
  }
  if (res.status === 401) window.dispatchEvent(new Event("vv:unauthorized"));
  if (!res.ok) {
    let msg = res.status >= 502 && res.status <= 504 ? "サーバーに接続できません" : `エラー (${res.status})`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

const qs = (o: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== "") as [string, string][]).toString();

export const api = {
  auth: () => req<{ required: boolean; ok: boolean }>("GET", "/api/auth"),
  login: (password: string) => req<void>("POST", "/api/login", { password }),
  status: () => req<{ jobs: { queued: number; running: number; failed: number }; scanning: boolean }>("GET", "/api/status"),
  scan: () => req<{ started: boolean }>("POST", "/api/library/scan"),

  folders: () => req<FolderTree>("GET", "/api/folders"),
  createFolder: (f: { id: string; name: string; parent_id: string | null }) => req<Folder>("POST", "/api/folders", f),
  updateFolder: (id: string, patch: { name?: string; parent_id?: string | null; sort_order?: number }) =>
    req<void>("PATCH", `/api/folders/${id}`, patch),
  deleteFolder: (id: string) => req<void>("DELETE", `/api/folders/${id}`),

  videos: (q: ListQuery, cursor?: string) =>
    req<VideoPage>("GET", `/api/videos?${qs({ view: q.view, sort: q.sort, q: q.q, cursor, limit: 60 })}`),
  videoIds: (q: ListQuery) => req<{ ids: string[] }>("GET", `/api/videos/ids?${qs({ view: q.view, sort: q.sort, q: q.q })}`),
  video: (id: string) => req<Video>("GET", `/api/videos/${id}`),
  updateVideo: (id: string, title: string) => req<void>("PATCH", `/api/videos/${id}`, { title }),
  retry: (id: string) => req<void>("POST", `/api/videos/${id}/retry`),
  move: (ids: string[], folder_id: string | null) => req<{ updated: number }>("POST", "/api/videos/move", { ids, folder_id }),
  trash: (ids: string[]) => req<{ updated: number }>("POST", "/api/videos/trash", { ids }),
  restore: (ids: string[]) => req<{ updated: number }>("POST", "/api/videos/restore", { ids }),
  purge: (ids: string[]) => req<{ deleted: number }>("DELETE", "/api/videos", { ids }),
};

export const media = {
  thumb: (id: string, v: number) => `/media/${id}/thumb?v=${v}`,
  sprite: (id: string, v: number) => `/media/${id}/sprite?v=${v}`,
  play: (v: Video) => `/media/${v.id}/play?v=${v.media_v}-${v.status}`,
  original: (id: string) => `/media/${id}/original`,
};

/** Must match media.SpriteFrames on the server. */
export const SPRITE_FRAMES = 10;
