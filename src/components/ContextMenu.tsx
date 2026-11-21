import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function ContextMenu({ x, y, label, children, onClose }: {
  x: number;
  y: number;
  label: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const menu = ref.current!;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(
      8,
      Math.min(x, innerWidth - bounds.width - 8),
    )}px`;
    menu.style.top = `${Math.max(
      8,
      Math.min(y, innerHeight - bounds.height - 8),
    )}px`;
    (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') || menu).focus();
    const dismiss = (event: Event) => {
      if (!menu.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', onClose, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      ref={ref}
      className="menu context-menu"
      role="menu"
      tabIndex={-1}
      aria-label={label}
      style={{ left: x, top: y }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          onClose();
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const buttons = [
            ...ref.current!.querySelectorAll<HTMLButtonElement>(
              'button:not(:disabled)',
            ),
          ];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[
            (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
              buttons.length
          ]?.focus();
        }
      }}>
      {children}
    </div>
  );
}
