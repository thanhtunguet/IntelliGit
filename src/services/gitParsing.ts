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

export function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  if (!stdout) {
    return [];
  }

  const tokens = stdout.split('\0').filter((token) => token.length > 0);
  const entries: NameStatusEntry[] = [];

  for (let index = 0; index < tokens.length; ) {
    const statusToken = tokens[index++];
    const status = statusToken[0]?.toUpperCase();

    if (!status) {
      continue;
    }

    if (status === 'R' || status === 'C') {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];

      if (!oldPath || !newPath) {
        break;
      }

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
