import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/**', '**/coverage/**']),
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // `@nestjs/config` is the only reader of the environment; code receives
      // validated values through `ConfigService`.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration through ConfigService, not process.env.',
        },
      ],
    },
  },
  {
    // The domain package uses only the language and standard library
    // (AD-32 layering): no framework, database, validation, or provider code.
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@nestjs/*',
                'kysely',
                'kysely/*',
                'pg',
                'pg/*',
                'zod',
                'zod/*',
                '@merchantflow/*',
                'stripe',
                '@stripe/*',
                '@adyen/*',
                'adyen-*',
                'braintree',
              ],
              message:
                'packages/domain must not import frameworks, database drivers, validation libraries, or provider SDKs.',
            },
          ],
        },
      ],
    },
  },
  {
    // The processor port is provider-agnostic: no framework, database,
    // validation library, or provider SDK, and of the workspace only the
    // domain package (AD-73).
    files: ['packages/processor-contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@nestjs/*',
                'kysely',
                'kysely/*',
                'pg',
                'pg/*',
                'zod',
                'zod/*',
                '@merchantflow/*',
                '!@merchantflow/domain',
                'stripe',
                '@stripe/*',
              ],
              message:
                'packages/processor-contracts must stay free of frameworks, database drivers, validation libraries, and provider SDKs.',
            },
          ],
        },
      ],
    },
  },
  {
    // Stripe models stay inside the Stripe adapter package (AD-73).
    files: ['apps/**/*.{ts,tsx}', 'packages/database/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['stripe', 'stripe/*'],
              message:
                'Only packages/processor-stripe may import the Stripe SDK; use the processor port.',
            },
          ],
        },
      ],
    },
  },
  {
    // Amounts are `bigint` from the API string to the database column and never
    // pass through `number`, which rounds above 2^53 - 1 (AD-60). The money code
    // cannot use `Number`, the globals that return or coerce to a number,
    // `Math`, `JSON` (it reads every numeric literal as a double), or the global
    // object that would reach them, and it cannot use unary plus.
    // The frontend's amount conversion (AD-74), the ledger rules (P-06), and
    // the refund rule (P-07) follow the same rules.
    files: [
      'packages/domain/src/money/**/*.ts',
      'packages/domain/src/ledger/**/*.ts',
      'packages/domain/src/refund/**/*.ts',
      'apps/web/src/money/**/*.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        ...[
          ['Number', 'Number() and Number.* convert through a double.'],
          ['parseInt', 'parseInt returns a number.'],
          ['parseFloat', 'parseFloat returns a number.'],
          ['isNaN', 'isNaN coerces its argument to a number.'],
          ['isFinite', 'isFinite coerces its argument to a number.'],
          ['Math', 'Math works on numbers.'],
          ['JSON', 'JSON.parse reads every numeric literal as a double.'],
          ['globalThis', 'The global object would reach Number and Math.'],
          ['global', 'The global object would reach Number and Math.'],
          ['window', 'The global object would reach Number and Math.'],
        ].map(([name, reason]) => ({
          name,
          message: `${reason} Amounts stay bigint and never pass through number.`,
        })),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "UnaryExpression[operator='+']",
          message:
            'Unary plus converts to number. Amounts stay bigint and never pass through number.',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
