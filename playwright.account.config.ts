import {defineConfig} from '@playwright/test';

const port=Number(process.env.MAS_ACCOUNT_UI_PORT??5198);
export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['account-navigation.spec.ts','management-settings.spec.ts','web-refinement.spec.ts','core-workflow-refinement.spec.ts','task-retry.spec.ts','site-polish.spec.ts','workspace-polish.spec.ts','resource-polish.spec.ts'],
  fullyParallel: false,
  workers: 1,
  use: {baseURL: 'http://127.0.0.1:'+port, viewport: {width: 1440, height: 1000}, channel: process.env.PLAYWRIGHT_CHANNEL},
  outputDir: 'artifacts/account-navigation',
  webServer: {
    command: 'MAS_NAVIGATION_FIXTURE=1 MAS_NAVIGATION_PORT='+port+' node tests/account-navigation-server.mjs',
    url: 'http://127.0.0.1:'+port,
    reuseExistingServer: false,
  },
});
