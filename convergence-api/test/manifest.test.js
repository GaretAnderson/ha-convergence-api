const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_PORT,
  RECORD_SCHEMA,
  VERSION,
  createApp,
  getRoutes
} = require('../server');

function readConfigValue(pattern) {
  const config = fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8');
  const match = config.match(pattern);
  assert.ok(match, `expected config.yaml to match ${pattern}`);
  return match[1];
}

test('manifest exposes live routes, version, port, schema, and retention', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convergence-api-test-'));
  const app = createApp({ port: DEFAULT_PORT, relayMax: 7, uploadDir });
  const server = app.listen(0, '127.0.0.1');

  await new Promise(resolve => server.once('listening', resolve));

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/manifest`);
    assert.equal(response.status, 200);

    const manifest = await response.json();
    const registeredRoutes = getRoutes(app);

    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.version, readConfigValue(/version:\s+"([^"]+)"/));
    assert.equal(manifest.port, DEFAULT_PORT);
    assert.equal(manifest.port, Number(readConfigValue(/8088\/tcp:\s+(\d+)/)));
    assert.deepEqual(manifest.recordSchema, RECORD_SCHEMA);
    assert.deepEqual(manifest.retention, {
      storage: 'memory',
      maxMessagesPerTopic: 7,
      eviction: 'drop-oldest'
    });
    assert.equal(manifest.routes.length, registeredRoutes.length);
    assert.deepEqual(manifest.routes, registeredRoutes);
    assert.ok(manifest.routes.some(route => route.method === 'GET' && route.path === '/api/manifest'));
    assert.ok(manifest.routes.some(route => route.method === 'POST' && route.path === '/relay/:topic'));
  } finally {
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
});
