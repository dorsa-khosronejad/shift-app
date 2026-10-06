const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { after, before, test } = require('node:test');
const { chromium } = require('playwright');
const { createInstrumenter } = require('istanbul-lib-instrument');
const { createCoverageMap } = require('istanbul-lib-coverage');

const workspaceRoot = path.resolve(__dirname, '../../..');
const frontendRoot = path.join(workspaceRoot, 'frontend');
const backendRoot = path.join(workspaceRoot, 'backend');
const backendRequire = createRequire(path.join(backendRoot, 'package.json'));
const Database = backendRequire('better-sqlite3');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const accounts = {
  employee: { email: 'employee@demo.local', password: 'Employee123!', home: 'employee.html' },
  manager: { email: 'manager@demo.local', password: 'Manager123!', home: 'manager.html' },
  admin: { email: 'admin@demo.local', password: 'Admin123!', home: 'admin.html' },
};

let tempDir;
let databasePath;
let apiBase;
let frontendBase;
let backendProcess;
let frontendServer;
let fixtureDb;
let browser;
const MINIMUM_LINE_COVERAGE = 70;
const MINIMUM_FUNCTION_COVERAGE = 70;
const MINIMUM_BRANCH_COVERAGE = 60;
const instrumenter = createInstrumenter({ esModules: false, compact: false, produceSourceMap: false, coverageVariable: '__coverage__' });
const instrumentedAssets = new Map();
const coverageStructures = new Map();
const coverageHits = new Map();

function instrumentScript(code, filename) {
  const output = instrumenter.instrumentSync(code, filename);
  const data = instrumenter.lastFileCoverage();
  coverageStructures.set(data.path, JSON.parse(JSON.stringify(data)));
  return output;
}

// Inline scripts are padded with blank lines so reported line numbers match the HTML file.
function instrumentHtml(html, filename) {
  let scriptIndex = 0;
  return html.replace(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g, (match, attributes, code, offset) => {
    const codeStart = offset + match.length - code.length - '</script>'.length;
    const lineOffset = html.slice(0, codeStart).split('\n').length - 1;
    const name = scriptIndex === 0 ? filename : `${filename}#${scriptIndex}`;
    scriptIndex += 1;
    return `<script${attributes}>${instrumentScript('\n'.repeat(lineOffset) + code, name)}</script>`;
  });
}

function prepareCoverageAssets() {
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'tests') return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  for (const file of walk(frontendRoot)) {
    const extension = path.extname(file);
    if (extension !== '.html' && extension !== '.js') continue;
    const text = fs.readFileSync(file, 'utf8');
    if (extension === '.html') instrumentedAssets.set(file, instrumentHtml(text, file));
    // The service worker is never loaded (workers are blocked), so it is measured as uncovered.
    else if (path.basename(file) === 'sw.js') instrumentScript(text, file);
    else instrumentedAssets.set(file, instrumentScript(text, file));
  }
}

function mergeCoverageHits(payload) {
  for (const [file, hit] of Object.entries(payload)) {
    if (!coverageStructures.has(file)) continue;
    const total = coverageHits.get(file) || { s: {}, f: {}, b: {} };
    for (const group of ['s', 'f']) {
      for (const [key, count] of Object.entries(hit[group] || {})) total[group][key] = (total[group][key] || 0) + count;
    }
    for (const [key, counts] of Object.entries(hit.b || {})) {
      total.b[key] = counts.map((count, index) => (total.b[key]?.[index] || 0) + count);
    }
    coverageHits.set(file, total);
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startFrontendServer() {
  const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };

  return http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/__coverage__') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        try { mergeCoverageHits(JSON.parse(Buffer.concat(chunks).toString())); } catch {}
        response.writeHead(204).end();
      });
      return;
    }
    const urlPath = decodeURIComponent(new URL(request.url, frontendBase).pathname);
    const requestedPath = path.resolve(frontendRoot, `.${urlPath === '/' ? '/index.html' : urlPath}`);
    if (!requestedPath.startsWith(`${frontendRoot}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const instrumented = instrumentedAssets.get(requestedPath);
    if (instrumented !== undefined) {
      response.writeHead(200, { 'content-type': mimeTypes[path.extname(requestedPath)] });
      response.end(instrumented);
      return;
    }
    fs.readFile(requestedPath, (error, content) => {
      if (error) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, { 'content-type': mimeTypes[path.extname(requestedPath)] || 'application/octet-stream' });
      response.end(content);
    });
  }).listen(0, '127.0.0.1');
}

async function waitForApi() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${apiBase}/ready`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Test API did not become ready');
}

async function flushPageCoverage(page) {
  if (page.isClosed()) return;
  await page.evaluate(() => {
    if (!window.__coverage__) return undefined;
    const payload = {};
    for (const [file, data] of Object.entries(window.__coverage__)) payload[file] = { s: data.s, f: data.f, b: data.b };
    return fetch('/__coverage__', { method: 'POST', body: JSON.stringify(payload), keepalive: true });
  }).catch(() => {});
}

async function createContext({ apiUrl = apiBase, mockPrint = true, allowServiceWorkers = false } = {}) {
  const context = await browser.newContext({ serviceWorkers: allowServiceWorkers ? 'allow' : 'block', acceptDownloads: true });
  await context.addInitScript((url) => { window.SHIFT_API_BASE = url; }, apiUrl);
  if (mockPrint) await context.addInitScript(() => { window.print = () => { window.__printWasCalled = true; }; });
  // Navigations destroy the document, so every page reports its cumulative counters as it unloads.
  await context.addInitScript(() => {
    window.addEventListener('pagehide', () => {
      if (!window.__coverage__) return;
      const payload = {};
      for (const [file, data] of Object.entries(window.__coverage__)) payload[file] = { s: data.s, f: data.f, b: data.b };
      fetch('/__coverage__', { method: 'POST', body: JSON.stringify(payload), keepalive: true }).catch(() => {});
    });
  });
  return context;
}

async function createTrackedPage(context) {
  return context.newPage();
}

async function closePage(page) {
  await flushPageCoverage(page);
  await page.close();
}

async function closeContext(context) {
  for (const page of context.pages()) await flushPageCoverage(page);
  await context.close();
}

async function createPage() {
  const context = await createContext();
  const page = await createTrackedPage(context);
  return { context, page };
}

async function reportCoverage() {
  const coverageMap = createCoverageMap({});
  for (const [file, structure] of coverageStructures) {
    const hits = coverageHits.get(file);
    const data = JSON.parse(JSON.stringify(structure));
    for (const key of Object.keys(data.s)) data.s[key] = hits?.s[key] || 0;
    for (const key of Object.keys(data.f)) data.f[key] = hits?.f[key] || 0;
    for (const key of Object.keys(data.b)) data.b[key] = data.b[key].map((_, index) => hits?.b[key]?.[index] || 0);
    coverageMap.addFileCoverage(data);
  }
  const summary = coverageMap.getCoverageSummary();
  const files = coverageMap.files().map((url) => {
    const fileCoverage = coverageMap.fileCoverageFor(url);
    const fileSummary = fileCoverage.toSummary();
    return {
      file: path.relative(workspaceRoot, url),
      lines: fileSummary.lines.pct,
      statements: fileSummary.statements.pct,
      functions: fileSummary.functions.pct,
      branches: fileSummary.branches.pct,
      uncoveredLines: fileCoverage.getUncoveredLines(),
    };
  }).sort((left, right) => left.lines - right.lines);
  const report = { threshold: MINIMUM_LINE_COVERAGE, total: summary, files };
  const coverageDir = path.join(workspaceRoot, 'coverage');
  await fs.promises.mkdir(coverageDir, { recursive: true });
  await fs.promises.writeFile(path.join(coverageDir, 'frontend-coverage.json'), JSON.stringify(report, null, 2));
  console.log(`\nFrontend browser coverage: ${summary.lines.pct}% lines (minimum ${MINIMUM_LINE_COVERAGE}%), ${summary.functions.pct}% functions (minimum ${MINIMUM_FUNCTION_COVERAGE}%), ${summary.branches.pct}% branches (minimum ${MINIMUM_BRANCH_COVERAGE}%)`);
  for (const file of files) {
    console.log(`  ${file.file}: ${file.lines}% lines, ${file.functions}% functions, ${file.branches}% branches`);
    if (file.uncoveredLines.length) console.log(`    uncovered: ${file.uncoveredLines.slice(0, 40).join(', ')}${file.uncoveredLines.length > 40 ? ', ...' : ''}`);
  }
  assert.ok(summary.lines.pct >= MINIMUM_LINE_COVERAGE, `Frontend line coverage ${summary.lines.pct}% is below the ${MINIMUM_LINE_COVERAGE}% minimum`);
  assert.ok(summary.functions.pct >= MINIMUM_FUNCTION_COVERAGE, `Frontend function coverage ${summary.functions.pct}% is below the ${MINIMUM_FUNCTION_COVERAGE}% minimum`);
  assert.ok(summary.branches.pct >= MINIMUM_BRANCH_COVERAGE, `Frontend branch coverage ${summary.branches.pct}% is below the ${MINIMUM_BRANCH_COVERAGE}% minimum`);
}

function dateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localDateTimeOffset(days, hour = '09:00') {
  return `${dateOffset(days)}T${hour}`;
}

function totpCode(secret, timestamp = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const key = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      key.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30000)));
  const digest = crypto.createHmac('sha1', Buffer.from(key)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

before(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shift-frontend-e2e-'));
  prepareCoverageAssets();
  databasePath = path.join(tempDir, 'shifts.db');
  const backendPort = await freePort();
  apiBase = `http://127.0.0.1:${backendPort}/api`;
  frontendServer = startFrontendServer();
  await new Promise((resolve, reject) => {
    frontendServer.once('listening', resolve);
    frontendServer.once('error', reject);
  });
  frontendBase = `http://127.0.0.1:${frontendServer.address().port}`;

  backendProcess = spawn(process.execPath, ['server.js'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      PORT: String(backendPort),
      DB_PATH: databasePath,
      CORS_ORIGIN: frontendBase,
      JWT_ACCESS_SECRET: 'frontend-test-access-secret-1234567890abcdef',
      JWT_REFRESH_SECRET: 'frontend-test-refresh-secret-1234567890abcdef',
      NODE_ENV: 'test',
      SMTP_HOST: '',
      FRONTEND_URL: frontendBase,
    },
    stdio: 'ignore',
  });
  await waitForApi();
  fixtureDb = new Database(databasePath);

  assert.ok(fs.existsSync(chromePath), `Chrome was not found at ${chromePath}; set CHROME_PATH to a Chromium-compatible browser`);
  browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
});

after(async () => {
  let coverageError;
  try {
    await reportCoverage();
  } catch (error) {
    coverageError = error;
  } finally {
    await browser?.close();
    fixtureDb?.close();
    if (frontendServer?.listening) await new Promise((resolve) => frontendServer.close(resolve));
    if (backendProcess && backendProcess.exitCode === null) {
      const exited = new Promise((resolve) => backendProcess.once('exit', resolve));
      backendProcess.kill('SIGTERM');
      await exited;
    }
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
  if (coverageError) throw coverageError;
});


module.exports = { assert, crypto, accounts, createPage, createContext, createTrackedPage, closeContext, closePage, dateOffset, localDateTimeOffset, totpCode };
Object.defineProperties(module.exports, {
  apiBase: { get: () => apiBase },
  frontendBase: { get: () => frontendBase },
  fixtureDb: { get: () => fixtureDb },
  browser: { get: () => browser },
});
