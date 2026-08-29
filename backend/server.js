/**
 * Flowback — backend/server.js
 * Express backend for Work-Context & Journey Reconstruction.
 * Privacy: No permanent storage, no raw logging.
 */

try { require('dotenv').config(); } catch {}
const express = require('express');
const cors = require('cors');
const { validateAndSanitizeContext, deterministicReconstruct } = require('../ai/context');
const { isAIConfigured, reconstructContext, FALLBACK_AI } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_PREFIX = '[Flowback Backend]';

// Secure CORS configuration: allow Chrome Extensions and local tools
const allowedOrigins = [
  /^chrome-extension:\/\//,
  /^http:\/\/localhost(:[0-9]+)?$/,
  /^http:\/\/127\.0\.0\.1(:[0-9]+)?$/
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser or extension requests with no origin header (like curl or service workers)
    if (!origin) return callback(null, true);
    const isAllowed = allowedOrigins.some(pattern => pattern.test(origin));
    if (isAllowed) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  req.setTimeout(15000, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout', ...FALLBACK_AI });
    }
  });
  next();
});

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`${LOG_PREFIX} ${timestamp} ${req.method} ${req.path} - Content-Length: ${req.headers['content-length'] || '0'}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    aiConfigured: isAIConfigured(),
    provider: process.env.AI_PROVIDER || 'openai',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    timestamp: new Date().toISOString(),
    mode: isAIConfigured() ? 'ai' : 'deterministic',
    message: isAIConfigured() ? 'AI reconstruction available' : 'Running in deterministic mode (AI optional)'
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Flowback Work-Context Recovery Engine',
    version: '0.2.0',
    endpoints: {
      health: 'GET /health',
      reconstruct: 'POST /api/reconstruct'
    },
    privacy: 'No permanent storage, request data discarded after processing.',
    ai: isAIConfigured() ? 'enabled' : 'optional - deterministic fallback active'
  });
});

/**
 * POST /api/reconstruct
 * Returns { task, tried, next, journeySummary, whereYouLeftOff, confidence, source, aiUsed }
 */
app.post('/api/reconstruct', async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  try {
    const validation = validateAndSanitizeContext(req.body);
    
    if (!validation.valid) {
      console.warn(`${LOG_PREFIX} ${requestId} - Invalid context: ${validation.error}`);
      return res.status(400).json({
        error: 'Invalid request',
        details: validation.error,
        ...FALLBACK_AI
      });
    }

    if (!validation.hasContent) {
      console.log(`${LOG_PREFIX} ${requestId} - Empty context payload`);
      return res.json({
        task: "Not enough context.",
        tried: "Not enough context.",
        next: "Not enough context.",
        journeySummary: "Single page session.",
        whereYouLeftOff: "Not enough context.",
        confidence: "low",
        source: 'empty',
        aiUsed: false
      });
    }

    try {
      const result = await reconstructContext(validation);
      
      return res.json({
        ...result,
        source: isAIConfigured() ? 'ai' : 'deterministic',
        aiUsed: isAIConfigured()
      });

    } catch (aiError) {
      console.warn(`${LOG_PREFIX} ${requestId} - AI failed: ${aiError.message}, using deterministic fallback`);
      const fallback = deterministicReconstruct(validation.context, validation.journey, validation.interruption);
      return res.json({
        ...fallback,
        source: 'deterministic',
        aiUsed: false,
        note: 'AI temporarily unavailable, used captured context'
      });
    }

  } catch (err) {
    console.error(`${LOG_PREFIX} ${requestId} - Unexpected error: ${err.message}`);
    try {
      const fallback = deterministicReconstruct(req.body?.context || req.body || {}, req.body?.journey || [], req.body?.interruption || {});
      return res.json({
        ...fallback,
        source: 'deterministic',
        aiUsed: false,
        error: 'Internal error, used fallback'
      });
    } catch {
      return res.status(500).json({
        error: 'Internal server error',
        ...FALLBACK_AI,
        source: 'fallback',
        aiUsed: false
      });
    }
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', available: ['GET /health', 'POST /api/reconstruct'] });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large, max 100kb', ...FALLBACK_AI });
  }
  
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON', ...FALLBACK_AI });
  }

  console.error(`${LOG_PREFIX} Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal error', ...FALLBACK_AI });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${LOG_PREFIX} Server running on http://localhost:${PORT}`);
  console.log(`${LOG_PREFIX} Health: http://localhost:${PORT}/health`);
  console.log(`${LOG_PREFIX} AI Configured: ${isAIConfigured() ? 'YES - AI reconstruction enabled' : 'NO - Running deterministic mode'}`);
});

module.exports = app;

