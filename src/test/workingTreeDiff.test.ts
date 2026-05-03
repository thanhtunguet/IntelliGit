import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, before, after } from 'node:test';
import { parseNameStatusZ } from '../services/gitParsing';

// ---------------------------------------------------------------------------
// Helpers for integration-style fixture repo
// ---------------------------------------------------------------------------

function spawnSync(args: string[], cwd: string): string {
  const result = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function runGit(args: string[], cwd: string): string {
  return spawnSync(args, cwd);
}

/**
 * Minimal stub that delegates runGit to the fixture repo.
 * We only expose the two new methods under test so that the tests
 * stay self-contained without needing vscode at runtime.
 */
function makeService(repoRoot: string) {
  async function execGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = cp.spawn('git', args, { cwd: repoRoot });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(stderr || `exit ${code}`));
        }
      });
    });
  }

  async function getFilesChangedBetweenWorkingTreeAndRef(
    ref: string,
    scopePath?: string
  ): Promise<Array<{ status: string; path: string; untracked: boolean }>> {
    const scopeArgs = scopePath ? ['--', scopePath] : [];

    const trackedResult = await execGit(['diff', '--name-status', '-z', ref, ...scopeArgs]);
    const trackedEntries = parseNameStatusZ(trackedResult.stdout).map(
      (entry) => ({ status: entry.status, path: entry.path, untracked: false })
    );

    const untrackedResult = await execGit([
      'ls-files', '--others', '--exclude-standard', '-z', ...scopeArgs
    ]);
    const untrackedEntries = untrackedResult.stdout
      .split('\0')
      .filter((p) => p.length > 0)
      .map((p) => ({ status: 'A', path: p, untracked: true }));

    const trackedPaths = new Set(trackedEntries.map((e) => e.path));
    const merged = [
      ...trackedEntries,
      ...untrackedEntries.filter((e) => !trackedPaths.has(e.path))
    ];
    merged.sort((a, b) => a.path.localeCompare(b.path));
    return merged;
  }

  async function resolveRevisionToCommit(
    input: string
  ): Promise<{ sha: string; subject: string; author: string; date: string } | undefined> {
    try {
      const verifyResult = await execGit(['rev-parse', '--verify', `${input}^{commit}`]);
      const sha = verifyResult.stdout.trim();
      if (!sha) {
        return undefined;
      }
      const logResult = await execGit([
        'log', '-1', '--format=%H%x00%s%x00%an%x00%ad', '--date=iso-strict', sha
      ]);
      const parts = logResult.stdout.trim().split('\0');
      if (parts.length < 4) {
        return undefined;
      }
      const [resolvedSha, subject, author, date] = parts;
      if (!resolvedSha || !subject || !author || !date) {
        return undefined;
      }
      return { sha: resolvedSha, subject, author, date };
    } catch {
      return undefined;
    }
  }

  return { getFilesChangedBetweenWorkingTreeAndRef, resolveRevisionToCommit };
}

// ---------------------------------------------------------------------------
// Unit tests: parseNameStatusZ (keep existing coverage)
// ---------------------------------------------------------------------------

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

  it('skips malformed rename and copy entries without dropping later entries', () => {
    const stdout = 'R100\0src/old.ts\0M\0src/a.ts\0C075\0src/old-copy.ts\0D\0src/b.ts\0';

    assert.deepStrictEqual(parseNameStatusZ(stdout), [
      { status: 'M', path: 'src/a.ts' },
      { status: 'D', path: 'src/b.ts' }
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration-style tests using a fixture Git repo
// ---------------------------------------------------------------------------

describe('GitService working-tree diff helpers (fixture repo)', () => {
  let repoDir: string;
  let baseCommitSha: string;
  let svc: ReturnType<typeof makeService>;

  before(() => {
    // Create a temp git repo with a known state
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelligit-test-'));

    // Initialise repo with deterministic identity
    runGit(['init', '-b', 'main'], repoDir);
    runGit(['config', 'user.email', 'test@example.com'], repoDir);
    runGit(['config', 'user.name', 'Test User'], repoDir);

    // Create initial structure
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'lib'), { recursive: true });

    fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(repoDir, 'lib', 'util.ts'), 'export const y = 2;\n');
    fs.writeFileSync(path.join(repoDir, 'root.txt'), 'root content\n');

    runGit(['add', '.'], repoDir);
    runGit(['commit', '-m', 'Initial commit'], repoDir);
    baseCommitSha = runGit(['rev-parse', 'HEAD'], repoDir).trim();

    // Modify a tracked file and create an untracked file
    fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const x = 42;\n');
    fs.writeFileSync(path.join(repoDir, 'src', 'new-untracked.ts'), 'export const z = 3;\n');
    // Untracked in lib subfolder
    fs.writeFileSync(path.join(repoDir, 'lib', 'extra.ts'), 'export const w = 4;\n');

    svc = makeService(repoDir);
  });

  after(() => {
    // Clean up temp dir
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  // (a) tracked modified + untracked file are both returned
  it('returns tracked modified files and untracked files', async () => {
    const changes = await svc.getFilesChangedBetweenWorkingTreeAndRef(baseCommitSha);

    const paths = changes.map((c) => c.path);
    // src/index.ts is tracked-modified
    assert.ok(paths.includes('src/index.ts'), `expected src/index.ts in: ${JSON.stringify(paths)}`);
    // src/new-untracked.ts is untracked
    assert.ok(paths.includes('src/new-untracked.ts'), `expected src/new-untracked.ts in: ${JSON.stringify(paths)}`);
    // lib/extra.ts is untracked
    assert.ok(paths.includes('lib/extra.ts'), `expected lib/extra.ts in: ${JSON.stringify(paths)}`);

    // Verify tracked vs untracked flags
    const indexed = changes.find((c) => c.path === 'src/index.ts');
    assert.strictEqual(indexed?.untracked, false);
    const newFile = changes.find((c) => c.path === 'src/new-untracked.ts');
    assert.strictEqual(newFile?.untracked, true);
    assert.strictEqual(newFile?.status, 'A');
  });

  // (b) scopePath restricts results to subfolder
  it('restricts results to a given scopePath', async () => {
    const changes = await svc.getFilesChangedBetweenWorkingTreeAndRef(baseCommitSha, 'src');

    const paths = changes.map((c) => c.path);
    // Only src/ entries
    for (const p of paths) {
      assert.ok(p.startsWith('src/'), `unexpected path outside scope: ${p}`);
    }
    // lib/extra.ts must not be present
    assert.ok(!paths.includes('lib/extra.ts'), 'lib/extra.ts should be excluded by scope');
    // src/index.ts and src/new-untracked.ts must be present
    assert.ok(paths.includes('src/index.ts'), 'src/index.ts missing');
    assert.ok(paths.includes('src/new-untracked.ts'), 'src/new-untracked.ts missing');
  });

  // (c) resolveRevisionToCommit with valid sha returns metadata
  it('resolves a valid commit sha to metadata', async () => {
    const meta = await svc.resolveRevisionToCommit(baseCommitSha);
    assert.ok(meta !== undefined, 'expected metadata for valid sha');
    assert.strictEqual(meta.sha, baseCommitSha);
    assert.ok(typeof meta.subject === 'string' && meta.subject.length > 0, 'subject should be non-empty');
    assert.ok(typeof meta.author === 'string' && meta.author.length > 0, 'author should be non-empty');
    assert.ok(typeof meta.date === 'string' && meta.date.length > 0, 'date should be non-empty');
    assert.strictEqual(meta.subject, 'Initial commit');
    assert.strictEqual(meta.author, 'Test User');
  });

  // (c continued) short sha prefix also resolves
  it('resolves a short sha prefix', async () => {
    const shortSha = baseCommitSha.slice(0, 7);
    const meta = await svc.resolveRevisionToCommit(shortSha);
    assert.ok(meta !== undefined, 'expected metadata for short sha');
    assert.strictEqual(meta.sha, baseCommitSha);
  });

  // (d) resolveRevisionToCommit with invalid ref returns undefined
  it('returns undefined for an invalid ref', async () => {
    const meta = await svc.resolveRevisionToCommit('refs/heads/nonexistent-branch-xyz-123');
    assert.strictEqual(meta, undefined);
  });

  it('returns undefined for a nonsense string', async () => {
    const meta = await svc.resolveRevisionToCommit('not-a-real-ref-at-all-9999');
    assert.strictEqual(meta, undefined);
  });
});
