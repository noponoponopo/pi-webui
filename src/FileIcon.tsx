import {
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileMusic,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";

const iconByExtension: Record<string, LucideIcon> = {
  json: FileJson,
  jsonc: FileJson,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  ico: FileImage,
  mp3: FileMusic,
  wav: FileMusic,
  ogg: FileMusic,
  flac: FileMusic,
  m4a: FileMusic,
  mp4: FileVideo,
  mov: FileVideo,
  webm: FileVideo,
  mkv: FileVideo,
  zip: FileArchive,
  gz: FileArchive,
  tar: FileArchive,
  "7z": FileArchive,
  toml: FileCog,
  yaml: FileCog,
  yml: FileCog,
  ini: FileCog,
  env: FileCog,
  py: FileCode,
  rs: FileCode,
  go: FileCode,
  java: FileCode,
  c: FileCode,
  cpp: FileCode,
  h: FileCode,
  swift: FileCode,
  rb: FileCode,
  php: FileCode,
  html: FileCode,
  css: FileCode,
  scss: FileCode,
  vue: FileCode,
  svelte: FileCode,
  sh: FileCode,
  sql: FileCode,
  md: FileText,
  mdx: FileText,
  txt: FileText,
  csv: FileText,
};

export function FileIcon({ name }: { name: string }) {
  const extension = name.toLowerCase().split(".").at(-1) || "";
  if (["ts", "tsx", "js", "jsx"].includes(extension))
    return (
      <svg
        className={`file-icon file-icon-${extension.startsWith("t") ? "typescript" : "javascript"}`}
        width="14"
        height="14"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <rect x="1" y="1" width="14" height="14" rx="2" fill="currentColor" />
        <text
          x="8"
          y="11"
          textAnchor="middle"
          fontSize="8"
          fontWeight="700"
          fill="var(--bg)"
        >
          {extension.startsWith("t") ? "TS" : "JS"}
        </text>
      </svg>
    );
  const knownIcon = Object.hasOwn(iconByExtension, extension)
    ? iconByExtension[extension]
    : undefined;
  const Icon = knownIcon ?? (name.toLowerCase() === "dockerfile" ? FileCog : File);
  return <Icon className={`file-icon file-icon-${extension}`} size={14} />;
}
