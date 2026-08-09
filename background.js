const DEFAULT_SETTINGS = {
  enabled: true,
  collectButtonEnabled: true,
  highlightEnabled: true,
  targetLanguage: "zh-CN",
  speechVoiceURI: "",
  speechRate: 0.92
};

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

  const params = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: targetLanguage,
    dt: "t",
    q: cleanText
  });
  params.append("dt", "bd");
  const response = await fetch(
    `https://translate.googleapis.com/translate_a/single?${params.toString()}`
  );

  if (!response.ok) {
    throw new Error(`翻译服务暂时不可用（${response.status}）`);
  }

  const data = await response.json();
  const meaning = Array.isArray(data?.[0])
    ? data[0].map((part) => part?.[0] || "").join("").trim()
    : "";
  const definitions = Array.isArray(data?.[1])
    ? data[1].map((section) => ({
        partOfSpeech: String(section?.[0] || "释义").trim(),
        meanings: Array.isArray(section?.[1])
          ? [...new Set(section[1].map((item) => String(item || "").trim()).filter(Boolean))]
          : []
      })).filter((section) => section.meanings.length)
    : [];

  if (!meaning) throw new Error("翻译服务没有返回释义");
  return { meaning, definitions };
}
