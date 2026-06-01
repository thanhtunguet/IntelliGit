// src/test/submoduleStreaming.test.ts
import * as assert from 'assert';
import { describe, it } from 'node:test';
import { spawnGitStreaming } from '../services/submoduleService';
import type { SubmoduleLogSink } from '../services/submoduleLogSink';

interface RecordedCall {
  type: 'stdout' | 'stderr' | 'done' | 'error';
  payload: unknown;
}

function recorder(): { sink: SubmoduleLogSink; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    sink: {
      header(line) { calls.push({ type: 'stdout', payload: `HEADER:${line}` }); },
      stdout(line) { calls.push({ type: 'stdout', payload: line }); },
      stderr(line) { calls.push({ type: 'stderr', payload: line }); },
      done(exitCode, durationMs) { calls.push({ type: 'done', payload: { exitCode, durationMs } }); },
      error(err) { calls.push({ type: 'error', payload: err.message }); }
    }
  };
}

// Helper: spawn `node -e '<script>'` instead of git, so tests are deterministic.
function runNode(script: string, signal?: AbortSignal) {
  const { sink, calls } = recorder();
  return {
    calls,
    promise: spawnGitStreaming(
      'node',
      ['-e', script],
      { gitRoot: process.cwd(), sink, signal }
    )
  };
}

describe('spawnGitStreaming', () => {
  it('forwards stdout lines individually', async () => {
    const { promise, calls } = runNode(`process.stdout.write('one\\ntwo\\nthree\\n');`);
    const result = await promise;
    assert.strictEqual(result.exitCode, 0);
    const stdouts = calls.filter(c => c.type === 'stdout').map(c => c.payload);
    assert.deepStrictEqual(stdouts, ['one', 'two', 'three']);
  });

  it('flushes a trailing partial line on close', async () => {
    const { promise, calls } = runNode(`process.stdout.write('partial');`);
    await promise;
    const stdouts = calls.filter(c => c.type === 'stdout').map(c => c.payload);
    assert.deepStrictEqual(stdouts, ['partial']);
  });

  it('resolves with non-zero exit code without throwing', async () => {
    const { promise, calls } = runNode(`process.stderr.write('boom\\n'); process.exit(2);`);
    const result = await promise;
    assert.strictEqual(result.exitCode, 2);
    const stderrs = calls.filter(c => c.type === 'stderr').map(c => c.payload);
    assert.deepStrictEqual(stderrs, ['boom']);
  });

  it('collapses \\r-only progress segments to the final segment per chunk', async () => {
    const { promise, calls } = runNode(
      `process.stderr.write('Receiving 1%\\rReceiving 50%\\rReceiving 100%\\n');`
    );
    await promise;
    const stderrs = calls.filter(c => c.type === 'stderr').map(c => c.payload);
    assert.deepStrictEqual(stderrs, ['Receiving 100%']);
  });

  it('honors AbortSignal by killing the child', async () => {
    const controller = new AbortController();
    const { promise, calls } = runNode(
      `setInterval(() => process.stdout.write('tick\\n'), 50);`,
      controller.signal
    );
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    assert.strictEqual(result.exitCode, null);
    const doneCall = calls.find(c => c.type === 'done');
    assert.ok(doneCall, 'expected done() to be called');
  });
});
