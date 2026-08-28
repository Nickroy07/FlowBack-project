/**
 * Flowback — backend/server.js
 * Express backend for AI reconstruction - OPTIONAL AI, core works without it
 * Privacy: No permanent storage, no logging of raw content
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { validateAndSanitizeContext, deterministicReconstruct } = require('../ai/context');
const { isAIConfigured, reconstructContext, FALLBACK_AI } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_PREFIX = '[Flowback Backend]';

app.use(cors({
  origin: true,
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
    name: 'Flowback AI Backend',
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
 * Always returns 200 with {task, tried, next} even without AI
 * AI is optional enhancement, not required for core flow
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

    console.log(`${LOG_PREFIX} ${requestId} - Context validated, length: ${validation.totalLength}, hasContent: ${validation.hasContent}`);

    if (!validation.hasContent) {
      console.log(`${LOG_PREFIX} ${requestId} - Empty context`);
      return res.json({
        task: "Not enough context.",
        tried: "Not enough context.",
        next: "Not enough context.",
        source: 'empty',
        aiUsed: false
      });
    }

    try {
      const result = await reconstructContext(validation.sanitized);
      
      console.log(`${LOG_PREFIX} ${requestId} - Reconstruction successful (aiConfigured: ${isAIConfigured()})`);
      
      // Add metadata without exposing secrets
      return res.json({
        ...result,
        source: isAIConfigured() ? 'ai' : 'deterministic',
        aiUsed: isAIConfigured()
      });

    } catch (aiError) {
      console.warn(`${LOG_PREFIX} ${requestId} - AI failed: ${aiError.message}, using deterministic fallback`);
      
      // Always fallback to deterministic, never fail the request
      const fallback = deterministicReconstruct(validation.sanitized);
      return res.json({
        ...fallback,
        source: 'deterministic',
        aiUsed: false,
        note: 'AI temporarily unavailable, used captured context'
      });
    }

  } catch (err) {
    console.error(`${LOG_PREFIX} ${requestId} - Unexpected error: ${err.message}`);
    // Even on unexpected error, return fallback, not crash
    try {
      const fallback = deterministicReconstruct(req.body || {});
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
    console.warn(`${LOG_PREFIX} Payload too large`);
    return res.status(413).json({ error: 'Payload too large, max 100kb', ...FALLBACK_AI });
  }
  
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.warn(`${LOG_PREFIX} Invalid JSON`);
    return res.status(400).json({ error: 'Invalid JSON', ...FALLBACK_AI });
  }

  console.error(`${LOG_PREFIX} Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal error', ...FALLBACK_AI });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${LOG_PREFIX} Server running on http://localhost:${PORT}`);
  console.log(`${LOG_PREFIX} Health: http://localhost:${PORT}/health`);
  console.log(`${LOG_PREFIX} AI Configured: ${isAIConfigured() ? 'YES - AI reconstruction enabled' : 'NO - Running deterministic mode (core works without AI)'}`);
  console.log(`${LOG_PREFIX} Provider: ${process.env.AI_PROVIDER || 'openai'} | Model: ${process.env.AI_MODEL || 'gpt-4o-mini'}`);
  console.log(`${LOG_PREFIX} Mode: ${isAIConfigured() ? 'AI + deterministic fallback' : 'Deterministic only (MVP)'}`);
  console.log(`${LOG_PREFIX} Privacy: No permanent storage, request data discarded`);
});

module.exports = app;
