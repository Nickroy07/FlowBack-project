/**
 * Flowback — backend/ai.js
 * AI provider integration layer with Work Journey reconstruction.
 * Gracefully falls back to deterministic reconstruction on any failure.
 */

const { SYSTEM_PROMPT, FALLBACK_AI } = require('../ai/prompt');
const { buildUserPrompt, validateAIResponse, deterministicReconstruct } = require('../ai/context');

function getConfig() {
  return {
    apiKey: process.env.AI_API_KEY,
    provider: process.env.AI_PROVIDER || 'openai',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    apiUrl: process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions',
    timeoutMs: parseInt(process.env.AI_TIMEOUT_MS, 10) || 12000
  };
}

const LOG_PREFIX = '[Flowback AI]';

function isAIConfigured() {
  const { apiKey } = getConfig();
  return Boolean(apiKey && apiKey.trim().length > 0 && apiKey !== 'your_api_key_here' && apiKey !== 'test-key');
}

async function reconstructContext(sanitizedPayload) {
  const config = getConfig();
  const context = sanitizedPayload.context || sanitizedPayload;
  const journey = sanitizedPayload.journey || [];
  const interruption = sanitizedPayload.interruption || {};
  
  if (!isAIConfigured()) {
    console.log(`${LOG_PREFIX} AI not configured, using deterministic fallback`);
    return deterministicReconstruct(context, journey, interruption);
  }

  const userPrompt = buildUserPrompt(sanitizedPayload);

  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: 500,
    response_format: { type: 'json_object' }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    console.log(`${LOG_PREFIX} Calling ${config.provider} (${config.model}), payload ~${userPrompt.length} chars`);

    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`${LOG_PREFIX} API error: ${response.status} ${response.statusText}, using deterministic fallback`);
      return deterministicReconstruct(context, journey, interruption);
    }

    const data = await response.json();

    let content = null;
    if (data.choices && data.choices[0] && data.choices[0].message) {
      content = data.choices[0].message.content;
    } else if (data.content) {
      content = data.content;
    } else if (typeof data === 'object' && data.task) {
      content = JSON.stringify(data);
    }

    if (!content) {
      console.warn(`${LOG_PREFIX} Empty AI content, using deterministic fallback`);
      return deterministicReconstruct(context, journey, interruption);
    }

    let parsed;
    try {
      const cleaned = content
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          return deterministicReconstruct(context, journey, interruption);
        }
      } else {
        return deterministicReconstruct(context, journey, interruption);
      }
    }

    const validation = validateAIResponse(parsed);
    if (!validation.valid) {
      console.warn(`${LOG_PREFIX} Invalid AI schema: ${validation.error}, using deterministic fallback`);
      return deterministicReconstruct(context, journey, interruption);
    }

    console.log(`${LOG_PREFIX} AI reconstruction successful`);
    return validation.sanitized;

  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`${LOG_PREFIX} AI call failed (${err.message}), using deterministic fallback`);
    return deterministicReconstruct(context, journey, interruption);
  }
}

async function reconstructWithFallback(sanitizedPayload) {
  try {
    return await reconstructContext(sanitizedPayload);
  } catch (err) {
    const context = sanitizedPayload.context || sanitizedPayload;
    const journey = sanitizedPayload.journey || [];
    const interruption = sanitizedPayload.interruption || {};
    try {
      return deterministicReconstruct(context, journey, interruption);
    } catch {
      return { ...FALLBACK_AI };
    }
  }
}

module.exports = {
  isAIConfigured,
  reconstructContext,
  reconstructWithFallback,
  FALLBACK_AI,
  SYSTEM_PROMPT,
  deterministicReconstruct
};

