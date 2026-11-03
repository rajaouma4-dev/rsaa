const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const context = {exports: {}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/components/callPreviewLayout.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
}).outputText, context);
const {previewBounds, clampPreview} = context.exports;
for (const [width, height, pipWidth, pipHeight, topInset, controlsHeight] of [
  [360, 800, 112, 158, 24, 128], [320, 568, 100, 140, 24, 128],
  [800, 360, 64, 88, 24, 116], [360, 300, 46, 64, 24, 116],
]) {
  const bounds = previewBounds(width, height, pipWidth, pipHeight, topInset, controlsHeight);
  for (const point of [{x: -1000, y: -1000}, {x: 2000, y: 2000}, {x: 130, y: 250}]) {
    const next = clampPreview(point, bounds);
    assert(next.x >= 12 && next.x + pipWidth <= width - 12);
    assert(next.y >= 12 && next.y + pipHeight <= height - controlsHeight - 16);
  }
  const interior = {x: bounds.minX + 1, y: bounds.minY + 1};
  assert.equal(clampPreview(interior, bounds).x, interior.x);
}
const portrait = previewBounds(360, 800, 112, 158, 24, 128);
const landscape = previewBounds(800, 360, 64, 88, 24, 116);
const rotated = clampPreview({x: portrait.maxX, y: portrait.maxY}, landscape);
assert(rotated.y <= landscape.maxY);
console.log('PASS: camera preview remains on-screen and above call controls across drag extremes, small screens and rotation.');
