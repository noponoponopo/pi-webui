import { expect, test } from 'bun:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { historyGraph, historyText, historyTree } from '../shared/session-tree';

const assistant = (text: string) => ({
  role: 'assistant' as const, content: [{ type: 'text' as const, text }],
  api: 'openai-completions' as const, provider: 'test', model: 'test',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop' as const, timestamp: Date.now(),
});

test('history preserves branches, hidden junctions, labels and the exact active position', () => {
  const session = SessionManager.inMemory();
  const root = session.appendMessage({ role: 'user', content: 'Start', timestamp: 1 });
  const junction = session.appendCustomEntry('extension');
  const left = session.appendMessage(assistant('First approach'));
  session.appendMessage({ role: 'user', content: [{ type: 'text', text: 'See image' }, { type: 'image', mimeType: 'image/png', data: 'SECRET_IMAGE_DATA' }], timestamp: 2 });
  session.branch(junction);
  const right = session.appendMessage({ role: 'user', content: 'Second approach', timestamp: 3 });
  const answer = session.appendMessage(assistant('Finished'));
  session.appendLabelChange(left, 'Original');
  const leaf = session.getLeafId();
  const tree = historyTree(session.getEntries(), leaf);
  const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
  expect(byId.get(junction)).toMatchObject({ parentId: root, kind: 'checkpoint' });
  expect(byId.get(left)).toMatchObject({ parentId: junction, label: 'Original' });
  expect(byId.get(right)?.parentId).toBe(junction);
  expect(byId.get(leaf!)?.parentId).toBe(answer);
  expect(tree.entries.find((entry) => entry.hasImages)?.preview).toBe('See image');
  expect(JSON.stringify(tree)).not.toContain('SECRET_IMAGE_DATA');
  expect(historyText(session.getEntry(left)!)).toBe('First approach');
  const graph = historyGraph(tree);
  expect(graph.columns).toBeGreaterThan(1);
  expect(graph.rows.filter((row) => row.active).map((row) => row.entry.id))
    .toEqual([leaf!, answer, right, junction, root]);
  expect(graph.rows.some((row) => row.join !== undefined)).toBe(true);
  session.resetLeaf();
  const anotherRoot = session.appendMessage({ role: 'user', content: 'Another root', timestamp: 4 });
  const custom = session.appendCustomMessageEntry('test', 'Extension message', true);
  const otherTree = historyTree(session.getEntries(), custom);
  expect(otherTree.entries.find((entry) => entry.id === anotherRoot)?.parentId).toBeNull();
  expect(otherTree.entries.find((entry) => entry.id === custom)).toMatchObject({ kind: 'custom', parentId: anotherRoot, preview: 'Extension message' });
});
