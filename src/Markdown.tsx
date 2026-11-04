import { createContext, memo, useContext, useEffect, useRef, useState } from 'react';
import type { Mounted } from 'pele';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import diff from 'highlight.js/lib/languages/diff';
import { CopyButton } from './ui';
import { api } from './api';
import { localFileLink } from '../shared/file-links';

export const MarkdownCwd = createContext('');

function Link({ href = '', children }: { href?: string; children?: React.ReactNode }) {
  const cwd = useContext(MarkdownCwd);
  const file = localFileLink(href, cwd, window.location.origin);
  const [error, setError] = useState('');
  return <>
    <a href={file ?? href} target="_blank" rel="noreferrer" onClick={file ? (event) => {
      event.preventDefault();
      setError('');
      void api('/files/open', { url: file }).catch((error) => setError(error.message));
    } : undefined}>{children}</a>
    {error && <span className="error-notice" role="alert">{error}</span>}
  </>;
}

const urlTransform = (url: string) =>
  localFileLink(url, '') ?? defaultUrlTransform(url);

for (const [name, language] of Object.entries({
  javascript,
  typescript,
  python,
  bash,
  json,
  css,
  xml,
  diff,
}))
  hljs.registerLanguage(name, language);

const CodeBlock = memo(function CodeBlock({ text, language }: { text: string; language: string }) {
  const highlighted = language && hljs.getLanguage(language)
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : undefined;
  return (
    <div className="code-block">
      <header>
        <span>{language || 'text'}</span>
        <CopyButton text={text} />
      </header>
      <pre>
        {highlighted ? (
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{text}</code>
        )}
      </pre>
    </div>
  );
});

const MermaidBlock = memo(function MermaidBlock({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [showSource, setShowSource] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let cancelled = false;
    let diagram: Mounted | undefined;
    setLoadError(false);
    void import('pele').then(({ mount }) => {
      if (cancelled) return;
      diagram = mount(element, text, {
        autoDirection: false,
        onRender: () => {
          element.querySelectorAll('a').forEach((link) => {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noreferrer');
          });
          setShowSource(false);
        },
        onError: () => setShowSource(true),
      });
    }).catch(() => {
      if (!cancelled) {
        setShowSource(true);
        setLoadError(true);
      }
    });
    return () => {
      cancelled = true;
      diagram?.destroy();
      element.replaceChildren();
    };
  }, [text]);

  return (
    <div className="code-block">
      <header>
        <span>mermaid</span>
        <CopyButton text={text} />
      </header>
      <div ref={ref} className="mermaid-diagram" />
      {loadError && <div className="error-notice" role="status">Unable to render diagram</div>}
      {showSource && <pre><code>{text}</code></pre>}
    </div>
  );
});

const remarkPlugins = [remarkGfm];
const components: NonNullable<Parameters<typeof ReactMarkdown>[0]['components']> = {
  a: Link,
  img: ({ alt }) => (
    <span className="muted">[Image: {alt || 'external image'}]</span>
  ),
  pre: ({ node, children }) => {
    const code = node?.children[0];
    if (code?.type !== 'element') return <pre>{children}</pre>;
    const text = code.children
      .map((child) => (child.type === 'text' ? child.value : ''))
      .join('');
    const language = String(code.properties.className || '').replace('language-', '');
    return language.toLowerCase() === 'mermaid'
      ? <MermaidBlock text={text} />
      : <CodeBlock text={text} language={language} />;
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
