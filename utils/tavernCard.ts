import type { CharacterProfile, TavernRegexRule, Worldbook } from '../types';
import { parseStandardWorldbook, toMountedWorldbook } from './worldbook';
import { pngHasShare, readShareText } from './pngShare';
import { stripSensitiveCardFields } from './characterCard';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_WEBP = [0x57, 0x45, 0x42, 0x50]; // "WEBP"

export function isPngBytes(bytes: Uint8Array): boolean {
    return bytes.length >= 8 && PNG_SIGNATURE.every((b, idx) => bytes[idx] === b);
}

export function isJpegBytes(bytes: Uint8Array): boolean {
    return bytes.length >= 3 && JPEG_SIGNATURE.every((b, idx) => bytes[idx] === b);
}

export function isWebpBytes(bytes: Uint8Array): boolean {
    return bytes.length >= 12
        && WEBP_RIFF.every((b, idx) => bytes[idx] === b)
        && WEBP_WEBP.every((b, idx) => bytes[idx + 8] === b);
}

export function detectImageMimeType(bytes: Uint8Array): string | null {
    if (isPngBytes(bytes)) return 'image/png';
    if (isJpegBytes(bytes)) return 'image/jpeg';
    if (isWebpBytes(bytes)) return 'image/webp';
    return null;
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

export function parseRegexPatternString(rawPattern: string): { pattern: string; flags: string } {
    const str = String(rawPattern || '').trim();
    const slashMatch = str.match(/^\/([\s\S]*)\/([a-z]*)$/i);
    if (slashMatch) {
        const rawFlags = slashMatch[2] || 'g';
        const cleanFlags = Array.from(new Set(rawFlags.replace(/[^gimsuy]/g, '').split(''))).join('');
        return {
            pattern: slashMatch[1],
            flags: cleanFlags.includes('g') ? cleanFlags : `${cleanFlags}g`,
        };
    }
    return { pattern: str, flags: 'g' };
}

/**
 * Parse SillyTavern `extensions.regex_scripts` or Nuojiji regex rules into `TavernRegexRule[]`.
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

        const parsed = parseRegexPatternString(rawFind);
        const pattern = parsed.pattern;
        const flags = typeof item.flags === 'string' && item.flags.trim()
            ? (item.flags.includes('g') ? item.flags : `${item.flags}g`)
            : parsed.flags;

        // SillyTavern placement: 1 = USER_INPUT, 2 = AI_OUTPUT, 3 = SLASH_COMMAND, 5 = WORLD_INFO
        const placement: number[] = Array.isArray(item.placement) ? item.placement.map(Number) : [];
        const hasUser = placement.includes(1);
        const hasAi = placement.length === 0 || placement.some(p => p !== 1);
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

export interface ParsedCharacterCardEntry {
    character: CharacterProfile;
    greetings: string[];
}

export interface ParsedCharacterCardResult {
    sourceFormat: 'sully' | 'tavern' | 'image_fallback';
    character: CharacterProfile;
    /**
     * When a multi-character ensemble card (e.g. 县城) is imported, `characters` holds all
     * split characters (each with its own matched greetings, avatar, and short description)
     * and `suggestedGroupName` holds the card title for automatic grouping in Neural Link.
     * For single-character cards, `characters` has 1 entry matching `character`.
     */
    characters: ParsedCharacterCardEntry[];
    suggestedGroupName?: string;
    worldbooks: Worldbook[];
    greetings: string[];
    warning?: string;
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
 * Extract per-character portrait URLs embedded in tavern regex scripts
 * (e.g. `baseUrls` + `imageUrlMap` or `charactersData` in 县城).
 */
function extractCharacterAvatarsFromRegexRules(regexRules: TavernRegexRule[]): Map<string, string> {
    const avatarMap = new Map<string, string>();
    for (const rule of regexRules) {
        const src = rule.replacement || '';
        if (!src) continue;

        // 1. Parse baseUrls dictionary: key: 'https://...'
        const baseUrls = new Map<string, string>();
        const baseBlockMatch = src.match(/const\s+baseUrls\s*=\s*\{([\s\S]*?)\};/);
        if (baseBlockMatch) {
            const pairRe = /([\w$]+)\s*:\s*['"](https?:\/\/[^'"\s]+)['"]/g;
            let pm: RegExpExecArray | null;
            while ((pm = pairRe.exec(baseBlockMatch[1])) !== null) {
                baseUrls.set(pm[1], pm[2].replace(/\/+$/, ''));
            }
        }

        // 2. Parse imageUrlMap: '角色名': { uniform: `${baseUrls.xxx}/xxx_uniform.png`, ... }
        const mapBlockMatch = src.match(/const\s+imageUrlMap\s*=\s*\{([\s\S]*?)\n\s*\};/);
        if (mapBlockMatch) {
            const entryRe = /['"]([^"'\n]+)['"]\s*:\s*\{([\s\S]*?)\}/g;
            let em: RegExpExecArray | null;
            while ((em = entryRe.exec(mapBlockMatch[1])) !== null) {
                const charName = em[1].trim();
                const body = em[2];
                // Prefer daily -> uniform -> outing -> first non-nsfw URL
                const variantOrder = ['daily', 'uniform', 'outing'];
                let resolvedUrl = '';
                for (const vKey of variantOrder) {
                    const vMatch = body.match(new RegExp(vKey + "\\s*:\\s*[\x60\"\x27]([^\x60\"\x27]+)[\x60\"\x27]"));
                    if (vMatch) {
                        resolvedUrl = vMatch[1].replace(/\$\{baseUrls\.([\w$]+)\}/g, (_m, k) => baseUrls.get(k) || '');
                        if (/^https?:\/\//i.test(resolvedUrl)) break;
                    }
                }
                if (resolvedUrl && /^https?:\/\//i.test(resolvedUrl) && !avatarMap.has(charName)) {
                    avatarMap.set(charName, resolvedUrl);
                }
            }
        }

        // 3. Parse charactersData array: { id: 'sun_yitong', name: '孙翌童', sfwBase: 'https://...' }
        const charDataRe = /\{\s*id\s*:\s*['"]([^'"]+)['"]\s*,\s*name\s*:\s*['"]([^'"]+)['"][\s\S]*?sfwBase\s*:\s*['"](https?:\/\/[^'"]+)['"]/g;
        let cm: RegExpExecArray | null;
        while ((cm = charDataRe.exec(src)) !== null) {
            const id = cm[1].trim();
            const cName = cm[2].trim();
            const sfwBase = cm[3].trim().replace(/\/+$/, '');
            if (cName && sfwBase && !avatarMap.has(cName)) {
                avatarMap.set(cName, `${sfwBase}/${id}_uniform.png`);
            }
        }
    }
    return avatarMap;
}

/**
 * Extract per-character short descriptions from worldbooks (e.g. `人物速览` entry or character entry).
 */
function extractCharacterSummariesFromWorldbooks(worldbooks: Worldbook[]): Map<string, string> {
    const summaryMap = new Map<string, string>();
    for (const wb of worldbooks) {
        const title = (wb.title || '').trim();
        const content = wb.content || '';
        if (title === '人物速览' || content.includes('人物速览:')) {
            const lineRe = /^\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,10})\s*[:：]\s*["“]?([^"”\r\n]+)["”]?\s*$/gm;
            let lm: RegExpExecArray | null;
            while ((lm = lineRe.exec(content)) !== null) {
                const cName = lm[1].trim();
                const desc = lm[2].trim();
                if (cName && desc && cName !== '人物速览') {
                    summaryMap.set(cName, desc);
                }
            }
        }
    }
    return summaryMap;
}

/**
 * Identify which character a greeting belongs to when a card is a multi-character ensemble card.
 */
function detectGreetingCharacterName(greeting: string, knownCharNames: Set<string>): string | null {
    const text = (greeting || '').trim();
    if (!text) return null;

    // 1. Check <SceneInfo> 在场角色: - 角色名|服装
    const sceneMatch = text.match(/<SceneInfo>([\s\S]*?)<\/SceneInfo>/i);
    if (sceneMatch) {
        const sceneBody = sceneMatch[1];
        const roleLines = Array.from(sceneBody.matchAll(/^\s*-\s*([^|\r\n]+?)(?:\|[^\r\n]*)?$/gm));
        if (roleLines.length > 0) {
            const firstRole = roleLines[0][1].trim();
            if (firstRole) return firstRole;
        }
    }

    // 2. Check leading bracket/title markers like 【角色名】 or [角色名] if it matches a known character in worldbook
    const headLine = text.split(/\r?\n/)[0].trim();
    const bracketMatch = headLine.match(/^[【\[]([^】\]]{2,10})[】\]]/);
    if (bracketMatch) {
        const candidate = bracketMatch[1].trim();
        if (knownCharNames.has(candidate)) return candidate;
    }

    return null;
}

/**
 * Convert a SillyTavern V1/V2/V3 card object into SullyOS CharacterProfile + embedded Worldbooks.
 * Automatically detects multi-character ensemble cards (multiple greetings for distinct characters)
 * and splits them into individual characters under a shared group so users can pick any character directly in Neural Link.
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
    const defaultAvatar = options.avatarUrl || (typeof d.avatar === 'string' && /^(data:|https?:)/i.test(d.avatar) ? d.avatar : '');
    const mountedWbs = worldbooks.map(toMountedWorldbook);
    const baseSystemPrompt = promptSections.join('\n\n');
    const baseWorldview = typeof d.scenario === 'string' ? d.scenario.trim() : '';

    // Check if this card is a multi-character ensemble card (like 县城)
    const knownWbCharNames = new Set<string>();
    for (const wb of worldbooks) {
        const t = (wb.title || '').trim();
        if (t && !t.endsWith('nsfw') && !t.includes('内心状态') && !t.includes('约束') && !t.includes('插图')) {
            knownWbCharNames.add(t);
        }
    }
    const summaryMap = extractCharacterSummariesFromWorldbooks(worldbooks);
    for (const k of summaryMap.keys()) knownWbCharNames.add(k);
    const avatarMap = extractCharacterAvatarsFromRegexRules(regexRules);
    for (const k of avatarMap.keys()) knownWbCharNames.add(k);

    const greetingGroups = new Map<string, string[]>();
    const unassignedGreetings: string[] = [];
    for (const g of greetings) {
        const detectedName = detectGreetingCharacterName(g, knownWbCharNames);
        if (detectedName && detectedName !== name) {
            const list = greetingGroups.get(detectedName) || [];
            list.push(g);
            greetingGroups.set(detectedName, list);
        } else {
            unassignedGreetings.push(g);
        }
    }

    // If at least 2 distinct sub-characters have dedicated greetings, split into multi-character entries!
    const isMultiCharCard = greetingGroups.size >= 2;
    const characters: ParsedCharacterCardEntry[] = [];

    if (isMultiCharCard) {
        let subIdx = 0;
        for (const [subName, subGreetings] of greetingGroups.entries()) {
            const subSummary = summaryMap.get(subName) || `${name} · ${subName}`;
            const subAvatar = avatarMap.get(subName) || defaultAvatar;
            const roleDirective = `【当前主视角角色：${subName}】\n当前与用户互动的主要角色是「${subName}」（${subSummary}）。请以「${subName}」为核心展开剧情与对话；当场景中有其他角色出场时，结合世界书设定自然演绎。`;
            const subChar: CharacterProfile = {
                id: `char-${now}-${subIdx}-${Math.random().toString(36).slice(2, 8)}`,
                name: subName,
                avatar: subAvatar,
                description: subSummary.slice(0, 120),
                systemPrompt: [roleDirective, baseSystemPrompt].filter(Boolean).join('\n\n'),
                worldview: baseWorldview,
                memories: [],
                refinedMemories: {},
                activeMemoryMonths: [],
                mountedWorldbooks: mountedWbs,
                tavernGreetings: subGreetings,
                ...(regexRules.length > 0 ? { tavernRegexRules: regexRules } : {}),
            };
            characters.push({
                character: subChar,
                greetings: subGreetings,
            });
            subIdx += 1;
        }

        // Also keep a hub/gallery entry if there are unassigned greetings (like 【主页】) or so the full sandbox is accessible
        const hubGreetings = unassignedGreetings.length > 0 ? unassignedGreetings : greetings;
        const hasHomepage = unassignedGreetings.some(g => g.trim() === '【主页】' || g.includes('【主页】'));
        const hubChar: CharacterProfile = {
            id: `char-${now}-hub-${Math.random().toString(36).slice(2, 8)}`,
            name: hasHomepage ? `${name} · 主页图鉴` : `${name}（全员沙盒）`,
            avatar: defaultAvatar,
            description: `${name}全角色立绘图鉴与自由沙盒（共 ${greetingGroups.size} 位角色）`.slice(0, 120),
            systemPrompt: baseSystemPrompt,
            worldview: baseWorldview,
            memories: [],
            refinedMemories: {},
            activeMemoryMonths: [],
            mountedWorldbooks: mountedWbs,
            tavernGreetings: hubGreetings,
            ...(regexRules.length > 0 ? { tavernRegexRules: regexRules } : {}),
        };
        characters.push({
            character: hubChar,
            greetings: hubGreetings,
        });
    }

    const charId = `char-${now}-${Math.random().toString(36).slice(2, 9)}`;
    const primaryCharacter: CharacterProfile = characters.length > 0
        ? characters[0].character
        : {
            id: charId,
            name,
            avatar: defaultAvatar,
            description: shortDescSource.slice(0, 120),
            systemPrompt: baseSystemPrompt,
            worldview: baseWorldview,
            memories: [],
            refinedMemories: {},
            activeMemoryMonths: [],
            mountedWorldbooks: mountedWbs,
            ...(greetings.length > 0 ? { tavernGreetings: greetings } : {}),
            ...(regexRules.length > 0 ? { tavernRegexRules: regexRules } : {}),
        };

    if (characters.length === 0) {
        characters.push({
            character: primaryCharacter,
            greetings,
        });
    }

    return {
        sourceFormat: 'tavern',
        character: primaryCharacter,
        characters,
        ...(isMultiCharCard ? { suggestedGroupName: name } : {}),
        worldbooks,
        greetings: characters[0].greetings,
    };
}

/**
 * Unified Character Card file reader:
 * - Supports SullyOS PNG share cards (`sULy` chunk)
 * - Supports SillyTavern PNG cards (`ccv3` / `chara` tEXt/iTXt chunks + PNG avatar extraction)
 * - Supports SullyOS JSON cards (`type === 'sully_character_card'`)
 * - Supports SillyTavern JSON cards (V1/V2/V3)
 * - Gracefully handles compressed/renamed JPEG/WebP/PNG images whose metadata was stripped by social apps
 *   by creating an avatar-initialized character card instead of failing with a hard error.
 */
export async function parseAnyCharacterCardFile(
    file: File,
    now = Date.now(),
): Promise<ParsedCharacterCardResult> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const fallbackName = file.name.replace(/\.(png|jpe?g|webp|json)$/i, '').trim() || '导入角色';

    // 1. Check if it is a true PNG file
    if (isPngBytes(bytes)) {
        // 1a. Check if it is a SillyTavern character card PNG (`ccv3` or `chara`)
        const tavernData = extractTavernCardFromPng(bytes);
        if (tavernData) {
            const avatarUrl = uint8ArrayToDataUrl(bytes, 'image/png');
            return convertTavernCardToCharacter(tavernData, { avatarUrl, fallbackName, now });
        }
        // 1b. Otherwise check if it is a SullyOS share PNG
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
        // 1c. Plain PNG without embedded metadata -> fallback to image character card
        const avatarUrl = uint8ArrayToDataUrl(bytes, 'image/png');
        return createImageFallbackCharacterResult(avatarUrl, fallbackName, now, '该 PNG 图片不含酒馆元数据，已为你自动创建带该立绘头像的新角色');
    }

    // 2. Check if it is a JPEG or WebP image (often saved from social apps with .png extension, stripping PNG tEXt/iTXt chunks)
    const detectedMime = detectImageMimeType(bytes);
    if (detectedMime) {
        const avatarUrl = uint8ArrayToDataUrl(bytes, detectedMime);
        return createImageFallbackCharacterResult(
            avatarUrl,
            fallbackName,
            now,
            '该图片在传输中被转码为 JPG/WebP（原酒馆隐藏数据被平台压缩剥离），已为你用该立绘创建角色，可在设定中补充人设或挂载世界书',
        );
    }

    // 3. Otherwise parse as JSON text
    const text = new TextDecoder('utf-8').decode(bytes);
    let data: any;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('不是有效的 JSON 或图片角色卡文件');
    }
    return parseJsonCharacterData(data, fallbackName, now);
}

function createImageFallbackCharacterResult(
    avatarUrl: string,
    fallbackName: string,
    now: number,
    warning: string,
): ParsedCharacterCardResult {
    const cleanName = /^[0-9a-f_\-]{12,}$/i.test(fallbackName) ? '新导入角色' : fallbackName;
    const character: CharacterProfile = {
        id: `char-${now}-${Math.random().toString(36).slice(2, 9)}`,
        name: cleanName,
        avatar: avatarUrl,
        description: '从立绘图片导入的角色，点击设定补充人设与世界书',
        systemPrompt: '',
        worldview: '',
        memories: [],
        refinedMemories: {},
        activeMemoryMonths: [],
        mountedWorldbooks: [],
    };
    return {
        sourceFormat: 'image_fallback',
        character,
        characters: [{ character, greetings: [] }],
        worldbooks: [],
        greetings: [],
        warning,
    };
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
        const greetings = Array.isArray(safeData.tavernGreetings) ? safeData.tavernGreetings : [];
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
            characters: [{ character, greetings }],
            worldbooks,
            greetings,
        };
    }

    if (isTavernCharacterJson(data)) {
        return convertTavernCardToCharacter(data, { fallbackName, now });
    }

    throw new Error('无法识别的角色卡格式（支持糯米机角色卡与酒馆 V2/V3 PNG/JSON 角色卡）');
}
