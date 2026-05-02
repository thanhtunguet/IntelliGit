import { SubmoduleConfigEntry, SubmoduleStatusEntry } from '../types';

interface MutableSubmoduleConfigEntry {
  name: string;
  path?: string;
  url?: string;
  branch?: string;
}

export function parseSubmoduleConfig(raw: string): SubmoduleConfigEntry[] {
  const map = new Map<string, MutableSubmoduleConfigEntry>();

  for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const match = line.match(/^submodule\.(.+?)\.(path|url|branch)\s+(.+)$/);
    if (!match) { continue; }
    const [, name, key, value] = match;
    if (!map.has(name)) { map.set(name, { name }); }
    const entry = map.get(name)!;
    if (key === 'path') { entry.path = value; }
    else if (key === 'url') { entry.url = value; }
    else if (key === 'branch') { entry.branch = value; }
  }

  return Array.from(map.values())
    .filter((e): e is SubmoduleConfigEntry => Boolean(e.path && e.url))
    .map((e) => ({
      name: e.name,
      path: e.path!,
      url: e.url!,
      branch: e.branch
    }));
}

export function parseSubmoduleStatus(raw: string): SubmoduleStatusEntry[] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const prefix = line[0];
      const rest = line.slice(1).trim();
      const spaceIdx = rest.indexOf(' ');
      const sha = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const pathAndDesc = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
      const parenIdx = pathAndDesc.indexOf('(');
      const subPath = (parenIdx === -1 ? pathAndDesc : pathAndDesc.slice(0, parenIdx)).trim();

      return {
        path: subPath,
        sha,
        isUninitialized: prefix === '-',
        isDirty: prefix === '+' || prefix === 'U',
        isPointerMismatch: prefix === '+',
        isNested: subPath.includes('/')
      };
    });
}
