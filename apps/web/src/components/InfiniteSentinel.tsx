import { useEffect, useRef } from "react";

/**
 * A tripwire rendered at the end of a list. When it scrolls into view it calls
 * onVisible() to reveal the next window — the load half of infinite scroll. It
 * arms slightly before the viewport edge (rootMargin) so the next page is fetched
 * just ahead of the user. Renders nothing when disabled (nothing left to load).
 */
export function InfiniteSentinel({
  onVisible,
  disabled = false,
}: {
  onVisible: () => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cbRef = useRef(onVisible);
  cbRef.current = onVisible;

  useEffect(() => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) cbRef.current();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [disabled]);

  if (disabled) return null;
  return <div ref={ref} data-testid="infinite-sentinel" aria-hidden className="h-px w-full" />;
}
