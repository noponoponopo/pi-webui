import { expect, test } from 'bun:test';
import { localFileLink } from '../shared/file-links';
import { openFile } from '../server/native-files';

test('local artifact links resolve against the session cwd, not the Web UI origin', async () => {
  const cwd = '/Users/nopo/Sandbox';
  const origin = 'http://127.0.0.1:43147';
  expect(localFileLink(`${origin}/live2d-re/automesh/output/kohari-precision/center/index.html`, cwd, origin))
    .toBe('file:///Users/nopo/Sandbox/live2d-re/automesh/output/kohari-precision/center/index.html');
  expect(localFileLink('http://127.0.0.1:3000/index.html', cwd, origin)).toBeUndefined();
  expect(localFileLink('live2d-re/automesh/output/kohari-precision/center/index.html', cwd))
    .toBe('file:///Users/nopo/Sandbox/live2d-re/automesh/output/kohari-precision/center/index.html');
  expect(localFileLink('../output/a%20b.html#preview', `${cwd}/project`))
    .toBe('file:///Users/nopo/Sandbox/output/a%20b.html#preview');
  expect(localFileLink('./index.html', '/tmp/a #b')).toBe('file:///tmp/a%20%23b/index.html');
  expect(localFileLink('/tmp/report.pdf', cwd)).toBe('file:///tmp/report.pdf');
  expect(localFileLink('file:///tmp/report.pdf', '')).toBe('file:///tmp/report.pdf');
  for (const href of ['https://example.com', 'http://localhost:3000', '//example.com', '#section', '?q=1', 'mailto:a@b.com', 'javascript:alert(1)', 'file://remote/report.pdf', '']) {
    expect(localFileLink(href, cwd)).toBeUndefined();
  }
  await expect(openFile('https://example.com')).rejects.toThrow('Expected a local file URL');
  await expect(openFile('file://remote/report.pdf')).rejects.toThrow('Expected a local file URL');
});
