export type LineHunk = {
  kind: 'add' | 'modify' | 'remove';
  // 0-based start line in the new (current) text; inclusive.
  newStart: number;
  // Number of new-text lines covered by this hunk. 0 for pure removals.
  newCount: number;
  // Number of old-text lines covered by this hunk. 0 for pure additions.
  oldCount: number;
};

export function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

type Op = { kind: 'eq' | 'del' | 'ins' };

export function computeLineHunks(oldText: string, newText: string): LineHunk[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = myers(a, b);
  return collectHunks(ops);
}

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) {
    return [];
  }
  const offset = max;
  const vSize = 2 * max + 1;
  const v = new Int32Array(vSize);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(new Int32Array(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      const down = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]);
      if (down) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, offset);
      }
    }
  }
  return [];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const v = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'eq' });
      x--;
      y--;
    }
    if (d > 0) {
      if (down) {
        ops.push({ kind: 'ins' });
        y--;
      } else {
        ops.push({ kind: 'del' });
        x--;
      }
    }
  }
  ops.reverse();
  return ops;
}

function collectHunks(ops: Op[]): LineHunk[] {
  const hunks: LineHunk[] = [];
  let newLine = 0;
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.kind === 'eq') {
      newLine++;
      i++;
      continue;
    }
    let dels = 0;
    let ins = 0;
    const start = newLine;
    while (i < ops.length && ops[i].kind !== 'eq') {
      if (ops[i].kind === 'del') {
        dels++;
      } else {
        ins++;
        newLine++;
      }
      i++;
    }
    if (ins > 0 && dels > 0) {
      hunks.push({ kind: 'modify', newStart: start, newCount: ins, oldCount: dels });
    } else if (ins > 0) {
      hunks.push({ kind: 'add', newStart: start, newCount: ins, oldCount: 0 });
    } else {
      hunks.push({ kind: 'remove', newStart: start, newCount: 0, oldCount: dels });
    }
  }
  return hunks;
}
