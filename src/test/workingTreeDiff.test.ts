import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, before, after } from 'node:test';
import { parseNameStatusZ } from '../services/gitParsing';
import { GitService } from '../services/gitService';

// ---------------------------------------------------------------------------
// Minimal stub implementations for GitService constructor dependencies.
// GitService requires: RepositoryContext, Logger, vscode.WorkspaceConfiguration.
// We satisfy these via duck-typed plain objects — no real vscode APIs needed
// for getFilesChangedBetweenWorkingTreeAndRef and resolveRevisionToCommit.
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: () => { /* noop */ },
    warn: () => { /* noop */ },
    error: () => { /* noop */ },
    show: () => { /* noop */ },
    dispose: () => { /* noop */ }
  };
}

function makeConfig() {
  return {
    get: <T>(key: string, defaultValue: T): T => {
      if (key === 'gitPath') { return 'git' as unknown as T; }
      if (key === 'commandTimeoutMs') { return 15000 as unknown as T; }
      return defaultValue;
    }
  };
}

function makeRepositoryContext(repoRoot: string) {
  return {
    rootPath: repoRoot,
    rootUri: { fsPath: repoRoot, toString: () => repoRoot }
  };
}

// ---------------------------------------------------------------------------
// Helpers for fixture repo setup
// ---------------------------------------------------------------------------

function runGit(args: string[], cwd: string): string {
  const result = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
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

  it('correctly handles a single uppercase-letter filename after R/C without false-positiving', () => {
    // A file genuinely named "A" is the new-path of a rename — must be emitted, not skipped.
    const stdout = 'R100\0src/old.ts\0A\0';
    assert.deepStrictEqual(parseNameStatusZ(stdout), [
      { status: 'R', path: 'A' }
    ]);
  });

  it('stops safely when R/C entry is missing its new-path token (truncated input)', () => {
    // Only oldPath follows R100; newPath is absent — stop without emitting the partial entry.
    const stdout = 'M\0src/a.ts\0R100\0src/old.ts';
    assert.deepStrictEqual(parseNameStatusZ(stdout), [
      { status: 'M', path: 'src/a.ts' }
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration-style tests using a fixture Git repo + real GitService instance
// ---------------------------------------------------------------------------

describe('GitService working-tree diff helpers (fixture repo)', () => {
  let repoDir: string;
  let baseCommitSha: string;
  let git: GitService;

  before(() => {
    // Create a temp git repo with a known state
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscodegitclient-test-'));

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

    // Add a file that will later be deleted to exercise the D status path
    fs.writeFileSync(path.join(repoDir, 'src', 'to-delete.ts'), 'export const del = 0;\n');

    runGit(['add', '.'], repoDir);
    runGit(['commit', '-m', 'Initial commit'], repoDir);
    baseCommitSha = runGit(['rev-parse', 'HEAD'], repoDir).trim();

    // Modify a tracked file, create untracked files, and delete a tracked file
    fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const x = 42;\n');
    fs.writeFileSync(path.join(repoDir, 'src', 'new-untracked.ts'), 'export const z = 3;\n');
    // Untracked in lib subfolder
    fs.writeFileSync(path.join(repoDir, 'lib', 'extra.ts'), 'export const w = 4;\n');
    // Delete a tracked file (without staging) — git diff will report it as D
    fs.unlinkSync(path.join(repoDir, 'src', 'to-delete.ts'));

    // Instantiate the real GitService with minimal stubs
    git = new GitService(
      makeRepositoryContext(repoDir) as never,
      makeLogger() as never,
      makeConfig() as never
    );
  });

  after(() => {
    // Clean up temp dir
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  // (a) tracked modified + untracked files are both returned
  it('returns tracked modified files and untracked files', async () => {
    const changes = await git.getFilesChangedBetweenWorkingTreeAndRef(baseCommitSha);

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

  // (a-new) deleted tracked file appears with status D and untracked:false
  it('reports a deleted tracked file with status D and untracked:false', async () => {
    const changes = await git.getFilesChangedBetweenWorkingTreeAndRef(baseCommitSha);

    const deleted = changes.find((c) => c.path === 'src/to-delete.ts');
    assert.ok(deleted !== undefined, 'expected src/to-delete.ts to appear in results');
    assert.strictEqual(deleted.status, 'D', `expected status D, got ${deleted?.status}`);
    assert.strictEqual(deleted.untracked, false);
  });

  // (b) scopePath restricts results to subfolder
  it('restricts results to a given scopePath', async () => {
    const changes = await git.getFilesChangedBetweenWorkingTreeAndRef(baseCommitSha, 'src');

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
    const meta = await git.resolveRevisionToCommit(baseCommitSha);
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
    const meta = await git.resolveRevisionToCommit(shortSha);
    assert.ok(meta !== undefined, 'expected metadata for short sha');
    assert.strictEqual(meta.sha, baseCommitSha);
  });

  // (d) resolveRevisionToCommit with invalid ref returns undefined
  it('returns undefined for an invalid ref', async () => {
    const meta = await git.resolveRevisionToCommit('refs/heads/nonexistent-branch-xyz-123');
    assert.strictEqual(meta, undefined);
  });

  it('returns undefined for a nonsense string', async () => {
    const meta = await git.resolveRevisionToCommit('not-a-real-ref-at-all-9999');
    assert.strictEqual(meta, undefined);
  });
});

describe('GitService graph branch filtering', () => {
  let repoDir: string;
  let git: GitService;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscodegitclient-graph-filter-'));
    runGit(['init', '-b', 'main'], repoDir);
    runGit(['config', 'user.email', 'test@example.com'], repoDir);
    runGit(['config', 'user.name', 'Test User'], repoDir);

    fs.writeFileSync(path.join(repoDir, 'history.txt'), 'base\n');
    runGit(['add', '.'], repoDir);
    runGit(['commit', '-m', 'base'], repoDir);

    runGit(['checkout', '-b', 'feature/login'], repoDir);
    fs.appendFileSync(path.join(repoDir, 'history.txt'), 'feature\n');
    runGit(['commit', '-am', 'feature commit'], repoDir);

    runGit(['checkout', 'main'], repoDir);
    fs.appendFileSync(path.join(repoDir, 'history.txt'), 'main\n');
    runGit(['commit', '-am', 'main commit'], repoDir);

    git = new GitService(
      makeRepositoryContext(repoDir) as never,
      makeLogger() as never,
      makeConfig() as never
    );
  });

  after(() => {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch { }
  });

  it('filters graph by an exact branch name', async () => {
    const commits = await git.getGraph(100, 0, { branch: 'feature/login' });
    assert.ok(commits.length > 0);
    assert.ok(commits.some((commit) => commit.refs.some((ref) => ref.includes('refs/heads/feature/login'))));
  });

  it('accepts partial branch keywords without throwing', async () => {
    await assert.doesNotReject(async () => {
      const commits = await git.getGraph(100, 0, { branch: 'feature' });
      assert.ok(commits.some((commit) => commit.refs.some((ref) => ref.includes('feature/login'))));
    });
  });

  it('returns empty graph for unknown branch keywords instead of throwing', async () => {
    const commits = await git.getGraph(100, 0, { branch: 'unknown-branch-keyword-xyz' });
    assert.deepStrictEqual(commits, []);
  });

  it('uses exact branch selection when full branch name is provided', async () => {
    runGit(['checkout', '-b', 'feature/login-helper'], repoDir);
    fs.appendFileSync(path.join(repoDir, 'history.txt'), 'helper\n');
    runGit(['commit', '-am', 'helper branch commit'], repoDir);
    runGit(['checkout', 'main'], repoDir);

    const commits = await git.getGraph(200, 0, { branch: 'feature/login' });
    assert.ok(commits.some((commit) => commit.subject === 'feature commit'));
    assert.ok(!commits.some((commit) => commit.subject === 'helper branch commit'));
  });

  it('treats message as text filter and never throws on unknown revision-like tokens', async () => {
    await assert.doesNotReject(async () => {
      const commits = await git.getGraph(100, 0, { message: 'deadbeefcafebabe1234' });
      assert.ok(Array.isArray(commits));
    });
  });

  it('does not treat non-commit object IDs as revisions in message filter', async () => {
    const blobSha = runGit(['hash-object', 'history.txt'], repoDir).trim();
    await assert.doesNotReject(async () => {
      const commits = await git.getGraph(100, 0, { message: blobSha });
      assert.ok(Array.isArray(commits));
    });
  });
});

describe('GitService graph scope across refs', () => {
  let repoDir: string;
  let git: GitService;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscodegitclient-graph-scope-'));
    runGit(['init', '-b', 'main'], repoDir);
    runGit(['config', 'user.email', 'test@example.com'], repoDir);
    runGit(['config', 'user.name', 'Test User'], repoDir);

    fs.writeFileSync(path.join(repoDir, 'scope.txt'), 'base\n');
    runGit(['add', '.'], repoDir);
    runGit(['commit', '-m', 'base'], repoDir);

    runGit(['checkout', '-b', 'feature/only-local'], repoDir);
    fs.appendFileSync(path.join(repoDir, 'scope.txt'), 'local\n');
    runGit(['commit', '-am', 'local branch only commit'], repoDir);

    runGit(['checkout', 'main'], repoDir);

    git = new GitService(
      makeRepositoryContext(repoDir) as never,
      makeLogger() as never,
      makeConfig() as never
    );
  });

  after(() => {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch { }
  });

  it('includes commits from non-current local branches in graph view', async () => {
    const commits = await git.getGraph(200, 0);
    assert.ok(commits.some((commit) => commit.subject === 'local branch only commit'));
  });
});

describe('GitService graph scope includes remote tracking refs', () => {
  let rootDir: string;
  let originDir: string;
  let localDir: string;
  let git: GitService;

  before(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscodegitclient-graph-remote-scope-'));
    originDir = path.join(rootDir, 'origin.git');
    localDir = path.join(rootDir, 'local');
    fs.mkdirSync(localDir, { recursive: true });

    runGit(['init', '--bare', originDir], rootDir);

    runGit(['init', '-b', 'main'], localDir);
    runGit(['config', 'user.email', 'test@example.com'], localDir);
    runGit(['config', 'user.name', 'Test User'], localDir);

    fs.writeFileSync(path.join(localDir, 'remote-scope.txt'), 'base\n');
    runGit(['add', '.'], localDir);
    runGit(['commit', '-m', 'base'], localDir);
    runGit(['remote', 'add', 'origin', originDir], localDir);
    runGit(['push', '-u', 'origin', 'main'], localDir);

    runGit(['checkout', '-b', 'feature/remote-only'], localDir);
    fs.appendFileSync(path.join(localDir, 'remote-scope.txt'), 'remote\n');
    runGit(['commit', '-am', 'remote-only branch commit'], localDir);
    runGit(['push', '-u', 'origin', 'feature/remote-only'], localDir);

    runGit(['checkout', 'main'], localDir);
    runGit(['branch', '-D', 'feature/remote-only'], localDir);
    runGit(['fetch', '--prune', 'origin'], localDir);

    git = new GitService(
      makeRepositoryContext(localDir) as never,
      makeLogger() as never,
      makeConfig() as never
    );
  });

  after(() => {
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch { }
  });

  it('includes commits reachable only from remote-tracking branches', async () => {
    const commits = await git.getGraph(300, 0);
    assert.ok(commits.some((commit) => commit.subject === 'remote-only branch commit'));
  });
});
