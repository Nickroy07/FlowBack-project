/**
 * Flowback — backend/ai.js
 * AI provider integration layer
 * Privacy: No permanent storage, no logging of raw content
 */

const { SYSTEM_PROMPT, FALLBACK_AI } = require('../ai/prompt');
const { buildUserPrompt, validateAIResponse } = require('../ai/context');

// Configuration from environment
const AI_API_KEY = process.env.AI_API_KEY;
const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const AI_API_URL = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS, 10) || 12000;

const LOG_PREFIX = '[Flowback AI]';

/**
 * Checks if AI is configured
 */
function isAIConfigured() {
  return Boolean(AI_API_KEY && AI_API_KEY.trim().length > 0 && AI_API_KEY !== 'your_api_key_here');
}

/**
 * Calls AI provider with strict timeout and error handling
 * Returns { task, tried, next } or throws
 */
async function reconstructContext(sanitizedContext) {
  if (!isAIConfigured()) {
    throw new Error('AI_API_KEY not configured');
  }

  const userPrompt = buildUserPrompt(sanitizedContext);

  // Build request payload - OpenAI-compatible chat completions format
  const payload = {
    model: AI_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: 400,
    // Some providers support json_object response format
    // We include it but handle gracefully if not supported
    response_format: { type: 'json_object' }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    console.log(`${LOG_PREFIX} Calling ${AI_PROVIDER} model ${AI_MODEL} (payload ~${userPrompt.length} chars)`);

    const response = await fetch(AI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      // Never log raw content, only status and sanitized error
      console.warn(`${LOG_PREFIX} API error: ${response.status} ${response.statusText}`);
      // Log truncated error for debugging without leaking sensitive data
      console.warn(`${LOG_PREFIX} Error detail: ${errorText.slice(0, 200)}`);
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract content from OpenAI-compatible response
    let content = null;
    if (data.choices && data.choices[0] && data.choices[0].message) {
      content = data.choices[0].message.content;
    } else if (data.content) {
      content = data.content;
    } else if (typeof data === 'object' && data.task) {
      // Direct JSON response (some providers)
      content = JSON.stringify(data);
    }

    if (!content) {
      console.warn(`${LOG_PREFIX} No content in AI response`);
      throw new Error('No content in AI response');
    }

    // Parse JSON - handle markdown fences if AI mistakenly adds them
    let parsed;
    try {
      // Strip possible markdown code fences
      const cleaned = content
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.warn(`${LOG_PREFIX} Failed to parse AI JSON: ${parseErr.message}`);
      // Try to extract JSON object with regex as fallback
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch (e) {
          throw new Error('Malformed AI JSON');
        }
      } else {
        throw new Error('Malformed AI JSON');
      }
    }

    const validation = validateAIResponse(parsed);
    if (!validation.valid) {
      console.warn(`${LOG_PREFIX} Invalid AI response: ${validation.error}`);
      throw new Error(`Invalid AI response: ${validation.error}`);
    }

    console.log(`${LOG_PREFIX} Reconstruction successful`);
    return validation.sanitized;

  } catch (err) {
    clearTimeout(timeoutId);
    
    if (err.name === 'AbortError') {
      console.warn(`${LOG_PREFIX} Request timed out after ${AI_TIMEOUT_MS}ms`);
      throw new Error('AI request timeout');
    }

    // Re-throw with sanitized message (no raw content)
    throw err;
  }
}

/**
 * Safe wrapper that returns fallback on failure
 * Used when you want guaranteed return value
 */
async function reconstructWithFallback(sanitizedContext) {
  try {
    return await reconstructContext(sanitizedContext);
  } catch (err) {
    console.warn(`${LOG_PREFIX} Using fallback: ${err.message}`);
    return { ...FALLBACK_AI };
  }
}

module.exports = {
  isAIConfigured,
  reconstructContext,
  reconstructWithFallback,
  FALLBACK_AI,
  SYSTEM_PROMPT
};
