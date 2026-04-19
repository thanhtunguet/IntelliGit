import * as vscode from 'vscode';
import { EditorOrchestrator } from '../editor/editorOrchestrator';
import { GitService } from '../services/gitService';
import { ChangelistStore } from '../state/changelistStore';
import { expandTemplate, loadTemplates } from '../state/commitTemplates';
import { StateStore } from '../state/stateStore';

export class ChangesWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private readonly _disposables: vscode.Disposable[] = [];

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

    const unstaged = this.state.unstagedChanges;
    await this.changelists.pruneMissing(unstaged.map((c) => c.path));
    const assignments: Record<string, string> = {};
    for (const c of unstaged) {
      const id = this.changelists.getChangelistIdFor(c.path);
      if (id !== this.changelists.defaultId) {
        assignments[c.path] = id;
      }
    }

    void this._view.webview.postMessage({
      type: 'update',
      staged: this.state.stagedChanges,
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

        case 'generateMessage':
          void this._view?.webview.postMessage({ type: 'generatingMessage' });
          try {
            const generated = await this.git.generateCommitMessage();
            void this._view?.webview.postMessage({ type: 'generatedMessage', message: generated });
          } catch (err) {
            void this._view?.webview.postMessage({ type: 'generatedMessage', message: '' });
            void vscode.window.showErrorMessage(String(err));
          }
          break;

        case 'openDiff': {
          const filePath = msg.path as string;
          const section = msg.section as 'staged' | 'unstaged';
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
.file-item{display:flex;align-items:center;padding:2px 8px 2px 20px;cursor:pointer;gap:4px;min-height:22px}
.file-item:hover{background:var(--vscode-list-hoverBackground)}
.file-item:hover .fa{opacity:1}
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
      <span id="genIcon">✨</span> Generate
    </button>
    <button class="btn btn-sec" id="btnTpl" title="Insert commit message template">📝 Template</button>
    <div class="btn-grp" style="margin-left:auto">
      <button class="btn" id="btnCommit">Commit</button>
      <button class="btn" id="btnMore" title="More options">▾</button>
    </div>
  </div>
</div>

<div class="dropdown" id="dropdown" style="display:none">
  <div class="ditem" id="miCommit">Commit</div>
  <div class="ditem" id="miCommitPush">Commit &amp; Push</div>
  <div class="ditem" id="miAmend">Amend Last Commit</div>
</div>

<div class="dropdown" id="tplDropdown" style="display:none"></div>
<div class="dropdown" id="clAssignMenu" style="display:none"></div>
<div class="dropdown" id="clHdrMenu" style="display:none"></div>

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
document.getElementById('btnUnstageAll').addEventListener('click', e => {
  e.stopPropagation();
  vscode.postMessage({ type: 'unstageAll' });
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

document.getElementById('changelistsRoot').addEventListener('click', e => {
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
  const stageAllBtn = e.target.closest('[data-stage-cl]');
  if (stageAllBtn) {
    e.stopPropagation();
    const id = stageAllBtn.getAttribute('data-stage-cl');
    for (const c of pathsInList(id)) {
      vscode.postMessage({ type: 'stageFile', path: c });
    }
    return;
  }
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
let _conflicts = new Set();
function renderFiles(changes, section) {
  if (!changes.length) return '<div class="empty">' + (section==='staged'?'No staged changes':'No changes') + '</div>';
  return changes.map(c => {
    const { name, dir } = fileParts(c.path);
    const isConflict = _conflicts.has(c.path);
    const { label, cls } = isConflict ? { label: '!', cls: 'C' } : statusInfo(c.status, section);
    const ep = esc(c.path), es = esc(c.status);
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
    const clickAction = isConflict ? 'openMergeEditor' : 'openDiff';
    const rowCls = isConflict ? 'file-item cf-item' : 'file-item';
    return \`<div class="\${rowCls}" onclick="act('\${clickAction}','\${ep}','\${es}','\${section}',event)">
      <span class="badge \${cls}">\${label}</span>
      <span class="fname" title="\${ep}">\${esc(name)}</span>
      \${dir ? \`<span class="fdir">\${esc(dir)}</span>\` : ''}
      \${actions}
    </div>\`;
  }).join('');
}

function act(type, path, status, section, e) {
  if (type !== 'openDiff' && type !== 'openMergeEditor') e.stopPropagation();
  vscode.postMessage({ type, path, status, section });
}

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
    if (isDefault) {
      actions.push('<button class="icon-btn" data-hdr-action="new" data-cl-id="default" title="New Changelist">＋</button>');
    } else {
      if (files.length > 0) {
        actions.push('<button class="icon-btn" data-hdr-action="commit" data-cl-id="' + esc(cl.id) + '" title="Commit This Changelist">✓</button>');
      }
      actions.push('<button class="icon-btn" data-hdr-action="rename" data-cl-id="' + esc(cl.id) + '" title="Rename">✎</button>');
      actions.push('<button class="icon-btn" data-hdr-action="delete" data-cl-id="' + esc(cl.id) + '" title="Delete">✕</button>');
    }
    actions.push('<button class="icon-btn" data-stage-cl="' + esc(cl.id) + '" title="Stage All In Changelist">↑</button>');
    const label = isDefault ? 'CHANGES' : 'CHANGELIST · ' + esc(cl.name);
    parts.push(
      '<div class="section-hdr" data-cl-id="' + esc(cl.id) + '">' +
        '<span class="chevron' + (open ? '' : ' closed') + '">▶</span>' +
        label +
        ' <span class="count">(' + files.length + ')</span>' +
        '<div class="hdr-actions">' + actions.join('') + '</div>' +
      '</div>' +
      '<div class="section-body' + (open ? '' : ' hidden') + '">' +
        renderFiles(files, 'unstaged') +
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
      _conflicts = new Set(m.conflicts || []);
      _templates = Array.isArray(m.templates) ? m.templates : [];
      _changelists = Array.isArray(m.changelists) && m.changelists.length > 0 ? m.changelists : [{ id: 'default', name: 'Changes' }];
      _assignments = m.assignments || {};
      _unstaged = m.unstaged || [];
      renderOperation(m.operation, _conflicts.size);
      document.getElementById('cntStaged').textContent = '(' + m.staged.length + ')';
      document.getElementById('sbStaged').innerHTML = renderFiles(m.staged, 'staged');
      renderChangelists();
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
      document.getElementById('btnGen').disabled = true;
      break;
    case 'generatedMessage':
      document.getElementById('genIcon').textContent = '✨';
      document.getElementById('genIcon').className = '';
      document.getElementById('btnGen').disabled = false;
      if (m.message) document.getElementById('msg').value = m.message;
      break;
  }
});
</script>
</body>
</html>`;
  }
}
