const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'src', 'views', 'templates');
const targetDir = path.join(root, 'dist', 'templates');

fs.rmSync(targetDir, { recursive: true, force: true });
copyTemplates(sourceDir, targetDir);

function copyTemplates(source, target) {
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyTemplates(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.hbs')) {
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}
