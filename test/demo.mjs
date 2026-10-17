/**
 * 独立演示：不依赖 DSH，直接用 node 跑，验证「抽关键词 → 存印象 → 按需想起」这条链路。
 *
 *   node test/demo.mjs
 *
 * 随机数固定种子，所以每次输出一样，方便对照。
 */

import {
  candidates,
  explicitOf,
  pickRandom,
  scoreEntry,
  renderCard,
  effectiveConf,
} from '../lib/pure.js';

/** 固定种子的伪随机数，保证演示可复现。 */
function mulberry32(a) {
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261018);
const memory = [];

function remember(text) {
  const explicit = explicitOf(text);
  const cand = candidates(text);
  const chosen = pickRandom(cand, rand);
  if (!chosen) return null;
  const entry = {
    id: `m${memory.length + 1}`,
    kw: [chosen.kw],
    gist: chosen.gist,
    kind: explicit ? 'explicit' : 'impression',
    conf: explicit ? 0.9 : 0.55,
    t: Date.now(),
    hits: 0,
  };
  memory.push(entry);
  return { entry, chosen, explicit };
}

function recall(query, threshold = 0.5) {
  const now = Date.now();
  const scored = memory
    .map((e) => ({ e, s: scoreEntry(e, query, now, rand) }))
    .sort((a, b) => b.s - a.s);
  const top = scored[0];
  return top && top.s >= threshold ? top : null;
}

const turns = [
  '最近又翻了三体，黑暗森林那段还是很震撼',
  '今天加班到十点，累死了',
  '我最近在学做饭，老是糊锅',
  '记住，我讨厌香菜',
];

console.log('== 对话 ==');
for (const text of turns) {
  console.log(`你：${text}`);
  const hit = remember(text);
  if (hit) {
    console.log(`  → 存下：关键词「${hit.chosen.kw}」 印象「${hit.chosen.gist}」 置信度 ${hit.entry.conf}${hit.explicit ? `（显式触发：${hit.explicit}）` : '（随机采样）'}`);
  } else {
    console.log('  → 没抽到像样的词，这条不存');
  }
}

console.log('\n== 记忆库 ==');
for (const e of memory) {
  console.log(`  · [${e.kw.join('、')}] ${e.gist}  conf=${e.conf.toFixed(2)} 有效=${effectiveConf(e).toFixed(2)}`);
}

console.log('\n== 回忆测试 ==');
for (const q of ['三体好看吗', '你还记得我喜欢什么书吗', '晚饭吃什么好', '做饭又糊锅了']) {
  const hit = recall(q);
  console.log(`你：${q}`);
  console.log(hit ? `  → 想起（${hit.s.toFixed(2)}）：${renderCard(hit.e)}` : '  → 没想起来');
}

console.log('\n== 30 天后 ==');
memory.forEach((e) => { e.t = Date.now() - 30 * 86400000; });
for (const q of ['三体好看吗', '做饭又糊锅了']) {
  const hit = recall(q);
  console.log(`你：${q}`);
  console.log(hit ? `  → 还想得起（${hit.s.toFixed(2)}）：${hit.e.gist}` : '  → 已经淡到想不起来了');
}
