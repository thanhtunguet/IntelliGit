import * as vscode from 'vscode';
import { BranchRef } from '../types';

export interface GraphFilters {
  branch?: string;
  author?: string;
  message?: string;
  since?: string;
  until?: string;
}

export interface GraphFilterHandlers {
  apply(filters: GraphFilters): Promise<void>;
  clear(): Promise<void>;
}

type IncomingMessage =
  | { type: 'apply'; filters: GraphFilters }
  | { type: 'clear' }
  | { type: 'close' };

export class GraphFilterView {
  private static current: GraphFilterView | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly handlers: GraphFilterHandlers,
    private readonly getInitial: () => { filters: GraphFilters; branches: BranchRef[] }
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'intelliGit.graphFilter',
      'IntelliGit: Filter Graph',
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
      this.panel.onDidDispose(() => this.dispose())
    );

    this.postInitial();
  }

  static open(
    handlers: GraphFilterHandlers,
    getInitial: () => { filters: GraphFilters; branches: BranchRef[] }
  ): GraphFilterView {
    if (GraphFilterView.current) {
      GraphFilterView.current.panel.reveal(vscode.ViewColumn.Active, false);
      GraphFilterView.current.postInitial();
      return GraphFilterView.current;
    }
    const view = new GraphFilterView(handlers, getInitial);
    GraphFilterView.current = view;
    return view;
  }

  private postInitial(): void {
    const { filters, branches } = this.getInitial();
    const branchNames = Array.from(new Set(branches.map((b) => b.name))).sort();
    void this.panel.webview.postMessage({
      type: 'init',
      filters,
      branches: branchNames
    });
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
    switch (message.type) {
      case 'apply':
        await this.handlers.apply(sanitize(message.filters));
        this.panel.dispose();
        return;
      case 'clear':
        await this.handlers.clear();
        this.panel.dispose();
        return;
      case 'close':
        this.panel.dispose();
        return;
    }
  }

  private dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    if (GraphFilterView.current === this) {
      GraphFilterView.current = undefined;
    }
  }
}

function sanitize(filters: GraphFilters): GraphFilters {
  const trim = (v: string | undefined): string | undefined => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : undefined;
  };
  return {
    branch: trim(filters.branch),
    author: trim(filters.author),
    message: trim(filters.message),
    since: trim(filters.since),
    until: trim(filters.until)
  };
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Filter Graph</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-focusBorder);
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--fg);
      background: var(--bg);
      margin: 0;
      padding: 20px 24px;
      max-width: 720px;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 15px;
      font-weight: 600;
    }
    p.hint {
      margin: 0 0 16px;
      font-size: 11px;
      color: var(--muted);
    }
    form {
      display: grid;
      gap: 14px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    label {
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    label .note {
      text-transform: none;
      font-weight: 400;
      color: var(--muted);
      margin-left: 6px;
    }
    input[type="text"], input[type="date"] {
      padding: 8px 10px;
      font-size: 13px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      outline: none;
      font-family: var(--vscode-font-family);
    }
    input:focus {
      border-color: var(--accent);
    }
    .actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 8px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    button {
      padding: 6px 14px;
      font-size: 12px;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-background);
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--fg));
      border: 1px solid var(--border);
    }
    button.secondary:hover {
      border-color: var(--accent);
    }
    datalist { display: none; }
  </style>
</head>
<body>
  <h1>Filter Graph</h1>
  <p class="hint">Narrow the graph view by commit message, branch, author, or date range. Enter submits.</p>

  <form id="form">
    <div class="field">
      <label for="message">
        Commit message / id
        <span class="note">— keyword in commit subject or message</span>
      </label>
      <input id="message" name="message" type="text" placeholder="e.g. fix login, HOTFIX-123, or a short SHA" autofocus spellcheck="false" />
    </div>

    <div class="field-row">
      <div class="field">
        <label for="branch">Branch / ref</label>
        <input id="branch" name="branch" type="text" placeholder="e.g. main, feature/login" list="branches" spellcheck="false" />
        <datalist id="branches"></datalist>
      </div>
      <div class="field">
        <label for="author">Author</label>
        <input id="author" name="author" type="text" placeholder="name or email fragment" spellcheck="false" />
      </div>
    </div>

    <div class="field-row">
      <div class="field">
        <label for="since">Since</label>
        <input id="since" name="since" type="date" />
      </div>
      <div class="field">
        <label for="until">Until</label>
        <input id="until" name="until" type="date" />
      </div>
    </div>

    <div class="actions">
      <button type="button" class="secondary" id="cancel">Cancel</button>
      <button type="button" class="secondary" id="clear">Clear Filters</button>
      <button type="submit" class="primary" id="apply">Apply</button>
    </div>
  </form>

  <script>
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('form');
    const branchesDatalist = document.getElementById('branches');

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'init') {
        const f = msg.filters || {};
        document.getElementById('message').value = f.message || '';
        document.getElementById('branch').value = f.branch || '';
        document.getElementById('author').value = f.author || '';
        document.getElementById('since').value = f.since || '';
        document.getElementById('until').value = f.until || '';
        renderBranches(msg.branches || []);
      }
    });

    function renderBranches(names) {
      branchesDatalist.innerHTML = names
        .map((n) => '<option value="' + n.replaceAll('"', '&quot;') + '"></option>')
        .join('');
    }

    function collect() {
      const get = (id) => document.getElementById(id).value;
      return {
        message: get('message'),
        branch: get('branch'),
        author: get('author'),
        since: get('since'),
        until: get('until')
      };
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'apply', filters: collect() });
    });

    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'close' });
    });

    document.getElementById('clear').addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        vscode.postMessage({ type: 'close' });
      }
    });
  </script>
</body>
</html>`;
}
