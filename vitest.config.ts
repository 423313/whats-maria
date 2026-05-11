import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Permite que imports .js encontrem os arquivos .ts correspondentes
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
