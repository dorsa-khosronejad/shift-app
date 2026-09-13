require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const authRoutes = require('./routes/auth');
const timeEntryRoutes = require('./routes/timeEntries');
const userRoutes = require('./routes/users');

const app = express();

app.disable('x-powered-by');
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5500').split(',').map((origin) => origin.trim()).filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true, // required so the browser will send/receive the refresh cookie
  })
);
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => {
  const requestId = req.get('x-request-id') || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
    return res.status(403).json({ error: 'Request origin is not allowed' });
  }
  next();
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/ready', (req, res) => {
  try {
    require('./db/database').prepare('SELECT 1').get();
    res.json({ status: 'ready' });
  } catch (error) {
    console.error('Readiness check failed:', error);
    res.status(503).json({ status: 'not-ready' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/shifts', timeEntryRoutes);
app.use('/api/users', userRoutes);

// Central error handler — never leak stack traces to the client
app.use((err, req, res, next) => {
  console.error(JSON.stringify({ requestId: req.requestId, method: req.method, path: req.path, error: err.message, stack: err.stack }));
  res.status(500).json({ error: 'Something went wrong on our end' });
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Shift tracker API running on http://0.0.0.0:${PORT}`);
  console.log(`  - Local: http://localhost:${PORT}`);
  console.log(`  - Network: http://192.168.0.62:${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down cleanly`);
  server.close(() => {
    require('./db/database').close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exitCode = 1;
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exitCode = 1;
});
