import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  FileDirectory,
  GitChangedFile,
  GitCommitResult,
  GitExpectedFile,
  GitFile,
  GitFileSaveResult,
  GitMutationResult,
  GitStatus,
  GitWorktree,
} from "../shared/git";

import { revealPath, trashPath } from './native-files';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_EDIT_BYTES = 1024 * 1024;
const mutationLocks = new Map<string, Promise<void>>();

export class GitFileConflictError extends Error {
  readonly status = 409;

  constructor(
    message = "File changed since it was opened; reload before saving.",
  ) {
    super(message);
    this.name = "GitFileConflictError";
  }
}

export class GitIndexConflictError extends Error {
  readonly status = 409;

  constructor() {
    super("Git index changed since this review; refresh and review again.");
    this.name = "GitIndexConflictError";
  }
}

type GitResult = { stdout: string; exitCode: number };

async function runGit(
  cwd: string,
  args: string[],
  allowedExitCodes: number[] = [],
  timeout = 10_000,
): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
      timeout,
      windowsHide: true,
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const result = error as Error & {
      code?: number;
      stderr?: string;
      stdout?: string;
    };
    if (
      typeof result.code === "number" &&
      allowedExitCodes.includes(result.code)
    )
      return { stdout: result.stdout ?? "", exitCode: result.code };
    throw new Error(
      `git ${args[0]} failed: ${result.stderr?.trim() || result.message}`,
    );
  }
}

async function git(
  cwd: string,
  args: string[],
  allowedExitCodes: number[] = [],
  timeout = 10_000,
): Promise<string> {
  return (await runGit(cwd, args, allowedExitCodes, timeout)).stdout;
}

async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: 10_000,
    windowsHide: true,
  });
  return stdout as Buffer;
}

async function repositoryRoot(cwd: string): Promise<string | null> {
  if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 4096)
    throw new Error("Invalid Git working directory");
  try {
    const top = await git(resolve(cwd), ["rev-parse", "--show-toplevel"]);
    return await realpath(top.trim());
  } catch (error) {
    if (
      (error as Error).message.includes("spawn git ENOENT") ||
      (error as Error).message.includes("not a git repository") ||
      (error as Error).message.includes("must be run in a work tree")
    )
      return null;
    throw error;
  }
}

async function currentBranch(root: string): Promise<string | null> {
  return (
    (await git(root, ["symbolic-ref", "--quiet", "HEAD"], [1]))
      .trim()
      .replace(/^refs\/heads\//, "") || null
  );
}

async function indexVersion(
  root: string,
  branch?: string | null,
): Promise<string> {
  const [entries, head, current] = await Promise.all([
    gitBytes(root, ["ls-files", "--stage", "-z"]),
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], [1]),
    branch === undefined ? currentBranch(root) : Promise.resolve(branch),
  ]);
  return createHash("sha256")
    .update(head.trim())
    .update("\0")
    .update(current ?? "")
    .update("\0")
    .update(entries)
    .digest("hex");
}

function parseStatus(output: string): GitChangedFile[] {
  const records = output.split("\0");
  const files: GitChangedFile[] = [];
  for (let index = 0; index < records.length; index++) {
    const entry = records[index]!;
    if (!entry) continue;
    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    if (entry.length < 4 || entry[2] !== " " || !indexStatus || !worktreeStatus)
      throw new Error("Could not parse Git status");
    const path = entry.slice(3);
    let originalPath: string | undefined;
    if (
      [indexStatus, worktreeStatus].some(
        (status) => status === "R" || status === "C",
      )
    ) {
      originalPath = records[++index];
      if (!originalPath) throw new Error("Could not parse Git rename status");
    }
    files.push({
      path,
      ...(originalPath ? { originalPath } : {}),
      indexStatus,
      worktreeStatus,
      untracked: indexStatus === "?" && worktreeStatus === "?",
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function parseWorktrees(
  output: string,
  root: string,
): Promise<GitWorktree[]> {
  const worktrees: GitWorktree[] = [];
  let path = "";
  let branch: string | null = null;
  const finish = async () => {
    if (!path) return;
    try {
      const canonicalPath = await realpath(path);
      worktrees.push({ path, branch, current: canonicalPath === root });
    } catch {
      // Ignore stale prunable worktree entries.
    }
    path = "";
    branch = null;
  };
  for (const record of output.split("\0")) {
    if (!record) {
      await finish();
    } else if (record.startsWith("worktree ")) {
      await finish();
      path = record.slice("worktree ".length);
    } else if (record.startsWith("branch refs/heads/")) {
      branch = record.slice("branch refs/heads/".length);
    }
  }
  await finish();
  return worktrees;
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  const root = await repositoryRoot(cwd);
  if (!root)
    return {
      isRepo: false,
      root: null,
      branch: null,
      branches: [],
      worktrees: [],
      files: [],
      indexVersion: null,
    };
  const [branchOutput, statusOutput, worktreeOutput, branchesOutput] =
    await Promise.all([
      currentBranch(root),
      git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(root, ["worktree", "list", "--porcelain", "-z"]),
      git(root, [
        "for-each-ref",
        "--format=%(refname:lstrip=2)",
        "refs/heads/",
      ]),
    ]);
  return {
    isRepo: true,
    root,
    branch: branchOutput,
    branches: [
      ...new Set([
        ...(branchOutput ? [branchOutput] : []),
        ...branchesOutput.trim().split("\n").filter(Boolean),
      ]),
    ].sort(),
    worktrees: await parseWorktrees(worktreeOutput, root),
    files: parseStatus(statusOutput),
    indexVersion: await indexVersion(root, branchOutput),
  };
}

export async function listFiles(
  cwd: string,
  path = "",
): Promise<FileDirectory> {
  const root = await realpath(cwd);
  const relativePath = path ? worktreePath(root, path) : "";
  const target = resolve(root, relativePath);
  assertInside(root, await realpath(target));
  const entries = (await readdir(target, { withFileTypes: true }))
    .filter((entry) => entry.name !== ".git")
    .map((entry) => ({
      name: entry.name,
      path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
      directory: entry.isDirectory(),
    }))
    .sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name),
    );
  return { root, path: relativePath, entries };
}

export async function revealWorkspacePath(cwd: string, path: string): Promise<void> {
  const root = (await repositoryRoot(cwd)) ?? await realpath(cwd);
  const target = resolve(root, worktreePath(root, path));
  await assertParentInside(root, target);
  await lstat(target);
  await revealPath(target);
}

export async function trashWorkspacePath(cwd: string, path: string): Promise<void> {
  const root = (await repositoryRoot(cwd)) ?? await realpath(cwd);
  await withRepositoryLock(root, async () => {
    const target = resolve(root, worktreePath(root, path));
    await assertParentInside(root, target);
    const stat = await lstat(target);
    await trashPath(target, stat.isDirectory());
  });
}

function worktreePath(root: string, path: string): string {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes(".git")
  )
    throw new Error("Invalid repository-relative path");
  const target = resolve(root, path);
  const resolvedPath = relative(root, target);
  if (
    !resolvedPath ||
    resolvedPath === ".." ||
    resolvedPath.startsWith(`..${sep}`) ||
    isAbsolute(resolvedPath)
  )
    throw new Error("Path must stay inside the Git working tree");
  return resolvedPath.split(sep).join("/");
}

function assertInside(root: string, candidate: string) {
  const path = relative(root, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error("Path resolves outside the Git working tree");
}

async function assertParentInside(root: string, target: string) {
  let parent = dirname(target);
  while (parent !== dirname(parent)) {
    try {
      assertInside(root, await realpath(parent));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      parent = dirname(parent);
    }
  }
  throw new Error("Invalid repository path");
}

type Snapshot = {
  exists: boolean;
  editable: boolean;
  content: string | null;
  version: string | null;
  worktreeVersion: string;
  lineEnding: "lf" | "crlf" | null;
  signature: string;
  mode: number | null;
};

function signature(stat: Awaited<ReturnType<typeof lstat>>) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function regularFileVersion(mode: number, bytes: Buffer) {
  return sha256(
    Buffer.concat([Buffer.from(`file\0${mode & 0o7777}\0`), bytes]),
  );
}

async function currentFile(root: string, path: string): Promise<Snapshot> {
  const target = resolve(root, ...path.split("/"));
  await assertParentInside(root, target);
  let pathStat: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        exists: false,
        editable: false,
        content: null,
        version: null,
        worktreeVersion: sha256("missing"),
        lineEnding: null,
        signature: "missing",
        mode: null,
      };
    throw error;
  }
  if (pathStat.isSymbolicLink()) {
    const link = await readlink(target);
    return {
      exists: true,
      editable: false,
      content: null,
      version: null,
      worktreeVersion: sha256(`symlink\0${link}\0${signature(pathStat)}`),
      lineEnding: null,
      signature: signature(pathStat),
      mode: null,
    };
  }
  if (!pathStat.isFile())
    return {
      exists: true,
      editable: false,
      content: null,
      version: null,
      worktreeVersion: sha256(`other\0${signature(pathStat)}`),
      lineEnding: null,
      signature: signature(pathStat),
      mode: null,
    };

  assertInside(root, await realpath(target));
  let handle;
  try {
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    if (!before.isFile())
      return {
        exists: true,
        editable: false,
        content: null,
        version: null,
        worktreeVersion: sha256(`other\0${signature(before)}`),
        lineEnding: null,
        signature: signature(pathStat),
        mode: null,
      };
    if (before.size > MAX_EDIT_BYTES) {
      const afterPathStat = await lstat(target);
      if (signature(before) !== signature(afterPathStat))
        throw new GitFileConflictError();
      return {
        exists: true,
        editable: false,
        content: null,
        version: null,
        worktreeVersion: sha256(`large\0${signature(before)}`),
        lineEnding: null,
        signature: signature(before),
        mode: before.mode,
      };
    }

    const bytes = await handle.readFile();
    const after = await handle.stat();
    const currentPathStat = await lstat(target);
    if (
      signature(before) !== signature(after) ||
      signature(after) !== signature(currentPathStat)
    )
      throw new GitFileConflictError();
    let content: string | null = null;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      // Binary files stay reviewable and stageable but are not exposed to the editor.
    }
    const normalized = content?.replace(/\r\n/g, "") ?? "";
    const hasLf = normalized.includes("\n");
    const hasCr = normalized.includes("\r");
    const hasCrLf = content?.includes("\r\n") ?? false;
    const mixedLines = hasCr || (hasLf && hasCrLf);
    const lineEnding = hasCrLf ? "crlf" : "lf";
    const editable = Boolean(
      content !== null &&
      !bytes.includes(0) &&
      !mixedLines &&
      (after.mode & 0o222) !== 0,
    );
    const version = editable ? sha256(bytes) : null;
    return {
      exists: true,
      editable,
      content: bytes.includes(0) ? null : content,
      version,
      worktreeVersion: regularFileVersion(after.mode, bytes),
      lineEnding: editable ? lineEnding : null,
      signature: signature(after),
      mode: after.mode,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      const linkStat = await lstat(target);
      const link = await readlink(target);
      return {
        exists: true,
        editable: false,
        content: null,
        version: null,
        worktreeVersion: sha256(`symlink\0${link}\0${signature(linkStat)}`),
        lineEnding: null,
        signature: signature(linkStat),
        mode: null,
      };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function diffBase(root: string): Promise<string> {
  const head = await git(
    root,
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    [1],
  );
  if (head.trim()) return head.trim();
  const objectFormat = (
    await git(root, ["rev-parse", "--show-object-format"])
  ).trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
    throw new Error("Unsupported Git object format");
  return sha256ForObjectFormat(objectFormat, "tree 0\0");
}

function sha256ForObjectFormat(format: "sha1" | "sha256", value: string) {
  return createHash(format).update(value).digest("hex");
}

function pathspec(path: string) {
  return `:(literal)${path}`;
}

export async function getWorkspaceFile(
  cwd: string,
  path: string,
): Promise<GitFile> {
  const status = await getGitStatus(cwd);
  const root = status.isRepo ? status.root : await realpath(cwd);
  const relativePath = worktreePath(root, path);
  const changed = status.files.find((file) => file.path === relativePath);
  if (!changed) {
    const snapshot = await currentFile(root, relativePath);
    if (!snapshot.exists) throw new Error("File not found");
    return {
      path: relativePath,
      stagedDiff: "",
      worktreeDiff: "",
      diff: "",
      content: snapshot.content,
      version: snapshot.version,
      worktreeVersion: snapshot.worktreeVersion,
      editable: snapshot.editable,
      lineEnding: snapshot.lineEnding,
    };
  }
  if (!status.isRepo)
    throw new Error("Working directory is not a Git repository");

  const before = await currentFile(status.root, relativePath);
  const filePaths = changed.originalPath
    ? [changed.originalPath, relativePath]
    : [relativePath];
  const filePathspecs = filePaths.map(pathspec);
  const stagedDiff = await git(status.root, [
    "diff",
    "--cached",
    await diffBase(status.root),
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--",
    ...filePathspecs,
  ]);
  const worktreeDiff = changed.untracked
    ? await git(
        status.root,
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--",
          process.platform === "win32" ? "NUL" : "/dev/null",
          relativePath,
        ],
        [1],
      )
    : await git(status.root, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        ...filePathspecs,
      ]);
  const diff = changed.untracked
    ? worktreeDiff
    : await git(status.root, [
        "diff",
        await diffBase(status.root),
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        ...filePathspecs,
      ]);
  const after = await currentFile(status.root, relativePath);
  if (before.signature !== after.signature) throw new GitFileConflictError();
  return {
    path: relativePath,
    stagedDiff,
    worktreeDiff,
    diff,
    content: after.content,
    version: after.version,
    worktreeVersion: after.worktreeVersion,
    editable: after.editable,
    lineEnding: after.lineEnding,
  };
}

async function withRepositoryLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = mutationLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationLocks.set(root, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (mutationLocks.get(root) === current) mutationLocks.delete(root);
  }
}

export async function switchGitBranch(
  cwd: string,
  branch: string,
  expectedIndexVersion: string,
  create = false,
): Promise<GitStatus> {
  expectedIndex(expectedIndexVersion);
  const root = await repositoryRoot(cwd);
  if (!root) throw new Error("Not a Git repository");
  return withRepositoryLock(root, async () => {
    const status = await currentRepoStatus(root);
    if (status.indexVersion !== expectedIndexVersion)
      throw new GitIndexConflictError();
    if (create) {
      if (typeof branch !== "string" || !branch || branch.startsWith("-") || branch.length > 1024)
        throw new Error("Enter a valid branch name");
      await git(root, ["check-ref-format", `refs/heads/${branch}`]);
      await git(root, ["switch", "-c", branch]);
    } else {
      if (!status.branches.includes(branch))
        throw new Error("Select an existing local branch");
      await git(root, ["switch", "--no-guess", "--", branch]);
    }
    return getGitStatus(root);
  });
}

function expectedIndex(value: string) {
  if (!/^[\da-f]{64}$/.test(value))
    throw new Error("Invalid Git index version");
}

function changedFiles(status: GitStatus & { isRepo: true }, paths: string[]) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100)
    throw new Error("Select between 1 and 100 changed files");
  const selected = [
    ...new Set(paths.map((path) => worktreePath(status.root, path))),
  ];
  if (selected.length !== paths.length) throw new Error("Duplicate file path");
  const files = selected.map((path) =>
    status.files.find((file) => file.path === path),
  );
  if (files.some((file) => !file))
    throw new Error("Files must be selected from current Git changes");
  return files as GitChangedFile[];
}

function worktreePaths(files: GitChangedFile[]) {
  return [
    ...new Set(
      files.flatMap((file) =>
        file.originalPath ? [file.originalPath, file.path] : [file.path],
      ),
    ),
  ];
}

function expectedFileVersions(
  root: string,
  selected: string[],
  expectedFiles?: GitExpectedFile[],
) {
  if (expectedFiles === undefined) return new Map<string, string>();
  if (!Array.isArray(expectedFiles) || expectedFiles.length > selected.length)
    throw new Error("Invalid expected file versions");
  const versions = new Map<string, string>();
  for (const item of expectedFiles) {
    if (
      !item ||
      typeof item.version !== "string" ||
      !/^[\da-f]{64}$/.test(item.version)
    )
      throw new Error("Invalid expected file version");
    const path = worktreePath(root, item.path);
    if (!selected.includes(path) || versions.has(path))
      throw new Error("Invalid expected file path");
    versions.set(path, item.version);
  }
  return versions;
}

async function currentRepoStatus(
  root: string,
): Promise<GitStatus & { isRepo: true }> {
  const status = await getGitStatus(root);
  if (!status.isRepo)
    throw new Error("Working directory is not a Git repository");
  return status;
}

export async function stageGitFiles(
  cwd: string,
  paths: string[],
  expectedIndexVersion: string,
  expectedFiles?: GitExpectedFile[],
): Promise<GitMutationResult> {
  expectedIndex(expectedIndexVersion);
  const status = await getGitStatus(cwd);
  if (!status.isRepo)
    throw new Error("Working directory is not a Git repository");
  const selectedFiles = changedFiles(status, paths);
  const selected = selectedFiles.map((file) => file.path);
  const versions = expectedFileVersions(status.root, selected, expectedFiles);
  return withRepositoryLock(status.root, async () => {
    const current = await currentRepoStatus(status.root);
    if (current.indexVersion !== expectedIndexVersion)
      throw new GitIndexConflictError();
    const currentFiles = selectedFiles.map((selectedFile) =>
      current.files.find((file) => file.path === selectedFile.path),
    );
    if (
      currentFiles.some(
        (file, index) =>
          !file || file.originalPath !== selectedFiles[index]!.originalPath,
      )
    )
      throw new GitFileConflictError(
        "Git file selection changed; refresh before staging.",
      );
    for (const [path, version] of versions)
      if ((await currentFile(status.root, path)).worktreeVersion !== version)
        throw new GitFileConflictError(
          "File changed since its preview; refresh before staging.",
        );
    const pathsToStage = worktreePaths(currentFiles as GitChangedFile[]);
    for (const path of pathsToStage)
      await assertParentInside(
        status.root,
        resolve(status.root, ...path.split("/")),
      );
    await git(status.root, ["add", "-A", "--", ...pathsToStage.map(pathspec)]);
    return { indexVersion: await indexVersion(status.root) };
  });
}

export async function unstageGitFiles(
  cwd: string,
  paths: string[],
  expectedIndexVersion: string,
): Promise<GitMutationResult> {
  expectedIndex(expectedIndexVersion);
  const status = await getGitStatus(cwd);
  if (!status.isRepo)
    throw new Error("Working directory is not a Git repository");
  const selectedFiles = changedFiles(status, paths);
  return withRepositoryLock(status.root, async () => {
    const current = await currentRepoStatus(status.root);
    if (current.indexVersion !== expectedIndexVersion)
      throw new GitIndexConflictError();
    const currentFiles = selectedFiles.map((selectedFile) =>
      current.files.find((file) => file.path === selectedFile.path),
    );
    if (
      currentFiles.some(
        (file, index) =>
          !file || file.originalPath !== selectedFiles[index]!.originalPath,
      )
    )
      throw new GitFileConflictError();
    for (const file of currentFiles as GitChangedFile[])
      if (file.indexStatus === " " || file.indexStatus === "?")
        throw new GitIndexConflictError();
    const head = await git(
      status.root,
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      [1],
    );
    const args = head.trim()
      ? ["restore", "--staged", "--"]
      : ["rm", "--cached", "--ignore-unmatch", "--"];
    await git(status.root, [
      ...args,
      ...worktreePaths(currentFiles as GitChangedFile[]).map(pathspec),
    ]);
    return { indexVersion: await indexVersion(status.root) };
  });
}

export async function saveWorkspaceFile(
  cwd: string,
  path: string,
  content: string,
  expectedVersion: string,
): Promise<GitFileSaveResult> {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") > MAX_EDIT_BYTES
  )
    throw new Error("Edited text exceeds the 1 MiB limit");
  if (Buffer.from(content, "utf8").toString("utf8") !== content)
    throw new Error("Edited text must be valid UTF-8");
  if (content.includes("\0"))
    throw new Error("Edited text cannot contain NUL bytes");
  if (!/^[\da-f]{64}$/.test(expectedVersion))
    throw new Error("Invalid file version");

  const root = (await repositoryRoot(cwd)) ?? (await realpath(cwd));
  const relativePath = worktreePath(root, path);
  const target = resolve(root, ...relativePath.split("/"));
  await assertParentInside(root, target);

  return withRepositoryLock(root, async () => {
    const original = await currentFile(root, relativePath);
    if (
      !original.editable ||
      !original.exists ||
      original.version !== expectedVersion ||
      original.mode === null
    )
      throw new GitFileConflictError();
    const bytes = Buffer.from(content, "utf8");
    const version = sha256(bytes);
    if (version === expectedVersion)
      return { version, worktreeVersion: original.worktreeVersion! };

    const temporary = resolve(dirname(target), `.pi-webui-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", original.mode & 0o777);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, original.mode & 0o777);
      const latest = await currentFile(root, relativePath);
      if (
        !latest.editable ||
        !latest.exists ||
        latest.version !== expectedVersion ||
        latest.signature !== original.signature
      )
        throw new GitFileConflictError();
      await rename(temporary, target);
      return {
        version,
        worktreeVersion: regularFileVersion(original.mode & 0o777, bytes),
      };
    } finally {
      await handle?.close();
      await unlink(temporary).catch(() => undefined);
    }
  });
}

export async function commitGit(
  cwd: string,
  message: string,
  expectedIndexVersion: string,
): Promise<GitCommitResult> {
  if (typeof message !== "string" || !message.trim() || message.length > 10_000)
    throw new Error(
      "Commit message is required and must be at most 10,000 characters",
    );
  expectedIndex(expectedIndexVersion);
  const status = await getGitStatus(cwd);
  if (!status.isRepo)
    throw new Error("Working directory is not a Git repository");
  return withRepositoryLock(status.root, async () => {
    const current = await currentRepoStatus(status.root);
    if (current.indexVersion !== expectedIndexVersion)
      throw new GitIndexConflictError();
    if (await git(status.root, ["ls-files", "--unmerged", "-z"]))
      throw new Error("Resolve unmerged files before committing");
    const diff = await runGit(
      status.root,
      ["diff", "--cached", "--quiet", "--"],
      [1],
    );
    if (diff.exitCode === 0) throw new Error("No staged changes to commit");
    if ((await indexVersion(status.root)) !== expectedIndexVersion)
      throw new GitIndexConflictError();

    await git(status.root, ["commit", "-m", message.trim()], [], 0);
    const commit = (await git(status.root, ["rev-parse", "HEAD"])).trim();
    const branch = await currentBranch(status.root);
    return {
      commit,
      branch,
      indexVersion: await indexVersion(status.root, branch),
    };
  });
}
