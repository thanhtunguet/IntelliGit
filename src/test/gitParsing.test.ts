import * as assert from 'assert';
import { describe, it } from 'node:test';
import { formatComparisonSummary, parsePorcelainStatusZ, parseRevListComparison, parseTrack } from '../services/gitParsing';
import { parseSubmoduleConfig, parseSubmoduleStatus } from '../services/submoduleParsing';
import { parseWorktreeListPorcelain, parseWorktreePruneDryRun } from '../services/worktreeParsing';

describe('Git parsing utilities', () => {
  it('parses branch track output', () => {
    assert.deepStrictEqual(parseTrack('[ahead 2]'), { ahead: 2, behind: 0 });
    assert.deepStrictEqual(parseTrack('[behind 3]'), { ahead: 0, behind: 3 });
    assert.deepStrictEqual(parseTrack('[ahead 1, behind 4]'), { ahead: 1, behind: 4 });
    assert.deepStrictEqual(parseTrack(''), { ahead: 0, behind: 0 });
  });

  it('parses rev-list comparison counts', () => {
    assert.deepStrictEqual(parseRevListComparison('2\t5\n'), { ahead: 2, behind: 5 });
    assert.deepStrictEqual(parseRevListComparison('0 0'), { ahead: 0, behind: 0 });
  });

  it('formats comparison count summaries', () => {
    assert.strictEqual(formatComparisonSummary('origin/main', 3, 1), 'Compared with origin/main: ahead 3, behind 1');
  });

  it('parses NUL-separated porcelain status output', () => {
    const raw = ' M src/changed.ts\0A  src/staged.ts\0?? src/new.ts\0R  src/new-name.ts\0src/old.ts\0';

    assert.deepStrictEqual(parsePorcelainStatusZ(raw), [
      { status: ' M', path: 'src/changed.ts' },
      { status: 'A ', path: 'src/staged.ts' },
      { status: '??', path: 'src/new.ts' },
      { status: 'R ', path: 'src/new-name.ts' }
    ]);
  });

  it('parses shortstat line', () => {
    const parseShortStat = (raw: string) => {
      const line = raw
        .split('\n')
        .map((value) => value.trim())
        .find((value) => value.length > 0);

      if (!line) {
        return undefined;
      }

      const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
      const insertionsMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
      const deletionsMatch = line.match(/(\d+)\s+deletions?\(-\)/);

      return {
        files: Number(filesMatch?.[1] ?? 0),
        insertions: Number(insertionsMatch?.[1] ?? 0),
        deletions: Number(deletionsMatch?.[1] ?? 0)
      };
    };

    assert.deepStrictEqual(parseShortStat(' 1 file changed, 2 insertions(+), 3 deletions(-)'), {
      files: 1,
      insertions: 2,
      deletions: 3
    });
  });
});

describe('Worktree parser', () => {
  it('parses two normal worktrees', () => {
    const raw = `worktree /home/user/project
HEAD abc1234
branch refs/heads/main

worktree /home/user/project/.worktrees/feature
HEAD def5678
branch refs/heads/feature/foo

`;
    const entries = parseWorktreeListPorcelain(raw);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].worktreePath, '/home/user/project');
    assert.strictEqual(entries[0].branch, 'main');
    assert.strictEqual(entries[0].headSha, 'abc1234');
    assert.strictEqual(entries[0].isLocked, false);
    assert.strictEqual(entries[1].branch, 'feature/foo');
  });

  it('parses a locked worktree with reason', () => {
    const raw = `worktree /home/user/project
HEAD abc1234
branch refs/heads/main

worktree /tmp/my-wt
HEAD deadbeef
branch refs/heads/experiment
locked long-running experiment

`;
    const entries = parseWorktreeListPorcelain(raw);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[1].isLocked, true);
    assert.strictEqual(entries[1].lockReason, 'long-running experiment');
  });

  it('parses a prunable worktree', () => {
    const raw = `worktree /home/user/project
HEAD abc1234
branch refs/heads/main

worktree /tmp/stale-wt
HEAD cafebabe
prunable gitdir file points to non-existent location

`;
    const entries = parseWorktreeListPorcelain(raw);
    assert.strictEqual(entries[1].isPrunable, true);
  });

  it('parses a detached HEAD worktree', () => {
    const raw = `worktree /home/user/project
HEAD abc1234
branch refs/heads/main

worktree /tmp/detached-wt
HEAD abcdef12
detached

`;
    const entries = parseWorktreeListPorcelain(raw);
    assert.strictEqual(entries[1].isDetached, true);
    assert.strictEqual(entries[1].branch, undefined);
  });

  it('parses prune dry-run output', () => {
    const raw = `Removing worktrees/stale-wt: gitdir file points to non-existent location
Removing worktrees/old-feature: gitdir file points to non-existent location
`;
    const entries = parseWorktreePruneDryRun(raw);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].worktreePath, 'stale-wt');
  });
});

describe('Submodule parser', () => {
  it('parses submodule config from .gitmodules', () => {
    const raw = `submodule.vendor/lib.path vendor/lib
submodule.vendor/lib.url https://github.com/example/lib.git
submodule.vendor/lib.branch main
submodule.tools/util.path tools/util
submodule.tools/util.url https://github.com/example/util.git
`;
    const entries = parseSubmoduleConfig(raw);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].name, 'vendor/lib');
    assert.strictEqual(entries[0].path, 'vendor/lib');
    assert.strictEqual(entries[0].url, 'https://github.com/example/lib.git');
    assert.strictEqual(entries[0].branch, 'main');
    assert.strictEqual(entries[1].branch, undefined);
  });

  it('parses submodule status output - normal', () => {
    const raw = ` abc12345 vendor/lib (v1.2.0)
`;
    const entries = parseSubmoduleStatus(raw);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].path, 'vendor/lib');
    assert.strictEqual(entries[0].sha, 'abc12345');
    assert.strictEqual(entries[0].isUninitialized, false);
    assert.strictEqual(entries[0].isDirty, false);
  });

  it('parses submodule status - uninitialized', () => {
    const raw = `-abc12345 vendor/lib
`;
    const entries = parseSubmoduleStatus(raw);
    assert.strictEqual(entries[0].isUninitialized, true);
  });

  it('parses submodule status - dirty (pointer changed)', () => {
    const raw = `+deadbeef tools/util (heads/main)
`;
    const entries = parseSubmoduleStatus(raw);
    assert.strictEqual(entries[0].isDirty, true);
    assert.strictEqual(entries[0].isPointerMismatch, true);
  });

  it('parses recursive submodule status with nested path', () => {
    const raw = ` abc12345 vendor/lib (v1.2.0)
 def67890 vendor/lib/nested/sub (v0.1)
`;
    const entries = parseSubmoduleStatus(raw);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[1].sha, 'def67890');
    assert.strictEqual(entries[1].path, 'vendor/lib/nested/sub');
    assert.strictEqual(entries[1].isNested, true);
  });
});
