/**
 * Flowback — backend/server.js
 * Small Express backend for AI reconstruction
 * 
 * Privacy:
 * - No permanent storage of raw webpage content
 * - Receive context -> Send to AI -> Return result -> Discard
 * - No user history, no analytics
 * - No logging of raw webpage content, passwords, payment data
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { validateAndSanitizeContext } = require('../ai/context');
const { isAIConfigured, reconstructContext, FALLBACK_AI } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_PREFIX = '[Flowback Backend]';

// --- Middleware ---

// CORS: Allow extension origins and localhost for testing
app.use(cors({
  origin: true, // Reflect request origin, allow all for hackathon MVP
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// JSON parser with size limit to prevent abuse
app.use(express.json({ limit: '100kb' }));

// Request timeout middleware (15s)
app.use((req, res, next) => {
  req.setTimeout(15000, () => {
    console.warn(`${LOG_PREFIX} Request timeout`);
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
  });
  next();
});

// Simple request logging without raw content
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  // Log only metadata, never raw body
  console.log(`${LOG_PREFIX} ${timestamp} ${req.method} ${req.path} - Content-Length: ${req.headers['content-length'] || '0'}`);
  next();
});

// --- Routes ---

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    aiConfigured: isAIConfigured(),
    provider: process.env.AI_PROVIDER || 'openai',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Flowback AI Backend',
    version: '0.1.0',
    endpoints: {
      health: 'GET /health',
      reconstruct: 'POST /api/reconstruct'
    },
    privacy: 'No permanent storage of webpage content. Request data is discarded after processing.'
  });
});

/**
 * POST /api/reconstruct
 * Body: { title, url, selectedText, visibleText, focusedElement, inputContext }
 * Returns: { task, tried, next }
 */
app.post('/api/reconstruct', async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  try {
    // 1. Validate API key configuration
    if (!isAIConfigured()) {
      console.warn(`${LOG_PREFIX} ${requestId} - AI not configured (missing API key)`);
      return res.status(503).json({
        error: 'AI service not configured',
        fallback: FALLBACK_AI,
        message: 'Set AI_API_KEY in .env'
      });
    }

    // 2. Validate and sanitize incoming context
    const validation = validateAndSanitizeContext(req.body);
    
    if (!validation.valid) {
      console.warn(`${LOG_PREFIX} ${requestId} - Invalid context: ${validation.error}`);
      return res.status(400).json({
        error: 'Invalid request',
        details: validation.error
      });
    }

    console.log(`${LOG_PREFIX} ${requestId} - Context validated, total length: ${validation.totalLength}, hasContent: ${validation.hasContent}`);

    // 3. Handle empty context gracefully
    if (!validation.hasContent) {
      console.log(`${LOG_PREFIX} ${requestId} - Empty context, returning Not enough context`);
      return res.json({
        task: "Not enough context.",
        tried: "Not enough context.",
        next: "Not enough context."
      });
    }

    // 4. Call AI provider
    try {
      const result = await reconstructContext(validation.sanitized);
      
      console.log(`${LOG_PREFIX} ${requestId} - AI reconstruction successful`);
      
      // 5. Return result and discard request data (no storage)
      return res.json(result);

    } catch (aiError) {
      console.warn(`${LOG_PREFIX} ${requestId} - AI failed: ${aiError.message}`);
      
      // Handle specific AI errors
      if (aiError.message.includes('timeout')) {
        return res.status(504).json({
          error: 'AI request timeout',
          fallback: FALLBACK_AI
        });
      }
      
      if (aiError.message.includes('API error: 401') || aiError.message.includes('API error: 403')) {
        return res.status(502).json({
          error: 'AI authentication failed',
          fallback: FALLBACK_AI
        });
      }

      if (aiError.message.includes('API error: 429')) {
        return res.status(429).json({
          error: 'AI rate limit exceeded',
          fallback: FALLBACK_AI
        });
      }

      // Generic AI failure - return fallback with error status
      // Extension will handle fallback gracefully
      return res.status(502).json({
        error: 'AI reconstruction failed',
        details: aiError.message,
        fallback: FALLBACK_AI
      });
    }

  } catch (err) {
    // Unexpected server error - never leak raw content
    console.error(`${LOG_PREFIX} ${requestId} - Unexpected error: ${err.message}`);
    return res.status(500).json({
      error: 'Internal server error',
      fallback: FALLBACK_AI
    });
  }
  // Request data is automatically discarded (no storage)
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', available: ['GET /health', 'POST /api/reconstruct'] });
});

// Error handler (catch JSON parse errors etc)
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    console.warn(`${LOG_PREFIX} Payload too large`);
    return res.status(413).json({ error: 'Payload too large, max 100kb', fallback: FALLBACK_AI });
  }
  
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.warn(`${LOG_PREFIX} Invalid JSON`);
    return res.status(400).json({ error: 'Invalid JSON', fallback: FALLBACK_AI });
  }

  console.error(`${LOG_PREFIX} Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal error', fallback: FALLBACK_AI });
});

// --- Start server ---

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${LOG_PREFIX} Server running on http://localhost:${PORT}`);
  console.log(`${LOG_PREFIX} Health check: http://localhost:${PORT}/health`);
  console.log(`${LOG_PREFIX} AI Configured: ${isAIConfigured() ? 'YES' : 'NO - Set AI_API_KEY in .env'}`);
  console.log(`${LOG_PREFIX} Provider: ${process.env.AI_PROVIDER || 'openai'} | Model: ${process.env.AI_MODEL || 'gpt-4o-mini'}`);
  console.log(`${LOG_PREFIX} Privacy: No permanent storage, request data discarded after processing`);
});

module.exports = app;
