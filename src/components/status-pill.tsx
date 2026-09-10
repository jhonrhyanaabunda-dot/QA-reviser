const STYLES: Record<string, { label: string; color: string }> = {
  queued: { label: "Queued", color: "var(--low)" },
  running: { label: "Running", color: "var(--medium)" },
  complete: { label: "Complete", color: "var(--good)" },
  failed: { label: "Failed", color: "var(--critical)" },
  canceled: { label: "Canceled", color: "var(--info)" },
};

export function StatusPill({ status }: { status: string }) {
  const style = STYLES[status] ?? { label: status, color: "var(--info)" };
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[0.7rem] font-medium"
      style={{ color: style.color, border: `1px solid ${style.color}` }}
    >
      {style.label}
    </span>
  );
}
