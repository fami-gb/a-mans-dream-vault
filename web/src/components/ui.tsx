import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** Bottom sheet on phones, centered dialog on larger screens. */
export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="animate-sheet flex max-h-[85dvh] w-full flex-col rounded-t-2xl bg-surface shadow-2xl sm:max-w-md sm:rounded-2xl" role="dialog" aria-label={title}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button className="rounded-full p-1.5 hover:bg-surface-2" onClick={onClose} aria-label="閉じる">
            <X size={20} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="safe-bottom border-t border-line px-4 pt-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmSheet({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button className="rounded-lg px-4 py-2 hover:bg-surface-2" onClick={onClose}>
            キャンセル
          </button>
          <button
            autoFocus
            className={`rounded-lg px-4 py-2 font-medium ${danger ? "bg-danger text-white" : "bg-accent text-white"}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <div className="px-4 py-4 text-sm text-muted">{message}</div>
    </Sheet>
  );
}

export function PromptSheet({
  title,
  initial = "",
  placeholder,
  confirmLabel = "OK",
  onSubmit,
  onClose,
}: {
  title: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit: (v: string) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const submit = () => {
    if (!v.trim()) return;
    onSubmit(v.trim());
    onClose();
  };
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button className="rounded-lg px-4 py-2 hover:bg-surface-2" onClick={onClose}>
            キャンセル
          </button>
          <button className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-40" disabled={!v.trim()} onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      }
    >
      <div className="p-4">
        <input
          ref={ref}
          value={v}
          placeholder={placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && submit()}
          className="w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-base outline-none focus:border-accent"
        />
      </div>
    </Sheet>
  );
}

export type MenuItem = { label: string; icon?: ReactNode; danger?: boolean; onSelect: () => void };

/** Minimal popover menu anchored to its trigger. */
export function Menu({ trigger, items, align = "right" }: { trigger: (open: () => void) => ReactNode; items: MenuItem[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref} data-no-marquee>
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div className={`absolute top-full z-40 mt-1 min-w-44 overflow-hidden rounded-xl border border-line bg-surface-2 py-1 shadow-xl ${align === "right" ? "right-0" : "left-0"}`}>
          {items.map((it) => (
            <button
              key={it.label}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-white/5 ${it.danger ? "text-danger" : ""}`}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
