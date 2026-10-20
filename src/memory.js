// 群友印象记忆：每个会话一个文件夹，每个群友一个以 QQ 号命名的 JSON 文件。
// 目录结构：
//   data/memory/group_<群号>/<QQ>.json
//   data/memory/private_<QQ>/<QQ>.json
// 每个成员文件：{ userId, name, impressions: [{ content, createdAt, dim?, origin?, sessionId? }], updatedAt, lastConsolidatedAt }
// 旧版单文件 data/memory/group_<群号>.json 会在首次访问时自动迁移。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from './config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

// ── 画像 v1 的条目元数据 ────────────────────────────────────────────────
// dim：画像维度（personality 性格 / tone 语气 / values 在意什么 / redline 雷点 /
//      relation 关系 / fact 事实）。缺省 fact —— 旧数据没有 dim 也照常渲染。
// origin：谁写的（model = 模型在会话里调 memory_append；consolidate = 整理管线或
//      管理端整体替换）。旧数据没有 origin 时按 consolidate 处理 —— 不把来历不明的
//      条目算成模型自发写入，验收归因才可信。
// sessionId：可选，记录模型写入来自哪次运行。
const IMPRESSION_DIMS = ['personality', 'tone', 'values', 'redline', 'relation', 'fact'];
const ORIGINS = ['model', 'consolidate'];
const DIM_LABELS = { personality: '性格', tone: '语气', values: '在意', redline: '雷点', relation: '关系' };

// 画像渲染硬上限：最多 3 人、每人 ≤120 字、整段 ≤420 字符。
// 段内不渲染任何时间戳/「最近互动」——【记忆】段是提示词锚点前缀的一部分，易变内容
// 会让锚点每轮 reset，前缀缓存全废（见 src/prompt.js 的锚点注释）。
const PORTRAIT_LIMITS = { maxMembers: 3, maxCharsPerMember: 120, maxCharsTotal: 420 };
const PORTRAIT_HEADER = '【对群友的印象】';

/** 归一化一条印象：只保留已知字段，并给 dim/origin 兜底（旧数据兼容）。 */
function normalizeImpression(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const content = String(raw.content ?? '').slice(0, 300);
  if (!content.trim()) return null;
  const entry = {
    content,
    createdAt: Number(raw.createdAt) || 0,
    dim: IMPRESSION_DIMS.includes(raw.dim) ? raw.dim : 'fact',
    origin: ORIGINS.includes(raw.origin) ? raw.origin : 'consolidate'
  };
  if (raw.sessionId) entry.sessionId = String(raw.sessionId).slice(0, 64);
  return entry;
}

/** 把「字符串 | {content,dim}」统一成可写入的印象对象。 */
function toImpression(item, { origin = 'consolidate', sessionId = '', createdAt = Date.now() } = {}) {
  const raw = typeof item === 'string' ? { content: item } : (item || {});
  const content = String(raw.content ?? '').slice(0, 300);
  if (!content.trim()) return null;
  const entry = {
    content,
    createdAt: Number(raw.createdAt) || createdAt,
    dim: IMPRESSION_DIMS.includes(raw.dim) ? raw.dim : 'fact',
    origin: ORIGINS.includes(origin) ? origin : 'consolidate'
  };
  if (sessionId) entry.sessionId = String(sessionId).slice(0, 64);
  return entry;
}

/** 按维度合成一个成员的画像文本（≤ maxCharsPerMember 字，段内无时间戳）。 */
function composePortrait(member, notes = {}) {
  const entries = [...(member.impressions || [])]
    .filter((e) => e && String(e.content ?? '').trim())
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  if (!entries.length) return '';

  // 每个结构化维度取最新 1 条；fact 取最近 3 条（与旧版「每人最近 3 条」的信息量对齐）
  const byDim = new Map();
  const facts = [];
  for (const e of entries) {
    const dim = IMPRESSION_DIMS.includes(e.dim) ? e.dim : 'fact';
    if (dim === 'fact') facts.push(String(e.content).trim());
    else byDim.set(dim, String(e.content).trim());
  }
  const parts = [];
  for (const dim of ['personality', 'tone', 'values', 'redline', 'relation']) {
    const v = byDim.get(dim);
    if (v) parts.push(`${DIM_LABELS[dim]}：${v}`);
  }
  for (const f of facts.slice(-3)) parts.push(f);

  const text = parts.join('；').replace(/\s+/g, ' ').trim();
  return text.slice(0, PORTRAIT_LIMITS.maxCharsPerMember);
}

/** 把画像行裁到整段字符上限内（头部保留；放不下的整行丢弃 —— 不截出半个名字）。 */
function clampPortraitLines(lines) {
  const max = PORTRAIT_LIMITS.maxCharsTotal;
  let out = lines[0] || '';
  for (const line of lines.slice(1)) {
    const next = `${out}\n${line}`;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

function legacyFile(chatKey) {
  return path.join(MEMORY_DIR, `${chatDirName(chatKey)}.json`);
}

function chatDir(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey));
}

function metaFile(chatKey) {
  return path.join(chatDir(chatKey), '_meta.json');
}

function memberFileName(userId, name = '') {
  if (String(userId ?? '').trim()) {
    const id = String(userId).trim();
    return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  }
  const safe = String(name || 'unknown').trim().replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
}

function memberFile(chatKey, userId, name = '') {
  return path.join(chatDir(chatKey), memberFileName(userId, name));
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function loadMember(chatKey, userId, name = '') {
  const file = memberFile(chatKey, userId, name);
  const raw = readJson(file, null);
  return {
    userId: String(raw?.userId ?? userId ?? ''),
    name: String(raw?.name ?? name ?? ''),
    impressions: Array.isArray(raw?.impressions)
      ? raw.impressions.map((e) => normalizeImpression(e)).filter(Boolean)
      : [],
    updatedAt: Number(raw?.updatedAt) || 0,
    lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0
  };
}

function loadMeta(chatKey) {
  const raw = readJson(metaFile(chatKey), null);
  return { lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0 };
}

export class MemoryStore {
  constructor() {
    this.cache = new Map(); // chatKey -> Map(userId|_n_xx, member)
  }

  /** 扫描所有有记忆的会话（文件夹或旧版单文件）。 */
  listChats() {
    const out = new Set();
    try {
      for (const f of fs.readdirSync(MEMORY_DIR)) {
        if (fs.statSync(path.join(MEMORY_DIR, f)).isDirectory()) {
          const m = /^(group|private)_(\d+)$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        } else {
          const m = /^(group|private)_(\d+)\.json$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        }
      }
    } catch { /* 目录不存在 */ }
    return [...out];
  }

  /** 旧版单文件 → 新版每成员文件。迁移后旧文件移到 backups/。 */
  #migrateLegacy(chatKey) {
    const legacy = legacyFile(chatKey);
    if (!fs.existsSync(legacy)) return;
    try {
      if (fs.statSync(legacy).isDirectory()) return;
      const old = readJson(legacy, null);
      if (!old) return;
      const notes = getConfig().memberNotes || {};
      const nameToQq = {};
      for (const [qq, name] of Object.entries(notes)) {
        if (name) nameToQq[String(name)] = String(qq);
      }
      const migrated = [];
      for (const e of Array.isArray(old.memberImpression) ? old.memberImpression : []) {
        if (!e?.content) continue;
        const target = String(e.target || '').trim();
        let userId = /^\d{5,15}$/.test(target) ? target : (nameToQq[target] || '');
        migrated.push({
          userId,
          name: target,
          content: String(e.content).slice(0, 300),
          createdAt: Number(e.createdAt) || Date.now()
        });
      }
      // 旧的 activeTopic/pendingThought 直接丢弃（本版只保留群友印象）
      for (const m of migrated) this.#appendRaw(chatKey, m.userId, m.name, m.content, m.createdAt);
      const backupDir = path.join(MEMORY_DIR, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, path.basename(legacy));
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      fs.renameSync(legacy, backup);
    } catch (error) {
      console.error('[memory] 旧记忆迁移失败:', error?.message ?? error);
    }
  }

  #ensureChat(chatKey) {
    this.#migrateLegacy(chatKey);
    if (!this.cache.has(chatKey)) {
      const map = new Map();
      try {
        for (const f of fs.readdirSync(chatDir(chatKey))) {
          if (!f.endsWith('.json') || f === '_meta.json') continue;
          const raw = readJson(path.join(chatDir(chatKey), f), null);
          if (!raw) continue;
          const key = raw.userId ? String(raw.userId) : `_n_${f}`;
          map.set(key, loadMember(chatKey, raw.userId, raw.name));
        }
      } catch { /* 尚无文件夹 */ }
      this.#mergeNameDuplicates(chatKey, map);
      this.cache.set(chatKey, map);
    }
    return this.cache.get(chatKey);
  }

  /**
   * 合并"同一个人被存成两份"的历史数据。
   *
   * 背景：早期没有 QQ 号时会按名字落文件（_n_xxx.json）。后来拿到 QQ 号再次写入时，
   * 会新建 <QQ>.json，但旧的 _n_ 文件不会被清理 → 同一个人在记忆里出现两次，
   * 印象重复、整理时互相干扰，也让"印象总数"虚高。
   *
   * 规则：无 QQ 号的条目，只要有同名（且该名字对应的条目有 QQ 号），
   * 就把它的印象并入该 QQ 号条目，然后删除 _n_ 文件。
   */
  #mergeNameDuplicates(chatKey, map) {
    const nameToId = new Map();
    for (const m of map.values()) {
      const uid = String(m.userId || '').trim();
      const nm = String(m.name || '').trim();
      if (uid && nm) nameToId.set(nm, uid);
    }
    const toDelete = [];
    for (const [key, m] of map.entries()) {
      const uid = String(m.userId || '').trim();
      if (uid) continue;                       // 已有 QQ 号，不是兜底条目
      const nm = String(m.name || '').trim();
      const targetId = nameToId.get(nm);
      if (!targetId) continue;
      const target = map.get(targetId);
      if (!target) continue;

      const seen = new Set(target.impressions.map((e) => e.content));
      let added = 0;
      for (const e of m.impressions) {
        if (seen.has(e.content)) continue;
        seen.add(e.content);
        target.impressions.push({ ...e });
        added += 1;
      }
      if (added) {
        target.impressions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        target.updatedAt = Math.max(Number(target.updatedAt) || 0, Number(m.updatedAt) || 0);
        writeJson(memberFile(chatKey, targetId, target.name), target);
      }
      // 删除已被并入的兜底文件
      try { fs.rmSync(memberFile(chatKey, '', nm), { force: true }); } catch { /* ignore */ }
      toDelete.push(key);
      console.log(`[memory] 合并重复记忆：${nm}（无 QQ 号）→ ${targetId}，并入 ${added} 条`);
    }
    for (const k of toDelete) map.delete(k);
  }

  /**
   * 追加一条原始印象（内部路径）。
   * opts: { origin: 'model'|'consolidate'（缺省 consolidate）, dim, sessionId }
   * 注意：这里不做去重之外的业务判断；origin 由调用入口决定，不猜。
   */
  #appendRaw(chatKey, userId, name, content, createdAt = Date.now(), opts = {}) {
    const map = this.#ensureChat(chatKey);
    const key = userId ? String(userId) : `_n_${memberFileName('', name)}`;
    const member = map.get(key) || loadMember(chatKey, userId, name);
    const entry = toImpression({ content, createdAt, dim: opts.dim }, {
      origin: opts.origin === 'model' ? 'model' : 'consolidate',
      sessionId: opts.sessionId,
      createdAt
    });
    if (!entry) return null;
    if (!member.impressions.some((e) => e.content === entry.content)) {
      member.impressions.push(entry);
    }
    member.userId = String(userId ?? member.userId ?? '');
    member.name = String(name || member.name || '');
    member.updatedAt = Date.now();
    writeJson(memberFile(chatKey, userId, name), member);
    map.set(key, member);
    return entry;
  }

  /**
   * 记一条对群友的印象（模型唯一写入口）。
   * extra: { userId, target, dim?, sessionId? } —— origin 固定为 model，
   * 这样验收能区分「模型在会话里记的」与「整理管线生成的」。
   */
  append(chatKey, category, content, extra = {}) {
    if (category !== 'memberImpression') return null;
    const userId = String(extra.userId ?? '').trim();
    const target = String(extra.target ?? '').trim().slice(0, 60);
    if (!userId && !target) return null;
    return this.#appendRaw(chatKey, userId, target || userId, content, Date.now(), {
      origin: 'model',
      dim: extra.dim,
      sessionId: extra.sessionId
    });
  }

  /** 所有成员的印象（扁平列表，兼容旧消费方）。 */
  query(chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    const map = this.#ensureChat(chatKey);
    const memberImpression = [];
    for (const m of map.values()) {
      for (const e of m.impressions) {
        memberImpression.push({
          userId: String(m.userId || ''),
          target: String(m.name || m.userId || '某人'),
          content: e.content,
          createdAt: e.createdAt,
          dim: IMPRESSION_DIMS.includes(e.dim) ? e.dim : 'fact',
          origin: ORIGINS.includes(e.origin) ? e.origin : 'consolidate'
        });
      }
    }
    memberImpression.sort((a, b) => b.createdAt - a.createdAt);
    return { memberImpression };
  }

  /** 成员级视图（记忆页签用）。 */
  members(chatKey) {
    const map = this.#ensureChat(chatKey);
    const list = [];
    for (const m of map.values()) {
      if (!m.impressions.length) continue;
      list.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || '某人'),
        impressions: m.impressions.map((e) => ({ ...e })),
        updatedAt: m.updatedAt,
        lastConsolidatedAt: m.lastConsolidatedAt
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  /** 单个成员的印象（含空成员）。 */
  getMember(chatKey, userId) {
    const map = this.#ensureChat(chatKey);
    const m = map.get(String(userId)) || loadMember(chatKey, String(userId));
    return {
      userId: String(m.userId || userId || ''),
      name: String(m.name || ''),
      impressions: (m.impressions || []).map((e) => ({ ...e })),
      updatedAt: Number(m.updatedAt) || 0
    };
  }

  /** 编辑群友印象（管理端）：QQ 号由调用方提供，自动回填名字，保存备注到配置。 */
  editMemberImpression(chatKey, { userId, name = '', note = '', impressions = [] }) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(impressions) ? impressions : [impressions];
    const now = Date.now();
    const entries = list
      .map((item) => toImpression(item, { origin: 'consolidate', createdAt: now }))
      .filter(Boolean)
      .slice(0, 20);
    const member = {
      userId: uid,
      name: finalName,
      impressions: entries,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    // 备注写入配置 memberNotes
    if (note !== undefined && note !== null) {
      const notes = { ...(getConfig().memberNotes || {}) };
      const n = String(note ?? '').trim();
      if (n) notes[uid] = n;
      else delete notes[uid];
      updateConfig({ memberNotes: notes });
    }
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt,
      note: String(note ?? '').trim()
    };
  }

  /** 手动替换某成员的全部印象（管理端编辑用）。返回更新后的成员。 */
  replaceMember(chatKey, userId, name, contents) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(contents) ? contents : [contents];
    const now = Date.now();
    const impressions = list
      .map((item) => toImpression(item, { origin: 'consolidate', createdAt: now }))
      .filter(Boolean)
      .slice(0, 20);
    const member = {
      userId: uid,
      name: finalName,
      impressions,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    // 单个成员替换也备份原文件（保留最近一次）
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.mkdirSync(backupDir, { recursive: true });
      const src = memberFile(chatKey, uid, finalName);
      if (fs.existsSync(src)) {
        const dst = path.join(backupDir, path.basename(src));
        if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        fs.copyFileSync(src, dst);
      }
    } catch { /* 备份失败不阻塞 */ }
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt
    };
  }

  /** 删除某成员的印象文件。 */
  removeMember(chatKey, userId) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) return false;
    const map = this.#ensureChat(chatKey);
    const m = map.get(uid) || loadMember(chatKey, uid);
    map.delete(uid);
    try { fs.rmSync(memberFile(chatKey, uid, m.name), { force: true }); } catch { /* ignore */ }
    return true;
  }

  /**
   * 删除一个会话的**全部**记忆（记忆页「删除本会话记忆」按钮）。
   * 成员文件、_meta.json、旧版单文件与备份一并清掉；目录本身保留
   * （可能是挂载点/被占用，删不掉也无妨——里面已空）。
   * @returns {boolean} 是否删掉了东西
   */
  removeChat(chatKey) {
    const dir = chatDir(chatKey);
    let removed = false;
    try {
      for (const f of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, f), { recursive: true, force: true });
        removed = true;
      }
    } catch { /* 目录不存在 = 没有记忆可删 */ }
    // 旧版单文件（迁移前的形态）
    try { fs.rmSync(legacyFile(chatKey), { force: true }); removed = true; } catch { /* ignore */ }
    // 内存缓存同步清掉，否则同进程内 members() 还能读到旧数据
    this.#ensureChat(chatKey).clear();
    return removed;
  }

  remove(chatKey, category, { userId = '', target = '', content = '' } = {}) {
    if (category !== 'memberImpression') return false;
    const map = this.#ensureChat(chatKey);
    let removed = false;
    for (const [key, m] of [...map.entries()]) {
      if (userId) {
        if (String(m.userId) === String(userId)) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      } else if (target) {
        const matchName = String(target).trim();
        if (String(m.name || m.userId) === matchName) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      }
    }
    return removed;
  }

  clear(chatKey) {
    const map = this.#ensureChat(chatKey);
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    writeJson(metaFile(chatKey), { lastConsolidatedAt: Date.now() });
  }

  /**
   * 生成提示词里的【对群友的印象】画像段。
   *
   * userIds 是**优先级顺序**（prompt.js 按「被 @/被引用 > 触发批最后发言者 >
   * 已读窗口最近互动者」排好）：决定谁进入画像（最多 3 人）；渲染顺序仍用
   * members() 的稳定序（updatedAt 降序）——【记忆】段是锚点前缀的一部分，
   * 同一成员集必须逐字节稳定，否则锚点每轮 reset、前缀缓存全废。
   *
   * 硬上限：最多 3 人、每人 ≤120 字、整段 ≤420 字符；段内不渲染任何时间戳。
   * 没有任何画像内容时返回 ''（调用方不许注入空段/空标题）。
   */
  formatForPrompt(chatKey, { userIds = null } = {}) {
    const notes = getConfig().memberNotes || {};
    const all = this.members(chatKey);
    if (!all.length) return '';

    const order = Array.isArray(userIds)
      ? [...new Set(userIds.map((u) => String(u ?? '').trim()).filter(Boolean))]
      : (userIds ? [...new Set([...userIds].map(String))] : null);

    let picked;
    if (!order) {
      picked = all.slice(0, PORTRAIT_LIMITS.maxMembers);
    } else {
      const rank = new Map(order.map((uid, i) => [uid, i]));
      picked = all
        .filter((m) => !m.userId || rank.has(String(m.userId)))   // 无 QQ 号的旧数据始终带上
        .sort((a, b) => {
          const ra = a.userId ? rank.get(String(a.userId)) : Number.MAX_SAFE_INTEGER;
          const rb = b.userId ? rank.get(String(b.userId)) : Number.MAX_SAFE_INTEGER;
          return ra - rb;
        })
        .slice(0, PORTRAIT_LIMITS.maxMembers);
    }
    if (!picked.length) return '';

    // 渲染顺序 = members() 稳定序，而不是传入的优先级顺序（前缀缓存要求）
    const pickedKeys = new Set(picked.map((m) => String(m.userId || m.name || '')));
    const lines = [PORTRAIT_HEADER];
    for (const m of all) {
      const key = String(m.userId || m.name || '');
      if (!pickedKeys.has(key)) continue;
      const text = composePortrait(m);
      if (!text) continue;
      const who = notes[String(m.userId)] || m.name || String(m.userId || '') || '某人';
      lines.push(`- ${who}：${text}`);
    }
    if (lines.length === 1) return '';
    return clampPortraitLines(lines);
  }

  // ── 自动整理（consolidation）──

  consolidationState(chatKey) {
    const map = this.#ensureChat(chatKey);
    let total = 0;
    let lastConsolidatedAt = 0;
    const members = [];
    for (const m of map.values()) {
      total += m.impressions.length;
      lastConsolidatedAt = Math.max(lastConsolidatedAt, m.lastConsolidatedAt || 0);
      members.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || ''),
        count: m.impressions.length,
        lastConsolidatedAt: m.lastConsolidatedAt || 0
      });
    }
    return {
      lastConsolidatedAt: loadMeta(chatKey).lastConsolidatedAt || lastConsolidatedAt,
      counts: { memberImpression: total },
      members
    };
  }

  /**
   * 记录一次整理完成的时间。
   * 同时写会话级 _meta.json（供冷却判断）与各成员文件的 lastConsolidatedAt。
   * userIds 为空时只更新会话级时间。
   */
  markConsolidated(chatKey, at = Date.now(), userIds = []) {
    try {
      fs.mkdirSync(chatDir(chatKey), { recursive: true });
      const prev = readJson(metaFile(chatKey), {}) || {};
      writeJson(metaFile(chatKey), { ...prev, lastConsolidatedAt: Number(at) || Date.now() });
    } catch (error) {
      console.warn('[memory] 写整理时间失败:', error?.message ?? error);
    }
    const map = this.#ensureChat(chatKey);
    for (const uid of userIds || []) {
      const key = String(uid ?? '').trim();
      if (!key) continue;
      const m = map.get(key);
      if (!m) continue;
      m.lastConsolidatedAt = Number(at) || Date.now();
      try { writeJson(memberFile(chatKey, m.userId, m.name), m); } catch { /* ignore */ }
    }
  }

  /**
   * 用整理结果整体替换本会话的印象（按成员写回各自文件）。
   * next.memberImpression: [{ userId?, target?, content }]
   */
  replaceConsolidated(chatKey, next) {
    const cut = (s, n) => String(s ?? '').trim().slice(0, n);
    const now = Date.now();
    const groups = new Map(); // key -> { userId, name, items: [{content, dim}] }
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, 15) : []) {
      const content = cut(item?.content, 300);
      if (!content) continue;
      const userId = cut(item?.userId, 40) || '';
      const name = cut(item?.target, 60) || userId;
      const key = userId || `_n_${memberFileName('', name)}`;
      if (!groups.has(key)) groups.set(key, { userId, name, items: [] });
      groups.get(key).items.push({ content, dim: IMPRESSION_DIMS.includes(item?.dim) ? item.dim : 'fact' });
    }
    const map = this.#ensureChat(chatKey);
    // 整理前把整个会话文件夹备份到 data/memory/backups/<会话>/（保留最近一次）
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.rmSync(backupDir, { recursive: true, force: true });
      fs.mkdirSync(backupDir, { recursive: true });
      for (const m of map.values()) {
        const src = memberFile(chatKey, m.userId, m.name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, path.basename(src)));
      }
      const metaSrc = metaFile(chatKey);
      if (fs.existsSync(metaSrc)) fs.copyFileSync(metaSrc, path.join(backupDir, '_meta.json'));
    } catch { /* 备份失败不阻塞整理 */ }
    // 删除所有现有成员文件（整理结果会重建）
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    for (const g of groups.values()) {
      for (const item of g.items) {
        this.#appendRaw(chatKey, g.userId, g.name, item.content, now, { origin: 'consolidate', dim: item.dim });
      }
      const file = memberFile(chatKey, g.userId, g.name);
      const member = loadMember(chatKey, g.userId, g.name);
      member.lastConsolidatedAt = now;
      member.updatedAt = now;
      writeJson(file, member);
      map.set(g.userId || `_n_${memberFileName('', g.name)}`, member);
    }
    writeJson(metaFile(chatKey), { lastConsolidatedAt: now });
    const totalAfter = [...map.values()].reduce((n, m) => n + m.impressions.length, 0);
    return { memberImpression: groups.size ? this.query(chatKey).memberImpression : [], count: totalAfter };
  }
}
