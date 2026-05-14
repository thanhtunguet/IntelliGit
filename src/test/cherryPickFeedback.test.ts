import * as assert from 'assert';
import { afterEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { CommandController } from '../commands/commandController';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('cherry-pick feedback', () => {
  const originalRegisterCommand = vscode.commands.registerCommand;
  const originalShowInformationMessage = vscode.window.showInformationMessage;

  afterEach(() => {
    (vscode.commands as unknown as { registerCommand: typeof vscode.commands.registerCommand }).registerCommand = originalRegisterCommand;
    (vscode.window as unknown as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = originalShowInformationMessage;
  });

  it('shows graph cherry-pick success before waiting for the full refresh to finish', async () => {
    const events: string[] = [];
    const commands = new Map<string, (...args: unknown[]) => Promise<void>>();
    const refresh = deferred();

    (vscode.commands as unknown as {
      registerCommand: typeof vscode.commands.registerCommand;
    }).registerCommand = (command: string, callback: (...args: unknown[]) => Promise<void>) => {
      commands.set(command, callback);
      return { dispose() { } };
    };

    (vscode.window as unknown as {
      showInformationMessage: typeof vscode.window.showInformationMessage;
    }).showInformationMessage = async (message: string) => {
      events.push(`message:${message}`);
      return undefined;
    };

    const controller = new CommandController(
      {
        cherryPick: async (sha: string) => {
          events.push(`git:${sha}`);
        }
      } as never,
      {
        refreshAll: () => {
          events.push('refresh:start');
          return refresh.promise.then(() => {
            events.push('refresh:finish');
          });
        }
      } as never,
      {} as never,
      { error() { }, warn() { }, info() { } } as never,
      {
        getCommitActionContext: () => undefined,
        getAllFileItems: () => [],
        showCommit: async () => undefined
      }
    );

    controller.register({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    const cherryPick = commands.get('intelliGit.graph.cherryPick');
    assert.ok(cherryPick, 'expected cherry-pick command to be registered');

    const run = cherryPick('abcdef123456');
    await delay(0);

    assert.deepStrictEqual(events, [
      'git:abcdef123456',
      'refresh:start',
      'message:Cherry-pick succeeded for abcdef12.'
    ]);

    refresh.resolve();
    await run;

    assert.deepStrictEqual(events, [
      'git:abcdef123456',
      'refresh:start',
      'message:Cherry-pick succeeded for abcdef12.',
      'refresh:finish'
    ]);
  });
});
