import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { clientId } from "./api";
import { markProcessed } from "./uploader";
import { toast } from "../state/stores";

type ServerEvent = {
  type: "changed" | "video" | "scan";
  scope?: "videos" | "folders" | "all";
  id?: string;
  status?: string;
  origin?: string;
  data?: { added: number; relinked: number; missing: number };
};

/** Subscribes to server-sent events and refreshes whatever changed on another device
 *  or in the background worker. Refetches are batched to at most one per 400ms. */
export function useServerEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const pending = new Set<string>();
    let timer: number | undefined;
    const flush = () => {
      timer = undefined;
      for (const k of pending) qc.invalidateQueries({ queryKey: [k] });
      pending.clear();
    };
    const invalidate = (...roots: string[]) => {
      roots.forEach((r) => pending.add(r));
      timer ??= window.setTimeout(flush, 400);
    };

    let es: EventSource | null = null;
    let wasDown = false;
    const connect = () => {
      es = new EventSource("/api/events");
      es.onopen = () => {
        if (wasDown) invalidate("videos", "folders", "ids", "video", "status");
        wasDown = false;
      };
      es.onerror = () => {
        wasDown = true;
      };
      es.onmessage = (m) => {
        const e: ServerEvent = JSON.parse(m.data);
        if (e.origin && e.origin === clientId) return;
        switch (e.type) {
          case "video":
            if (e.id && e.status) markProcessed(e.id, e.status);
            invalidate("videos", "folders", "video", "status");
            break;
          case "scan":
            if (e.data) toast(`スキャン完了: 追加 ${e.data.added} / 再リンク ${e.data.relinked} / 見つからない ${e.data.missing}`);
            invalidate("status");
            break;
          case "changed":
            if (e.scope === "folders") invalidate("folders");
            else invalidate("videos", "folders", "ids", "video");
        }
      };
    };
    connect();
    return () => {
      es?.close();
      if (timer) clearTimeout(timer);
    };
  }, [qc]);
}
