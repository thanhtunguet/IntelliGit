import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
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

interface CommitClickMessage {
  readonly type: 'commitClick';
  readonly sha: string;
  readonly subject: string;
}

export class CompareView {
  private readonly panel: vscode.WebviewPanel;
  private filesPanel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService
  ) {
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

    this.panel.onDidDispose(() => {
      this.filesPanel?.dispose();
      this.filesPanel = undefined;
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
    if (isCommitClickMessage(message)) {
      await this.openFilesPanel(message.sha, message.subject);
      return;
    }

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

  private async openFilesPanel(sha: string, subject: string): Promise<void> {
    const files = await this.git.getFilesInCommit(sha);

    if (!this.filesPanel) {
      this.filesPanel = vscode.window.createWebviewPanel(
        'intelliGit.commitFiles',
        `Files: ${sha.slice(0, 8)}`,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: false, retainContextWhenHidden: true }
      );
      this.filesPanel.onDidDispose(() => {
        this.filesPanel = undefined;
      });
    }

    this.filesPanel.title = `${sha.slice(0, 8)}: ${subject}`;
    this.filesPanel.webview.html = renderCommitFilesHtml(sha, subject, files);
    this.filesPanel.reveal(vscode.ViewColumn.Beside, true);
  }
}

function renderCompareHtml(result: CompareResult): string {
  const leftCommits = renderCommitRows(result.commitsOnlyLeft, 'left');
  const rightCommits = renderCommitRows(result.commitsOnlyRight, 'right');

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

    document.addEventListener('click', (event) => {
      if (menu.classList.contains('visible')) {
        if (!menu.contains(event.target)) { closeMenu(); }
        return;
      }
      const row = event.target && event.target.closest ? event.target.closest('.commit-row') : null;
      if (!row) { return; }
      const sha = row.getAttribute('data-sha') || '';
      const subject = row.getAttribute('data-subject') || '';
      if (!sha) { return; }
      vscode.postMessage({ type: 'commitClick', sha, subject });
    });

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
      return `<tr class="commit-row" data-sha="${escapeHtml(commit.sha)}" data-subject="${escapeHtml(commit.subject)}" data-side="${side}" title="${escapeHtml(commit.sha)}"><td class="sha">${escapeHtml(commit.shortSha)}</td><td>${escapeHtml(commit.subject)}</td><td>${escapeHtml(commit.author)}</td><td class="muted" style="white-space:nowrap"><span title="${full}">${rel}</span></td></tr>`;
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

function isCommitClickMessage(value: unknown): value is CommitClickMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const c = value as Record<string, unknown>;
  return c.type === 'commitClick' && typeof c.sha === 'string';
}

function renderCommitFilesHtml(sha: string, subject: string, files: string[]): string {
  const tree = buildHtmlFileTree(files, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Commit Files</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-focusBorder);
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      margin: 0;
      padding: 12px 16px;
    }
    h2 { margin: 0 0 4px; font-size: 13px; }
    .sha { font-family: var(--vscode-editor-font-family); color: var(--muted); font-size: 11px; margin-bottom: 12px; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: flex; align-items: center; gap: 4px; padding: 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    li.folder { font-weight: 600; margin-top: 4px; cursor: default; }
    li.file { padding-left: var(--indent, 0px); }
    .icon { width: 16px; flex-shrink: 0; }
  </style>
</head>
<body>
  <h2>${escapeHtml(subject)}</h2>
  <div class="sha">${escapeHtml(sha)}</div>
  <ul>${tree}</ul>
</body>
</html>`;
}

type FileTreeNode = { type: 'folder'; name: string; children: FileTreeNode[] } | { type: 'file'; name: string; path: string };

function buildHtmlFileTree(files: string[], basePath: string): string {
  const folders = new Map<string, string[]>();
  const leaves: string[] = [];

  for (const file of files) {
    const relative = basePath ? file.slice(basePath.length + 1) : file;
    const slash = relative.indexOf('/');
    if (slash === -1) {
      leaves.push(file);
    } else {
      const segment = relative.slice(0, slash);
      const childBase = basePath ? `${basePath}/${segment}` : segment;
      const list = folders.get(childBase) ?? [];
      list.push(file);
      folders.set(childBase, list);
    }
  }

  let html = '';
  const indent = (basePath.split('/').length) * 16;

  for (const [folderPath, children] of [...folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const name = folderPath.split('/').at(-1) ?? folderPath;
    html += `<li class="folder" style="padding-left:${indent}px"><span class="icon">📁</span>${escapeHtml(name)}</li>`;
    html += buildHtmlFileTree(children, folderPath);
  }

  for (const file of leaves.sort()) {
    const name = file.split('/').at(-1) ?? file;
    html += `<li class="file" style="--indent:${indent}px;padding-left:${indent}px" title="${escapeHtml(file)}"><span class="icon">📄</span>${escapeHtml(name)}</li>`;
  }

  return html;
}
