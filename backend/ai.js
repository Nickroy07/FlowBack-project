/**
 * Flowback — backend/ai.js
 * AI provider integration layer - OPTIONAL for MVP
 * Core product works WITHOUT AI via deterministic fallback
 */

const { SYSTEM_PROMPT, FALLBACK_AI } = require('../ai/prompt');
const { buildUserPrompt, validateAIResponse, deterministicReconstruct } = require('../ai/context');

// Configuration from environment - loaded fresh each call to handle .env changes
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

async function reconstructContext(sanitizedContext) {
  const config = getConfig();
  
  if (!isAIConfigured()) {
    console.log(`${LOG_PREFIX} AI not configured, using deterministic fallback`);
    return deterministicReconstruct(sanitizedContext);
  }

  const userPrompt = buildUserPrompt(sanitizedContext);

  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: 400,
    response_format: { type: 'json_object' }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    console.log(`${LOG_PREFIX} Calling ${config.provider} model ${config.model} (payload ~${userPrompt.length} chars)`);

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
      const errorText = await response.text().catch(() => 'Unknown error');
      console.warn(`${LOG_PREFIX} API error: ${response.status} ${response.statusText}`);
      
      // Handle specific error codes with deterministic fallback
      if (response.status === 429) {
        console.warn(`${LOG_PREFIX} Quota exceeded (429), using deterministic fallback`);
        return deterministicReconstruct(sanitizedContext);
      }
      if (response.status === 401 || response.status === 403) {
        console.warn(`${LOG_PREFIX} Auth failed (${response.status}), using deterministic fallback`);
        return deterministicReconstruct(sanitizedContext);
      }
      
      console.warn(`${LOG_PREFIX} Error detail: ${errorText.slice(0, 200)}`);
      // For any API error, fallback to deterministic
      return deterministicReconstruct(sanitizedContext);
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
      console.warn(`${LOG_PREFIX} No content in AI response, using deterministic fallback`);
      return deterministicReconstruct(sanitizedContext);
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
      console.warn(`${LOG_PREFIX} Failed to parse AI JSON: ${parseErr.message}, using deterministic fallback`);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch (e) {
          return deterministicReconstruct(sanitizedContext);
        }
      } else {
        return deterministicReconstruct(sanitizedContext);
      }
    }

    const validation = validateAIResponse(parsed);
    if (!validation.valid) {
      console.warn(`${LOG_PREFIX} Invalid AI response: ${validation.error}, using deterministic fallback`);
      return deterministicReconstruct(sanitizedContext);
    }

    console.log(`${LOG_PREFIX} AI reconstruction successful`);
    return validation.sanitized;

  } catch (err) {
    clearTimeout(timeoutId);
    
    if (err.name === 'AbortError') {
      console.warn(`${LOG_PREFIX} Request timed out after ${config.timeoutMs}ms, using deterministic fallback`);
      return deterministicReconstruct(sanitizedContext);
    }

    console.warn(`${LOG_PREFIX} AI failed: ${err.message}, using deterministic fallback`);
    return deterministicReconstruct(sanitizedContext);
  }
}

async function reconstructWithFallback(sanitizedContext) {
  try {
    return await reconstructContext(sanitizedContext);
  } catch (err) {
    console.warn(`${LOG_PREFIX} Using fallback: ${err.message}`);
    // Even fallback failure returns deterministic
    try {
      return deterministicReconstruct(sanitizedContext);
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
  deterministicReconstruct: deterministicReconstruct
};
