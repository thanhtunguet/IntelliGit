import * as assert from 'assert';
import { afterEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { CommandController } from '../commands/commandController';
import { GraphCommit } from '../types';

function createGraphCommit(sha: string, subject: string): GraphCommit {
  return {
    sha,
    shortSha: sha.slice(0, 8),
    parents: [],
    refs: [],
    author: 'Tester',
    date: '2026-05-24T00:00:00.000Z',
    subject
  };
}

function registerController(params: {
  git?: Record<string, unknown>;
  state?: Record<string, unknown>;
  commitFilesView?: {
    getCommitActionContext(selectedItems: readonly unknown[]): unknown;
    getAllFileItems(): unknown[];
    showCommit(sha: string, subject: string): Promise<void>;
    clear(): Promise<void>;
    isShowingCommit(sha: string): boolean;
  };
}): Map<string, (...args: unknown[]) => Promise<void>> {
  const commands = new Map<string, (...args: unknown[]) => Promise<void>>();
  (vscode.commands as unknown as {
    registerCommand: typeof vscode.commands.registerCommand;
  }).registerCommand = (command: string, callback: (...args: unknown[]) => Promise<void>) => {
    commands.set(command, callback);
    return { dispose() { } };
  };

  const controller = new CommandController(
    (params.git ?? {}) as never,
    (params.state ?? { branches: [], conflicts: [], graph: [], refreshAll: async () => undefined }) as never,
    {} as never,
    { error() { }, warn() { }, info() { } } as never,
    (params.commitFilesView ?? {
      getCommitActionContext: () => undefined,
      getAllFileItems: () => [],
      showCommit: async () => undefined,
      clear: async () => undefined,
      isShowingCommit: () => false
    }) as never
  );
  controller.register({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  return commands;
}

describe('commit details behaviors', () => {
  const originalRegisterCommand = vscode.commands.registerCommand;
  const originalShowQuickPick = vscode.window.showQuickPick;
  const originalShowInformationMessage = vscode.window.showInformationMessage;

  afterEach(() => {
    (vscode.commands as unknown as { registerCommand: typeof vscode.commands.registerCommand }).registerCommand = originalRegisterCommand;
    (vscode.window as unknown as { showQuickPick: typeof vscode.window.showQuickPick }).showQuickPick = originalShowQuickPick;
    (vscode.window as unknown as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = originalShowInformationMessage;
  });

  it('toggles commit details off when opening the same commit again', async () => {
    const events: string[] = [];
    const sha = 'abcdef1234567890';
    const subject = 'Refactor commit details';
    const commands = registerController({
      state: {
        branches: [],
        conflicts: [],
        graph: [createGraphCommit(sha, subject)]
      },
      commitFilesView: {
        getCommitActionContext: () => undefined,
        getAllFileItems: () => [],
        showCommit: async (commitSha: string) => {
          events.push(`show:${commitSha}`);
        },
        clear: async () => {
          events.push('clear');
        },
        isShowingCommit: (commitSha: string) => commitSha === sha
      }
    });

    const openDetails = commands.get('vscodeGitClient.graph.openDetails');
    assert.ok(openDetails, 'expected open details command');

    await openDetails(sha);
    assert.deepStrictEqual(events, ['clear']);
  });

});
