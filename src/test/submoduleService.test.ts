// src/test/submoduleService.test.ts
import * as assert from 'assert';
import { describe, it } from 'node:test';
import { SubmoduleService } from '../services/submoduleService';
import type { SubmoduleLogSink } from '../services/submoduleLogSink';

interface Captured { args: string[]; cwd?: string; }

class FakeSubmoduleService extends SubmoduleService {
  readonly spawned: Captured[] = [];
  readonly headers: string[] = [];

  constructor() {
    super(
      { get: <T>(_k: string, d: T) => d } as never,
      '/repo',
      async () => ({ stdout: '', stderr: '' })
    );
  }

  // Override the private wrapper. Cast through unknown to bypass private access in tests.
  override async ['spawnGitStreaming'](
    args: string[],
    options: { cwd?: string; sink?: SubmoduleLogSink }
  ): Promise<{ exitCode: number | null }> {
    this.spawned.push({ args, cwd: options.cwd });
    return { exitCode: 0 };
  }
}

function recordingSink(): { sink: SubmoduleLogSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      header(line) { lines.push(`H:${line}`); },
      stdout(line) { lines.push(`O:${line}`); },
      stderr(line) { lines.push(`E:${line}`); },
      done() { /* noop */ },
      error() { /* noop */ }
    }
  };
}

describe('SubmoduleService streaming ops', () => {
  it('initAllSubmodules spawns `submodule init` and writes a header', async () => {
    const svc = new FakeSubmoduleService();
    const { sink, lines } = recordingSink();
    const result = await svc.initAllSubmodules({ sink });
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(svc.spawned[0].args, ['submodule', 'init']);
    assert.ok(lines.some(l => l === 'H:$ git submodule init'));
  });

  it('updateAllSubmodules(true) adds --recursive', async () => {
    const svc = new FakeSubmoduleService();
    await svc.updateAllSubmodules(true, { sink: recordingSink().sink });
    assert.deepStrictEqual(svc.spawned[0].args, ['submodule', 'update', '--init', '--recursive']);
  });

  it('updateSubmodule passes the path after `--`', async () => {
    const svc = new FakeSubmoduleService();
    await svc.updateSubmodule('libs/foo', false, { sink: recordingSink().sink });
    assert.deepStrictEqual(svc.spawned[0].args, ['submodule', 'update', '--init', '--', 'libs/foo']);
  });

  it('syncSubmodule with no path syncs all', async () => {
    const svc = new FakeSubmoduleService();
    await svc.syncSubmodule(undefined, true, { sink: recordingSink().sink });
    assert.deepStrictEqual(svc.spawned[0].args, ['submodule', 'sync', '--recursive']);
  });

  it('deinitSubmodule honors force', async () => {
    const svc = new FakeSubmoduleService();
    await svc.deinitSubmodule('libs/foo', true, { sink: recordingSink().sink });
    assert.deepStrictEqual(svc.spawned[0].args, ['submodule', 'deinit', '-f', '--', 'libs/foo']);
  });

  it('pullSubmoduleTrackedBranch sets cwd to the submodule path', async () => {
    const svc = new FakeSubmoduleService();
    await svc.pullSubmoduleTrackedBranch('libs/foo', { sink: recordingSink().sink });
    assert.deepStrictEqual(svc.spawned[0].args, ['pull']);
    assert.strictEqual(svc.spawned[0].cwd, 'libs/foo');
  });

  it('checkoutRecordedSubmoduleCommit spawns submodule update -- <path>', async () => {
    const svc = new FakeSubmoduleService();
    await svc.checkoutRecordedSubmoduleCommit('libs/foo', { sink: recordingSink().sink });
    assert.deepStrictEqual(svc.spawned[0].args, ['submodule', 'update', '--', 'libs/foo']);
  });

  it('initSubmodule passes the path after `--`', async () => {
    const svc = new FakeSubmoduleService();
    await svc.initSubmodule('libs/foo', { sink: recordingSink().sink });
    assert.deepStrictEqual(svc.spawned[0].args, ['submodule', 'init', '--', 'libs/foo']);
  });
});
