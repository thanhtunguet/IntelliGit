import * as vscode from 'vscode';

export type CommitAction =
  | 'openDetails'
  | 'copyCommitId'
  | 'copyCommitMessage'
  | 'copyRevisionNumber'
  | 'createPatch'
  | 'cherryPick'
  | 'checkoutRevision'
  | 'showRepositoryAtRevision'
  | 'compareWithLocal'
  | 'resetCurrentBranchToHere'
  | 'revertCommit'
  | 'interactiveRebaseFromHere'
  | 'editCommitMessage'
  | 'pushAllUpToHere'
  | 'newBranch'
  | 'newTag'
  | 'goToChildCommit'
  | 'goToParentCommit';

export interface CommitActionMessage {
  readonly type: 'commitAction';
  readonly action: CommitAction;
  readonly sha: string;
  readonly shas?: readonly string[];
  readonly subject?: string;
  readonly subjects?: readonly string[];
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
  const normalizedSubjects = Array.from(
    new Set(
      (Array.isArray(message.subjects) ? message.subjects : [message.subject ?? ''])
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    )
  );
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
    case 'copyCommitId':
      await vscode.env.clipboard.writeText(normalizedShas.join('\n'));
      void vscode.window.setStatusBarMessage(
        normalizedShas.length > 1 ? `Copied ${normalizedShas.length} commit IDs` : `Copied commit ID ${sha}`,
        1500
      );
      return;
    case 'copyCommitMessage':
      if (normalizedSubjects.length === 0) {
        return;
      }
      await vscode.env.clipboard.writeText(normalizedSubjects.join('\n'));
      void vscode.window.setStatusBarMessage(
        normalizedSubjects.length > 1 ? `Copied ${normalizedSubjects.length} commit messages` : 'Copied commit message',
        1500
      );
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
    case 'editCommitMessage':
      await vscode.commands.executeCommand('intelliGit.graph.editCommitMessage', sha);
      return;
    case 'pushAllUpToHere':
      await vscode.commands.executeCommand('intelliGit.graph.pushAllUpToHere', sha);
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
    case 'goToChildCommit':
      await vscode.commands.executeCommand('intelliGit.graph.goToChildCommit', sha);
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
  const hasValidSubjects =
    candidate.subjects === undefined ||
    (Array.isArray(candidate.subjects) && candidate.subjects.every((item) => typeof item === 'string'));
  return candidate.type === 'commitAction'
    && typeof candidate.action === 'string'
    && typeof candidate.sha === 'string'
    && (candidate.subject === undefined || typeof candidate.subject === 'string')
    && hasValidShas
    && hasValidSubjects;
}
