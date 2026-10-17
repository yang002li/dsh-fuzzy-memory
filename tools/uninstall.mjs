/**
 * 卸载 dsh-fuzzy-memory：从 profile 的 package.json 里移除登记，删除拷贝的目录。
 * 记忆文件（data\fuzzy-memory\）保留，想清空就手动删。
 *
 * 用法：
 *   node tools/uninstall.mjs D:\DeepSeek-Harness-Portable-0.2.0-rc.2
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const packageName = 'dsh-fuzzy-memory';

if (!root) {
  console.error('用法：node tools/uninstall.mjs <DSH 便携版根目录>');
  process.exit(1);
}

const profile = join(root, 'data', 'profiles', 'web');
const profilePkg = join(profile, 'package.json');
const dest = join(profile, 'node_modules', packageName);

const pkg = JSON.parse(readFileSync(profilePkg, 'utf8'));
if (pkg.dependencies) delete pkg.dependencies[packageName];
if (pkg.dsh?.profile?.bundles) {
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== packageName);
}
writeFileSync(profilePkg, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
rmSync(dest, { recursive: true, force: true });

console.log('已卸载。重启 DSH 生效；记忆文件仍保留在 data/fuzzy-memory/。');
