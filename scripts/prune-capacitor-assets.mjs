/**
 * 从 Capacitor 产物里剔除已托管到 NOS CDN 的重资产。
 *
 * 仓库里保留完整资源（浏览器版 / 测试 / 新资源上传都要用），只在打 App 包时删本地副本：
 * 运行时 `utils/nosAssetResolver.ts` 会把清单里的路径直接改写到 CDN，
 * Service Worker 再把命中过的文件缓存在手机本地，所以删掉不影响功能。
 *
 * 额外剔除三类「留了也没人读」的文件，见 REDUNDANT_PATHS。
 */
import { readFile, rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

/** 4K 模型在加载时统一降档到 2K（utils/live2dModelStore.ts），BVH 源动作只在构建期用。 */
const REDUNDANT_FILES = [
    '/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
];
const REDUNDANT_DIRS = [
    '/sully/live2d-4k',
    '/room3d/motions/social-source',
];

async function fileSize(path) {
    try {
        return (await stat(path)).size;
    } catch {
        return 0;
    }
}

async function dirSize(path) {
    if (!existsSync(path)) return 0;
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        total += entry.isDirectory() ? await dirSize(child) : await fileSize(child);
    }
    return total;
}

export async function pruneCapacitorAssets(targetDir = join(ROOT, 'dist')) {
    const publicDir = join(targetDir);
    if (!existsSync(join(publicDir, 'index.html'))) {
        throw new Error(`目标目录不像构建产物（缺少 index.html）：${publicDir}`);
    }

    const manifestPath = join(ROOT, 'utils/nosAssetManifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const mapped = Object.keys(manifest.assets || {});

    let removedCount = 0;
    let removedBytes = 0;
    const missing = [];

    for (const urlPath of mapped) {
        const file = join(publicDir, urlPath);
        if (!existsSync(file)) {
            missing.push(urlPath);
            continue;
        }
        removedBytes += await fileSize(file);
        await rm(file, { force: true });
        removedCount += 1;
    }

    let redundantCount = 0;
    let redundantBytes = 0;
    for (const urlPath of REDUNDANT_FILES) {
        const file = join(publicDir, urlPath);
        if (!existsSync(file)) continue;
        redundantBytes += await fileSize(file);
        await rm(file, { force: true });
        redundantCount += 1;
    }
    for (const urlPath of REDUNDANT_DIRS) {
        const dir = join(publicDir, urlPath);
        if (!existsSync(dir)) continue;
        redundantBytes += await dirSize(dir);
        redundantCount += 1;
        await rm(dir, { recursive: true, force: true });
    }

    const total = removedBytes + redundantBytes;
    return {
        targetDir: publicDir,
        removedCount,
        removedBytes,
        redundantCount,
        redundantBytes,
        missing,
        totalBytes: total,
    };
}

function formatMB(bytes) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
    const target = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'dist');
    const result = await pruneCapacitorAssets(target);
    console.log(`已剔除 CDN 托管资源 ${result.removedCount} 个，${formatMB(result.removedBytes)}`);
    console.log(`已剔除冗余资源 ${result.redundantCount} 项，${formatMB(result.redundantBytes)}`);
    if (result.missing.length > 0) {
        console.log(`清单中有 ${result.missing.length} 项本地不存在（跳过）`);
    }
    console.log(`合计减少 ${formatMB(result.totalBytes)}`);
}
