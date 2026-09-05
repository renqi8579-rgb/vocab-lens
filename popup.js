const DEFAULT_SETTINGS = {
  enabled: true,
  collectButtonEnabled: true,
  highlightEnabled: true,
  targetLanguage: "zh-CN",
  speechVoiceURI: "",
  speechRate: 0.92
};

const enabledInput = document.querySelector("#enabled");
const highlightInput = document.querySelector("#highlightEnabled");
const collectInput = document.querySelector("#collectButtonEnabled");
const voiceSelect = document.querySelector("#speechVoice");

initialize();

async function initialize() {
  const stored = await chrome.storage.local.get(["settings", "vocabulary"]);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  const vocabulary = stored.vocabulary || {};

  enabledInput.checked = settings.enabled;
  highlightInput.checked = settings.highlightEnabled;
  collectInput.checked = settings.collectButtonEnabled;
  await populateEnglishVoices(settings.speechVoiceURI);
  renderStatus(settings.enabled);
  renderStats(vocabulary);

  enabledInput.addEventListener("change", saveSettings);
  highlightInput.addEventListener("change", saveSettings);
  collectInput.addEventListener("change", saveSettings);
  voiceSelect.addEventListener("change", saveSettings);
  document.querySelector("#previewVoice").addEventListener("click", previewVoice);
  document.querySelector("#openWordbook").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

async function saveSettings() {
  const stored = await chrome.storage.local.get("settings");
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored.settings || {}),
    enabled: enabledInput.checked,
    highlightEnabled: highlightInput.checked,
    collectButtonEnabled: collectInput.checked,
    speechVoiceURI: voiceSelect.value
  };
  await chrome.storage.local.set({ settings });
  renderStatus(settings.enabled);
}

function renderStatus(enabled) {
  const status = document.querySelector("#status");
  status.textContent = enabled ? "已开启 · 正在标记你的生词" : "已暂停 · 页面内容不会被修改";
  status.classList.toggle("disabled", !enabled);
}

function renderStats(vocabulary) {
  const entries = Object.values(vocabulary);
  const unknownCount = entries.reduce((sum, entry) => sum + (entry.review?.unknown || 0), 0);
  const difficultCount = entries.filter((entry) => {
    if (entry.masteredAt) return false;
    const known = entry.review?.known || 0;
    const unknown = entry.review?.unknown || 0;
    return unknown > 0 && unknown >= known;
  }).length;

  document.querySelector("#wordCount").textContent = entries.length;
  document.querySelector("#unknownCount").textContent = unknownCount;
  document.querySelector("#difficultCount").textContent = difficultCount;
}

async function populateEnglishVoices(selectedURI) {
  const voices = await getSpeechVoices();
  const englishVoices = voices
    .filter((voice) => /^en(?:-|_)/i.test(voice.lang))
    .sort((a, b) => voiceQualityScore(b) - voiceQualityScore(a) || a.name.localeCompare(b.name));

  for (const voice of englishVoices) {
    const option = document.createElement("option");
    option.value = voice.voiceURI;
    option.textContent = `${voice.name} · ${voice.lang}`;
    voiceSelect.append(option);
  }
  voiceSelect.value = englishVoices.some((voice) => voice.voiceURI === selectedURI) ? selectedURI : "";
}

async function previewVoice() {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const voices = await getSpeechVoices();
  const utterance = new SpeechSynthesisUtterance("This voice will read your vocabulary words.");
  utterance.lang = "en-US";
  utterance.rate = 0.92;
  const voice = chooseEnglishVoice(voices, voiceSelect.value);
  if (voice) utterance.voice = voice;
  speechSynthesis.speak(utterance);
}

async function getSpeechVoices() {
  if (!("speechSynthesis" in window)) return [];
  const immediate = speechSynthesis.getVoices();
  if (immediate.length) return immediate;
  return new Promise((resolve) => {
    const finish = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
    setTimeout(finish, 800);
  });
}

function chooseEnglishVoice(voices, selectedURI) {
  if (selectedURI) {
    const selected = voices.find((voice) => voice.voiceURI === selectedURI);
    if (selected) return selected;
  }
  return voices
    .filter((voice) => /^en(?:-|_)/i.test(voice.lang))
    .sort((a, b) => voiceQualityScore(b) - voiceQualityScore(a))[0] || null;
}

function voiceQualityScore(voice) {
  const name = voice.name.toLocaleLowerCase();
  let score = voice.lang.toLocaleLowerCase() === "en-us" ? 20 : 0;
  if (/natural|enhanced|premium|neural/.test(name)) score += 80;
  if (/samantha|ava|aria|jenny|google us english/.test(name)) score += 55;
  if (/alex|daniel|karen/.test(name)) score += 30;
  if (voice.localService) score += 5;
  return score;
}
