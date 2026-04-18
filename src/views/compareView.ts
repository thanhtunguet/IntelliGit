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

interface FileClickMessage {
  readonly type: 'fileClick';
  readonly sha: string;
  readonly filePath: string;
}

export class CompareView {
  private readonly panel: vscode.WebviewPanel;
  private filesPanel: vscode.WebviewPanel | undefined;
  private disposeCallback: (() => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService,
    private readonly onFileClick: (sha: string, filePath: string) => Promise<void>
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
      try {
        await this.handleMessage(message);
      } catch (error) {
        void vscode.window.showErrorMessage(`IntelliGit: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    this.panel.onDidDispose(() => {
      this.filesPanel?.dispose();
      this.filesPanel = undefined;
      this.disposeCallback?.();
    });
  }

  onDispose(callback: () => void): void {
    this.disposeCallback = callback;
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

    const isNew = !this.filesPanel;

    if (isNew) {
      this.filesPanel = vscode.window.createWebviewPanel(
        'intelliGit.commitFiles',
        'Commit Files',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true }
      );

      this.filesPanel.webview.onDidReceiveMessage(async (message: unknown) => {
        try {
          if (isFileClickMessage(message)) {
            await this.onFileClick(message.sha, message.filePath);
          }
        } catch (error) {
          void vscode.window.showErrorMessage(`IntelliGit: ${error instanceof Error ? error.message : String(error)}`);
        }
      });

      this.filesPanel.onDidDispose(() => {
        this.filesPanel = undefined;
      });
    }

    this.filesPanel!.title = `${sha.slice(0, 8)}: ${subject.slice(0, 40)}`;
    this.filesPanel!.webview.html = renderCommitFilesHtml(sha, subject, files);

    if (!isNew) {
      this.filesPanel!.reveal(vscode.ViewColumn.Beside, true);
    }
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
      table-layout: fixed;
    }
    col.col-sha    { width: 62px; }
    col.col-author { width: 110px; }
    col.col-date   { width: 96px; }
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
    .col-sha {
      font-family: var(--vscode-editor-font-family);
      white-space: nowrap;
      overflow: hidden;
    }
    .col-subject {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .col-author, .col-date {
      position: sticky;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .col-date  { right: 0; }
    .col-author { right: 96px; }
    td.col-author, td.col-date {
      background: color-mix(in srgb, var(--bg), white 3%);
    }
    th.col-author, th.col-date { z-index: 2; }
    .commit-row {
      cursor: context-menu;
    }
    .commit-row:hover {
      background: color-mix(in srgb, var(--accent), transparent 90%);
    }
    .commit-row:hover td.col-author,
    .commit-row:hover td.col-date {
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
          <colgroup><col class="col-sha"><col class="col-subject"><col class="col-author"><col class="col-date"></colgroup>
          <thead><tr><th class="col-sha">SHA</th><th class="col-subject">Subject</th><th class="col-author">Author</th><th class="col-date">Date</th></tr></thead>
          <tbody>${leftCommits}</tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>Only in ${escapeHtml(result.rightRef)} (${result.commitsOnlyRight.length})</h2>
      <div class="table-wrap">
        <table>
          <colgroup><col class="col-sha"><col class="col-subject"><col class="col-author"><col class="col-date"></colgroup>
          <thead><tr><th class="col-sha">SHA</th><th class="col-subject">Subject</th><th class="col-author">Author</th><th class="col-date">Date</th></tr></thead>
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

function renderCommitFilesHtml(sha: string, subject: string, files: string[]): string {
  const tree = buildFileTree(files);
  const rows = renderFileTreeNodes(sha, tree, 0);

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
      --list-hover: var(--vscode-list-hoverBackground);
      --list-active: var(--vscode-list-activeSelectionBackground);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      padding: 8px 0;
      height: 100vh;
      overflow-y: auto;
    }
    .header {
      padding: 4px 12px 8px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 4px;
    }
    .header .sha {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      color: var(--muted);
    }
    .header .subject {
      font-size: 13px;
      font-weight: 600;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tree-row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .tree-row:hover {
      background: var(--list-hover);
    }
    .tree-row.file:hover {
      background: var(--list-hover);
    }
    .icon {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      width: 16px;
      height: 16px;
    }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }
    .indent { display: inline-block; width: 16px; flex-shrink: 0; }
    .folder-toggle {
      display: inline-flex;
      align-items: center;
      width: 16px;
      flex-shrink: 0;
      color: var(--muted);
      font-size: 10px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="sha">${escapeHtml(sha)}</div>
    <div class="subject">${escapeHtml(subject)}</div>
  </div>
  <div id="tree">${rows}</div>
  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('tree').addEventListener('click', (event) => {
      const row = event.target.closest('.tree-row');
      if (!row) return;

      if (row.classList.contains('folder')) {
        const key = row.getAttribute('data-key');
        const children = document.querySelectorAll('[data-parent="' + key + '"]');
        const isOpen = row.getAttribute('data-open') === 'true';
        row.setAttribute('data-open', isOpen ? 'false' : 'true');
        row.querySelector('.folder-toggle').textContent = isOpen ? '▶' : '▼';
        children.forEach(child => {
          child.style.display = isOpen ? 'none' : '';
        });
        return;
      }

      if (row.classList.contains('file')) {
        const sha = row.getAttribute('data-sha');
        const filePath = row.getAttribute('data-path');
        vscode.postMessage({ type: 'fileClick', sha, filePath });
      }
    });
  </script>
</body>
</html>`;
}

interface FileTreeNode {
  name: string;
  path: string;
  children: Map<string, FileTreeNode>;
  isFile: boolean;
}

function buildFileTree(files: string[]): FileTreeNode {
  const root: FileTreeNode = { name: '', path: '', children: new Map(), isFile: false };
  for (const filePath of files) {
    const parts = filePath.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!node.children.has(part)) {
        const childPath = parts.slice(0, i + 1).join('/');
        node.children.set(part, {
          name: part,
          path: childPath,
          children: new Map(),
          isFile: i === parts.length - 1
        });
      }
      node = node.children.get(part)!;
    }
  }
  return root;
}

function renderFileTreeNodes(sha: string, node: FileTreeNode, depth: number): string {
  let html = '';
  const indent = '<span class="indent"></span>'.repeat(depth);

  const sorted = [...node.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  for (const child of sorted) {
    if (child.isFile) {
      html += `<div class="tree-row file" data-sha="${escapeHtml(sha)}" data-path="${escapeHtml(child.path)}">${indent}<span class="icon">${fileIcon()}</span><span class="label">${escapeHtml(child.name)}</span></div>`;
    } else {
      const key = escapeHtml(child.path);
      html += `<div class="tree-row folder" data-key="${key}" data-open="true">${indent}<span class="folder-toggle">▼</span><span class="icon">${folderIcon()}</span><span class="label">${escapeHtml(child.name)}</span></div>`;
      const childrenHtml = renderFileTreeNodes(sha, child, depth + 1);
      html += childrenHtml.replace(/<div class="tree-row/g, `<div data-parent="${key}" class="tree-row`);
    }
  }

  return html;
}

function folderIcon(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14.5 4H8.707L7.146 2.439A.5.5 0 0 0 6.793 2.25H1.5A1.5 1.5 0 0 0 0 3.75v8.5A1.5 1.5 0 0 0 1.5 13.75h13A1.5 1.5 0 0 0 16 12.25V5.5A1.5 1.5 0 0 0 14.5 4z" fill="#C09553"/></svg>`;
}

function fileIcon(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 1.5H3.5A1.5 1.5 0 0 0 2 3v10a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 13V6.5L9 1.5z" fill="currentColor" opacity="0.6"/><path d="M9 1.5V6.5H14" stroke="currentColor" stroke-width="1" fill="none"/></svg>`;
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
      return `<tr class="commit-row" data-sha="${escapeHtml(commit.sha)}" data-subject="${escapeHtml(commit.subject)}" data-side="${side}" title="${escapeHtml(commit.sha)}"><td class="col-sha">${escapeHtml(commit.shortSha)}</td><td class="col-subject">${escapeHtml(commit.subject)}</td><td class="col-author">${escapeHtml(commit.author)}</td><td class="col-date muted"><span title="${full}">${rel}</span></td></tr>`;
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

function isFileClickMessage(value: unknown): value is FileClickMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const c = value as Record<string, unknown>;
  return c.type === 'fileClick' && typeof c.sha === 'string' && typeof c.filePath === 'string';
}
