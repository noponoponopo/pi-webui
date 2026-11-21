import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './split.css';

type Direction = 'horizontal' | 'vertical';

export function ResizeHandle({ direction, label, getSize, onResize, reverse = false }: {
  direction: Direction;
  reverse?: boolean;
  label: string;
  getSize: () => number;
  onResize: (size: number) => void;
}) {
  const drag = useRef<{ pointer: number; origin: number; size: number } | undefined>(undefined);
  const [active, setActive] = useState(false);
  return (
    <div
      className={`resize-handle ${direction}${active ? ' dragging' : ''}`}
      role="separator"
      aria-label={label}
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointer: event.pointerId,
          origin: direction === 'horizontal' ? event.clientX : event.clientY,
          size: getSize(),
        };
        setActive(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointer !== event.pointerId) return;
        const delta = (direction === 'horizontal' ? event.clientX : event.clientY) - start.origin;
        onResize(start.size + (reverse ? -delta : delta));
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointer === event.pointerId) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => { drag.current = undefined; setActive(false); }}
      onKeyDown={(event) => {
        const negative = direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
        const positive = direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
        if (event.key !== negative && event.key !== positive) return;
        event.preventDefault();
        onResize(getSize() + (event.key === negative ? -10 : 10) * (reverse ? -1 : 1));
      }}
    />
  );
}

export function ResizableSplit({
  first, second, firstHidden = false, secondHidden = false,
  direction = 'horizontal', resizeSecond = false, initialSize,
  minSize, minRemaining, stackAt = 0, label, className = '',
}: {
  first: ReactNode;
  second: ReactNode;
  firstHidden?: boolean;
  secondHidden?: boolean;
  direction?: Direction;
  resizeSecond?: boolean;
  initialSize: number;
  minSize: number;
  minRemaining: number;
  stackAt?: number;
  label: string;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const sized = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  const [size, setSize] = useState(initialSize);
  const [stackSize, setStackSize] = useState(resizeSecond ? 320 : 150);
  useEffect(() => {
    if (!stackAt || !root.current) return;
    const observer = new ResizeObserver(([entry]) => setStacked(entry.contentRect.width < stackAt));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [stackAt]);
  const axis = stacked ? 'vertical' : direction;
  const split = !firstHidden && !secondHidden;
  const minimum = stacked ? (resizeSecond ? 160 : 74) : minSize;
  const remaining = stacked ? (resizeSecond ? 260 : 120) : minRemaining;
  const fraction = minimum / (minimum + remaining);
  return (
    <div
      ref={root}
      className={`resizable-split ${axis} ${resizeSecond ? 'resize-second' : ''} ${split ? 'is-split' : ''} ${className}`}
      style={{
        '--pane-size': `${stacked ? stackSize : size}px`,
        '--pane-min': `${minimum}px`,
        '--pane-remaining': `${remaining}px`,
        '--pane-fraction': `${fraction * 100}%`,
      } as CSSProperties}
    >
      <div className="split-pane" hidden={firstHidden} ref={resizeSecond ? undefined : sized}>{first}</div>
      {split && <ResizeHandle
        direction={axis}
        label={label}
        reverse={resizeSecond}
        getSize={() => axis === 'horizontal' ? sized.current!.clientWidth : sized.current!.clientHeight}
        onResize={(value) => {
          const extent = axis === 'horizontal' ? root.current!.clientWidth : root.current!.clientHeight;
          const next = Math.max(Math.min(minimum, extent * fraction), Math.min(value, extent - Math.min(remaining, extent * (1 - fraction)) - 1));
          (stacked ? setStackSize : setSize)(next);
        }}
      />}
      <div className="split-pane" hidden={secondHidden} ref={resizeSecond ? sized : undefined}>{second}</div>
    </div>
  );
}
