import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { IconButton } from "../components/ui";

export function NoticeToast({ message }: { message: string }) {
  const [dismissed, setDismissed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [dragX, setDragX] = useState(0);
  const dragStart = useRef<number | null>(null);

  useEffect(() => {
    if (dismissed || paused) return;
    const timer = window.setTimeout(() => setDismissed(true), 6000);
    return () => window.clearTimeout(timer);
  }, [dismissed, paused]);

  if (dismissed) return null;
  const opacity = dragX > 0 ? Math.max(0.2, 1 - dragX / 160) : 1;
  return (
    <div
      className="notice-toast"
      role="status"
      style={
        dragX
          ? { transform: `translateX(${dragX}px)`, opacity, transition: "none" }
          : undefined
      }
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onPointerDown={(event) => {
        if ((event.target as Element).closest("button")) return;
        dragStart.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragStart.current === null) return;
        setDragX(Math.max(0, event.clientX - dragStart.current));
      }}
      onPointerUp={(event) => {
        if (dragStart.current === null) return;
        const delta = event.clientX - dragStart.current;
        dragStart.current = null;
        if (delta > 60) setDismissed(true);
        else setDragX(0);
      }}
      onPointerCancel={() => {
        dragStart.current = null;
        setDragX(0);
      }}
    >
      <span className="notice-toast-text">{message}</span>
      <IconButton
        className="icon-button notice-toast-close"
        label="Dismiss notice"
        onClick={() => setDismissed(true)}
      >
        <X size={14} />
      </IconButton>
    </div>
  );
}
