import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: true,
  rules: {
    'jsdoc/no-defaults': 'off',
  },
}, {
  rules: {
    'ts/consistent-type-definitions': 'off',
    'ts/method-signature-style': 'off',
  },
}, {
  files: ['**/*.test.ts', '**/*.test-d.ts'],
  rules: {
    'unused-imports/no-unused-vars': 'off',
    'antfu/no-top-level-await': 'off',
  },
})
