import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/**', '**/coverage/**']),
  js.configs.recommended,
  {
    files: ['**/*.ts'],
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
    files: ['**/*.ts'],
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
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
