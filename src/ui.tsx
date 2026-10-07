import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Check, Copy, X } from 'lucide-react';

export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function Modal({
  title,
  children,
  onClose,
  dismissible = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef<{ x: number; y: number } | null>(null);
  const isBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.target === event.currentTarget && (
      event.clientX < rect.left || event.clientX >= rect.right ||
      event.clientY < rect.top || event.clientY >= rect.bottom
    );
  };
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={title}
      onPointerDown={(event) => {
        backdropPress.current = isBackdrop(event)
          ? { x: event.clientX, y: event.clientY }
          : null;
      }}
      onPointerMove={(event) => {
        const press = backdropPress.current;
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4)
          backdropPress.current = null;
      }}
      onPointerCancel={() => { backdropPress.current = null; }}
      onClick={(event) => {
        const close = backdropPress.current && event.detail > 0 && isBackdrop(event);
        backdropPress.current = null;
        if (dismissible && close) onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <IconButton
          label="Close dialog"
          onClick={onClose}
          disabled={!dismissible}
        >
          <X size={18} />
        </IconButton>
      </header>
      {children}
    </dialog>
  );
}

export function Disclosure({
  summary,
  children,
  ...props
}: {
  summary: ReactNode;
  children: () => ReactNode;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details {...props} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && children()}
    </details>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 1800);
      return () => clearTimeout(timer);
    }
  }, [copied]);
  return (
    <IconButton
      label={error || (copied ? 'Copied' : 'Copy')}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setError('');
        } catch {
          setError('Clipboard unavailable');
        }
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </IconButton>
  );
}

export function ErrorNotice({ error }: { error?: string }) {
  return error ? (
    <div role="alert" className="error-notice">
      {error}
    </div>
  ) : null;
}
