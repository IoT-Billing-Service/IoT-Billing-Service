import { readFileSync } from 'node:fs';

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  const j = JSON.parse(data);
  const errors = [];
  for (const f of j) {
    const file = f.filePath.replace(/.*backend[/\\]/, '');
    for (const m of f.messages) {
      if (m.ruleId) {
        errors.push({ file, line: m.line, rule: m.ruleId, message: m.message });
      }
    }
  }
  
  // Group by rule
  const byRule = {};
  for (const e of errors) {
    if (!byRule[e.rule]) byRule[e.rule] = [];
    byRule[e.rule].push(e);
  }
  
  for (const [rule, errs] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n=== ${rule} (${errs.length} errors) ===`);
    const byFile = {};
    for (const e of errs) {
      if (!byFile[e.file]) byFile[e.file] = [];
      byFile[e.file].push(e);
    }
    for (const [file, fileErrs] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${file}: ${fileErrs.map(e => e.line).join(', ')}`);
    }
  }
});
