import { beforeEach, describe, expect, it } from 'vitest';
import {
    BUILTIN_CHENWAN_CHARACTER_ID,
    buildBuiltinCharacterSeeds,
    hasSeededBuiltinCharacter,
    markBuiltinCharacterSeeded,
} from './builtinCharacters';

beforeEach(() => { localStorage.clear(); });

describe('内置角色', () => {
    it('固定 id，人设与世界书都随包带齐', () => {
        const [{ character, worldbooks }] = buildBuiltinCharacterSeeds(1000);
        expect(character.id).toBe(BUILTIN_CHENWAN_CHARACTER_ID);
        expect(character.name).toBe('陈晚');
        expect(character.avatar.startsWith('data:image/svg+xml')).toBe(true);
        expect(character.avatar).not.toContain('base64');
        expect(character.systemPrompt).toContain('{{user}}');
        expect(worldbooks.length).toBeGreaterThan(0);
        expect(worldbooks[0]).toMatchObject({ createdAt: 1000, updatedAt: 1000 });
    });

    it('世界书分类落到角色名下，不残留旧角色名', () => {
        const [{ worldbooks }] = buildBuiltinCharacterSeeds();
        for (const book of worldbooks) {
            expect(book.category).toBe('陈晚');
            expect(book.content).not.toContain('陈砚');
        }
    });

    it('写入记号后不再重复播种', () => {
        expect(hasSeededBuiltinCharacter(BUILTIN_CHENWAN_CHARACTER_ID)).toBe(false);
        markBuiltinCharacterSeeded(BUILTIN_CHENWAN_CHARACTER_ID);
        expect(hasSeededBuiltinCharacter(BUILTIN_CHENWAN_CHARACTER_ID)).toBe(true);
    });
});
