(() => {
  const ROOT_KEY = 'pensieve.campaign.v1';
  const THREADS_LEGACY_KEY = 'pensieve.threads';
  const VERSION = 1;

  const CHAPTER_TITLES = {
    '01': 'Echo Tide',
    '02': 'Two Rooms, One Room',
    '03': 'Ink Drift',
    '04': 'The Weight of Things',
    '05': 'Lantern Keeper',
    '06': 'Mirror Walk',
    '07': 'Falling Upward',
    '08': 'The Unspooling',
    '09': 'Faces in Fog',
    '10': 'The Lullaby',
    '11': 'The Argument',
    '12': 'The Forgetting Garden'
  };

  const safeParse = (txt, fallback = null) => {
    try { return JSON.parse(txt); } catch (_) { return fallback; }
  };

  const nowIso = () => new Date().toISOString();

  const makeId = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  };

  const emptyCampaign = () => ({
    version: VERSION,
    updatedAt: nowIso(),
    chapters: {},
    threads: []
  });

  function normalizeChapterId(chapterId) {
    if (chapterId == null) return null;
    const raw = String(chapterId).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return raw.padStart(2, '0');
    return raw;
  }

  function readCampaign() {
    const data = safeParse(localStorage.getItem(ROOT_KEY), null);
    if (!data || typeof data !== 'object') return emptyCampaign();
    if (!Array.isArray(data.threads)) data.threads = [];
    if (!data.chapters || typeof data.chapters !== 'object') data.chapters = {};
    if (!data.version) data.version = VERSION;
    return data;
  }

  function writeCampaign(campaign) {
    campaign.version = VERSION;
    campaign.updatedAt = nowIso();
    localStorage.setItem(ROOT_KEY, JSON.stringify(campaign));
    return campaign;
  }

  function guessChapterIdFromGame(game) {
    const n = Number(game);
    if (Number.isInteger(n) && n >= 1 && n <= 12) return String(n).padStart(2, '0');
    return null;
  }

  function normalizeThread(payload) {
    const chapterId = normalizeChapterId(payload.chapterId) || guessChapterIdFromGame(payload.game) || '??';
    const threadId = payload.threadId || payload.memoryId || makeId();
    const completedAt = payload.completedAt || nowIso();
    const scores = payload.scores || {
      clarity: Number(payload.clarity),
      sync: Number(payload.sync)
    };
    if (!Number.isFinite(scores.clarity)) delete scores.clarity;
    if (!Number.isFinite(scores.sync)) delete scores.sync;

    return {
      version: VERSION,
      threadId,
      memoryId: threadId,
      chapterId,
      chapterSlug: payload.chapterSlug || CHAPTER_TITLES[chapterId] || payload.title || null,
      title: payload.title || CHAPTER_TITLES[chapterId] || null,
      game: payload.game,
      state: payload.state || 'completed',
      completed: payload.completed !== false,
      completedAt,
      color: payload.color || 'silver',
      scores: Object.keys(scores).length ? scores : undefined,
      carryover: payload.carryover || payload.carryovers || undefined,
      summaryText: payload.summaryText || payload.text || undefined,
      meta: payload.meta || undefined,
      source: payload.source || undefined
    };
  }

  function upsertThread(campaign, thread) {
    const idx = campaign.threads.findIndex(t => t.threadId === thread.threadId);
    if (idx >= 0) campaign.threads[idx] = Object.assign({}, campaign.threads[idx], thread);
    else campaign.threads.push(thread);
  }

  function markChapterCompleteInCampaign(campaign, chapterId, meta = {}) {
    const id = normalizeChapterId(chapterId);
    if (!id) return;
    const prev = campaign.chapters[id] || {};
    campaign.chapters[id] = {
      chapterId: id,
      completed: true,
      completedAt: meta.completedAt || prev.completedAt || nowIso(),
      title: meta.title || prev.title || CHAPTER_TITLES[id] || null,
      lastThreadId: meta.lastThreadId || prev.lastThreadId || null,
      threadCount: Number.isFinite(meta.threadCount) ? meta.threadCount : prev.threadCount || 0
    };
  }

  function emitCompletionEvents(thread) {
    const detail = { thread, chapterId: thread.chapterId };
    window.dispatchEvent(new CustomEvent('pensieve:chapter-complete', { detail }));
    window.dispatchEvent(new CustomEvent('pensieve:thread', { detail: thread }));
    window.dispatchEvent(new CustomEvent('pensieve:complete', { detail: { thread, chapterId: thread.chapterId } }));
  }

  function saveChapterResult(payload) {
    const campaign = readCampaign();
    const thread = normalizeThread(payload);
    upsertThread(campaign, thread);

    const chapterThreads = campaign.threads.filter(t => t.chapterId === thread.chapterId);
    markChapterCompleteInCampaign(campaign, thread.chapterId, {
      completedAt: thread.completedAt,
      title: thread.title,
      lastThreadId: thread.threadId,
      threadCount: chapterThreads.length
    });

    writeCampaign(campaign);
    emitCompletionEvents(thread);
    return thread;
  }

  function markChapterComplete(chapterId, meta = {}) {
    const campaign = readCampaign();
    markChapterCompleteInCampaign(campaign, chapterId, meta);
    writeCampaign(campaign);
  }

  function getCampaign() {
    return readCampaign();
  }

  function getAllThreads() {
    return readCampaign().threads.slice().sort((a, b) => String(a.completedAt || '').localeCompare(String(b.completedAt || '')));
  }

  function getChapterResults(chapterId) {
    const id = normalizeChapterId(chapterId);
    return getAllThreads().filter(t => t.chapterId === id);
  }

  function getLatestChapterResult(chapterId) {
    const rows = getChapterResults(chapterId);
    return rows.length ? rows[rows.length - 1] : null;
  }

  function migrateLegacyOnce() {
    const migrated = localStorage.getItem('pensieve.campaign.v1.migrated');
    if (migrated === '1') return;

    const campaign = readCampaign();
    if (campaign.threads.length > 0) {
      localStorage.setItem('pensieve.campaign.v1.migrated', '1');
      return;
    }

    const legacyThreads = safeParse(localStorage.getItem(THREADS_LEGACY_KEY), []);
    if (Array.isArray(legacyThreads)) {
      legacyThreads.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object') return;
        const chapterId = normalizeChapterId(raw.chapterId) || guessChapterIdFromGame(raw.game) || '08';
        const thread = normalizeThread({
          ...raw,
          chapterId,
          threadId: raw.threadId || raw.memoryId || `legacy-${chapterId}-${i}-${makeId()}`,
          scores: raw.scores || { clarity: raw.clarity, sync: raw.sync },
          carryover: raw.carryover || raw.carryovers
        });
        upsertThread(campaign, thread);
      });
    }

    writeCampaign(campaign);
    localStorage.setItem('pensieve.campaign.v1.migrated', '1');
  }

  function mountBackButton() {
    if (document.querySelector('.hub-btn')) return;
    const back = document.createElement('a');
    back.className = 'hub-btn';
    back.href = '/index.html';
    back.textContent = '← Back to Hub';
    document.body.appendChild(back);
  }

  function initHelpers() {
    window.proto = {
      setBar(id, pct){
        const el = document.getElementById(id);
        if (!el) return;
        el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      },
      setText(id, text){
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      }
    };
  }

  try {
    migrateLegacyOnce();
  } catch (_) {}

  try { mountBackButton(); } catch (_) {}
  initHelpers();

  window.PensieveCampaign = {
    version: VERSION,
    chapterTitles: CHAPTER_TITLES,
    makeId,
    getCampaign,
    getAllThreads,
    getChapterResults,
    getLatestChapterResult,
    saveChapterResult,
    markChapterComplete
  };
})();
