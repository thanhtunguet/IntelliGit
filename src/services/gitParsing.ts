export function parseTrack(value: string): { ahead: number; behind: number } {
  if (!value) {
    return { ahead: 0, behind: 0 };
  }

  const aheadMatch = value.match(/ahead (\d+)/);
  const behindMatch = value.match(/behind (\d+)/);
  return {
    ahead: Number(aheadMatch?.[1] ?? 0),
    behind: Number(behindMatch?.[1] ?? 0)
  };
}

export function parseRevListComparison(value: string): { ahead: number; behind: number } {
  const [aheadRaw, behindRaw] = value.trim().split(/\s+/);
  return {
    ahead: Number(aheadRaw ?? 0),
    behind: Number(behindRaw ?? 0)
  };
}

export function formatComparisonSummary(ref: string, ahead: number, behind: number): string {
  return `Compared with ${ref}: ahead ${ahead}, behind ${behind}`;
}

export interface NameStatusEntry {
  readonly status: string;
  readonly path: string;
}

export interface PorcelainStatusEntry {
  readonly status: string;
  readonly path: string;
}

export function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  if (!stdout) {
    return [];
  }

  const tokens = stdout.split('\0').filter((token) => token.length > 0);
  const entries: NameStatusEntry[] = [];

  for (let index = 0; index < tokens.length; ) {
    const statusToken = tokens[index++];
    const status = statusToken[0].toUpperCase();

    if (status === 'R' || status === 'C') {
      // Consume both oldPath and newPath tokens deterministically.
      // Stop safely if either is absent (truncated input).
      const oldPath = tokens[index];
      const newPath = tokens[index + 1];

      if (!oldPath || !newPath) {
        break;
      }

      index += 2;
      entries.push({ status, path: newPath });
      continue;
    }

    const path = tokens[index++];
    if (!path) {
      break;
    }

    entries.push({ status, path });
  }

  return entries;
}

export function parsePorcelainStatusZ(stdout: string): PorcelainStatusEntry[] {
  if (!stdout) {
    return [];
  }

  const tokens = stdout.split('\0').filter((token) => token.length > 0);
  const entries: PorcelainStatusEntry[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) {
      continue;
    }

    const status = token.slice(0, 2);
    const path = token.slice(3);
    const statusCode = status.trim()[0]?.toUpperCase();

    if (statusCode === 'R' || statusCode === 'C') {
      // `git status --porcelain=v1 -z` emits renames/copies as
      // `XY <new>\0<old>\0` — the destination is in the status token,
      // followed by the source in the next token. Keep `path` (new)
      // and consume the trailing source token.
      const origPath = tokens[index + 1];
      if (!origPath) {
        break;
      }
      entries.push({ status, path });
      index += 1;
      continue;
    }

    entries.push({ status, path });
  }

  return entries;
}
