import chenwanCard from '../presets/characters/chenwan.json';
import { CharacterProfile, MountedWorldbook, Worldbook } from '../types';

/**
 * 随应用分发的内置角色。首次启动写进本地库，之后和用户自己建的角色完全一样。
 *
 * 写入过就留一个 localStorage 记号：用户删掉内置角色后，下次启动不会又冒出来。
 * 记号丢了但 IndexedDB 还在时也不会重复写——先按固定 id 查一遍现有角色。
 */
export const BUILTIN_CHENWAN_CHARACTER_ID = 'preset-chenwan-v1';

const SEEDED_KEY_PREFIX = 'sullyos_builtin_char_seeded_';

const CARD = chenwanCard as unknown as Omit<CharacterProfile, 'id' | 'memories'>;

export interface BuiltinCharacterSeed {
    character: CharacterProfile;
    worldbooks: Worldbook[];
}

export function buildBuiltinCharacterSeeds(now = Date.now()): BuiltinCharacterSeed[] {
    const mounted = (CARD.mountedWorldbooks || []) as MountedWorldbook[];
    const worldbooks: Worldbook[] = mounted.map((book, index) => ({
        ...book,
        id: book.id || `wb-builtin-chenwan-${index}`,
        title: book.title || '未命名设定',
        content: book.content || '',
        category: book.category || `${CARD.name} 的世界书`,
        createdAt: now,
        updatedAt: now,
    }));
    const character: CharacterProfile = {
        ...CARD,
        id: BUILTIN_CHENWAN_CHARACTER_ID,
        memories: [],
        refinedMemories: {},
        activeMemoryMonths: [],
        mountedWorldbooks: mounted,
    };
    return [{ character, worldbooks }];
}

export function hasSeededBuiltinCharacter(id: string): boolean {
    try {
        return localStorage.getItem(SEEDED_KEY_PREFIX + id) === '1';
    } catch {
        return true;
    }
}

export function markBuiltinCharacterSeeded(id: string): void {
    try {
        localStorage.setItem(SEEDED_KEY_PREFIX + id, '1');
    } catch {
        /* 写不进去就下次再试，反正先查 id 不会重复写角色。 */
    }
}
