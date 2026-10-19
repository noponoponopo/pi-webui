import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
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

const remarkPlugins = [remarkGfm];
const components: NonNullable<Parameters<typeof ReactMarkdown>[0]['components']> = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">{children}</a>
  ),
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
    return <CodeBlock text={text} language={language} />;
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
