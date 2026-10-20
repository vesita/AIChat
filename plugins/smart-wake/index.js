// 智能唤醒判定插件（确定性型，提供 reply.interest-judge 能力）。
//
// 定位：**本地启发式的"要不要接话"判定**，纯本地 —— 不发请求、不写盘、不
// monkeypatch 宿主代码；状态（冷却/预算/去重缓存）只在内存，重启清零。
//
// 判定语义（与核心契约一致：返回 { respond, reason }；返回 undefined = 不干预）：
//   · base.shouldRespond = true（核心已判定触发）：只在识别到刷屏/复读/命令/超短，
//     或冷却/预算用尽时否决；其余保持响应 —— 不误杀正常触发。
//   · base.shouldRespond = false（核心判定不触发）：只有问句/提到 bot/延续对话等
//     信号足够强、且分数达到 escalateThreshold 时才接话。
//   · 私聊 / 被艾特 / 拍了拍我由核心直接跳过，不会咨询到这里。
//
// 同一批消息可能被咨询不止一次（onIncoming 一次、wake 收尾一次）：用
// "签名 + 5 秒缓存"保证同一批重复咨询得到同一答案、且不重复消耗预算。
//
// 默认 settings.enabled = false：本插件会改变触发行为，默认不打扰；
// 在控制台「插件」页打开开关后才生效（关闭时等价于没装，核心原样走自己的判定）。

const CACHE_TTL_MS = 5000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 由 setup 注入的配置读取器；测试可直接构造 settings 调纯函数。 */
let getSettings = () => ({});

/** chatKey -> { responses: number[], cache: Map<string, {at, decision}> }（仅内存）。 */
const states = new Map();

export function setup(api) {
  getSettings = () => {
    try {
      return (typeof api?.config === 'function' ? api.config() : api?.config) || {};
    } catch {
      return {};
    }
  };
}

/** 测试用：清空内存状态。 */
export function resetState() {
  states.clear();
}

function stateOf(chatKey) {
  let st = states.get(chatKey);
  if (!st) {
    st = { responses: [], cache: new Map() };
    states.set(chatKey, st);
  }
  return st;
}

/** 同一个 chatKey 的判定输入签名：同一批重复咨询（onIncoming → wake）会命中同一个。 */
function batchSignature(info) {
  const entries = Array.isArray(info?.triggerEntries) ? info.triggerEntries : [];
  const latest = entries.length ? String(entries[entries.length - 1]?.text ?? '') : '';
  const base = info?.base || {};
  return `${String(info?.chatKey || '')}|${String(base.reason || '')}|${Number(base.tier) || 0}|${latest}`;
}

/** 纯函数：分析信号给分（0~10），并给出命中的信号名（写进 reason 便于排障）。 */
export function scoreSignals(info, settings = {}, now = Date.now()) {
  const entries = Array.isArray(info?.triggerEntries) ? info.triggerEntries : [];
  const latest = entries[entries.length - 1] || {};
  const text = String(latest.text ?? '');
  const recent = Array.isArray(info?.recent) ? info.recent : [];
  const botName = String(info?.botName || '').trim();
  const nickname = String(info?.selfNickname || '').trim();
  const minChars = Math.max(1, Number(settings.minChars) || 6);
  const signals = [];
  let score = 0;

  if (/[?？]\s*$/.test(text) || /[吗呢]|[怎为][么样]|为什么|如何|能不能|可不可以|有没有|是不是/.test(text)) {
    score += 3;
    signals.push('问句');
  }
  if ((botName && text.includes(botName)) || (nickname && text.includes(nickname))) {
    score += 3;
    signals.push('提到机器人');
  }
  const continuationSec = Math.max(0, Number(settings.continuationSec) || 120);
  const lastSelfTs = recent
    .filter((m) => m && m.isSelf && Number(m.ts) > 0)
    .reduce((max, m) => Math.max(max, Number(m.ts)), 0);
  if (lastSelfTs && now - lastSelfTs <= continuationSec * 1000) {
    score += 2;
    signals.push('延续对话');
  }
  // 信息量：去掉占位符（[图片]/[表情]…）后的有效字数
  const plain = text.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
  if (plain.length >= 12) {
    score += 2;
    signals.push('信息量足');
  }
  if (plain.length >= minChars) {
    score += 1;
    signals.push('长度达标');
  }
  return { score: Math.max(0, Math.min(10, score)), signals };
}

/**
 * 纯函数：刷屏信号检测。
 * 只认"确定是噪音"的形状：纯表情/占位符、命令、复读、超短消息。
 */
export function detectSpam(info, settings = {}) {
  if (settings.suppressSpam === false) return { spam: false, reason: '' };
  const entries = Array.isArray(info?.triggerEntries) ? info.triggerEntries : [];
  const latest = entries[entries.length - 1] || {};
  const text = String(latest.text ?? '').trim();
  if (!text) return { spam: false, reason: '' };
  // 纯表情 / 纯占位符（[图片][表情]…）：去掉占位符与空白/符号后啥也不剩
  const plain = text.replace(/\[[^\]]*\]/g, '').replace(/[\s\p{P}\p{S}]/gu, '');
  if (!plain) return { spam: true, reason: '纯表情/占位符' };
  if (/^[/!！]/.test(text)) return { spam: true, reason: '命令式消息' };
  const minChars = Math.max(1, Number(settings.minChars) || 6);
  if (plain.length < minChars) return { spam: true, reason: '超短消息' };
  // 复读：最近 N 条（不含自己）里出现相同文本。
  // ⚠️ 必须只比**更早**的消息：wake 阶段 recent 里已经包含刚 drain 的触发批，
  //    不排除它的话每条触发消息都会把自己当成复读，全部被误杀。
  const latestTs = Number(latest.ts) || 0;
  const windowSize = Math.max(1, Number(settings.repeatWindow) || 12);
  const recent = (Array.isArray(info?.recent) ? info.recent : [])
    .filter((m) => m && !m.isSelf && (!latestTs || Number(m.ts) < latestTs))
    .slice(-windowSize);
  const same = recent.filter((m) => String(m.text ?? '').trim() === text).length;
  if (same >= 1) return { spam: true, reason: '复读消息' };
  return { spam: false, reason: '' };
}

/** 纯函数：冷却与小时/日预算（只看内存里已记录的接话时间）。 */
export function checkBudget(responses, now = Date.now(), settings = {}) {
  const list = Array.isArray(responses) ? responses : [];
  const cooldownSec = Math.max(0, Number(settings.cooldownSec) || 0);
  const last = list.length ? Math.max(...list) : 0;
  if (cooldownSec > 0 && last && now - last < cooldownSec * 1000) {
    const left = Math.ceil((cooldownSec * 1000 - (now - last)) / 1000);
    return { ok: false, reason: `冷却中（还剩 ${left}s）` };
  }
  const hourlyCap = Math.max(0, Number(settings.hourlyCap) || 0);
  if (hourlyCap > 0) {
    const inHour = list.filter((t) => now - t < HOUR_MS).length;
    if (inHour >= hourlyCap) return { ok: false, reason: `本小时已接话 ${inHour} 次（上限 ${hourlyCap}）` };
  }
  const dailyCap = Math.max(0, Number(settings.dailyCap) || 0);
  if (dailyCap > 0) {
    const inDay = list.filter((t) => now - t < DAY_MS).length;
    if (inDay >= dailyCap) return { ok: false, reason: `今天已接话 ${inDay} 次（上限 ${dailyCap}）` };
  }
  return { ok: true, reason: '' };
}

/**
 * 纯函数：一次判定（不碰模块级状态，预算看传入的 state.responses）。
 * @returns {{respond: boolean, reason: string}} 或 undefined（关闭/不干预）
 */
export function evaluate(info, settings = {}, state = { responses: [] }, now = Date.now()) {
  if (!settings || settings.enabled !== true) return undefined;
  const base = info?.base || {};
  const baseRespond = base.shouldRespond === true;
  const spam = detectSpam(info, settings);
  const budget = checkBudget(state.responses || [], now, settings);

  if (baseRespond) {
    if (spam.spam) return { respond: false, reason: `抑制刷屏：${spam.reason}` };
    if (!budget.ok) return { respond: false, reason: `触发预算用尽：${budget.reason}` };
    return { respond: true, reason: '启发式：非噪音，维持响应' };
  }
  if (spam.spam) return { respond: false, reason: `不接话：${spam.reason}` };
  if (!budget.ok) return { respond: false, reason: `不接话：预算用尽（${budget.reason}）` };
  const { score, signals } = scoreSignals(info, settings, now);
  // escalateThreshold 是主动接话阈值；没配时退回 threshold（老配置/简写兼容）。
  const threshold = Math.max(1, Number(settings.escalateThreshold) || Number(settings.threshold) || 5);
  if (score >= threshold) return { respond: true, reason: `启发式接话：${signals.join('+')}（${score} 分）` };
  return { respond: false, reason: `启发式不接：${signals.join('+') || '无信号'}（${score} 分）` };
}

/**
 * 带内存状态的判定：同批重复咨询走 5 秒缓存（不重复消耗预算）。
 * 供 providers 使用，也导出给测试直接驱动。
 */
export function handle(info, settings = {}, now = Date.now(), statesMap = states) {
  if (!settings || settings.enabled !== true) return undefined;
  const chatKey = String(info?.chatKey || '');
  let st = statesMap.get(chatKey);
  if (!st) {
    st = { responses: [], cache: new Map() };
    statesMap.set(chatKey, st);
  }
  // 清理过期记录（内存只增不减会是慢性泄漏）
  st.responses = st.responses.filter((t) => now - t < DAY_MS);
  for (const [sig, c] of st.cache) if (now - c.at > CACHE_TTL_MS) st.cache.delete(sig);

  const sig = batchSignature(info);
  const cached = st.cache.get(sig);
  if (cached && now - cached.at <= CACHE_TTL_MS) return cached.decision;

  const decision = evaluate(info, settings, st, now);
  if (!decision) return undefined;
  if (decision.respond) st.responses.push(now);
  st.cache.set(sig, { at: now, decision });
  return decision;
}

export const providers = {
  // 契约：{ base, chatKey, kind, …, triggerEntries, recent, … } → { respond, reason? }
  'reply.interest-judge': (info = {}) => handle(info, getSettings(), Date.now()),
};
