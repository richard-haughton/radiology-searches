// ai.js - client bridge to secure Firebase Functions AI proxy.

var _aiClientUid = null;

function initAiClient(uid) {
  _aiClientUid = uid;
}

function getAiClientUid() {
  return _aiClientUid;
}

async function callAiFunction(functionName, payload) {
  if (!appFunctions || typeof appFunctions.httpsCallable !== 'function') {
    throw new Error('Functions SDK is not initialized.');
  }
  if (!appAuth.currentUser) {
    throw new Error('Please sign in before using AI features.');
  }

  try {
    var callable = appFunctions.httpsCallable(functionName);
    var response = await callable(payload || {});
    return response && response.data ? response.data : {};
  } catch (err) {
    var message = (err && err.message) || 'AI request failed.';
    if (err && err.details && typeof err.details.message === 'string') {
      message = err.details.message;
    }
    throw new Error(message);
  }
}

function saveAiProviderKey(provider, apiKey, defaultModel) {
  return callAiFunction('saveAiProviderKey', {
    provider: provider,
    apiKey: apiKey,
    defaultModel: defaultModel || ''
  });
}

function removeAiProviderKey(provider) {
  return callAiFunction('removeAiProviderKey', {
    provider: provider
  });
}

function getAiProviderStatus() {
  return callAiFunction('getAiProviderStatus', {});
}

function testAiProvider(provider, model) {
  return callAiFunction('testAiProvider', {
    provider: provider,
    model: model || ''
  });
}

function generatePatternFromAi(options) {
  return callAiFunction('generatePatternFromAi', options || {});
}

function modifyStepWithAi(options) {
  return callAiFunction('modifyStepWithAi', options || {});
}
