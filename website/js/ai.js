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
    var code = (err && err.code) ? String(err.code) : '';
    var message = (err && err.message) ? String(err.message) : 'AI request failed.';

    if (err && err.details && typeof err.details.message === 'string') {
      // Custom message from our backend — use it directly.
      message = err.details.message;
    } else if (code === 'functions/not-found' || message === 'not-found') {
      message = 'AI functions are not deployed yet. Follow the Firebase Functions setup in SETUP.md.';
    } else if (code === 'functions/failed-precondition' || message === 'failed-precondition') {
      message = 'AI secret not configured on the server. Run: firebase functions:secrets:set AI_PROXY_SECRET';
    } else if (code === 'functions/unauthenticated' || message === 'unauthenticated') {
      message = 'Sign in required to use AI features.';
    } else if (code === 'functions/permission-denied' || message === 'permission-denied') {
      message = 'Permission denied. Check Firestore security rules.';
    } else if (code === 'functions/internal' || message.toLowerCase() === 'internal') {
      message = 'AI service error. Make sure Firebase Functions are deployed and AI_PROXY_SECRET is set in Secret Manager.';
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
