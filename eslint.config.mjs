import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['homebridge-ui/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', fetch: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  { rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
