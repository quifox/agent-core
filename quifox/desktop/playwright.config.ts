import { defineConfig } from '@playwright/test'

export default defineConfig({ testDir: './e2e', testMatch: '**/*.spec.ts', fullyParallel: true,
    outputDir: '../../artifacts/ui/results', reporter: [['list'], ['html', { outputFolder: '../../artifacts/ui/report', open: 'never' }]],
    use: { baseURL: 'http://127.0.0.1:29407', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL, viewport: { width: 1440, height: 900 },
        screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    webServer: { command: 'bun run dev --port 29407', url: 'http://127.0.0.1:29407/e2e/harness.html', reuseExistingServer: false } })
