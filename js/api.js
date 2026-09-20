// ==========================================
// API CLIENT & ERROR CLASSIFICATION
// ==========================================

export function classifyAntigravityError(errObj, statusCode) {
  const status = statusCode || errObj?.status || 500;
  const rawMsg = typeof errObj === 'string' 
    ? errObj 
    : (errObj?.message || errObj?.error || `HTTP ${status}`);
  
  console.log('Antigravity raw error message:', rawMsg);

  const lowerMsg = rawMsg.toLowerCase();
  const isDaily = lowerMsg.includes('per day') || lowerMsg.includes('daily') || lowerMsg.includes('requests per day');

  let type = errObj?.type || 'unknown_error';
  if (isDaily) {
    type = 'daily_quota_exhausted';
  } else if (status === 429 || lowerMsg.includes('quota') || lowerMsg.includes('rate limit')) {
    type = 'quota_exceeded';
  } else if (status === 401 || status === 403 || lowerMsg.includes('key') || lowerMsg.includes('unauthorized')) {
    type = 'auth_failed';
  } else if (status === 404) {
    type = 'agent_unavailable';
  }

  let userMessage = rawMsg;
  if (type === 'daily_quota_exhausted') {
    userMessage = "Daily call limit reached — this won't auto-retry. Try again after your quota resets.";
  } else if (type === 'quota_exceeded') {
    userMessage = 'Antigravity model is not available: Quota exceeded (HTTP 429). Check your Google AI Studio limits or billing.';
  } else if (type === 'auth_failed') {
    userMessage = 'Antigravity model is not available: API key invalid or unauthorized for Antigravity API.';
  } else if (type === 'agent_unavailable') {
    userMessage = 'Antigravity model is not available: Model or remote endpoint not found (HTTP 404).';
  } else if (!rawMsg.includes('Antigravity model is not available')) {
    userMessage = `Antigravity model is not available: ${rawMsg}`;
  }

  return {
    type,
    status,
    message: userMessage,
    rawMessage: rawMsg
  };
}
