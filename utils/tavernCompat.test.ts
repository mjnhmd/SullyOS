import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
    applyTavernRegexRules,
    compilePresetForChatApp,
    createTavernVariableStore,
    expandTavernMacros,
} from './tavernPreset';
import {
    compileStoryPreset,
    parseStoryDisplayBlocks,
    parseStoryTheaterPreset,
} from './storyTheater';
import {
    convertTavernCardToCharacter,
    extractTavernCardFromPng,
    parseAnyCharacterCardFile,
} from './tavernCard';
import {
    parseStandardWorldbook,
    resolveWorldbookEntries,
} from './worldbook';

function buildMinimalPngWithTextChunk(keyword: string, textValue: string): Uint8Array {
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const enc = new TextEncoder();

    const makeChunk = (type: string, data: Uint8Array): Uint8Array => {
        const out = new Uint8Array(12 + data.length);
        const view = new DataView(out.buffer);
        view.setUint32(0, data.length);
        out.set(enc.encode(type), 4);
        out.set(data, 8);
        view.setUint32(8 + data.length, 0); // CRC not checked by reader
        return out;
    };

    const ihdr = makeChunk('IHDR', new Uint8Array(13));
    const keyBytes = enc.encode(keyword);
    const valBytes = enc.encode(textValue);
    const textData = new Uint8Array(keyBytes.length + 1 + valBytes.length);
    textData.set(keyBytes, 0);
    textData[keyBytes.length] = 0;
    textData.set(valBytes, keyBytes.length + 1);
    const textChunk = makeChunk('tEXt', textData);
    const iend = makeChunk('IEND', new Uint8Array(0));

    const total = new Uint8Array(sig.length + ihdr.length + textChunk.length + iend.length);
    let offset = 0;
    for (const part of [sig, ihdr, textChunk, iend]) {
        total.set(part, offset);
        offset += part.length;
    }
    return total;
}

describe('1. 直接导入酒馆预设 (SillyTavern & Nuojiji Preset Direct Import)', () => {
    it('直接解析并编译桌面的酒馆预设 v0.8_-_1.json，完整支持 setvar/getvar 与 regex_scripts', () => {
        const rawJson = fs.readFileSync('/Users/mengjingnan/Desktop/v0.8_-_1.json', 'utf8');
        const preset = parseStoryTheaterPreset(rawJson, 'v0.8_-_1.json');

        expect(preset.document.schema).toBe('sullyos.story-preset');
        expect(preset.document.prompts.length).toBeGreaterThan(50);
        expect(preset.document.regexRules?.length).toBeGreaterThanOrEqual(14);

        const compiled = compileStoryPreset({
            preset,
            userName: '小帅',
            characterNames: ['特图'],
            historyMessages: [{ role: 'user', content: '你好，我想开始一段冒险' }],
            slots: {
                actors: '【角色设定】特图：唯一神',
                persona: '【用户设定】小帅',
                scenario: '神秘酒馆',
                worldBefore: '前置世界书内容',
                worldAfter: '后置世界书内容',
            },
        });

        const joined = compiled.messages.map(m => m.content).join('\n\n');
        // No unexpanded {{setvar}} or {{getvar}} should remain in compiled output!
        expect(joined).not.toMatch(/\{\{(?:get|set)var::/i);
        // Second-person POV and user agency from v0.8's enabled setvar switches should be expanded into the prompt!
        expect(joined).toContain('使用第二人称进行创作');
        expect(joined).toContain('不小于 800字');
        // Prompt-time regex rule `用户输入规范` should wrap user history in <latest_input>
        const userHistoryMsg = compiled.messages.find(m => m.role === 'user' && m.content.includes('我想开始一段冒险'));
        expect(userHistoryMsg?.content).toContain('<latest_input>');
    });

    it('正常聊天模式 (compilePresetForChatApp) 自动剥离小说标签要求并保留文风与人设', () => {
        const rawJson = fs.readFileSync('/Users/mengjingnan/Desktop/v0.8_-_1.json', 'utf8');
        const preset = parseStoryTheaterPreset(rawJson, 'v0.8_-_1.json');
        const chatCompiled = compilePresetForChatApp(preset.document, {
            userName: '小帅',
            charName: '特图',
            allowFormatOverride: false,
        });

        expect(chatCompiled.preHistorySystemBlock).toContain('日本轻小说');
        const postJoined = chatCompiled.postHistoryMessages.map(m => m.content).join('\n');
        expect(postJoined).toContain('使用第二人称进行创作');
        expect(postJoined).not.toContain('<now_plot>');
    });

    it('剧场展示层原生兼容酒馆的 <draft>、<scene_time>、<now_plot>、<action>', () => {
        const blocks = parseStoryDisplayBlocks(
            `<draft>思考内容</draft><scene_time>2026-10-17T08:00|星期六|朝|晴</scene_time><now_plot>「早上好！」她笑着推开门。</now_plot><action><choice><label>打招呼</label><reply>早安</reply></choice></action>`,
        );
        expect(blocks.map(b => b.kind)).toEqual(['backstage', 'scene', 'story', 'choices']);
    });
});

describe('2. 直接导入酒馆角色卡 (PNG ccv3/chara & JSON + 内嵌世界书)', () => {
    it('从 PNG 的 tEXt (chara / ccv3) 块提取酒馆角色卡、头像、开场白与内嵌 character_book', async () => {
        const cardV2 = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: '艾莉丝',
                description: '银发红瞳的魔法学院优等生。',
                personality: '外冷内热、认真严谨',
                scenario: '魔法学院图书馆的雨夜',
                first_mes: '这么晚了，你还在图书馆找什么禁书吗？',
                alternate_greetings: ['早安，今天的魔药课准备好了吗？'],
                system_prompt: '始终保持角色语气。',
                character_book: {
                    name: '艾莉丝专属设定集',
                    entries: [
                        {
                            uid: 1,
                            comment: '学院禁书区',
                            content: '禁书区位于图书馆地下三层。',
                            keys: ['禁书', '地下'],
                            constant: false,
                            enabled: true,
                            position: 'after_char',
                            insertion_order: 50,
                        },
                    ],
                },
                extensions: {
                    regex_scripts: [
                        {
                            scriptName: '测试清理',
                            findRegex: '/<test>/g',
                            replaceString: '',
                            disabled: false,
                            promptOnly: true,
                        },
                    ],
                },
            },
        };

        const base64Payload = Buffer.from(JSON.stringify(cardV2), 'utf8').toString('base64');
        const pngBytes = buildMinimalPngWithTextChunk('chara', base64Payload);

        const extracted = extractTavernCardFromPng(pngBytes);
        expect(extracted?.data?.name).toBe('艾莉丝');

        const file = new File([pngBytes.buffer as ArrayBuffer], 'alice.png', { type: 'image/png' });
        const result = await parseAnyCharacterCardFile(file, 1000);

        expect(result.sourceFormat).toBe('tavern');
        expect(result.character.name).toBe('艾莉丝');
        expect(result.character.avatar).toMatch(/^data:image\/png;base64,/);
        expect(result.character.systemPrompt).toContain('银发红瞳的魔法学院优等生');
        expect(result.character.systemPrompt).toContain('【性格】\n外冷内热');
        expect(result.greetings).toEqual([
            '这么晚了，你还在图书馆找什么禁书吗？',
            '早安，今天的魔药课准备好了吗？',
        ]);
        expect(result.worldbooks).toHaveLength(1);
        expect(result.worldbooks[0].title).toBe('学院禁书区');
        expect(result.worldbooks[0].category).toBe('艾莉丝专属设定集');
        expect(result.character.mountedWorldbooks).toHaveLength(1);
        expect(result.character.tavernRegexRules).toHaveLength(1);
    });
});

describe('3. 酒馆世界书高级递归与 Inclusion Group 权重组', () => {
    it('支持递归触发 (delayUntilRecursion / preventRecursion / excludeRecursion) 与 Inclusion Group 优先级覆盖', () => {
        const wbJson = JSON.stringify({
            entries: {
                0: {
                    uid: 1,
                    comment: '表层线索：古堡',
                    content: '古堡深处藏着血族圣器。',
                    key: ['古堡'],
                    constant: false,
                    order: 10,
                },
                1: {
                    uid: 2,
                    comment: '深层递归线索：血族圣器',
                    content: '血族圣器会在满月之夜苏醒。',
                    key: ['血族圣器'],
                    constant: false,
                    delayUntilRecursion: true,
                    order: 20,
                },
                2: {
                    uid: 3,
                    comment: '天气组：普通阴天',
                    content: '天空阴沉。',
                    key: ['古堡'],
                    constant: false,
                    group: 'weather_group',
                    groupWeight: 100,
                    groupOverride: false,
                    order: 30,
                },
                3: {
                    uid: 4,
                    comment: '天气组：血月降临（优先覆盖）',
                    content: '猩红的血月笼罩古堡。',
                    key: ['古堡'],
                    constant: false,
                    group: 'weather_group',
                    groupWeight: 10,
                    groupOverride: true,
                    order: 40,
                },
            },
        });

        const books = parseStandardWorldbook(wbJson, '古堡设定');
        expect(books).toHaveLength(4);

        const resolved = resolveWorldbookEntries(books, [{ role: 'user', content: '我们走进了古堡' }], '特图', '小帅');
        const titles = resolved.map(r => r.book.title);
        // Entry 1 ("表层线索：古堡") triggers on user message, which recursively triggers Entry 2 ("深层递归线索：血族圣器")!
        expect(titles).toContain('表层线索：古堡');
        expect(titles).toContain('深层递归线索：血族圣器');
        // In `weather_group`, Entry 4 has `groupOverride: true` so it deterministically beats Entry 3!
        expect(titles).toContain('天气组：血月降临（优先覆盖）');
        expect(titles).not.toContain('天气组：普通阴天');
    });
});


describe('4. 桌面真实图片与群像角色卡 (1_11.png + 3张转码立绘图片) 完整兼容验证', () => {
    it('解析 1_11.png (县城 V3 群像卡)：自动拆分为独立角色列表 + 同名分组 + 独立立绘头像 + 优先读取 extensions.position=4 + 展开 {{roll:1d20}} + Display 正则渲染 HTML', async () => {
        const pngBytes = fs.readFileSync('/Users/mengjingnan/Desktop/1_11.png');
        const file = new File([pngBytes], '1_11.png', { type: 'image/png' });
        const parsed = await parseAnyCharacterCardFile(file, 2000);

        expect(parsed.sourceFormat).toBe('tavern');
        expect(parsed.suggestedGroupName).toBe('县城');
        expect(parsed.worldbooks).toHaveLength(61);

        // 15 distinct sub-characters + 1 hub entry = 16 characters
        expect(parsed.characters).toHaveLength(16);
        const charNames = parsed.characters.map(c => c.character.name);
        expect(charNames).toContain('张子薇');
        expect(charNames).toContain('孙翌童');
        expect(charNames).toContain('柳青');
        expect(charNames).toContain('李南星');
        expect(charNames).toContain('庞咏萱');
        expect(charNames).toContain('县城 · 主页图鉴');

        // Verify each split character has its dedicated portrait URL extracted from regex_scripts and summary from 人物速览
        const liuQing = parsed.characters.find(c => c.character.name === '柳青')!;
        expect(liuQing.character.avatar).toContain('liu_qing');
        expect(liuQing.character.description).toContain('JK和娃圈行家');
        expect(liuQing.greetings).toHaveLength(1);
        expect(liuQing.greetings[0]).toContain('柳青|外出');

        // Verify extensions.position=4 takes priority over legacy position="after_char"
        const sceneInfoWb = parsed.worldbooks.find(w => w.title.trim() === '插图')!;
        expect(sceneInfoWb.position).toBe(4);
        expect(sceneInfoWb.depth).toBe(0);

        const cotWb = parsed.worldbooks.find(w => w.title.trim() === '爱的思维链')!;
        expect(cotWb.position).toBe(4);
        expect(cotWb.depth).toBe(0);

        // Verify {{roll:1d20}} dice macro expansion in 性斗骰子 worldbook
        const diceWb = parsed.worldbooks.find(w => w.title.trim() === '性斗骰子')!;
        const resolved = resolveWorldbookEntries([{ ...diceWb, disable: false }], [{ role: 'user', content: '进入nsfw场景' }], '柳青', '小帅');
        expect(resolved).toHaveLength(1);
        expect(resolved[0].content).not.toContain('{{roll:1d20}}');
        expect(resolved[0].content).toMatch(/①:1d20=\d+/);

        // Verify Display regex transforms <SceneInfo> and 【主页】 into rich <!DOCTYPE html> blocks
        const transformedGreeting = applyTavernRegexRules(
            liuQing.greetings[0],
            liuQing.character.tavernRegexRules,
            { timing: 'display', role: 'ai', userName: '小帅', charName: '柳青' },
        );
        expect(transformedGreeting).toContain('<!DOCTYPE html>');
        expect(transformedGreeting).toContain('scene-info-panel');
    });


    it('通用多角色群像卡识别：不依赖 <SceneInfo>，支持普通【角色线】开场白、正文人名高频匹配、以及纯世界书多角色提取', () => {
        const genericMultiCard = {
            spec: 'chara_card_v2',
            data: {
                name: '星海学园',
                description: '一所位于人工岛上的超能力学院。',
                first_mes: '【苏晴 · 天台偶遇】\n午休时间的天台上，苏晴正靠在栏杆边翻阅一本旧乐谱。听到脚步声，苏晴转过头看向你。',
                alternate_greetings: [
                    '【苏晴 · 琴房夜练】\n傍晚的琴房里只剩下苏晴一个人弹奏钢琴。',
                    '图书馆的角落里，沈清瑶推了推眼镜，把一叠整理好的古籍递到你面前。「这是你上次找的资料。」沈清瑶轻声说道。',
                    '[角色：夏凛]\n训练场上，夏凛擦去额头的汗水，朝你勾了勾手指。',
                ],
                character_book: {
                    name: '星海学园设定集',
                    entries: [
                        {
                            uid: 1,
                            comment: '苏晴',
                            keys: ['苏晴'],
                            content: '身份：音乐科二年级生，温柔安静的钢琴少女。\n外貌：长发及腰，白皙清秀。\n![苏晴](https://example.com/suqing.png)',
                        },
                        {
                            uid: 2,
                            comment: '沈清瑶',
                            keys: ['沈清瑶'],
                            content: '身份：图书委员长，性格清冷严谨。\n外貌：黑长直，银框眼镜。',
                        },
                        {
                            uid: 3,
                            comment: '夏凛',
                            keys: ['夏凛'],
                            content: '身份：剑道部主将，直率爽朗。',
                        },
                    ],
                },
            },
        };

        const res = convertTavernCardToCharacter(genericMultiCard, { now: 5000 });
        expect(res.suggestedGroupName).toBe('星海学园');
        const names = res.characters.map(c => c.character.name);
        expect(names).toEqual(['苏晴', '沈清瑶', '夏凛', '星海学园（全员沙盒）']);

        const suqing = res.characters.find(c => c.character.name === '苏晴')!;
        expect(suqing.greetings).toHaveLength(2);
        expect(suqing.character.avatar).toBe('https://example.com/suqing.png');
        expect(suqing.character.description).toContain('音乐科二年级生');
    });

    it('兼容桌面 3 张被重命名为 .png 的 JPEG 立绘图片，自动识别真实 MIME 并生成可用角色卡而不报错', async () => {
        const paths = [
            '/Users/mengjingnan/Desktop/232624895728480__00001_.png',
            '/Users/mengjingnan/Desktop/138bc55101f9460bba39cd8f918ee502.png',
            '/Users/mengjingnan/Desktop/48b46017145056c2.png',
        ];
        for (const p of paths) {
            const bytes = fs.readFileSync(p);
            const name = p.split('/').pop()!;
            const file = new File([bytes], name, { type: 'image/png' });
            const parsed = await parseAnyCharacterCardFile(file, 3000);
            expect(parsed.sourceFormat).toBe('image_fallback');
            expect(parsed.character.avatar).toMatch(/^data:image\/jpeg;base64,/);
            expect(parsed.characters).toHaveLength(1);
            expect(parsed.warning).toBeTruthy();
        }
    });
});
