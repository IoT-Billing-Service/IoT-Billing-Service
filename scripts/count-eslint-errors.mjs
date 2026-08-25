import { readFileSync } from 'node:fs';

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  const j = JSON.parse(data);
  const r = j.map(f => ({
    file: f.filePath.replace(/.*backend[/\\]/, ''),
    count: f.errorCount + f.warningCount,
  })).filter(f => f.count > 0).sort((a, b) => b.count - a.count);
  r.forEach(f => console.log(String(f.count).padStart(5), f.file));
  console.log('Total files:', r.length);
});
