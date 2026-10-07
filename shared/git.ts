export type FileEntry = { path: string; name: string; directory: boolean };
export type FileDirectory = {
  root: string;
  path: string;
  entries: FileEntry[];
};
export type GitChangedFile = {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
};

export type GitWorktree = {
  path: string;
  branch: string | null;
  current: boolean;
};

export type GitStatus =
  | {
      isRepo: true;
      root: string;
      branch: string | null;
      branches: string[];
      worktrees: GitWorktree[];
      files: GitChangedFile[];
      indexVersion: string;
    }
  | {
      isRepo: false;
      root: null;
      branch: null;
      branches: [];
      worktrees: [];
      files: [];
      indexVersion: null;
    };

export type GitFile = {
  path: string;
  stagedDiff: string;
  worktreeDiff: string;
  diff: string;
  content: string | null;
  version: string | null;
  worktreeVersion: string;
  editable: boolean;
  lineEnding: "lf" | "crlf" | null;
};

export type GitFileSaveResult = { version: string; worktreeVersion: string };
export type GitMutationResult = { indexVersion: string };
export type GitCommitResult = {
  commit: string;
  branch: string | null;
  indexVersion: string;
};
export type GitExpectedFile = { path: string; version: string };
