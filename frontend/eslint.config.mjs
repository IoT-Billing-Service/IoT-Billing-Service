import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
  {
    // Guardrail for the valid kernel of issue #70: `JSON.stringify` of a Map or
    // Set silently produces "{}" (no enumerable own props, no toJSON), losing
    // all data with no error. This is a syntactic guard — it catches the
    // literal `JSON.stringify(new Map()/new Set())` footgun. For values whose
    // Map/Set-ness is only known via their type, route them through
    // `safeStringify` from `@/lib/serialization` instead.
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'] > NewExpression[callee.name=/^(Map|Set)$/]",
          message:
            "JSON.stringify(new Map()/new Set()) silently yields '{}' and loses all data. Use safeStringify from '@/lib/serialization'.",
        },
      ],
    },
  },
]);

export default eslintConfig;
