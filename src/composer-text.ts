import type { FileEntry } from "../shared/git";

export function fileQuery(text: string, cursor: number) {
  cursor = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)@(?:"([^"\n]*)|([^\s"]*))$/.exec(before);
  if (!match) return;
  const quoted = match[1] !== undefined;
  const path = match[1] ?? match[2];
  const slash = path.lastIndexOf("/");
  const rest = text.slice(cursor);
  const suffix = (quoted ? /^[^"\n]*(?:"|$)/ : /^[^\s"]*/).exec(rest)?.[0] ?? "";
  return {
    start: cursor - path.length - (quoted ? 2 : 1),
    end: cursor + suffix.length,
    directory: slash < 0 ? "" : path.slice(0, slash),
    query: path.slice(slash + 1),
    quoted,
  };
}

export function matchingFiles(entries: FileEntry[], query: string) {
  const lower = query.toLowerCase();
  return entries
    .filter((entry) => !/["\r\n]/.test(entry.path))
    .map((entry) => {
      const name = entry.name.toLowerCase();
      const rank = name === lower ? 0 : name.startsWith(lower) ? 1 : name.includes(lower) ? 2 : 3;
      return { entry, rank };
    })
    .filter(({ rank }) => rank < 3)
    .sort((a, b) =>
      a.rank - b.rank ||
      Number(b.entry.directory) - Number(a.entry.directory) ||
      a.entry.name.localeCompare(b.entry.name),
    )
    .slice(0, 8)
    .map(({ entry }) => entry);
}

export function completeFile(
  text: string,
  token: NonNullable<ReturnType<typeof fileQuery>>,
  entry: FileEntry,
) {
  const path = entry.path + (entry.directory ? "/" : "");
  const quoted = token.quoted || /\s/.test(path);
  const replacement = `@${quoted ? `"${path}"` : path}${entry.directory ? "" : " "}`;
  return {
    text: text.slice(0, token.start) + replacement + text.slice(token.end),
    cursor: token.start + replacement.length - (entry.directory && quoted ? 1 : 0),
  };
}

export function formatAsQuote(text: string) {
  return text.trim().split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
}
