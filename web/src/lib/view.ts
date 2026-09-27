import { useLocation, useParams, useSearchParams } from "react-router";
import type { ListQuery, Sort, View } from "./api";

const SORT_KEY = "vv:sort";

export function savedSort(): Sort {
  try {
    return (localStorage.getItem(SORT_KEY) as Sort) || "new";
  } catch {
    return "new";
  }
}

export function saveSort(s: Sort) {
  try {
    localStorage.setItem(SORT_KEY, s);
  } catch {
    /* ignore */
  }
}

/** The list the user is looking at, derived from the URL. */
export function useListQuery(): ListQuery & { folderId: string | null } {
  const { folderId } = useParams();
  const { pathname } = useLocation();
  const [sp] = useSearchParams();
  let view: View = "all";
  if (folderId) view = folderId;
  else if (pathname.startsWith("/unsorted")) view = "unsorted";
  else if (pathname.startsWith("/trash")) view = "trash";
  return { view, sort: (sp.get("sort") as Sort) || savedSort(), q: sp.get("q") ?? "", folderId: folderId ?? null };
}

export function viewPath(view: View): string {
  return view === "all" || view === "unsorted" || view === "trash" ? `/${view}` : `/f/${view}`;
}

export const SORTS: { value: Sort; label: string }[] = [
  { value: "new", label: "新しい順" },
  { value: "old", label: "古い順" },
  { value: "name", label: "名前順" },
  { value: "long", label: "長い順" },
  { value: "short", label: "短い順" },
];
