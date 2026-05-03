import * as assert from 'assert';
import { describe, it } from 'node:test';
import { parseNameStatusZ } from '../services/gitParsing';

describe('parseNameStatusZ', () => {
  it('returns an empty array for empty input', () => {
    assert.deepStrictEqual(parseNameStatusZ(''), []);
  });

  it('parses NUL-separated name-status entries', () => {
    const stdout = 'M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0';

    assert.deepStrictEqual(parseNameStatusZ(stdout), [
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'src/b.ts' },
      { status: 'D', path: 'src/c.ts' }
    ]);
  });

  it('returns the new path for rename and copy entries', () => {
    const stdout = 'R100\0src/old.ts\0src/new.ts\0C075\0src/old-copy.ts\0src/new-copy.ts\0';

    assert.deepStrictEqual(parseNameStatusZ(stdout), [
      { status: 'R', path: 'src/new.ts' },
      { status: 'C', path: 'src/new-copy.ts' }
    ]);
  });

  it('tolerates missing trailing NUL', () => {
    const stdout = 'M\0src/a.ts\0R100\0src/old.ts\0src/new.ts';

    assert.deepStrictEqual(parseNameStatusZ(stdout), [
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', path: 'src/new.ts' }
    ]);
  });
});
