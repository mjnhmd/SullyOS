import {
    MountedWorldbook,
    Worldbook,
    WorldbookDepthRole,
    WorldbookPosition,
    WorldbookSelectiveLogic,
} from '../types';

export type WorldbookLike = Worldbook | MountedWorldbook;

export interface WorldbookScanMessage {
    role?: string;
    content: unknown;
}

export interface ResolvedWorldbookEntry {
    book: WorldbookLike;
    content: string;
    position: WorldbookPosition;
    order: number;
}

export interface WorldbookSystemSections {
    beforeCharacter: ResolvedWorldbookEntry[];
    afterCharacter: ResolvedWorldbookEntry[];
    authorsNoteTop: ResolvedWorldbookEntry[];
    authorsNoteBottom: ResolvedWorldbookEntry[];
    atDepth: ResolvedWorldbookEntry[];
    beforeExamples: ResolvedWorldbookEntry[];
    afterExamples: ResolvedWorldbookEntry[];
}

export const WORLDBOOK_POSITION_LABELS: Record<WorldbookPosition, string> = {
    0: '角色定义之前',
    1: '角色定义之后',
    2: '作者注释之前',
    3: '作者注释之后',
    4: '聊天记录指定深度',
    5: '示例消息之前',
    6: '示例消息之后',
};

export const WORLDBOOK_POSITION_DESCRIPTIONS: Record<WorldbookPosition, string> = {
    0: '适合最高优先级的世界底层规则，放在角色设定前面。',
    1: '默认位置；紧跟在角色人设和基础世界观后面。',
    2: '适合场景风格、叙事基调，放在后置注释内容顶部。',
    3: '适合放作者注释后的补充与强调；比顶部内容更靠后。',
    4: '适合临时状态、近期事件或强提醒；按深度和角色插入聊天记录。',
    5: '适合放阅读示例对话前需要先知道的说明。',
    6: '适合放示例对话结束后的补充说明。',
};

export const WORLDBOOK_ROLE_LABELS: Record<WorldbookDepthRole, string> = {
    0: 'System',
    1: 'User',
    2: 'Assistant',
};

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const asStringArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    if (typeof value === 'string') return splitWorldbookKeywords(value);
    return [];
};

export const splitWorldbookKeywords = (value: string): string[] => (
    value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean)
);

export const toMountedWorldbook = (book: WorldbookLike): MountedWorldbook => ({
    id: book.id,
    title: book.title,
    content: book.content,
    category: book.category,
    key: book.key ? [...book.key] : undefined,
    keysecondary: book.keysecondary ? [...book.keysecondary] : undefined,
    constant: book.constant,
    selective: book.selective,
    selectiveLogic: book.selectiveLogic,
    order: book.order,
    position: book.position,
    disable: book.disable,
    probability: book.probability,
    useProbability: book.useProbability,
    depth: book.depth,
    role: book.role,
    scanDepth: book.scanDepth,
    caseSensitive: book.caseSensitive,
    matchWholeWords: book.matchWholeWords,
    excludeRecursion: book.excludeRecursion,
    preventRecursion: book.preventRecursion,
    delayUntilRecursion: book.delayUntilRecursion,
    sticky: book.sticky,
    cooldown: book.cooldown,
    delay: book.delay,
    group: book.group,
    groupWeight: book.groupWeight,
    groupOverride: book.groupOverride,
    sourceUid: book.sourceUid,
});

/**
 * Install a complete worldbook group into one character cache. Existing entries
 * with the same ids are replaced, so retrying an install cannot create duplicates.
 */
export const upsertMountedWorldbooks = (
    current: MountedWorldbook[] = [],
    books: Worldbook[] = [],
): MountedWorldbook[] => {
    const incomingIds = new Set(books.map(book => book.id));
    return [
        ...current.filter(book => !incomingIds.has(book.id)),
        ...books.map(toMountedWorldbook),
    ];
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const keywordMatches = (
    text: string,
    keyword: string,
    caseSensitive: boolean,
    wholeWords: boolean,
): boolean => {
    if (!keyword) return false;
    if (!wholeWords) {
        return caseSensitive
            ? text.includes(keyword)
            : text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase());
    }
    const flags = caseSensitive ? 'u' : 'iu';
    const escaped = escapeRegExp(keyword);
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, flags).test(text);
};

const messageText = (message: WorldbookScanMessage): string => {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content
            .map(part => (typeof part === 'string' ? part : (part as any)?.text || ''))
            .filter(Boolean)
            .join('\n');
    }
    return '';
};

const scanTextForBook = (book: WorldbookLike, messages: WorldbookScanMessage[]): string => {
    const depth = Math.max(0, Math.floor(book.scanDepth ?? 4));
    if (depth === 0) return '';
    return messages.slice(-depth).map(messageText).filter(Boolean).join('\n');
};

const secondaryConditionPasses = (
    book: WorldbookLike,
    text: string,
    caseSensitive: boolean,
    wholeWords: boolean,
): boolean => {
    if (!book.selective) return true;
    const secondary = book.keysecondary || [];
    if (secondary.length === 0) return true;
    const matches = secondary.map(key => keywordMatches(text, key, caseSensitive, wholeWords));
    const logic: WorldbookSelectiveLogic = book.selectiveLogic ?? 0;
    if (logic === 1) return !matches.every(Boolean);
    if (logic === 2) return !matches.some(Boolean);
    if (logic === 3) return matches.every(Boolean);
    return matches.some(Boolean);
};

export interface WorldbookActivationOptions {
    isRecursion?: boolean;
    recursionText?: string;
}

export const isWorldbookEntryActive = (
    book: WorldbookLike,
    messages: WorldbookScanMessage[] = [],
    options?: WorldbookActivationOptions,
): boolean => {
    if (book.disable) return false;

    const isRecursion = options?.isRecursion === true;
    if (isRecursion && book.excludeRecursion) return false;
    if (!isRecursion && book.delayUntilRecursion) return false;

    const delay = Math.max(0, Math.floor(Number(book.delay) || 0));
    if (delay > 0 && messages.length < delay) return false;

    const primary = book.key || [];
    const isConstant = book.constant ?? primary.length === 0;
    if (isConstant) {
        if (isRecursion) return false;
    } else {
        if (primary.length === 0) return false;
        const caseSensitive = book.caseSensitive === true;
        const wholeWords = book.matchWholeWords === true;
        const text = isRecursion ? String(options?.recursionText || '') : scanTextForBook(book, messages);
        if (!primary.some(key => keywordMatches(text, key, caseSensitive, wholeWords))) return false;
        if (!secondaryConditionPasses(book, text, caseSensitive, wholeWords)) return false;
    }

    if (book.useProbability) {
        const probability = clamp(book.probability, 0, 100, 100);
        if (probability <= 0) return false;
        if (probability < 100 && Math.random() * 100 >= probability) return false;
    }

    return true;
};


export const evaluateDiceRoll = (formula: string): string => {
    const cleaned = String(formula || '').trim();
    const match = cleaned.match(/^(?:(\d+)?d)?(\d+)\s*([+-]\s*\d+)?$/i);
    if (!match) return '1';
    const count = Math.min(100, Math.max(1, match[1] ? parseInt(match[1], 10) : 1));
    const sides = Math.max(1, parseInt(match[2], 10) || 20);
    const mod = match[3] ? parseInt(match[3].replace(/\s+/g, ''), 10) || 0 : 0;
    let total = mod;
    for (let i = 0; i < count; i += 1) {
        total += Math.floor(Math.random() * sides) + 1;
    }
    return String(total);
};

export const expandWorldbookMacros = (content: string, charName: string, userName: string): string => {
    let expanded = content;
    if (charName) expanded = expanded.replace(/{{\s*char\s*}}/gi, charName);
    if (userName) expanded = expanded.replace(/{{\s*user\s*}}/gi, userName);
    // Support {{random::a::b}} and {{random:a,b}}
    expanded = expanded.replace(/\{\{random::([^{}]+)\}\}/gi, (_m, inner: string) => {
        const items = inner.split('::').map(s => s.trim()).filter(Boolean);
        return items.length ? items[Math.floor(Math.random() * items.length)] : '';
    });
    expanded = expanded.replace(/\{\{random:([^{}]+)\}\}/gi, (_m, inner: string) => {
        const items = inner.split(',').map(s => s.trim()).filter(Boolean);
        return items.length ? items[Math.floor(Math.random() * items.length)] : '';
    });
    // Support {{roll:1d20}}, {{roll:2d6+3}}, {{roll:d100}}, {{roll:20}}
    expanded = expanded.replace(/\{\{\s*roll\s*[:：]{1,2}\s*([^{}]+?)\s*\}\}/gi, (_m, formula: string) => {
        return evaluateDiceRoll(formula);
    });
    return expanded;
};

/**
 * Filter candidate entries by SillyTavern Inclusion Group rules:
 * - If a group has already been activated in an earlier pass, drop candidates in that group.
 * - Within the same group in the current pass:
 *   - If any entry has `groupOverride: true`, only `groupOverride` entries compete (highest `order` wins; ties broken by weight).
 *   - Otherwise, weighted random selection using `groupWeight` (default 100).
 */
const filterByInclusionGroups = (
    candidates: WorldbookLike[],
    activatedGroups: Set<string>,
): WorldbookLike[] => {
    const filtered = candidates.filter(book => {
        const g = (book.group || '').trim();
        return !g || !activatedGroups.has(g);
    });
    const byGroup = new Map<string, WorldbookLike[]>();
    for (const book of filtered) {
        const g = (book.group || '').trim();
        if (!g) continue;
        const list = byGroup.get(g) || [];
        list.push(book);
        byGroup.set(g, list);
    }
    if (byGroup.size === 0) return filtered;

    const winners = new Set<WorldbookLike>();
    for (const [g, list] of byGroup.entries()) {
        if (list.length === 1) {
            winners.add(list[0]);
            activatedGroups.add(g);
            continue;
        }
        const overrides = list.filter(b => b.groupOverride === true);
        const pool = overrides.length > 0 ? overrides : list;
        if (pool.length === 1) {
            winners.add(pool[0]);
            activatedGroups.add(g);
            continue;
        }
        const totalWeight = pool.reduce((sum, b) => sum + Math.max(1, Number(b.groupWeight) || 100), 0);
        let roll = Math.random() * totalWeight;
        let chosen = pool[pool.length - 1];
        for (const item of pool) {
            roll -= Math.max(1, Number(item.groupWeight) || 100);
            if (roll <= 0) {
                chosen = item;
                break;
            }
        }
        winners.add(chosen);
        activatedGroups.add(g);
    }

    return filtered.filter(book => {
        const g = (book.group || '').trim();
        return !g || winners.has(book);
    });
};

export const resolveWorldbookEntries = (
    books: WorldbookLike[] = [],
    messages: WorldbookScanMessage[] = [],
    charName = '',
    userName = '',
): ResolvedWorldbookEntry[] => {
    const activatedIds = new Set<string>();
    const activatedGroups = new Set<string>();
    const activatedBooks: WorldbookLike[] = [];

    // Pass 0: initial scan (constants + primary/secondary keywords on messages)
    const initialCandidates = books.filter(book => {
        if (!book || activatedIds.has(book.id)) return false;
        return isWorldbookEntryActive(book, messages, { isRecursion: false });
    });
    let currentWave = filterByInclusionGroups(initialCandidates, activatedGroups);
    for (const book of currentWave) {
        activatedIds.add(book.id);
        activatedBooks.push(book);
    }

    // Recursion passes (up to 3 steps) for entries triggered by other entries' content
    const maxRecursionSteps = 3;
    for (let step = 0; step < maxRecursionSteps && currentWave.length > 0; step += 1) {
        const recursionBuffer = currentWave
            .filter(book => !book.preventRecursion)
            .map(book => expandWorldbookMacros(book.content || '', charName, userName))
            .join('\n');
        if (!recursionBuffer.trim()) break;

        const nextCandidates = books.filter(book => {
            if (!book || activatedIds.has(book.id)) return false;
            return isWorldbookEntryActive(book, messages, {
                isRecursion: true,
                recursionText: recursionBuffer,
            });
        });
        if (nextCandidates.length === 0) break;
        currentWave = filterByInclusionGroups(nextCandidates, activatedGroups);
        for (const book of currentWave) {
            activatedIds.add(book.id);
            activatedBooks.push(book);
        }
    }

    return activatedBooks
        .map(book => ({
            book,
            content: expandWorldbookMacros(book.content || '', charName, userName),
            position: book.position ?? 1,
            order: Number.isFinite(book.order) ? Number(book.order) : 100,
        }))
        .filter(entry => entry.content.trim())
        .sort((a, b) => a.order - b.order);
};

/**
 * 只取「聊天记录指定深度」的条目，交给 injectWorldbookDepthEntries 插进对话。
 * 兼容旧调用方；新 App 使用 ContextBuilder 的完整消息入口，不自行解析或插入世界书。
 */
export const resolveWorldbookDepthEntries = (
    books: WorldbookLike[] = [],
    messages: WorldbookScanMessage[] = [],
    charName = '',
    userName = '',
): ResolvedWorldbookEntry[] => resolveWorldbookEntries(books, messages, charName, userName)
    .filter(entry => entry.position === 4);

export const splitWorldbookSections = (entries: ResolvedWorldbookEntry[]): WorldbookSystemSections => ({
    beforeCharacter: entries.filter(entry => entry.position === 0),
    afterCharacter: entries.filter(entry => entry.position === 1),
    authorsNoteTop: entries.filter(entry => entry.position === 2),
    authorsNoteBottom: entries.filter(entry => entry.position === 3),
    atDepth: entries.filter(entry => entry.position === 4),
    beforeExamples: entries.filter(entry => entry.position === 5),
    afterExamples: entries.filter(entry => entry.position === 6),
});

export const formatWorldbookSection = (
    entries: ResolvedWorldbookEntry[],
    heading: string,
): string => {
    if (entries.length === 0) return '';
    let output = `### ${heading}\n`;
    let lastLegacyCategory = '';
    for (const entry of entries) {
        // SillyTavern comments are editor-only and are not part of the prompt.
        if (entry.book.sourceUid === undefined) {
            const category = entry.book.category || '通用设定 (General)';
            if (category !== lastLegacyCategory) {
                output += `#### [${category}]\n`;
                lastLegacyCategory = category;
            }
            output += `**Title: ${entry.book.title}**\n`;
        }
        output += `${entry.content.trim()}\n---\n`;
    }
    return `${output}\n`;
};

export const injectWorldbookDepthEntries = <T extends WorldbookScanMessage>(
    messages: T[],
    entries: ResolvedWorldbookEntry[],
): Array<T | { role: 'system' | 'user' | 'assistant'; content: string }> => {
    if (entries.length === 0) return [...messages];
    const buckets = new Map<number, ResolvedWorldbookEntry[]>();
    for (const entry of entries) {
        const depth = Math.max(0, Math.floor(entry.book.depth ?? 4));
        const index = Math.max(0, messages.length - depth);
        const bucket = buckets.get(index) || [];
        bucket.push(entry);
        buckets.set(index, bucket);
    }

    const result: Array<T | { role: 'system' | 'user' | 'assistant'; content: string }> = [];
    for (let index = 0; index <= messages.length; index += 1) {
        const bucket = buckets.get(index) || [];
        for (const entry of bucket) {
            const roleValue = entry.book.role ?? 0;
            const role = roleValue === 1 ? 'user' : roleValue === 2 ? 'assistant' : 'system';
            result.push({ role, content: entry.content.trim() });
        }
        if (index < messages.length) result.push(messages[index]);
    }
    return result;
};

export const serializeStandardWorldbook = (books: WorldbookLike[]): string => {
    const usedUids = new Set<number>();
    const entries: Record<string, Record<string, unknown>> = {};

    books.forEach((book, index) => {
        let uid = Number.isFinite(book.sourceUid) ? Number(book.sourceUid) : index;
        while (usedUids.has(uid)) uid += 1;
        usedUids.add(uid);

        const primary = book.key || [];
        const secondary = book.keysecondary || [];
        const position = book.position ?? 1;
        entries[String(index)] = {
            uid,
            key: [...primary],
            keysecondary: [...secondary],
            comment: book.title,
            content: book.content,
            constant: book.constant ?? primary.length === 0,
            selective: book.selective ?? secondary.length > 0,
            selectiveLogic: book.selectiveLogic ?? 0,
            order: book.order ?? 100,
            position,
            disable: book.disable === true,
            probability: book.probability ?? 100,
            useProbability: book.useProbability === true,
            depth: book.depth ?? 4,
            role: position === 4 ? (book.role ?? 0) : null,
            scanDepth: book.scanDepth ?? null,
            caseSensitive: book.caseSensitive ?? null,
            matchWholeWords: book.matchWholeWords ?? null,
            excludeRecursion: book.excludeRecursion === true,
            preventRecursion: book.preventRecursion === true,
            delayUntilRecursion: book.delayUntilRecursion === true,
            sticky: book.sticky ?? 0,
            cooldown: book.cooldown ?? 0,
            delay: book.delay ?? 0,
            group: book.group ?? '',
            groupWeight: book.groupWeight ?? 100,
            groupOverride: book.groupOverride === true,
            displayIndex: index,
        };
    });

    return JSON.stringify({ entries }, null, 2);
};

export const parseStandardWorldbook = (
    rawText: string,
    category: string,
    now = Date.now(),
): Worldbook[] => {
    const parsed = JSON.parse(rawText);
    // Support top-level { entries: ... }, Character Card V2/V3 { data: { character_book: { entries: ... } } }, or { character_book: { entries: ... } }
    const container = parsed?.entries
        ? parsed
        : parsed?.data?.character_book?.entries
            ? parsed.data.character_book
            : parsed?.character_book?.entries
                ? parsed.character_book
                : null;
    if (!container || typeof container !== 'object' || !container.entries || typeof container.entries !== 'object') {
        throw new Error('不是受支持的标准世界书文件：缺少 entries');
    }
    const rawEntries = Array.isArray(container.entries)
        ? container.entries
        : Object.values(container.entries);

    const resolvedCategory = (container.name && String(container.name).trim()) || category;

    const books = rawEntries.flatMap((value: any, index: number): Worldbook[] => {
        if (!value || typeof value !== 'object' || typeof value.content !== 'string') return [];
        const uid = Number.isFinite(Number(value.uid ?? value.id)) ? Number(value.uid ?? value.id) : index;
        // Support SillyTavern character_book numeric extensions.position (0..6) first, then position strings ('before_char' | 'after_char') or numeric position
        const extPosNum = value.extensions?.position !== undefined && value.extensions?.position !== null && value.extensions?.position !== ''
            ? Number(value.extensions.position)
            : NaN;
        const directPosNum = typeof value.position === 'number' ? value.position : NaN;
        const rawPos = Number.isFinite(extPosNum)
            ? extPosNum
            : Number.isFinite(directPosNum)
                ? directPosNum
                : value.position === 'before_char'
                    ? 0
                    : value.position === 'after_char'
                        ? 1
                        : value.extensions?.position ?? value.position;
        const position = clamp(rawPos, 0, 6, 1) as WorldbookPosition;
        const rawRoleVal = value.role ?? value.extensions?.role;
        const rawRole = rawRoleVal == null ? null : clamp(rawRoleVal, 0, 2, 0) as WorldbookDepthRole;
        const primaryKeys = asStringArray(value.key ?? value.keys);
        const secondaryKeys = asStringArray(value.keysecondary ?? value.secondary_keys);
        const isDisabled = value.disable === true || value.enabled === false;
        const ext = value.extensions && typeof value.extensions === 'object' ? value.extensions : {};

        return [{
            id: `wb-${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            title: String(value.comment || value.name || `条目 ${uid + 1}`),
            content: value.content,
            category: resolvedCategory,
            createdAt: now,
            updatedAt: now,
            key: primaryKeys,
            keysecondary: secondaryKeys,
            constant: value.constant === true,
            selective: value.selective !== undefined ? value.selective === true : secondaryKeys.length > 0,
            selectiveLogic: clamp(value.selectiveLogic ?? ext.selectiveLogic, 0, 3, 0) as WorldbookSelectiveLogic,
            order: Number.isFinite(Number(value.order ?? value.insertion_order)) ? Number(value.order ?? value.insertion_order) : 100,
            position,
            disable: isDisabled,
            probability: clamp(value.probability ?? ext.probability, 0, 100, 100),
            useProbability: value.useProbability !== undefined ? value.useProbability === true : (ext.useProbability === true || value.probability !== undefined),
            depth: Math.max(0, Math.floor(clamp(value.depth ?? ext.depth, 0, 999, 4))),
            role: rawRole,
            scanDepth: (value.scanDepth ?? ext.scan_depth) == null ? null : Math.max(0, Math.floor(clamp(value.scanDepth ?? ext.scan_depth, 0, 999, 4))),
            caseSensitive: (value.caseSensitive ?? value.case_sensitive ?? ext.case_sensitive) == null ? null : Boolean(value.caseSensitive ?? value.case_sensitive ?? ext.case_sensitive),
            matchWholeWords: (value.matchWholeWords ?? ext.match_whole_words) == null ? null : Boolean(value.matchWholeWords ?? ext.match_whole_words),
            excludeRecursion: Boolean(value.excludeRecursion ?? ext.exclude_recursion),
            preventRecursion: Boolean(value.preventRecursion ?? ext.prevent_recursion),
            delayUntilRecursion: Boolean(value.delayUntilRecursion ?? ext.delay_until_recursion),
            sticky: Math.max(0, Math.floor(Number(value.sticky ?? ext.sticky) || 0)),
            cooldown: Math.max(0, Math.floor(Number(value.cooldown ?? ext.cooldown) || 0)),
            delay: Math.max(0, Math.floor(Number(value.delay ?? ext.delay) || 0)),
            group: typeof (value.group ?? ext.group) === 'string' ? String(value.group ?? ext.group).trim() : '',
            groupWeight: Math.max(1, Math.floor(clamp(value.groupWeight ?? ext.group_weight, 1, 10000, 100))),
            groupOverride: Boolean(value.groupOverride ?? ext.group_override),
            sourceUid: uid,
        }];
    });

    if (books.length === 0) throw new Error('世界书里没有可导入的有效条目');
    return books;
};
