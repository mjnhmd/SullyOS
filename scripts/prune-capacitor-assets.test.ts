import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pruneCapacitorAssets } from './prune-capacitor-assets.mjs';

let dir: string;
let mappedAsset: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prune-capacitor-'));
    await writeFile(join(dir, 'index.html'), '<html></html>');
    const manifest = JSON.parse(await readFile(new URL('../utils/nosAssetManifest.json', import.meta.url), 'utf8'));
    mappedAsset = Object.keys(manifest.assets).find(path => path.startsWith('/room3d/wardrobe/'))!;
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const exists = async (path: string) => {
    try { await stat(path); return true; } catch { return false; }
};

describe('Capacitor 产物剔除', () => {
    it('删掉 CDN 清单里的文件与冗余重资产，保留其余文件', async () => {
        const assetPath = join(dir, mappedAsset);
        await mkdir(dirname(assetPath), { recursive: true });
        await writeFile(assetPath, 'x');
        await mkdir(join(dir, 'sully/live2d-4k/Sully.4096'), { recursive: true });
        await mkdir(join(dir, 'room3d/motions/social-source'), { recursive: true });
        await writeFile(join(dir, 'sully/live2d-4k/Sully.4096/texture_00.png'), 'xxxx');
        await writeFile(join(dir, 'room3d/motions/social-source/13_17.bvh'), 'xx');
        await writeFile(join(dir, 'keep.txt'), 'keep');

        const result = await pruneCapacitorAssets(dir);

        expect(await exists(assetPath)).toBe(false);
        expect(await exists(join(dir, 'sully/live2d-4k'))).toBe(false);
        expect(await exists(join(dir, 'room3d/motions/social-source'))).toBe(false);
        expect(await exists(join(dir, 'keep.txt'))).toBe(true);
        expect(await exists(join(dir, 'index.html'))).toBe(true);
        expect(result.removedBytes).toBeGreaterThan(0);
        expect(result.redundantBytes).toBeGreaterThan(0);
    });

    it('拒绝清理不像构建产物的目录', async () => {
        const empty = await mkdtemp(join(tmpdir(), 'prune-empty-'));
        await expect(pruneCapacitorAssets(empty)).rejects.toThrow(/index\.html/);
        await rm(empty, { recursive: true, force: true });
    });
});
