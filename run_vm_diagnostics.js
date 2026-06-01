const { chromium } = require('playwright');
const { spawn } = require('child_process');

async function run() {
  console.log("Starting Next.js server (dev mode)...");
  const server = spawn('npm', ['run', 'dev'], {
    cwd: 'c:\\Users\\csbal\\Downloads\\secondone',
    shell: true,
    env: { ...process.env, PORT: '3000' }
  });

  server.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      console.log(`[SERVER STDOUT] ${text}`);
    }
  });

  server.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      console.error(`[SERVER STDERR] ${text}`);
    }
  });

  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 8000));

  console.log("Launching Playwright browser...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Route console logs
  page.on('console', msg => {
    console.log(`[BROWSER CONSOLE] [${msg.type()}] ${msg.text()}`);
  });

  page.on('pageerror', err => {
    console.error(`[BROWSER ERROR] ${err.toString()}`);
  });

  console.log("Navigating directly to dashboard (auth bypassed)...");
  await page.goto('http://localhost:3000/dashboard');
  await page.waitForTimeout(10000);
  console.log("Current URL after goto:", page.url());

  console.log("Selecting Linux Terminal tab...");
  try {
    await page.getByRole('button', { name: 'Linux Terminal' }).click({ timeout: 5000 });
    console.log("Click successful!");
  } catch (clickErr) {
    console.error("Failed to click tab:", clickErr.message);
  }
  await page.waitForTimeout(2000);
  console.log("Current URL after click:", page.url());

  console.log("Selecting WASM VM Mode button...");
  try {
    await page.getByRole('button', { name: 'WASM VM Mode' }).click({ timeout: 10000 });
    console.log("WASM VM Mode button click successful!");
  } catch (clickErr) {
    console.error("Failed to click WASM VM Mode button:", clickErr.message);
    const content = await page.content();
    console.log("=== HTML BODY PAGE CONTENT DUMP ===");
    console.log(content.slice(0, 5000));
    console.log("===================================");
  }
  await page.waitForTimeout(2000);

  // Wait for emulator to be mounted on window
  console.log("Waiting for window.emulator to be initialized...");
  let initialized = false;
  for (let i = 0; i < 20; i++) {
    initialized = await page.evaluate(() => typeof window.emulator !== 'undefined');
    if (initialized) break;
    await page.waitForTimeout(1000);
  }

  if (!initialized) {
    console.error("Error: window.emulator failed to initialize within 20s.");
    await browser.close();
    server.kill();
    process.exit(1);
  }
  console.log("window.emulator is initialized!");

  // Wait for bootComplete
  console.log("Waiting for VM bootComplete...");
  let bootComplete = false;
  for (let i = 0; i < 60; i++) {
    bootComplete = await page.evaluate(() => {
      return window.emulator && window.emulator.getFullLifecycleState().bootComplete;
    });
    if (bootComplete) break;
    await page.waitForTimeout(1000);
  }

  if (!bootComplete) {
    console.error("Error: VM failed to reach bootComplete within 60s.");
    await browser.close();
    server.kill();
    process.exit(1);
  }
  console.log("VM bootComplete is true! Waiting 5s for verification pipeline to execute...");
  await page.waitForTimeout(5000);

  console.log("Sending command to check guest_verify.sh...");
  await page.evaluate(() => {
    window.emulator.sendProgrammaticInput(0, "f=/mnt/guest_verify.sh; [ ! -f $f ] && f=/mnt/9p/guest_verify.sh; ls -la $f && cat $f && md5sum $f && wc -c $f\n");
  });

  // Wait to capture the output of cat
  await page.waitForTimeout(8000);

  console.log("Tearing down...");
  await browser.close();
  server.kill();
  process.exit(0);
}

run().catch(err => {
  console.error("Diagnostic script failed:", err);
  process.exit(1);
});
