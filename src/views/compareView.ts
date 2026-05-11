import * as vscode from 'vscode';
import XLSX from 'xlsx';
import { renderTemplate } from './templateRenderer';
import { handleCommitAction, isCommitActionMessage } from './commitActions';
import { formatCommitDate } from './commitDate';
import { CompareResult, GraphCommit } from '../types';

interface CommitClickMessage {
  readonly type: 'commitClick';
  readonly sha: string;
  readonly subject: string;
}

interface CommitRangeClickMessage {
  readonly type: 'commitRangeClick';
  readonly shas: readonly string[];
}

export interface CompareCommitRangeSelection {
  readonly side: 'left' | 'right';
  readonly shas: readonly string[];
}

interface CompareExportCommit {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
}

type CompareExportFormat = 'csv' | 'excel';

interface ExportCompareMessage {
  readonly type: 'exportCompare';
  readonly format?: CompareExportFormat;
  readonly leftRef: string;
  readonly rightRef: string;
  readonly leftCommits: CompareExportCommit[];
  readonly rightCommits: CompareExportCommit[];
}

export class CompareView {
  private readonly panel: vscode.WebviewPanel;
  private disposeCallback: (() => void) | undefined;
  private currentResult: CompareResult | undefined;

  constructor(
    private readonly onCommitClick: (sha: string, subject: string) => Promise<void>,
    private readonly onCommitRangeClick: (selection: CompareCommitRangeSelection) => Promise<void>
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
    this.currentResult = result;
    this.panel.title = `Compare ${result.leftRef} <> ${result.rightRef}`;
    this.panel.webview.html = renderCompareHtml(result, this.getCompareExportFormat());
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (isCommitClickMessage(message)) {
      await this.onCommitClick(message.sha, message.subject);
      return;
    }

    if (isCommitRangeClickMessage(message)) {
      const selection = this.resolveContinuousSelection(message.shas);
      if (selection) {
        await this.onCommitRangeClick(selection);
      }
      return;
    }

    if (isExportCompareMessage(message)) {
      await this.exportCompare(message);
      return;
    }

    if (isCommitActionMessage(message) && message.action === 'openDetails') {
      const selection = this.resolveContinuousSelection(message.shas ?? [message.sha]);
      if (selection) {
        await this.onCommitRangeClick(selection);
        return;
      }
    }

    if (!isCommitActionMessage(message)) {
      return;
    }

    await handleCommitAction(message);
  }

  private resolveContinuousSelection(rawShas: readonly string[]): CompareCommitRangeSelection | undefined {
    if (!this.currentResult) {
      return undefined;
    }

    const selectedShas = normalizeShas(rawShas);
    if (selectedShas.length < 2) {
      return undefined;
    }

    const leftSelection = this.resolveContinuousSelectionForSide(this.currentResult.commitsOnlyLeft, selectedShas, 'left');
    const rightSelection = this.resolveContinuousSelectionForSide(this.currentResult.commitsOnlyRight, selectedShas, 'right');

    return leftSelection ?? rightSelection;
  }

  private resolveContinuousSelectionForSide(
    commits: readonly GraphCommit[],
    selectedShas: readonly string[],
    side: 'left' | 'right'
  ): CompareCommitRangeSelection | undefined {
    const indices = selectedShas.map((sha) => commits.findIndex((commit) => commit.sha === sha));
    if (indices.some((index) => index < 0)) {
      return undefined;
    }

    const orderedUniqueIndices = [...new Set(indices)].sort((a, b) => a - b);
    if (orderedUniqueIndices.length !== selectedShas.length) {
      return undefined;
    }

    const first = orderedUniqueIndices[0];
    const last = orderedUniqueIndices[orderedUniqueIndices.length - 1];
    if (last - first + 1 !== orderedUniqueIndices.length) {
      return undefined;
    }

    return {
      side,
      shas: commits.slice(first, last + 1).map((commit) => commit.sha)
    };
  }

  private getCompareExportFormat(): CompareExportFormat {
    const configured = vscode.workspace.getConfiguration('intelliGit').get<string>('compare.exportFormat', 'csv');
    return configured === 'excel' ? 'excel' : 'csv';
  }

  private async exportCompare(message: ExportCompareMessage): Promise<void> {
    const format = message.format === 'excel' || message.format === 'csv'
      ? message.format
      : this.getCompareExportFormat();
    if (format === 'excel') {
      await this.exportAsExcel(message);
      return;
    }
    await this.exportAsCsv(message);
  }

  private async exportAsExcel(message: ExportCompareMessage): Promise<void> {
    const leftRef = message.leftRef || this.currentResult?.leftRef || 'left';
    const rightRef = message.rightRef || this.currentResult?.rightRef || 'right';
    const defaultFileName = `${sanitizeFileNameSegment(leftRef)}-vs-${sanitizeFileNameSegment(rightRef)}.xlsx`;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = workspaceRoot ? vscode.Uri.joinPath(workspaceRoot, defaultFileName) : undefined;
    const targetUri = await vscode.window.showSaveDialog({
      title: 'Export Compare Branches As Excel',
      saveLabel: 'Export',
      defaultUri,
      filters: {
        'Excel Workbook': ['xlsx']
      }
    });

    if (!targetUri) {
      return;
    }

    const workbook = XLSX.utils.book_new();
    const [leftSheetName, rightSheetName] = buildSheetNames(leftRef, rightRef);
    const leftSheet = XLSX.utils.json_to_sheet(
      message.leftCommits.map((commit) => ({
        SHA: commit.sha,
        Subject: commit.subject,
        Author: commit.author,
        Date: commit.date
      }))
    );
    const rightSheet = XLSX.utils.json_to_sheet(
      message.rightCommits.map((commit) => ({
        SHA: commit.sha,
        Subject: commit.subject,
        Author: commit.author,
        Date: commit.date
      }))
    );

    XLSX.utils.book_append_sheet(workbook, leftSheet, leftSheetName);
    XLSX.utils.book_append_sheet(workbook, rightSheet, rightSheetName);
    const workbookBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const bytes = workbookBuffer instanceof Uint8Array ? workbookBuffer : Buffer.from(workbookBuffer);
    await vscode.workspace.fs.writeFile(targetUri, bytes);
    void vscode.window.showInformationMessage(`IntelliGit: Exported compare commits to ${targetUri.fsPath}`);
  }

  private async exportAsCsv(message: ExportCompareMessage): Promise<void> {
    const leftRef = message.leftRef || this.currentResult?.leftRef || 'left';
    const rightRef = message.rightRef || this.currentResult?.rightRef || 'right';
    const defaultFileName = `${sanitizeFileNameSegment(leftRef)}-vs-${sanitizeFileNameSegment(rightRef)}.csv`;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = workspaceRoot ? vscode.Uri.joinPath(workspaceRoot, defaultFileName) : undefined;
    const targetUri = await vscode.window.showSaveDialog({
      title: 'Export Compare Branches As CSV',
      saveLabel: 'Export',
      defaultUri,
      filters: {
        CSV: ['csv']
      }
    });

    if (!targetUri) {
      return;
    }

    const [leftUri, rightUri] = buildCsvUris(targetUri, leftRef, rightRef);
    const headers = ['SHA', 'Subject', 'Author', 'Date'];
    const leftRows = message.leftCommits.map((commit) => [commit.sha, commit.subject, commit.author, commit.date]);
    const rightRows = message.rightCommits.map((commit) => [commit.sha, commit.subject, commit.author, commit.date]);
    await vscode.workspace.fs.writeFile(leftUri, Buffer.from(toCsv(headers, leftRows), 'utf8'));
    await vscode.workspace.fs.writeFile(rightUri, Buffer.from(toCsv(headers, rightRows), 'utf8'));
    void vscode.window.showInformationMessage(`IntelliGit: Exported compare commits to ${leftUri.fsPath} and ${rightUri.fsPath}`);
  }

}

function renderCompareHtml(result: CompareResult, exportFormat: CompareExportFormat): string {
  return renderTemplate('compareView.hbs', {
    leftRef: result.leftRef,
    leftTotal: result.commitsOnlyLeft.length,
    leftCommits: renderCommitRows(result.commitsOnlyLeft, 'left'),
    rightRef: result.rightRef,
    rightTotal: result.commitsOnlyRight.length,
    rightCommits: renderCommitRows(result.commitsOnlyRight, 'right'),
    authorsJson: toInlineJson(collectDistinctAuthors(result.commitsOnlyLeft, result.commitsOnlyRight)),
    exportFormat,
    exportButtonLabel: exportFormat === 'excel' ? 'Export Excel' : 'Export CSV'
  });
}

function renderCommitRows(commits: GraphCommit[], side: 'left' | 'right'): string {
  if (commits.length === 0) {
    return '<tr><td colspan="4">No commits</td></tr>';
  }

  return commits
    .map((commit) => {
      const date = formatCommitDate(commit.date);
      const rel = escapeHtml(date.label);
      const full = escapeHtml(date.title);
      const graph = escapeHtml(renderGraphGlyph(commit.graph));
      return `<tr class="commit-row" data-sha="${escapeHtml(commit.sha)}" data-subject="${escapeHtml(commit.subject)}" data-author="${escapeHtml(commit.author)}" data-timestamp="${date.timestamp}" data-side="${side}" title="${escapeHtml(commit.sha)}"><td class="col-graph copyable" title="Copy commit id: ${escapeHtml(commit.sha)}">${graph}</td><td class="col-subject">${escapeHtml(commit.subject)}</td><td class="col-author">${escapeHtml(commit.author)}</td><td class="col-date muted"><span title="${full}">${rel}</span></td></tr>`;
    })
    .join('');
}

function collectDistinctAuthors(left: GraphCommit[], right: GraphCommit[]): string[] {
  const unique = new Map<string, string>();
  for (const commit of [...left, ...right]) {
    const raw = commit.author.trim();
    if (!raw) {
      continue;
    }
    const normalized = raw.toLowerCase();
    if (!unique.has(normalized)) {
      unique.set(normalized, raw);
    }
  }
  return Array.from(unique.values()).sort((a, b) => a.localeCompare(b));
}

function toInlineJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('</', '<\\/');
}

function renderGraphGlyph(graph?: string): string {
  if (graph === '<') return '◀';
  if (graph === '>') return '▶';
  if (graph === '-') return '●';
  return '○';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isCommitClickMessage(value: unknown): value is CommitClickMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const c = value as Record<string, unknown>;
  return c.type === 'commitClick' && typeof c.sha === 'string';
}

function isCommitRangeClickMessage(value: unknown): value is CommitRangeClickMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'commitRangeClick'
    && Array.isArray(candidate.shas)
    && candidate.shas.every((sha) => typeof sha === 'string');
}

function normalizeShas(rawShas: readonly string[]): string[] {
  return Array.from(
    new Set(
      rawShas
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    )
  );
}

function isExportCompareMessage(value: unknown): value is ExportCompareMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'exportCompare') {
    return false;
  }

  return (
    typeof candidate.leftRef === 'string' &&
    typeof candidate.rightRef === 'string' &&
    Array.isArray(candidate.leftCommits) &&
    Array.isArray(candidate.rightCommits)
  );
}

function buildSheetNames(leftRef: string, rightRef: string): [string, string] {
  const left = sanitizeSheetName(leftRef, 'left');
  const right = sanitizeSheetName(rightRef, 'right');
  if (left !== right) {
    return [left, right];
  }

  const leftSuffix = ' (1)';
  const rightSuffix = ' (2)';
  const maxLength = 31;
  const sharedPrefixLength = Math.max(0, maxLength - leftSuffix.length);
  const prefix = left.slice(0, sharedPrefixLength);
  return [`${prefix}${leftSuffix}`, `${prefix}${rightSuffix}`];
}

function sanitizeSheetName(ref: string, fallback: string): string {
  const cleaned = ref
    .replace(/[\\/?*\[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = cleaned || fallback;
  return safe.slice(0, 31);
}

function sanitizeFileNameSegment(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'branch';
}

function buildCsvUris(baseUri: vscode.Uri, leftRef: string, rightRef: string): [vscode.Uri, vscode.Uri] {
  const basePath = baseUri.path.replace(/\.csv$/i, '');
  const leftSegment = sanitizeFileNameSegment(leftRef);
  const rightSegment = sanitizeFileNameSegment(rightRef);
  if (leftSegment !== rightSegment) {
    return [
      baseUri.with({ path: `${basePath}-${leftSegment}.csv` }),
      baseUri.with({ path: `${basePath}-${rightSegment}.csv` })
    ];
  }

  return [
    baseUri.with({ path: `${basePath}-${leftSegment}-left.csv` }),
    baseUri.with({ path: `${basePath}-${rightSegment}-right.csv` })
  ];
}

function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(','));
  return `${lines.join('\n')}\n`;
}

function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!/[",\n]/.test(normalized)) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '""')}"`;
}
