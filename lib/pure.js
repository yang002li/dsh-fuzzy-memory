/**
 * dsh-fuzzy-memory / pure logic
 *
 * 记忆内核的纯函数部分：不 import 任何 DSH 或 Node 模块，因此可以被单测
 * 和 test/demo.mjs 直接跑。这里只有三件事：
 *
 *   1. candidates(text)  从一句话里抽候选关键词（中文按 2~4 字窗口 + 停用字过滤）
 *   2. scoreEntry(...)   用当前输入给一条记忆打分（关键词重合 + 时间衰减 + 抖动）
 *   3. 衰减、渲染、去重等小工具
 *
 * 设计原则：宁可漏，不可错。抽不到像样的词就不存，别把「今天」「一下」存进去。
 */

export const PLUGIN_NAME = 'dsh-fuzzy-memory';

/** 整词停用词：这些词单独出现时没有记忆价值。 */
const STOPWORDS = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '大家',
  '今天', '明天', '昨天', '现在', '刚才', '最近', '以后', '以前', '时候',
  '这个', '那个', '这些', '那些', '这里', '那里', '这样', '那样',
  '什么', '怎么', '为什么', '因为', '所以', '但是', '然后', '就是', '还是',
  '已经', '可以', '觉得', '知道', '一下', '有点', '真的', '其实', '应该',
  '可能', '没有', '不是', '好的', '嗯', '哦', '啊', '吧', '呢', '吗', '呀',
  '一个', '一直', '一些', '如果', '虽然', '不过', '而且', '或者', '正在',
  '东西', '事情', '问题', '感觉', '比较', '非常', '特别', '有点', '有点',
]);

/** 停用字：候选词里只要含这些字就丢掉（虚词、代词、常见动词）。 */
const STOP_CHARS = new Set([
  '的', '了', '着', '过', '吗', '呢', '吧', '啊', '嗯', '哦', '呀', '嘛',
  '我', '你', '他', '她', '它', '咱', '这', '那', '哪', '什', '么',
  '是', '在', '把', '被', '让', '给', '对', '从', '到', '和', '与', '跟',
  '就', '都', '也', '又', '还', '很', '太', '更', '最', '不', '没', '别',
  '会', '能', '要', '想', '说', '看', '去', '来', '上', '下', '里', '外',
  '而', '且', '或', '但', '却', '因', '为', '所', '以', '如', '果', '虽',
  '然', '已', '经', '正', '在', '将', '把', '着', '得', '地',
]);

/** 显式记忆触发词：出现时无条件记一条，置信度最高。 */
const EXPLICIT_RE = /(记住|帮我记|记一下|别忘了|我喜欢|我讨厌|我叫|我住|生日|下次|以后都)/u;

/**
 * 显式事实：从「我叫阳阳」「我喜欢喝乌龙茶」这类句子里直接抽事实值。
 * 这类事实是「核心档案」，不参与随机采样，也不靠关键词碰运气。
 */
const FACT_RE = /(?:我叫|我的名字是|我住在|我住|我喜欢|我讨厌|我爱吃|我爱|我养了|我是|我的生日是|生日是|叫我)[：:，,\s]*([^，。！？；、,.!?;\s]{1,12})/u;

/**
 * 把「记住我叫阳阳」这类原句归一化成档案口吻：「他叫阳阳」。
 * 旧记忆文件里存的是原句，读取时也走这里，不用删档。
 */
export function normalizeProfileGist(text) {
  return String(text ?? '')
    .trim()
    .replace(/^(记住|帮我记|记一下|别忘了|请记住)[，,：:\s]*/u, '')
    .replace(/^我/u, '他')
    .slice(0, 40);
}

/**
 * 抽取显式事实。
 * @returns {{kw: string, gist: string} | null} kw 是事实值本身（如「阳阳」），gist 是归一化后的档案句
 */
export function explicitFact(text) {
  const raw = String(text ?? '').trim();
  // 问句不是事实：「我叫啥」「我叫什么」不能存成档案
  if (/[?？]\s*$/u.test(raw)) return null;
  const m = FACT_RE.exec(raw);
  if (!m) return null;
  const value = m[1].replace(/[^\u3400-\u9fffA-Za-z0-9_]/gu, '');
  if (value.length === 0) return null;
  if (/^(什么|啥|谁|哪|多少|几)/u.test(value)) return null;
  return { kw: value, gist: normalizeProfileGist(raw) };
}

/** 判断一个字符是否为中日韩统一表意文字。 */
function isCjk(ch) {
  return /[\u3400-\u9fff]/u.test(ch);
}

/** 归一化：小写、去掉空白与标点，用于匹配。 */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）()《》【】\[\]{}<>,.!?;:'"|/\\~`@#$%^&*+=_-]+/gu, '');
}

/** 按标点/空白切成小句。 */
export function clauses(text) {
  return String(text ?? '')
    .split(/[\s，。！？、；：""''（）()《》【】\[\]{}<>,.!?;:'"|/\\~`@#$%^&*+=_-]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 字符二元组。 */
export function bigrams(text) {
  const s = normalize(text);
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 1) out.push(s.slice(i, i + 2));
  return out;
}

/** 两个短文本的二元组 Jaccard 相似度，用于合并重复记忆。 */
export function similarity(a, b) {
  const A = new Set(bigrams(a));
  const B = new Set(bigrams(b));
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / (A.size + B.size - hit);
}

/** 找到包含关键词的那一小句，截成 24 字左右的印象。 */
export function gistOf(clause, keyword) {
  const text = String(clause ?? '').trim();
  if (!text) return keyword;
  if (text.length <= 24) return text;
  const idx = Math.max(0, text.indexOf(keyword));
  const start = Math.max(0, idx - 8);
  const body = text.slice(start, start + 24);
  return `${start > 0 ? '…' : ''}${body}${start + 24 < text.length ? '…' : ''}`;
}

/**
 * 从一段话里抽候选关键词。
 * 中文没有分词器，这里用「2~4 字窗口 + 停用字过滤 + 取最长不重叠」近似，
 * 效果不完美，但足够抽到「三体」「黑暗森林」这类实体，且零依赖。
 * @returns {{kw: string, gist: string}[]}
 */
export function candidates(text) {
  const out = [];
  const seen = new Set();

  const push = (kw, clause) => {
    const word = String(kw ?? '').trim();
    if (word.length < 2 || word.length > 6) return;
    if (STOPWORDS.has(word)) return;
    for (const ch of word) if (STOP_CHARS.has(ch)) return;
    if (seen.has(word)) return;
    seen.add(word);
    out.push({ kw: word, gist: gistOf(clause, word) });
  };

  for (const clause of clauses(text)) {
    const seg = clause.replace(/[^\u3400-\u9fffA-Za-z0-9]/gu, '');

    // 英文/型号类词：v4、GPT、RTX4090
    for (const m of clause.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,}/gu)) push(m[0].toLowerCase(), clause);

    // 中文：从长到短取窗口，短的若被长的包含则丢弃
    const kept = [];
    for (let n = 4; n >= 2; n -= 1) {
      for (let i = 0; i + n <= seg.length; i += 1) {
        const t = seg.slice(i, i + n);
        if (!/^[\u3400-\u9fff]+$/u.test(t)) continue;
        if (STOPWORDS.has(t)) continue;
        let bad = false;
        for (const ch of t) if (STOP_CHARS.has(ch)) { bad = true; break; }
        if (bad) continue;
        if (kept.some((k) => k.includes(t))) continue;
        const shorter = kept.findIndex((k) => t.includes(k));
        if (shorter >= 0) kept.splice(shorter, 1);
        kept.push(t);
      }
    }
    for (const word of kept) push(word, clause);
  }

  return out;
}

/** 显式记忆触发词，返回命中的词或 null。 */
export function explicitOf(text) {
  const m = EXPLICIT_RE.exec(String(text ?? ''));
  return m ? m[0] : null;
}

/** 从候选里随机挑一个（这是「呆傻感」的来源之一）。 */
export function pickRandom(list, rand = Math.random) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[Math.floor(rand() * list.length) % list.length];
}

/** 记忆的有效置信度：每过 30 天打八折，但只读不改写。 */
export function effectiveConf(entry, now = Date.now()) {
  const base = typeof entry?.conf === 'number' ? entry.conf : 0.6;
  const ageDays = Math.max(0, (now - (entry?.t ?? now)) / 86400000);
  const periods = Math.floor(ageDays / 30);
  return base * 0.8 ** periods;
}

/**
 * 给一条记忆相对于当前输入打分。
 * 关键词重合 0.6 + 新鲜度 0.2 + 置信度 0.1 + 随机抖动 0.1。
 * 抖动是故意的：同一句话有时想得起、有时想不起。
 */
export function scoreEntry(entry, query, now = Date.now(), rand = Math.random) {
  const q = normalize(query);
  if (!q) return 0;

  let overlap = 0;
  for (const raw of entry?.kw ?? []) {
    const k = normalize(raw);
    if (!k) continue;
    if (q.includes(k)) { overlap = Math.max(overlap, 1); continue; }
    const grams = bigrams(k);
    if (grams.length === 0) continue;
    const qs = new Set(bigrams(q));
    let hit = 0;
    for (const g of grams) if (qs.has(g)) hit += 1;
    overlap = Math.max(overlap, hit / grams.length);
  }

  const ageDays = Math.max(0, (now - (entry?.t ?? now)) / 86400000);
  const recency = Math.exp(-ageDays / 30);
  return 0.6 * overlap + 0.2 * recency + 0.1 * effectiveConf(entry, now) + 0.1 * rand();
}

/** 丢弃已经淡到几乎不存在的记忆，并返回新数组。 */
export function decayEntries(entries, now = Date.now()) {
  return entries.filter((e) => effectiveConf(e, now) >= 0.25);
}

/** 记忆卡：注入给模型的提示文本。 */
export function renderCard(entry) {
  const gist = String(entry?.gist ?? '').trim();
  if (!gist) return '';
  return `（你模糊记得：${gist}。不太确定，别说得太肯定。）`;
}

/** 排序权重：越可信、越新、被想起过越多次，越靠前。 */
export function rank(entry, now = Date.now()) {
  const ageDays = Math.max(0, (now - (entry?.t ?? now)) / 86400000);
  return effectiveConf(entry, now) * Math.exp(-ageDays / 30) + 0.05 * (entry?.hits ?? 0);
}
