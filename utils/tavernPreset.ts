import type { StoryApiRole } from './storyTheater';
import type {
    StoryTheaterPresetDocument,
    StoryTheaterPresetPrompt,
    TavernRegexRule,
} from '../types';
import { parseTavernRegexScripts } from './tavernCard';

const ST_VARIABLE_MACRO_RE = /\{\{(get|set|add|inc|dec)(global)?var::([^:}]+?)(?:::([\s\S]*?))?\}\}/gi;
const ST_COMMENT_MACRO_RE = /\{\{\/\/[\s\S]*?\}\}/g;

const toFiniteNumber = (val: unknown): number => {
    const n = Number(String(val ?? '').trim());
    return Number.isFinite(n) ? n : 0;
};

export interface TavernMacroVariableStore {
    get: (name: string, isGlobal?: boolean) => string;
    set: (name: string, value: string | number, isGlobal?: boolean) => string;
    snapshot: () => { local: Record<string, string>; global: Record<string, string> };
}

export function createTavernVariableStore(
    initialLocal: Record<string, string> = {},
    initialGlobal: Record<string, string> = {},
): TavernMacroVariableStore {
    const local: Record<string, string> = { ...initialLocal };
    const global: Record<string, string> = { ...initialGlobal };
    return {
        get(name: string, isGlobal = false): string {
            const target = isGlobal ? global : local;
            return target[name] == null ? '' : String(target[name]);
        },
        set(name: string, value: string | number, isGlobal = false): string {
            const target = isGlobal ? global : local;
            target[name] = value == null ? '' : String(value);
            return target[name];
        },
        snapshot() {
            return { local: { ...local }, global: { ...global } };
        },
    };
}

/**
 * Evaluate SillyTavern & Nuojiji macros sequentially across prompt blocks:
 * - `{{// comment}}` -> stripped
 * - `{{setvar::name::value}}` -> sets variable and returns `""`
 * - `{{getvar::name}}` -> returns current value of `name`
 * - `{{addvar::name::delta}}` -> adds numeric delta and returns `""`
 * - `{{incvar::name}}` / `{{decvar::name}}` -> increments/decrements and returns new value
 * - `{{random::a::b::c}}` and `{{random:a,b,c}}` -> picks one random item
 * - `{{user}}`, `{{char}}`, `{{group}}`, `{{time}}`, `{{date}}` -> replaced with runtime context
 */
export function expandTavernMacros(
    text: string,
    context: {
        userName: string;
        characterNames: string[];
        store?: TavernMacroVariableStore;
        now?: Date;
    },
): string {
    if (!text || typeof text !== 'string') return '';
    const store = context.store || createTavernVariableStore();
    const now = context.now || new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const userStr = context.userName || '你';
    const charStr = context.characterNames.filter(Boolean).join('、') || '角色';

    let result = text.replace(ST_COMMENT_MACRO_RE, '');

    // Evaluate multi-pass so nested macros inside setvar values (e.g. {{setvar::weather::{{random::晴::雨}}}}) work cleanly
    for (let pass = 0; pass < 3; pass += 1) {
        let changed = false;

        // 1. {{random::a::b}} and {{random:a,b}}
        result = result.replace(/\{\{random::([^{}]+)\}\}/gi, (_m, inner: string) => {
            changed = true;
            const items = inner.split('::').map(s => s.trim()).filter(Boolean);
            return items.length ? items[Math.floor(Math.random() * items.length)] : '';
        });
        result = result.replace(/\{\{random:([^{}]+)\}\}/gi, (_m, inner: string) => {
            changed = true;
            const items = inner.split(',').map(s => s.trim()).filter(Boolean);
            return items.length ? items[Math.floor(Math.random() * items.length)] : '';
        });

        // 2. Basic identity & clock macros
        result = result
            .replace(/\{\{\s*user\s*\}\}/gi, userStr)
            .replace(/\{\{\s*char\s*\}\}/gi, charStr)
            .replace(/\{\{\s*group\s*\}\}/gi, charStr)
            .replace(/\{\{\s*time\s*\}\}/gi, timeStr)
            .replace(/\{\{\s*date\s*\}\}/gi, dateStr);

        // 3. Variable macros (innermost first: match only {{...var...}} that contain no inner `{{`)
        result = result.replace(
            /\{\{(get|set|add|inc|dec)(global)?var::([^:}]+?)(?:::((?:(?!\{\{)[\s\S])*?))?\}\}/gi,
            (_match, opRaw: string, globalFlag: string, rawName: string, rawVal?: string) => {
                changed = true;
                const op = String(opRaw).toLowerCase();
                const isGlobal = Boolean(globalFlag);
                const key = String(rawName).trim();
                if (!key) return '';
                switch (op) {
                    case 'get':
                        return store.get(key, isGlobal);
                    case 'set':
                        store.set(key, rawVal === undefined ? '' : rawVal, isGlobal);
                        return '';
                    case 'add': {
                        const next = toFiniteNumber(store.get(key, isGlobal)) + toFiniteNumber(rawVal);
                        store.set(key, next, isGlobal);
                        return '';
                    }
                    case 'inc': {
                        const next = toFiniteNumber(store.get(key, isGlobal)) + 1;
                        return store.set(key, next, isGlobal);
                    }
                    case 'dec': {
                        const next = toFiniteNumber(store.get(key, isGlobal)) - 1;
                        return store.set(key, next, isGlobal);
                    }
                    default:
                        return '';
                }
            },
        );

        if (!changed) break;
    }

    return result;
}

/**
 * Apply `TavernRegexRule[]` to a message text (for either `prompt` or `display` timing).
 */
export function applyTavernRegexRules(
    text: string,
    rules: TavernRegexRule[] | undefined,
    context: {
        timing: 'prompt' | 'display';
        role: 'user' | 'ai';
        depth?: number;
        userName?: string;
        charName?: string;
    },
): string {
    if (!text || typeof text !== 'string' || !Array.isArray(rules) || rules.length === 0) {
        return text || '';
    }

    const sorted = [...rules].sort((a, b) => (a.order || 0) - (b.order || 0));
    let output = text;

    for (const rule of sorted) {
        if (!rule || !rule.enabled) continue;
        if (context.timing === 'prompt' && !rule.applyOnPrompt) continue;
        if (context.timing === 'display' && !rule.applyOnDisplay) continue;
        if (rule.role && rule.role !== 'both' && rule.role !== context.role) continue;
        if (typeof context.depth === 'number') {
            if (rule.minDepth != null && context.depth < rule.minDepth) continue;
            if (rule.maxDepth != null && context.depth > rule.maxDepth) continue;
        }

        let patternStr = rule.pattern;
        if (rule.substituteRegex) {
            const esc = rule.substituteRegex === 2
                ? (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                : (s: string) => s;
            patternStr = patternStr
                .replace(/\{\{\s*user\s*\}\}/gi, esc(context.userName || '你'))
                .replace(/\{\{\s*char\s*\}\}/gi, esc(context.charName || '角色'));
        }
        if (!patternStr.trim()) continue;

        let regex: RegExp;
        try {
            const flags = rule.flags?.includes('g') ? rule.flags : `${rule.flags || ''}g`;
            regex = new RegExp(patternStr, flags);
        } catch {
            continue;
        }

        const trimStrings = Array.isArray(rule.trimStrings) ? rule.trimStrings.filter(Boolean) : [];
        const rawReplacement = (rule.replacement || '')
            .replace(/\{\{\s*user\s*\}\}/gi, context.userName || '你')
            .replace(/\{\{\s*char\s*\}\}/gi, context.charName || '角色');

        try {
            output = output.replace(regex, (...args) => {
                const fullMatch = String(args[0] ?? '');
                let groups = args.slice(1);
                let namedGroups: Record<string, string> = {};
                if (groups.length > 0 && typeof groups[groups.length - 1] === 'object' && groups[groups.length - 1] !== null) {
                    namedGroups = groups.pop() as Record<string, string>;
                }
                // Pop offset and original string
                groups.pop();
                groups.pop();

                const allCaptures = [fullMatch, ...groups];
                let replaced = rawReplacement.replace(/\$(\d+)/g, (m, numStr) => {
                    const idx = Number(numStr);
                    return allCaptures[idx] !== undefined ? String(allCaptures[idx]) : m;
                });
                replaced = replaced.replace(/\$<(\w+)>/g, (m, name) => (
                    namedGroups[name] !== undefined ? String(namedGroups[name]) : m
                ));
                replaced = replaced.replace(/\{\{\s*match\s*\}\}/gi, fullMatch);
                for (const trimStr of trimStrings) {
                    replaced = replaced.split(trimStr).join('');
                }
                return replaced;
            });
        } catch {
            // Ignore runtime regex error on edge inputs
        }
    }

    return output;
}

const ST_MARKER_TO_SULLY_MARKER: Record<string, NonNullable<StoryTheaterPresetPrompt['marker']>> = {
    worldInfoBefore: 'world_before',
    charDescription: 'characters',
    charPersonality: 'characters',
    personaDescription: 'user',
    worldInfoAfter: 'world_after',
    scenario: 'scenario',
    dialogueExamples: 'examples',
    chatHistory: 'history',
};

const NUOJIJI_MARKER_TO_SULLY_MARKER: Record<string, NonNullable<StoryTheaterPresetPrompt['marker']>> = {
    worldbookJailbreak: 'world_before',
    worldbookHigh: 'world_before',
    soul: 'characters',
    userProfile: 'user',
    userPersona: 'user',
    worldbookMedium: 'world_after',
    context: 'history',
};

export function isSillyTavernPresetJson(data: any): boolean {
    if (!data || typeof data !== 'object') return false;
    if (data.schema === 'sullyos.story-preset') return false;
    return Array.isArray(data.prompts) && (
        Array.isArray(data.prompt_order)
        || typeof data.openai_max_tokens === 'number'
        || typeof data.impersonation_prompt === 'string'
        || typeof data.new_chat_prompt === 'string'
    );
}

export function isNuojijiPresetJson(data: any): boolean {
    return Boolean(data && typeof data === 'object' && data.__nuojijiChatPreset === true && Array.isArray(data.blocks));
}

const normalizeRole = (role: unknown): StoryApiRole => {
    if (role === 'assistant' || role === 2) return 'assistant';
    if (role === 'user' || role === 1) return 'user';
    return 'system';
};

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

/**
 * Convert a SillyTavern Chat Completion Preset JSON directly into SullyOS `StoryTheaterPresetDocument`.
 * Preserves prompt_order, {{setvar}}/{{getvar}} macros, custom section groups (`--/xxx/--`),
 * and embedded `regex_scripts` / `SPreset.RegexBinding.regexes`.
 */
export function convertSillyTavernPresetToSullyDocument(
    data: Record<string, any>,
    fallbackName = '酒馆导入预设',
): StoryTheaterPresetDocument {
    const rawPrompts: any[] = Array.isArray(data.prompts) ? data.prompts : [];
    const promptsById = new Map<string, any>();
    for (const p of rawPrompts) {
        if (p && typeof p === 'object' && p.identifier) {
            promptsById.set(String(p.identifier), p);
        }
    }

    // Pick character_id 100001 (SillyTavern default global order) or the longest order list
    let orderList: Array<{ identifier: string; enabled?: boolean }> = [];
    if (Array.isArray(data.prompt_order) && data.prompt_order.length > 0) {
        const preferred = data.prompt_order.find((po: any) => Number(po?.character_id) === 100001 && Array.isArray(po?.order))
            || [...data.prompt_order].sort((a: any, b: any) => (b?.order?.length || 0) - (a?.order?.length || 0))[0];
        if (preferred && Array.isArray(preferred.order)) {
            orderList = preferred.order;
        }
    }

    if (orderList.length === 0) {
        orderList = rawPrompts.map((p: any, idx: number) => ({
            identifier: String(p?.identifier || `prompt_${idx + 1}`),
            enabled: p?.enabled !== false,
        }));
    }

    const prompts: StoryTheaterPresetPrompt[] = [];
    let openSection: { id: string; name: string } | null = null;
    let sectionSeq = 0;

    const closeOpenSection = () => {
        if (!openSection) return;
        prompts.push({
            id: `st_sec_end_${openSection.id}`,
            name: `${openSection.name} · 结束`,
            enabled: false,
            role: 'system',
            content: '',
            section: { id: openSection.id, name: openSection.name, edge: 'end' },
        });
        openSection = null;
    };

    for (let i = 0; i < orderList.length; i += 1) {
        const orderItem = orderList[i];
        if (!orderItem || !orderItem.identifier) continue;
        const pid = String(orderItem.identifier);
        const raw = promptsById.get(pid);
        if (!raw) continue;

        const name = String(raw.name || pid).trim();
        const content = String(raw.content || '');
        const enabled = orderItem.enabled !== undefined ? Boolean(orderItem.enabled) : raw.enabled !== false;
        const sullyMarker = ST_MARKER_TO_SULLY_MARKER[pid];

        // Native markers must not be trapped inside a custom section
        if (sullyMarker) {
            closeOpenSection();
            prompts.push({
                id: pid,
                name: name || pid,
                enabled,
                role: normalizeRole(raw.role),
                content: '',
                marker: sullyMarker,
            });
            continue;
        }

        // Detect SillyTavern decorative divider headers (e.g. `--/😯人称 /--` with empty content)
        const isDecorativeHeader = !content.trim() && (/^--\/|\/--$/.test(name) || /🌊--\/|--\//.test(name));
        if (isDecorativeHeader) {
            closeOpenSection();
            sectionSeq += 1;
            const cleanGroupName = name.replace(/^🌊?--\//, '').replace(/\/--.*$/, '').replace(/--\//g, '').trim() || `分组 ${sectionSeq}`;
            const secId = `st_grp_${sectionSeq}`;
            openSection = { id: secId, name: cleanGroupName };
            prompts.push({
                id: `st_sec_start_${secId}`,
                name: cleanGroupName,
                enabled: false,
                role: 'system',
                content: '',
                section: { id: secId, name: cleanGroupName, edge: 'start' },
            });
            continue;
        }

        prompts.push({
            id: pid,
            name: name || `条目 ${i + 1}`,
            enabled,
            role: normalizeRole(raw.role),
            content,
        });
    }
    closeOpenSection();

    // Collect regex rules from extensions.regex_scripts and extensions.SPreset.RegexBinding.regexes
    const ext = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};
    const primaryRegexes = parseTavernRegexScripts(ext.regex_scripts);
    const spresetRegexes = parseTavernRegexScripts(ext.SPreset?.RegexBinding?.regexes);
    const seenRegexNames = new Set(primaryRegexes.map(r => r.name));
    const regexRules: TavernRegexRule[] = [
        ...primaryRegexes,
        ...spresetRegexes.filter(r => !seenRegexNames.has(r.name)),
    ];

    const fixedName = typeof ext.SPreset?.FixedPresetName === 'string' && ext.SPreset.FixedPresetName.trim()
        ? ext.SPreset.FixedPresetName.trim()
        : fallbackName;

    return {
        schema: 'sullyos.story-preset',
        version: 1,
        name: fixedName,
        description: `从酒馆预设导入（共 ${prompts.filter(p => !p.section).length} 条提示词，${regexRules.length} 条正则规则）`,
        generation: {
            temperature: clampNumber(data.temperature, 0, 2, 1),
            topP: clampNumber(data.top_p, 0, 1, 1),
            frequencyPenalty: clampNumber(data.frequency_penalty, -2, 2, 0),
            presencePenalty: clampNumber(data.presence_penalty, -2, 2, 0),
            maxTokens: Math.round(clampNumber(data.openai_max_tokens, 256, 32000, 16000)),
        },
        prompts,
        assistantPrefill: typeof data.assistant_prefill === 'string' ? data.assistant_prefill : '',
        ...(regexRules.length > 0 ? { regexRules } : {}),
    };
}

/**
 * Convert a Nuojiji (`.nuopreset.json`) preset directly into SullyOS `StoryTheaterPresetDocument`.
 */
export function convertNuojijiPresetToSullyDocument(
    data: Record<string, any>,
    fallbackName = '糯叽机导入预设',
): StoryTheaterPresetDocument {
    const blocks: any[] = Array.isArray(data.blocks) ? data.blocks : [];
    const prompts: StoryTheaterPresetPrompt[] = [];
    let openSection: { id: string; name: string } | null = null;
    let sectionSeq = 0;

    const closeOpenSection = () => {
        if (!openSection) return;
        prompts.push({
            id: `nuo_sec_end_${openSection.id}`,
            name: `${openSection.name} · 结束`,
            enabled: false,
            role: 'system',
            content: '',
            section: { id: openSection.id, name: openSection.name, edge: 'end' },
        });
        openSection = null;
    };

    blocks.forEach((b: any, idx: number) => {
        if (!b || typeof b !== 'object') return;
        if (b.type === 'group') {
            closeOpenSection();
            sectionSeq += 1;
            const secId = `nuo_grp_${sectionSeq}`;
            const secName = String(b.name || `分组 ${sectionSeq}`).trim();
            openSection = { id: secId, name: secName };
            prompts.push({
                id: `nuo_sec_start_${secId}`,
                name: secName,
                enabled: false,
                role: 'system',
                content: '',
                section: { id: secId, name: secName, edge: 'start' },
            });
            return;
        }
        if (b.type === 'groupEnd') {
            closeOpenSection();
            return;
        }
        if (b.type === 'marker') {
            const sullyMarker = NUOJIJI_MARKER_TO_SULLY_MARKER[String(b.key || '')];
            if (!sullyMarker) return;
            closeOpenSection();
            prompts.push({
                id: String(b.id || `m_${b.key}_${idx}`),
                name: String(b.name || b.key),
                enabled: b.enabled !== false,
                role: normalizeRole(b.role),
                content: '',
                marker: sullyMarker,
            });
            return;
        }
        if (b.type === 'custom') {
            prompts.push({
                id: String(b.id || `custom_${idx + 1}`),
                name: String(b.name || `自定义板块 ${idx + 1}`),
                enabled: b.enabled !== false,
                role: normalizeRole(b.role),
                content: String(b.content || ''),
            });
        }
    });
    closeOpenSection();

    const regexRules = parseTavernRegexScripts(data.regexRules);
    const params = data.params && typeof data.params === 'object' ? data.params : {};

    return {
        schema: 'sullyos.story-preset',
        version: 1,
        name: String(data.name || fallbackName),
        description: `从糯叽机预设导入（共 ${prompts.filter(p => !p.section).length} 条提示词，${regexRules.length} 条正则规则）`,
        generation: {
            temperature: clampNumber(params.temperature, 0, 2, 0.9),
            topP: clampNumber(params.topP, 0, 1, 1),
            frequencyPenalty: clampNumber(params.frequencyPenalty, -2, 2, 0),
            presencePenalty: clampNumber(params.presencePenalty, -2, 2, 0),
            maxTokens: Math.round(clampNumber(params.maxTokens, 256, 32000, 16000)),
        },
        prompts,
        assistantPrefill: '',
        ...(regexRules.length > 0 ? { regexRules } : {}),
    };
}

/**
 * Compile a `StoryTheaterPresetDocument` for online ChatApp / 3D Home conversations:
 * - Evaluates `{{setvar}}` / `{{getvar}}` / `{{random}}` / `{{user}}` / `{{char}}` in order from top to bottom
 * - Separates prompts BEFORE `history` marker (injected into `systemPrompt`) from prompts AFTER `history` marker
 * - When `allowFormatOverride` is false (default for WeChat-style IM chat), strips blocks after `history` that
 *   force full-novel XML tags (`<now_plot>`, `<scene_time>`, `<draft>`, `<scene_header>`, `<story_text>`) so that
 *   the character keeps replying in natural IM chat bubbles while still benefitting from the preset's jailbreak,
 *   character shaping, writing style, POV, and anti-cliché rules!
 */
export function compilePresetForChatApp(
    document: StoryTheaterPresetDocument,
    context: {
        userName: string;
        charName: string;
        allowFormatOverride?: boolean;
    },
): {
    preHistorySystemBlock: string;
    postHistoryMessages: Array<{ role: StoryApiRole; content: string }>;
    regexRules: TavernRegexRule[];
} {
    const varStore = createTavernVariableStore();
    const characterNames = [context.charName || '角色'];
    const preBlocks: string[] = [];
    const postMessages: Array<{ role: StoryApiRole; content: string }> = [];
    let seenHistoryMarker = false;

    const isNovelFormatBlock = (name: string, rawContent: string): boolean => {
        if (context.allowFormatOverride) return false;
        const combined = `${name}\n${rawContent}`;
        return /<(?:now_plot|scene_time|scene_header|story_text|draft|summary_format|plot_area_format|action_format)\b/i.test(combined)
            || /格式要求|顶部日期|场景条|幕后暗格|镜头债|世界线小喇叭|三把勺子|出口检查/i.test(name);
    };

    for (const prompt of document.prompts) {
        if (!prompt.enabled || prompt.section) continue;
        if (prompt.marker) {
            if (prompt.marker === 'history') {
                seenHistoryMarker = true;
            }
            continue;
        }
        const raw = String(prompt.content || '');
        if (!raw.trim()) continue;

        // Always run macro expansion even on skipped format blocks in case they contain {{setvar::...}} definitions
        const expanded = expandTavernMacros(raw, {
            userName: context.userName,
            characterNames,
            store: varStore,
        }).trim();
        if (!expanded) continue;

        if (isNovelFormatBlock(prompt.name || '', expanded)) {
            // Preserve language/POV lines set via {{getvar::rencheng}} / {{getvar::juqingyuyan}} before stripping XML format instructions
            const keptLines = expanded
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => /^(?:-\s*)?(?:正文语言|使用第[一二三]人称)/.test(line));
            if (keptLines.length > 0) {
                postMessages.push({
                    role: prompt.role || 'system',
                    content: keptLines.join('\n'),
                });
            }
            continue;
        }

        if (!seenHistoryMarker) {
            preBlocks.push(expanded);
        } else {
            postMessages.push({
                role: prompt.role || 'system',
                content: expanded,
            });
        }
    }

    return {
        preHistorySystemBlock: preBlocks.length > 0
            ? `\n\n### 激活预设附加设定 (${document.name})\n${preBlocks.join('\n\n')}\n`
            : '',
        postHistoryMessages: postMessages,
        regexRules: document.regexRules || [],
    };
}


export const GLOBAL_ACTIVE_PRESET_STORAGE_KEY = 'sully_global_active_preset_id';
export const GLOBAL_PRESET_CHAT_FORMAT_OVERRIDE_KEY = 'sully_global_preset_chat_format_override';

export function getGlobalActivePresetId(): string {
    try {
        if (typeof localStorage === 'undefined') return '';
        return localStorage.getItem(GLOBAL_ACTIVE_PRESET_STORAGE_KEY) || '';
    } catch {
        return '';
    }
}

export function setGlobalActivePresetId(presetId: string): void {
    try {
        if (typeof localStorage === 'undefined') return;
        const clean = (presetId || '').trim();
        if (clean) localStorage.setItem(GLOBAL_ACTIVE_PRESET_STORAGE_KEY, clean);
        else localStorage.removeItem(GLOBAL_ACTIVE_PRESET_STORAGE_KEY);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('sully-active-preset-changed', { detail: { presetId: clean } }));
        }
    } catch {
        // Ignore storage errors
    }
}

export function getGlobalPresetChatFormatOverride(): boolean {
    try {
        if (typeof localStorage === 'undefined') return false;
        return localStorage.getItem(GLOBAL_PRESET_CHAT_FORMAT_OVERRIDE_KEY) === '1';
    } catch {
        return false;
    }
}

export function setGlobalPresetChatFormatOverride(allow: boolean): void {
    try {
        if (typeof localStorage === 'undefined') return;
        if (allow) localStorage.setItem(GLOBAL_PRESET_CHAT_FORMAT_OVERRIDE_KEY, '1');
        else localStorage.removeItem(GLOBAL_PRESET_CHAT_FORMAT_OVERRIDE_KEY);
    } catch {
        // Ignore storage errors
    }
}

/**
 * Resolve the effective preset ID for a character in ChatApp / DateApp:
 * - `'__none__'` explicitly disables presets for this character
 * - Specific `boundChatPresetId` uses that preset
 * - Empty/undefined falls back to `getGlobalActivePresetId()`
 */
export function resolveEffectivePresetIdForChar(boundChatPresetId?: string): string {
    if (boundChatPresetId === '__none__') return '';
    if (boundChatPresetId && boundChatPresetId.trim()) return boundChatPresetId.trim();
    return getGlobalActivePresetId();
}
