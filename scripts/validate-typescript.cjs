#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {execFileSync} = require('node:child_process');
const mobileRoot = path.resolve(__dirname, '../mobile');
const requireFromMobile = createRequire(path.join(mobileRoot, 'package.json'));
let ts;
try {
  ts = requireFromMobile('typescript');
} catch {
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], {encoding: 'utf8'}).trim();
    ts = require(path.join(globalRoot, 'typescript'));
  } catch {
    console.error('TypeScript is not installed. Run `cd mobile && npm install`.');
    process.exit(2);
  }
}
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(file);
  }
}
walk(mobileRoot);
const errors = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      strict: true,
    },
  });
  for (const diagnostic of result.diagnostics || []) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    const location = diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : {line: 0, character: 0};
    errors.push(`${path.relative(mobileRoot, file)}:${location.line + 1}:${location.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`PASS: TypeScript/TSX syntax parsed (${files.length} files). This is not a semantic typecheck.`);
