import * as path from 'path';
import * as vscode from 'vscode';
import { confirmDangerousAction } from '../guards';
import { Logger } from '../logger';
import { GraphCommitFileTreeItem, GraphCommitTreeItem } from '../providers/graphTreeProvider';
import { BranchTreeItem } from '../providers/branchTreeProvider';
import { StashTreeItem } from '../providers/stashTreeProvider';
import { GitService } from '../services/gitService';
import { StateStore } from '../state/stateStore';
import { EditorOrchestrator } from '../editor/editorOrchestrator';

interface QuickAction {
  label: string;
  description?: string;
  run: () => Promise<void>;
}

export class CommandController {
  constructor(
    private readonly git: GitService,
    private readonly state: StateStore,
    private readonly editor: EditorOrchestrator,
    private readonly logger: Logger,
    private readonly branchProvider: {
      setFilter(value: string): void;
      refresh(): void;
    }
  ) {}

  register(context: vscode.ExtensionContext): void {
    const asBranchItem = (value: unknown): BranchTreeItem | undefined => (value instanceof BranchTreeItem ? value : undefined);
    const asStashItem = (value: unknown): StashTreeItem | undefined => (value instanceof StashTreeItem ? value : undefined);
    const asGraphItem = (value: unknown): GraphCommitTreeItem | undefined =>
      value instanceof GraphCommitTreeItem ? value : undefined;
    const asGraphFileItem = (value: unknown): GraphCommitFileTreeItem | undefined =>
      value instanceof GraphCommitFileTreeItem ? value : undefined;
    const toCommitSha = (value: unknown): string | undefined => {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || undefined;
      }
      return asGraphItem(value)?.commit.sha;
    };

    const register = (command: string, callback: (...args: unknown[]) => Promise<void>): void => {
      context.subscriptions.push(
        vscode.commands.registerCommand(command, async (...args: unknown[]) => {
          try {
            await callback(...args);
          } catch (error) {
            this.logger.error(`Command failed: ${command}`, error);
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`IntelliGit: ${message}`);
          }
        })
      );
    };

    register('intelliGit.refresh', async () => {
      await this.state.refreshAll();
      void vscode.window.setStatusBarMessage('IntelliGit refreshed', 1500);
    });

    register('intelliGit.quickActions', async () => {
      await this.openQuickActions();
    });

    register('intelliGit.branch.search', async () => {
      const query = await vscode.window.showInputBox({
        title: 'Search branches',
        placeHolder: 'Type branch name filter'
      });

      this.branchProvider.setFilter(query ?? '');
    });

    register('intelliGit.branch.checkout', async (arg?: unknown) => {
      const item = asBranchItem(arg);
      const branchName = item?.branch.name ?? (await this.pickBranchName());
      if (!branchName) {
        return;
      }

      await this.git.checkoutBranch(branchName);
      await this.state.refreshAll();
    });

    register('intelliGit.branch.create', async () => {
      const baseBranch = await this.pickBranchName('Pick base branch for new branch');
      if (!baseBranch) {
        return;
      }

      const branchName = await vscode.window.showInputBox({
        title: 'Create branch',
        placeHolder: 'feature/my-branch',
        validateInput: (value) => (value.trim() ? undefined : 'Branch name is required')
      });

      if (!branchName) {
        return;
      }

      await this.git.createBranch(branchName.trim(), baseBranch);
      await this.git.checkoutBranch(branchName.trim());
      await this.state.refreshAll();
    });

    register('intelliGit.branch.rename', async (arg?: unknown) => {
      const item = asBranchItem(arg);
      const from = item?.branch.name ?? (await this.pickBranchName('Pick branch to rename'));
      if (!from) {
        return;
      }

      const to = await vscode.window.showInputBox({
        title: `Rename branch ${from}`,
        value: from,
        validateInput: (value) => (value.trim() ? undefined : 'Branch name is required')
      });

      if (!to || to.trim() === from) {
        return;
      }

      await this.git.renameBranch(from, to.trim());
      await this.state.refreshAll();
    });

    register('intelliGit.branch.delete', async (arg?: unknown) => {
      const item = asBranchItem(arg);
      const branch = item?.branch.name ?? (await this.pickBranchName('Pick branch to delete'));
      if (!branch) {
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Delete branch',
        detail: `Branch: ${branch}`,
        acceptLabel: 'Delete'
      });
      if (!confirmed) {
        return;
      }

      await this.git.deleteBranch(branch);
      await this.state.refreshAll();
    });

    register('intelliGit.branch.track', async (arg?: unknown) => {
      const item = asBranchItem(arg);
      const local = item?.branch.name ?? (await this.pickBranchName('Pick local branch to track'));
      if (!local) {
        return;
      }

      const remote = await this.pickBranchName('Pick remote upstream branch', true);
      if (!remote) {
        return;
      }

      await this.git.trackBranch(local, remote);
      await this.state.refreshAll();
    });

    register('intelliGit.branch.untrack', async (arg?: unknown) => {
      const item = asBranchItem(arg);
      const branch = item?.branch.name ?? (await this.pickBranchName('Pick local branch to untrack'));
      if (!branch) {
        return;
      }

      await this.git.untrackBranch(branch);
      await this.state.refreshAll();
    });

    register('intelliGit.branch.mergeIntoCurrent', async (arg?: unknown) => {
      const item = asBranchItem(arg);
      const branch = item?.branch.name ?? (await this.pickBranchName('Pick branch to merge into current branch'));
      if (!branch) {
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Merge into current branch',
        detail: `Source branch: ${branch}`,
        acceptLabel: 'Merge'
      });
      if (!confirmed) {
        return;
      }

      await this.git.mergeIntoCurrent(branch);
      await this.state.refreshAll();
    });

    register('intelliGit.branch.rebaseOnto', async (arg?: unknown) => {
      const item = asBranchItem(arg);
      const onto = item?.branch.name ?? (await this.pickBranchName('Pick branch to rebase onto'));
      if (!onto) {
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Rebase current branch',
        detail: `Rebase onto: ${onto}`,
        acceptLabel: 'Rebase'
      });
      if (!confirmed) {
        return;
      }

      await this.git.rebaseCurrentOnto(onto);
      await this.state.refreshAll();
    });

    register('intelliGit.branch.resetCurrentToCommit', async (arg?: unknown) => {
      const target = toCommitSha(arg) ?? (await this.pickCommitSha('Pick target commit for reset'));
      if (!target) {
        return;
      }

      const mode = await vscode.window.showQuickPick(['soft', 'mixed', 'hard'], {
        title: 'Reset mode',
        placeHolder: 'Choose reset mode'
      });

      if (!mode) {
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Reset current branch',
        detail: `Mode: ${mode}\nTarget: ${target}`,
        acceptLabel: 'Reset'
      });
      if (!confirmed) {
        return;
      }

      await this.git.resetCurrent(target, mode as 'soft' | 'mixed' | 'hard');
      await this.state.refreshAll();
    });

    register('intelliGit.branch.compareWithCurrent', async (arg?: unknown) => {
      const item = asBranchItem(arg);
      const current = await this.git.getCurrentBranch();
      const target = item?.branch.name ?? (await this.pickBranchName('Pick branch to compare with current'));
      if (!target) {
        return;
      }

      await this.editor.openBranchCompare(current, target);
    });

    register('intelliGit.stash.create', async () => {
      const message = (await vscode.window.showInputBox({
        title: 'Create stash',
        placeHolder: 'WIP: short message'
      }))?.trim();

      if (!message) {
        return;
      }

      const includeUntracked =
        (await vscode.window.showQuickPick(['No', 'Yes'], {
          title: 'Include untracked files?'
        })) === 'Yes';

      const keepIndex =
        (await vscode.window.showQuickPick(['No', 'Yes'], {
          title: 'Keep staged changes in index?'
        })) === 'Yes';

      await this.git.createStash(message, { includeUntracked, keepIndex });
      await this.state.refreshAll();
    });

    register('intelliGit.stash.apply', async (arg?: unknown) => {
      const item = asStashItem(arg);
      const ref = item?.stash.ref ?? (await this.pickStashRef('Pick stash to apply'));
      if (!ref) {
        return;
      }

      await this.git.applyStash(ref, false);
      await this.state.refreshAll();
    });

    register('intelliGit.stash.pop', async (arg?: unknown) => {
      const item = asStashItem(arg);
      const ref = item?.stash.ref ?? (await this.pickStashRef('Pick stash to pop'));
      if (!ref) {
        return;
      }

      await this.git.applyStash(ref, true);
      await this.state.refreshAll();
    });

    register('intelliGit.stash.drop', async (arg?: unknown) => {
      const item = asStashItem(arg);
      const ref = item?.stash.ref ?? (await this.pickStashRef('Pick stash to drop'));
      if (!ref) {
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Drop stash',
        detail: `Target: ${ref}`,
        acceptLabel: 'Drop'
      });
      if (!confirmed) {
        return;
      }

      await this.git.dropStash(ref);
      await this.state.refreshAll();
    });

    register('intelliGit.stash.rename', async (arg?: unknown) => {
      const item = asStashItem(arg);
      const ref = item?.stash.ref ?? (await this.pickStashRef('Pick stash to rename'));
      if (!ref) {
        return;
      }

      const message = await vscode.window.showInputBox({
        title: `Rename ${ref}`,
        placeHolder: 'Updated stash message'
      });
      if (!message) {
        return;
      }

      await this.git.renameStash(ref, message.trim());
      await this.state.refreshAll();
    });

    register('intelliGit.stash.previewPatch', async (arg?: unknown) => {
      const item = asStashItem(arg);
      const ref = item?.stash.ref ?? (await this.pickStashRef('Pick stash to preview patch'));
      if (!ref) {
        return;
      }

      const patch = await this.git.getStashPatch(ref);
      const doc = await vscode.workspace.openTextDocument({
        language: 'diff',
        content: patch
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    });

    register('intelliGit.graph.openDetails', async (arg?: unknown) => {
      const item = asGraphItem(arg);
      const sha = item?.commit.sha ?? (await this.pickCommitSha('Pick commit for details'));
      if (!sha) {
        return;
      }

      const details = await this.git.getCommitDetails(sha);
      const content = [
        `# ${details.commit.shortSha} ${details.commit.subject}`,
        '',
        `- Author: ${details.commit.author}`,
        `- Date: ${new Date(details.commit.date).toLocaleString()}`,
        `- Commit: ${details.commit.sha}`,
        `- Parents: ${details.commit.parents.join(', ') || 'none'}`,
        '',
        '## Message',
        details.body,
        '',
        '## Changed Files',
        ...details.changedFiles.map((file) => `- ${file.status} ${file.path}`)
      ].join('\n');

      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
      await vscode.window.showTextDocument(doc, { preview: false });
    });

    register('intelliGit.graph.openFileDiff', async (arg?: unknown) => {
      const item = asGraphFileItem(arg);
      if (!item) {
        return;
      }

      await this.editor.openCommitFileDiff(item.commit.sha, item.filePath);
    });

    register('intelliGit.graph.checkoutCommit', async (arg?: unknown) => {
      const sha = toCommitSha(arg) ?? (await this.pickCommitSha('Pick commit to checkout'));
      if (!sha) {
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Checkout detached HEAD',
        detail: `Commit: ${sha}`,
        acceptLabel: 'Checkout'
      });
      if (!confirmed) {
        return;
      }

      await this.git.checkoutCommit(sha);
      await this.state.refreshAll();
    });

    register('intelliGit.graph.createBranchHere', async (arg?: unknown) => {
      const sha = toCommitSha(arg) ?? (await this.pickCommitSha('Pick commit for new branch'));
      if (!sha) {
        return;
      }

      const name = await vscode.window.showInputBox({
        title: `Create branch at ${sha.slice(0, 8)}`,
        placeHolder: 'feature/new-branch',
        validateInput: (value) => (value.trim() ? undefined : 'Branch name is required')
      });

      if (!name) {
        return;
      }

      await this.git.createBranch(name.trim(), sha);
      await this.state.refreshAll();
    });

    register('intelliGit.graph.createTagHere', async (arg?: unknown) => {
      const sha = toCommitSha(arg) ?? (await this.pickCommitSha('Pick commit for new tag'));
      if (!sha) {
        return;
      }

      const name = await vscode.window.showInputBox({
        title: `Create tag at ${sha.slice(0, 8)}`,
        placeHolder: 'v1.2.3',
        validateInput: (value) => (value.trim() ? undefined : 'Tag name is required')
      });

      if (!name) {
        return;
      }

      await this.git.createTag(name.trim(), sha);
      await this.state.refreshAll();
      void vscode.window.showInformationMessage(`Created tag ${name.trim()} at ${sha.slice(0, 8)}.`);
    });

    register('intelliGit.graph.cherryPick', async (arg?: unknown) => {
      const sha = toCommitSha(arg) ?? (await this.pickCommitSha('Pick commit to cherry-pick'));
      if (!sha) {
        return;
      }

      await this.git.cherryPick(sha);
      await this.state.refreshAll();
    });

    register('intelliGit.graph.cherryPickRange', async () => {
      const fromExclusive = await this.pickCommitSha('Pick starting point (exclusive)');
      if (!fromExclusive) {
        return;
      }
      const toInclusive = await this.pickCommitSha('Pick end point (inclusive)');
      if (!toInclusive) {
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Cherry-pick range',
        detail: `${fromExclusive}..${toInclusive}`,
        acceptLabel: 'Cherry-pick'
      });
      if (!confirmed) {
        return;
      }

      await this.git.cherryPickRange(fromExclusive, toInclusive);
      await this.state.refreshAll();
    });

    register('intelliGit.graph.revert', async (arg?: unknown) => {
      const sha = toCommitSha(arg) ?? (await this.pickCommitSha('Pick commit to revert'));
      if (!sha) {
        return;
      }

      await this.git.revertCommit(sha);
      await this.state.refreshAll();
    });

    register('intelliGit.graph.compareWithCurrent', async (arg?: unknown) => {
      const sha = toCommitSha(arg) ?? (await this.pickCommitSha('Pick commit to compare with current'));
      if (!sha) {
        return;
      }

      await this.editor.openCompareFromCommit(sha);
    });

    register('intelliGit.graph.rebaseInteractiveFromHere', async (arg?: unknown) => {
      const base = toCommitSha(arg) ?? (await this.pickCommitSha('Pick base commit for interactive rebase'));
      if (!base) {
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Interactive rebase',
        detail: `Base commit: ${base}`,
        acceptLabel: 'Start rebase'
      });
      if (!confirmed) {
        return;
      }

      await this.git.rebaseInteractive(base);
      await this.state.refreshAll();
    });

    register('intelliGit.graph.goToParentCommit', async (arg?: unknown) => {
      const sha = toCommitSha(arg) ?? (await this.pickCommitSha('Pick commit'));
      if (!sha) {
        return;
      }

      const parent = await this.git.getParentCommit(sha);
      if (!parent) {
        void vscode.window.showInformationMessage('This commit has no parent commit.');
        return;
      }

      const graphCommit = this.state.graph.find((commit) => commit.sha === parent);
      if (graphCommit) {
        await vscode.commands.executeCommand('intelliGit.graph.openDetails', new GraphCommitTreeItem(graphCommit));
      } else {
        const details = await this.git.getCommitDetails(parent);
        const doc = await vscode.workspace.openTextDocument({
          language: 'markdown',
          content: [
            `# ${details.commit.shortSha} ${details.commit.subject}`,
            '',
            `- Author: ${details.commit.author}`,
            `- Date: ${new Date(details.commit.date).toLocaleString()}`,
            `- Commit: ${details.commit.sha}`,
            '',
            '## Message',
            details.body
          ].join('\n')
        });
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    });

    register('intelliGit.graph.createPatch', async (arg?: unknown) => {
      const sha = toCommitSha(arg) ?? (await this.pickCommitSha('Pick commit to export patch'));
      if (!sha) {
        return;
      }

      const patch = await this.git.getPatchForCommit(sha);
      const doc = await vscode.workspace.openTextDocument({
        language: 'diff',
        content: patch
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    });

    register('intelliGit.graph.showRepositoryAtRevision', async (arg?: unknown) => {
      const sha = toCommitSha(arg) ?? (await this.pickCommitSha('Pick revision'));
      if (!sha) {
        return;
      }

      const files = await this.git.getFilesAtRevision(sha);
      if (files.length === 0) {
        void vscode.window.showInformationMessage(`No files found at revision ${sha.slice(0, 8)}.`);
        return;
      }

      const picked = await vscode.window.showQuickPick(
        files.map((filePath) => ({ label: filePath })),
        {
          title: `Repository at ${sha.slice(0, 8)}`,
          placeHolder: 'Pick a file to open at this revision'
        }
      );

      if (!picked) {
        return;
      }

      const content = await this.git.getFileContentFromRef(sha, picked.label);
      const document = await vscode.workspace.openTextDocument({
        language: getLanguageFromFileName(picked.label),
        content
      });
      await vscode.window.showTextDocument(document, { preview: false });
    });

    register('intelliGit.graph.filter', async () => {
      const existing = this.state.graphFilters;
      const branch = await vscode.window.showInputBox({
        title: 'Graph filter: branch/ref',
        value: existing.branch ?? '',
        placeHolder: 'Optional (e.g. main)'
      });
      if (branch === undefined) {
        return;
      }

      const author = await vscode.window.showInputBox({
        title: 'Graph filter: author',
        value: existing.author ?? '',
        placeHolder: 'Optional'
      });
      if (author === undefined) {
        return;
      }

      const message = await vscode.window.showInputBox({
        title: 'Graph filter: message text',
        value: existing.message ?? '',
        placeHolder: 'Optional'
      });
      if (message === undefined) {
        return;
      }

      const since = await vscode.window.showInputBox({
        title: 'Graph filter: since',
        value: existing.since ?? '',
        placeHolder: 'Optional (e.g. 2026-01-01)'
      });
      if (since === undefined) {
        return;
      }

      const until = await vscode.window.showInputBox({
        title: 'Graph filter: until',
        value: existing.until ?? '',
        placeHolder: 'Optional (e.g. 2026-03-01)'
      });
      if (until === undefined) {
        return;
      }

      await this.state.refreshGraph({
        branch: branch.trim() || undefined,
        author: author.trim() || undefined,
        message: message.trim() || undefined,
        since: since.trim() || undefined,
        until: until.trim() || undefined
      });
    });

    register('intelliGit.graph.clearFilter', async () => {
      await this.state.clearGraphFilters();
    });

    register('intelliGit.diff.open', async () => {
      await this.openDiffWorkflow();
    });

    register('intelliGit.compare.open', async () => {
      await this.openCompareWorkflow();
    });

    register('intelliGit.merge.openConflict', async () => {
      const conflicts = await this.git.getMergeConflicts();
      if (conflicts.length === 0) {
        void vscode.window.showInformationMessage('No conflicted files found.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        conflicts.map((item) => ({ label: item.path, description: item.status })),
        { title: 'Open conflict in merge editor' }
      );

      if (!picked) {
        return;
      }

      await this.editor.openMergeConflict(picked.label);
    });

    register('intelliGit.merge.next', async () => {
      await vscode.commands.executeCommand('merge-conflict.next');
    });

    register('intelliGit.merge.previous', async () => {
      await vscode.commands.executeCommand('merge-conflict.previous');
    });

    register('intelliGit.merge.finalize', async () => {
      const conflicts = await this.git.getMergeConflicts();
      if (conflicts.length > 0) {
        void vscode.window.showWarningMessage(`Resolve all conflicts before finalizing (${conflicts.length} remaining).`);
        return;
      }

      const changed = await this.git.getChangedFiles();
      if (changed.length > 0) {
        await this.git.addAll();
      }

      void vscode.window.showInformationMessage('All conflicts resolved. Ready to commit merge.');
      await this.state.refreshAll();
    });

    register('intelliGit.git.pushWithPreview', async () => {
      const preview = await this.git.getOutgoingIncomingPreview();
      const confirmed = await confirmDangerousAction({
        title: 'Push current branch',
        detail: `Outgoing commits:\n${preview.outgoing.slice(0, 10).join('\n') || 'none'}`,
        acceptLabel: 'Push'
      });
      if (!confirmed) {
        return;
      }

      await this.git.push();
      await this.state.refreshAll();
    });

    register('intelliGit.git.pullWithPreview', async () => {
      const preview = await this.git.getOutgoingIncomingPreview();
      const confirmed = await confirmDangerousAction({
        title: 'Pull current branch',
        detail: `Incoming commits:\n${preview.incoming.slice(0, 10).join('\n') || 'none'}`,
        acceptLabel: 'Pull'
      });
      if (!confirmed) {
        return;
      }

      await this.git.pull();
      await this.state.refreshAll();
    });

    register('intelliGit.git.fetchPrune', async () => {
      await this.git.fetchPrune();
      await this.state.refreshAll();
      void vscode.window.showInformationMessage('Fetch --prune completed.');
    });

    register('intelliGit.stage.patch', async () => {
      const changed = await this.git.getChangedFiles();
      if (changed.length === 0) {
        void vscode.window.showInformationMessage('No local changes found.');
        return;
      }

      const file = await vscode.window.showQuickPick(
        changed.map((item) => ({ label: item.path, description: item.status })),
        { title: 'Select file for interactive hunk staging' }
      );

      if (!file) {
        return;
      }

      await this.git.stagePatch(file.label);
      await this.state.refreshAll();
    });

    register('intelliGit.stage.file', async () => {
      const changed = await this.git.getChangedFiles();
      const candidates = changed.filter((entry) => entry.status.length > 0 && entry.status[1] !== ' ');
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage('No unstaged files found.');
        return;
      }

      const file = await vscode.window.showQuickPick(
        candidates.map((item) => ({ label: item.path, description: item.status })),
        { title: 'Stage file' }
      );
      if (!file) {
        return;
      }

      await this.git.stageFile(file.label);
      await this.state.refreshAll();
    });

    register('intelliGit.unstage.file', async () => {
      const changed = await this.git.getChangedFiles();
      const candidates = changed.filter((entry) => entry.status.length > 1 && entry.status[0] !== ' ' && entry.status[0] !== '?');
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage('No staged files found.');
        return;
      }

      const file = await vscode.window.showQuickPick(
        candidates.map((item) => ({ label: item.path, description: item.status })),
        { title: 'Unstage file' }
      );
      if (!file) {
        return;
      }

      await this.git.unstageFile(file.label);
      await this.state.refreshAll();
    });

    register('intelliGit.commit.amend', async () => {
      const defaultMessage = await this.git.getHeadCommitMessage();
      const message = await vscode.window.showInputBox({
        title: 'Amend last commit message',
        value: defaultMessage,
        prompt: 'Leave unchanged to amend content only'
      });

      if (message === undefined) {
        return;
      }

      if (message.trim() && message.trim() !== defaultMessage.trim()) {
        await this.git.amendCommit(message.trim());
      } else {
        await this.git.amendCommit();
      }
      await this.state.refreshAll();
    });
    register('intelliGit.fileHistory.open', async () => {
      const file = this.getActiveFilePath();
      if (!file) {
        void vscode.window.showWarningMessage('Open a file to view history.');
        return;
      }

      const history = await this.git.fileHistory(file);
      const content = [
        `# File history: ${file}`,
        '',
        ...history.map((entry) => `- ${entry.shortSha} ${entry.subject} (${entry.author}, ${new Date(entry.date).toLocaleString()})`)
      ].join('\n');

      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
      await vscode.window.showTextDocument(doc, { preview: false });
    });

    register('intelliGit.fileBlame.open', async () => {
      const file = this.getActiveFilePath();
      if (!file) {
        void vscode.window.showWarningMessage('Open a file to view blame.');
        return;
      }

      const blame = await this.git.fileBlame(file);
      const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: blame });
      await vscode.window.showTextDocument(doc, { preview: false });
    });
  }

  private async openQuickActions(): Promise<void> {
    const actions: QuickAction[] = [
      { label: 'Refresh all views', run: () => this.state.refreshAll() },
      { label: 'Search branches', run: async () => vscode.commands.executeCommand('intelliGit.branch.search') },
      { label: 'Create branch', run: async () => vscode.commands.executeCommand('intelliGit.branch.create') },
      { label: 'Checkout branch', run: async () => vscode.commands.executeCommand('intelliGit.branch.checkout') },
      { label: 'Create stash', run: async () => vscode.commands.executeCommand('intelliGit.stash.create') },
      { label: 'Open stash patch preview', run: async () => vscode.commands.executeCommand('intelliGit.stash.previewPatch') },
      { label: 'Open compare branches', run: async () => vscode.commands.executeCommand('intelliGit.compare.open') },
      { label: 'Open diff workflow', run: async () => vscode.commands.executeCommand('intelliGit.diff.open') },
      { label: 'Open merge conflict', run: async () => vscode.commands.executeCommand('intelliGit.merge.openConflict') },
      { label: 'Filter graph', run: async () => vscode.commands.executeCommand('intelliGit.graph.filter') },
      { label: 'Clear graph filters', run: async () => vscode.commands.executeCommand('intelliGit.graph.clearFilter') },
      { label: 'Fetch --prune', run: async () => vscode.commands.executeCommand('intelliGit.git.fetchPrune') },
      { label: 'Push with preview', run: async () => vscode.commands.executeCommand('intelliGit.git.pushWithPreview') },
      { label: 'Pull with preview', run: async () => vscode.commands.executeCommand('intelliGit.git.pullWithPreview') },
      { label: 'Stage selected hunks', run: async () => vscode.commands.executeCommand('intelliGit.stage.patch') },
      { label: 'Stage file', run: async () => vscode.commands.executeCommand('intelliGit.stage.file') },
      { label: 'Unstage file', run: async () => vscode.commands.executeCommand('intelliGit.unstage.file') },
      { label: 'Amend last commit', run: async () => vscode.commands.executeCommand('intelliGit.commit.amend') },
      { label: 'Open file history', run: async () => vscode.commands.executeCommand('intelliGit.fileHistory.open') },
      { label: 'Open file blame', run: async () => vscode.commands.executeCommand('intelliGit.fileBlame.open') }
    ];

    const picked = await vscode.window.showQuickPick(
      actions.map((action) => ({
        label: action.label,
        description: action.description
      })),
      {
        title: 'IntelliGit Quick Actions',
        placeHolder: 'Pick a Git action'
      }
    );

    if (!picked) {
      return;
    }

    const action = actions.find((item) => item.label === picked.label);
    if (!action) {
      return;
    }

    await action.run();
  }

  private async openDiffWorkflow(): Promise<void> {
    const mode = await vscode.window.showQuickPick(
      [
        'Working tree vs HEAD',
        'Index vs HEAD',
        'Commit vs parent',
        'Any two refs for one file'
      ],
      { title: 'Open side-by-side diff' }
    );

    if (!mode) {
      return;
    }

    if (mode === 'Commit vs parent') {
      const sha = await this.pickCommitSha('Pick commit');
      if (!sha) {
        return;
      }
      await this.editor.openCommitFilesDiff(sha);
      return;
    }

    let leftRef = 'HEAD';
    let rightRef = 'WORKTREE';

    if (mode === 'Index vs HEAD') {
      leftRef = 'HEAD';
      rightRef = 'INDEX';
    }

    if (mode === 'Any two refs for one file') {
      leftRef =
        (await vscode.window.showInputBox({ title: 'Left ref', placeHolder: 'e.g. main, HEAD~1, abc1234' }))?.trim() ?? '';
      rightRef =
        (await vscode.window.showInputBox({ title: 'Right ref', placeHolder: 'e.g. feature/x, HEAD, def5678' }))?.trim() ?? '';

      if (!leftRef || !rightRef) {
        return;
      }
    }

    const filePath = await this.pickFileFromWorkspace('Pick file to diff');
    if (!filePath) {
      return;
    }

    await this.editor.openDiffForFile({
      path: filePath,
      leftRef,
      rightRef,
      title: `${mode} · ${filePath}`
    });
  }

  private async openCompareWorkflow(): Promise<void> {
    const left =
      (await vscode.window.showInputBox({
        title: 'Compare branches',
        placeHolder: 'Left ref (default: current branch)'
      }))?.trim() || (await this.git.getCurrentBranch());

    const right =
      (await vscode.window.showInputBox({
        title: `Compare against ${left}`,
        placeHolder: 'Right ref'
      }))?.trim() ?? '';

    if (!right) {
      return;
    }

    await this.editor.openBranchCompare(left, right);

    const followUp = await vscode.window.showQuickPick(
      ['Open changed file diff', 'Cherry-pick commit range', 'No more actions'],
      { title: 'Branch comparison action' }
    );

    if (followUp === 'Open changed file diff') {
      await this.editor.openBranchComparisonFileDiff(left, right);
    } else if (followUp === 'Cherry-pick commit range') {
      await vscode.commands.executeCommand('intelliGit.graph.cherryPickRange');
    }
  }

  private async pickBranchName(title = 'Pick branch', remoteOnly = false): Promise<string | undefined> {
    const branches = this.state.branches.filter((branch) => {
      if (remoteOnly) {
        return branch.type === 'remote';
      }
      return true;
    });

    const picked = await vscode.window.showQuickPick(
      branches.map((branch) => ({
        label: branch.name,
        description: branch.current ? 'current' : branch.type,
        detail: `${branch.upstream ? `upstream ${branch.upstream}` : 'no upstream'} · ▲${branch.ahead} ▼${branch.behind}`
      })),
      { title }
    );

    return picked?.label;
  }

  private async pickStashRef(title: string): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(
      this.state.stashes.map((stash) => ({
        label: stash.ref,
        description: stash.message,
        detail: `${stash.fileCount} files`
      })),
      { title }
    );

    return picked?.label;
  }

  private async pickCommitSha(title: string): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(
      this.state.graph.map((commit) => ({
        label: commit.shortSha,
        description: commit.subject,
        detail: `${commit.author} · ${new Date(commit.date).toLocaleString()}`,
        sha: commit.sha
      })),
      { title }
    );

    return picked?.sha;
  }

  private async pickFileFromWorkspace(title: string): Promise<string | undefined> {
    const files = await vscode.workspace.findFiles('**/*', '**/.git/**', 500);
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: this.toRelativePath(uri.fsPath)
      })),
      {
        title,
        matchOnDescription: true
      }
    );

    return picked?.label;
  }

  private toRelativePath(absolutePath: string): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return absolutePath;
    }

    return path.relative(folders[0].uri.fsPath, absolutePath).replaceAll('\\', '/');
  }

  private getActiveFilePath(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      return undefined;
    }

    return this.toRelativePath(uri.fsPath);
  }
}

function getLanguageFromFileName(filePath: string): string | undefined {
  const extension = path.extname(filePath).replace('.', '').toLowerCase();
  if (!extension) {
    return undefined;
  }

  const lookup: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    json: 'json',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shellscript',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    java: 'java',
    kt: 'kotlin',
    go: 'go',
    rs: 'rust',
    py: 'python',
    rb: 'ruby',
    php: 'php',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c'
  };

  return lookup[extension];
}
