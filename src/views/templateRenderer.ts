import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';

const compiledTemplates = new Map<string, Handlebars.TemplateDelegate>();

export function renderTemplate<TContext extends object = Record<string, never>>(
  templateName: string,
  context?: TContext
): string {
  let template = compiledTemplates.get(templateName);
  if (!template) {
    template = Handlebars.compile(fs.readFileSync(resolveTemplatePath(templateName), 'utf8'));
    compiledTemplates.set(templateName, template);
  }
  return template(context ?? ({} as TContext));
}

function resolveTemplatePath(templateName: string): string {
  const compiledPath = path.join(__dirname, 'templates', templateName);
  if (fs.existsSync(compiledPath)) {
    return compiledPath;
  }
  return path.join(__dirname, '..', '..', 'src', 'views', 'templates', templateName);
}
