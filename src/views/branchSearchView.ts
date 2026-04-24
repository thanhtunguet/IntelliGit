import * as vscode from 'vscode';
import { BranchRef } from '../types';

export interface BranchSearchHandlers {
  checkout(name: string): Promise<void>;
  openActions(name: string): Promise<void>;
}

type IncomingMessage =
  | { type: 'checkout'; name: string }
  | { type: 'actions'; name: string }
  | { type: 'close' };

export class BranchSearchView {
  private static current: BranchSearchView | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly handlers: BranchSearchHandlers,
    private readonly getBranches: () => BranchRef[],
    onStateChange: (listener: () => void) => vscode.Disposable
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'intelliGit.branchSearch',
      'IntelliGit: Search Branches',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = renderHtml();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
        try {
          await this.handleMessage(message as IncomingMessage);
        } catch (error) {
          void vscode.window.showErrorMessage(
            `IntelliGit: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }),
      onStateChange(() => this.postBranches()),
      this.panel.onDidDispose(() => this.dispose())
    );

    this.postBranches();
  }

  static open(
    handlers: BranchSearchHandlers,
    getBranches: () => BranchRef[],
    onStateChange: (listener: () => void) => vscode.Disposable
  ): BranchSearchView {
    if (BranchSearchView.current) {
      BranchSearchView.current.panel.reveal(vscode.ViewColumn.Active, false);
      return BranchSearchView.current;
    }
    const view = new BranchSearchView(handlers, getBranches, onStateChange);
    BranchSearchView.current = view;
    return view;
  }

  private postBranches(): void {
    const payload = this.getBranches().map((branch) => ({
      name: branch.name,
      shortName: branch.shortName,
      fullName: branch.fullName,
      type: branch.type,
      remoteName: branch.remoteName,
      upstream: branch.upstream,
      ahead: branch.ahead,
      behind: branch.behind,
      current: branch.current,
      lastCommitEpoch: branch.lastCommitEpoch
    }));
    void this.panel.webview.postMessage({ type: 'branches', branches: payload });
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
    switch (message.type) {
      case 'checkout':
        await this.handlers.checkout(message.name);
        this.panel.dispose();
        return;
      case 'actions':
        await this.handlers.openActions(message.name);
        return;
      case 'close':
        this.panel.dispose();
        return;
    }
  }

  private dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    if (BranchSearchView.current === this) {
      BranchSearchView.current = undefined;
    }
  }
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Search Branches</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-focusBorder);
      --row-hover: color-mix(in srgb, var(--accent), transparent 85%);
      --row-active: color-mix(in srgb, var(--accent), transparent 70%);
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--fg);
      background: var(--bg);
      margin: 0;
      padding: 16px 20px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow: hidden;
    }
    .header {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    h1 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
    }
    .hint {
      margin: 0;
      font-size: 11px;
      color: var(--muted);
    }
    .search-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    input[type="text"] {
      flex: 1;
      padding: 8px 10px;
      font-size: 13px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      outline: none;
    }
    input[type="text"]:focus {
      border-color: var(--accent);
    }
    .count {
      font-size: 11px;
      color: var(--muted);
      min-width: 80px;
      text-align: right;
    }
    .list {
      flex: 1;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 0;
      min-height: 0;
    }
    .section {
      padding: 4px 0;
    }
    .section-title {
      padding: 6px 14px 4px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      font-weight: 600;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 14px;
      cursor: pointer;
      user-select: none;
    }
    .row:hover, .row.focused {
      background: var(--row-hover);
    }
    .row.current {
      background: var(--row-active);
    }
    .row-icon {
      font-size: 13px;
      width: 16px;
      text-align: center;
      color: var(--muted);
      flex-shrink: 0;
    }
    .row.current .row-icon { color: var(--vscode-gitDecoration-addedResourceForeground, #89d185); }
    .row-name {
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .row-name mark {
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, 0.4));
      color: inherit;
      border-radius: 2px;
      padding: 0 1px;
    }
    .row-meta {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .row-actions {
      display: none;
      gap: 4px;
      flex-shrink: 0;
    }
    .row:hover .row-actions, .row.focused .row-actions {
      display: flex;
    }
    .row-actions button {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 2px 6px;
      font-size: 10px;
      cursor: pointer;
    }
    .row-actions button:hover {
      color: var(--fg);
      border-color: var(--accent);
    }
    .empty {
      padding: 24px 14px;
      text-align: center;
      color: var(--muted);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Search Branches</h1>
    <p class="hint">Type to filter. Enter to checkout the top match. ↑/↓ to move. Esc to close.</p>
    <div class="search-row">
      <input id="search" type="text" placeholder="Filter by branch name…" autofocus spellcheck="false" />
      <span id="count" class="count">0 branches</span>
    </div>
  </div>
  <div id="list" class="list"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('search');
    const listEl = document.getElementById('list');
    const countEl = document.getElementById('count');

    let branches = [];
    let filtered = [];
    let focusedIndex = 0;

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'branches') {
        branches = msg.branches || [];
        applyFilter();
      }
    });

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    function highlight(text, query) {
      if (!query) return escapeHtml(text);
      const lower = text.toLowerCase();
      const q = query.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx < 0) return escapeHtml(text);
      return (
        escapeHtml(text.slice(0, idx)) +
        '<mark>' + escapeHtml(text.slice(idx, idx + query.length)) + '</mark>' +
        escapeHtml(text.slice(idx + query.length))
      );
    }

    function describe(branch) {
      const parts = [];
      if (branch.current) parts.push('current');
      if (branch.type === 'remote') parts.push('remote');
      if (branch.upstream) parts.push('↑ ' + branch.upstream);
      if (branch.ahead || branch.behind) parts.push('▲' + branch.ahead + ' ▼' + branch.behind);
      return parts.join(' · ');
    }

    function applyFilter() {
      const query = searchInput.value.trim().toLowerCase();
      filtered = branches.filter((b) => {
        if (!query) return true;
        return b.name.toLowerCase().includes(query) || b.shortName.toLowerCase().includes(query);
      });

      filtered.sort((a, b) => {
        if (a.current && !b.current) return -1;
        if (b.current && !a.current) return 1;
        const aEpoch = a.lastCommitEpoch || 0;
        const bEpoch = b.lastCommitEpoch || 0;
        if (aEpoch !== bEpoch) return bEpoch - aEpoch;
        return a.name.localeCompare(b.name);
      });

      focusedIndex = 0;
      render(query);
    }

    function render(query) {
      countEl.textContent = filtered.length + (filtered.length === 1 ? ' branch' : ' branches');

      if (filtered.length === 0) {
        listEl.innerHTML = '<div class="empty">No branches match your search.</div>';
        return;
      }

      const groups = { recent: [], local: [], remote: [] };
      const recentThreshold = 10;
      const sortedByEpoch = [...branches]
        .filter((b) => (b.lastCommitEpoch || 0) > 0)
        .sort((a, b) => (b.lastCommitEpoch || 0) - (a.lastCommitEpoch || 0))
        .slice(0, recentThreshold)
        .map((b) => b.fullName);
      const recentSet = new Set(sortedByEpoch);

      for (const branch of filtered) {
        if (recentSet.has(branch.fullName) && !query) {
          groups.recent.push(branch);
        }
        if (branch.type === 'local') {
          groups.local.push(branch);
        } else {
          groups.remote.push(branch);
        }
      }

      const sections = [
        !query && groups.recent.length > 0 ? { label: 'Recent', items: groups.recent } : null,
        { label: 'Local', items: groups.local },
        { label: 'Remote', items: groups.remote }
      ].filter((s) => s && s.items.length > 0);

      let globalIndex = 0;
      const html = sections
        .map((section) => {
          const rows = section.items
            .map((branch) => {
              const idx = globalIndex++;
              const icon = branch.current ? '✔' : branch.type === 'remote' ? '☁' : '⎇';
              const meta = describe(branch);
              const classes = ['row'];
              if (branch.current) classes.push('current');
              if (idx === focusedIndex) classes.push('focused');
              return '<div class="' + classes.join(' ') + '" data-index="' + idx + '" data-name="' + escapeHtml(branch.name) + '">' +
                '<span class="row-icon">' + icon + '</span>' +
                '<span class="row-name">' + highlight(branch.name, query) + '</span>' +
                (meta ? '<span class="row-meta">' + escapeHtml(meta) + '</span>' : '') +
                '<span class="row-actions">' +
                  '<button data-action="actions" title="More actions">⋯</button>' +
                '</span>' +
                '</div>';
            })
            .join('');
          return '<div class="section"><div class="section-title">' + escapeHtml(section.label) + '</div>' + rows + '</div>';
        })
        .join('');

      listEl.innerHTML = html;
    }

    function rowsFlat() {
      return Array.from(listEl.querySelectorAll('.row'));
    }

    function focusRow(idx) {
      const rows = rowsFlat();
      if (rows.length === 0) return;
      focusedIndex = Math.max(0, Math.min(idx, rows.length - 1));
      rows.forEach((r, i) => r.classList.toggle('focused', i === focusedIndex));
      const row = rows[focusedIndex];
      if (row) row.scrollIntoView({ block: 'nearest' });
    }

    searchInput.addEventListener('input', applyFilter);

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        vscode.postMessage({ type: 'close' });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusRow(focusedIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusRow(focusedIndex - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const rows = rowsFlat();
        const row = rows[focusedIndex];
        if (row) {
          vscode.postMessage({ type: 'checkout', name: row.dataset.name });
        }
      }
    });

    listEl.addEventListener('click', (e) => {
      const target = e.target;
      const actionBtn = target.closest('button[data-action]');
      const row = target.closest('.row');
      if (!row) return;
      const name = row.dataset.name;
      if (!name) return;
      if (actionBtn && actionBtn.dataset.action === 'actions') {
        e.stopPropagation();
        vscode.postMessage({ type: 'actions', name });
        return;
      }
      vscode.postMessage({ type: 'checkout', name });
    });
  </script>
</body>
</html>`;
}
