/**
 * 打包成 npm 风格的 .tgz（package/ 前缀），不依赖 npm 或外部 tar 工具。
 *
 *   node tools/pack.mjs
 *
 * 产物：dist/dsh-fuzzy-memory-<version>.tgz
 * 可以直接 `npm publish dist/xxx.tgz`，也可以发给别人离线安装。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const INCLUDE_FILES = ['package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE'];
const INCLUDE_DIRS = ['lib'];

/** 递归收集要打进包里的文件，返回 [相对路径, 绝对路径] 列表。 */
function collect() {
  const out = [];
  for (const name of INCLUDE_FILES) {
    const abs = join(root, name);
    if (existsSync(abs)) out.push([name, abs]);
  }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push([relative(root, abs).split('\\').join('/'), abs]);
    }
  };
  for (const name of INCLUDE_DIRS) {
    const abs = join(root, name);
    if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/** 写一个 512 字节的 tar 头。 */
function tarHeader(name, size, mtime) {
  const buf = Buffer.alloc(512, 0);
  const oct = (n, len) => `${n.toString(8).padStart(len - 1, '0')}\0`;
  buf.write(name, 0, 100, 'utf8');
  buf.write(oct(0o644, 8), 100, 8, 'ascii');
  buf.write(oct(0, 8), 108, 8, 'ascii');
  buf.write(oct(0, 8), 116, 8, 'ascii');
  buf.write(oct(size, 12), 124, 12, 'ascii');
  buf.write(oct(Math.floor(mtime / 1000), 12), 136, 12, 'ascii');
  buf.fill(0x20, 148, 156);
  buf.write('0', 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return buf;
}

const files = collect();
const chunks = [];
let total = 0;

for (const [rel, abs] of files) {
  const data = readFileSync(abs);
  // npm 包内的路径统一带 package/ 前缀
  const name = `package/${rel}`;
  if (Buffer.byteLength(name, 'utf8') > 99) {
    throw new Error(`路径太长，tar 头放不下：${name}`);
  }
  const header = tarHeader(name, data.length, statSync(abs).mtimeMs);
  chunks.push(header, data);
  const pad = (512 - (data.length % 512)) % 512;
  if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  total += 512 + data.length + pad;
}

// 两个 512 字节的结束块
chunks.push(Buffer.alloc(1024, 0));
total += 1024;

const tarball = Buffer.concat(chunks);
const gz = gzipSync(tarball, { level: 9 });

const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
const outFile = join(dist, `${pkg.name}-${pkg.version}.tgz`);
writeFileSync(outFile, gz);

console.log(`打包完成：${outFile}`);
console.log(`版本：${pkg.version}  条目：${files.length}  压缩后：${(gz.length / 1024).toFixed(1)} KB`);
for (const [rel] of files) console.log(`  package/${rel}`);
