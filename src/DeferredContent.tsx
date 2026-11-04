import { useEffect, useRef, useState } from 'react';

export const isDisplayUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^\/api\/pi\/content\/[a-f0-9]{64}\.(png|jpg|gif|webp|txt|json)$/.test(value);

/** Release decoded image memory when it leaves the viewport, preserving its layout. */
export function DeferredImage({ src }: { src: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState<number>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '400px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="deferred-image" style={{ minHeight: height ?? 120 }}>
    {visible && (failed ? <button onClick={() => setFailed(false)}>Retry image</button> :
      <img className="message-image" src={src} alt="Attached image" loading="lazy"
        onLoad={(event) => setHeight(event.currentTarget.getBoundingClientRect().height)}
        onError={() => setFailed(true)} />)}
  </div>;
}
