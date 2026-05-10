import * as vscode from 'vscode';

export type CommitAction =
  | 'openDetails'
  | 'copyRevisionNumber'
  | 'createPatch'
  | 'cherryPick'
  | 'checkoutRevision'
  | 'showRepositoryAtRevision'
  | 'compareWithLocal'
  | 'resetCurrentBranchToHere'
  | 'revertCommit'
  | 'interactiveRebaseFromHere'
  | 'newBranch'
  | 'newTag'
  | 'goToParentCommit';

export interface CommitActionMessage {
  readonly type: 'commitAction';
  readonly action: CommitAction;
  readonly sha: string;
  readonly shas?: readonly string[];
}

export async function handleCommitAction(message: CommitActionMessage): Promise<void> {
  const normalizedShas = Array.from(
    new Set(
      (Array.isArray(message.shas) ? message.shas : [message.sha])
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    )
  );
  const [sha] = normalizedShas;
  if (!sha) {
    return;
  }

  const runForEachSha = async (command: string) => {
    for (const item of normalizedShas) {
      await vscode.commands.executeCommand(command, item);
    }
  };

  switch (message.action) {
    case 'openDetails':
      await runForEachSha('intelliGit.graph.openDetails');
      return;
    case 'copyRevisionNumber':
      await vscode.env.clipboard.writeText(normalizedShas.join('\n'));
      void vscode.window.setStatusBarMessage(
        normalizedShas.length > 1 ? `Copied ${normalizedShas.length} revisions` : `Copied ${sha}`,
        1500
      );
      return;
    case 'createPatch':
      await runForEachSha('intelliGit.graph.createPatch');
      return;
    case 'cherryPick':
      await runForEachSha('intelliGit.graph.cherryPick');
      return;
    case 'checkoutRevision':
      await vscode.commands.executeCommand('intelliGit.graph.checkoutCommit', sha);
      return;
    case 'showRepositoryAtRevision':
      await vscode.commands.executeCommand('intelliGit.graph.showRepositoryAtRevision', sha);
      return;
    case 'compareWithLocal':
      await vscode.commands.executeCommand('intelliGit.graph.compareWithCurrent', sha);
      return;
    case 'resetCurrentBranchToHere':
      await vscode.commands.executeCommand('intelliGit.branch.resetCurrentToCommit', sha);
      return;
    case 'revertCommit':
      await runForEachSha('intelliGit.graph.revert');
      return;
    case 'interactiveRebaseFromHere':
      await vscode.commands.executeCommand('intelliGit.graph.rebaseInteractiveFromHere', sha);
      return;
    case 'newBranch':
      await vscode.commands.executeCommand('intelliGit.graph.createBranchHere', sha);
      return;
    case 'newTag':
      await vscode.commands.executeCommand('intelliGit.graph.createTagHere', sha);
      return;
    case 'goToParentCommit':
      await vscode.commands.executeCommand('intelliGit.graph.goToParentCommit', sha);
      return;
    default:
      return;
  }
}

export function isCommitActionMessage(value: unknown): value is CommitActionMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const hasValidShas =
    candidate.shas === undefined ||
    (Array.isArray(candidate.shas) && candidate.shas.every((item) => typeof item === 'string'));
  return candidate.type === 'commitAction'
    && typeof candidate.action === 'string'
    && typeof candidate.sha === 'string'
    && hasValidShas;
}
