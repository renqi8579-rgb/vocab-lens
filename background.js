const DEFAULT_SETTINGS = {
  enabled: true,
  collectButtonEnabled: true,
  highlightEnabled: true,
  targetLanguage: "zh-CN",
  speechVoiceURI: "",
  speechRate: 0.92
};

const TRANSLATION_API_URL = "https://api.mymemory.translated.net/get";
const TRANSLATION_CACHE_KEY = "translationCache";
const TRANSLATION_CACHE_VERSION = "mymemory-v1";
const TRANSLATION_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const TRANSLATION_CACHE_LIMIT = 300;
const TRANSLATION_TIMEOUT = 12000;
const pendingTranslations = new Map();
let cacheWriteQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["settings", "vocabulary"]);
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    vocabulary: stored.vocabulary || {}
  });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "vocab-lens-collect",
      title: "翻译并加入 Vocab Lens",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "vocab-lens-collect" || !tab?.id) return;

  chrome.tabs.sendMessage(tab.id, {
    type: "VOCAB_LENS_COLLECT_SELECTION",
    selectionText: info.selectionText || ""
  }).catch(() => {
    // chrome://、扩展商店等页面不允许内容脚本运行。
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "VOCAB_LENS_TRANSLATE") return false;

  translateText(message.text, message.targetLanguage || "zh-CN")
    .then((translation) => sendResponse({ ok: true, ...translation }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function translateText(text, targetLanguage) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("没有可翻译的内容");

  const target = normalizeTargetLanguage(targetLanguage);
  const cacheKey = `${TRANSLATION_CACHE_VERSION}:${target}:${cleanText.toLocaleLowerCase()}`;
  if (pendingTranslations.has(cacheKey)) return pendingTranslations.get(cacheKey);

  const request = translateWithCache(cleanText, target, cacheKey)
    .finally(() => pendingTranslations.delete(cacheKey));
  pendingTranslations.set(cacheKey, request);
  return request;
}

async function translateWithCache(text, targetLanguage, cacheKey) {
  const cached = await readCachedTranslation(cacheKey).catch(() => null);
  if (cached) return cached;

  const translation = await requestTranslation(text, targetLanguage);
  await cacheTranslation(cacheKey, translation).catch(() => {});
  return translation;
}

async function requestTranslation(text, targetLanguage) {
  if (new TextEncoder().encode(text).length > 500) {
    throw new Error("翻译内容过长，请缩短到 500 字节以内");
  }

  const params = new URLSearchParams({
    q: text,
    langpair: `en|${targetLanguage}`,
    mt: "1"
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT);
  let response;
  try {
    response = await fetch(`${TRANSLATION_API_URL}?${params.toString()}`, {
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("翻译服务响应超时，请稍后重试");
    throw new Error("无法连接翻译服务，请检查网络后重试");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    if (response.status === 429) throw new Error("翻译请求过于频繁，请稍后重试（429）");
    throw new Error(`翻译服务暂时不可用（${response.status}）`);
  }

  let data;
  try {
    data = await response.json();
  } catch (_error) {
    throw new Error("翻译服务返回了无法识别的内容");
  }

  const responseStatus = Number(data?.responseStatus || 0);
  if (data?.quotaFinished || responseStatus === 429) {
    throw new Error("翻译服务今日额度已用完，请稍后再试（429）");
  }
  if (responseStatus && responseStatus !== 200) {
    const details = String(data?.responseDetails || "").trim();
    throw new Error(details || `翻译服务暂时不可用（${responseStatus}）`);
  }

  const meaning = decodeHtmlEntities(data?.responseData?.translatedText).trim();
  const alternatives = Array.isArray(data?.matches)
    ? [...new Set(data.matches
        .filter((match) => Number(match?.match || 0) >= 0.8)
        .map((match) => decodeHtmlEntities(match?.translation).trim())
        .filter((candidate) => candidate && candidate !== meaning && candidate.length <= 120))]
        .slice(0, 6)
    : [];
  const definitions = alternatives.length
    ? [{ partOfSpeech: "相关译法", meanings: alternatives }]
    : [];

  if (!meaning) throw new Error("翻译服务没有返回释义");
  return { meaning, definitions };
}

function normalizeTargetLanguage(targetLanguage) {
  const language = String(targetLanguage || "zh-CN").trim();
  return language.toLowerCase() === "zh-cn" ? "zh-CN" : language;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function readCachedTranslation(cacheKey) {
  const stored = await chrome.storage.local.get(TRANSLATION_CACHE_KEY);
  const entry = stored[TRANSLATION_CACHE_KEY]?.[cacheKey];
  if (!entry || Date.now() - Number(entry.cachedAt || 0) > TRANSLATION_CACHE_TTL) {
    return null;
  }

  return {
    meaning: String(entry.meaning || ""),
    definitions: Array.isArray(entry.definitions) ? entry.definitions : []
  };
}

function cacheTranslation(cacheKey, translation) {
  cacheWriteQueue = cacheWriteQueue.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get(TRANSLATION_CACHE_KEY);
    const cache = stored[TRANSLATION_CACHE_KEY] || {};
    cache[cacheKey] = { ...translation, cachedAt: Date.now() };

    const entries = Object.entries(cache)
      .sort(([, a], [, b]) => Number(b?.cachedAt || 0) - Number(a?.cachedAt || 0))
      .slice(0, TRANSLATION_CACHE_LIMIT);
    await chrome.storage.local.set({ [TRANSLATION_CACHE_KEY]: Object.fromEntries(entries) });
  });
  return cacheWriteQueue;
}
