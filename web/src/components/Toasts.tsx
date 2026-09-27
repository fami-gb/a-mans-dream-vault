import { useToasts } from "../state/stores";

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`animate-toast pointer-events-auto flex max-w-full items-center gap-3 rounded-xl px-4 py-3 text-sm shadow-2xl ${
            t.kind === "error" ? "bg-danger text-white" : "bg-[#f1f3f8] text-[#111]"
          }`}
        >
          <span className="min-w-0">{t.message}</span>
          {t.action && (
            <button
              className="shrink-0 font-semibold text-accent-strong"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
