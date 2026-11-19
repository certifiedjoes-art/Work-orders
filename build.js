// Compiles index-source.html (editable) into index.html (what the site runs).
// Usage: npm install   (once)   then   npm run build
// Optional: node build.js <source.html> <output.html>
const babel = require('@babel/core');
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || path.join(__dirname, 'index-source.html');
const out = process.argv[3] || path.join(__dirname, 'index.html');

let html = fs.readFileSync(src, 'utf8');
const open = '<script type="text/babel" data-presets="react">';
const a = html.indexOf(open);
if (a < 0) throw new Error('Could not find the <script type="text/babel"> block in ' + src);
const bodyStart = a + open.length;
const b = html.indexOf('</script>', bodyStart);
const code = html.slice(bodyStart, b);

// MUST be the classic runtime. The automatic runtime emits require("react/jsx-dev-runtime"),
// which crashes the browser on load ("Something went wrong loading the app").
const res = babel.transformSync(code, {
  presets: [[require.resolve('@babel/preset-react'), { runtime: 'classic' }]],
  compact: true,
  comments: false,
  sourceType: 'script',
});

html = html.slice(0, a) + '<script>\n' + res.code + '\n' + html.slice(b);
// The compiled copy no longer needs the in-browser Babel compiler.
html = html.replace(/<script crossorigin src="https:\/\/cdn\.jsdelivr\.net\/npm\/@babel\/standalone[^\n]*<\/script>\n/, '');

if (html.includes('require(') || html.includes('jsx-dev-runtime')) {
  throw new Error('Build check failed: output contains require( or jsx-dev-runtime. Do not publish it.');
}
fs.writeFileSync(out, html);
console.log('Built ' + out + ' (' + html.length + ' bytes). Checks passed.');
