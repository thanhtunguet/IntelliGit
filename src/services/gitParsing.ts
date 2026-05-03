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
