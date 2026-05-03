const branchContextMenuItems = [
  { command: 'intelliGit.branch.checkout', label: 'Checkout Branch' },
  { command: 'intelliGit.branch.compareWithCurrent', label: 'Compare With Current Branch' },
  { command: 'intelliGit.branch.rename', label: 'Rename Branch' },
  { command: 'intelliGit.branch.delete', label: 'Delete Branch' },
  { separator: true },
  { command: 'intelliGit.branch.track', label: 'Track Remote Branch' },
  { command: 'intelliGit.branch.untrack', label: 'Untrack Branch' },
  { command: 'intelliGit.branch.mergeIntoCurrent', label: 'Merge Into Current' },
  { command: 'intelliGit.branch.rebaseOnto', label: 'Rebase Current Onto Branch' }
] as const;

export type BranchContextMenuCommand = Extract<
  (typeof branchContextMenuItems)[number],
  { readonly command: string }
>['command'];

const branchContextMenuCommands = new Set<string>(
  branchContextMenuItems.flatMap((item) => ('command' in item ? [item.command] : []))
);

export function isBranchContextMenuCommand(command: string): command is BranchContextMenuCommand {
  return branchContextMenuCommands.has(command);
}

export function renderBranchContextMenu(): string {
  const items = branchContextMenuItems
    .map((item) => {
      if ('separator' in item) {
        return '    <div class="menu-separator"></div>';
      }
      return `    <button class="menu-item" data-command="${escapeHtml(item.command)}">${escapeHtml(item.label)}</button>`;
    })
    .join('\n');

  return [
    '  <div id="branch-context-menu" class="context-menu" role="menu" aria-label="Branch context menu">',
    items,
    '  </div>'
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
