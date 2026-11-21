export type SessionPreset = {
  id: string;
  name: string;
  cwd?: string;
  promptPrefix?: string;
  thinkingLevel?: string;
};

const STORAGE_KEY = 'pi-webui-presets';

export function storedPresets(): SessionPreset[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (item): item is SessionPreset =>
        item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string',
    );
  } catch {
    return [];
  }
}

export function savePresets(presets: SessionPreset[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}
