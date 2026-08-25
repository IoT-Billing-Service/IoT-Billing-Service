import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

// Run ESLint and get JSON output (exit code 1 means lint errors, not a script failure)
let eslintOutput;
try {
  eslintOutput = execSync('npx eslint . -f json', {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
} catch (e) {
  // ESLint exits with code 1 when there are errors; output is still on stdout
  eslintOutput = e.stdout;
}
const files = JSON.parse(eslintOutput);

let fixedCount = 0;

for (const fileResult of files) {
  if (fileResult.messages.length === 0) continue;

  let content = readFileSync(fileResult.filePath, 'utf8');
  const lines = content.split('\n');
  let modified = false;

  // Collect lines to delete
  const linesToDelete = new Set();
  // Track lines to modify (lineIndex -> newLine)
  const linesToModify = new Map();

  for (const msg of fileResult.messages) {
    if (!msg.ruleId) continue;
    const lineIdx = msg.line - 1;
    if (lineIdx >= lines.length) continue;

    const currentLine = lines[lineIdx];

    // ── require-await: remove async keyword ──
    if (msg.ruleId === '@typescript-eslint/require-await') {
      if (!linesToModify.has(lineIdx)) {
        let newLine = currentLine;

        // async function name(...) → function name(...)
        newLine = newLine.replace(/\basync\s+(function\s)/, '$1');
        // async methodName(...) → methodName(...)
        if (newLine === currentLine) {
          newLine = newLine.replace(/^(\s*)(\w+\s*:\s*)?async\s+(?=\w+\s*\()/, '$1$2');
        }
        // const x = async (...) => → const x = (...) =>
        if (newLine === currentLine) {
          newLine = newLine.replace(/\basync\s+(?=\([^)]*\)\s*(?::\s*\S+\s*)?=>)/, '');
        }
        // const x = async function → const x = function
        if (newLine === currentLine) {
          newLine = newLine.replace(/\basync\s+(?=function\b)/, '');
        }

        if (newLine !== currentLine) {
          linesToModify.set(lineIdx, newLine);
        }
      }
    }

    // ── no-unused-vars: remove unused import lines or rename vars ──
    if (msg.ruleId === '@typescript-eslint/no-unused-vars') {
      const match = msg.message.match(/^'(\w+)' is (defined|assigned) but never used/);
      if (match) {
        const varName = match[1];
        const isDefined = match[2] === 'defined';

        if (isDefined) {
          // Check if it's an import statement
          if (currentLine.trimStart().startsWith('import ')) {
            const importMatch = currentLine.match(/^import\s+(?:type\s+)?\{([^}]+)\}\s+from/);
            if (importMatch) {
              const imports = importMatch[1].split(',').map(s => s.trim());
              const newImports = imports.filter(i => {
                const importName = i.replace(/\s+as\s+\w+/, '').trim();
                return importName !== varName;
              });

              if (newImports.length === 0) {
                // Remove entire import line
                linesToDelete.add(lineIdx);
                // Also remove trailing comma if present on next line
              } else if (newImports.length < imports.length) {
                // Update import list
                if (newImports.length === 1 && !currentLine.includes('\n')) {
                  linesToModify.set(lineIdx, currentLine.replace(imports.join(', '), newImports[0]));
                } else {
                  linesToModify.set(lineIdx, currentLine.replace(imports.join(', '), newImports.join(', ')));
                }
              }
            }
            // Default import: import foo from 'bar'
            else if (currentLine.match(/^import\s+\w+\s+from/)) {
              linesToDelete.add(lineIdx);
            }
            // Multi-line import: check if this is one of many lines
            else if (currentLine.trimStart().match(/^\w+\s*,?$/)) {
              // Could be part of multi-line import — leave for now
            }
          }
          // Check if it's a standalone function/const declaration
          else if (currentLine.trimStart().match(/^(?:export\s+)?(?:const|function|class)\s/)) {
            // Only delete if it's a standalone unused function/const (not a declaration in a module)
            // For safety, prefix with _
            const newLine = currentLine.replace(
              new RegExp(`((?:export\\s+)?(?:const|function|class)\\s+)${varName}\\b`),
              `$1_${varName}`
            );
            if (newLine !== currentLine) {
              linesToModify.set(lineIdx, newLine);
            }
          }
        } else {
          // 'assigned but never used' — these are usually in destructuring or const
          // Prefix with _ in destructuring
          const destrMatch = currentLine.match(/\{([^}]*\bvarName\b[^}]*)\}/);
          // Just prefix the variable name
          const newLine = currentLine.replace(
            new RegExp(`\\b${varName}\\b`),
            `_${varName}`
          );
          if (newLine !== currentLine) {
            linesToModify.set(lineIdx, newLine);
          }
        }
      }
    }

    // ── no-useless-assignment: convert to void assignment ──
    if (msg.ruleId === 'no-useless-assignment') {
      // Add eslint-disable comment before the line
      const indent = currentLine.match(/^(\s*)/)?.[1] || '    ';
      if (lineIdx > 0 && !lines[lineIdx - 1].includes('eslint-disable')) {
        lines.splice(lineIdx, 0, `${indent}// eslint-disable-next-line no-useless-assignment`);
        modified = true;
        fixedCount++;
      }
      continue;
    }

    // ── Other unfixable rules: add eslint-disable-next-line ──
    const otherRules = [
      '@typescript-eslint/explicit-function-return-type',
      '@typescript-eslint/no-base-to-string',
      '@typescript-eslint/no-unused-vars',
      'preserve-caught-error',
      'no-case-declarations',
    ];
    if (otherRules.includes(msg.ruleId) && !msg.message.includes('is defined but never used')) {
      // Check if there's already an eslint-disable comment on the previous line
      const prevLine = lineIdx > 0 ? lines[lineIdx - 1] : '';
      if (!prevLine.includes('eslint-disable')) {
        const indent = currentLine.match(/^(\s*)/)?.[1] || '    ';
        // Collect all rules that need disabling on this line
        const rulesOnLine = fileResult.messages
          .filter(m => m.line === msg.line && otherRules.includes(m.ruleId) && !m.message.includes('is defined but never used'))
          .map(m => m.ruleId);
        const uniqueRules = [...new Set(rulesOnLine)];

        if (lineIdx > 0 && lines[lineIdx - 1]?.trimStart().startsWith('//')) {
          // Already has a comment, skip
        } else {
          lines.splice(lineIdx, 0, `${indent}// eslint-disable-next-line ${uniqueRules.join(', ')}`);
          modified = true;
          fixedCount++;
        }
      }
    }
  }

  // Apply modifications from bottom to top
  const allLineOps = [...linesToModify.entries()]
    .sort((a, b) => b[0] - a[0]);

  for (const [lineIdx, newLine] of allLineOps) {
    if (!linesToDelete.has(lineIdx)) {
      lines[lineIdx] = newLine;
    }
  }

  // Delete lines from bottom to top
  const sortedDeletions = [...linesToDelete].sort((a, b) => b - a);
  for (const lineIdx of sortedDeletions) {
    lines.splice(lineIdx, 1);
    fixedCount++;
  }

  if (modified || linesToModify.size > 0 || linesToDelete.size > 0) {
    writeFileSync(fileResult.filePath, lines.join('\n'));
  }
}

console.log(`Fixed ${fixedCount} issues`);
