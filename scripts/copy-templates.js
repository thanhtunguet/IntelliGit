const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'src', 'views', 'templates');
const targetDir = path.join(root, 'dist', 'views', 'templates');

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.hbs')) {
    continue;
  }
  fs.copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
}
