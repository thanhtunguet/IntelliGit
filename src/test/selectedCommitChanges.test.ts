import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, afterEach } from 'node:test';
import * as vscode from 'vscode';
import { CommandController } from '../commands/commandController';
import { GraphCommitFileTreeItem } from '../providers/graphTreeProvider';
import { GitService } from '../services/gitService';
import { GraphCommit } from '../types';

function execGit(cwd: string, args: string[]): string {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function createGraphCommit(sha: string): GraphCommit {
  return {
    sha,
    shortSha: sha.slice(0, 8),
    parents: [],
    refs: [],
    author: 'Tester',
    date: '2026-05-22T00:00:00.000Z',
    subject: 'backup change'
  };
}

function registerController(
  git: Record<string, unknown>,
  state: Record<string, unknown>
): Map<string, (...args: unknown[]) => Promise<void>> {
  const commands = new Map<string, (...args: unknown[]) => Promise<void>>();

  (vscode.commands as unknown as {
    registerCommand: typeof vscode.commands.registerCommand;
  }).registerCommand = (command: string, callback: (...args: unknown[]) => Promise<void>) => {
    commands.set(command, callback);
    return { dispose() { } };
  };

  const controller = new CommandController(
    git as never,
    state as never,
    {} as never,
    { error() { }, warn() { }, info() { } } as never,
    {
      getCommitActionContext: () => undefined,
      getAllFileItems: () => [],
      showCommit: async () => undefined
    }
  );

  controller.register({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  return commands;
}

describe('selected commit file changes', () => {
  const originalRegisterCommand = vscode.commands.registerCommand;
  const originalShowInformationMessage = vscode.window.showInformationMessage;
  const originalShowWarningMessage = vscode.window.showWarningMessage;

  afterEach(() => {
    (vscode.commands as unknown as { registerCommand: typeof vscode.commands.registerCommand }).registerCommand = originalRegisterCommand;
    (vscode.window as unknown as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = originalShowInformationMessage;
    (vscode.window as unknown as { showWarningMessage: typeof vscode.window.showWarningMessage }).showWarningMessage = originalShowWarningMessage;
  });

  it('cherry-picks multiple selected Git Graph file rows from the same commit', async () => {
    const events: string[] = [];
    const sha = 'abcdef1234567890';
    const commit = createGraphCommit(sha);
    const first = new GraphCommitFileTreeItem(commit, 'src/a.ts', '/repo', false);
    const second = new GraphCommitFileTreeItem(commit, 'src/b.ts', '/repo', false);

    (vscode.window as unknown as {
      showWarningMessage: typeof vscode.window.showWarningMessage;
    }).showWarningMessage = async (_message: string, _options: unknown, acceptLabel: string) => acceptLabel;
    (vscode.window as unknown as {
      showInformationMessage: typeof vscode.window.showInformationMessage;
    }).showInformationMessage = async (message: string) => {
      events.push(`message:${message}`);
      return undefined;
    };

    const commands = registerController(
      {
        isCommitInCurrentBranch: async () => false,
        cherryPickCommitFiles: async (ref: string, filePaths: string[]) => {
          events.push(`git:cherry-pick-files:${ref}:${filePaths.join(',')}`);
        }
      },
      {
        branches: [],
        conflicts: [],
        refreshAll: async () => {
          events.push('refresh');
        }
      }
    );

    const cherryPick = commands.get('vscodeGitClient.commit.cherryPickSelectedChanges');
    assert.ok(cherryPick, 'expected selected-changes cherry-pick command to be registered');

    await cherryPick(first, [first, second]);

    assert.deepStrictEqual(events, [
      `git:cherry-pick-files:${sha}:src/a.ts,src/b.ts`,
      'refresh',
      `message:Cherry-picked selected changes from ${sha.slice(0, 8)} into the current checkout.`
    ]);
  });

  it('applies selected cherry-picked file changes to the current checkout without creating a commit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-git-client-selected-changes-'));
    try {
      execGit(root, ['init', '-q', '-b', 'dev']);
      execGit(root, ['config', 'user.email', 'tester@example.com']);
      execGit(root, ['config', 'user.name', 'Tester']);
      fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
      execGit(root, ['add', 'file.txt']);
      execGit(root, ['commit', '-q', '-m', 'base']);
      execGit(root, ['checkout', '-q', '-b', 'backup']);
      fs.writeFileSync(path.join(root, 'file.txt'), 'base\nbackup\n');
      execGit(root, ['commit', '-am', 'backup change', '-q']);
      const backupSha = execGit(root, ['rev-parse', 'HEAD']).trim();
      execGit(root, ['checkout', '-q', 'dev']);

      const service = new GitService(
        {
          rootUri: vscode.Uri.file(root),
          rootPath: root
        },
        { error() { }, warn() { }, info() { } } as never,
        vscode.workspace.getConfiguration()
      );

      await service.cherryPickCommitFiles(backupSha, ['file.txt']);

      assert.strictEqual(execGit(root, ['rev-list', '--count', 'HEAD']).trim(), '1');
      assert.strictEqual(execGit(root, ['status', '--short']).trim(), 'M  file.txt');
      assert.ok(fs.readFileSync(path.join(root, 'file.txt'), 'utf8').includes('backup\n'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
