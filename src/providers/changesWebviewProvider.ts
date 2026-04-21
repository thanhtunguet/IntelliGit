import * as vscode from 'vscode';
import { EditorOrchestrator } from '../editor/editorOrchestrator';
import { GitService } from '../services/gitService';
import { ChangelistStore } from '../state/changelistStore';
import { expandTemplate, loadTemplates } from '../state/commitTemplates';
import { StateStore } from '../state/stateStore';

export class ChangesWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private readonly _disposables: vscode.Disposable[] = [];
  private viewMode: 'tree' | 'list' = 'tree';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService,
    private readonly state: StateStore,
    private readonly editor: EditorOrchestrator,
    private readonly changelists: ChangelistStore
  ) { }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    // Dispose any subscriptions from a previous resolve cycle before re-registering.
    for (const d of this._disposables.splice(0)) { d.dispose(); }
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this._getHtml();

    this._disposables.push(
      this.state.onDidChange(() => { void this._sendUpdate(); }),
      this.changelists.onDidChange(() => { void this._sendUpdate(); }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('intelliGit.commitMessageTemplates') ||
          e.affectsConfiguration('intelliGit.commitMessageTicketPattern')
        ) {
          void this._sendUpdate();
        }
      })
    );

    // Reassert the badge when the view becomes visible again; VS Code can
    // drop badge writes that happen while a WebviewView is hidden.
    this._disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          void this._sendUpdate();
        }
      })
    );

    webviewView.webview.onDidReceiveMessage(
      async (msg: { type: string;[k: string]: unknown }) => {
        await this._handleMessage(msg);
      },
      null,
      this._disposables
    );

    void this._sendUpdate();
  }

  dispose(): void {
    for (const d of this._disposables) { d.dispose(); }
  }

  private _asPaths(value: unknown): string[] {
    if (!Array.isArray(value)) { return []; }
    return [...new Set(value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))];
  }

  toggleViewMode(): void {
    this.viewMode = this.viewMode === 'tree' ? 'list' : 'tree';
    void this._sendUpdate();
  }

  private async _sendUpdate(): Promise<void> {
    if (!this._view) { return; }
    let headMessage = '';
    try { headMessage = await this.git.getHeadCommitMessage(); } catch { /* ignore */ }
    let branch = '';
    try { branch = await this.git.getCurrentBranch(); } catch { /* ignore */ }

    const count = this.state.changes.length;
    this._view.badge = count > 0
      ? { tooltip: `${count} change${count === 1 ? '' : 's'}`, value: count }
      : undefined;

    const unstagedRaw = this.state.unstagedChanges;
    const stagedRaw = this.state.stagedChanges;

    const buildTree = (changes: typeof unstagedRaw): typeof unstagedRaw => {
      return [...changes].sort((a, b) => a.path.localeCompare(b.path));
    };

    const view = this.viewMode;
    const staged = view === 'list' ? [...stagedRaw] : buildTree(stagedRaw);
    const unstaged = view === 'list' ? [...unstagedRaw] : buildTree(unstagedRaw);

    await this.changelists.pruneMissing(unstagedRaw.map((c) => c.path));
    const assignments: Record<string, string> = {};
    for (const c of unstagedRaw) {
      const id = this.changelists.getChangelistIdFor(c.path);
      if (id !== this.changelists.defaultId) {
        assignments[c.path] = id;
      }
    }

    void this._view.webview.postMessage({
      type: 'update',
      viewMode: view,
      staged,
      unstaged,
      headMessage,
      branch,
      operation: this.state.operationState,
      conflicts: this.state.conflicts.map((c) => c.path),
      templates: loadTemplates(),
      changelists: this.changelists.getLists(),
      assignments
    });
  }

  private async _handleMessage(msg: { type: string;[k: string]: unknown }): Promise<void> {
    try {
      switch (msg.type) {
        case 'stageFile':
          await this.git.stageFile(msg.path as string);
          await this.state.refreshChanges();
          break;

        case 'unstageFile':
          await this.git.unstageFile(msg.path as string);
          await this.state.refreshChanges();
          break;

        case 'stageAll':
          await this.git.addAll();
          await this.state.refreshChanges();
          break;

        case 'unstageAll':
          await this.git.unstageAll();
          await this.state.refreshChanges();
          break;

        case 'discardFile': {
          const filePath = msg.path as string;
          const confirm = await vscode.window.showWarningMessage(
            `Discard changes to ${filePath}?`, { modal: true }, 'Discard'
          );
          if (confirm === 'Discard') {
            const change = this.state.changes.find((c) => c.path === filePath);
            await this.git.discardFile(filePath, change?.status === '??');
            await this.state.refreshChanges();
          }
          break;
        }

        case 'stageFiles': {
          const paths = this._asPaths(msg.paths);
          if (paths.length === 0) { break; }
          for (const p of paths) { await this.git.stageFile(p); }
          await this.state.refreshChanges();
          break;
        }

        case 'unstageFiles': {
          const paths = this._asPaths(msg.paths);
          if (paths.length === 0) { break; }
          for (const p of paths) { await this.git.unstageFile(p); }
          await this.state.refreshChanges();
          break;
        }

        case 'discardFiles': {
          const paths = this._asPaths(msg.paths);
          if (paths.length === 0) { break; }
          const confirm = await vscode.window.showWarningMessage(
            paths.length === 1
              ? `Discard changes to ${paths[0]}?`
              : `Discard changes to ${paths.length} files?`,
            { modal: true },
            'Discard'
          );
          if (confirm !== 'Discard') { break; }
          for (const p of paths) {
            const change = this.state.changes.find((c) => c.path === p);
            await this.git.discardFile(p, change?.status === '??');
          }
          await this.state.refreshChanges();
          break;
        }

        case 'shelveFiles': {
          const paths = this._asPaths(msg.paths);
          if (paths.length === 0) { break; }
          const stashMessage = (await vscode.window.showInputBox({
            title: paths.length === 1 ? `Shelve ${paths[0]}` : `Shelve ${paths.length} files`,
            value: 'Shelved changes',
            placeHolder: 'Shelve message'
          }))?.trim();
          if (!stashMessage) { break; }
          const includeUntracked = this.state.changes.some(
            (c) => paths.includes(c.path) && c.status === '??'
          );
          await this.git.stashFiles(paths, stashMessage, { keepIndex: false, includeUntracked });
          await this.state.refreshAll();
          void vscode.window.showInformationMessage(
            `Shelved ${paths.length} file${paths.length === 1 ? '' : 's'}.`
          );
          break;
        }

        case 'discardAll': {
          const unstaged = this.state.unstagedChanges;
          if (unstaged.length === 0) {
            void vscode.window.showInformationMessage('No unstaged changes to discard.');
            break;
          }
          const confirm = await vscode.window.showWarningMessage(
            `Discard all unstaged changes in ${unstaged.length} file${unstaged.length === 1 ? '' : 's'}?`,
            { modal: true },
            'Discard All'
          );
          if (confirm === 'Discard All') {
            for (const change of unstaged) {
              await this.git.discardFile(change.path, change.status === '??');
            }
            await this.state.refreshChanges();
          }
          break;
        }

        case 'commit':
        case 'commitAndPush': {
          if (this.state.operationState.kind !== 'none' && this.state.conflicts.length > 0) {
            void vscode.window.showWarningMessage(
              `Cannot commit: ${this.state.conflicts.length} conflict${this.state.conflicts.length === 1 ? '' : 's'} still unresolved. Resolve all conflicts first.`
            );
            break;
          }
          await this.git.commit(msg.commitMessage as string);
          if (msg.type === 'commitAndPush') { await this.git.push(); }
          await this.state.refreshAll();
          void this._view?.webview.postMessage({ type: 'clearMessage' });
          break;
        }

        case 'amendCommit':
          await this.git.amendCommit((msg.commitMessage as string) || undefined);
          await this.state.refreshAll();
          void this._view?.webview.postMessage({ type: 'clearMessage' });
          break;

        case 'generateMessage': {
          const timeoutMs = vscode.workspace.getConfiguration('intelliGit').get<number>('aiGenerateTimeoutMs', 5000);
          void this._view?.webview.postMessage({ type: 'generatingMessage' });
          const cts = new vscode.CancellationTokenSource();
          const timer = setTimeout(() => cts.cancel(), timeoutMs);
          try {
            const generated = await this.git.generateCommitMessage(cts.token);
            void this._view?.webview.postMessage({ type: 'generatedMessage', message: generated });
          } catch (err) {
            const msg = cts.token.isCancellationRequested
              ? `AI generation timed out after ${timeoutMs / 1000}s.`
              : String(err);
            void this._view?.webview.postMessage({ type: 'generatedMessage', message: '' });
            void vscode.window.showErrorMessage(msg);
          } finally {
            clearTimeout(timer);
            cts.dispose();
          }
          break;
        }

        case 'openDiff': {
          const filePath = msg.path as string;
          const section = msg.section as 'staged' | 'unstaged';
          const status = (msg.status as string | undefined) ?? '';
          if (section === 'unstaged' && status === '??') {
            await this.editor.openWorkingTreeFile(filePath);
            break;
          }
          const [leftRef, rightRef] = section === 'staged'
            ? ['HEAD', 'INDEX']
            : ['INDEX', 'WORKTREE'];
          await this.editor.openDiffForFile({
            path: filePath,
            leftRef,
            rightRef,
            title: `${leftRef} ↔ ${rightRef} · ${filePath}`
          });
          break;
        }

        case 'openMergeEditor':
          await this.editor.openMergeConflict(msg.path as string);
          break;

        case 'acceptOurs':
          await this.git.resolveConflictOurs(msg.path as string);
          await this.state.refreshChanges();
          break;

        case 'acceptTheirs':
          await this.git.resolveConflictTheirs(msg.path as string);
          await this.state.refreshChanges();
          break;

        case 'acceptBoth':
          await this.editor.openMergeConflict(msg.path as string);
          break;

        case 'operationAbort':
          await vscode.commands.executeCommand('intelliGit.operation.abort');
          break;

        case 'operationContinue':
          await vscode.commands.executeCommand('intelliGit.operation.continue');
          break;

        case 'operationSkip':
          await vscode.commands.executeCommand('intelliGit.operation.skip');
          break;

        case 'insertTemplate': {
          const template = String(msg.template ?? '');
          if (!template) {
            break;
          }
          let branch = '';
          try { branch = await this.git.getCurrentBranch(); } catch { /* ignore */ }
          const { text, cursor } = expandTemplate(template, { branch });
          void this._view?.webview.postMessage({ type: 'applyTemplate', text, cursor });
          break;
        }

        case 'createChangelist': {
          const name = await vscode.window.showInputBox({
            prompt: 'New changelist name',
            validateInput: (v) => (v.trim().toLowerCase() === 'changes' ? '"Changes" is reserved.' : undefined)
          });
          if (name && name.trim()) {
            await this.changelists.createList(name);
          }
          break;
        }

        case 'renameChangelist': {
          const id = String(msg.id);
          const current = this.changelists.findById(id);
          if (!current || id === this.changelists.defaultId) { break; }
          const name = await vscode.window.showInputBox({
            prompt: 'Rename changelist',
            value: current.name
          });
          if (name && name.trim()) {
            await this.changelists.renameList(id, name);
          }
          break;
        }

        case 'deleteChangelist': {
          const id = String(msg.id);
          if (id === this.changelists.defaultId) { break; }
          const current = this.changelists.findById(id);
          if (!current) { break; }
          const confirm = await vscode.window.showWarningMessage(
            `Delete changelist "${current.name}"? Its files move to the default changelist.`,
            { modal: true },
            'Delete'
          );
          if (confirm === 'Delete') {
            await this.changelists.deleteList(id);
          }
          break;
        }

        case 'assignToChangelist': {
          const path = String(msg.path);
          const id = String(msg.id);
          await this.changelists.assign(path, id);
          break;
        }

        case 'commitChangelist': {
          const id = String(msg.id);
          const message = String(msg.commitMessage ?? '').trim();
          if (!message) {
            void vscode.window.showWarningMessage('Enter a commit message first.');
            break;
          }
          const unstagedPaths = this.state.unstagedChanges.map((c) => c.path);
          const paths = unstagedPaths.filter((p) => this.changelists.getChangelistIdFor(p) === id);
          if (paths.length === 0) {
            void vscode.window.showWarningMessage('This changelist is empty.');
            break;
          }
          if (this.state.conflicts.length > 0) {
            void vscode.window.showWarningMessage('Resolve all conflicts before committing.');
            break;
          }
          await this.git.commitOnly(message, paths);
          await this.state.refreshAll();
          void this._view?.webview.postMessage({ type: 'clearMessage' });
          break;
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(String(err));
    }
  }

  private _getHtml(): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);overflow-x:hidden}
.commit-panel{padding:8px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-widget-border,#454545))}
textarea{width:100%;min-height:76px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;padding:4px 6px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);resize:vertical;outline:none}
textarea:focus{border-color:var(--vscode-focusBorder)}
textarea::placeholder{color:var(--vscode-input-placeholderForeground)}
.row{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}
.amend-label{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--vscode-descriptionForeground);cursor:pointer;user-select:none}
.amend-label input{cursor:pointer}
.btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:2px;padding:4px 10px;cursor:pointer;font-size:var(--vscode-font-size);font-family:var(--vscode-font-family);display:inline-flex;align-items:center;gap:4px;white-space:nowrap;line-height:1.4}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.btn:disabled{opacity:.5;cursor:default}
.btn-sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-sec:hover{background:var(--vscode-button-secondaryHoverBackground)}
.btn-grp{display:flex;margin-left:auto}
.btn-grp .btn:first-child{border-radius:2px 0 0 2px}
.btn-grp .btn:last-child{border-radius:0 2px 2px 0;padding:4px 7px;border-left:1px solid color-mix(in srgb,var(--vscode-button-background) 80%,#000 20%)}
.icon-btn{background:transparent;color:var(--vscode-foreground);border:none;padding:2px 4px;cursor:pointer;border-radius:2px;font-size:12px;line-height:1;display:inline-flex;align-items:center;opacity:.7}
.icon-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}
.section-hdr{display:flex;align-items:center;padding:4px 8px;background:var(--vscode-sideBarSectionHeader-background);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground));cursor:pointer;gap:4px;user-select:none}
.section-hdr:hover{background:var(--vscode-list-hoverBackground)}
.chevron{font-size:9px;transition:transform .1s;display:inline-block}
.chevron.closed{transform:rotate(-90deg)}
.count{font-weight:normal;opacity:.7;text-transform:none;letter-spacing:0;font-size:var(--vscode-font-size)}
.hdr-actions{margin-left:auto;display:flex;gap:2px;opacity:0}
.section-hdr:hover .hdr-actions{opacity:1}
.section-body{}
.section-body.hidden{display:none}
.bulk-actions{display:flex;gap:6px;padding:6px 8px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-widget-border,#454545));flex-wrap:wrap}
.mini-btn{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:2px;padding:2px 8px;cursor:pointer;font-size:11px;font-family:var(--vscode-font-family);line-height:1.5}
.mini-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
.mini-btn:disabled{opacity:.5;cursor:default}
.file-item{display:flex;align-items:center;padding:2px 8px;cursor:pointer;gap:4px;min-height:22px;user-select:none}
.file-item:hover{background:var(--vscode-list-hoverBackground)}
.file-item:hover .fa{opacity:1}
.file-item.selected{background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-list-inactiveSelectionForeground)}
.file-item.selected:focus,.file-item.selected.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.folder-item{display:flex;align-items:center;padding:2px 8px;cursor:pointer;gap:4px;min-height:22px;user-select:none}
.folder-item:hover{background:var(--vscode-list-hoverBackground)}
.ditem.separator{height:1px;padding:0;background:var(--vscode-menu-separatorBackground,var(--vscode-menu-border,#454545));cursor:default;margin:4px 0}
.ditem.separator:hover{background:var(--vscode-menu-separatorBackground,var(--vscode-menu-border,#454545))}
.ditem.disabled{opacity:.5;cursor:default}
.ditem.disabled:hover{background:transparent;color:var(--vscode-menu-foreground)}
.fname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fdir{font-size:11px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%;flex-shrink:0}
.badge{font-size:10px;font-weight:700;width:14px;text-align:center;flex-shrink:0}
.M{color:var(--vscode-gitDecoration-modifiedResourceForeground,#e2c08d)}
.A{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991)}
.D{color:var(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)}
.R{color:var(--vscode-gitDecoration-renamedResourceForeground,#73c991)}
.U{color:var(--vscode-gitDecoration-untrackedResourceForeground,#73c991)}
.C{color:var(--vscode-gitDecoration-conflictingResourceForeground,#e4676b)}
.fa{display:flex;gap:1px;opacity:0;flex-shrink:0}
.empty{padding:6px 20px;font-size:11px;color:var(--vscode-descriptionForeground);font-style:italic}
.dropdown{position:fixed;background:var(--vscode-menu-background);border:1px solid var(--vscode-menu-border,var(--vscode-widget-border,#454545));border-radius:2px;z-index:9999;min-width:170px;box-shadow:0 2px 8px rgba(0,0,0,.35)}
.ditem{padding:6px 14px;cursor:pointer;font-size:var(--vscode-font-size);color:var(--vscode-menu-foreground);white-space:nowrap}
.ditem:hover{background:var(--vscode-menu-selectionBackground);color:var(--vscode-menu-selectionForeground)}
.spin{display:inline-block;animation:spin 1s linear infinite}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.op-banner{display:none;padding:8px;background:var(--vscode-inputValidation-warningBackground,#5a2d02);color:var(--vscode-inputValidation-warningForeground,#ffcc00);border-bottom:1px solid var(--vscode-inputValidation-warningBorder,#b89500);font-size:12px}
.op-banner.active{display:block}
.op-title{font-weight:600;margin-bottom:4px}
.op-detail{opacity:.85;margin-bottom:6px;font-size:11px}
.op-actions{display:flex;gap:4px;flex-wrap:wrap}
.op-actions .btn{padding:3px 8px;font-size:11px}
.cf-item{background:color-mix(in srgb,var(--vscode-inputValidation-warningBackground,#5a2d02) 18%,transparent)}
</style>
</head>
<body>

<div class="op-banner" id="opBanner">
  <div class="op-title" id="opTitle"></div>
  <div class="op-detail" id="opDetail"></div>
  <div class="op-actions">
    <button class="btn" id="opContinue">Continue</button>
    <button class="btn btn-sec" id="opSkip">Skip</button>
    <button class="btn btn-sec" id="opAbort">Abort</button>
  </div>
</div>

<div class="commit-panel">
  <textarea id="msg" placeholder="Message (Ctrl+Enter to commit)"></textarea>
  <div class="row">
    <label class="amend-label"><input type="checkbox" id="amend"> Amend last commit</label>
  </div>
  <div class="row" style="margin-top:6px">
    <button class="btn btn-sec" id="btnGen" title="Generate commit message with AI">
      <span id="genIcon">✨</span> <span id="genLabel">Generate</span>
    </button>
    <button class="btn btn-sec" id="btnTpl" title="Insert commit message template">📝 Template</button>
    <div class="btn-grp" style="margin-left:auto">
      <button class="btn" id="btnCommit">Commit</button>
      <button class="btn" id="btnMore" title="More options">▾</button>
    </div>
  </div>
</div>

<div class="bulk-actions">
  <button class="mini-btn" id="btnStageAll" title="Stage all unstaged changes">Stage All</button>
  <button class="mini-btn" id="btnUnstageAllBulk" title="Unstage all staged changes">Unstage All</button>
  <button class="mini-btn" id="btnDiscardAll" title="Discard all unstaged changes">Discard All</button>
</div>

<div class="dropdown" id="dropdown" style="display:none">
  <div class="ditem" id="miCommit">Commit</div>
  <div class="ditem" id="miCommitPush">Commit &amp; Push</div>
  <div class="ditem" id="miAmend">Amend Last Commit</div>
</div>

<div class="dropdown" id="tplDropdown" style="display:none"></div>
<div class="dropdown" id="clAssignMenu" style="display:none"></div>
<div class="dropdown" id="clHdrMenu" style="display:none"></div>
<div class="dropdown" id="ctxMenu" style="display:none"></div>

<div class="section-hdr" id="shStaged">
  <span class="chevron" id="cvStaged">▶</span>
  STAGED CHANGES
  <span class="count" id="cntStaged">(0)</span>
  <div class="hdr-actions">
    <button class="icon-btn" id="btnUnstageAll" title="Unstage All Changes">↩</button>
  </div>
</div>
<div class="section-body" id="sbStaged">
  <div class="empty">No staged changes</div>
</div>

<div id="changelistsRoot"></div>

<script>
const vscode = acquireVsCodeApi();
let _headMsg = '';
let _viewMode = 'tree';

/* ── section toggles ── */
let stagedOpen = true;
const clOpen = {}; // id -> boolean
document.getElementById('shStaged').addEventListener('click', e => {
  if (e.target.closest('.hdr-actions')) return;
  stagedOpen = !stagedOpen;
  document.getElementById('sbStaged').classList.toggle('hidden', !stagedOpen);
  document.getElementById('cvStaged').classList.toggle('closed', !stagedOpen);
});

/* ── amend checkbox ── */
const amendEl = document.getElementById('amend');
amendEl.addEventListener('change', () => {
  const ta = document.getElementById('msg');
  if (amendEl.checked && !ta.value.trim()) ta.value = _headMsg;
  syncCommitBtn();
});
function syncCommitBtn() {
  document.getElementById('btnCommit').textContent = amendEl.checked ? 'Amend' : 'Commit';
}

/* ── commit actions ── */
document.getElementById('btnCommit').addEventListener('click', () => doCommit(false));

function doCommit(andPush) {
  const msg = document.getElementById('msg').value.trim();
  if (!msg && !amendEl.checked) { document.getElementById('msg').focus(); return; }
  if (amendEl.checked) {
    vscode.postMessage({ type: 'amendCommit', commitMessage: msg });
  } else {
    vscode.postMessage({ type: andPush ? 'commitAndPush' : 'commit', commitMessage: msg });
  }
}

/* ── dropdown ── */
const dropEl = document.getElementById('dropdown');
document.getElementById('btnMore').addEventListener('click', e => {
  e.stopPropagation();
  if (dropEl.style.display === 'none') {
    const r = e.currentTarget.getBoundingClientRect();
    dropEl.style.top = (r.bottom + 2) + 'px';
    dropEl.style.right = (window.innerWidth - r.right) + 'px';
    dropEl.style.left = 'auto';
    dropEl.style.display = 'block';
  } else {
    dropEl.style.display = 'none';
  }
});
document.addEventListener('click', () => {
  dropEl.style.display = 'none';
  const tpl = document.getElementById('tplDropdown');
  if (tpl) tpl.style.display = 'none';
  const a = document.getElementById('clAssignMenu');
  if (a) a.style.display = 'none';
  const ctx = document.getElementById('ctxMenu');
  if (ctx) ctx.style.display = 'none';
  const clh = document.getElementById('clHdrMenu');
  if (clh) clh.style.display = 'none';
});
document.getElementById('miCommit').addEventListener('click', () => doCommit(false));
document.getElementById('miCommitPush').addEventListener('click', () => doCommit(true));
document.getElementById('miAmend').addEventListener('click', () => {
  amendEl.checked = true;
  const ta = document.getElementById('msg');
  if (!ta.value.trim()) ta.value = _headMsg;
  syncCommitBtn();
  doCommit(false);
});

/* ── generate message ── */
document.getElementById('btnGen').addEventListener('click', () => {
  vscode.postMessage({ type: 'generateMessage' });
});

/* ── stage/unstage all ── */
function postUnstageAll(e) {
  if (e) e.stopPropagation();
  vscode.postMessage({ type: 'unstageAll' });
}
document.getElementById('btnUnstageAll').addEventListener('click', postUnstageAll);
document.getElementById('btnUnstageAllBulk').addEventListener('click', postUnstageAll);
document.getElementById('btnStageAll').addEventListener('click', e => {
  e.stopPropagation();
  vscode.postMessage({ type: 'stageAll' });
});
document.getElementById('btnDiscardAll').addEventListener('click', e => {
  e.stopPropagation();
  vscode.postMessage({ type: 'discardAll' });
});

/* ── template dropdown ── */
let _templates = [];
const tplDropEl = document.getElementById('tplDropdown');
document.getElementById('btnTpl').addEventListener('click', e => {
  e.stopPropagation();
  if (tplDropEl.style.display !== 'none') { tplDropEl.style.display = 'none'; return; }
  if (_templates.length === 0) {
    tplDropEl.innerHTML = '<div class="ditem" style="opacity:.7;cursor:default">No templates configured</div>';
  } else {
    tplDropEl.innerHTML = _templates.map((t, i) =>
      '<div class="ditem" data-tpl-i="' + i + '" title="' + esc(t.template) + '">' + esc(t.label) + '</div>'
    ).join('');
  }
  const r = e.currentTarget.getBoundingClientRect();
  tplDropEl.style.top = (r.bottom + 2) + 'px';
  tplDropEl.style.left = r.left + 'px';
  tplDropEl.style.right = 'auto';
  tplDropEl.style.display = 'block';
});
tplDropEl.addEventListener('click', e => {
  const item = e.target.closest('[data-tpl-i]');
  if (!item) return;
  const idx = parseInt(item.getAttribute('data-tpl-i'), 10);
  const tpl = _templates[idx];
  tplDropEl.style.display = 'none';
  if (tpl) vscode.postMessage({ type: 'insertTemplate', template: tpl.template });
});

/* ── changelist header actions ── */
let _changelists = [{ id: 'default', name: 'Changes' }];
let _assignments = {}; // path -> changelistId
let _unstaged = [];
let _staged = [];
const folderOpen = {}; // key -> boolean

document.getElementById('changelistsRoot').addEventListener('click', e => {
  const folder = e.target.closest('[data-toggle-folder]');
  if (folder) {
    e.stopPropagation();
    const key = folder.getAttribute('data-toggle-folder');
    folderOpen[key] = !(folderOpen[key] !== false); // default true -> toggle
    renderChangelists();
    return;
  }
  const hdrBtn = e.target.closest('[data-hdr-action]');
  if (hdrBtn) {
    e.stopPropagation();
    const action = hdrBtn.getAttribute('data-hdr-action');
    const id = hdrBtn.getAttribute('data-cl-id');
    if (action === 'new') {
      vscode.postMessage({ type: 'createChangelist' });
    } else if (action === 'rename') {
      vscode.postMessage({ type: 'renameChangelist', id });
    } else if (action === 'delete') {
      vscode.postMessage({ type: 'deleteChangelist', id });
    } else if (action === 'commit') {
      const m = document.getElementById('msg').value.trim();
      vscode.postMessage({ type: 'commitChangelist', id, commitMessage: m });
    }
    return;
  }
  const stageAllBtn = e.target.closest('[data-stage-cl]');
  if (stageAllBtn) {
    e.stopPropagation();
    const id = stageAllBtn.getAttribute('data-stage-cl');
    for (const c of pathsInList(id)) {
      vscode.postMessage({ type: 'stageFile', path: c });
    }
    return;
  }
  const hdr = e.target.closest('.section-hdr[data-cl-id]');
  if (hdr) {
    if (e.target.closest('.hdr-actions')) return;
    const id = hdr.getAttribute('data-cl-id');
    clOpen[id] = !(clOpen[id] !== false); // default true → toggle
    renderChangelists();
    return;
  }
  const assignBtn = e.target.closest('[data-assign-path]');
  if (assignBtn) {
    e.stopPropagation();
    openAssignMenu(assignBtn);
    return;
  }
});
document.getElementById('sbStaged').addEventListener('click', e => {
  const folder = e.target.closest('[data-toggle-folder]');
  if (!folder) return;
  e.stopPropagation();
  const key = folder.getAttribute('data-toggle-folder');
  folderOpen[key] = !(folderOpen[key] !== false); // default true -> toggle
  document.getElementById('sbStaged').innerHTML = renderFiles(_staged, 'staged', 'staged');
});

const clAssignMenu = document.getElementById('clAssignMenu');
function openAssignMenu(btn) {
  const path = btn.getAttribute('data-assign-path');
  const current = _assignments[path] || 'default';
  const items = _changelists.map(cl =>
    '<div class="ditem" data-assign-id="' + esc(cl.id) + '" data-assign-target="' + esc(path) + '">' +
    (cl.id === current ? '✓ ' : '  ') + esc(cl.name) +
    '</div>'
  ).join('') + '<div class="ditem" data-assign-new="' + esc(path) + '" style="border-top:1px solid var(--vscode-menu-border,#454545)">＋ New Changelist…</div>';
  clAssignMenu.innerHTML = items;
  const r = btn.getBoundingClientRect();
  clAssignMenu.style.top = (r.bottom + 2) + 'px';
  clAssignMenu.style.left = Math.max(4, r.right - 170) + 'px';
  clAssignMenu.style.right = 'auto';
  clAssignMenu.style.display = 'block';
}
clAssignMenu.addEventListener('click', e => {
  const assign = e.target.closest('[data-assign-id]');
  if (assign) {
    e.stopPropagation();
    const id = assign.getAttribute('data-assign-id');
    const path = assign.getAttribute('data-assign-target');
    clAssignMenu.style.display = 'none';
    vscode.postMessage({ type: 'assignToChangelist', path, id });
    return;
  }
  const neu = e.target.closest('[data-assign-new]');
  if (neu) {
    e.stopPropagation();
    clAssignMenu.style.display = 'none';
    vscode.postMessage({ type: 'createChangelist' });
  }
});

function pathsInList(id) {
  return _unstaged
    .map(c => c.path)
    .filter(p => (_assignments[p] || 'default') === id);
}

/* ── ctrl+enter ── */
document.getElementById('msg').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doCommit(false);
});

/* ── helpers ── */
function statusInfo(rawStatus, section) {
  let ch = '?';
  if (rawStatus === '??') { ch = 'U'; }
  else if (section === 'staged') { ch = rawStatus[0] || '?'; }
  else { ch = rawStatus[1] || '?'; }
  const cls = ['M','A','D','R','C'].includes(ch) ? ch : (ch === 'U' ? 'U' : '');
  return { label: ch === '?' ? 'U' : ch, cls };
}
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fileParts(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? { name: p, dir: '' } : { name: p.slice(i+1), dir: p.slice(0, i) };
}

function joinPath(base, segment) {
  return base ? (base + '/' + segment) : segment;
}

function buildFolderTree(changes) {
  const root = { path: '', folders: new Map(), files: [] };
  for (const c of changes) {
    const parts = c.path.split('/');
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = cursor.folders.get(seg);
      if (!child) {
        child = { path: joinPath(cursor.path, seg), folders: new Map(), files: [] };
        cursor.folders.set(seg, child);
      }
      cursor = child;
    }
    cursor.files.push(c);
  }
  return root;
}

function countTreeFiles(node) {
  let count = node.files.length;
  for (const child of node.folders.values()) count += countTreeFiles(child);
  return count;
}

let _conflicts = new Set();
function renderFileRow(c, section, depth) {
  const { name, dir } = _viewMode === 'list' ? fileParts(c.path) : { name: c.path.split('/').at(-1) || c.path, dir: '' };
  const isConflict = _conflicts.has(c.path);
  const { label, cls } = isConflict ? { label: '!', cls: 'C' } : statusInfo(c.status, section);
  const ep = esc(c.path), es = esc(c.status);
  const padLeft = 8 + depth * 14;
  let actions;
  if (isConflict) {
    actions = \`<div class="fa">
      <button class="icon-btn" onclick="act('openMergeEditor','\${ep}','\${es}','\${section}',event)" title="Open 3-way Merge Editor">⇔</button>
      <button class="icon-btn" onclick="act('acceptOurs','\${ep}','\${es}','\${section}',event)" title="Accept Yours">Y</button>
      <button class="icon-btn" onclick="act('acceptTheirs','\${ep}','\${es}','\${section}',event)" title="Accept Theirs">T</button>
      <button class="icon-btn" onclick="act('acceptBoth','\${ep}','\${es}','\${section}',event)" title="Accept Both (open merge editor)">B</button>
    </div>\`;
  } else if (section === 'staged') {
    actions = \`<div class="fa"><button class="icon-btn" onclick="act('unstageFile','\${ep}','\${es}','staged',event)" title="Unstage">↩</button></div>\`;
  } else {
    actions = \`<div class="fa"><button class="icon-btn" data-assign-path="\${ep}" title="Move to Changelist">⇢</button><button class="icon-btn" onclick="act('stageFile','\${ep}','\${es}','unstaged',event)" title="Stage">+</button><button class="icon-btn" onclick="act('discardFile','\${ep}','\${es}','unstaged',event)" title="Discard Changes">↺</button></div>\`;
  }
  const isSelected = _selSection === section && _selected.has(c.path);
  const selCls = isSelected ? ' selected' : '';
  const baseCls = isConflict ? 'file-item cf-item' : 'file-item';
  return \`<div class="\${baseCls}\${selCls}" style="padding-left:\${padLeft}px" data-path="\${ep}" data-section="\${section}" onclick="onRowClick(event,'\${ep}','\${es}','\${section}')" oncontextmenu="onRowContext(event,'\${ep}','\${es}','\${section}')">
    <span class="badge \${cls}">\${label}</span>
    <span class="fname" title="\${ep}">\${esc(name)}</span>
    \${dir ? \`<span class="fdir">\${esc(dir)}</span>\` : ''}
    \${actions}
  </div>\`;
}

function renderTreeNode(node, section, listKey, depth) {
  const parts = [];
  const folderNames = Array.from(node.folders.keys()).sort((a, b) => a.localeCompare(b));
  for (const name of folderNames) {
    const child = node.folders.get(name);
    const toggleKey = section + ':' + listKey + ':' + child.path;
    const open = folderOpen[toggleKey] !== false;
    const padLeft = 8 + depth * 14;
    const count = countTreeFiles(child);
    parts.push(
      '<div class="folder-item" style="padding-left:' + padLeft + 'px" data-toggle-folder="' + esc(toggleKey) + '"' +
        ' oncontextmenu="onFolderContext(event,\\'' + esc(section) + '\\',\\'' + esc(child.path) + '\\')">' +
        '<span class="chevron' + (open ? '' : ' closed') + '">▶</span>' +
        '<span class="fname">' + esc(name) + '</span>' +
        '<span class="count">(' + count + ')</span>' +
      '</div>'
    );
    if (open) {
      parts.push(renderTreeNode(child, section, listKey, depth + 1));
    }
  }
  const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const c of files) {
    parts.push(renderFileRow(c, section, depth));
  }
  return parts.join('');
}

function renderFiles(changes, section, listKey = 'default') {
  if (!changes.length) return '<div class="empty">' + (section==='staged'?'No staged changes':'No changes') + '</div>';
  if (_viewMode === 'list') {
    return [...changes].sort((a, b) => a.path.localeCompare(b.path)).map(c => renderFileRow(c, section, 1)).join('');
  }
  const tree = buildFolderTree(changes);
  return renderTreeNode(tree, section, listKey, 1);
}

function setBulkButtons(stagedCount, unstagedCount) {
  const stageAllBtn = document.getElementById('btnStageAll');
  const unstageAllBtn = document.getElementById('btnUnstageAllBulk');
  const discardAllBtn = document.getElementById('btnDiscardAll');
  stageAllBtn.disabled = unstagedCount === 0;
  unstageAllBtn.disabled = stagedCount === 0;
  discardAllBtn.disabled = unstagedCount === 0;
}

function act(type, path, status, section, e) {
  if (type !== 'openDiff' && type !== 'openMergeEditor') e.stopPropagation();
  vscode.postMessage({ type, path, status, section });
}

/* ── selection + context menu ── */
let _selSection = null;
let _selected = new Set();
let _anchor = null;

function ensureSection(section) {
  if (_selSection !== section) {
    _selSection = section;
    _selected = new Set();
    _anchor = null;
  }
}
function repaintSelection() {
  document.querySelectorAll('.file-item[data-path]').forEach(el => {
    const p = el.getAttribute('data-path');
    const s = el.getAttribute('data-section');
    el.classList.toggle('selected', _selSection === s && _selected.has(p));
  });
}
function pruneSelection() {
  if (!_selSection) return;
  const src = _selSection === 'staged' ? _staged : _unstaged;
  const valid = new Set(src.map(c => c.path));
  for (const p of [..._selected]) if (!valid.has(p)) _selected.delete(p);
  if (_anchor && !valid.has(_anchor)) _anchor = null;
  if (_selected.size === 0) _selSection = null;
}
function selectRange(fromPath, toPath, section) {
  const rows = [...document.querySelectorAll('.file-item[data-section="' + section + '"]')]
    .map(el => el.getAttribute('data-path'));
  const iTo = rows.indexOf(toPath);
  if (iTo < 0) return;
  const iFrom = fromPath ? rows.indexOf(fromPath) : iTo;
  const lo = Math.min(iFrom < 0 ? iTo : iFrom, iTo);
  const hi = Math.max(iFrom < 0 ? iTo : iFrom, iTo);
  _selected = new Set(rows.slice(lo, hi + 1));
}

function onRowClick(event, path, status, section) {
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault(); event.stopPropagation();
    ensureSection(section);
    if (_selected.has(path)) _selected.delete(path); else _selected.add(path);
    _anchor = path;
    if (_selected.size === 0) _selSection = null;
    repaintSelection();
    return;
  }
  if (event.shiftKey) {
    event.preventDefault(); event.stopPropagation();
    ensureSection(section);
    selectRange(_anchor, path, section);
    repaintSelection();
    return;
  }
  _selSection = section;
  _selected = new Set([path]);
  _anchor = path;
  repaintSelection();
  const type = _conflicts.has(path) ? 'openMergeEditor' : 'openDiff';
  vscode.postMessage({ type, path, status, section });
}

const ctxMenuEl = document.getElementById('ctxMenu');
function openCtxMenu(x, y, section) {
  const count = _selected.size;
  if (count === 0) return;
  const items = [];
  if (section === 'unstaged') {
    items.push({ action: 'stage', label: count === 1 ? 'Add Change to Staged' : 'Add ' + count + ' Changes to Staged' });
  } else {
    items.push({ action: 'unstage', label: count === 1 ? 'Remove Change from Staged' : 'Remove ' + count + ' Changes from Staged' });
  }
  items.push({ action: 'revert', label: count === 1 ? 'Revert File' : 'Revert ' + count + ' Files' });
  items.push({ sep: true });
  items.push({ action: 'shelve', label: count === 1 ? 'Shelve Changes…' : 'Shelve ' + count + ' Files…' });
  ctxMenuEl.innerHTML = items.map(it => it.sep
    ? '<div class="ditem separator"></div>'
    : '<div class="ditem" data-ctx-action="' + esc(it.action) + '">' + esc(it.label) + '</div>'
  ).join('');
  ctxMenuEl.dataset.section = section;
  const menuW = 220;
  const menuH = items.length * 28 + 8;
  const left = Math.min(x, Math.max(4, window.innerWidth - menuW - 4));
  const top = Math.min(y, Math.max(4, window.innerHeight - menuH - 4));
  ctxMenuEl.style.left = left + 'px';
  ctxMenuEl.style.top = top + 'px';
  ctxMenuEl.style.right = 'auto';
  ctxMenuEl.style.display = 'block';
}
function onRowContext(event, path, status, section) {
  event.preventDefault(); event.stopPropagation();
  if (_selSection !== section || !_selected.has(path)) {
    _selSection = section;
    _selected = new Set([path]);
    _anchor = path;
    repaintSelection();
  }
  openCtxMenu(event.clientX, event.clientY, section);
}
function onFolderContext(event, section, folderPath) {
  event.preventDefault(); event.stopPropagation();
  const src = section === 'staged' ? _staged : _unstaged;
  const prefix = folderPath + '/';
  const paths = src
    .filter(c => c.path === folderPath || c.path.startsWith(prefix))
    .map(c => c.path);
  if (paths.length === 0) return;
  _selSection = section;
  _selected = new Set(paths);
  _anchor = paths[paths.length - 1];
  repaintSelection();
  openCtxMenu(event.clientX, event.clientY, section);
}
ctxMenuEl.addEventListener('click', e => {
  const it = e.target.closest('[data-ctx-action]');
  if (!it) return;
  e.stopPropagation();
  const action = it.getAttribute('data-ctx-action');
  const section = ctxMenuEl.dataset.section;
  ctxMenuEl.style.display = 'none';
  const paths = [..._selected];
  if (paths.length === 0) return;
  if (action === 'stage') vscode.postMessage({ type: 'stageFiles', paths });
  else if (action === 'unstage') vscode.postMessage({ type: 'unstageFiles', paths });
  else if (action === 'revert') vscode.postMessage({ type: 'discardFiles', paths });
  else if (action === 'shelve') vscode.postMessage({ type: 'shelveFiles', paths, section });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ctxMenuEl.style.display = 'none';
    clHdrMenuEl.style.display = 'none';
  }
});
document.addEventListener('contextmenu', e => {
  if (!e.target.closest('.file-item, .folder-item')) {
    ctxMenuEl.style.display = 'none';
  }
  if (!e.target.closest('.section-hdr[data-cl-id]')) {
    clHdrMenuEl.style.display = 'none';
  }
});

const clHdrMenuEl = document.getElementById('clHdrMenu');
function onChangelistHdrContext(event, clId) {
  event.preventDefault(); event.stopPropagation();
  const isDefault = clId === 'default';
  const items = [{ action: 'new', label: '＋ New Changelist…' }];
  if (!isDefault) {
    items.push({ sep: true });
    items.push({ action: 'rename', label: 'Rename Changelist…' });
    items.push({ action: 'delete', label: 'Delete Changelist' });
  }
  clHdrMenuEl.innerHTML = items.map(it => it.sep
    ? '<div class="ditem separator"></div>'
    : '<div class="ditem" data-hdr-ctx="' + esc(it.action) + '">' + esc(it.label) + '</div>'
  ).join('');
  clHdrMenuEl.dataset.clId = clId;
  const menuW = 220;
  const menuH = items.length * 28 + 8;
  const left = Math.min(event.clientX, Math.max(4, window.innerWidth - menuW - 4));
  const top = Math.min(event.clientY, Math.max(4, window.innerHeight - menuH - 4));
  clHdrMenuEl.style.left = left + 'px';
  clHdrMenuEl.style.top = top + 'px';
  clHdrMenuEl.style.right = 'auto';
  clHdrMenuEl.style.display = 'block';
}
clHdrMenuEl.addEventListener('click', e => {
  const it = e.target.closest('[data-hdr-ctx]');
  if (!it) return;
  e.stopPropagation();
  const action = it.getAttribute('data-hdr-ctx');
  const id = clHdrMenuEl.dataset.clId;
  clHdrMenuEl.style.display = 'none';
  if (action === 'new') vscode.postMessage({ type: 'createChangelist' });
  else if (action === 'rename') vscode.postMessage({ type: 'renameChangelist', id });
  else if (action === 'delete') vscode.postMessage({ type: 'deleteChangelist', id });
});

document.getElementById('opAbort').addEventListener('click', () => vscode.postMessage({ type: 'operationAbort' }));
document.getElementById('opContinue').addEventListener('click', () => vscode.postMessage({ type: 'operationContinue' }));
document.getElementById('opSkip').addEventListener('click', () => vscode.postMessage({ type: 'operationSkip' }));

function renderOperation(op, conflictCount) {
  const banner = document.getElementById('opBanner');
  if (!op || op.kind === 'none') { banner.classList.remove('active'); return; }
  banner.classList.add('active');
  const labels = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting' };
  let title = labels[op.kind] || op.kind;
  if (op.headShort) title += ' · ' + esc(op.headShort);
  if (op.ontoShort) title += ' → ' + esc(op.ontoShort);
  document.getElementById('opTitle').textContent = title;
  const parts = [];
  if (typeof op.stepCurrent === 'number' && typeof op.stepTotal === 'number') parts.push('Step ' + op.stepCurrent + '/' + op.stepTotal);
  parts.push(conflictCount + ' conflict' + (conflictCount === 1 ? '' : 's'));
  if (op.message) parts.push(esc(op.message));
  document.getElementById('opDetail').textContent = parts.join(' · ');
  const skip = document.getElementById('opSkip');
  skip.style.display = (op.kind === 'rebase' || op.kind === 'cherry-pick') ? '' : 'none';
  const cont = document.getElementById('opContinue');
  cont.disabled = conflictCount > 0;
  cont.title = conflictCount > 0 ? 'Resolve all conflicts first' : '';
}

function renderChangelists() {
  const root = document.getElementById('changelistsRoot');
  const byList = new Map();
  for (const cl of _changelists) byList.set(cl.id, []);
  for (const c of _unstaged) {
    const id = _assignments[c.path] || 'default';
    if (byList.has(id)) byList.get(id).push(c);
    else byList.get('default').push(c);
  }
  const parts = [];
  for (const cl of _changelists) {
    const files = byList.get(cl.id) || [];
    const isDefault = cl.id === 'default';
    const open = clOpen[cl.id] !== false;
    const actions = [];
    if (!isDefault) {
      if (files.length > 0) {
        actions.push('<button class="icon-btn" data-hdr-action="commit" data-cl-id="' + esc(cl.id) + '" title="Commit This Changelist">✓</button>');
      }
      actions.push('<button class="icon-btn" data-hdr-action="rename" data-cl-id="' + esc(cl.id) + '" title="Rename">✎</button>');
      actions.push('<button class="icon-btn" data-hdr-action="delete" data-cl-id="' + esc(cl.id) + '" title="Delete">✕</button>');
    }
    actions.push('<button class="icon-btn" data-stage-cl="' + esc(cl.id) + '" title="Add All to Staged">＋</button>');
    const label = isDefault ? 'CHANGES' : 'CHANGELIST · ' + esc(cl.name);
    parts.push(
      '<div class="section-hdr" data-cl-id="' + esc(cl.id) + '"' +
        ' oncontextmenu="onChangelistHdrContext(event,\\'' + esc(cl.id) + '\\')">' +
        '<span class="chevron' + (open ? '' : ' closed') + '">▶</span>' +
        label +
        ' <span class="count">(' + files.length + ')</span>' +
        '<div class="hdr-actions">' + actions.join('') + '</div>' +
      '</div>' +
      '<div class="section-body' + (open ? '' : ' hidden') + '">' +
        renderFiles(files, 'unstaged', cl.id) +
      '</div>'
    );
  }
  root.innerHTML = parts.join('');
}

/* ── messages from extension ── */
window.addEventListener('message', e => {
  const m = e.data;
  switch (m.type) {
    case 'update':
      _headMsg = m.headMessage || '';
      _viewMode = m.viewMode === 'list' ? 'list' : 'tree';
      _conflicts = new Set(m.conflicts || []);
      _templates = Array.isArray(m.templates) ? m.templates : [];
      _changelists = Array.isArray(m.changelists) && m.changelists.length > 0 ? m.changelists : [{ id: 'default', name: 'Changes' }];
      _assignments = m.assignments || {};
      _unstaged = m.unstaged || [];
      _staged = m.staged || [];
      pruneSelection();
      setBulkButtons(_staged.length, _unstaged.length);
      renderOperation(m.operation, _conflicts.size);
      document.getElementById('cntStaged').textContent = '(' + m.staged.length + ')';
      document.getElementById('sbStaged').innerHTML = renderFiles(_staged, 'staged', 'staged');
      renderChangelists();
      repaintSelection();
      break;
    case 'clearMessage':
      document.getElementById('msg').value = '';
      amendEl.checked = false;
      syncCommitBtn();
      break;
    case 'applyTemplate': {
      const ta = document.getElementById('msg');
      ta.value = m.text || '';
      ta.focus();
      const c = Math.min(m.cursor || 0, ta.value.length);
      try { ta.setSelectionRange(c, c); } catch (_) { /* noop */ }
      break;
    }
    case 'generatingMessage':
      document.getElementById('genIcon').textContent = '⟳';
      document.getElementById('genIcon').className = 'spin';
      document.getElementById('genLabel').textContent = 'Generating…';
      document.getElementById('btnGen').disabled = true;
      document.getElementById('msg').disabled = true;
      break;
    case 'generatedMessage':
      document.getElementById('genIcon').textContent = '✨';
      document.getElementById('genIcon').className = '';
      document.getElementById('genLabel').textContent = 'Generate';
      document.getElementById('btnGen').disabled = false;
      document.getElementById('msg').disabled = false;
      if (m.message) document.getElementById('msg').value = m.message;
      break;
  }
});
</script>
</body>
</html>`;
  }
}
