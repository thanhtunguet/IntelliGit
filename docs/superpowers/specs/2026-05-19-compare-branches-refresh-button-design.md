# Compare Branches — Refresh Button

**Date:** 2026-05-19
**Status:** Approved

## Summary

Add a refresh icon button to the Compare branches view so users can refetch commits from the two selected branches without reopening the panel.

## UI

Location: `.filter-actions` div in `compareView.hbs`, to the left of the existing "Clear filters" button (same row as the mode toggle).

- Icon-only button (`⟳`), tooltip "Refresh"
- Styled to match the existing outline button aesthetics
- Disabled immediately on click to prevent double-fire; re-enables naturally when `render()` replaces the webview HTML or through a completion message if refresh fails

## Message Protocol

New message sent from webview → extension host:

```ts
interface RefreshMessage { type: 'refresh'; }
```

Type guard `isRefreshMessage` added alongside the existing guards in `compareView.ts`.

## `CompareView` changes (`src/views/compareView.ts`)

1. Add `RefreshMessage` interface and `isRefreshMessage` guard
2. Add fourth constructor parameter: `private readonly onRefresh: (leftRef: string, rightRef: string) => Promise<void>`
3. In `handleMessage`, add:
   ```ts
   if (isRefreshMessage(message)) {
     await this.onRefresh(this.currentResult.leftRef, this.currentResult.rightRef);
     return;
   }
   ```

## `EditorOrchestrator` changes (`src/editor/editorOrchestrator.ts`)

In `ensureCompareView()`, pass the callback as the fourth argument:

```ts
async (leftRef, rightRef) => {
  const result = await this.state.compareBranches(leftRef, rightRef);
  this.compareView?.render(result);
}
```

## Template changes (`src/views/templates/compareView.hbs`)

Add button HTML in `.filter-actions`:

```html
<button id="btn-refresh" class="refresh-btn" type="button" title="Refresh">⟳</button>
```

Add CSS for `.refresh-btn` (outline style, spin animation on `.loading` class).

Add JS: on click, disable button, post `{ type: 'refresh' }` to extension.

## Out of Scope

- Progress indicator beyond button disable/enable
- Keyboard shortcut for refresh
- Auto-refresh on branch change
