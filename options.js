let vocabulary = {};
let settings = { speechVoiceURI: "", speechRate: 0.92 };

const wordList = document.querySelector("#wordList");
const emptyState = document.querySelector("#emptyState");
const searchInput = document.querySelector("#searchInput");
const filterSelect = document.querySelector("#filterSelect");
const sortSelect = document.querySelector("#sortSelect");

initialize();

async function initialize() {
  const stored = await chrome.storage.local.get(["vocabulary", "settings"]);
  vocabulary = stored.vocabulary || {};
  settings = { ...settings, ...(stored.settings || {}) };
  bindEvents();
  render();
}

function bindEvents() {
  searchInput.addEventListener("input", render);
  filterSelect.addEventListener("change", render);
  sortSelect.addEventListener("change", render);
  document.querySelector("#addForm").addEventListener("submit", addManualEntry);
  document.querySelector("#exportButton").addEventListener("click", exportVocabulary);
  document.querySelector("#importButton").addEventListener("click", () => {
    document.querySelector("#importFile").click();
  });
  document.querySelector("#importFile").addEventListener("change", importVocabulary);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.vocabulary) {
      vocabulary = changes.vocabulary.newValue || {};
      render();
    }
    if (changes.settings) settings = { ...settings, ...(changes.settings.newValue || {}) };
  });
}

function render() {
  renderSummary();
  const entries = getVisibleEntries();
  wordList.replaceChildren(...entries.map(createWordCard));
  emptyState.hidden = entries.length > 0;
}

function renderSummary() {
  const entries = Object.values(vocabulary);
  const known = entries.reduce((sum, entry) => sum + (entry.review?.known || 0), 0);
  const unknown = entries.reduce((sum, entry) => sum + (entry.review?.unknown || 0), 0);
  const difficult = entries.filter(isDifficult).length;

  document.querySelector("#totalWords").textContent = entries.length;
  document.querySelector("#totalKnown").textContent = known;
  document.querySelector("#totalUnknown").textContent = unknown;
  document.querySelector("#difficultWords").textContent = difficult;
}

function getVisibleEntries() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const filter = filterSelect.value;
  const sort = sortSelect.value;

  return Object.values(vocabulary)
    .filter((entry) => {
      const haystack = [
        entry.word,
        entry.meaning,
        ...(entry.contexts || []).map((context) => context.sentence)
      ].join(" ").toLocaleLowerCase();
      if (query && !haystack.includes(query)) return false;
      if (filter === "difficult" && !isDifficult(entry)) return false;
      if (filter === "never-reviewed" && getReviewTotal(entry) !== 0) return false;
      if (filter === "last-unknown" && entry.review?.lastResult !== "unknown") return false;
      return true;
    })
    .sort((a, b) => {
      if (sort === "alpha") return a.word.localeCompare(b.word, "en");
      if (sort === "difficult") return difficultyScore(b) - difficultyScore(a);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
}

function createWordCard(entry) {
  const card = document.createElement("article");
  card.className = "word-card";
  if (isDifficult(entry)) card.classList.add("is-difficult");

  const top = document.createElement("div");
  top.className = "word-card-top";
  const titleArea = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = entry.word;
  const meta = document.createElement("div");
  meta.className = "word-meta";
  meta.textContent = formatMeta(entry);
  titleArea.append(title, meta);

  const score = document.createElement("div");
  score.className = "review-score";
  score.innerHTML = `<span class="known">✓ ${entry.review?.known || 0}</span><span class="unknown">× ${entry.review?.unknown || 0}</span>`;
  top.append(titleArea, score);

  const meaningLabel = document.createElement("label");
  meaningLabel.className = "edit-field";
  meaningLabel.textContent = "中文释义";
  const meaningInput = document.createElement("textarea");
  meaningInput.rows = 2;
  meaningInput.value = entry.meaning || "";
  meaningInput.maxLength = 500;
  meaningLabel.append(meaningInput);

  const contexts = document.createElement("div");
  contexts.className = "contexts";
  for (const context of (entry.contexts || []).slice(0, 3)) {
    const block = document.createElement("blockquote");
    block.textContent = context.sentence;
    if (isHttpUrl(context.url)) {
      const link = document.createElement("a");
      link.href = context.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = context.title || new URL(context.url).hostname;
      block.append(document.createElement("br"), link);
    }
    contexts.append(block);
  }
  if (!contexts.childElementCount) {
    const noContext = document.createElement("p");
    noContext.className = "no-context";
    noContext.textContent = "没有保存例句";
    contexts.append(noContext);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.append(
    createButton("保存释义", "primary", async () => {
      const meaning = meaningInput.value.trim();
      if (!meaning) return showToast("释义不能为空");
      vocabulary[entry.normalized].meaning = meaning;
      vocabulary[entry.normalized].updatedAt = Date.now();
      await persist("释义已更新");
    }),
    createButton("朗读", "secondary", () => speak(entry.word)),
    createButton("清空统计", "secondary", async () => {
      vocabulary[entry.normalized].review = {
        known: 0,
        unknown: 0,
        lastResult: null,
        lastReviewedAt: null
      };
      await persist("复习统计已清空");
    }),
    createButton("删除", "danger", async () => {
      if (!confirm(`确定从单词本删除“${entry.word}”吗？`)) return;
      delete vocabulary[entry.normalized];
      await persist("单词已删除");
    })
  );

  card.append(top, meaningLabel, contexts, actions);
  return card;
}

function createButton(label, variant, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${variant}`;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function addManualEntry(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const word = sanitizeWord(data.get("word"));
  const meaning = String(data.get("meaning") || "").trim();
  const sentence = String(data.get("sentence") || "").trim();
  if (!word || !meaning) return;

  const key = normalizeWord(word);
  const existing = vocabulary[key] || {};
  vocabulary[key] = {
    word: existing.word || word,
    normalized: key,
    meaning,
    definitions: existing.definitions || [],
    contexts: sentence
      ? [{ sentence, url: "", title: "手动添加", savedAt: Date.now() }, ...(existing.contexts || [])].slice(0, 5)
      : (existing.contexts || []),
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
    review: existing.review || { known: 0, unknown: 0, lastResult: null, lastReviewedAt: null }
  };
  form.reset();
  await persist(existing.word ? "单词已更新" : "单词已添加");
}

function exportVocabulary() {
  const payload = {
    format: "vocab-lens-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    vocabulary
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vocab-lens-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("备份已导出");
}

async function importVocabulary(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  try {
    const parsed = JSON.parse(await file.text());
    const source = parsed?.vocabulary || parsed;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("文件中没有有效的单词本");
    }

    const imported = {};
    for (const candidate of Object.values(source)) {
      const entry = sanitizeImportedEntry(candidate);
      if (entry) imported[entry.normalized] = entry;
    }
    if (!Object.keys(imported).length) throw new Error("没有找到可导入的单词");
    vocabulary = { ...vocabulary, ...imported };
    await persist(`已导入 ${Object.keys(imported).length} 个单词`);
  } catch (error) {
    showToast(error.message || "导入失败", true);
  }
}

function sanitizeImportedEntry(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const word = sanitizeWord(candidate.word);
  const meaning = String(candidate.meaning || "").trim().slice(0, 500);
  if (!word || !meaning) return null;
  const normalized = normalizeWord(word);
  return {
    word,
    normalized,
    meaning,
    definitions: sanitizeDefinitions(candidate.definitions),
    contexts: Array.isArray(candidate.contexts)
      ? candidate.contexts.slice(0, 5).map((context) => ({
          sentence: String(context?.sentence || "").slice(0, 500),
          url: isHttpUrl(context?.url) ? context.url : "",
          title: String(context?.title || "").slice(0, 200),
          savedAt: Number(context?.savedAt) || Date.now()
        }))
      : [],
    createdAt: Number(candidate.createdAt) || Date.now(),
    updatedAt: Number(candidate.updatedAt) || Date.now(),
    review: {
      known: safeCount(candidate.review?.known),
      unknown: safeCount(candidate.review?.unknown),
      lastResult: ["known", "unknown"].includes(candidate.review?.lastResult) ? candidate.review.lastResult : null,
      lastReviewedAt: Number(candidate.review?.lastReviewedAt) || null
    }
  };
}

function sanitizeDefinitions(definitions) {
  if (!Array.isArray(definitions)) return [];
  return definitions.map((definition) => ({
    partOfSpeech: String(definition?.partOfSpeech || "释义").trim().slice(0, 40),
    meanings: Array.isArray(definition?.meanings)
      ? [...new Set(definition.meanings.map((meaning) => String(meaning || "").trim().slice(0, 100)).filter(Boolean))]
      : []
  })).filter((definition) => definition.meanings.length);
}

async function persist(message) {
  await chrome.storage.local.set({ vocabulary });
  render();
  showToast(message);
}

function showToast(message, isError = false) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 1800);
}

function sanitizeWord(word) {
  return String(word || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .trim()
    .slice(0, 100);
}

function normalizeWord(word) {
  return sanitizeWord(word).toLocaleLowerCase("en-US");
}

function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function getReviewTotal(entry) {
  return (entry.review?.known || 0) + (entry.review?.unknown || 0);
}

function difficultyScore(entry) {
  const known = entry.review?.known || 0;
  const unknown = entry.review?.unknown || 0;
  if (!unknown) return 0;
  return (unknown / Math.max(1, known + unknown)) * 100 + Math.min(unknown, 20);
}

function isDifficult(entry) {
  const known = entry.review?.known || 0;
  const unknown = entry.review?.unknown || 0;
  return unknown > 0 && unknown >= known;
}

function formatMeta(entry) {
  const date = entry.createdAt ? new Date(entry.createdAt).toLocaleDateString("zh-CN") : "未知日期";
  const count = entry.contexts?.length || 0;
  return `${date} 收录 · ${count} 条例句`;
}

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

async function speak(word) {
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = "en-US";
  utterance.rate = Number(settings.speechRate) || 0.92;
  const voices = await getSpeechVoices();
  const selected = voices.find((voice) => voice.voiceURI === settings.speechVoiceURI);
  const englishVoices = voices.filter((voice) => /^en(?:-|_)/i.test(voice.lang));
  const voice = selected || englishVoices.sort((a, b) => voiceQualityScore(b) - voiceQualityScore(a))[0];
  if (voice) utterance.voice = voice;
  speechSynthesis.speak(utterance);
}

async function getSpeechVoices() {
  const immediate = speechSynthesis.getVoices();
  if (immediate.length) return immediate;
  return new Promise((resolve) => {
    const finish = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
    setTimeout(finish, 800);
  });
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
