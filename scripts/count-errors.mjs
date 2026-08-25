let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const data = JSON.parse(input);
let total = 0;
const counts = {};
const fileCounts = {};
for (const f of data) {
  for (const m of f.messages) {
    counts[m.ruleId] = (counts[m.ruleId] || 0) + 1;
    total++;
    fileCounts[f.filePath] = (fileCounts[f.filePath] || 0) + 1;
  }
}
console.log('Total errors:', total);
console.log('\nTop rules:');
Object.entries(counts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .forEach(([r, c]) => console.log('  ', c, r));
console.log('\nTop files:');
Object.entries(fileCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .forEach(([f, c]) => console.log('  ', c, f.replace(/.*IoT-Billing-Service\//, '')));
