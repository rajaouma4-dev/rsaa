#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const mobileRequire = createRequire(path.resolve(__dirname, '../mobile/package.json'));
const ts = mobileRequire('typescript');
const sourcePath = path.resolve(__dirname, '../mobile/src/services/framing.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const Module = require('node:module');
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(compiled, sourcePath);
const {JsonLineFrameDecoder} = loaded.exports;
const {Buffer} = require('node:buffer');

const decoder = new JsonLineFrameDecoder(1024, 4096);
const encoded = Buffer.from('{"type":"users","display_name":"বাংলা নাম"}\n{"type":"pong"}\n', 'utf8');
const splitAt = encoded.indexOf(Buffer.from('া')) + 1; // split inside a multi-byte UTF-8 character
assert.deepEqual(decoder.push(encoded.subarray(0, splitAt)), []);
const frames = decoder.push(encoded.subarray(splitAt));
assert.equal(frames.length, 2);
assert.equal(frames[0].display_name, 'বাংলা নাম');
assert.equal(frames[1].type, 'pong');

assert.throws(() => new JsonLineFrameDecoder(256, 512).push(Buffer.from('{bad}\n')), /Malformed JSON/);
assert.throws(() => new JsonLineFrameDecoder(256, 512).push(Buffer.alloc(257, 0x61)), /Unterminated signaling frame/);
assert.throws(() => new JsonLineFrameDecoder(256, 256).push(Buffer.alloc(257, 0x61)), /receive buffer limit/);
console.log('PASS: signaling frame decoder handles split Bengali UTF-8, multiple frames, malformed JSON and size limits');
