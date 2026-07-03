// @ts-check
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  timeout: 15000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    viewport: { width: 360, height: 640 }, // sidebar-panel-ish, not full-window
  },
});
