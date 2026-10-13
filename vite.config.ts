import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  oxc: { jsx: { runtime: 'automatic' } },
});
