import * as vscode from 'vscode';
import XLSX from 'xlsx';
import { getConfigValue } from '../configuration';
import { renderTemplate } from './templateRenderer';
import { handleCommitAction, isCommitActionMessage } from './commitActions';
import { formatCommitDate } from './commitDate';
import { CompareResult, GraphCommit } from '../types';

export type CompareViewMode = 'list' | 'graph';

export interface CompareViewModeStore {
  getCompareViewMode(): CompareViewMode;
  setCompareViewMode(mode: CompareViewMode): Promise<void>;
}

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

interface RefreshMessage {
  readonly type: 'refresh';
}

interface RefreshCompleteMessage {
  readonly type: 'refreshComplete';
}

interface SetCompareModeMessage {
  readonly type: 'setCompareMode';
  readonly mode: CompareViewMode;
}

export class CompareView {
  private readonly panel: vscode.WebviewPanel;
  private disposeCallback: (() => void) | undefined;
  private currentResult: CompareResult | undefined;

  constructor(
    private readonly onCommitClick: (sha: string, subject: string) => Promise<void>,
    private readonly onCommitRangeClick: (selection: CompareCommitRangeSelection) => Promise<void>,
    private readonly modeStore: CompareViewModeStore,
    private readonly onRefresh: (leftRef: string, rightRef: string) => Promise<void>
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'vscodeGitClient.branchCompare',
      'VS Code Git Client: Branch Comparison',
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
        void vscode.window.showErrorMessage(`VS Code Git Client: ${error instanceof Error ? error.message : String(error)}`);
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
    this.panel.webview.html = renderCompareHtml(result, this.getCompareExportFormat(), this.modeStore.getCompareViewMode());
  }

  private rerender(): void {
    if (!this.currentResult) {
      return;
    }
    this.panel.webview.html = renderCompareHtml(
      this.currentResult,
      this.getCompareExportFormat(),
      this.modeStore.getCompareViewMode()
    );
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

    if (isSetCompareModeMessage(message)) {
      await this.modeStore.setCompareViewMode(message.mode);
      this.rerender();
      return;
    }

    if (isRefreshMessage(message)) {
      if (this.currentResult) {
        try {
          await this.onRefresh(this.currentResult.leftRef, this.currentResult.rightRef);
        } finally {
          void this.panel.webview.postMessage({ type: 'refreshComplete' } satisfies RefreshCompleteMessage);
        }
      }
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
    const configured = getConfigValue<string>('compare.exportFormat', 'csv');
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
    void vscode.window.showInformationMessage(`VS Code Git Client: Exported compare commits to ${targetUri.fsPath}`);
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
    void vscode.window.showInformationMessage(`VS Code Git Client: Exported compare commits to ${leftUri.fsPath} and ${rightUri.fsPath}`);
  }

}

function renderCompareHtml(result: CompareResult, exportFormat: CompareExportFormat, mode: CompareViewMode): string {
  const graphData = mode === 'graph' ? buildGraphRenderData(result) : undefined;
  return renderTemplate('compareView.hbs', {
    leftRef: result.leftRef,
    leftTotal: result.commitsOnlyLeft.length,
    leftCommits: renderCommitRows(result.commitsOnlyLeft, 'left'),
    rightRef: result.rightRef,
    rightTotal: result.commitsOnlyRight.length,
    rightCommits: renderCommitRows(result.commitsOnlyRight, 'right'),
    authorsJson: toInlineJson(collectDistinctAuthors(result.commitsOnlyLeft, result.commitsOnlyRight)),
    exportFormat,
    exportButtonLabel: exportFormat === 'excel' ? 'Export Excel' : 'Export CSV',
    mode,
    isListMode: mode === 'list',
    isGraphMode: mode === 'graph',
    graphSvg: graphData ? graphData.svg : '',
    graphRows: graphData ? graphData.rows : '',
    graphSvgHeight: graphData ? graphData.svgHeight : 0,
    graphMergeBaseShort: result.mergeBase ? result.mergeBase.shortSha : ''
  });
}

interface GraphRenderData {
  readonly svg: string;
  readonly rows: string;
  readonly svgHeight: number;
}

const GRAPH_ROW_HEIGHT = 24;
const GRAPH_LANE_X_LEFT = 16;
const GRAPH_LANE_X_RIGHT = 40;
const GRAPH_LANE_X_BASE = (GRAPH_LANE_X_LEFT + GRAPH_LANE_X_RIGHT) / 2;
const GRAPH_NODE_RADIUS = 5;

function buildGraphRenderData(result: CompareResult): GraphRenderData {
  const leftSorted = sortByDateDescending(result.commitsOnlyLeft);
  const rightSorted = sortByDateDescending(result.commitsOnlyRight);
  const interleaved = interleaveByDateDescending(leftSorted, rightSorted);
  const totalRows = interleaved.length + (result.mergeBase ? 1 : 0);
  const svgHeight = Math.max(totalRows * GRAPH_ROW_HEIGHT, GRAPH_ROW_HEIGHT);

  const edges: string[] = [];
  const nodes: string[] = [];
  const rowsHtml: string[] = [];

  const lastIndexBySide: { left: number; right: number } = { left: -1, right: -1 };

  interleaved.forEach((entry, index) => {
    const y = index * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
    const x = entry.side === 'left' ? GRAPH_LANE_X_LEFT : GRAPH_LANE_X_RIGHT;
    const laneClass = entry.side === 'left' ? 'lane-left' : 'lane-right';

    const previousIndexOnSide = lastIndexBySide[entry.side];
    if (previousIndexOnSide >= 0) {
      const prevY = previousIndexOnSide * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
      edges.push(
        `<line class="graph-edge ${laneClass}" data-edge-side="${entry.side}" data-edge-from="${escapeHtml(entry.commit.sha)}" x1="${x}" y1="${prevY}" x2="${x}" y2="${y}" />`
      );
    }
    lastIndexBySide[entry.side] = index;

    nodes.push(
      `<circle class="graph-node ${laneClass}" data-node-sha="${escapeHtml(entry.commit.sha)}" cx="${x}" cy="${y}" r="${GRAPH_NODE_RADIUS}" />`
    );

    const date = formatCommitDate(entry.commit.date);
    rowsHtml.push(renderGraphRow(entry.commit, entry.side, date));
  });

  if (result.mergeBase) {
    const baseRowIndex = interleaved.length;
    const baseY = baseRowIndex * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;

    if (lastIndexBySide.left >= 0) {
      const fromY = lastIndexBySide.left * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
      edges.push(
        `<path class="graph-edge lane-left" d="M ${GRAPH_LANE_X_LEFT} ${fromY} L ${GRAPH_LANE_X_LEFT} ${baseY - GRAPH_ROW_HEIGHT / 2} Q ${GRAPH_LANE_X_LEFT} ${baseY} ${GRAPH_LANE_X_BASE} ${baseY}" fill="none" />`
      );
    }
    if (lastIndexBySide.right >= 0) {
      const fromY = lastIndexBySide.right * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
      edges.push(
        `<path class="graph-edge lane-right" d="M ${GRAPH_LANE_X_RIGHT} ${fromY} L ${GRAPH_LANE_X_RIGHT} ${baseY - GRAPH_ROW_HEIGHT / 2} Q ${GRAPH_LANE_X_RIGHT} ${baseY} ${GRAPH_LANE_X_BASE} ${baseY}" fill="none" />`
      );
    }

    nodes.push(
      `<circle class="graph-node lane-base" cx="${GRAPH_LANE_X_BASE}" cy="${baseY}" r="${GRAPH_NODE_RADIUS}" />`
    );
    rowsHtml.push(renderGraphMergeBaseRow(result.mergeBase));
  }

  const svgInner = `${edges.join('')}${nodes.join('')}`;

  return {
    svg: svgInner,
    rows: rowsHtml.join(''),
    svgHeight
  };
}

interface InterleavedEntry {
  readonly side: 'left' | 'right';
  readonly commit: GraphCommit;
}

function sortByDateDescending(commits: GraphCommit[]): GraphCommit[] {
  return [...commits].sort((a, b) => parseIsoTimestamp(b.date) - parseIsoTimestamp(a.date));
}

function interleaveByDateDescending(left: GraphCommit[], right: GraphCommit[]): InterleavedEntry[] {
  const result: InterleavedEntry[] = [];
  let l = 0;
  let r = 0;
  while (l < left.length && r < right.length) {
    const lTs = parseIsoTimestamp(left[l].date);
    const rTs = parseIsoTimestamp(right[r].date);
    if (lTs >= rTs) {
      result.push({ side: 'left', commit: left[l] });
      l += 1;
    } else {
      result.push({ side: 'right', commit: right[r] });
      r += 1;
    }
  }
  while (l < left.length) {
    result.push({ side: 'left', commit: left[l] });
    l += 1;
  }
  while (r < right.length) {
    result.push({ side: 'right', commit: right[r] });
    r += 1;
  }
  return result;
}

function parseIsoTimestamp(value: string): number {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function renderGraphRow(commit: GraphCommit, side: 'left' | 'right', date: { label: string; title: string; timestamp: number }): string {
  return `<li class="graph-row commit-row" data-sha="${escapeHtml(commit.sha)}" data-short-sha="${escapeHtml(commit.shortSha)}" data-subject="${escapeHtml(commit.subject)}" data-author="${escapeHtml(commit.author)}" data-timestamp="${date.timestamp}" data-side="${side}" title="${escapeHtml(commit.sha)}"><span class="graph-row-spacer"></span><span class="graph-row-sha">${escapeHtml(commit.shortSha)}</span><span class="graph-row-subject">${escapeHtml(commit.subject)}</span><span class="graph-row-author">${escapeHtml(commit.author)}</span><span class="graph-row-date muted" title="${escapeHtml(date.title)}">${escapeHtml(date.label)}</span></li>`;
}

function renderGraphMergeBaseRow(commit: GraphCommit): string {
  const date = formatCommitDate(commit.date);
  return `<li class="graph-row graph-row-base" data-sha="${escapeHtml(commit.sha)}" data-short-sha="${escapeHtml(commit.shortSha)}" title="Merge base ${escapeHtml(commit.sha)}"><span class="graph-row-spacer"></span><span class="graph-row-sha">${escapeHtml(commit.shortSha)}</span><span class="graph-row-subject"><em>merge base</em> · ${escapeHtml(commit.subject)}</span><span class="graph-row-author">${escapeHtml(commit.author)}</span><span class="graph-row-date muted" title="${escapeHtml(date.title)}">${escapeHtml(date.label)}</span></li>`;
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

function isSetCompareModeMessage(value: unknown): value is SetCompareModeMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'setCompareMode' && (candidate.mode === 'list' || candidate.mode === 'graph');
}

function isRefreshMessage(value: unknown): value is RefreshMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return (value as Record<string, unknown>).type === 'refresh';
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
