import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import vitest from '@vitest/eslint-plugin'

export default tseslint.config(
    { ignores: ['**/node_modules/**', '**/dist/**', '**/target/**', '**/gen/**', 'coverage/**', 'artifacts/**', '.worktrees/**'] },
    {
        files: ['packages/**/*.ts', 'examples/**/*.ts', 'examples/**/*.tsx', 'quifox/**/*.ts', 'quifox/**/*.tsx'],
        extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
        rules: {
            // A Hook generator may return its final value without emitting events.
            'require-yield': 'off',
            // Named owners are needed inside ordinary generator functions and getters.
            '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['owner', 'plugin', 'publisher'] }],
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
                ignoreRestSiblings: true
            }]
        }
    },
    {
        files: ['quifox/desktop/src/**/*.tsx'],
        rules: { 'no-restricted-syntax': ['error', { selector: 'JSXOpeningElement[name.name="p"]',
            message: 'Use a semantic state, hint, or Markdown body component instead of a standalone business paragraph.' }] }
    },
    {
        files: ['*.mjs'],
        extends: [eslint.configs.recommended],
        languageOptions: { globals: { URL: 'readonly' } }
    },
    {
        files: ['packages/**/test/**/*.ts', 'examples/**/test/**/*.ts', 'examples/**/test/**/*.tsx', 'quifox/**/test/**/*.ts', 'quifox/**/test/**/*.tsx'],
        plugins: { vitest },
        rules: {
            'vitest/no-focused-tests': 'error',
            'vitest/no-disabled-tests': 'error',
            'vitest/valid-expect': 'error',
            'vitest/no-identical-title': 'error'
        }
    }
)
