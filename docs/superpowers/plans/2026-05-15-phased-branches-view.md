# Phased Branches View Loading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Branches view appear in four progressive phases (local branches → remote branches → tag names → per-remote tag availability) so the slow `git ls-remote --tags <remote>` calls stop blocking the entire view from rendering.

**Architecture:** Split `GitService.getBranches()` and `getTags()` into smaller phase-aligned helpers, keeping the existing combined methods as thin wrappers. Replace `StateStore.loadRefs()` with a sequential 4-phase async flow that mutates `_branches` / `_tags` after each phase and fires `this.emitter` if that phase changed observable state. `RefreshScheduler`'s single-in-flight guarantee is untouched.

**Tech Stack:** TypeScript, VS Code Extension API, git CLI (via existing `runGit`), `node:test`.

**Reference spec:** `docs/superpowers/specs/2026-05-15-phased-branches-view-design.md`.

---

## File Structure

| Path                                                            | Responsibility |
| --------------------------------------------------------------- | -------------- |
| `src/services/gitService.ts`                                    | Extract `getLocalBranches`, `getRemoteBranches`, `getTagsBasic`; make `getRemoteFetchUrls` non-private (still in the class, just remove `private`); keep `getBranches`/`getTags` as wrappers. Reuse the existing sort comparator. |
| `src/state/stateStore.ts`                                       | Replace `loadRefs` body with a private `loadRefsPhased` flow. Each phase mutates state, compares to previous value with a small inline helper, fires emitter when it differs, and is wrapped in `try`/`catch` so a later-phase failure does not erase earlier state. |
| `src/test/stateStoreRefs.test.ts` *(new)*                       | Unit-test the phased loader using a stub `GitService`. Asserts state and emitter-fire ordering. |
| `CHANGELOG.md`                                                  | One line under `[Unreleased] / Changed`. |

---

## Task 0: Split `GitService` ref-loading helpers

**Goal:** Extract phase-aligned helpers from `getBranches()` and `getTags()` without changing the existing public surface, so the state store can call each phase independently.

**Files:**
- Modify: `src/services/gitService.ts` (`getBranches` ~177–239, `getRemoteFetchUrls` ~241–260, `getTags` ~262–296)

**Acceptance Criteria:**
- [ ] `getLocalBranches(): Promise<BranchRef[]>` exists, sorted with the existing comparator restricted to local branches (current branch first, then alpha).
- [ ] `getRemoteBranches(remoteUrls: Map<string, string>): Promise<BranchRef[]>` exists, returning only remote refs, sorted by name; filters out root remote refs (no slash) as today.
- [ ] `getRemoteFetchUrls()` is no longer `private` (no access modifier — package-internal). Existing behaviour unchanged.
- [ ] `getTagsBasic(): Promise<TagRef[]>` exists. Returns tags with `availableOnRemotes: []`, sorted by `lastCommitEpoch` desc then name.
- [ ] `getTagAvailabilityByRemote()` is no longer `private`. Existing behaviour unchanged.
- [ ] `getBranches()` is now a thin wrapper: `const urls = await this.getRemoteFetchUrls(); return [...await this.getLocalBranches(), ...await this.getRemoteBranches(urls)].sort(sameComparator);`.
- [ ] `getTags()` is now a thin wrapper: `const [basic, availability] = await Promise.all([this.getTagsBasic(), this.getTagAvailabilityByRemote()]); return mergeTagAvailability(basic, availability);` (helper defined inside the file).
- [ ] All existing callers of `getBranches()` / `getTags()` continue to compile and return identical data.

**Verify:**
- `npm run check-types` → no errors.
- `npm test` → all existing tests pass (no behavioural change at the public API level).

**Steps:**

- [ ] **Step 1: Replace the body of `getBranches` with the split helpers + wrapper.**

In `src/services/gitService.ts`, replace the current `getBranches` method (lines 177–239) with the following block. Define a private comparator and three methods:

```typescript
private static readonly BRANCH_SORT_COMPARATOR = (a: BranchRef, b: BranchRef): number => {
  if (a.current) { return -1; }
  if (b.current) { return 1; }
  if (a.type !== b.type) { return a.type === 'local' ? -1 : 1; }
  return a.name.localeCompare(b.name);
};

private static readonly BRANCH_FORMAT = [
  '%(refname:short)',
  '%(refname)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(HEAD)',
  '%(committerdate:unix)'
].join(FIELD_SEPARATOR);

private parseBranchLines(stdout: string, remoteUrls: Map<string, string>): BranchRef[] {
  return stdout
    .split(RECORD_SEPARATOR)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, fullName, upstream, track, head, commitEpochRaw] = line.split(FIELD_SEPARATOR);
      const { ahead, behind } = parseTrack(track || '');
      const type: 'local' | 'remote' = fullName.startsWith('refs/remotes/') ? 'remote' : 'local';
      const shortName = type === 'remote' ? name.replace(/^[^/]+\//, '') : name;
      const remoteName = type === 'remote' ? name.split('/')[0] : undefined;
      const commitEpoch = Number.parseInt((commitEpochRaw ?? '').trim(), 10);
      return {
        name,
        shortName,
        fullName,
        type,
        remoteName,
        remoteUrl: remoteName ? remoteUrls.get(remoteName) : undefined,
        upstream: upstream || undefined,
        ahead,
        behind,
        current: head === '*',
        lastCommitEpoch: Number.isNaN(commitEpoch) ? undefined : commitEpoch
      };
    })
    .filter((branch) => {
      // Drop remote root refs like "origin" (no slash).
      return branch.type !== 'remote' || branch.name.includes('/');
    });
}

async getLocalBranches(): Promise<BranchRef[]> {
  const result = await this.runGit([
    'for-each-ref',
    `--format=${GitService.BRANCH_FORMAT}${RECORD_SEPARATOR}`,
    'refs/heads'
  ]);
  return this.parseBranchLines(result.stdout, new Map())
    .sort(GitService.BRANCH_SORT_COMPARATOR);
}

async getRemoteBranches(remoteUrls: Map<string, string>): Promise<BranchRef[]> {
  const result = await this.runGit([
    'for-each-ref',
    `--format=${GitService.BRANCH_FORMAT}${RECORD_SEPARATOR}`,
    'refs/remotes'
  ]);
  return this.parseBranchLines(result.stdout, remoteUrls)
    .sort(GitService.BRANCH_SORT_COMPARATOR);
}

async getBranches(): Promise<BranchRef[]> {
  const remoteUrls = await this.getRemoteFetchUrls();
  const [locals, remotes] = await Promise.all([
    this.getLocalBranches(),
    this.getRemoteBranches(remoteUrls)
  ]);
  return [...locals, ...remotes].sort(GitService.BRANCH_SORT_COMPARATOR);
}
```

- [ ] **Step 2: Remove `private` from `getRemoteFetchUrls`.**

Find `private async getRemoteFetchUrls(): Promise<Map<string, string>>` (around line 241). Change to:

```typescript
async getRemoteFetchUrls(): Promise<Map<string, string>> {
```

- [ ] **Step 3: Split `getTags` similarly.**

Replace the current `getTags` (lines 262–296) with:

```typescript
private static readonly TAG_FORMAT = [
  '%(refname:short)',
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(creatordate:unix)'
].join(FIELD_SEPARATOR);

private static readonly TAG_SORT_COMPARATOR = (a: TagRef, b: TagRef): number => {
  const left = a.lastCommitEpoch ?? 0;
  const right = b.lastCommitEpoch ?? 0;
  if (left !== right) { return right - left; }
  return a.name.localeCompare(b.name);
};

async getTagsBasic(): Promise<TagRef[]> {
  const result = await this.runGit([
    'for-each-ref',
    `--format=${GitService.TAG_FORMAT}${RECORD_SEPARATOR}`,
    'refs/tags'
  ]);
  return result.stdout
    .split(RECORD_SEPARATOR)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, fullName, objectSha, peeledSha, commitEpochRaw] = line.split(FIELD_SEPARATOR);
      const commitEpoch = Number.parseInt((commitEpochRaw ?? '').trim(), 10);
      return {
        name,
        fullName,
        sha: peeledSha || objectSha || undefined,
        availableOnRemotes: [] as string[],
        lastCommitEpoch: Number.isNaN(commitEpoch) ? undefined : commitEpoch
      };
    })
    .sort(GitService.TAG_SORT_COMPARATOR);
}

mergeTagAvailability(
  tags: readonly TagRef[],
  availability: ReadonlyMap<string, ReadonlySet<string>>
): TagRef[] {
  return tags.map((tag) => ({
    ...tag,
    availableOnRemotes: Array.from(availability.get(tag.name) ?? [])
      .sort((a, b) => a.localeCompare(b))
  }));
}

async getTags(): Promise<TagRef[]> {
  const [basic, availability] = await Promise.all([
    this.getTagsBasic(),
    this.getTagAvailabilityByRemote()
  ]);
  return this.mergeTagAvailability(basic, availability);
}
```

- [ ] **Step 4: Remove `private` from `getTagAvailabilityByRemote`.**

Find `private async getTagAvailabilityByRemote(): Promise<Map<string, Set<string>>>` (around line 298). Change to:

```typescript
async getTagAvailabilityByRemote(): Promise<Map<string, Set<string>>> {
```

- [ ] **Step 5: Type-check.**

Run: `npm run check-types`
Expected: no errors.

- [ ] **Step 6: Run tests.**

Run: `npm test`
Expected: all existing tests pass — the public API of `getBranches()` / `getTags()` is unchanged.

- [ ] **Step 7: Commit.**

```bash
git add src/services/gitService.ts
git commit -m "refactor(git): split branch and tag loaders into phase-aligned helpers

Introduce getLocalBranches, getRemoteBranches, getTagsBasic,
mergeTagAvailability. Keep getBranches / getTags as thin wrappers so
existing callers (compare views, graph filters, branch search)
continue to work unchanged. Sets up phased loading in stateStore.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: Phased `StateStore.loadRefs`

**Goal:** Replace `loadRefs()` body with a 4-phase sequential loader that fires `this.emitter` after each phase that changes observable state. Per-phase try/catch so a later-phase failure does not erase earlier state.

**Files:**
- Modify: `src/state/stateStore.ts` (`loadRefs` ~220–224)

**Acceptance Criteria:**
- [ ] Phase A: `_branches` set to result of `getLocalBranches()`. If different from previous `_branches`, fire `emitter`.
- [ ] Phase B: append `getRemoteBranches(remoteUrls)` to `_branches` and re-sort. If different from current value, fire `emitter`.
- [ ] Phase C: `_tags` set to result of `getTagsBasic()`. If different, fire `emitter`.
- [ ] Phase D: `_tags` re-mapped through `mergeTagAvailability(_, await git.getTagAvailabilityByRemote())`. If different, fire `emitter`.
- [ ] Each phase wrapped in `try`/`catch`; catch logs `this.logger.warn(...)` and continues without touching earlier-phase state.
- [ ] No emit is fired if a phase yields a result deeply-equal to the current state.

**Verify:**
- `npm run check-types` → no errors.
- `npm test` → existing tests still pass; new test added in Task 2 also passes.

**Steps:**

- [ ] **Step 1: Add a local equality helper at module scope (top of `src/state/stateStore.ts`, below imports).**

```typescript
function branchesEqual(a: readonly BranchRef[], b: readonly BranchRef[]): boolean {
  if (a.length !== b.length) { return false; }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.name !== right.name ||
      left.type !== right.type ||
      left.current !== right.current ||
      left.upstream !== right.upstream ||
      left.ahead !== right.ahead ||
      left.behind !== right.behind ||
      left.lastCommitEpoch !== right.lastCommitEpoch
    ) {
      return false;
    }
  }
  return true;
}

function tagsEqual(a: readonly TagRef[], b: readonly TagRef[]): boolean {
  if (a.length !== b.length) { return false; }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.name !== right.name ||
      left.sha !== right.sha ||
      left.lastCommitEpoch !== right.lastCommitEpoch ||
      left.availableOnRemotes.length !== right.availableOnRemotes.length ||
      left.availableOnRemotes.some((r, idx) => r !== right.availableOnRemotes[idx])
    ) {
      return false;
    }
  }
  return true;
}
```

If `BranchRef` / `TagRef` are not already imported at the top of `stateStore.ts`, they are — but the type-only import already exists. No new imports needed.

- [ ] **Step 2: Replace `loadRefs` with a phased loader.**

Locate the existing method (around line 220):

```typescript
private async loadRefs(): Promise<void> {
  const [branches, tags] = await Promise.all([this.git.getBranches(), this.git.getTags()]);
  this._branches = branches;
  this._tags = tags;
}
```

Replace with:

```typescript
private async loadRefs(): Promise<void> {
  // Phase A — local branches
  let phaseAOk = false;
  try {
    const locals = await this.git.getLocalBranches();
    if (!branchesEqual(this._branches, locals)) {
      this._branches = locals;
      this.emitter.fire();
    }
    phaseAOk = true;
  } catch (error) {
    this.logger.warn(`Failed to load local branches: ${String(error)}`);
  }

  // Phase B — remote branches
  let remoteUrls = new Map<string, string>();
  try {
    remoteUrls = await this.git.getRemoteFetchUrls();
    const remotes = await this.git.getRemoteBranches(remoteUrls);
    const merged = phaseAOk
      ? [...this._branches.filter((b) => b.type === 'local'), ...remotes]
      : remotes;
    // Sort using the same rules GitService uses: current first, locals before remotes, then alpha.
    merged.sort((a, b) => {
      if (a.current) { return -1; }
      if (b.current) { return 1; }
      if (a.type !== b.type) { return a.type === 'local' ? -1 : 1; }
      return a.name.localeCompare(b.name);
    });
    if (!branchesEqual(this._branches, merged)) {
      this._branches = merged;
      this.emitter.fire();
    }
  } catch (error) {
    this.logger.warn(`Failed to load remote branches: ${String(error)}`);
  }

  // Phase C — tags (basic, no availability)
  let phaseCOk = false;
  try {
    const basic = await this.git.getTagsBasic();
    if (!tagsEqual(this._tags, basic)) {
      this._tags = basic;
      this.emitter.fire();
    }
    phaseCOk = true;
  } catch (error) {
    this.logger.warn(`Failed to load tag list: ${String(error)}`);
  }

  // Phase D — tag remote availability (slowest, network-bound)
  if (!phaseCOk) {
    return;
  }
  try {
    const availability = await this.git.getTagAvailabilityByRemote();
    const enriched = this.git.mergeTagAvailability(this._tags, availability);
    if (!tagsEqual(this._tags, enriched)) {
      this._tags = enriched;
      this.emitter.fire();
    }
  } catch (error) {
    this.logger.warn(`Failed to compute tag remote availability: ${String(error)}`);
  }
}
```

- [ ] **Step 3: Type-check.**

Run: `npm run check-types`
Expected: no errors. (`BranchRef` and `TagRef` are already imported via `import { BranchRef, ..., TagRef, ... } from '../types';`.)

- [ ] **Step 4: Run tests.**

Run: `npm test`
Expected: all existing tests pass. The new test added in Task 2 also passes.

- [ ] **Step 5: Lint.**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit (after Task 2 if you prefer one commit; otherwise commit now).**

```bash
git add src/state/stateStore.ts
git commit -m "feat(refresh): load Branches view in four progressive phases

loadRefs now emits state after each completed phase:
  A) local branches  → for-each-ref refs/heads
  B) remote branches → for-each-ref refs/remotes (+ remote -v)
  C) tag names       → for-each-ref refs/tags
  D) tag remote avail → ls-remote --tags per remote (slowest, network)

A failure in any later phase does not erase earlier-phase data.
RefreshScheduler still serialises full cycles; the mid-cycle emits
all originate from inside one in-flight executeRefresh.

Refs: docs/superpowers/specs/2026-05-15-phased-branches-view-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Phased loader test

**Goal:** Lock in the observable behaviour: state is published incrementally, emitter fires after each meaningful phase, and a phase-D failure does not blow away phase A–C state.

**Files:**
- Create: `src/test/stateStoreRefs.test.ts`

**Acceptance Criteria:**
- [ ] Test "publishes locals first, then remotes, then tags, then availability" passes.
- [ ] Test "tolerates phase-D failure without erasing earlier state" passes.

**Verify:** `npm test -- --test-name-pattern stateStoreRefs` → 2 passing tests.

**Steps:**

- [ ] **Step 1: Write the test file.**

Create `src/test/stateStoreRefs.test.ts`:

```typescript
import * as assert from 'assert';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';
import { StateStore } from '../state/stateStore';
import { BranchRef, TagRef } from '../types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const localBranch = (name: string, current = false): BranchRef => ({
  name,
  shortName: name,
  fullName: `refs/heads/${name}`,
  type: 'local',
  current,
  ahead: 0,
  behind: 0
});

const remoteBranch = (name: string): BranchRef => ({
  name: `origin/${name}`,
  shortName: name,
  fullName: `refs/remotes/origin/${name}`,
  type: 'remote',
  remoteName: 'origin',
  current: false,
  ahead: 0,
  behind: 0
});

const tag = (name: string): TagRef => ({
  name,
  fullName: `refs/tags/${name}`,
  sha: 'aaaa',
  availableOnRemotes: [],
  lastCommitEpoch: 1
});

function makeStubGit(overrides: {
  localBranches?: () => Promise<BranchRef[]>;
  remoteBranches?: () => Promise<BranchRef[]>;
  tagsBasic?: () => Promise<TagRef[]>;
  tagAvailability?: () => Promise<Map<string, Set<string>>>;
}): unknown {
  return {
    isRepo: async () => true,
    getLocalBranches: overrides.localBranches ?? (async () => []),
    getRemoteBranches: overrides.remoteBranches ?? (async () => []),
    getRemoteFetchUrls: async () => new Map<string, string>(),
    getTagsBasic: overrides.tagsBasic ?? (async () => []),
    getTagAvailabilityByRemote: overrides.tagAvailability ?? (async () => new Map<string, Set<string>>()),
    mergeTagAvailability: (tags: readonly TagRef[], availability: ReadonlyMap<string, ReadonlySet<string>>) =>
      tags.map((t) => ({
        ...t,
        availableOnRemotes: Array.from(availability.get(t.name) ?? []).sort((a, b) => a.localeCompare(b))
      })),
    // Methods called by other scopes — return safe defaults so executeRefresh works
    // even though we only request 'refs'.
    getStashes: async () => [],
    getWorkingTreeChanges: async () => [],
    getOperationState: async () => ({ kind: 'none' as const }),
    getMergeConflictFiles: async () => [],
    getGraph: async () => [],
    getWorktrees: async () => [],
    getSubmodules: async () => []
  };
}

function makeLogger(): unknown {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    dispose: () => undefined
  };
}

function makeWorkspaceState(): vscode.Memento {
  const data = new Map<string, unknown>();
  return {
    keys: () => Array.from(data.keys()) as readonly string[],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      (data.has(key) ? (data.get(key) as T) : defaultValue),
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    }
  } as vscode.Memento;
}

describe('StateStore refs phased loader', () => {
  it('publishes locals first, then remotes, then tags, then availability', async () => {
    const localD = deferred<BranchRef[]>();
    const remoteD = deferred<BranchRef[]>();
    const tagsD = deferred<TagRef[]>();
    const availD = deferred<Map<string, Set<string>>>();

    const stubGit = makeStubGit({
      localBranches: () => localD.promise,
      remoteBranches: () => remoteD.promise,
      tagsBasic: () => tagsD.promise,
      tagAvailability: () => availD.promise
    });

    const store = new StateStore(
      stubGit as never,
      makeLogger() as never,
      { get: () => undefined } as never,
      makeWorkspaceState()
    );

    const snapshots: Array<{ branches: number; tags: number; firstTagAvail: number }> = [];
    store.onDidChange(() => {
      snapshots.push({
        branches: store.branches.length,
        tags: store.tags.length,
        firstTagAvail: store.tags[0]?.availableOnRemotes.length ?? 0
      });
    });

    const refreshPromise = store.refreshBranches();

    // Resolve phases one at a time and let microtasks drain after each.
    localD.resolve([localBranch('main', true)]);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(store.branches.length, 1, 'locals visible after phase A');
    assert.strictEqual(store.tags.length, 0, 'tags not yet loaded');

    remoteD.resolve([remoteBranch('main'), remoteBranch('feature')]);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(store.branches.length, 3, 'remotes appended after phase B');
    assert.strictEqual(store.tags.length, 0, 'tags still not loaded');

    tagsD.resolve([tag('v1.0.0'), tag('v0.9.0')]);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(store.tags.length, 2, 'tags visible after phase C');
    assert.strictEqual(store.tags[0].availableOnRemotes.length, 0, 'no availability yet');

    availD.resolve(new Map([['v1.0.0', new Set(['origin'])]]));
    await refreshPromise;

    assert.strictEqual(store.tags[0].availableOnRemotes.length, 1, 'availability enriches phase D');
    assert.ok(snapshots.length >= 3, `expected at least 3 emits, got ${snapshots.length}`);
  });

  it('tolerates phase-D failure without erasing earlier state', async () => {
    const stubGit = makeStubGit({
      localBranches: async () => [localBranch('main', true)],
      remoteBranches: async () => [remoteBranch('feature')],
      tagsBasic: async () => [tag('v1.0.0')],
      tagAvailability: async () => {
        throw new Error('network down');
      }
    });

    const store = new StateStore(
      stubGit as never,
      makeLogger() as never,
      { get: () => undefined } as never,
      makeWorkspaceState()
    );

    await store.refreshBranches();

    assert.strictEqual(store.branches.length, 2, 'branches preserved despite phase D failure');
    assert.strictEqual(store.tags.length, 1, 'tag list preserved despite phase D failure');
    assert.deepStrictEqual(store.tags[0].availableOnRemotes, [], 'availability stays empty');
  });
});
```

> Note: the stub `GitService` only needs to satisfy the methods `StateStore` actually calls. `as never` casts are intentional — they bypass full structural typing for fields we don't use in this test. This is a common pattern in this repo (see `cherryPickFeedback.test.ts`).

- [ ] **Step 2: Run the new test.**

Run: `npm test -- --test-name-pattern stateStoreRefs`
Expected: 2 tests pass.

- [ ] **Step 3: Run the full suite.**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Lint.**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit.**

```bash
git add src/test/stateStoreRefs.test.ts
git commit -m "test(state): cover phased Branches view loader

Asserts that locals, remotes, tag names, and tag availability appear in
order, and that a network failure during the slow phase-D ls-remote
calls does not erase data already published in phases A through C.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Changelog

**Goal:** Document the user-visible behaviour change.

**Files:**
- Modify: `CHANGELOG.md`

**Acceptance Criteria:**
- [ ] One bullet added under `## [Unreleased]` / `### Changed`.

**Verify:** `git diff CHANGELOG.md` shows exactly one bullet added.

**Steps:**

- [ ] **Step 1: Read and update `CHANGELOG.md`.**

Open `CHANGELOG.md`. Under `## [Unreleased]` → `### Changed`, immediately above the existing "Auto-refresh on external git changes" entry, insert:

```markdown
- **Branches view — progressive loading** — the Branches view now appears in four phases instead of waiting for everything before showing anything: local branches first, then remote branches, then tag names, then per-remote tag availability annotations (the network-bound `git ls-remote --tags` calls). A failure in any later phase no longer erases data already published by earlier phases.
```

- [ ] **Step 2: Commit.**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for phased Branches view loading

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section / goal                                              | Task |
| ---------------------------------------------------------------- | ---- |
| Local branches appear first                                      | Task 1 (Phase A) |
| Remote branches appear next                                      | Task 1 (Phase B) |
| Tag names appear before per-remote availability                  | Task 1 (Phase C) |
| Tag remote-availability fills in last                            | Task 1 (Phase D) |
| RefreshScheduler invariant preserved                             | Task 1 — no scheduler changes |
| Per-phase error isolation                                        | Task 1 (try/catch each phase) + Task 2 (test) |
| Public `getBranches` / `getTags` shape unchanged                 | Task 0 (wrappers) |
| Unit test for phased loader                                      | Task 2 |
| Changelog                                                        | Task 3 |

**Non-goals confirmed absent:** no VS Code API switch for enumeration, no loading skeleton, no scheduler changes.

**Placeholder scan:** all code blocks are complete. No "TODO" / "TBD" / "appropriate error handling" placeholders. Per-phase error handling is explicit `try`/`catch` with `logger.warn(...)`.

**Type consistency:**
- `getLocalBranches` / `getRemoteBranches` / `getTagsBasic` defined in Task 0, consumed in Task 1, stubbed in Task 2.
- `mergeTagAvailability` defined as an instance method on `GitService` in Task 0 (so `this.git.mergeTagAvailability(...)` works in Task 1) and stubbed identically in Task 2.
- `getRemoteFetchUrls` and `getTagAvailabilityByRemote` are made non-private in Task 0 (called from Task 1).
- `BranchRef` / `TagRef` already in `src/types.ts` and imported by both `gitService.ts` and `stateStore.ts`.

---

## Execution
