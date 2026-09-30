import type { Video } from "./api";

/** localStorage that never throws (private mode, blocked storage). */
export const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

export function playErrorText(v: Video): string {
  if (v.missing) return "元ファイルが見つかりません。";
  if (v.status === "processing") return "このブラウザで再生できる形式に変換中です。しばらくお待ちください。";
  return "再生できませんでした。";
}
