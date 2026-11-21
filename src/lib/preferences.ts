export const sendShortcuts = {
  "mod-enter": "Ctrl / Cmd + Enter",
  "shift-enter": "Shift + Enter",
  "alt-enter": "Option / Alt + Enter",
  enter: "Enter",
} as const;
export type SendShortcut = keyof typeof sendShortcuts;

export function isSendKey(
  event: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  shortcut: SendShortcut,
) {
  if (event.key !== "Enter") return false;
  const mod = event.ctrlKey || event.metaKey;
  switch (shortcut) {
    case "mod-enter":
      return mod && !event.shiftKey && !event.altKey;
    case "shift-enter":
      return event.shiftKey && !mod && !event.altKey;
    case "alt-enter":
      return event.altKey && !mod && !event.shiftKey;
    case "enter":
      return !mod && !event.shiftKey && !event.altKey;
  }
}

export function storedWrapLines() {
  return localStorage.getItem("pi-webui-wrap-lines") === "true";
}

export function storedSendShortcut(): SendShortcut {
  const saved = localStorage.getItem("pi-webui-send-shortcut");
  return saved && Object.hasOwn(sendShortcuts, saved)
    ? (saved as SendShortcut)
    : "mod-enter";
}

export const uiFonts = {
  system: {
    label: "System",
    stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif",
  },
  jpSans: {
    label: "Hiragino / Noto Sans JP",
    stack: "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', -apple-system, sans-serif",
  },
  serif: {
    label: "Serif",
    stack: "'Hiragino Mincho ProN', 'Yu Mincho', Georgia, 'Noto Serif JP', serif",
  },
  mono: {
    label: "Monospace",
    stack: "'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  },
} as const;
export type UiFont = keyof typeof uiFonts;

export const monoFonts = {
  sfMono: {
    label: "SF Mono / Menlo",
    stack: "'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  },
  jetbrains: {
    label: "JetBrains Mono",
    stack: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
  },
  fira: {
    label: "Fira Code",
    stack: "'Fira Code', 'SF Mono', Menlo, Consolas, monospace",
  },
} as const;
export type MonoFont = keyof typeof monoFonts;

export const fontSizes = {
  compact: { label: "Compact (13px)", px: "13px" },
  default: { label: "Default (14px)", px: "14px" },
  comfortable: { label: "Comfortable (15px)", px: "15px" },
  large: { label: "Large (16px)", px: "16px" },
} as const;
export type FontSize = keyof typeof fontSizes;

export function storedUiFont(): UiFont {
  const saved = localStorage.getItem("pi-webui-ui-font");
  return saved && Object.hasOwn(uiFonts, saved) ? (saved as UiFont) : "system";
}

export function storedMonoFont(): MonoFont {
  const saved = localStorage.getItem("pi-webui-mono-font");
  return saved && Object.hasOwn(monoFonts, saved) ? (saved as MonoFont) : "sfMono";
}

export function storedFontSize(): FontSize {
  const saved = localStorage.getItem("pi-webui-font-size");
  return saved && Object.hasOwn(fontSizes, saved) ? (saved as FontSize) : "default";
}

export function applyTypography(uiFont: UiFont, monoFont: MonoFont, fontSize: FontSize) {
  const root = document.documentElement;
  root.style.setProperty("--font-sans", uiFonts[uiFont].stack);
  root.style.setProperty("--mono", monoFonts[monoFont].stack);
  root.style.setProperty("--font-size", fontSizes[fontSize].px);
}
