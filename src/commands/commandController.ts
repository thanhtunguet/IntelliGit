import * as vscode from 'vscode';
import { EditorOrchestrator } from '../editor/editorOrchestrator';
import { confirmDangerousAction } from '../guards';
import { Logger } from '../logger';
import { BranchTreeItem, TagTreeItem } from '../providers/branchTreeProvider';
import {
  CommitActionContext,
  CommitFileTreeItem,
  CommitRangeFileTreeItem,
  RevisionFileTreeItem,
  WorkingTreeCompareFileTreeItem
} from '../providers/commitFilesTreeProvider';
import { GraphCommitFileTreeItem, GraphCommitTreeItem } from '../providers/graphTreeProvider';
import { StashTreeItem } from '../providers/stashTreeProvider';
import { WorktreeTreeItem } from '../providers/worktreeTreeProvider';
import { SubmoduleTreeItem } from '../providers/submoduleTreeProvider';
import { GitService } from '../services/gitService';
import { expandTemplate, loadTemplates } from '../state/commitTemplates';
import { StateStore } from '../state/stateStore';
import { BranchSearchView } from '../views/branchSearchView';
import { CommitListView } from '../views/commitListView';
import { GraphFilterView } from '../views/graphFilterView';
import { pickRevisionToCompare } from '../views/revisionPicker';

interface QuickAction {
  label: string;
  description?: string;
  run: () => Promise<void>;
}

type CherryPickIssueKind = 'conflict' | 'nothingToCherryPick' | 'failed';
type RebaseIssueKind = 'conflict' | 'failed';

type GitScmRepository = {
  rootUri: vscode.Uri;
  inputBox: {
    value: string;
  };
};

type GitScmApi = {
  repositories: GitScmRepository[];
  getRepository(uri: vscode.Uri): GitScmRepository | null;
};

type GitScmExtensionExports = {
  getAPI(version: 1): GitScmApi;
};

export class CommandController {
  constructor(
    private readonly git: GitService,
    private readonly state: StateStore,
    private readonly editor: EditorOrchestrator,
    private readonly logger: Logger,
    private readonly commitFilesView: {
      getCommitActionContext(selectedItems: readonly CommitFileTreeItem[]): CommitActionContext | undefined;
      getAllFileItems(): CommitFileTreeItem[];
      showCommit(sha: string, subject: string): Promise<void>;
    }
  ) { }

  register(context: vscode.ExtensionContext): void {
    const asBranchItem = (value: unknown): BranchTreeItem | undefined => (value instanceof BranchTreeItem ? value : undefined);
    const asTagItem = (value: unknown): TagTreeItem | undefined => (value instanceof TagTreeItem ? value : undefined);
    const asStashItem = (value: unknown): StashTreeItem | undefined => (value instanceof StashTreeItem ? value : undefined);
    const asGraphItem = (value: unknown): GraphCommitTreeItem | undefined =>
      value instanceof GraphCommitTreeItem ? value : undefined;
    const asGraphFileItem = (value: unknown): GraphCommitFileTreeItem | undefined =>
      value instanceof GraphCommitFileTreeItem ? value : undefined;
    const asCommitViewFileItem = (value: unknown): CommitFileTreeItem | undefined =>
      value instanceof CommitFileTreeItem ? value : undefined;
    const asCommitRangeFileItem = (
      value: unknown
    ): { filePath: string; fromRef: string; toRef: string; fromLabel: string; toLabel: string } | undefined => {
      if (value instanceof CommitRangeFileTreeItem) {
        return {
          filePath: value.filePath,
          fromRef: value.fromRef,
          toRef: value.toRef,
          fromLabel: value.fromLabel,
          toLabel: value.toLabel
        };
      }

      if (
        typeof value === 'object' &&
        value !== null &&
        'filePath' in value &&
        'fromRef' in value &&
        'toRef' in value
      ) {
        const record = value as Record<string, unknown>;
        if (
          typeof record.filePath === 'string' &&
          typeof record.fromRef === 'string' &&
          typeof record.toRef === 'string'
        ) {
          return {
            filePath: record.filePath,
            fromRef: record.fromRef,
            toRef: record.toRef,
            fromLabel: typeof record.fromLabel === 'string' ? record.fromLabel : record.fromRef,
            toLabel: typeof record.toLabel === 'string' ? record.toLabel : record.toRef
          };
        }
      }

      return undefined;
    };
    const asRevisionViewFileItem = (value: unknown): RevisionFileTreeItem | undefined =>
      value instanceof RevisionFileTreeItem ? value : undefined;
    const asWorkingTreeCompareFileItem = (
      value: unknown
    ): { filePath: string; ref: string; refLabel: string; status: string } | undefined => {
      if (value instanceof WorkingTreeCompareFileTreeItem) {
        return {
          filePath: value.filePath,
          ref: value.ref,
          refLabel: value.refLabel,
          status: value.status
        };
      }

      if (
        typeof value === 'object' &&
        value !== null &&
        'filePath' in value &&
        'ref' in value &&
        'refLabel' in value &&
        'status' in value
      ) {
        const record = value as Record<string, unknown>;
        if (
          typeof record.filePath === 'string' &&
          typeof record.ref === 'string' &&
          typeof record.refLabel === 'string' &&
          typeof record.status === 'string'
        ) {
          return {
            filePath: record.filePath,
            ref: record.ref,
            refLabel: record.refLabel,
            status: record.status
          };
        }
      }

      return undefined;
    };
    const asFileResourceUri = (value: unknown): vscode.Uri | undefined => {
      if (value instanceof vscode.Uri) {
        return value.scheme === 'file' ? value : undefined;
      }

      if (
        typeof value === 'object' &&
        value !== null &&
        'resourceUri' in value &&
        (value as { resourceUri?: unknown }).resourceUri instanceof vscode.Uri
      ) {
        const uri = (value as { resourceUri: vscode.Uri }).resourceUri;
        return uri.scheme === 'file' ? uri : undefined;
      }

      return undefined;
    };
    const toBranchName = (value: unknown): string | undefined => {
      const item = asBranchItem(value);
      if (item) {
        return item.branch.name;
      }
      if (typeof value !== 'string') {
        return undefined;
      }
      const raw = value.trim();
      if (!raw) {
        return undefined;
      }
      return this.resolveBranchNameForActionHub(raw) ?? raw;
    };
    const toRepoFilePath = (value: unknown): string | undefined => {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || undefined;
      }

      const filePath =
        asGraphFileItem(value)?.filePath ??
        asCommitViewFileItem(value)?.filePath ??
        asRevisionViewFileItem(value)?.filePath;
      if (filePath) {
        return filePath;
      }

      const uri = asFileResourceUri(value);
      if (!uri) {
        return undefined;
      }

      return this.git.toRepoRelative(uri.fsPath);
    };
    const toCommitSha = (value: unknown): string | undefined => {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || undefined;
      }
      const tag = asTagItem(value)?.tag;
      return asGraphItem(value)?.commit.sha ?? tag?.sha ?? tag?.name;
    };
    const toGraphCommitShas = (arg: unknown, selectedArg: unknown): string[] => {
      const selectedItems = Array.isArray(selectedArg) ? selectedArg : [];
      const fromSelected = selectedItems
        .map((item) => asGraphItem(item)?.commit.sha ?? toCommitSha(item))
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value): value is string => Boolean(value));
      if (fromSelected.length > 0) {
        return [...new Set(fromSelected)];
      }
      const primary = toCommitSha(arg);
      return primary ? [primary] : [];
    };
    const toTagRef = (value: unknown): string | undefined => asTagItem(value)?.tag.name;
    const toTagRevision = (value: unknown): string | undefined => {
      const tag = asTagItem(value)?.tag;
      return tag?.sha ?? tag?.name;
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
      await this.state.refreshVisible();
      void vscode.window.setStatusBarMessage('IntelliGit refreshed', 1500);
    });

    register('intelliGit.quickActions', async () => {
      await this.openQuickActions();
    });

    register('intelliGit.branch.actionHub', async (arg?: unknown) => {
      await this.openBranchActionHub(arg);
    });

    register('intelliGit.branch.openCommits', async (arg?: unknown) => {
      const branchName = toBranchName(arg) ?? (await this.pickBranchName('Pick branch to open commits'));
      if (!branchName) {
        return;
      }

      await this.openBranchCommits(branchName);
    });

    register('intelliGit.branch.search', async () => {
      await this.state.refreshBranches();
      BranchSearchView.open(
        {
          checkout: async (name: string) => {
            await this.git.checkoutBranch(name);
            await this.state.refreshAll();
          },
          checkoutTag: async (name: string) => {
            await vscode.commands.executeCommand('intelliGit.tag.checkoutNewBranch', name);
            await this.state.refreshAll();
          },
          openActions: async (name: string) => {
            await vscode.commands.executeCommand('intelliGit.branch.actionHub', name);
          },
          runCommand: async (command, name) => {
            await vscode.commands.executeCommand(command, name);
          }
        },
        () => this.state.branches,
        () => this.state.tags,
        (listener) => this.state.onDidChange(listener)
      );
    });

    register('intelliGit.branch.checkout', async (arg?: unknown) => {
      const branchName = toBranchName(arg) ?? (await this.pickBranchName());
      if (!branchName) {
        return;
      }

      await this.git.checkoutBranch(branchName);
      await this.state.refreshAll();
    });

    register('intelliGit.tag.openCommits', async (arg?: unknown) => {
      const revision = toTagRevision(arg) ?? (await this.pickCommitSha('Pick tag or revision for details'));
      if (!revision) {
        return;
      }

      const tagRef = toTagRef(arg) ?? revision;
      await this.openRefCommits(`tag:${revision}`, `Tag: ${tagRef}`, revision);
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

    register('intelliGit.tag.checkoutNewBranch', async (arg?: unknown) => {
      const baseRef = toTagRef(arg) ?? (await this.pickCommitSha('Pick tag or revision for new branch'));
      if (!baseRef) {
        return;
      }

      const branchName = await vscode.window.showInputBox({
        title: `Checkout new branch from ${baseRef}`,
        placeHolder: 'feature/new-branch',
        validateInput: (value) => (value.trim() ? undefined : 'Branch name is required')
      });

      if (!branchName) {
        return;
      }

      await this.git.createBranch(branchName.trim(), baseRef);
      await this.git.checkoutBranch(branchName.trim());
      await this.state.refreshAll();
    });

    register('intelliGit.tag.checkout', async (arg?: unknown) => {
      const tagRef = toTagRef(arg) ?? (await this.pickCommitSha('Pick tag or revision to checkout'));
      if (!tagRef) {
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Checkout revision',
        detail: `Revision: ${tagRef}`,
        acceptLabel: 'Checkout'
      });
      if (!confirmed) {
        return;
      }

      await this.git.checkoutCommit(tagRef);
      await this.state.refreshAll();
    });

    register('intelliGit.tag.copyRevisionNumber', async (arg?: unknown) => {
      const revision = toTagRevision(arg) ?? (await this.pickCommitSha('Pick revision to copy'));
      if (!revision) {
        return;
      }

      await vscode.env.clipboard.writeText(revision);
      void vscode.window.setStatusBarMessage(`Copied ${revision}`, 1500);
    });

    register('intelliGit.tag.showRepositoryAtRevision', async (arg?: unknown) => {
      const revision = toTagRevision(arg) ?? (await this.pickCommitSha('Pick revision'));
      if (!revision) {
        return;
      }

      await this.editor.showRepositoryAtRevision(revision);
    });

    register('intelliGit.tag.compareWithCurrent', async (arg?: unknown) => {
      const revision = toTagRevision(arg) ?? (await this.pickCommitSha('Pick revision to compare with current'));
      if (!revision) {
        return;
      }

      await this.editor.openCompareFromCommit(revision);
    });

    register('intelliGit.tag.createPatch', async (arg?: unknown) => {
      const revision = toTagRevision(arg) ?? (await this.pickCommitSha('Pick revision to export patch'));
      if (!revision) {
        return;
      }

      const patch = await this.git.getPatchForCommit(revision);
      const doc = await vscode.workspace.openTextDocument({
        language: 'diff',
        content: patch
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    });

    register('intelliGit.tag.createCurrent', async () => {
      const sha = await this.git.getCurrentHeadSha();
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

    register('intelliGit.branch.rename', async (arg?: unknown) => {
      const from = toBranchName(arg) ?? (await this.pickBranchName('Pick branch to rename'));
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
      const branch = toBranchName(arg) ?? (await this.pickBranchName('Pick branch to delete'));
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
      const local = toBranchName(arg) ?? (await this.pickBranchName('Pick local branch to track'));
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
      const branch = toBranchName(arg) ?? (await this.pickBranchName('Pick local branch to untrack'));
      if (!branch) {
        return;
      }

      await this.git.untrackBranch(branch);
      await this.state.refreshAll();
    });

    register('intelliGit.branch.mergeIntoCurrent', async (arg?: unknown) => {
      const branch = toBranchName(arg) ?? (await this.pickBranchName('Pick branch to merge into current branch'));
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
      const onto = toBranchName(arg) ?? (await this.pickBranchName('Pick branch to rebase onto'));
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

      await this.startRebaseOperation(() => this.git.rebaseCurrentOnto(onto));
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
      const current = await this.git.getCurrentBranch();
      const target = toBranchName(arg) ?? (await this.pickBranchName('Pick branch to compare with current'));
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

    register('intelliGit.stash.unshelve', async (arg?: unknown) => {
      const item = asStashItem(arg);
      const ref = item?.stash.ref ?? (await this.pickStashRef('Pick stash to unshelve'));
      if (!ref) {
        return;
      }

      await this.git.unstashToWorkingTree(ref);
      await this.state.refreshAll();
      void vscode.window.showInformationMessage(`Unshelved ${ref}.`);
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

    register('intelliGit.graph.openDetails', async (arg?: unknown, selected?: unknown) => {
      const selectedShas = toGraphCommitShas(arg, selected);
      const shouldOpenFirstDiff =
        asGraphItem(arg) !== undefined ||
        (Array.isArray(selected) && selected.some((item) => asGraphItem(item) !== undefined));
      if (selectedShas.length === 0) {
        const picked = await this.pickCommitSha('Pick commit for details');
        if (!picked) {
          return;
        }
        selectedShas.push(picked);
      }

      for (const sha of selectedShas) {
        const subject = this.state.graph.find((commit) => commit.sha === sha)?.subject ?? sha;
        await this.commitFilesView.showCommit(sha, subject);
        if (shouldOpenFirstDiff) {
          const firstFile = this.commitFilesView.getAllFileItems()[0];
          if (firstFile) {
            await this.editor.openCommitFileDiffWithStatus(sha, firstFile.filePath, firstFile.status);
          }
        }
      }
    });

    register('intelliGit.graph.openFileDiff', async (arg?: unknown) => {
      const item = asGraphFileItem(arg);
      if (item) {
        await this.editor.openCommitFileDiff(item.commit.sha, item.filePath);
        return;
      }

      const rangeItem = asCommitRangeFileItem(arg);
      if (rangeItem) {
        await this.editor.openCommitRangeFileDiff(
          rangeItem.fromRef,
          rangeItem.toRef,
          rangeItem.filePath,
          { fromLabel: rangeItem.fromLabel, toLabel: rangeItem.toLabel }
        );
        return;
      }

      const commitItem = asCommitViewFileItem(arg);
      if (!commitItem) {
        return;
      }

      await this.editor.openCommitFileDiffWithStatus(commitItem.sha, commitItem.filePath, commitItem.status);
    });

    register('intelliGit.workingTreeCompare.openFileDiff', async (arg?: unknown) => {
      const item = asWorkingTreeCompareFileItem(arg);
      if (!item) {
        return;
      }

      await this.editor.openWorkingTreeFileDiff(item.filePath, item.ref, item.refLabel, {
        preview: true,
        status: item.status
      });
    });

    register('intelliGit.graph.openRepositoryFileAtRevision', async (arg?: unknown) => {
      const item = asRevisionViewFileItem(arg);
      if (!item) {
        return;
      }

      await this.editor.openFileAtRevision(item.sha, item.filePath);
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

    register('intelliGit.graph.cherryPick', async (arg?: unknown, selected?: unknown) => {
      const selectedShas = toGraphCommitShas(arg, selected);
      if (selectedShas.length === 0) {
        const picked = await this.pickCommitSha('Pick commit to cherry-pick');
        if (!picked) {
          return;
        }
        selectedShas.push(picked);
      }

      const pickedShas: string[] = [];
      const emptyShas: string[] = [];
      const failedShas: string[] = [];
      let conflictSha: string | undefined;
      let issueMessage: string | undefined;

      try {
        for (const sha of selectedShas) {
          try {
            await this.git.cherryPick(sha);
            pickedShas.push(sha);
          } catch (error) {
            const issue = this.classifyCherryPickIssue(error);
            issueMessage = issue.message;
            if (issue.kind === 'nothingToCherryPick') {
              emptyShas.push(sha);
              continue;
            }
            if (issue.kind === 'conflict') {
              conflictSha = sha;
              break;
            }
            failedShas.push(sha);
            break;
          }
        }
      } finally {
        await this.state.refreshAll();
      }

      if (conflictSha) {
        await this.openOperationConflictEditors('cherry-pick');
        void vscode.window.showWarningMessage(
          'There are some conflicts. You have to resolve them first.'
        );
        return;
      }

      if (failedShas.length > 0) {
        const detail = issueMessage ? ` ${issueMessage}` : '';
        const prefix = pickedShas.length > 0
          ? `Cherry-pick stopped after applying ${pickedShas.length} commit(s).`
          : 'Cherry-pick failed.';
        void vscode.window.showErrorMessage(`${prefix}${detail}`);
        return;
      }

      if (pickedShas.length > 0 && emptyShas.length === 0) {
        const message = pickedShas.length === 1
          ? `Cherry-pick succeeded for ${pickedShas[0].slice(0, 8)}.`
          : `Cherry-pick succeeded for ${pickedShas.length} commit(s).`;
        void vscode.window.showInformationMessage(message);
        return;
      }

      if (pickedShas.length === 0 && emptyShas.length > 0) {
        const message = emptyShas.length === 1
          ? `Nothing to cherry-pick for ${emptyShas[0].slice(0, 8)} (already applied or empty).`
          : `Nothing to cherry-pick for ${emptyShas.length} commit(s) (already applied or empty).`;
        void vscode.window.showInformationMessage(message);
        return;
      }

      if (pickedShas.length > 0 && emptyShas.length > 0) {
        void vscode.window.showInformationMessage(
          `Cherry-pick completed: ${pickedShas.length} applied, ${emptyShas.length} already applied or empty.`
        );
      }
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

    register('intelliGit.graph.revert', async (arg?: unknown, selected?: unknown) => {
      const selectedShas = toGraphCommitShas(arg, selected);
      if (selectedShas.length === 0) {
        const picked = await this.pickCommitSha('Pick commit to revert');
        if (!picked) {
          return;
        }
        selectedShas.push(picked);
      }

      for (const sha of selectedShas) {
        await this.git.revertCommit(sha);
      }
      await this.state.refreshAll();
    });

    register('intelliGit.commit.revertSelectedChanges', async (arg?: unknown, selected?: unknown) => {
      const target = await this.resolveSelectedCommitFiles(arg, selected);
      if (!target) {
        void vscode.window.showInformationMessage('Select one or more files from a commit first.');
        return;
      }

      if (!target.canRevert) {
        void vscode.window.showWarningMessage('Selected files belong to a commit that is not in the current branch.');
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Revert selected changes',
        detail: `Commit: ${target.sha}\nFiles: ${target.filePaths.length}\n${target.filePaths.map((path) => `- ${path}`).join('\n')}`,
        acceptLabel: 'Revert'
      });
      if (!confirmed) {
        return;
      }

      await this.git.revertCommitFiles(target.sha, target.filePaths, target.subject);
      await this.state.refreshAll();
      void vscode.window.showInformationMessage(`Reverted selected changes from ${target.sha.slice(0, 8)}.`);
    });

    register('intelliGit.commit.cherryPickSelectedChanges', async (arg?: unknown, selected?: unknown) => {
      const target = await this.resolveSelectedCommitFiles(arg, selected);
      if (!target) {
        void vscode.window.showInformationMessage('Select one or more files from a commit first.');
        return;
      }

      if (!target.canCherryPick) {
        void vscode.window.showWarningMessage('Selected files belong to a commit that is already in the current branch.');
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Cherry-pick selected changes',
        detail: `Commit: ${target.sha}\nFiles: ${target.filePaths.length}\n${target.filePaths.map((path) => `- ${path}`).join('\n')}`,
        acceptLabel: 'Cherry-pick'
      });
      if (!confirmed) {
        return;
      }

      await this.git.cherryPickCommitFiles(target.sha, target.filePaths, target.subject);
      await this.state.refreshAll();
      void vscode.window.showInformationMessage(`Cherry-picked selected changes from ${target.sha.slice(0, 8)}.`);
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

      await this.startRebaseOperation(() => this.git.rebaseInteractive(base));
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
        const subject = (await this.git.getCommitDetails(parent)).commit.subject;
        await this.commitFilesView.showCommit(parent, subject);
        const firstFile = this.commitFilesView.getAllFileItems()[0];
        if (firstFile) {
          await this.editor.openCommitFileDiffWithStatus(parent, firstFile.filePath, firstFile.status);
        }
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

      await this.editor.showRepositoryAtRevision(sha);
    });

    register('intelliGit.graph.filter', async () => {
      GraphFilterView.open(
        {
          apply: async (filters) => {
            await this.state.refreshGraph(filters);
            const isActive = Object.values(filters).some(Boolean);
            await vscode.commands.executeCommand('setContext', 'intelliGit.graphFilterActive', isActive);
          },
          clear: async () => {
            await this.state.clearGraphFilters();
            await vscode.commands.executeCommand('setContext', 'intelliGit.graphFilterActive', false);
          },
          openCommitDetails: async (sha, subject) => this.commitFilesView.showCommit(sha, subject),
          openCommitRangeDetails: async (shas) => this.editor.openCommitRangeDetails(shas),
          getCommitFiles: async (sha) => this.git.getFilesInCommit(sha),
          openFileDiff: async (sha, filePath) => this.editor.openCommitFileDiff(sha, filePath)
        },
        () => ({
          filters: this.state.graphFilters,
          branches: this.state.branches,
          commits: this.state.graph
        })
      );
    });

    register('intelliGit.graph.clearFilter', async () => {
      await this.state.clearGraphFilters();
      await vscode.commands.executeCommand('setContext', 'intelliGit.graphFilterActive', false);
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

    register('intelliGit.conflict.acceptOurs', async (arg?: unknown) => {
      const path = this.pickConflictPathArg(arg) ?? (await this.pickConflictPath('Accept Yours (ours) for which file?'));
      if (!path) { return; }
      await this.git.resolveConflictOurs(path);
      await this.state.refreshChanges();
      void vscode.window.showInformationMessage(`Accepted yours: ${path}`);
    });

    register('intelliGit.conflict.acceptTheirs', async (arg?: unknown) => {
      const path = this.pickConflictPathArg(arg) ?? (await this.pickConflictPath('Accept Theirs for which file?'));
      if (!path) { return; }
      await this.git.resolveConflictTheirs(path);
      await this.state.refreshChanges();
      void vscode.window.showInformationMessage(`Accepted theirs: ${path}`);
    });

    register('intelliGit.conflict.acceptBoth', async (arg?: unknown) => {
      const path = this.pickConflictPathArg(arg) ?? (await this.pickConflictPath('Accept Both: open merge editor for which file?'));
      if (!path) { return; }
      await this.editor.openMergeConflict(path);
    });

    register('intelliGit.operation.abort', async () => {
      const state = await this.git.getOperationState();
      if (state.kind === 'none') {
        void vscode.window.showInformationMessage('No merge/rebase/cherry-pick/revert in progress.');
        return;
      }
      const confirmed = await confirmDangerousAction({
        title: `Abort ${state.kind}`,
        detail: 'This will reset the working tree to before the operation started.',
        acceptLabel: 'Abort'
      });
      if (!confirmed) { return; }
      try {
        if (state.kind === 'merge') { await this.git.mergeAbort(); }
        else if (state.kind === 'rebase') { await this.git.rebaseAbort(); }
        else if (state.kind === 'cherry-pick') { await this.git.cherryPickAbort(); }
        else if (state.kind === 'revert') { await this.git.revertAbort(); }
      } finally {
        await this.state.refreshAll();
      }
    });

    register('intelliGit.operation.continue', async () => {
      const state = await this.git.getOperationState();
      if (state.kind === 'none') {
        void vscode.window.showInformationMessage('No merge/rebase/cherry-pick/revert in progress.');
        return;
      }
      const conflicts = await this.git.getMergeConflicts();
      if (conflicts.length > 0) {
        if (state.kind === 'rebase') {
          await this.handleRebaseConflict();
          return;
        }
        void vscode.window.showWarningMessage(`Resolve all conflicts before continuing (${conflicts.length} remaining).`);
        return;
      }
      try {
        if (state.kind === 'merge') {
          await vscode.commands.executeCommand('intelliGit.merge.finalize');
          return;
        }
        if (state.kind === 'rebase') {
          try {
            await this.git.rebaseContinue();
          } catch (error) {
            const issue = this.classifyRebaseIssue(error);
            await this.state.refreshAll();
            if (issue.kind === 'conflict') {
              await this.handleRebaseConflict();
              return;
            }
            throw error;
          }
          await this.state.refreshAll();
          await this.showRebaseProgressFeedback();
          return;
        }
        if (state.kind === 'cherry-pick') {
          await this.git.cherryPickContinue();
        } else if (state.kind === 'revert') {
          await this.git.revertContinue();
        }
      } finally {
        if (state.kind !== 'rebase') {
          await this.state.refreshAll();
        }
      }
    });

    register('intelliGit.operation.skip', async () => {
      const state = await this.git.getOperationState();
      if (state.kind === 'rebase') {
        await this.git.rebaseSkip();
      } else if (state.kind === 'cherry-pick') {
        await this.git.cherryPickSkip();
      } else {
        void vscode.window.showInformationMessage('Skip is only available during rebase or cherry-pick.');
        return;
      }
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

    register('intelliGit.scm.shelveResource', async (arg?: unknown) => {
      const filePath = toRepoFilePath(arg);
      if (!filePath) {
        void vscode.window.showWarningMessage('Select a Source Control file to shelve.');
        return;
      }

      const defaultMessage = `Shelve ${filePath}`;
      const rawMessage = await vscode.window.showInputBox({
        title: 'Shelve selected change',
        value: defaultMessage,
        placeHolder: 'Shelve message'
      });
      if (rawMessage === undefined) {
        return;
      }

      const message = rawMessage.trim() || defaultMessage;
      const changes = await this.git.getChangedFiles();
      const includeUntracked = changes.some((item) => item.path === filePath && item.status.trim() === '??');

      await this.git.stashFiles([filePath], message, {
        keepIndex: true,
        includeUntracked
      });

      await this.state.refreshAll();
      void vscode.window.showInformationMessage(`Shelved ${filePath}.`);
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

    register('intelliGit.scm.commitTemplate', async () => {
      const repository = await this.getBuiltInGitRepository();
      if (!repository) {
        void vscode.window.showWarningMessage('Git repository context not available.');
        return;
      }

      const templates = loadTemplates();
      if (templates.length === 0) {
        void vscode.window.showInformationMessage('No commit templates configured.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        templates.map((template) => ({
          label: template.label,
          description: template.template,
          template: template.template
        })),
        {
          title: 'Insert commit message template',
          placeHolder: 'Pick a template'
        }
      );
      if (!picked) {
        return;
      }

      let branch = '';
      try {
        branch = await this.git.getCurrentBranch();
      } catch {
        // ignore: branch placeholder will stay empty
      }

      const expanded = expandTemplate(picked.template, { branch }).text;
      repository.inputBox.value = expanded;
    });

    register('intelliGit.scm.generateCommitMessage', async () => {
      const repository = await this.getBuiltInGitRepository();
      if (!repository) {
        void vscode.window.showWarningMessage('Git repository context not available.');
        return;
      }

      const timeoutMs = vscode.workspace.getConfiguration('intelliGit').get<number>('aiGenerateTimeoutMs', 5000);
      const cts = new vscode.CancellationTokenSource();
      const timer = setTimeout(() => cts.cancel(), timeoutMs);

      try {
        const generated = await this.git.generateCommitMessage(cts.token);
        repository.inputBox.value = generated;
      } catch (error) {
        const message = cts.token.isCancellationRequested
          ? `AI generation timed out after ${timeoutMs / 1000}s.`
          : String(error);
        void vscode.window.showErrorMessage(message);
      } finally {
        clearTimeout(timer);
        cts.dispose();
      }
    });

    register('intelliGit.scm.amendFromInput', async () => {
      const repository = await this.getBuiltInGitRepository();
      if (!repository) {
        void vscode.window.showWarningMessage('Git repository context not available.');
        return;
      }

      const commitMessage = repository.inputBox.value.trim();
      const confirmed = await confirmDangerousAction({
        title: 'Amend last commit',
        detail: commitMessage
          ? 'Use the current Source Control commit message and amend the last commit.'
          : 'Amend the last commit without changing its message.',
        acceptLabel: 'Amend'
      });
      if (!confirmed) {
        return;
      }

      await this.git.amendCommit(commitMessage || undefined);
      repository.inputBox.value = '';
      await this.state.refreshAll();
    });

    register('intelliGit.compareWithRevision', async (arg?: unknown) => {
      const uri = asFileResourceUri(arg);
      if (!uri) {
        void vscode.window.showWarningMessage('Right-click a file or folder in the Explorer to compare.');
        return;
      }

      if (!(await this.git.isRepo())) {
        void vscode.window.showErrorMessage('Not inside a Git repository');
        return;
      }

      const gitRoot = await this.git.getGitRoot();
      const normalizedTarget = uri.fsPath.replace(/[\\/]+$/, '');
      const normalizedRoot = gitRoot.replace(/[\\/]+$/, '');
      const repoRelative = normalizedTarget === normalizedRoot
        ? ''
        : this.git.toRepoRelative(uri.fsPath);
      if (repoRelative === undefined) {
        void vscode.window.showErrorMessage('Not inside a Git repository');
        return;
      }

      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        void vscode.window.showErrorMessage('Selected path is no longer available.');
        return;
      }
      const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;

      const selection = await pickRevisionToCompare(this.git, this.state.branches, this.state.tags);
      if (!selection) {
        return;
      }

      if (isDirectory) {
        await this.editor.openCompareWithRevisionForFolder(repoRelative, selection.ref, selection.label);
      } else {
        await this.editor.openCompareWithRevisionForFile(repoRelative, selection.ref, selection.label);
      }
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

    // ── Worktree commands ──────────────────────────────────────────────────

    register('intelliGit.worktree.refresh', async () => {
      await this.state.refreshWorktrees();
    });

    register('intelliGit.worktree.open', async (arg?: unknown) => {
      const item = arg instanceof WorktreeTreeItem ? arg : undefined;
      const worktreePath = item?.worktree.worktreePath;
      if (!worktreePath) { return; }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), { forceReuseWindow: true });
    });

    register('intelliGit.worktree.openInNewWindow', async (arg?: unknown) => {
      const item = arg instanceof WorktreeTreeItem ? arg : undefined;
      const worktreePath = item?.worktree.worktreePath;
      if (!worktreePath) { return; }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), { forceNewWindow: true });
    });

    register('intelliGit.worktree.addFromBranch', async () => {
      const branches = this.state.branches.filter((b) => b.type === 'local');
      const picked = await vscode.window.showQuickPick(
        branches.map((b) => ({ label: b.name })),
        { title: 'Add worktree from branch', placeHolder: 'Select branch' }
      );
      if (!picked) { return; }

      const targetPath = await vscode.window.showInputBox({
        title: 'Worktree path',
        placeHolder: '../my-worktree',
        validateInput: (v) => v.trim() ? undefined : 'Path is required'
      });
      if (!targetPath) { return; }

      await this.git.addWorktree(targetPath.trim(), picked.label);
      await this.state.refreshWorktrees();
    });

    register('intelliGit.worktree.addNewBranch', async () => {
      const branchName = await vscode.window.showInputBox({
        title: 'New branch name',
        placeHolder: 'feature/my-branch',
        validateInput: (v) => v.trim() ? undefined : 'Branch name is required'
      });
      if (!branchName) { return; }

      const base = await this.pickBranchName('Select base branch (optional — press Enter to skip)');

      const targetPath = await vscode.window.showInputBox({
        title: 'Worktree path',
        placeHolder: '../my-worktree',
        validateInput: (v) => v.trim() ? undefined : 'Path is required'
      });
      if (!targetPath) { return; }

      await this.git.addWorktreeBranch(targetPath.trim(), branchName.trim(), base ?? undefined);
      await this.state.refreshWorktrees();
    });

    register('intelliGit.worktree.addDetached', async () => {
      const ref = await vscode.window.showInputBox({
        title: 'Detached worktree at ref',
        placeHolder: 'HEAD, commit SHA, or tag',
        validateInput: (v) => v.trim() ? undefined : 'Ref is required'
      });
      if (!ref) { return; }

      const targetPath = await vscode.window.showInputBox({
        title: 'Worktree path',
        placeHolder: '../my-worktree',
        validateInput: (v) => v.trim() ? undefined : 'Path is required'
      });
      if (!targetPath) { return; }

      const confirmed = await confirmDangerousAction({
        title: 'Add detached worktree',
        detail: `This creates a worktree in detached HEAD state at ${ref}`,
        acceptLabel: 'Create Detached'
      });
      if (!confirmed) { return; }

      await this.git.addDetachedWorktree(targetPath.trim(), ref.trim());
      await this.state.refreshWorktrees();
    });

    register('intelliGit.worktree.remove', async (arg?: unknown) => {
      const item = arg instanceof WorktreeTreeItem ? arg : undefined;
      if (!item) { return; }
      const { worktree } = item;

      if (worktree.isCurrent) {
        void vscode.window.showWarningMessage('Cannot remove the current worktree.');
        return;
      }

      if (worktree.isLocked) {
        void vscode.window.showWarningMessage('Unlock the worktree before removing it.');
        return;
      }

      if (worktree.isDirty) {
        void vscode.window.showWarningMessage(
          `${worktree.worktreePath} has uncommitted changes. Use Force Remove if you want to discard them.`
        );
        return;
      } else {
        const confirmed = await confirmDangerousAction({
          title: 'Remove worktree',
          detail: worktree.worktreePath,
          acceptLabel: 'Remove'
        });
        if (!confirmed) { return; }
      }

      await this.git.removeWorktree(worktree.worktreePath);
      await this.state.refreshWorktrees();
    });

    register('intelliGit.worktree.removeForce', async (arg?: unknown) => {
      const item = arg instanceof WorktreeTreeItem ? arg : undefined;
      if (!item) { return; }
      const { worktree } = item;

      if (worktree.isCurrent) {
        void vscode.window.showWarningMessage('Cannot remove the current worktree.');
        return;
      }

      const confirmed = await confirmDangerousAction({
        title: 'Force remove worktree',
        detail: `${worktree.worktreePath} — all local changes will be lost. This cannot be undone.`,
        acceptLabel: 'Force Remove'
      });
      if (!confirmed) { return; }

      await this.git.removeWorktree(worktree.worktreePath, true);
      await this.state.refreshWorktrees();
    });

    register('intelliGit.worktree.lock', async (arg?: unknown) => {
      const item = arg instanceof WorktreeTreeItem ? arg : undefined;
      if (!item) { return; }

      const reason = await vscode.window.showInputBox({
        title: 'Lock reason (optional)',
        placeHolder: 'e.g. long-running experiment'
      });

      await this.git.lockWorktree(item.worktree.worktreePath, reason?.trim() || undefined);
      await this.state.refreshWorktrees();
    });

    register('intelliGit.worktree.unlock', async (arg?: unknown) => {
      const item = arg instanceof WorktreeTreeItem ? arg : undefined;
      if (!item) { return; }

      await this.git.unlockWorktree(item.worktree.worktreePath);
      await this.state.refreshWorktrees();
    });

    register('intelliGit.worktree.prunePreview', async () => {
      const prunable = await this.git.getPrunableWorktrees();
      if (prunable.length === 0) {
        void vscode.window.showInformationMessage('No prunable worktrees found.');
        return;
      }

      const items = prunable.map((p) => ({ label: p.worktreePath, description: p.reason }));
      await vscode.window.showQuickPick(items, {
        title: 'Prunable worktrees (dry run)',
        placeHolder: 'These worktrees would be pruned',
        canPickMany: false
      });
    });

    register('intelliGit.worktree.prune', async () => {
      const prunable = await this.git.getPrunableWorktrees();
      if (prunable.length === 0) {
        void vscode.window.showInformationMessage('No prunable worktrees found.');
        return;
      }

      const items = prunable.map((p) => ({ label: p.worktreePath, description: p.reason }));
      const confirmed = await vscode.window.showQuickPick(items, {
        title: `Prune ${prunable.length} stale worktree(s)?`,
        placeHolder: 'Review — confirm by pressing Enter',
        canPickMany: false
      });
      if (!confirmed) { return; }

      await this.git.pruneWorktrees();
      await this.state.refreshWorktrees();
      void vscode.window.showInformationMessage('Stale worktrees pruned.');
    });

    register('intelliGit.worktree.revealInFinder', async (arg?: unknown) => {
      const item = arg instanceof WorktreeTreeItem ? arg : undefined;
      if (!item) { return; }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.worktree.worktreePath));
    });

    register('intelliGit.worktree.openTerminal', async (arg?: unknown) => {
      const item = arg instanceof WorktreeTreeItem ? arg : undefined;
      if (!item) { return; }
      const terminal = vscode.window.createTerminal({ cwd: item.worktree.worktreePath, name: `Worktree: ${item.label}` });
      terminal.show();
    });

    // ── Submodule commands ─────────────────────────────────────────────────

    register('intelliGit.submodule.refresh', async () => {
      await this.state.refreshSubmodules();
    });

    register('intelliGit.submodule.init', async (arg?: unknown) => {
      const item = arg instanceof SubmoduleTreeItem ? arg : undefined;
      if (!item) { return; }
      await this.git.initSubmodule(item.submodule.path);
      await this.state.refreshSubmodules();
    });

    register('intelliGit.submodule.initAll', async () => {
      await this.git.initAllSubmodules();
      await this.state.refreshSubmodules();
    });

    register('intelliGit.submodule.update', async (arg?: unknown) => {
      const item = arg instanceof SubmoduleTreeItem ? arg : undefined;
      if (!item) { return; }

      if (item.submodule.isDirty) {
        const confirmed = await confirmDangerousAction({
          title: 'Update dirty submodule',
          detail: `${item.submodule.path} has uncommitted changes.`,
          acceptLabel: 'Update anyway'
        });
        if (!confirmed) { return; }
      }

      await this.git.updateSubmodule(item.submodule.path);
      await this.state.refreshSubmodules();
    });

    register('intelliGit.submodule.updateAll', async () => {
      const submodules = this.state.submodules;
      const dirtyCount = submodules.filter((s) => s.isDirty).length;
      if (dirtyCount > 0) {
        const confirmed = await confirmDangerousAction({
          title: 'Update all submodules',
          detail: `${dirtyCount} submodule(s) have uncommitted changes.`,
          acceptLabel: 'Update all'
        });
        if (!confirmed) { return; }
      }

      void vscode.window.showInformationMessage(`Updating ${submodules.length} submodule(s)…`);
      await this.git.updateAllSubmodules();
      await this.state.refreshSubmodules();
    });

    register('intelliGit.submodule.updateRecursive', async () => {
      const submodules = this.state.submodules;
      const dirtyCount = submodules.filter((s) => s.isDirty).length;
      const confirmed = await confirmDangerousAction({
        title: 'Update all submodules recursively',
        detail: dirtyCount > 0
          ? `${submodules.length} submodule(s) will be updated recursively. ${dirtyCount} have uncommitted changes.`
          : `${submodules.length} submodule(s) will be updated recursively.`,
        acceptLabel: 'Update Recursive'
      });
      if (!confirmed) { return; }

      void vscode.window.showInformationMessage(`Recursively updating ${submodules.length} submodule(s)…`);
      await this.git.updateAllSubmodules(true);
      await this.state.refreshSubmodules();
    });

    register('intelliGit.submodule.sync', async (arg?: unknown) => {
      const item = arg instanceof SubmoduleTreeItem ? arg : undefined;
      if (!item) { return; }
      await this.git.syncSubmodule(item.submodule.path);
      await this.state.refreshSubmodules();
    });

    register('intelliGit.submodule.syncAll', async () => {
      await this.git.syncSubmodule(undefined, true);
      await this.state.refreshSubmodules();
    });

    register('intelliGit.submodule.open', async (arg?: unknown) => {
      const item = arg instanceof SubmoduleTreeItem ? arg : undefined;
      if (!item) { return; }
      const fullPath = `${this.git.gitRoot}/${item.submodule.path}`;
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(fullPath), { forceReuseWindow: true });
    });

    register('intelliGit.submodule.openInNewWindow', async (arg?: unknown) => {
      const item = arg instanceof SubmoduleTreeItem ? arg : undefined;
      if (!item) { return; }
      const fullPath = `${this.git.gitRoot}/${item.submodule.path}`;
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(fullPath), { forceNewWindow: true });
    });

    register('intelliGit.submodule.openTerminal', async (arg?: unknown) => {
      const item = arg instanceof SubmoduleTreeItem ? arg : undefined;
      if (!item) { return; }
      const fullPath = `${this.git.gitRoot}/${item.submodule.path}`;
      const terminal = vscode.window.createTerminal({ cwd: fullPath, name: `Submodule: ${item.submodule.name}` });
      terminal.show();
    });

    register('intelliGit.submodule.checkoutRecorded', async (arg?: unknown) => {
      const item = arg instanceof SubmoduleTreeItem ? arg : undefined;
      if (!item) { return; }
      await this.git.checkoutRecordedSubmoduleCommit(item.submodule.path);
      await this.state.refreshSubmodules();
    });

    register('intelliGit.submodule.pullTrackedBranch', async (arg?: unknown) => {
      const item = arg instanceof SubmoduleTreeItem ? arg : undefined;
      if (!item) { return; }
      await this.git.pullSubmoduleTrackedBranch(item.submodule.path);
      await this.state.refreshSubmodules();
    });

    register('intelliGit.submodule.diffPointer', async (arg?: unknown) => {
      const item = arg instanceof SubmoduleTreeItem ? arg : undefined;
      if (!item) { return; }
      const diff = await this.git.getSubmodulePointerDiff(item.submodule.path);
      if (!diff.trim()) {
        void vscode.window.showInformationMessage('No pointer diff for this submodule.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument({ content: diff, language: 'diff' });
      await vscode.window.showTextDocument(doc);
    });

    register('intelliGit.submodule.stagePointerChange', async (arg?: unknown) => {
      const item = arg instanceof SubmoduleTreeItem ? arg : undefined;
      if (!item) { return; }
      await this.git.stageSubmodulePointer(item.submodule.path);
      await this.state.refreshAll();
    });

    register('intelliGit.submodule.deinit', async (arg?: unknown) => {
      const item = arg instanceof SubmoduleTreeItem ? arg : undefined;
      if (!item) { return; }

      if (item.submodule.isDirty) {
        const confirmed = await confirmDangerousAction({
          title: 'Deinit dirty submodule',
          detail: `${item.submodule.path} has uncommitted changes that will be lost.`,
          acceptLabel: 'Deinit'
        });
        if (!confirmed) { return; }
      } else {
        const confirmed = await confirmDangerousAction({
          title: 'Deinit submodule',
          detail: `This will remove ${item.submodule.path} from the working tree.`,
          acceptLabel: 'Deinit'
        });
        if (!confirmed) { return; }
      }

      await this.git.deinitSubmodule(item.submodule.path, item.submodule.isDirty);
      await this.state.refreshSubmodules();
    });
  }

  private async openBranchCommits(branchName: string): Promise<void> {
    await this.openRefCommits(`branch:${branchName}`, `Branch: ${branchName}`, branchName);
  }

  private async openRefCommits(id: string, title: string, ref: string): Promise<void> {
    await this.state.refreshBranches();
    const maxCommits = Math.max(1, vscode.workspace.getConfiguration('intelliGit').get<number>('maxGraphCommits', 200));
    const commits = await this.git.getGraph(maxCommits, { branch: ref });
    CommitListView.open(
      {
        id,
        title,
        hint: `Showing up to ${maxCommits} commits reachable from ${ref}. Filters update the table locally.`,
        branches: this.state.branches,
        commits
      },
      {
        openCommitDetails: async (sha, subject) => this.commitFilesView.showCommit(sha, subject),
        getCommitFiles: async (sha) => this.git.getFilesInCommit(sha),
        openFileDiff: async (sha, filePath) => this.editor.openCommitFileDiff(sha, filePath)
      }
    );
  }

  private async openQuickActions(): Promise<void> {
    const actions: QuickAction[] = [
      { label: 'Refresh', run: () => this.state.refreshAll() },
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
      { label: 'Open file blame', run: async () => vscode.commands.executeCommand('intelliGit.fileBlame.open') },
      { label: 'Worktree: Add from branch', run: async () => vscode.commands.executeCommand('intelliGit.worktree.addFromBranch') },
      { label: 'Worktree: Add new branch', run: async () => vscode.commands.executeCommand('intelliGit.worktree.addNewBranch') },
      { label: 'Worktree: Prune stale (preview)', run: async () => vscode.commands.executeCommand('intelliGit.worktree.prunePreview') },
      { label: 'Submodule: Init all', run: async () => vscode.commands.executeCommand('intelliGit.submodule.initAll') },
      { label: 'Submodule: Update all', run: async () => vscode.commands.executeCommand('intelliGit.submodule.updateAll') },
      { label: 'Submodule: Sync all', run: async () => vscode.commands.executeCommand('intelliGit.submodule.syncAll') }
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

  private async openBranchActionHub(arg?: unknown): Promise<void> {
    const explicitBranchArg = this.normalizeBranchActionHubArg(arg);
    const branchName =
      (explicitBranchArg ? this.resolveBranchNameForActionHub(explicitBranchArg) ?? explicitBranchArg : undefined)
      ?? (await this.pickBranchName('Pick branch for IntelliGit actions'));

    if (!branchName) {
      return;
    }

    const currentBranch = await this.git.getCurrentBranch();
    const branch = this.state.branches.find((item) => item.name === branchName || item.shortName === branchName);
    const isCurrentBranch = branch ? branch.current : branchName === currentBranch;
    const canRenameOrDelete = branch ? branch.type !== 'remote' : false;

    type BranchHubAction = {
      id: string;
      label: string;
      description?: string;
      run: () => Promise<void>;
    };

    const actions: BranchHubAction[] = [];

    if (!isCurrentBranch) {
      actions.push({
        id: 'checkout',
        label: 'Checkout branch',
        run: async () => {
          await this.git.checkoutBranch(branchName);
          await this.state.refreshAll();
        }
      });
    }

    actions.push({
      id: 'compare',
      label: 'Compare with current',
      description: `${currentBranch} ↔ ${branchName}`,
      run: async () => {
        await this.editor.openBranchCompare(currentBranch, branchName);
      }
    });

    if (canRenameOrDelete) {
      actions.push({
        id: 'rename',
        label: 'Rename branch',
        run: async () => {
          const renamedTo = await vscode.window.showInputBox({
            title: `Rename branch ${branchName}`,
            value: branchName,
            validateInput: (value) => (value.trim() ? undefined : 'Branch name is required')
          });

          if (!renamedTo || renamedTo.trim() === branchName) {
            return;
          }

          await this.git.renameBranch(branchName, renamedTo.trim());
          await this.state.refreshAll();
        }
      });

      actions.push({
        id: 'delete',
        label: 'Delete branch',
        run: async () => {
          const confirmed = await confirmDangerousAction({
            title: 'Delete branch',
            detail: `Branch: ${branchName}`,
            acceptLabel: 'Delete'
          });

          if (!confirmed) {
            return;
          }

          await this.git.deleteBranch(branchName);
          await this.state.refreshAll();
        }
      });
    }

    if (!isCurrentBranch) {
      actions.push({
        id: 'merge',
        label: 'Merge into current branch',
        description: `${branchName} → ${currentBranch}`,
        run: async () => {
          const confirmed = await confirmDangerousAction({
            title: 'Merge into current branch',
            detail: `Source branch: ${branchName}`,
            acceptLabel: 'Merge'
          });

          if (!confirmed) {
            return;
          }

          await this.git.mergeIntoCurrent(branchName);
          await this.state.refreshAll();
        }
      });

      actions.push({
        id: 'rebase',
        label: 'Rebase current onto this branch',
        description: `${currentBranch} onto ${branchName}`,
        run: async () => {
          const confirmed = await confirmDangerousAction({
            title: 'Rebase current branch',
            detail: `Rebase onto: ${branchName}`,
            acceptLabel: 'Rebase'
          });

          if (!confirmed) {
            return;
          }

          await this.startRebaseOperation(() => this.git.rebaseCurrentOnto(branchName));
        }
      });
    }

    const picked = await vscode.window.showQuickPick(
      actions.map((action) => ({
        label: action.label,
        description: action.description,
        id: action.id
      })),
      {
        title: `Branch actions: ${branchName}`,
        placeHolder: 'Choose an action'
      }
    );

    if (!picked) {
      return;
    }

    const action = actions.find((item) => item.id === picked.id);
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

  private pickConflictPathArg(arg: unknown): string | undefined {
    if (typeof arg === 'string' && arg.trim()) { return arg.trim(); }
    return undefined;
  }

  private async pickConflictPath(title: string): Promise<string | undefined> {
    const conflicts = this.state.conflicts.length > 0
      ? this.state.conflicts
      : await this.git.getMergeConflicts();
    if (conflicts.length === 0) {
      void vscode.window.showInformationMessage('No conflicted files.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      conflicts.map((c) => ({ label: c.path, description: c.status })),
      { title }
    );
    return picked?.label;
  }

  private normalizeBranchActionHubArg(arg: unknown): string | undefined {
    if (arg instanceof BranchTreeItem) {
      return arg.branch.name;
    }
    if (typeof arg !== 'string') {
      return undefined;
    }
    const raw = arg.trim();
    return raw || undefined;
  }

  private resolveBranchNameForActionHub(rawBranchName: string): string | undefined {
    const exactMatch = this.state.branches.find((branch) => branch.name === rawBranchName);
    if (exactMatch) {
      return exactMatch.name;
    }

    const uniqueLocalShortMatch = this.state.branches.filter(
      (branch) => branch.type === 'local' && branch.shortName === rawBranchName
    );
    if (uniqueLocalShortMatch.length === 1) {
      return uniqueLocalShortMatch[0].name;
    }

    const uniqueShortMatch = this.state.branches.filter((branch) => branch.shortName === rawBranchName);
    if (uniqueShortMatch.length === 1) {
      return uniqueShortMatch[0].name;
    }

    return undefined;
  }

  private async pickBranchName(title = 'Pick branch', remoteOnly = false): Promise<string | undefined> {
    await this.state.refreshBranches();
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
        detail: `${branch.upstream ? `upstream ${branch.upstream}` : 'no upstream'} · ▲${branch.ahead} ▼${branch.behind}`,
        value: branch.name
      })),
      { title }
    );

    return picked?.value;
  }

  private async pickStashRef(title: string): Promise<string | undefined> {
    await this.state.refreshStashes();
    const picked = await vscode.window.showQuickPick(
      this.state.stashes.map((stash) => ({
        label: stash.ref,
        description: stash.message,
        detail: stash.fileCount === undefined ? 'files not loaded' : `${stash.fileCount} files`
      })),
      { title }
    );

    return picked?.label;
  }

  private async pickCommitSha(title: string): Promise<string | undefined> {
    await this.state.refreshGraph();
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
      files
        .map((uri) => this.git.toRepoRelative(uri.fsPath))
        .filter((rel): rel is string => Boolean(rel))
        .map((label) => ({ label })),
      {
        title,
        matchOnDescription: true
      }
    );

    return picked?.label;
  }

  private async getBuiltInGitRepository(): Promise<GitScmRepository | undefined> {
    const gitExtension = vscode.extensions.getExtension<GitScmExtensionExports>('vscode.git');
    if (!gitExtension) {
      return undefined;
    }

    const gitExports = gitExtension.isActive
      ? gitExtension.exports
      : await gitExtension.activate();
    const gitApi = gitExports?.getAPI(1);
    if (!gitApi) {
      return undefined;
    }

    const rootUri = vscode.Uri.file(this.git.gitRoot);
    const direct = gitApi.getRepository(rootUri);
    if (direct) {
      return direct;
    }

    const normalizedRoot = this.git.gitRoot.replace(/\\/g, '/');
    return gitApi.repositories.find((repo) => repo.rootUri.fsPath.replace(/\\/g, '/') === normalizedRoot)
      ?? gitApi.repositories[0];
  }

  private getActiveFilePath(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      return undefined;
    }

    return this.git.toRepoRelative(uri.fsPath);
  }

  private async resolveSelectedCommitFiles(
    arg: unknown,
    selectedArg: unknown
  ): Promise<{ sha: string; subject: string; filePaths: string[]; canRevert: boolean; canCherryPick: boolean } | undefined> {
    const selectedItems = this.toSelectedItems(arg, selectedArg);
    if (selectedItems.length > 0 && selectedItems[0] instanceof CommitFileTreeItem) {
      const context = this.commitFilesView.getCommitActionContext(selectedItems as CommitFileTreeItem[]);
      if (!context || context.filePaths.length === 0) {
        return undefined;
      }
      return {
        sha: context.sha,
        subject: context.subject,
        filePaths: context.filePaths,
        canRevert: context.canRevertSelected,
        canCherryPick: context.canCherryPickSelected
      };
    }

    const graphItems = selectedItems.filter((item): item is GraphCommitFileTreeItem => item instanceof GraphCommitFileTreeItem);
    if (graphItems.length === 0) {
      return undefined;
    }

    const commitShas = [...new Set(graphItems.map((item) => item.commit.sha))];
    if (commitShas.length !== 1) {
      void vscode.window.showWarningMessage('Select files from a single commit only.');
      return undefined;
    }

    const sha = commitShas[0];
    const commit = graphItems[0].commit;
    const filePaths = [...new Set(graphItems.map((item) => item.filePath))].sort((a, b) => a.localeCompare(b));
    if (filePaths.length === 0) {
      return undefined;
    }

    const canRevert = await this.git.isCommitInCurrentBranch(sha);
    return {
      sha,
      subject: commit.subject,
      filePaths,
      canRevert,
      canCherryPick: !canRevert
    };
  }

  private toSelectedItems(arg: unknown, selectedArg: unknown): Array<GraphCommitFileTreeItem | CommitFileTreeItem> {
    const selectedList = Array.isArray(selectedArg) ? selectedArg : [];
    const first = this.extractSelectableItem(arg);
    const fromSelected = selectedList
      .map((item) => this.extractSelectableItem(item))
      .filter((item): item is GraphCommitFileTreeItem | CommitFileTreeItem => Boolean(item));

    const all = [...fromSelected];
    if (first) {
      all.unshift(first);
    }

    return [...new Set(all)];
  }

  private extractSelectableItem(value: unknown): GraphCommitFileTreeItem | CommitFileTreeItem | undefined {
    if (value instanceof GraphCommitFileTreeItem) {
      return value;
    }
    if (value instanceof CommitFileTreeItem) {
      return value;
    }
    return undefined;
  }

  private classifyCherryPickIssue(error: unknown): { kind: CherryPickIssueKind; message?: string } {
    const message = this.getErrorSummary(error);
    const normalized = message.toLowerCase();

    const emptyMarkers = [
      'nothing to cherry-pick',
      'the previous cherry-pick is now empty',
      'nothing to commit, working tree clean',
      'the patch is empty'
    ];
    if (emptyMarkers.some((marker) => normalized.includes(marker))) {
      return { kind: 'nothingToCherryPick', message };
    }

    const conflictMarkers = [
      'conflict',
      'could not apply',
      'unmerged files',
      'cannot cherry-pick',
      'can not cherry pick',
      'after resolving the conflicts',
      'fix conflicts and then commit the result',
      'cherry-pick failed'
    ];
    if (conflictMarkers.some((marker) => normalized.includes(marker))) {
      return { kind: 'conflict', message };
    }

    return { kind: 'failed', message };
  }

  private classifyRebaseIssue(error: unknown): { kind: RebaseIssueKind; message?: string } {
    const message = this.getErrorSummary(error);
    const normalized = message.toLowerCase();

    const conflictMarkers = [
      'conflict',
      'could not apply',
      'unmerged files',
      'resolve all conflicts manually',
      'after resolving the conflicts',
      'fix conflicts and then run'
    ];
    if (conflictMarkers.some((marker) => normalized.includes(marker))) {
      return { kind: 'conflict', message };
    }

    return { kind: 'failed', message };
  }

  private getErrorSummary(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const firstLine = raw
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    return firstLine ?? 'Unknown git error.';
  }

  private async startRebaseOperation(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      const issue = this.classifyRebaseIssue(error);
      await this.state.refreshAll();
      if (issue.kind === 'conflict') {
        await this.handleRebaseConflict();
        return;
      }
      throw error;
    }

    await this.state.refreshAll();
    await this.showRebaseProgressFeedback();
  }

  private async handleRebaseConflict(): Promise<void> {
    await this.openOperationConflictEditors('rebase');
    void vscode.window.showWarningMessage('There are some conflicts. You have to resolve them first.');
  }

  private async showRebaseProgressFeedback(): Promise<void> {
    const state = this.state.operationState;
    if (state.kind !== 'rebase') {
      void vscode.window.showInformationMessage('Rebase completed successfully.');
      return;
    }

    const progress = state.stepCurrent && state.stepTotal
      ? ` (${state.stepCurrent}/${state.stepTotal})`
      : '';
    const conflicts = this.state.conflicts.length > 0
      ? this.state.conflicts
      : await this.git.getMergeConflicts();
    if (conflicts.length > 0) {
      await this.handleRebaseConflict();
      return;
    }

    void vscode.window.showInformationMessage(
      `Rebase is still in progress${progress}. Continue to process remaining commits or Abort.`
    );
  }

  private async openOperationConflictEditors(operation: 'cherry-pick' | 'rebase'): Promise<void> {
    const conflicts = this.state.conflicts.length > 0
      ? this.state.conflicts
      : await this.git.getMergeConflicts();
    if (conflicts.length === 0) {
      await vscode.commands.executeCommand('workbench.view.scm');
      return;
    }

    let openedCount = 0;
    for (const conflict of conflicts) {
      try {
        await this.editor.openMergeConflict(conflict.path);
        openedCount += 1;
      } catch (error) {
        this.logger.warn(`Failed to open merge editor for ${operation} conflict file ${conflict.path}: ${String(error)}`);
      }
    }

    if (openedCount < conflicts.length) {
      await vscode.commands.executeCommand('workbench.view.scm');
    }
  }

}
