import * as assert from 'assert';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';
import { GraphTreeProvider, LoadMoreTreeItem } from '../providers/graphTreeProvider';
import { StateStore } from '../state/stateStore';
import { CommitFilters, GraphCommit } from '../types';
import { GraphFilterSession } from '../views/graphFilterSession';

function makeCommit(sha: string): GraphCommit {
  return { graph: '-', sha, shortSha: sha.slice(0, 7), parents: [], refs: [], author: 'A', date: '2024-01-01T00:00:00Z', subject: 'msg' };
}

function makeFullPage(size = 200): GraphCommit[] {
  return Array.from({ length: size }, (_, i) => makeCommit(`a${String(i).padStart(39, '0')}`));
}

function makeStubGit(getGraph: (maxCount: number, skip: number, filters?: CommitFilters) => Promise<GraphCommit[]>): unknown {
  return {
    isRepo: async () => true,
    getLocalBranches: async () => [],
    getRemoteBranches: async () => [],
    getRemoteFetchUrls: async () => new Map<string, string>(),
    getTagsBasic: async () => [],
    getTagAvailabilityByRemote: async () => new Map<string, Set<string>>(),
    mergeTagAvailability: (tags: readonly unknown[]) => tags,
    getStashes: async () => [],
    getChangedFiles: async () => [],
    getOperationState: async () => ({ kind: 'none' as const }),
    getMergeConflicts: async () => [],
    getWorktrees: async () => [],
    getSubmodules: async () => [],
    getGraph,
  };
}

function makeWorkspaceState(): vscode.Memento {
  const data = new Map<string, unknown>();
  return {
    keys: () => Array.from(data.keys()) as readonly string[],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      data.has(key) ? (data.get(key) as T) : defaultValue,
    update: async (key: string, value: unknown) => { data.set(key, value); },
  } as vscode.Memento;
}

const stubLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} };

function makeStateStub(graph: GraphCommit[], graphHasMore: boolean): unknown {
  return {
    graph,
    graphHasMore,
    onDidChange: () => ({ dispose: () => {} }),
  };
}

describe('StateStore graph pagination', () => {
  it('loadMoreGraph uses skip=0 on first call and appends results', async () => {
    const calls: Array<{ maxCount: number; skip: number }> = [];
    const page = makeFullPage(200);
    const stubGit = makeStubGit(async (maxCount, skip) => {
      calls.push({ maxCount, skip });
      return page;
    });
    const state = new StateStore(stubGit as never, stubLogger as never, { get: () => undefined } as never, makeWorkspaceState());

    await state.loadMoreGraph();

    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], { maxCount: 200, skip: 0 });
    assert.strictEqual(state.graph.length, 200);
    assert.strictEqual(state.graphHasMore, true);
  });

  it('loadMoreGraph uses skip=prevLength on second call', async () => {
    const calls: Array<{ maxCount: number; skip: number }> = [];
    let callCount = 0;
    const stubGit = makeStubGit(async (maxCount, skip) => {
      calls.push({ maxCount, skip });
      callCount++;
      return callCount === 1 ? makeFullPage(200) : makeFullPage(50);
    });
    const state = new StateStore(stubGit as never, stubLogger as never, { get: () => undefined } as never, makeWorkspaceState());

    await state.loadMoreGraph();
    await state.loadMoreGraph();

    assert.deepStrictEqual(calls[1], { maxCount: 200, skip: 200 });
    assert.strictEqual(state.graph.length, 250);
    assert.strictEqual(state.graphHasMore, false);
  });

  it('loadMoreGraph sets graphHasMore=false on partial page', async () => {
    const stubGit = makeStubGit(async () => makeFullPage(42));
    const state = new StateStore(stubGit as never, stubLogger as never, { get: () => undefined } as never, makeWorkspaceState());

    await state.loadMoreGraph();

    assert.strictEqual(state.graphHasMore, false);
  });

  it('graphHasMore starts false before any load', () => {
    const stubGit = makeStubGit(async () => []);
    const state = new StateStore(stubGit as never, stubLogger as never, { get: () => undefined } as never, makeWorkspaceState());
    assert.strictEqual(state.graphHasMore, false);
  });

  it('refreshGraph resets graphHasMore to false', async () => {
    let callCount = 0;
    const stubGit = makeStubGit(async () => {
      callCount++;
      // First call (loadMoreGraph): full page → hasMore=true
      // Second call (loadGraph via refreshGraph): partial page → hasMore=false
      return callCount === 1 ? makeFullPage(200) : makeFullPage(10);
    });
    const state = new StateStore(stubGit as never, stubLogger as never, { get: () => undefined } as never, makeWorkspaceState());

    await state.loadMoreGraph();
    assert.strictEqual(state.graphHasMore, true, 'should be true after full page');

    await state.refreshGraph({});
    assert.strictEqual(state.graphHasMore, false, 'should be false after partial-page reload');
    assert.strictEqual(state.graph.length, 10, 'graph should be replaced not appended');
  });
});

describe('GraphTreeProvider pagination', () => {
  it('getChildren includes LoadMoreTreeItem when graphHasMore is true', async () => {
    const commits = [makeCommit('abc123' + '0'.repeat(34))];
    const state = makeStateStub(commits, true);
    const provider = new GraphTreeProvider(state as never, {} as never);
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 2);
    const last = children[children.length - 1];
    assert.ok(last instanceof LoadMoreTreeItem, 'last item should be LoadMoreTreeItem');
    assert.strictEqual(last.contextValue, 'graphLoadMore');
    assert.strictEqual(last.command?.command, 'vscodeGitClient.graph.loadMore');
  });

  it('getChildren omits LoadMoreTreeItem when graphHasMore is false', async () => {
    const commits = [makeCommit('abc123' + '0'.repeat(34))];
    const state = makeStateStub(commits, false);
    const provider = new GraphTreeProvider(state as never, {} as never);
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    assert.ok(!(children[0] instanceof LoadMoreTreeItem));
  });
});

describe('GraphFilterSession', () => {
  it('apply loads filtered commits without mutating the master graph snapshot', async () => {
    const masterCommits = [makeCommit('m'.repeat(40))];
    const filteredCommits = [makeCommit('f'.repeat(40))];
    const calls: Array<{ maxCount: number; skip: number; filters?: CommitFilters }> = [];
    const session = new GraphFilterSession(async (maxCount, skip, filters) => {
      calls.push({ maxCount, skip, filters });
      return filteredCommits;
    }, () => 200);

    const snapshot = await session.apply({ message: 'fix' });

    assert.deepStrictEqual(snapshot.commits, filteredCommits);
    assert.deepStrictEqual(masterCommits, [makeCommit('m'.repeat(40))]);
    assert.deepStrictEqual(calls, [{ maxCount: 200, skip: 0, filters: { message: 'fix' } }]);
  });

  it('loadMore starts from the master graph length without appending to the master graph', async () => {
    const masterCommits = [makeCommit('a'.repeat(40)), makeCommit('b'.repeat(40))];
    const nextPage = [makeCommit('c'.repeat(40))];
    const calls: Array<{ maxCount: number; skip: number; filters?: CommitFilters }> = [];
    const session = new GraphFilterSession(async (maxCount, skip, filters) => {
      calls.push({ maxCount, skip, filters });
      return nextPage;
    }, () => 200);

    const result = await session.loadMore({ filters: {}, commits: masterCommits, hasMore: true });

    assert.deepStrictEqual(result, { commits: nextPage, hasMore: false });
    assert.strictEqual(masterCommits.length, 2);
    assert.deepStrictEqual(calls, [{ maxCount: 200, skip: 2, filters: {} }]);
  });
});
