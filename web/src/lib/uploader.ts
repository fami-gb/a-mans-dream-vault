import * as tus from "tus-js-client";
import { create } from "zustand";
import { clientId, uuidv7 } from "./api";
import { queryClient } from "./queryClient";
import { toast } from "../state/stores";

export type UploadItem = {
  key: string; // local key
  videoId: string; // becomes the server video id
  name: string;
  size: number;
  folderId: string | null;
  progress: number; // 0..1
  status: "queued" | "uploading" | "processing" | "done" | "error";
  error?: string;
  preview?: string;
};

type UploadState = {
  items: UploadItem[];
  patch: (key: string, p: Partial<UploadItem>) => void;
  clearFinished: () => void;
};

export const useUploads = create<UploadState>((set, get) => ({
  items: [],
  patch: (key, p) => set({ items: get().items.map((i) => (i.key === key ? { ...i, ...p } : i)) }),
  clearFinished: () => set({ items: get().items.filter((i) => i.status !== "done" && i.status !== "processing") }),
}));

const files = new Map<string, File>();
const running = new Map<string, tus.Upload>();
const CONCURRENCY = 2;

export function addFiles(list: FileList | File[], folderId: string | null) {
  const accepted = Array.from(list).filter((f) => f.type.startsWith("video/") || /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpe?g|3gp|ts|mts|m2ts)$/i.test(f.name));
  const skipped = Array.from(list).length - accepted.length;
  if (skipped) toast(`動画以外のファイル ${skipped} 件をスキップしました`);
  if (!accepted.length) return;
  const items: UploadItem[] = accepted.map((f) => {
    const key = uuidv7();
    files.set(key, f);
    return { key, videoId: uuidv7(), name: f.name, size: f.size, folderId, progress: 0, status: "queued" };
  });
  useUploads.setState((s) => ({ items: [...s.items, ...items] }));
  // Previews one at a time so a phone does not decode many videos at once.
  (async () => {
    for (const it of items) {
      const preview = await localPreview(files.get(it.key)!);
      if (preview) useUploads.getState().patch(it.key, { preview });
    }
  })();
  pump();
}

export function retryUpload(key: string) {
  useUploads.getState().patch(key, { status: "queued", error: undefined });
  pump();
}

export function cancelUpload(key: string) {
  running.get(key)?.abort(true);
  running.delete(key);
  files.delete(key);
  useUploads.setState((s) => ({ items: s.items.filter((i) => i.key !== key) }));
  pump();
}

/** Called from the SSE stream when the worker finishes a video. */
export function markProcessed(videoId: string, status: string) {
  const it = useUploads.getState().items.find((i) => i.videoId === videoId);
  if (it) useUploads.getState().patch(it.key, status === "ready" ? { status: "done" } : { status: "error", error: "変換に失敗しました" });
}

function pump() {
  const { items } = useUploads.getState();
  let active = items.filter((i) => i.status === "uploading").length;
  for (const it of items) {
    if (active >= CONCURRENCY) break;
    if (it.status === "queued") {
      active++;
      start(it);
    }
  }
}

async function start(item: UploadItem) {
  const { patch } = useUploads.getState();
  const file = files.get(item.key);
  if (!file) return patch(item.key, { status: "error", error: "ファイルを再選択してください" });
  patch(item.key, { status: "uploading" });

  const upload = new tus.Upload(file, {
    endpoint: "/api/uploads/",
    chunkSize: 50 * 1024 * 1024,
    retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000, 60000, 60000, 60000],
    removeFingerprintOnSuccess: true,
    headers: { "X-Client-Id": clientId },
    metadata: { id: item.videoId, filename: file.name, filetype: file.type, folder_id: item.folderId ?? "" },
    onProgress: (sent, total) => patch(item.key, { progress: total ? sent / total : 0 }),
    onSuccess: () => {
      running.delete(item.key);
      files.delete(item.key);
      patch(item.key, { status: "processing", progress: 1 });
      queryClient.invalidateQueries({ queryKey: ["videos"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      pump();
    },
    onError: (err) => {
      running.delete(item.key);
      const msg = String((err as { originalResponse?: { getBody(): string } }).originalResponse?.getBody?.() || err.message);
      patch(item.key, { status: "error", error: msg.slice(0, 200) });
      pump();
    },
  });
  running.set(item.key, upload);

  // Resume an upload interrupted earlier (closed tab, lost signal) for the same file.
  try {
    const previous = await upload.findPreviousUploads();
    const prev = previous.find((p) => p.metadata?.id);
    if (prev) {
      patch(item.key, { videoId: prev.metadata.id, folderId: prev.metadata.folder_id || null });
      upload.resumeFromPreviousUpload(prev);
    }
  } catch {
    /* storage unavailable: start fresh */
  }
  upload.start();
}

/** Grabs a frame in the browser so the placeholder card is recognisable immediately. */
async function localPreview(file: File): Promise<string | undefined> {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "metadata";
  v.src = url;
  const once = (ev: string) =>
    new Promise<void>((res, rej) => {
      v.addEventListener(ev, () => res(), { once: true });
      v.addEventListener("error", () => rej(new Error("decode")), { once: true });
      setTimeout(() => rej(new Error("timeout")), 8000);
    });
  try {
    await once("loadeddata");
    v.currentTime = Math.min(1, (v.duration || 0) / 10);
    await once("seeked");
    const w = 320;
    const h = Math.round((w * v.videoHeight) / v.videoWidth) || 180;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(v, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.7);
  } catch {
    return undefined;
  } finally {
    v.removeAttribute("src");
    v.load();
    URL.revokeObjectURL(url);
  }
}

// Warn before closing the tab mid-upload (tus can resume, but only if the user reselects the file).
window.addEventListener("beforeunload", (e) => {
  if (useUploads.getState().items.some((i) => i.status === "uploading" || i.status === "queued")) e.preventDefault();
});
