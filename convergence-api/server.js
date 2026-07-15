const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { version: VERSION } = require('./package.json');

const DEFAULT_PORT = 8088;
const DEFAULT_RELAY_MAX = 500;
const DEFAULT_UPLOAD_DIR = '/data/files';
const RECORD_SCHEMA = {
  type: 'object',
  fields: {
    id: 'string',
    timestamp: 'iso8601',
    from: 'string',
    body: 'string',
    replyTo: 'string|null',
    metadata: 'object'
  }
};

function registerRoute(app, routeDescriptions, method, routePath, desc, ...handlers) {
  app[method](routePath, ...handlers);
  routeDescriptions.set(`${method.toUpperCase()} ${routePath}`, desc);
}

function getRoutes(app) {
  const routeDescriptions = app.locals.routeDescriptions || new Map();
  const stack = app._router && app._router.stack ? app._router.stack : [];

  return stack
    .filter(layer => layer.route)
    .flatMap(layer => {
      const routePath = layer.route.path;
      return Object.keys(layer.route.methods)
        .filter(method => layer.route.methods[method])
        .map(method => ({
          method: method.toUpperCase(),
          path: routePath,
          desc: routeDescriptions.get(`${method.toUpperCase()} ${routePath}`) || ''
        }));
    });
}

function createApp(options = {}) {
  const app = express();
  const port = options.port || DEFAULT_PORT;
  const relayMax = options.relayMax || parseInt(process.env.RELAY_MAX || `${DEFAULT_RELAY_MAX}`, 10);
  const uploadDir = options.uploadDir || process.env.UPLOAD_DIR || DEFAULT_UPLOAD_DIR;
  const routeDescriptions = new Map();
  const topics = new Map();

  app.locals.routeDescriptions = routeDescriptions;
  app.locals.port = port;
  app.locals.relayMax = relayMax;
  app.locals.version = VERSION;

  app.use(express.json());

  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  function getTopic(name) {
    if (!topics.has(name)) {
      topics.set(name, { messages: [], subscribers: new Set() });
    }
    return topics.get(name);
  }

  registerRoute(app, routeDescriptions, 'get', '/api/health', 'Health check (uptime, version)', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), version: VERSION });
  });

  registerRoute(app, routeDescriptions, 'get', '/api/manifest', 'Live API manifest (version, routes, schema, retention)', (_req, res) => {
    res.json({
      version: VERSION,
      port,
      routes: getRoutes(app),
      recordSchema: RECORD_SCHEMA,
      retention: {
        storage: 'memory',
        maxMessagesPerTopic: relayMax,
        eviction: 'drop-oldest'
      }
    });
  });

  registerRoute(
    app,
    routeDescriptions,
    'post',
    '/relay/upload',
    'Upload a file and receive a served URL',
    express.raw({ type: '*/*', limit: '20mb' }),
    (req, res) => {
      const ext = (req.headers['content-type'] || 'application/octet-stream').split('/')[1] || 'bin';
      const id = crypto.randomBytes(8).toString('hex');
      const filename = `${id}.${ext.replace(/[^a-z0-9]/g, '')}`;
      const filepath = path.join(uploadDir, filename);

      fs.writeFileSync(filepath, req.body);
      const url = `/files/${filename}`;
      console.log(`[upload] ${filename} (${req.body.length} bytes)`);
      res.status(201).json({ id, filename, url, size: req.body.length });
    }
  );

  registerRoute(app, routeDescriptions, 'get', '/files/:filename', 'Serve an uploaded file by filename', (req, res) => {
    const filepath = path.join(uploadDir, req.params.filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'not found' });
    res.sendFile(filepath);
  });

  registerRoute(app, routeDescriptions, 'post', '/relay/:topic', 'Publish a message to a topic', (req, res) => {
    const topic = getTopic(req.params.topic);
    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      from: req.body.from || 'unknown',
      body: req.body.body || '',
      replyTo: req.body.replyTo || null,
      metadata: req.body.metadata || {}
    };

    topic.messages.push(msg);
    if (topic.messages.length > relayMax) {
      topic.messages = topic.messages.slice(-relayMax);
    }

    for (const sub of topic.subscribers) {
      sub.write(`data: ${JSON.stringify(msg)}\n\n`);
    }

    console.log(`[relay] ${req.params.topic}: ${msg.from} -> "${msg.body.slice(0, 80)}"`);
    res.status(201).json(msg);
  });

  registerRoute(app, routeDescriptions, 'get', '/relay/:topic', 'Poll recent messages for a topic', (req, res) => {
    const topic = getTopic(req.params.topic);
    const since = req.query.since;
    let messages = topic.messages;
    if (since) {
      messages = messages.filter(message => message.timestamp > since);
    }
    res.json({ topic: req.params.topic, count: messages.length, messages });
  });

  registerRoute(app, routeDescriptions, 'get', '/relay/:topic/stream', 'Subscribe to a topic via server-sent events', (req, res) => {
    const topic = getTopic(req.params.topic);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    res.write(': connected\n\n');

    topic.subscribers.add(res);
    console.log(`[relay] ${req.params.topic}: subscriber connected (${topic.subscribers.size} total)`);

    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30000);

    req.on('close', () => {
      topic.subscribers.delete(res);
      clearInterval(keepalive);
      console.log(`[relay] ${req.params.topic}: subscriber disconnected (${topic.subscribers.size} remaining)`);
    });
  });

  registerRoute(app, routeDescriptions, 'get', '/relay', 'List active relay topics with stats', (_req, res) => {
    const summary = {};
    for (const [name, topic] of topics) {
      summary[name] = {
        messageCount: topic.messages.length,
        subscriberCount: topic.subscribers.size,
        lastMessage: topic.messages.length > 0
          ? topic.messages[topic.messages.length - 1].timestamp
          : null
      };
    }
    res.json(summary);
  });

  registerRoute(app, routeDescriptions, 'get', '/chat', 'Serve the chat PWA shell', (_req, res) => {
    res.sendFile(path.join(__dirname, 'chat.html'));
  });

  return app;
}

function startServer(options = {}) {
  const app = createApp(options);
  const port = options.port || app.locals.port;
  const relayMax = options.relayMax || app.locals.relayMax;
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Convergence API listening on port ${port}`);
    console.log('  /api/health         — health check');
    console.log('  /api/manifest       — live API manifest');
    console.log('  /relay/:topic       — publish (POST) / poll (GET)');
    console.log('  /relay/:topic/stream — SSE subscribe');
    console.log(`  Relay max messages per topic: ${relayMax}`);
  });

  return { app, server };
}

if (require.main === module) {
  startServer();
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_RELAY_MAX,
  RECORD_SCHEMA,
  VERSION,
  createApp,
  getRoutes,
  startServer
};
