import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "./lib/api";
import { queryClient } from "./lib/queryClient";
import { useServerEvents } from "./lib/events";
import { addFiles } from "./lib/uploader";
import { LibraryPage } from "./pages/LibraryPage";
import { WatchPage } from "./pages/WatchPage";
import { FeedPage } from "./pages/FeedPage";
import { Toasts } from "./components/Toasts";
import { UploadPanel } from "./components/UploadPanel";
import { MoveVideosPicker } from "./components/FolderPicker";

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    api.login(pw).then(onDone, (e: Error) => setErr(e.message));
  };
  return (
    <form onSubmit={submit} className="mx-auto flex min-h-dvh max-w-xs flex-col justify-center gap-3 px-4">
      <img src="/icon.svg" alt="" className="mx-auto mb-2 size-14" />
      <h1 className="text-center text-xl font-bold">VideoVault</h1>
      <input
        type="password"
        autoFocus
        autoComplete="current-password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="パスワード"
        className="rounded-lg border border-line bg-surface px-3 py-2.5 text-base outline-none focus:border-accent"
      />
      {err && <p className="text-sm text-danger">{err}</p>}
      <button className="rounded-lg bg-accent py-2.5 font-medium text-white">ログイン</button>
    </form>
  );
}

/** Picks up files shared from another app via the PWA share target (see public/sw.js). */
async function consumeSharedFiles() {
  if (!new URLSearchParams(location.search).has("share") || !("caches" in window)) return;
  history.replaceState(null, "", location.pathname);
  const cache = await caches.open("vv-share");
  const files: File[] = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    if (!res) continue;
    const blob = await res.blob();
    files.push(new File([blob], decodeURIComponent(res.headers.get("x-name") ?? "shared.mp4"), { type: blob.type, lastModified: Date.now() }));
    await cache.delete(req);
  }
  if (files.length) addFiles(files, null);
}

function Authed() {
  useServerEvents();
  useEffect(() => {
    consumeSharedFiles().catch(() => {});
  }, []);
  return (
    <>
      <Routes>
        <Route path="/" element={<Navigate to="/all" replace />} />
        <Route path="/all" element={<LibraryPage />} />
        <Route path="/unsorted" element={<LibraryPage />} />
        <Route path="/trash" element={<LibraryPage />} />
        <Route path="/f/:folderId" element={<LibraryPage />} />
        <Route path="/watch/:id" element={<WatchPage />} />
        <Route path="/feed" element={<FeedPage />} />
        <Route path="*" element={<Navigate to="/all" replace />} />
      </Routes>
      <UploadPanel />
      <MoveVideosPicker />
    </>
  );
}

function Gate() {
  const auth = useQuery({ queryKey: ["auth"], queryFn: api.auth, staleTime: Infinity });
  useEffect(() => {
    const on = () => queryClient.invalidateQueries({ queryKey: ["auth"] });
    window.addEventListener("vv:unauthorized", on);
    return () => window.removeEventListener("vv:unauthorized", on);
  }, []);
  if (auth.isLoading)
    return (
      <div className="grid min-h-dvh place-items-center text-muted">
        <Loader2 className="animate-spin" />
      </div>
    );
  if (auth.data && !auth.data.ok) return <Login onDone={() => queryClient.invalidateQueries()} />;
  return <Authed />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Gate />
        <Toasts />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
