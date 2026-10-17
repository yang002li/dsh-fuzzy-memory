/**
 * 安装 dsh-fuzzy-memory 到 DSH 便携版的 web profile。
 *
 * 三步：
 *   1. 自检记忆内核（纯函数，不依赖 DSH）
 *   2. 拷插件进 profile 的 node_modules 并登记到 package.json 的 bundles
 *   3. 用 node 真 import 一次，确认语法和依赖解析；失败自动回滚
 *
 * 用法：
 *   node tools/install.mjs D:\DeepSeek-Harness-Portable-0.2.0-rc.2
 */

import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { candidates, explicitOf, explicitFact, scoreEntry, renderCard } from '../lib/pure.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const root = process.argv[2];
const packageName = 'dsh-fuzzy-memory';

if (!root) {
  console.error('用法：node tools/install.mjs <DSH 便携版根目录>');
  process.exit(1);
}

// ---------- 1. 内核自检 ----------
console.log('[1/3] 自检记忆内核...');
const cand = candidates('最近又翻了三体，黑暗森林那段还是很震撼');
if (!cand.some((c) => c.kw === '三体')) {
  console.error('自检失败：没有抽到「三体」，抽到的是', cand.map((c) => c.kw).join('、'));
  process.exit(1);
}
const sample = {
  id: 'self-test',
  kw: ['三体'],
  gist: '黑暗森林那段还是很震撼',
  conf: 0.9,
  t: Date.now(),
  hits: 0,
};
const score = scoreEntry(sample, '三体好看吗');
if (score < 0.5) {
  console.error(`自检失败：三体记忆匹配分数过低 ${score.toFixed(2)}`);
  process.exit(1);
}
if (!renderCard(sample).includes('黑暗森林')) {
  console.error('自检失败：记忆卡渲染异常');
  process.exit(1);
}
const fact = explicitFact('记住我叫阳阳');
if (!fact || fact.kw !== '阳阳') {
  console.error('自检失败：显式事实没有抽到「阳阳」，得到', fact);
  process.exit(1);
}
if (explicitFact('我叫啥') !== null) {
  console.error('自检失败：问句「我叫啥」被误当成事实');
  process.exit(1);
}
console.log(`      通过：抽词「${cand[0].kw}」、匹配分 ${score.toFixed(2)}、显式触发「${explicitOf('记住，我讨厌香菜')}」、名字「${fact.kw}」`);

// ---------- 2. 拷贝 + 登记 ----------
const profile = join(root, 'data', 'profiles', 'web');
const profilePkg = join(profile, 'package.json');
const dest = join(profile, 'node_modules', packageName);
const backup = `${profilePkg}.bak-fuzzy-memory`;

if (!existsSync(profilePkg)) {
  console.error(`找不到 ${profilePkg}，确认 DSH 安装目录是否正确。`);
  process.exit(1);
}

console.log('[2/3] 安装到 web profile...');
console.log(`      插件目录：${pluginDir}`);
console.log(`      目标目录：${dest}`);

// 覆盖安装前先备份旧目录，验证失败时能还原，避免 DSH 启动时找不到包
const oldDir = `${dest}.bak`;
rmSync(oldDir, { recursive: true, force: true });
if (existsSync(dest)) {
  renameSync(dest, oldDir);
}
mkdirSync(dest, { recursive: true });
cpSync(join(pluginDir, 'lib'), join(dest, 'lib'), { recursive: true });
copyFileSync(join(pluginDir, 'package.json'), join(dest, 'package.json'));
copyFileSync(join(pluginDir, 'cordis.patch.yml'), join(dest, 'cordis.patch.yml'));

const original = readFileSync(profilePkg, 'utf8');
writeFileSync(backup, original, 'utf8');
const pkg = JSON.parse(original);
pkg.dsh = pkg.dsh ?? {};
pkg.dsh.profile = pkg.dsh.profile ?? {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? [];
if (!pkg.dsh.profile.bundles.includes(packageName)) pkg.dsh.profile.bundles.push(packageName);
writeFileSync(profilePkg, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`      已登记（备份：${backup}）`);

// ---------- 3. 真 import 验证 ----------
console.log('[3/3] 验证插件能否被加载...');
const probe = join(profile, '_fuzzy-memory-check.mjs');
writeFileSync(
  probe,
  `import('${packageName}').then((m) => { console.log('EXPORTS:' + Object.keys(m).sort().join(',')); });\n`,
  'utf8',
);
const check = spawnSync(process.execPath, [probe], { cwd: profile, encoding: 'utf8' });
rmSync(probe, { force: true });

if (check.status !== 0) {
  console.error('模块加载失败，已回滚：');
  console.error(check.stderr || check.stdout);
  writeFileSync(profilePkg, original, 'utf8');
  rmSync(dest, { recursive: true, force: true });
  if (existsSync(oldDir)) renameSync(oldDir, dest);
  process.exit(1);
}

rmSync(oldDir, { recursive: true, force: true });
console.log(check.stdout.trim());
console.log('安装完成。重启 DSH 生效（默认已开启）。');
