import { useToastStore } from '../stores/toast.js';

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);

  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
          onClick={() => remove(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
