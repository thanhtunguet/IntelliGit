const fs = require('fs');
const Module = require('module');

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }

  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = 'file';
  }

  static file(fsPath) {
    return new Uri(fsPath);
  }

  toString() {
    return this.fsPath;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const vscodeMock = {
  EventEmitter,
  Uri,
  ThemeIcon,
  ThemeColor,
  TreeItem,
  QuickPickItemKind: { Separator: -1 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  OverviewRulerLane: { Left: 1 },
  DecorationRangeBehavior: { ClosedClosed: 0 },
  workspace: {
    fs: {
      readFile: (uri) => fs.promises.readFile(uri.fsPath),
      stat: async (uri) => {
        const stat = await fs.promises.stat(uri.fsPath);
        return { size: stat.size, type: 0, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
      }
    },
    getConfiguration: () => ({
      get: (_key, defaultValue) => defaultValue
    }),
    workspaceFolders: [],
    createFileSystemWatcher: () => ({
      onDidCreate: () => ({ dispose() {} }),
      onDidChange: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {}
    })
  },
  window: {
    createOutputChannel: () => ({
      appendLine() {},
      show() {},
      dispose() {}
    }),
    createTextEditorDecorationType: () => ({ dispose() {} }),
    visibleTextEditors: [],
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeWindowState: () => ({ dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} })
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand: () => ({ dispose() {} })
  },
  extensions: {
    getExtension: () => undefined
  },
  languages: {
    registerFileDecorationProvider: () => ({ dispose() {} })
  },
  Range: class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};
