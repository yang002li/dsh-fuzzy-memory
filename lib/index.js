/**
 * dsh-fuzzy-memory —— DSH 模糊记忆插件（host 侧）
 *
 * 做什么：
 *   - 陪伴模式开启时，从用户每句话里偶尔随机抽一个关键词，配一句话印象，存本地；
 *   - 每轮对话前在本地用关键词给所有记忆打分，命中一条就注入「你模糊记得……」
 *     （注入是一条独立的 user 消息，不动系统提示词前缀，所以不破坏缓存）；
 *   - 提供 fuzzy_remember / fuzzy_recall 两个工具，让模型主动记和主动想；
 *   - 30 天没被想起的记忆慢慢变淡，低于阈值不再出现。
 *
 * 关闭时 apply 直接返回，不注册任何东西，等于官方原生模式。
 */

import { mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

import {
  PLUGIN_NAME,
  candidates,
  explicitOf,
  explicitFact,
  normalizeProfileGist,
  pickRandom,
  scoreEntry,
  renderCard,
  effectiveConf,
  similarity,
  rank,
} from './pure.js';

/** Cordis 插件名（loader 诊断用）。 */
export const name = PLUGIN_NAME;

/** 依赖的服务：工具注册表、系统提示、agent 注册表（pre-step 事件）。 */
export const inject = ['tools', 'systemPrompt', 'agents'];

/** 插件配置。开启开关在 DSH「设置 → 插件」里对应本插件的表单。 */
export const Config = z.object({
  /** 总开关。关闭时插件不注册任何提示段、工具与钩子。 */
  enabled: z.boolean().default(false),
  /** 可选：基础人设。填了会追加到系统提示词末尾。 */
  persona: z.string().default(''),
  /** 是否让人设替换整个系统提示词（会盖掉编码 agent 那段）。与 minimal 预设的 complete 人设同时开会冲突。 */
  personaComplete: z.boolean().default(false),
  /** 随机记忆采样率：每句话有多少概率被抽一条印象存下来。 */
  sampleRate: z.number().default(0.35),
  /** 检索阈值：分数低于它的记忆不会被注入。 */
  threshold: z.number().default(0.5),
  /** 记忆库上限，超过后按「可信度 × 新鲜度」淘汰。 */
  maxEntries: z.number().default(300),
  /** 同一条记忆两次出现之间至少隔几个回合（防刷屏）。 */
  cooldownTurns: z.number().default(2),
  /** 是否注册 fuzzy_remember / fuzzy_recall 两个工具（关掉省约 240 token/轮）。 */
  enableTools: z.boolean().default(true),
});

/** 数值夹取。 */
function clamp(n, lo = 0, hi = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** 本地 JSONL 记忆库。 */
class Store {
  constructor(dir, max = 300) {
    this.dir = dir;
    this.max = Math.max(10, Number(max) || 300);
    this.file = join(dir, 'memories.jsonl');
    this.entries = [];
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* 目录已存在或不可写，读取会再兜底一次 */
    }
    try {
      const raw = readFileSync(this.file, 'utf8');
      for (const line of raw.split(/\r?\n/u)) {
        const s = line.trim();
        if (!s) continue;
        try {
          const e = JSON.parse(s);
          if (e && Array.isArray(e.kw) && typeof e.gist === 'string') {
            // 旧版本存的是原句（「记住我叫阳阳」），读取时归一化成「他叫阳阳」
            if (e.kind === 'profile') e.gist = normalizeProfileGist(e.gist);
            this.entries.push(e);
          }
        } catch {
          /* 坏行跳过，不影响其他记忆 */
        }
      }
    } catch {
      /* 首次运行没有文件 */
    }
  }

  size() {
    return this.entries.length;
  }

  /** 追加一条；重复（同关键词 + 高相似印象）只提升置信度。 */
  add(input, confOverride) {
    const now = Date.now();
    const kw = (input.keywords ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 6);
    const gist = String(input.gist ?? '').trim().slice(0, 60);
    if (kw.length === 0 || !gist) return null;

    const dup = this.entries.find(
      (e) => e.gist === gist || (e.kw?.[0] && kw[0] && e.kw[0] === kw[0] && similarity(e.gist, gist) > 0.8),
    );
    if (dup) {
      dup.conf = Math.min(1, (dup.conf ?? 0.6) + 0.1);
      dup.t = now;
      this.flush();
      return dup;
    }

    const entry = {
      id: randomUUID(),
      kw,
      gist,
      kind: input.kind ?? 'impression',
      conf: clamp(confOverride ?? input.conf ?? 0.6),
      t: now,
      hits: 0,
    };
    this.entries.push(entry);
    try {
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      /* 落盘失败不阻塞对话 */
    }
    this.trim();
    return entry;
  }

  /** 超上限时按排序权重淘汰。 */
  trim(max = this.max) {
    if (!max || this.entries.length <= max) return;
    const now = Date.now();
    this.entries.sort((a, b) => rank(b, now) - rank(a, now));
    this.entries = this.entries.slice(0, max);
    this.flush();
  }

  /** 全量重写（去重、淘汰后调用）。 */
  flush() {
    try {
      writeFileSync(this.file, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    } catch {
      /* 忽略 */
    }
  }

  /** 给当前输入找出最该想起来的一条。 */
  retrieve(query, threshold) {
    const now = Date.now();
    let best = null;
    let bestScore = 0;
    for (const e of this.entries) {
      const s = scoreEntry(e, query, now) * (0.7 + 0.3 * effectiveConf(e, now));
      if (s > bestScore) {
        bestScore = s;
        best = e;
      }
    }
    if (!best || bestScore < threshold) return null;
    best.hits = (best.hits ?? 0) + 1;
    best.lastHit = now;
    this.flush();
    return { entry: best, score: bestScore };
  }

  /** 从一句话里随机抽一条印象存下来（显式事实 / 显式触发词优先）。 */
  consider(text, sampleRate) {
    const raw = String(text ?? '').trim();
    if (raw.length < 3) return null;

    // 显式事实（我叫阳阳 / 我喜欢喝乌龙茶）→ 核心档案，永远记，置信度 1
    const fact = explicitFact(raw);
    if (fact) {
      return this.add({ keywords: [fact.kw], gist: fact.gist, kind: 'profile' }, 1);
    }

    if (raw.length < 6) return null;
    const explicit = explicitOf(raw);
    if (!explicit && Math.random() > sampleRate) return null;

    const cand = candidates(raw);
    const chosen = pickRandom(cand);
    if (!chosen) return null;

    return this.add(
      {
        keywords: [chosen.kw],
        gist: chosen.gist,
        kind: explicit ? 'explicit' : 'impression',
      },
      explicit ? 0.9 : 0.55,
    );
  }
}

/** 从 pre-step 的 admitted messages 里取出真实用户文本。 */
function userText(messages) {
  const parts = [];
  for (const m of messages ?? []) {
    if (!m || m.role !== 'user') continue;
    if (m.source && m.source.kind !== 'user') continue;
    for (const block of m.content ?? []) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** 核心档案卡：名字、喜好这类显式事实，每个会话必带。 */
function profileCard(store) {
  const items = store.entries
    .filter((e) => e.kind === 'profile' && typeof e.gist === 'string' && e.gist.trim())
    .slice(-8)
    .map((e) => e.gist.trim());
  if (items.length === 0) return '';
  return `（你记得关于他的事：${items.join('；')}。）`;
}

/** 每个 agent 会话一份小状态：最近注入过哪条、第几回合。 */
const states = new WeakMap();

function stateOf(agent) {
  const key = agent?.session ?? agent;
  if (!key) return { byId: new Map() };
  let st = states.get(key);
  if (!st) {
    st = { byId: new Map(), profileText: '' };
    states.set(key, st);
  }
  return st;
}

/**
 * 插件入口。任何异常都在这里兜住，避免拖垮 DSH 启动。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  try {
    applyInner(ctx, config);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[dsh-fuzzy-memory] 加载失败：', error);
  }
}

function applyInner(ctx, config) {
  const enabled = config?.enabled === true;
  if (!enabled) return;

  const dir = join(resolveDshHome(), 'fuzzy-memory');
  const threshold = clamp(config.threshold, 0, 1);
  const sampleRate = clamp(config.sampleRate, 0, 1);
  const cooldownTurns = Math.max(0, Number(config.cooldownTurns) || 0);
  const maxEntries = Math.max(10, Number(config.maxEntries) || 300);
  const store = new Store(dir, maxEntries);

  // 可选人设。默认只追加；打开 personaComplete 才会替换整个系统提示词。
  if (typeof config.persona === 'string' && config.persona.trim()) {
    try {
      ctx.systemPrompt.section({
        name: `${PLUGIN_NAME}:persona`,
        order: 1,
        complete: config.personaComplete === true,
        interpolate: false,
        text: config.persona,
      });
    } catch {
      /* 已存在同名 complete 段时不要炸掉整个会话 */
    }
  }

  // 工具一：主动记（enableTools=false 时不注册，省 token）
  if (config.enableTools !== false) try {
    ctx.tools.register(
      defineTool({
        name: 'fuzzy_remember',
        description:
          '把一件值得长期记住的事写进模糊记忆。keywords 给 2-5 个锚点词（书名、人名、地点、事件），gist 写一句 10-20 字的印象。',
        parameters: {
          keywords: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: '2-5 个关键词锚点',
          },
          gist: { type: 'string', required: true, description: '一句话印象，10-20 字' },
          kind: {
            type: 'string',
            enum: ['preference', 'event', 'relation', 'promise', 'emotion'],
            description: '记忆类型，默认 event',
          },
          confidence: { type: 'number', description: '0-1 的置信度，默认 0.7' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              id: { type: 'string', required: true },
              total: { type: 'integer', required: true },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: value.ok ? `已记住（库存 ${value.total} 条）` : '没记住：内容为空' },
          ],
        },
        execute(args) {
          const entry = store.add({
            keywords: args.keywords,
            gist: args.gist,
            kind: args.kind ?? 'event',
            conf: clamp(args.confidence ?? 0.7),
          });
          return Promise.resolve({
            ok: Boolean(entry),
            id: entry?.id ?? '',
            total: store.size(),
          });
        },
      }),
    );
  } catch {
    /* 工具注册失败不影响记忆检索 */
  }

  // 工具二：主动想（enableTools=false 时不注册）
  if (config.enableTools !== false) try {
    ctx.tools.register(
      defineTool({
        name: 'fuzzy_recall',
        description:
          '按关键词或一句话检索模糊记忆，返回最像的几条印象。用户问起关于他自己的事（名字、喜好、住址、约定）而你记不清时，先调用它再回答。',
        parameters: {
          query: { type: 'string', required: true, description: '要回忆的关键词或一句话' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              matches: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    keywords: { type: 'array', required: true, items: { type: 'string' } },
                    gist: { type: 'string', required: true },
                    confidence: { type: 'number', required: true },
                  },
                },
              },
            },
          },
          render: (_args, value) =>
            value.matches.length === 0
              ? [{ type: 'text', text: '没想起来。' }]
              : value.matches.map((m) => ({
                  type: 'text',
                  text: `· ${m.gist}（关键词：${m.keywords.join('、')}，把握 ${Math.round(m.confidence * 100)}%）`,
                })),
        },
        execute(args) {
          const now = Date.now();
          const scored = store.entries
            .map((e) => ({ entry: e, score: scoreEntry(e, args.query, now) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .filter((x) => x.score > 0.3);
          return Promise.resolve({
            matches: scored.map((x) => ({
              keywords: x.entry.kw,
              gist: x.entry.gist,
              confidence: Number(effectiveConf(x.entry, now).toFixed(2)),
            })),
          });
        },
      }),
    );
  } catch {
    /* 同上 */
  }

  // 每轮模型调用前：先决定记不记，再决定想不想得起来。
  ctx.on(
    'agent/pre-step',
    async ({ agent, messages, turn, step, signal }, next) => {
      const decision = await next();
      try {
        if (decision.kind === 'reject' || signal?.aborted) return decision;
        if (step !== 1) return decision;

        const text = userText(decision.messages);
        if (!text) return decision;

        const st = stateOf(agent);
        const extra = [];

        // 1) 核心档案：每个会话开头带一次；档案有更新时再带一次
        const prof = profileCard(store);
        if (prof && st.profileText !== prof) {
          st.profileText = prof;
          extra.push(prof);
        }

        // 2) 先想旧印象（先检索，避免把这一轮刚存的新记忆立刻翻出来）
        const hit = store.retrieve(text, threshold);

        // 3) 再决定要不要存新记忆
        store.consider(text, sampleRate);

        if (hit) {
          const lastTurn = st.byId.get(hit.entry.id);
          const cooling = typeof lastTurn === 'number' && turn - lastTurn < cooldownTurns;
          if (!cooling) {
            st.byId.set(hit.entry.id, turn);
            if (st.byId.size > 64) st.byId.clear();
            const card = renderCard(hit.entry);
            if (card) extra.push(card);
          }
        }

        if (extra.length === 0) return decision;

        return {
          ...decision,
          messages: [
            ...decision.messages,
            ...extra.map((card) =>
              createUserMessage({
                content: [{ type: 'text', text: card }],
                source: {
                  kind: PLUGIN_NAME,
                  form: 'snapshot',
                  sections: [{ name: PLUGIN_NAME, text: card }],
                },
              }),
            ),
          ],
        };
      } catch {
        return decision;
      }
    },
    { prepend: true },
  );

  // 启动时清一次明显已经淡忘的记忆，避免库越滚越大。
  try {
    const kept = store.entries.filter((e) => effectiveConf(e) >= 0.25);
    if (kept.length !== store.entries.length) {
      store.entries = kept;
      store.flush();
    }
    store.trim(maxEntries);
  } catch {
    /* 忽略 */
  }
}
