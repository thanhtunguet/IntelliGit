import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';

const compiledTemplates = new Map<string, Handlebars.TemplateDelegate>();
const registeredPartials = new Set<string>();

export function renderTemplate<TContext extends object = Record<string, never>>(
  templateName: string,
  context?: TContext
): string {
  registerPartials();
  let template = compiledTemplates.get(templateName);
  if (!template) {
    template = Handlebars.compile(fs.readFileSync(resolveTemplatePath(templateName), 'utf8'));
    compiledTemplates.set(templateName, template);
  }
  return template(context ?? ({} as TContext));
}

function resolveTemplatePath(templateName: string): string {
  for (const templateRoot of getTemplateRoots()) {
    const templatePath = path.join(templateRoot, templateName);
    if (fs.existsSync(templatePath)) {
      return templatePath;
    }
  }
  return path.join(getTemplateRoots()[0], templateName);
}

function registerPartials(): void {
  for (const templateRoot of getTemplateRoots()) {
    registerPartialsInDirectory(path.join(templateRoot, 'partials'), 'partials');
  }
}

function registerPartialsInDirectory(directory: string, prefix: string): void {
  if (!fs.existsSync(directory)) {
    return;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const partialName = path.posix.join(prefix, entry.name.replace(/\.hbs$/, ''));
    if (entry.isDirectory()) {
      registerPartialsInDirectory(entryPath, path.posix.join(prefix, entry.name));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.hbs') || registeredPartials.has(partialName)) {
      continue;
    }
    Handlebars.registerPartial(partialName, fs.readFileSync(entryPath, 'utf8'));
    registeredPartials.add(partialName);
  }
}

function getTemplateRoots(): string[] {
  return [
    path.join(__dirname, 'templates'),
    path.join(__dirname, '..', 'templates'),
    path.join(__dirname, '..', '..', 'src', 'views', 'templates')
  ];
}
