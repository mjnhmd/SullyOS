import type { CharacterProfile, TavernRegexRule, Worldbook } from '../types';
import { parseStandardWorldbook, toMountedWorldbook } from './worldbook';
import { pngHasShare, readShareText } from './pngShare';
import { stripSensitiveCardFields } from './characterCard';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPngBytes(bytes: Uint8Array): boolean {
    return bytes.length >= 8 && PNG_SIGNATURE.every((b, idx) => bytes[idx] === b);
}

function decodeBase64Utf8(base64Str: string): string {
    const cleaned = base64Str.replace(/\s+/g, '');
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Extract SillyTavern character card JSON from PNG `tEXt` or `iTXt` chunks.
 * Supports both Tavern Card V3 (`ccv3`) and V2 (`chara`), preferring `ccv3` when both exist.
 */
export function extractTavernCardFromPng(bytes: Uint8Array): Record<string, any> | null {
    if (!isPngBytes(bytes)) return null;
    const latin1 = new TextDecoder('latin1');
    const utf8 = new TextDecoder('utf-8');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let charaFallback: Record<string, any> | null = null;
    let offset = 8;

    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        const type = latin1.decode(bytes.subarray(offset + 4, offset + 8));
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length) break;

        if (type === 'tEXt') {
            const chunkData = bytes.subarray(dataStart, dataEnd);
            const nullIdx = chunkData.indexOf(0);
            if (nullIdx > 0) {
                const keyword = latin1.decode(chunkData.subarray(0, nullIdx)).toLowerCase();
                if (keyword === 'ccv3' || keyword === 'chara') {
                    const rawValue = latin1.decode(chunkData.subarray(nullIdx + 1));
                    try {
                        const parsed = JSON.parse(decodeBase64Utf8(rawValue));
                        if (parsed && typeof parsed === 'object') {
                            if (keyword === 'ccv3') return parsed;
                            if (!charaFallback) charaFallback = parsed;
                        }
                    } catch {
                        // Also try plain UTF-8 JSON in case a generator stored unencoded JSON
                        try {
                            const parsed = JSON.parse(utf8.decode(chunkData.subarray(nullIdx + 1)));
                            if (parsed && typeof parsed === 'object') {
                                if (keyword === 'ccv3') return parsed;
                                if (!charaFallback) charaFallback = parsed;
                            }
                        } catch {
                            // Ignore malformed chunk
                        }
                    }
                }
            }
        } else if (type === 'iTXt') {
            const chunkData = bytes.subarray(dataStart, dataEnd);
            const nullIdx = chunkData.indexOf(0);
            if (nullIdx > 0) {
                const keyword = latin1.decode(chunkData.subarray(0, nullIdx)).toLowerCase();
                if (keyword === 'ccv3' || keyword === 'chara') {
                    // iTXt layout: keyword\0 + compression_flag(1) + compression_method(1) + lang\0 + translated_keyword\0 + text
                    let cursor = nullIdx + 3;
                    while (cursor < chunkData.length && chunkData[cursor] !== 0) cursor += 1;
                    cursor += 1;
                    while (cursor < chunkData.length && chunkData[cursor] !== 0) cursor += 1;
                    cursor += 1;
                    if (cursor < chunkData.length) {
                        const textPart = utf8.decode(chunkData.subarray(cursor));
                        try {
                            const parsed = JSON.parse(textPart.trim().startsWith('{') ? textPart : decodeBase64Utf8(textPart));
                            if (parsed && typeof parsed === 'object') {
                                if (keyword === 'ccv3') return parsed;
                                if (!charaFallback) charaFallback = parsed;
                            }
                        } catch {
                            // Ignore malformed iTXt
                        }
                    }
                }
            }
        }

        if (type === 'IEND') break;
        offset = dataEnd + 4;
    }

    return charaFallback;
}

export function uint8ArrayToDataUrl(bytes: Uint8Array, mimeType = 'image/png'): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * Normalize SillyTavern regex scripts (`extensions.regex_scripts` or `SPreset.RegexBinding.regexes`)
 * into SullyOS `TavernRegexRule[]`.
 */
export function parseTavernRegexScripts(rawList: unknown): TavernRegexRule[] {
    if (!Array.isArray(rawList)) return [];
    const results: TavernRegexRule[] = [];

    rawList.forEach((item: any, idx: number) => {
        if (!item || typeof item !== 'object') return;
        const rawFind = typeof item.findRegex === 'string'
            ? item.findRegex
            : typeof item.pattern === 'string'
                ? item.pattern
                : '';
        if (!rawFind.trim()) return;

        const trimmedFind = rawFind.trim();
        const slashMatch = trimmedFind.match(/^\/([\s\S]*)\/([a-z]*)$/i);
        let pattern = slashMatch ? slashMatch[1] : trimmedFind;
        let flags = slashMatch ? (slashMatch[2] || item.flags || 'g') : (item.flags || 'g');
        if (!flags.includes('g')) flags += 'g';

        // Sanitize empty alternatives (e.g. `foo||bar` or trailing `|`) which match every character boundary in JS RegExp
        if (pattern.includes('||') || pattern.endsWith('|') || pattern.startsWith('|')) {
            pattern = pattern.split('|').filter(Boolean).join('|');
        }
        if (!pattern) return;

        const placement = Array.isArray(item.placement) ? item.placement : [];
        const hasUser = placement.includes(1);
        const hasAi = placement.length === 0 || placement.some((p: number) => p !== 1);
        const role: 'user' | 'ai' | 'both' = item.role === 'user' || item.role === 'ai' || item.role === 'both'
            ? item.role
            : hasUser && hasAi
                ? 'both'
                : hasUser
                    ? 'user'
                    : 'ai';

        const mdOnly = Boolean(item.markdownOnly);
        const promptOnly = Boolean(item.promptOnly);
        const applyOnDisplay = item.applyOnDisplay !== undefined
            ? Boolean(item.applyOnDisplay)
            : mdOnly ? true : promptOnly ? false : true;
        const applyOnPrompt = item.applyOnPrompt !== undefined
            ? Boolean(item.applyOnPrompt)
            : promptOnly ? true : mdOnly ? false : true;

        let replacement = typeof item.replaceString === 'string'
            ? item.replaceString
            : typeof item.replacement === 'string'
                ? item.replacement
                : '';
        // Strip SillyTavern-only duplicate macro if user input is already captured via $1
        replacement = replacement.replace(/\{\{LATEST_USER_INPUT\}\}\s*/gi, '');

        results.push({
            id: String(item.id || `rx_${Date.now()}_${idx}`),
            name: String(item.scriptName || item.name || `酒馆正则 #${idx + 1}`),
            pattern,
            flags,
            replacement,
            trimStrings: Array.isArray(item.trimStrings)
                ? item.trimStrings.filter((s: unknown) => typeof s === 'string' && s.length > 0)
                : [],
            substituteRegex: typeof item.substituteRegex === 'number' ? item.substituteRegex : 0,
            minDepth: item.minDepth === 0 || item.minDepth ? Number(item.minDepth) : null,
            maxDepth: item.maxDepth === 0 || item.maxDepth ? Number(item.maxDepth) : null,
            enabled: item.disabled !== undefined ? !item.disabled : item.enabled !== false,
            applyOnPrompt,
            applyOnDisplay,
            role,
            order: typeof item.order === 'number' ? item.order : idx,
        });
    });

    return results;
}

export interface ParsedCharacterCardResult {
    sourceFormat: 'sully' | 'tavern';
    character: CharacterProfile;
    worldbooks: Worldbook[];
    greetings: string[];
}

export function isTavernCharacterJson(raw: any): boolean {
    if (!raw || typeof raw !== 'object') return false;
    if (raw.type === 'sully_character_card') return false;
    if (raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3') return true;
    const d = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    return typeof (d.name || d.char_name) === 'string' && (
        typeof d.description === 'string'
        || typeof d.personality === 'string'
        || typeof d.first_mes === 'string'
        || typeof d.scenario === 'string'
        || typeof d.mes_example === 'string'
    );
}

/**
 * Convert a SillyTavern V1/V2/V3 card object into SullyOS CharacterProfile + embedded Worldbooks.
 */
export function convertTavernCardToCharacter(
    rawCard: Record<string, any>,
    options: {
        avatarUrl?: string;
        fallbackName?: string;
        now?: number;
    } = {},
): ParsedCharacterCardResult {
    const now = options.now ?? Date.now();
    const d = rawCard?.data && typeof rawCard.data === 'object' ? rawCard.data : rawCard || {};
    const name = String(d.name || d.char_name || options.fallbackName || '未命名角色').trim() || '未命名角色';

    const promptSections: string[] = [];
    if (typeof d.description === 'string' && d.description.trim()) {
        promptSections.push(d.description.trim());
    }
    if (typeof d.personality === 'string' && d.personality.trim()) {
        promptSections.push(`【性格】\n${d.personality.trim()}`);
    }
    if (typeof d.scenario === 'string' && d.scenario.trim()) {
        promptSections.push(`【情境】\n${d.scenario.trim()}`);
    }
    if (typeof d.mes_example === 'string' && d.mes_example.trim()) {
        promptSections.push(`【对话范例】\n${d.mes_example.trim()}`);
    }
    if (typeof d.system_prompt === 'string' && d.system_prompt.trim()) {
        promptSections.push(`【系统提示】\n${d.system_prompt.trim()}`);
    }
    if (typeof d.post_history_instructions === 'string' && d.post_history_instructions.trim()) {
        promptSections.push(`【历史后指令】\n${d.post_history_instructions.trim()}`);
    }
    if (typeof d.creator_notes === 'string' && d.creator_notes.trim()) {
        promptSections.push(`【创作者备注】\n${d.creator_notes.trim()}`);
    }

    const greetings = [
        typeof d.first_mes === 'string' ? d.first_mes.trim() : '',
        ...(Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map((g: unknown) => String(g || '').trim()) : []),
    ].filter(Boolean);

    const shortDescSource = typeof d.creator_notes === 'string' && d.creator_notes.trim()
        ? d.creator_notes.trim().split(/\r?\n/)[0]
        : typeof d.personality === 'string' && d.personality.trim()
            ? d.personality.trim().split(/\r?\n/)[0]
            : typeof d.description === 'string' && d.description.trim()
                ? d.description.trim().split(/\r?\n/)[0]
                : `从酒馆角色卡导入：${name}`;

    // Parse embedded character_book if present
    const worldbooks: Worldbook[] = [];
    const charBook = d.character_book || rawCard?.character_book;
    if (charBook && typeof charBook === 'object' && charBook.entries) {
        try {
            const categoryName = (typeof charBook.name === 'string' && charBook.name.trim())
                ? charBook.name.trim()
                : `${name} 世界书`;
            const parsedBooks = parseStandardWorldbook(JSON.stringify(charBook), categoryName, now);
            worldbooks.push(...parsedBooks);
        } catch (err) {
            console.warn('[TavernCard] Failed to parse embedded character_book:', err);
        }
    }

    // Parse embedded regex_scripts if present
    const ext = d.extensions && typeof d.extensions === 'object' ? d.extensions : rawCard?.extensions || {};
    const regexRules = parseTavernRegexScripts(ext.regex_scripts);

    const charId = `char-${now}-${Math.random().toString(36).slice(2, 9)}`;
    const character: CharacterProfile = {
        id: charId,
        name,
        avatar: options.avatarUrl || (typeof d.avatar === 'string' && /^(data:|https?:)/i.test(d.avatar) ? d.avatar : ''),
        description: shortDescSource.slice(0, 120),
        systemPrompt: promptSections.join('\n\n'),
        worldview: typeof d.scenario === 'string' ? d.scenario.trim() : '',
        memories: [],
        refinedMemories: {},
        activeMemoryMonths: [],
        mountedWorldbooks: worldbooks.map(toMountedWorldbook),
        ...(greetings.length > 0 ? { tavernGreetings: greetings } : {}),
        ...(regexRules.length > 0 ? { tavernRegexRules: regexRules } : {}),
    };

    return {
        sourceFormat: 'tavern',
        character,
        worldbooks,
        greetings,
    };
}

/**
 * Unified Character Card file reader:
 * - Supports SullyOS PNG share cards (`sULy` chunk)
 * - Supports SillyTavern PNG cards (`ccv3` / `chara` tEXt/iTXt chunks + PNG avatar extraction)
 * - Supports SullyOS JSON cards (`type === 'sully_character_card'`)
 * - Supports SillyTavern JSON cards (V1/V2/V3)
 */
export async function parseAnyCharacterCardFile(
    file: File,
    now = Date.now(),
): Promise<ParsedCharacterCardResult> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const fallbackName = file.name.replace(/\.(png|json)$/i, '').trim() || '导入角色';

    // 1. Check if it's a PNG file
    if (isPngBytes(bytes) || /\.png$/i.test(file.name) || file.type === 'image/png') {
        // 1a. Check if it's a SillyTavern character card PNG (`ccv3` or `chara`)
        const tavernData = extractTavernCardFromPng(bytes);
        if (tavernData) {
            const avatarUrl = uint8ArrayToDataUrl(bytes, 'image/png');
            return convertTavernCardToCharacter(tavernData, { avatarUrl, fallbackName, now });
        }
        // 1b. Otherwise check if it's a SullyOS share PNG
        let hasSullyShare = false;
        try {
            hasSullyShare = pngHasShare(bytes);
        } catch {
            hasSullyShare = false;
        }
        if (hasSullyShare) {
            const jsonText = await readShareText(file, 'character');
            const data = JSON.parse(jsonText);
            return parseJsonCharacterData(data, fallbackName, now);
        }
        throw new Error('PNG 图片中未找到酒馆角色卡数据（ccv3/chara）或糯米机分享数据，请确认使用的是原图而非压缩图');
    }

    // 2. Otherwise parse as JSON text
    const text = new TextDecoder('utf-8').decode(bytes);
    let data: any;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('不是有效的 JSON 角色卡文件');
    }
    return parseJsonCharacterData(data, fallbackName, now);
}

function parseJsonCharacterData(
    data: any,
    fallbackName: string,
    now: number,
): ParsedCharacterCardResult {
    if (data?.type === 'sully_character_card') {
        const safeData = stripSensitiveCardFields(data);
        const fallbackCategory = `${data.name || fallbackName} 的世界书`;
        const incomingMounted = Array.isArray(data.mountedWorldbooks)
            ? data.mountedWorldbooks.map((wb: any) => ({
                ...wb,
                category: wb.category && String(wb.category).trim() ? wb.category : fallbackCategory,
            }))
            : [];
        const worldbooks: Worldbook[] = incomingMounted.map((wb: any, idx: number) => ({
            ...wb,
            id: wb.id || `wb-${now}-${idx}`,
            title: wb.title || '未命名设定',
            content: wb.content || '',
            category: wb.category || fallbackCategory,
            createdAt: now,
            updatedAt: now,
        }));
        const character: CharacterProfile = {
            ...safeData,
            id: `char-${now}-${Math.random().toString(36).slice(2, 9)}`,
            memories: [],
            refinedMemories: {},
            activeMemoryMonths: [],
            mountedWorldbooks: incomingMounted,
        } as CharacterProfile;
        return {
            sourceFormat: 'sully',
            character,
            worldbooks,
            greetings: Array.isArray(safeData.tavernGreetings) ? safeData.tavernGreetings : [],
        };
    }

    if (isTavernCharacterJson(data)) {
        return convertTavernCardToCharacter(data, { fallbackName, now });
    }

    throw new Error('无法识别的角色卡格式（支持糯米机角色卡与酒馆 V2/V3 PNG/JSON 角色卡）');
}
