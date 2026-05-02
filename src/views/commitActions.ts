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
}

export async function handleCommitAction(message: CommitActionMessage): Promise<void> {
  const sha = message.sha.trim();
  if (!sha) {
    return;
  }

  switch (message.action) {
    case 'openDetails':
      await vscode.commands.executeCommand('intelliGit.graph.openDetails', sha);
      return;
    case 'copyRevisionNumber':
      await vscode.env.clipboard.writeText(sha);
      void vscode.window.setStatusBarMessage(`Copied ${sha}`, 1500);
      return;
    case 'createPatch':
      await vscode.commands.executeCommand('intelliGit.graph.createPatch', sha);
      return;
    case 'cherryPick':
      await vscode.commands.executeCommand('intelliGit.graph.cherryPick', sha);
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
      await vscode.commands.executeCommand('intelliGit.graph.revert', sha);
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
  return candidate.type === 'commitAction' && typeof candidate.action === 'string' && typeof candidate.sha === 'string';
}
