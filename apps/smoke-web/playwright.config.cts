import { defineConfig } from '@playwright/test';

const projectRoot = __dirname;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  timeout: 60000,
  use: {
    headless: true,
    baseURL: 'http://localhost:4300',
  },
  webServer: {
    command: 'pnpm vite --host --port 4300 --config vite.config.mts',
    cwd: projectRoot,
    url: 'http://localhost:4300',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
