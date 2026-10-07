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
