import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath:
            process.env.CHROMIUM_PATH === "bundled"
              ? undefined
              : (process.env.CHROMIUM_PATH ?? "/usr/bin/chromium"),
        },
      },
    },
  ],
  webServer: {
    command: process.env.E2E_START_COMMAND ?? "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
