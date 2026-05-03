export interface FormattedCommitDate {
  readonly label: string;
  readonly title: string;
  readonly timestamp: number;
}

export function formatCommitDate(value: string | Date, now = Date.now()): FormattedCommitDate {
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();

  if (!Number.isFinite(timestamp)) {
    return {
      label: '',
      title: '',
      timestamp: 0
    };
  }

  return {
    label: relativeCommitDate(date, now),
    title: date.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }),
    timestamp
  };
}

function relativeCommitDate(date: Date, now: number): string {
  const diffMs = now - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  if (mins < 1) {
    return 'just now';
  }
  if (mins < 60) {
    return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  }
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
