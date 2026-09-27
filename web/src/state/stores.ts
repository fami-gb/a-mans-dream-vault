import { create } from "zustand";

// ---- selection ----

type SelectionState = {
  ids: Set<string>;
  anchor: string | null;
  toggle: (id: string) => void;
  /** Shift-click: select everything between the anchor and id in `order`. */
  range: (order: string[], id: string) => void;
  set: (ids: Iterable<string>, anchor?: string | null) => void;
  clear: () => void;
};

export const useSelection = create<SelectionState>((set, get) => ({
  ids: new Set(),
  anchor: null,
  toggle: (id) => {
    const ids = new Set(get().ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    set({ ids, anchor: id });
  },
  range: (order, id) => {
    const { anchor, ids: cur } = get();
    const a = anchor ? order.indexOf(anchor) : -1;
    const b = order.indexOf(id);
    if (a < 0 || b < 0) return get().toggle(id);
    const ids = new Set(cur);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) ids.add(order[i]);
    set({ ids });
  },
  set: (ids, anchor = null) => set({ ids: new Set(ids), anchor }),
  clear: () => set({ ids: new Set(), anchor: null }),
}));

// ---- toasts ----

export type Toast = {
  id: number;
  message: string;
  kind: "info" | "error";
  action?: { label: string; run: () => void };
};

type ToastState = {
  toasts: Toast[];
  push: (t: Omit<Toast, "id" | "kind"> & { kind?: Toast["kind"] }) => void;
  dismiss: (id: number) => void;
};

let toastSeq = 0;
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-3), { kind: "info", ...t, id }] });
    setTimeout(() => get().dismiss(id), t.action ? 7000 : 4000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (message: string, action?: Toast["action"]) => useToasts.getState().push({ message, action });
export const toastError = (e: unknown) =>
  useToasts.getState().push({ message: e instanceof Error ? e.message : String(e), kind: "error" });

// ---- UI chrome ----

type UIState = {
  drawerOpen: boolean;
  setDrawer: (open: boolean) => void;
  /** Ids waiting for a destination in the folder picker; null = picker closed. */
  moving: string[] | null;
  openMove: (ids: string[]) => void;
  closeMove: () => void;
};

export const useUI = create<UIState>((set) => ({
  drawerOpen: false,
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  moving: null,
  openMove: (ids) => set({ moving: ids }),
  closeMove: () => set({ moving: null }),
}));
