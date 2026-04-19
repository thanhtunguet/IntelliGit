import * as vscode from 'vscode';

export type CommitTemplate = {
  label: string;
  template: string;
};

export type TemplateContext = {
  branch: string;
};

const CURSOR_PLACEHOLDER = '{cursor}';

export function loadTemplates(): CommitTemplate[] {
  const raw = vscode.workspace.getConfiguration('intelliGit').get<unknown>('commitMessageTemplates', []);
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: CommitTemplate[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ label: item.slice(0, 24), template: item });
    } else if (item && typeof item === 'object') {
      const label = typeof (item as { label?: unknown }).label === 'string' ? (item as { label: string }).label : '';
      const template = typeof (item as { template?: unknown }).template === 'string' ? (item as { template: string }).template : '';
      if (label && template) {
        out.push({ label, template });
      }
    }
  }
  return out;
}

export function getTicketPattern(): RegExp | undefined {
  const pattern = vscode.workspace.getConfiguration('intelliGit').get<string>('commitMessageTicketPattern', '');
  if (!pattern) {
    return undefined;
  }
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

export function extractTicket(branch: string): string {
  const pattern = getTicketPattern();
  if (!pattern) {
    return '';
  }
  const match = branch.match(pattern);
  return match ? match[0] : '';
}

// Expands {branch}, {ticket}, and {scope}. Leaves {cursor} alone for the caller.
// Returns { text, cursor } where cursor is the offset of {cursor}, or text.length if absent.
export function expandTemplate(template: string, ctx: TemplateContext): { text: string; cursor: number } {
  const ticket = extractTicket(ctx.branch);
  const scope = inferScope(ctx.branch);
  let expanded = template
    .replace(/\{branch\}/g, ctx.branch)
    .replace(/\{ticket\}/g, ticket)
    .replace(/\{scope\}/g, scope);
  const idx = expanded.indexOf(CURSOR_PLACEHOLDER);
  if (idx === -1) {
    return { text: expanded, cursor: expanded.length };
  }
  expanded = expanded.slice(0, idx) + expanded.slice(idx + CURSOR_PLACEHOLDER.length);
  return { text: expanded, cursor: idx };
}

function inferScope(branch: string): string {
  // `feature/auth-xyz` → `auth`; `fix/ui/layout` → `ui`; otherwise best-effort.
  const parts = branch.split('/');
  const tail = parts[parts.length - 1] || branch;
  const cleaned = tail.replace(/^[A-Z]+-\d+[-_]?/, '');
  const firstToken = cleaned.split(/[-_]/)[0] || '';
  return firstToken;
}
