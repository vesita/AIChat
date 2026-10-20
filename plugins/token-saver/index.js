// 上下文省流插件（确定性型：提供 reply.local-policy / llm.usage，挂 before-llm-messages）。
//
// 两件事，都只在"确定安全"的时候做：
//   1. before-llm-messages：把【已读信息】里**最旧的**历史裁到 keepLast 条 /
//      字符预算内。不碰【未读信息】（当前触发批）、不碰【新已读信息】（最近消息）、
//      不碰 system / tool 消息。裁了记日志并经 llm.usage 上报省下的条数。
//   2. reply.local-policy：本轮"只发消息、没有待执行工具"且全部成功时提前收尾，
//      省掉只为收尾的整轮 LLM 调用。判据保守：任何一条不满足就返回 undefined
//      （= 不干预，模型继续正常循环）。
//
// 边界：纯本地、零网络、不写盘；不 monkeypatch 宿主；不 import 宿主 src。
// 默认 localPolicy = false（收尾策略会改变对话轮次，默认关；上下文裁剪默认开）。
//
// 本版**不做** `llm.request-params` 的前缀搬移（把锚点前缀提到 system 里做缓存优化）：
// 那会改动提示词字节、影响 prompt-anchor 的缓存前提，风险高，留待后续单独评估。

/** 由 setup 注入的配置读取器。 */
let getSettings = () => ({});

/** sessionId -> { lines, chars }：本轮 hook 裁掉的数量，供 llm.usage 上报。 */
const stats = new Map();

export function setup(api) {
  getSettings = () => {
    try {
      return (typeof api?.config === 'function' ? api.config() : api?.config) || {};
    } catch {
      return {};
    }
  };
}

/** 测试用：清空统计。 */
export function resetStats() {
  stats.clear();
}

/** 【已读信息】段的段头（正文里还有别的段也引用“已读信息”，用完整句式定位）。 */
const READ_SECTION_HEADER = '【已读信息】以下是';

/**
 * 裁一个【已读信息】段：保留段头行，正文只留最近 keepLast 条 / 字符预算内。
 * @returns {{changed:boolean, content?:string, removedLines:number, removedChars:number}}
 */
function trimReadSection(content, keepLast, charBudget) {
  const at = content.indexOf(READ_SECTION_HEADER);
  if (at < 0) return { changed: false, removedLines: 0, removedChars: 0 };
  const headerEnd = content.indexOf('\n', at);
  // 没有正文（"暂无历史记录"单行）→ 不动
  if (headerEnd < 0) return { changed: false, removedLines: 0, removedChars: 0 };
  // 段结束 = 后面第一个新的段头（"\n【"）。历史行以 "[" 开头，不会误判。
  const nextSection = content.indexOf('\n【', headerEnd);
  const sectionEnd = nextSection < 0 ? content.length : nextSection;
  const headerLine = content.slice(at, headerEnd);
  const body = content.slice(headerEnd + 1, sectionEnd);
  // 保留段尾的空行（段与段之间用空行分隔）：只裁历史条目本身
  const rawLines = body.split('\n');
  let tailNewlines = 0;
  while (rawLines.length && rawLines[rawLines.length - 1] === '') { rawLines.pop(); tailNewlines++; }
  const lines = rawLines.filter((line) => line !== '');
  if (!lines.length) return { changed: false, removedLines: 0, removedChars: 0 };

  let kept = lines;
  if (lines.length > keepLast) kept = kept.slice(-keepLast);
  if (charBudget > 0) {
    while (kept.length > 1 && kept.join('\n').length > charBudget) kept = kept.slice(1);
  }
  const newBody = kept.join('\n') + '\n'.repeat(tailNewlines);
  if (newBody === body) return { changed: false, removedLines: 0, removedChars: 0 };
  return {
    changed: true,
    content: `${content.slice(0, at)}${headerLine}\n${newBody}${content.slice(sectionEnd)}`,
    removedLines: lines.length - kept.length,
    removedChars: body.length - newBody.length
  };
}

/**
 * 纯函数：原地裁剪 messages 里最旧的已读历史。
 * 只处理 role=user 的字符串消息；system / tool / 助手消息一律不动。
 * @returns {{trimmedLines:number, trimmedChars:number}}
 */
export function trimReadHistory(messages, settings = {}) {
  const keepLast = Math.max(1, Number(settings.keepLast) || 40);
  const charBudget = Math.max(0, Number(settings.charBudget) || 0);
  let trimmedLines = 0;
  let trimmedChars = 0;
  for (const msg of messages || []) {
    if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') continue;
    const r = trimReadSection(msg.content, keepLast, charBudget);
    if (!r.changed) continue;
    msg.content = r.content;
    trimmedLines += r.removedLines;
    trimmedChars += r.removedChars;
  }
  return { trimmedLines, trimmedChars };
}

/** 本轮调用里"只交付、不留待办"的工具（出现其它工具就说明模型还有活要干）。 */
const SEND_ONLY_TOOLS = new Set(['send_message', 'send_sticker']);

/**
 * 纯函数：本地收尾判定（reply.local-policy 的实现）。
 * 保守规则，任一不满足 → undefined（不干预）：
 *   · 本轮发过消息（newSent 非空）；
 *   · 有工具调用且全部已有结果（没有待执行工具）；
 *   · 本轮所有调用都是纯发送类工具（没有检索/记忆/图片读取之类可能还有下文的）；
 *   · 没有失败结果（失败留给模型重试）；
 *   · 最后一条消息不以问句收尾（在等对方回复，不该结束）。
 * @returns {{shouldEnd:true, reason:string}|undefined}
 */
export function canEndLocally(args = {}, settings = {}) {
  const batch = args?.batch || {};
  if (!settings || settings.enabled !== true) return undefined;
  if (settings.localPolicy !== true) return undefined;
  const newSent = Array.isArray(batch.newSent) ? batch.newSent : [];
  const calls = Array.isArray(batch.calls) ? batch.calls : [];
  const results = Array.isArray(batch.results) ? batch.results : [];
  if (!newSent.length) return undefined;
  if (!calls.length || results.length !== calls.length) return undefined;
  const names = calls.map((call) => String(call?.function?.name || call?.name || ''));
  if (!names.every((name) => SEND_ONLY_TOOLS.has(name))) return undefined;
  const failed = results.some((r) => {
    const content = String(r?.content ?? '');
    return /"ok"\s*:\s*false/.test(content) || /"error"\s*:\s*"/.test(content);
  });
  if (failed) return undefined;
  const last = newSent[newSent.length - 1] || {};
  const lastText = String(last.text ?? last.message ?? '');
  if (/[?？]\s*$/.test(lastText)) return undefined;
  return { shouldEnd: true, reason: '本轮只发送、无待执行工具（本地收尾策略）' };
}

export const hooks = {
  // 契约：messages 是**同一个数组引用**，可原地改；返回值忽略。
  'before-llm-messages': ({ messages, sessionId } = {}) => {
    const settings = getSettings();
    if (!settings || settings.enabled !== true) return;
    const r = trimReadHistory(messages, settings);
    if (!r.trimmedLines) return;
    const key = String(sessionId || '');
    const st = stats.get(key) || { lines: 0, chars: 0 };
    st.lines += r.trimmedLines;
    st.chars += r.trimmedChars;
    stats.set(key, st);
    console.log(`[token-saver] 已读历史裁掉 ${r.trimmedLines} 条（${r.trimmedChars} 字），保留最近 ${Math.max(1, Number(settings.keepLast) || 40)} 条`);
  }
};

export const providers = {
  // 契约：{ api, entries, batch } → { shouldEnd?, budget?, ... }
  'reply.local-policy': (args = {}) => canEndLocally(args, getSettings()),
  // 契约：{ result, usage, ...ctx } → { [字段]: 数值 }（累加进 extraUsage）
  'llm.usage': (args = {}) => {
    const settings = getSettings();
    if (!settings || settings.enabled !== true || settings.countUsage === false) return undefined;
    const key = String(args?.sessionId || '');
    const st = stats.get(key);
    if (!st || !st.lines) return undefined;
    stats.delete(key);   // 上报一次就清零，避免同一批数字在每轮调用里反复累加
    return { tokenSaverTrimmedLines: st.lines };
  }
};
