import * as vscode from 'vscode';
import { CompareResult, GraphCommit } from '../types';

type CompareCommitAction =
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

interface CompareCommitActionMessage {
  readonly type: 'commitAction';
  readonly action: CompareCommitAction;
  readonly sha: string;
}

export class CompareView {
  private readonly panel: vscode.WebviewPanel;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      'intelliGit.branchCompare',
      'IntelliGit: Branch Comparison',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
      await this.handleMessage(message);
    });
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active, false);
  }

  dispose(): void {
    this.panel.dispose();
  }

  render(result: CompareResult): void {
    this.panel.title = `Compare ${result.leftRef} <> ${result.rightRef}`;
    this.panel.webview.html = renderCompareHtml(result);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isCompareCommitActionMessage(message)) {
      return;
    }

    const sha = message.sha.trim();
    if (!sha) {
      return;
    }

    switch (message.action) {
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
}

function renderCompareHtml(result: CompareResult): string {
  const leftCommits = renderCommitRows(result.commitsOnlyLeft, 'left');
  const rightCommits = renderCommitRows(result.commitsOnlyRight, 'right');
  const files = result.changedFiles
    .map((file) => `<tr><td>${escapeHtml(file.status)}</td><td>${escapeHtml(file.path)}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Branch Comparison</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-focusBorder);
      --menu-bg: color-mix(in srgb, var(--bg), black 8%);
      --menu-hover: color-mix(in srgb, var(--accent), transparent 75%);
      --menu-separator: color-mix(in srgb, var(--border), transparent 25%);
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--fg);
      background: linear-gradient(145deg, color-mix(in srgb, var(--bg), transparent 0%), color-mix(in srgb, var(--accent), transparent 92%));
      margin: 0;
      padding: 16px;
      height: 100vh;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      gap: 0;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 18px;
      flex-shrink: 0;
    }
    .muted {
      color: var(--muted);
      margin-bottom: 16px;
      flex-shrink: 0;
    }
    .grid {
      display: flex;
      flex-direction: column;
      gap: 16px;
      flex: 2;
      min-height: 0;
      margin-bottom: 16px;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: color-mix(in srgb, var(--bg), white 3%);
      min-width: 0;
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .card h2 {
      margin: 0 0 8px;
      flex-shrink: 0;
    }
    .table-wrap {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      text-align: left;
      border-bottom: 1px solid var(--border);
      padding: 6px 4px;
    }
    th {
      position: sticky;
      top: 0;
      background: color-mix(in srgb, var(--bg), white 3%);
      z-index: 1;
    }
    .sha {
      font-family: var(--vscode-editor-font-family);
      white-space: nowrap;
    }
    .commit-row {
      cursor: context-menu;
    }
    .commit-row:hover {
      background: color-mix(in srgb, var(--accent), transparent 90%);
    }
    .context-menu {
      position: fixed;
      z-index: 1000;
      min-width: 260px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px;
      background: var(--menu-bg);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
      display: none;
      backdrop-filter: blur(12px);
    }
    .context-menu.visible {
      display: block;
    }
    .menu-item {
      width: 100%;
      border: 0;
      background: transparent;
      color: var(--fg);
      text-align: left;
      padding: 8px 10px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
    }
    .menu-item:hover {
      background: var(--menu-hover);
    }
    .menu-item:disabled {
      color: var(--muted);
      cursor: default;
      opacity: 0.65;
    }
    .menu-item:disabled:hover {
      background: transparent;
    }
    .menu-separator {
      height: 1px;
      margin: 6px 2px;
      background: var(--menu-separator);
      border: 0;
    }
  </style>
</head>
<body>
  <h1>Branch Comparison</h1>
  <div class="muted">${escapeHtml(result.leftRef)} vs ${escapeHtml(result.rightRef)}</div>

  <div class="grid">
    <section class="card">
      <h2>Only in ${escapeHtml(result.leftRef)} (${result.commitsOnlyLeft.length})</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>SHA</th><th>Subject</th><th>Author</th><th>Date</th></tr></thead>
          <tbody>${leftCommits}</tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>Only in ${escapeHtml(result.rightRef)} (${result.commitsOnlyRight.length})</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>SHA</th><th>Subject</th><th>Author</th><th>Date</th></tr></thead>
          <tbody>${rightCommits}</tbody>
        </table>
      </div>
    </section>
  </div>

  <section class="card">
    <h2>Changed Files (${result.changedFiles.length})</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Status</th><th>Path</th></tr></thead>
        <tbody>${files || '<tr><td colspan="2">No changed files</td></tr>'}</tbody>
      </table>
    </div>
  </section>

  <div id="commit-context-menu" class="context-menu" role="menu" aria-label="Commit context menu">
    <button class="menu-item" data-action="copyRevisionNumber">Copy Revision Number</button>
    <button class="menu-item" data-action="createPatch">Create Patch...</button>
    <button class="menu-item" data-action="cherryPick">Cherry-Pick</button>
    <div class="menu-separator"></div>
    <button class="menu-item" data-action="checkoutRevision">Checkout Revision</button>
    <button class="menu-item" data-action="showRepositoryAtRevision">Show Repository at Revision</button>
    <button class="menu-item" data-action="compareWithLocal">Compare with Local</button>
    <div class="menu-separator"></div>
    <button class="menu-item" data-action="resetCurrentBranchToHere">Reset Current Branch to Here...</button>
    <button class="menu-item" data-action="revertCommit">Revert Commit</button>
    <button class="menu-item" disabled>Undo Commit...</button>
    <div class="menu-separator"></div>
    <button class="menu-item" disabled>Edit Commit Message...</button>
    <button class="menu-item" disabled>Fixup...</button>
    <button class="menu-item" disabled>Squash Into...</button>
    <button class="menu-item" disabled>Drop Commit</button>
    <button class="menu-item" data-action="interactiveRebaseFromHere">Interactively Rebase from Here...</button>
    <button class="menu-item" disabled>Push All up to Here...</button>
    <div class="menu-separator"></div>
    <button class="menu-item" data-action="newBranch">New Branch...</button>
    <button class="menu-item" data-action="newTag">New Tag...</button>
    <div class="menu-separator"></div>
    <button class="menu-item" disabled>Go to Child Commit</button>
    <button class="menu-item" data-action="goToParentCommit">Go to Parent Commit</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const menu = document.getElementById('commit-context-menu');
    let selectedCommit = null;

    const closeMenu = () => {
      menu.classList.remove('visible');
      selectedCommit = null;
    };

    const openMenu = (x, y, payload) => {
      selectedCommit = payload;
      menu.style.left = '0px';
      menu.style.top = '0px';
      menu.classList.add('visible');

      const menuRect = menu.getBoundingClientRect();
      const maxX = Math.max(8, window.innerWidth - menuRect.width - 8);
      const maxY = Math.max(8, window.innerHeight - menuRect.height - 8);
      const targetX = Math.max(8, Math.min(x, maxX));
      const targetY = Math.max(8, Math.min(y, maxY));

      menu.style.left = targetX + 'px';
      menu.style.top = targetY + 'px';
    };

    document.addEventListener('contextmenu', (event) => {
      const row = event.target && event.target.closest ? event.target.closest('.commit-row') : null;
      if (!row) {
        closeMenu();
        return;
      }

      event.preventDefault();
      const sha = row.getAttribute('data-sha') || '';
      if (!sha) {
        return;
      }

      openMenu(event.clientX, event.clientY, { sha });
    });

    menu.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target.closest('.menu-item[data-action]') : null;
      if (!target || !selectedCommit) {
        return;
      }

      const action = target.getAttribute('data-action');
      if (!action) {
        return;
      }

      vscode.postMessage({
        type: 'commitAction',
        action,
        sha: selectedCommit.sha
      });
      closeMenu();
    });

    document.addEventListener('click', (event) => {
      if (!menu.classList.contains('visible')) {
        return;
      }
      if (!menu.contains(event.target)) {
        closeMenu();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    });

    window.addEventListener('blur', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
  </script>
</body>
</html>`;
}

function renderCommitRows(commits: GraphCommit[], side: 'left' | 'right'): string {
  if (commits.length === 0) {
    return '<tr><td colspan="4">No commits</td></tr>';
  }

  return commits
    .map((commit) => {
      const date = new Date(commit.date);
      const rel = escapeHtml(relativeTime(date));
      const full = escapeHtml(date.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }));
      return `<tr class="commit-row" data-sha="${escapeHtml(commit.sha)}" data-side="${side}" title="${escapeHtml(commit.sha)}"><td class="sha">${escapeHtml(commit.shortSha)}</td><td>${escapeHtml(commit.subject)}</td><td>${escapeHtml(commit.author)}</td><td class="muted" style="white-space:nowrap"><span title="${iso}">${rel}</span></td></tr>`;
    })
    .join('');
}

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isCompareCommitActionMessage(value: unknown): value is CompareCommitActionMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.type === 'commitAction' && typeof candidate.action === 'string' && typeof candidate.sha === 'string';
}
