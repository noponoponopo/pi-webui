// Leave external web URLs and in-page references to the browser.
export function localFileLink(href: string, cwd: string, origin?: string): string | undefined {
  if (!href || href.startsWith('#') || href.startsWith('?') || href.startsWith('//')) return;
  try {
    if (origin && /^https?:/i.test(href)) {
      const url = new URL(href);
      if (url.origin !== origin) return;
      href = `./${url.pathname.slice(1)}${url.search}${url.hash}`;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('file:')) return;
    if (!cwd && !href.startsWith('file:')) return;
    const base = new URL('file:///');
    base.pathname = `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/`;
    const url = new URL(href, base);
    if (url.protocol === 'file:' && !url.host) return url.href;
  } catch { /* Invalid links are not local file links. */ }
}
