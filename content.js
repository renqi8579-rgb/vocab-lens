(() => {
  const UI_ROOT_CLASS = "vocab-lens-ui";
  const HIGHLIGHT_CLASS = "vocab-lens-highlight";
  const DEFAULT_SETTINGS = {
    enabled: true,
    collectButtonEnabled: true,
    highlightEnabled: true,
    targetLanguage: "zh-CN",
    speechVoiceURI: "",
    speechRate: 0.92
  };

  const state = {
    settings: DEFAULT_SETTINGS,
    vocabulary: {},
    selection: null,
    collectButton: null,
    collector: null,
    reviewCard: null,
    reviewAnchor: null,
    reviewPointer: { x: -1, y: -1 },
    closeReviewTimer: null,
    mutationTimer: null,
    observer: null,
    highlightSignature: "",
    pendingHighlightRefresh: false,
    speechRequestId: 0,
    speakingButton: null
  };

  initialize();

  async function initialize() {
    const stored = await chrome.storage.local.get(["settings", "vocabulary"]);
    state.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    state.vocabulary = stored.vocabulary || {};
    state.highlightSignature = getHighlightSignature(state.vocabulary);

    bindEvents();
    if (state.settings.enabled && state.settings.highlightEnabled) {
      applyHighlights();
    }
    startObserver();
  }

  function bindEvents() {
    document.addEventListener("mouseup", handleSelection, true);
    document.addEventListener("keyup", (event) => {
      if (event.key === "Shift" || event.key.startsWith("Arrow")) {
        handleSelection(event);
      }
    }, true);
    document.addEventListener("pointerover", handleHighlightEnter, true);
    document.addEventListener("pointerout", handleHighlightLeave, true);
    document.addEventListener("pointermove", trackReviewPointer, true);
    document.addEventListener("mousedown", handleOutsideClick, true);

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "VOCAB_LENS_COLLECT_SELECTION") return;

      const selected = readSelection();
      const text = selected?.text || sanitizeSelection(message.selectionText);
      if (!text) return;
      openCollector({
        text,
        sentence: selected?.sentence || "",
        rect: selected?.rect || centerRect()
      });
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      let shouldRefreshHighlights = false;
      if (changes.settings) {
        state.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
        shouldRefreshHighlights = true;
        if (!state.settings.enabled) {
          removeCollectButton();
          closeCollector();
          closeReviewCard();
        }
      }
      if (changes.vocabulary) {
        state.vocabulary = changes.vocabulary.newValue || {};
        const nextSignature = getHighlightSignature(state.vocabulary);
        shouldRefreshHighlights ||= nextSignature !== state.highlightSignature;
        state.highlightSignature = nextSignature;
      }

      if (shouldRefreshHighlights) {
        applyHighlights();
      }
    });
  }

  function handleSelection(event) {
    if (!state.settings.enabled || !state.settings.collectButtonEnabled) return;
    if (event.target?.closest?.(`.${UI_ROOT_CLASS}, .${HIGHLIGHT_CLASS}`)) return;

    window.setTimeout(() => {
      const selected = readSelection();
      if (!selected || !looksLikeEnglish(selected.text)) {
        removeCollectButton();
        return;
      }

      state.selection = selected;
      showCollectButton(selected.rect);
    }, 20);
  }

  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

    const text = sanitizeSelection(selection.toString());
    if (!text || text.length > 100) return null;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;

    return {
      text,
      sentence: extractSentence(range, text),
      rect
    };
  }

  function sanitizeSelection(text) {
    return String(text || "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s+/g, " ")
      .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
      .trim();
  }

  function looksLikeEnglish(text) {
    return /^[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,5}$/.test(text);
  }

  function extractSentence(range, selectedText) {
    const selectedLower = selectedText.toLocaleLowerCase();
    const candidates = [];
    const startNode = range.startContainer;
    const startText = startNode.nodeType === Node.TEXT_NODE ? startNode.nodeValue : "";
    addCandidate(startText);

    let element = startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode;
    for (let depth = 0; element && element !== document.body && depth < 7; depth += 1) {
      const renderedText = String(element.innerText || element.textContent || "");
      for (const line of renderedText.split(/\n+/)) addCandidate(line);
      if (renderedText.length > 1200) break;
      element = element.parentElement;
    }

    const raw = (candidates.sort((a, b) => a.length - b.length)[0] || selectedText).slice(0, 700);

    if (!raw) return "";
    const lowerRaw = raw.toLocaleLowerCase();
    const index = lowerRaw.indexOf(selectedLower);
    if (index < 0) return raw.slice(0, 320);

    const sentenceStart = Math.max(
      raw.lastIndexOf(".", index - 1),
      raw.lastIndexOf("!", index - 1),
      raw.lastIndexOf("?", index - 1),
      raw.lastIndexOf("。", index - 1),
      raw.lastIndexOf("！", index - 1),
      raw.lastIndexOf("？", index - 1)
    );
    const following = raw.slice(index + selectedText.length).search(/[.!?。！？]/);
    const sentenceEnd = following < 0
      ? Math.min(raw.length, index + selectedText.length + 220)
      : index + selectedText.length + following + 1;

    return raw.slice(sentenceStart + 1, sentenceEnd).trim().slice(0, 400);

    function addCandidate(value) {
      const clean = String(value || "").replace(/\s+/g, " ").trim();
      if (!clean || !clean.toLocaleLowerCase().includes(selectedLower)) return;
      if (clean.length < selectedText.length + 8 || clean.length > 700) return;
      if (!candidates.includes(clean)) candidates.push(clean);
    }
  }

  function showCollectButton(rect) {
    removeCollectButton();
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${UI_ROOT_CLASS} vocab-lens-collect-button`;
    button.textContent = "+ 译";
    button.title = "翻译并加入单词本";
    document.documentElement.appendChild(button);
    state.collectButton = button;

    positionFloatingElement(button, rect, 8);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const selection = state.selection;
      removeCollectButton();
      if (selection) openCollector(selection);
    });
  }

  function removeCollectButton() {
    state.collectButton?.remove();
    state.collectButton = null;
  }

  function openCollector({ text, sentence, rect }) {
    closeCollector();
    closeReviewCard();

    const card = document.createElement("section");
    card.className = `${UI_ROOT_CLASS} vocab-lens-collector`;
    card.innerHTML = `
      <div class="vocab-lens-collector-head">
        <strong class="vocab-lens-collector-word"></strong>
        <button type="button" class="vocab-lens-icon-button" data-action="close" aria-label="关闭">×</button>
      </div>
      <label class="vocab-lens-field">
        <span>中文释义</span>
        <textarea rows="2" data-field="meaning" placeholder="正在翻译…"></textarea>
      </label>
      <div class="vocab-lens-source-sentence" data-field="sentence"></div>
      <div class="vocab-lens-collector-status" role="status">正在翻译…</div>
      <div class="vocab-lens-collector-actions">
        <button type="button" class="vocab-lens-secondary-button" data-action="retry">重新翻译</button>
        <button type="button" class="vocab-lens-primary-button" data-action="save" disabled>保存到单词本</button>
      </div>
    `;

    card.querySelector(".vocab-lens-collector-word").textContent = text;
    const meaningInput = card.querySelector('[data-field="meaning"]');
    const sentenceElement = card.querySelector('[data-field="sentence"]');
    const statusElement = card.querySelector(".vocab-lens-collector-status");
    const saveButton = card.querySelector('[data-action="save"]');
    let translatedDefinitions = [];
    sentenceElement.textContent = sentence ? `例句：${sentence}` : "未能自动提取例句";
    document.documentElement.appendChild(card);
    state.collector = card;
    positionFloatingElement(card, rect, 12);

    meaningInput.addEventListener("input", () => {
      saveButton.disabled = !meaningInput.value.trim();
    });
    card.querySelector('[data-action="close"]').addEventListener("click", closeCollector);
    card.querySelector('[data-action="retry"]').addEventListener("click", runTranslation);
    saveButton.addEventListener("click", async () => {
      const meaning = meaningInput.value.trim();
      if (!meaning) return;
      await saveVocabularyEntry(text, meaning, sentence, translatedDefinitions);
      statusElement.textContent = "已保存，之后遇到它会自动高亮";
      saveButton.textContent = "已保存";
      saveButton.disabled = true;
      window.setTimeout(closeCollector, 900);
    });

    runTranslation();

    async function runTranslation() {
      statusElement.textContent = "正在翻译…";
      meaningInput.placeholder = "正在翻译…";
      saveButton.disabled = true;

      try {
        const result = await chrome.runtime.sendMessage({
          type: "VOCAB_LENS_TRANSLATE",
          text,
          targetLanguage: state.settings.targetLanguage
        });
        if (!result?.ok) throw new Error(result?.error || "翻译失败");
        meaningInput.value = result.meaning;
        translatedDefinitions = Array.isArray(result.definitions) ? result.definitions : [];
        meaningInput.placeholder = "填写中文释义";
        statusElement.textContent = "可修改释义后保存";
        saveButton.disabled = false;
      } catch (error) {
        meaningInput.value = "";
        meaningInput.placeholder = "自动翻译失败，请手动填写释义";
        statusElement.textContent = error.message || "自动翻译失败";
        meaningInput.focus();
      }
    }
  }

  async function saveVocabularyEntry(word, meaning, sentence, definitions = []) {
    const key = normalizeWord(word);
    const stored = await chrome.storage.local.get("vocabulary");
    const vocabulary = stored.vocabulary || {};
    const existing = vocabulary[key] || {};
    const context = {
      sentence: sentence || "",
      url: location.href,
      title: document.title,
      savedAt: Date.now()
    };
    const oldContexts = Array.isArray(existing.contexts) ? existing.contexts : [];
    const contexts = context.sentence
      ? [context, ...oldContexts.filter((item) => item.sentence !== context.sentence)].slice(0, 5)
      : oldContexts;

    vocabulary[key] = {
      word: existing.word || word,
      normalized: key,
      meaning,
      definitions: definitions.length ? definitions : (existing.definitions || []),
      contexts,
      createdAt: existing.createdAt || Date.now(),
      updatedAt: Date.now(),
      review: {
        known: existing.review?.known || 0,
        unknown: existing.review?.unknown || 0,
        lastResult: existing.review?.lastResult || null,
        lastReviewedAt: existing.review?.lastReviewedAt || null
      }
    };

    await chrome.storage.local.set({ vocabulary });
  }

  function closeCollector() {
    state.collector?.remove();
    state.collector = null;
  }

  function startObserver() {
    if (!document.body) return;
    state.observer = new MutationObserver((mutations) => {
      if (!state.settings.enabled || !state.settings.highlightEnabled) return;
      if (mutations.every((mutation) => mutation.target?.closest?.(`.${UI_ROOT_CLASS}`))) return;

      // 动态网页可能持续修改 DOM。复习卡片打开时如果立即重新包裹文本，
      // clearHighlights() 会销毁卡片，表现为鼠标停留时弹窗自行消失。
      if (state.reviewCard) {
        state.pendingHighlightRefresh = true;
        return;
      }

      window.clearTimeout(state.mutationTimer);
      state.mutationTimer = window.setTimeout(applyHighlights, 500);
    });
    observePage();
  }

  function observePage() {
    state.observer?.observe(document.body, { childList: true, subtree: true });
  }

  function applyHighlights() {
    if (!document.body) return;
    state.pendingHighlightRefresh = false;
    state.observer?.disconnect();
    clearHighlights();

    if (!state.settings.enabled || !state.settings.highlightEnabled) {
      observePage();
      return;
    }

    const entries = Object.values(state.vocabulary)
      .filter((entry) => entry?.normalized && entry?.meaning)
      .sort((a, b) => b.normalized.length - a.normalized.length)
      .slice(0, 800);
    if (!entries.length) {
      observePage();
      return;
    }

    const entryByKey = new Map(entries.map((entry) => [entry.normalized, entry]));
    const pattern = entries.map((entry) => escapeRegExp(entry.normalized)).join("|");
    let matcher;
    try {
      matcher = new RegExp(`(?<![A-Za-z])(${pattern})(?![A-Za-z])`, "giu");
    } catch (_error) {
      observePage();
      return;
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest(`.${UI_ROOT_CLASS}, .${HIGHLIGHT_CLASS}`)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest("script, style, noscript, textarea, input, select, option, code, pre, [contenteditable='true']")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
      matcher.lastIndex = 0;
      if (!matcher.test(node.nodeValue)) continue;
      matcher.lastIndex = 0;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      for (const match of node.nodeValue.matchAll(matcher)) {
        const index = match.index;
        if (index > lastIndex) fragment.append(node.nodeValue.slice(lastIndex, index));
        const span = document.createElement("span");
        span.className = HIGHLIGHT_CLASS;
        span.textContent = match[0];
        const key = normalizeWord(match[0]);
        if (entryByKey.has(key)) span.dataset.vocabLensKey = key;
        fragment.append(span);
        lastIndex = index + match[0].length;
      }
      if (lastIndex < node.nodeValue.length) fragment.append(node.nodeValue.slice(lastIndex));
      node.replaceWith(fragment);
    }
    state.observer?.takeRecords();
    observePage();
  }

  function clearHighlights() {
    const parents = new Set();
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((span) => {
      parents.add(span.parentNode);
      span.replaceWith(document.createTextNode(span.textContent || ""));
    });
    parents.forEach((parent) => parent?.normalize?.());
    closeReviewCard();
  }

  function handleHighlightEnter(event) {
    if (event.target?.closest?.(".vocab-lens-review-card")) {
      window.clearTimeout(state.closeReviewTimer);
      return;
    }
    const highlight = event.target?.closest?.(`.${HIGHLIGHT_CLASS}`);
    if (!highlight) return;
    window.clearTimeout(state.closeReviewTimer);
    if (state.reviewAnchor === highlight) return;
    showReviewCard(highlight);
  }

  function handleHighlightLeave(event) {
    const highlight = event.target?.closest?.(`.${HIGHLIGHT_CLASS}`);
    if (!highlight || highlight.contains(event.relatedTarget)) return;
    if (event.relatedTarget?.closest?.(".vocab-lens-review-card")) return;
    scheduleReviewClose();
  }

  function trackReviewPointer(event) {
    state.reviewPointer = { x: event.clientX, y: event.clientY };
    if (state.reviewCard && isPointerInReviewZone()) {
      window.clearTimeout(state.closeReviewTimer);
    }
  }

  function showReviewCard(highlight) {
    closeReviewCard();
    const key = highlight.dataset.vocabLensKey;
    const entry = state.vocabulary[key];
    if (!entry) return;

    const card = document.createElement("section");
    card.className = `${UI_ROOT_CLASS} vocab-lens-review-card`;
    card.innerHTML = `
      <div class="vocab-lens-review-head">
        <strong data-field="word"></strong>
        <button type="button" class="vocab-lens-icon-button" data-action="close" aria-label="关闭">×</button>
      </div>
      <div class="vocab-lens-review-meaning" data-field="meaning" title="把鼠标移到这里查看释义"></div>
      <div class="vocab-lens-full-definitions" data-field="definitions" hidden></div>
      <div class="vocab-lens-review-sentence" data-field="sentence"></div>
      <div class="vocab-lens-review-footer">
        <button type="button" class="vocab-lens-reveal-button" data-action="full-definitions" aria-expanded="false">完整释义</button>
        <div class="vocab-lens-review-actions">
          <button type="button" class="vocab-lens-round-button vocab-lens-speak" data-action="speak" title="朗读" aria-label="朗读单词">
            <span class="vocab-lens-play-icon" aria-hidden="true">▶</span>
            <span class="vocab-lens-playing-icon" aria-hidden="true"><i></i><i></i><i></i></span>
          </button>
          <button type="button" class="vocab-lens-round-button vocab-lens-wrong" data-action="unknown" title="没认出来">×</button>
          <button type="button" class="vocab-lens-round-button vocab-lens-known" data-action="known" title="认出来了">✓</button>
        </div>
      </div>
      <div class="vocab-lens-review-counts" data-field="counts"></div>
    `;
    card.querySelector('[data-field="word"]').textContent = entry.word;
    card.querySelector('[data-field="meaning"]').textContent = entry.meaning;
    const sentenceElement = card.querySelector('[data-field="sentence"]');
    const exampleLines = getExampleLines(entry);
    sentenceElement.replaceChildren(...exampleLines.map((sentence) => {
      const line = document.createElement("div");
      line.className = "vocab-lens-review-sentence-line";
      line.textContent = sentence;
      return line;
    }));
    sentenceElement.hidden = !exampleLines.length;
    updateReviewCounts(card, entry);

    document.documentElement.appendChild(card);
    state.reviewCard = card;
    state.reviewAnchor = highlight;
    positionFloatingElement(card, highlight.getBoundingClientRect(), 4);

    card.addEventListener("pointerenter", () => window.clearTimeout(state.closeReviewTimer));
    card.addEventListener("pointerleave", scheduleReviewClose);
    card.querySelector('[data-action="close"]').addEventListener("click", closeReviewCard);
    card.querySelector('[data-action="full-definitions"]').addEventListener("click", () => {
      toggleFullDefinitions(key, entry, card);
    });
    const speakButton = card.querySelector('[data-action="speak"]');
    speakButton.addEventListener("click", () => speak(entry.word, speakButton));
    card.querySelector('[data-action="known"]').addEventListener("click", () => recordReview(key, "known"));
    card.querySelector('[data-action="unknown"]').addEventListener("click", () => recordReview(key, "unknown"));
  }

  async function recordReview(key, result) {
    const stored = await chrome.storage.local.get("vocabulary");
    const vocabulary = stored.vocabulary || {};
    const entry = vocabulary[key];
    if (!entry) return;

    entry.review = {
      known: (entry.review?.known || 0) + (result === "known" ? 1 : 0),
      unknown: (entry.review?.unknown || 0) + (result === "unknown" ? 1 : 0),
      lastResult: result,
      lastReviewedAt: Date.now()
    };
    await chrome.storage.local.set({ vocabulary });

    if (state.reviewCard) {
      setMeaningRevealed(state.reviewCard, true);
      state.reviewCard.classList.toggle("vocab-lens-result-known", result === "known");
      state.reviewCard.classList.toggle("vocab-lens-result-unknown", result === "unknown");
      updateReviewCounts(state.reviewCard, entry);
    }
  }

  function updateReviewCounts(card, entry) {
    const known = entry.review?.known || 0;
    const unknown = entry.review?.unknown || 0;
    card.querySelector('[data-field="counts"]').textContent = `认出 ${known} 次 · 未认出 ${unknown} 次`;
  }

  function scheduleReviewClose() {
    window.clearTimeout(state.closeReviewTimer);
    state.closeReviewTimer = window.setTimeout(() => {
      if (!isPointerInReviewZone()) closeReviewCard();
    }, 650);
  }

  function isPointerInReviewZone() {
    if (!state.reviewCard || !state.reviewAnchor) return false;
    const anchor = state.reviewAnchor.getBoundingClientRect();
    const card = state.reviewCard.getBoundingClientRect();
    const padding = 10;
    const zone = {
      left: Math.min(anchor.left, card.left) - padding,
      right: Math.max(anchor.right, card.right) + padding,
      top: Math.min(anchor.top, card.top) - padding,
      bottom: Math.max(anchor.bottom, card.bottom) + padding
    };
    return state.reviewPointer.x >= zone.left
      && state.reviewPointer.x <= zone.right
      && state.reviewPointer.y >= zone.top
      && state.reviewPointer.y <= zone.bottom;
  }

  function closeReviewCard() {
    window.clearTimeout(state.closeReviewTimer);
    const shouldRefresh = state.pendingHighlightRefresh;
    if (state.reviewCard?.contains(state.speakingButton)) stopSpeechPlayback();
    state.reviewCard?.remove();
    state.reviewCard = null;
    state.reviewAnchor = null;
    state.pendingHighlightRefresh = false;

    if (shouldRefresh && state.settings.enabled && state.settings.highlightEnabled) {
      window.clearTimeout(state.mutationTimer);
      state.mutationTimer = window.setTimeout(applyHighlights, 80);
    }
  }

  function getExampleLines(entry) {
    const lines = [];
    for (const context of entry.contexts || []) {
      const clean = String(context?.sentence || "").replace(/\s+/g, " ").trim();
      if (!clean) continue;

      let parts = clean.split(/(?<=[.!?。！？])\s+/);
      if (parts.length === 1) {
        const optionParts = clean.split(/\s+(?=To\s+[a-z])/);
        if (optionParts.length > 1) parts = optionParts;
      }
      for (const part of parts) {
        const sentence = part.trim();
        if (!sentence || lines.includes(sentence)) continue;
        lines.push(sentence.length > 180 ? `${sentence.slice(0, 177)}…` : sentence);
        if (lines.length === 2) return lines;
      }
    }
    return lines;
  }

  function setMeaningRevealed(card, revealed) {
    const meaning = card.querySelector('[data-field="meaning"]');
    card.classList.toggle("vocab-lens-is-revealed", revealed);
    if (revealed) {
      meaning.style.setProperty("filter", "blur(0px)", "important");
      meaning.style.setProperty("user-select", "text", "important");
    } else {
      meaning.style.removeProperty("filter");
      meaning.style.removeProperty("user-select");
    }
  }

  async function toggleFullDefinitions(key, entry, card) {
    const panel = card.querySelector('[data-field="definitions"]');
    const button = card.querySelector('[data-action="full-definitions"]');
    if (!panel.hidden) {
      panel.hidden = true;
      button.textContent = "完整释义";
      button.setAttribute("aria-expanded", "false");
      positionFloatingElement(card, state.reviewAnchor.getBoundingClientRect(), 4);
      return;
    }

    let definitions = Array.isArray(entry.definitions) ? entry.definitions : [];
    if (!definitions.length) {
      button.disabled = true;
      button.textContent = "加载中…";
      try {
        const result = await chrome.runtime.sendMessage({
          type: "VOCAB_LENS_TRANSLATE",
          text: entry.word,
          targetLanguage: state.settings.targetLanguage
        });
        if (!result?.ok) throw new Error(result?.error || "完整释义加载失败");
        definitions = Array.isArray(result.definitions) ? result.definitions : [];
        if (definitions.length) {
          entry.definitions = definitions;
          await saveDefinitions(key, definitions);
        }
      } catch (_error) {
        definitions = [];
      } finally {
        button.disabled = false;
      }
    }

    if (!card.isConnected || state.reviewCard !== card || !state.reviewAnchor) return;
    renderFullDefinitions(panel, definitions);
    panel.hidden = false;
    button.textContent = "收起释义";
    button.setAttribute("aria-expanded", "true");
    positionFloatingElement(card, state.reviewAnchor.getBoundingClientRect(), 4);
  }

  function renderFullDefinitions(panel, definitions) {
    if (!definitions.length) {
      const empty = document.createElement("div");
      empty.className = "vocab-lens-definition-empty";
      empty.textContent = "暂未查询到更多词典释义";
      panel.replaceChildren(empty);
      return;
    }

    panel.replaceChildren(...definitions.map((definition) => {
      const row = document.createElement("div");
      row.className = "vocab-lens-definition-row";
      const partOfSpeech = document.createElement("span");
      partOfSpeech.className = "vocab-lens-part-of-speech";
      partOfSpeech.textContent = definition.partOfSpeech || "释义";
      const meanings = document.createElement("div");
      meanings.className = "vocab-lens-definition-meanings";
      meanings.textContent = definition.meanings.join("；");
      row.append(partOfSpeech, meanings);
      return row;
    }));
  }

  async function saveDefinitions(key, definitions) {
    const stored = await chrome.storage.local.get("vocabulary");
    const vocabulary = stored.vocabulary || {};
    if (!vocabulary[key]) return;
    vocabulary[key].definitions = definitions;
    vocabulary[key].updatedAt = Date.now();
    await chrome.storage.local.set({ vocabulary });
  }

  async function speak(word, button) {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
    if (button.classList.contains("vocab-lens-is-speaking")) {
      stopSpeechPlayback();
      return;
    }

    stopSpeechPlayback();
    const requestId = state.speechRequestId;
    state.speakingButton = button;
    button.classList.add("vocab-lens-is-speaking");
    button.title = "正在播放，点击停止";
    button.setAttribute("aria-label", "停止朗读");

    try {
      const voices = await getSpeechVoices();
      if (requestId !== state.speechRequestId) return;
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.lang = "en-US";
      utterance.rate = Number(state.settings.speechRate) || 0.92;
      const voice = chooseEnglishVoice(voices, state.settings.speechVoiceURI);
      if (voice) utterance.voice = voice;
      utterance.onend = () => finishSpeechPlayback(button, requestId);
      utterance.onerror = () => finishSpeechPlayback(button, requestId);
      window.speechSynthesis.speak(utterance);
    } catch (_error) {
      finishSpeechPlayback(button, requestId);
    }
  }

  function stopSpeechPlayback() {
    state.speechRequestId += 1;
    window.speechSynthesis?.cancel?.();
    if (state.speakingButton) {
      state.speakingButton.classList.remove("vocab-lens-is-speaking");
      state.speakingButton.title = "朗读";
      state.speakingButton.setAttribute("aria-label", "朗读单词");
    }
    state.speakingButton = null;
  }

  function finishSpeechPlayback(button, requestId) {
    if (requestId !== state.speechRequestId) return;
    button.classList.remove("vocab-lens-is-speaking");
    button.title = "朗读";
    button.setAttribute("aria-label", "朗读单词");
    state.speakingButton = null;
  }

  async function getSpeechVoices() {
    const immediate = window.speechSynthesis.getVoices();
    if (immediate.length) return immediate;
    return new Promise((resolve) => {
      const finish = () => resolve(window.speechSynthesis.getVoices());
      window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
      window.setTimeout(finish, 800);
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

  function handleOutsideClick(event) {
    const target = event.target;
    if (target?.closest?.(`.${UI_ROOT_CLASS}, .${HIGHLIGHT_CLASS}`)) return;
    removeCollectButton();
    closeCollector();
    closeReviewCard();
  }

  function positionFloatingElement(element, anchorRect, gap) {
    const margin = 10;
    element.style.visibility = "hidden";
    element.style.left = "0px";
    element.style.top = "0px";
    const box = element.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + gap;
    if (left + box.width > window.innerWidth - margin) {
      left = window.innerWidth - box.width - margin;
    }
    if (top + box.height > window.innerHeight - margin) {
      top = anchorRect.top - box.height - gap;
    }
    element.style.left = `${Math.max(margin, left)}px`;
    element.style.top = `${Math.max(margin, top)}px`;
    element.style.visibility = "visible";
  }

  function centerRect() {
    return {
      left: window.innerWidth / 2 - 20,
      top: window.innerHeight / 2,
      bottom: window.innerHeight / 2,
      width: 40,
      height: 0
    };
  }

  function normalizeWord(word) {
    return sanitizeSelection(word).toLocaleLowerCase("en-US");
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  }

  function getHighlightSignature(vocabulary) {
    return Object.values(vocabulary || {})
      .filter((entry) => entry?.normalized && entry?.meaning)
      .map((entry) => entry.normalized)
      .sort()
      .join("\n");
  }
})();
