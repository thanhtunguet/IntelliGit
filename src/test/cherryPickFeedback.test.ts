import * as assert from 'assert';
import { afterEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { CommandController } from '../commands/commandController';
import { BranchRemoteNode } from '../providers/branchTreeProvider';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const conflictMessage = 'There are some conflicts. You have to resolve them first.';

type GitOverrides = Partial<{
  cherryPick(sha: string): Promise<void>;
  deleteRemote(remoteName: string): Promise<void>;
  mergeIntoCurrent(branch: string): Promise<void>;
  rebaseCurrentOnto(branch: string): Promise<void>;
  setRemoteUrl(remoteName: string, remoteUrl: string): Promise<void>;
}>;

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function registerController(
  events: string[],
  refresh: { promise: Promise<void> },
  overrides: GitOverrides = {},
  captureWarnings = false
): Map<string, (...args: unknown[]) => Promise<void>> {
  const commands = new Map<string, (...args: unknown[]) => Promise<void>>();

  (vscode.commands as unknown as {
    registerCommand: typeof vscode.commands.registerCommand;
  }).registerCommand = (command: string, callback: (...args: unknown[]) => Promise<void>) => {
    commands.set(command, callback);
    return { dispose() { } };
  };

  if (captureWarnings) {
    (vscode.window as unknown as {
      showWarningMessage: typeof vscode.window.showWarningMessage;
    }).showWarningMessage = async (message: string, ...items: unknown[]) => {
      events.push(`warning:${message.split('\n')[0]}`);
      return items.find((item): item is string => typeof item === 'string');
    };
  }

  const controller = new CommandController(
    {
      cherryPick: overrides.cherryPick ?? (async (sha: string) => {
        events.push(`git:cherry-pick:${sha}`);
      }),
      deleteRemote: overrides.deleteRemote ?? (async (remoteName: string) => {
        events.push(`git:delete-remote:${remoteName}`);
      }),
      getMergeConflicts: async () => [{ path: 'src/conflict.ts', status: 'UU' }],
      getOperationState: async () => ({ kind: 'rebase' }),
      mergeIntoCurrent: overrides.mergeIntoCurrent ?? (async (branch: string) => {
        events.push(`git:merge:${branch}`);
      }),
      rebaseContinue: async () => {
        events.push('git:rebase-continue');
      },
      rebaseCurrentOnto: overrides.rebaseCurrentOnto ?? (async (branch: string) => {
        events.push(`git:rebase:${branch}`);
      }),
      setRemoteUrl: overrides.setRemoteUrl ?? (async (remoteName: string, remoteUrl: string) => {
        events.push(`git:set-remote-url:${remoteName}:${remoteUrl}`);
      })
    } as never,
    {
      branches: [],
      conflicts: [],
      refreshAll: () => {
        events.push('refresh:start');
        return refresh.promise.then(() => {
          events.push('refresh:finish');
        });
      },
      refreshBranches: () => {
        events.push('refresh-branches:start');
        return refresh.promise.then(() => {
          events.push('refresh-branches:finish');
        });
      }
    } as never,
    {
      openMergeConflict: async (path: string) => {
        events.push(`open:${path}`);
      }
    } as never,
    { error() { }, warn() { }, info() { } } as never,
    {
      getCommitActionContext: () => undefined,
      getAllFileItems: () => [],
      showCommit: async () => undefined,
      clear: async () => undefined,
      isShowingCommit: () => false
    }
  );

  controller.register({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  return commands;
}

describe('cherry-pick and operation feedback', () => {
  const originalRegisterCommand = vscode.commands.registerCommand;
  const originalShowInformationMessage = vscode.window.showInformationMessage;
  const originalShowInputBox = vscode.window.showInputBox;
  const originalShowWarningMessage = vscode.window.showWarningMessage;

  afterEach(() => {
    (vscode.commands as unknown as { registerCommand: typeof vscode.commands.registerCommand }).registerCommand = originalRegisterCommand;
    (vscode.window as unknown as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = originalShowInformationMessage;
    (vscode.window as unknown as { showInputBox: typeof vscode.window.showInputBox }).showInputBox = originalShowInputBox;
    (vscode.window as unknown as { showWarningMessage: typeof vscode.window.showWarningMessage }).showWarningMessage = originalShowWarningMessage;
  });

  it('shows graph cherry-pick success before waiting for the full refresh to finish', async () => {
    const events: string[] = [];
    const refresh = deferred();
    const commands = registerController(events, refresh);

    (vscode.window as unknown as {
      showInformationMessage: typeof vscode.window.showInformationMessage;
    }).showInformationMessage = async (message: string) => {
      events.push(`message:${message}`);
      return undefined;
    };

    const cherryPick = commands.get('vscodeGitClient.graph.cherryPick');
    assert.ok(cherryPick, 'expected cherry-pick command to be registered');

    const run = cherryPick('abcdef123456');
    await delay(0);

    assert.deepStrictEqual(events, [
      'git:cherry-pick:abcdef123456',
      'refresh:start',
      'message:Cherry-pick succeeded for abcdef12.'
    ]);

    refresh.resolve();
    await run;

    assert.deepStrictEqual(events, [
      'git:cherry-pick:abcdef123456',
      'refresh:start',
      'message:Cherry-pick succeeded for abcdef12.',
      'refresh:finish'
    ]);
  });

  it('shows graph cherry-pick conflict before waiting for the full refresh to finish', async () => {
    const events: string[] = [];
    const refresh = deferred();
    const commands = registerController(events, refresh, {
      cherryPick: async (sha: string) => {
        events.push(`git:cherry-pick:${sha}`);
        throw new Error('CONFLICT (content): Merge conflict in src/conflict.ts');
      }
    }, true);
    const cherryPick = commands.get('vscodeGitClient.graph.cherryPick');
    assert.ok(cherryPick, 'expected cherry-pick command to be registered');

    const run = cherryPick('abcdef123456');
    await delay(0);

    assert.deepStrictEqual(events, [
      'git:cherry-pick:abcdef123456',
      'refresh:start',
      `warning:${conflictMessage}`
    ]);

    refresh.resolve();
    await run;

    assert.deepStrictEqual(events, [
      'git:cherry-pick:abcdef123456',
      'refresh:start',
      `warning:${conflictMessage}`,
      'refresh:finish',
      'open:src/conflict.ts'
    ]);
  });

  it('shows merge conflict before waiting for the full refresh to finish', async () => {
    const events: string[] = [];
    const refresh = deferred();
    const commands = registerController(events, refresh, {
      mergeIntoCurrent: async (branch: string) => {
        events.push(`git:merge:${branch}`);
        throw new Error('Automatic merge failed; fix conflicts and then commit the result.');
      }
    }, true);
    const merge = commands.get('vscodeGitClient.branch.mergeIntoCurrent');
    assert.ok(merge, 'expected merge command to be registered');

    const run = merge('feature/conflict');
    await delay(0);

    assert.deepStrictEqual(events, [
      'warning:Merge into current branch',
      'git:merge:feature/conflict',
      'refresh:start',
      `warning:${conflictMessage}`
    ]);

    refresh.resolve();
    await run;
  });

  it('shows rebase conflict before waiting for the full refresh to finish', async () => {
    const events: string[] = [];
    const refresh = deferred();
    const commands = registerController(events, refresh, {
      rebaseCurrentOnto: async (branch: string) => {
        events.push(`git:rebase:${branch}`);
        throw new Error('CONFLICT (content): Merge conflict in src/conflict.ts');
      }
    }, true);
    const rebase = commands.get('vscodeGitClient.branch.rebaseOnto');
    assert.ok(rebase, 'expected rebase command to be registered');

    const run = rebase('main');
    await delay(0);

    assert.deepStrictEqual(events, [
      'warning:Rebase current branch',
      'git:rebase:main',
      'refresh:start',
      `warning:${conflictMessage}`
    ]);

    refresh.resolve();
    await run;
  });

  it('shows remote URL update success before waiting for branch refresh to finish', async () => {
    const events: string[] = [];
    const refresh = deferred();
    const commands = registerController(events, refresh);

    (vscode.window as unknown as {
      showInputBox: typeof vscode.window.showInputBox;
    }).showInputBox = async () => 'https://github.com/example/new.git';

    (vscode.window as unknown as {
      showInformationMessage: typeof vscode.window.showInformationMessage;
    }).showInformationMessage = async (message: string) => {
      events.push(`message:${message}`);
      return undefined;
    };

    const changeUrl = commands.get('vscodeGitClient.remote.changeUrl');
    assert.ok(changeUrl, 'expected remote URL command to be registered');

    const remote = new BranchRemoteNode('origin', [{
      name: 'origin/main',
      shortName: 'main',
      fullName: 'refs/remotes/origin/main',
      type: 'remote',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/example/old.git',
      ahead: 0,
      behind: 0,
      current: false
    }], 'https://github.com/example/old.git');

    const run = changeUrl(remote);
    await delay(0);

    assert.deepStrictEqual(events, [
      'git:set-remote-url:origin:https://github.com/example/new.git',
      'refresh-branches:start',
      'message:Remote origin URL updated.'
    ]);

    refresh.resolve();
    await run;

    assert.deepStrictEqual(events, [
      'git:set-remote-url:origin:https://github.com/example/new.git',
      'refresh-branches:start',
      'message:Remote origin URL updated.',
      'refresh-branches:finish'
    ]);
  });

  it('confirms and deletes a remote from the Branches remote group', async () => {
    const events: string[] = [];
    const refresh = deferred();
    const commands = registerController(events, refresh, {}, true);

    (vscode.window as unknown as {
      showInformationMessage: typeof vscode.window.showInformationMessage;
    }).showInformationMessage = async (message: string) => {
      events.push(`message:${message}`);
      return undefined;
    };

    const deleteRemote = commands.get('vscodeGitClient.remote.delete');
    assert.ok(deleteRemote, 'expected remote delete command to be registered');

    const remote = new BranchRemoteNode('origin', [{
      name: 'origin/main',
      shortName: 'main',
      fullName: 'refs/remotes/origin/main',
      type: 'remote',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/example/repo.git',
      ahead: 0,
      behind: 0,
      current: false
    }], 'https://github.com/example/repo.git');

    const run = deleteRemote(remote);
    await delay(0);

    assert.deepStrictEqual(events, [
      'warning:Delete remote',
      'git:delete-remote:origin',
      'refresh-branches:start'
    ]);

    refresh.resolve();
    await run;

    assert.deepStrictEqual(events, [
      'warning:Delete remote',
      'git:delete-remote:origin',
      'refresh-branches:start',
      'refresh-branches:finish',
      'message:Deleted remote origin.'
    ]);
  });
});
