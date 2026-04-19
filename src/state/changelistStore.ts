import * as vscode from 'vscode';

export type Changelist = {
  id: string;
  name: string;
  paths: string[];
};

const STATE_KEY = 'intelliGit.changelists';
const DEFAULT_ID = 'default';

type PersistedShape = {
  lists: { id: string; name: string }[];
  assignments: Record<string, string>; // path -> changelistId
};

export class ChangelistStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private lists: { id: string; name: string }[];
  private assignments: Map<string, string>;

  constructor(private readonly memento: vscode.Memento) {
    const persisted = memento.get<PersistedShape>(STATE_KEY);
    if (persisted && Array.isArray(persisted.lists)) {
      this.lists = persisted.lists.filter((l) => l.id !== DEFAULT_ID);
      this.assignments = new Map(Object.entries(persisted.assignments || {}));
    } else {
      this.lists = [];
      this.assignments = new Map();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }

  get defaultId(): string {
    return DEFAULT_ID;
  }

  getLists(): { id: string; name: string }[] {
    return [{ id: DEFAULT_ID, name: 'Changes' }, ...this.lists];
  }

  getCustomLists(): { id: string; name: string }[] {
    return [...this.lists];
  }

  findById(id: string): { id: string; name: string } | undefined {
    if (id === DEFAULT_ID) {
      return { id: DEFAULT_ID, name: 'Changes' };
    }
    return this.lists.find((l) => l.id === id);
  }

  getChangelistIdFor(path: string): string {
    return this.assignments.get(path) || DEFAULT_ID;
  }

  groupPaths(paths: string[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const list of this.getLists()) {
      grouped.set(list.id, []);
    }
    for (const p of paths) {
      const id = this.getChangelistIdFor(p);
      const bucket = grouped.get(id);
      if (bucket) {
        bucket.push(p);
      } else {
        grouped.get(DEFAULT_ID)!.push(p);
      }
    }
    return grouped;
  }

  async createList(name: string): Promise<string> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Changelist name is required.');
    }
    if (trimmed.toLowerCase() === 'changes') {
      throw new Error('"Changes" is reserved for the default changelist.');
    }
    const id = `cl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.lists.push({ id, name: trimmed });
    await this.persist();
    return id;
  }

  async renameList(id: string, name: string): Promise<void> {
    if (id === DEFAULT_ID) {
      throw new Error('The default changelist cannot be renamed.');
    }
    const target = this.lists.find((l) => l.id === id);
    if (!target) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Changelist name is required.');
    }
    target.name = trimmed;
    await this.persist();
  }

  async deleteList(id: string): Promise<void> {
    if (id === DEFAULT_ID) {
      throw new Error('The default changelist cannot be deleted.');
    }
    this.lists = this.lists.filter((l) => l.id !== id);
    for (const [path, assignedId] of this.assignments) {
      if (assignedId === id) {
        this.assignments.delete(path);
      }
    }
    await this.persist();
  }

  async assign(path: string, changelistId: string): Promise<void> {
    if (changelistId === DEFAULT_ID) {
      this.assignments.delete(path);
    } else {
      if (!this.lists.some((l) => l.id === changelistId)) {
        throw new Error(`Unknown changelist: ${changelistId}`);
      }
      this.assignments.set(path, changelistId);
    }
    await this.persist();
  }

  // Drop assignments for paths that are no longer in the working tree.
  async pruneMissing(activePaths: readonly string[]): Promise<void> {
    const active = new Set(activePaths);
    let changed = false;
    for (const path of [...this.assignments.keys()]) {
      if (!active.has(path)) {
        this.assignments.delete(path);
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    const payload: PersistedShape = {
      lists: this.lists,
      assignments: Object.fromEntries(this.assignments)
    };
    await this.memento.update(STATE_KEY, payload);
    this.emitter.fire();
  }
}
