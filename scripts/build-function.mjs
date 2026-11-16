import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'functions');
const cloud = join(root, 'cloud');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const f of ['api.js', 'llm.js', 'agent.js', 'local.js']) {
  await copyFile(join(cloud, 'lib', f), join(out, f));
}
for (const f of ['persona.json', 'corpus.json']) {
  await copyFile(join(cloud, f), join(out, f));
}

// prompt.js 的 Node 版用 fs 读 JSON；Deno 包改成 JSON import attributes，其余逐字保留。
const promptSrc = await readFile(join(cloud, 'lib', 'prompt.js'), 'utf8');
const marker = "export const corpus = load('corpus.json');";
const idx = promptSrc.indexOf(marker);
if (idx < 0) throw new Error('prompt.js 结构变了：找不到 corpus 加载标记，请同步更新本脚本');
const header = "import personaJson from './persona.json' with { type: 'json' };\n"
  + "import corpusJson from './corpus.json' with { type: 'json' };\n"
  + 'export const persona = personaJson;\n'
  + 'export const corpus = corpusJson;\n';
await writeFile(join(out, 'prompt.js'), header + promptSrc.slice(idx + marker.length), 'utf8');

await copyFile(join(cloud, 'sites', 'store-db.js'), join(out, 'store.js'));
await copyFile(join(cloud, 'sites', 'index.ts'), join(out, 'index.ts'));

console.log('[build-function] functions/ 组装完成：index.ts api.js llm.js agent.js local.js prompt.js store.js persona.json corpus.json');