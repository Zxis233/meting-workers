import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(rootDir, 'wrangler.toml');
const outputPath = resolve(rootDir, '.wrangler', 'wrangler.generated.toml');

const namespaceId = process.env.METING_KV_NAMESPACE_ID || process.env.KV_NAMESPACE_ID;
const previewNamespaceId = process.env.METING_KV_PREVIEW_NAMESPACE_ID || process.env.KV_PREVIEW_NAMESPACE_ID || '';
const binding = process.env.METING_KV_BINDING || 'METING_COOKIE_KV';

if (!namespaceId) {
    console.error('Missing METING_KV_NAMESPACE_ID. Set it from your Cloudflare KV namespace id before deploying.');
    process.exit(1);
}

const source = await readFile(sourcePath, 'utf8');
if (/^\s*\[\[kv_namespaces\]\]/m.test(source)) {
    console.error('wrangler.toml already contains a kv_namespaces block. Remove it before generating a private deploy config.');
    process.exit(1);
}

const kvBlock = [
    '',
    '[[kv_namespaces]]',
    `binding = ${JSON.stringify(binding)}`,
    `id = ${JSON.stringify(namespaceId)}`,
    previewNamespaceId ? `preview_id = ${JSON.stringify(previewNamespaceId)}` : '',
].filter(Boolean).join('\n');

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${source.trimEnd()}\n${kvBlock}\n`, 'utf8');

console.log(`Generated ${outputPath}`);
