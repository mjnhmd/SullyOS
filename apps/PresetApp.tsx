import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft,
    Check,
    Copy,
    DownloadSimple,
    Plus,
    SlidersHorizontal,
    Sparkle,
    Trash,
    UploadSimple,
    X,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import type { StoryTheaterPreset } from '../types';
import { DB } from '../utils/db';
import { readShareFile } from '../utils/pngShare';
import {
    createBlankStoryPreset,
    downloadStoryPreset,
    duplicateStoryPreset,
    estimateStoryTokens,
    getPresetPromptStats,
    parseStoryTheaterPreset,
    withBuiltInStoryPresets,
} from '../utils/storyTheater';
import {
    getGlobalActivePresetId,
    getGlobalPresetChatFormatOverride,
    setGlobalActivePresetId,
    setGlobalPresetChatFormatOverride,
} from '../utils/tavernPreset';
import StoryPresetMaker from '../components/date/story/StoryPresetMaker';
import { useAppShortcut } from '../utils/appShortcutLaunch';
import { AppID as ShortcutAppID } from '../types';

const PresetApp: React.FC = () => {
    const { closeApp, characters, updateCharacter, addToast } = useOS();
    const [customPresets, setCustomPresets] = useState<StoryTheaterPreset[]>([]);
    const [editingPreset, setEditingPreset] = useState<StoryTheaterPreset | null>(null);
    const [globalActiveId, setGlobalActiveId] = useState<string>(() => getGlobalActivePresetId());
    const [allowFormatOverride, setAllowFormatOverride] = useState<boolean>(() => getGlobalPresetChatFormatOverride());
    const [regexExpandedId, setRegexExpandedId] = useState<string | null>(null);
    const importInputRef = useRef<HTMLInputElement>(null);

    const presets = useMemo(() => withBuiltInStoryPresets(customPresets), [customPresets]);

    const reload = useCallback(async () => {
        try {
            const stored = await DB.getStoryTheaterPresets();
            setCustomPresets(stored.filter(p => !p.builtIn).sort((a, b) => b.updatedAt - a.updatedAt));
            setGlobalActiveId(getGlobalActivePresetId());
        } catch (err) {
            console.error('[PresetApp] Failed to load presets:', err);
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    useAppShortcut(ShortcutAppID.Presets, () => {
        setEditingPreset(null);
        void reload();
    });

    const handleActivateGlobal = async (presetId: string) => {
        const nextId = globalActiveId === presetId ? '' : presetId;
        setGlobalActivePresetId(nextId);
        setGlobalActiveId(nextId);
        // 同步清除所有角色身上残留的单独覆盖，确保一键切换时所有角色的聊天与见面立即同步生效
        for (const char of characters) {
            if (char.boundChatPresetId) {
                updateCharacter(char.id, { boundChatPresetId: undefined });
            }
        }
        const target = presets.find(p => p.id === nextId);
        if (nextId && target) {
            addToast(`已全局启用「${target.name}」：正常聊天与见面（陪伴/剧场）已同步生效`, 'success');
        } else {
            addToast('已关闭全局外部预设，恢复默认聊天与见面提示词', 'info');
        }
    };

    const handleImportFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (e.target) e.target.value = '';
        if (files.length === 0) return;

        let lastImported: StoryTheaterPreset | null = null;
        let count = 0;

        for (const file of files) {
            try {
                const source = await readShareFile(file, 'story');
                const text = await source.text();
                const imported = parseStoryTheaterPreset(text, source.name);
                await DB.saveStoryTheaterPreset(imported);
                lastImported = imported;
                count += 1;
            } catch (err: any) {
                addToast(`${file.name}: ${err?.message || '预设导入失败'}`, 'error');
            }
        }

        if (lastImported) {
            await reload();
            // 一次导入直接全局激活，正常聊天 + 见面（陪伴/剧场）立刻全部生效
            setGlobalActivePresetId(lastImported.id);
            setGlobalActiveId(lastImported.id);
            for (const char of characters) {
                if (char.boundChatPresetId) {
                    updateCharacter(char.id, { boundChatPresetId: undefined });
                }
            }
            addToast(
                count === 1
                    ? `已导入并全局启用「${lastImported.name}」（聊天与见面直接生效）`
                    : `已导入 ${count} 套预设，当前全局启用「${lastImported.name}」`,
                'success',
            );
        }
    };

    const handleCreateBlank = async () => {
        const created = createBlankStoryPreset(`自定义预设 ${customPresets.length + 1}`);
        await DB.saveStoryTheaterPreset(created);
        setCustomPresets(prev => [created, ...prev]);
        setEditingPreset(created);
    };

    const handleSavePreset = async (next: StoryTheaterPreset) => {
        if (next.builtIn) return;
        await DB.saveStoryTheaterPreset(next);
        setCustomPresets(prev => [next, ...prev.filter(item => item.id !== next.id)]);
        setEditingPreset(next);
        addToast('预设已保存', 'success');
    };

    const handleCopyPreset = async (preset: StoryTheaterPreset) => {
        const copy = duplicateStoryPreset(preset);
        await DB.saveStoryTheaterPreset(copy);
        setCustomPresets(prev => [copy, ...prev]);
        setEditingPreset(copy);
        addToast(`已创建副本「${copy.name}」`, 'success');
    };

    const handleDeletePreset = async (preset: StoryTheaterPreset) => {
        if (preset.builtIn) return;
        await DB.deleteStoryTheaterPreset(preset.id);
        setCustomPresets(prev => prev.filter(item => item.id !== preset.id));
        if (globalActiveId === preset.id) {
            setGlobalActivePresetId('');
            setGlobalActiveId('');
        }
        setEditingPreset(null);
        addToast(`已删除预设「${preset.name}」`, 'info');
    };

    const handleToggleRegexRule = async (preset: StoryTheaterPreset, ruleId: string) => {
        if (preset.builtIn || !preset.document.regexRules) return;
        const updatedRules = preset.document.regexRules.map(r => (
            r.id === ruleId ? { ...r, enabled: !r.enabled } : r
        ));
        const updated: StoryTheaterPreset = {
            ...preset,
            updatedAt: Date.now(),
            document: {
                ...preset.document,
                regexRules: updatedRules,
            },
        };
        await DB.saveStoryTheaterPreset(updated);
        setCustomPresets(prev => prev.map(item => (item.id === updated.id ? updated : item)));
    };

    const handleToggleFormatOverride = () => {
        const next = !allowFormatOverride;
        setGlobalPresetChatFormatOverride(next);
        setAllowFormatOverride(next);
        addToast(
            next
                ? '已开启：正常聊天将完整保留预设的长文/XML格式指令'
                : '已开启气泡保护：正常聊天自动剥离小说XML格式指令，保持微信短气泡体验',
            'info',
        );
    };

    if (editingPreset) {
        return (
            <StoryPresetMaker
                preset={editingPreset}
                onBack={() => setEditingPreset(null)}
                onSave={handleSavePreset}
                onOpenCopy={handleCopyPreset}
                onDelete={editingPreset.builtIn ? undefined : handleDeletePreset}
            />
        );
    }

    const activePresetObj = presets.find(p => p.id === globalActiveId) || null;

    return (
        <div className="h-full w-full flex flex-col bg-slate-100 text-slate-800 font-sans overflow-hidden">
            {/* Top Header */}
            <header
                className="bg-white/80 backdrop-blur-xl border-b border-slate-200/80 shrink-0 sticky top-0 z-20"
                style={{ paddingTop: 'var(--safe-top)' }}
            >
                <div className="h-14 px-4 flex items-center gap-3">
                    <button
                        onClick={closeApp}
                        className="w-9 h-9 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center active:scale-90 transition-transform"
                        aria-label="返回桌面"
                    >
                        <ArrowLeft size={18} weight="bold" />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                            <SlidersHorizontal size={16} weight="bold" className="text-indigo-500" />
                            <h1 className="text-base font-bold text-slate-800 truncate">预设中心</h1>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate">
                            一次导入 · 正常聊天与见面（陪伴/剧场）全局同步生效
                        </p>
                    </div>
                    <input
                        ref={importInputRef}
                        type="file"
                        multiple
                        accept=".json,.png,application/json,image/png"
                        className="hidden"
                        onChange={handleImportFiles}
                    />
                    <button
                        onClick={() => importInputRef.current?.click()}
                        className="h-9 px-3.5 rounded-full bg-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm shadow-indigo-200 active:scale-95 transition-transform"
                    >
                        <UploadSimple size={15} weight="bold" />
                        导入预设
                    </button>
                    <button
                        onClick={handleCreateBlank}
                        className="w-9 h-9 rounded-full bg-slate-900 text-white flex items-center justify-center active:scale-90 transition-transform"
                        title="新建空白预设"
                    >
                        <Plus size={16} weight="bold" />
                    </button>
                </div>
            </header>

            {/* Main Content */}
            <main className="flex-1 overflow-y-auto px-4 py-4 pb-24 space-y-4 no-scrollbar">
                {/* Global Status Banner */}
                <section className="rounded-3xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 text-white p-4 shadow-md shadow-indigo-200/60">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/20 text-[10px] font-bold tracking-wider uppercase">
                                <Sparkle size={11} weight="fill" />
                                全局联动状态
                            </div>
                            <h2 className="mt-2 text-lg font-bold truncate">
                                {activePresetObj ? activePresetObj.name : '未启用外部预设（使用系统默认）'}
                            </h2>
                            <p className="mt-1 text-[11px] text-indigo-100 leading-relaxed">
                                {activePresetObj
                                    ? '当前预设已同时作用于【Message 正常聊天】、【见面 · 陪伴】与【见面 · 剧场】。包含变量宏（setvar/getvar）与预设正则。'
                                    : '点击下方任意预设的「全局启用」，或直接导入酒馆（SillyTavern）/ 糯叽机 / 糯米机预设文件，即可全场景一键生效。'}
                            </p>
                        </div>
                        {activePresetObj && (
                            <button
                                onClick={() => void handleActivateGlobal(activePresetObj.id)}
                                className="shrink-0 px-3 py-1.5 rounded-full bg-white/15 hover:bg-white/25 text-[11px] font-bold flex items-center gap-1"
                            >
                                <X size={12} weight="bold" />
                                停用
                            </button>
                        )}
                    </div>

                    {activePresetObj && (
                        <div className="mt-3.5 pt-3 border-t border-white/15 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-xs font-bold">正常聊天/陪伴 · 气泡格式保护</div>
                                <div className="text-[10px] text-indigo-100/90 mt-0.5">
                                    {allowFormatOverride
                                        ? '已关闭保护：保留预设中的长篇小说标签（如 <now_plot>）'
                                        : '已开启保护（推荐）：吸收预设破甲/人称/文风/COT，自动过滤长篇XML外壳'}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={handleToggleFormatOverride}
                                className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold transition-colors ${
                                    !allowFormatOverride
                                        ? 'bg-emerald-400 text-slate-950'
                                        : 'bg-white/20 text-white'
                                }`}
                            >
                                {!allowFormatOverride ? '保护中' : '原样输出'}
                            </button>
                        </div>
                    )}
                </section>

                {/* Preset List */}
                <section className="space-y-3">
                    <div className="flex items-center justify-between px-1">
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                            全部预设 ({presets.length})
                        </span>
                        <span className="text-[11px] text-slate-400">
                            支持酒馆 .json / 糯叽机 / .sully.json
                        </span>
                    </div>

                    {presets.map(preset => {
                        const isActive = globalActiveId === preset.id;
                        const stats = getPresetPromptStats(preset);
                        const regexCount = preset.document.regexRules?.length || 0;
                        const enabledRegexCount = preset.document.regexRules?.filter(r => r.enabled).length || 0;
                        const tokenEst = estimateStoryTokens(
                            preset.document.prompts.filter(p => p.enabled).map(p => p.content).join('\n')
                            + (preset.document.assistantPrefill || ''),
                        );
                        const isRegexOpen = regexExpandedId === preset.id;

                        return (
                            <div
                                key={preset.id}
                                className={`rounded-2xl bg-white border transition-all p-4 shadow-sm ${
                                    isActive
                                        ? 'border-indigo-500 ring-2 ring-indigo-500/15'
                                        : 'border-slate-200/80'
                                }`}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <h3 className="text-sm font-bold text-slate-800 truncate">
                                                {preset.name}
                                            </h3>
                                            {preset.builtIn && (
                                                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-bold">
                                                    官方内置
                                                </span>
                                            )}
                                            {isActive && (
                                                <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-bold flex items-center gap-1">
                                                    <Check size={10} weight="bold" />
                                                    全局生效中
                                                </span>
                                            )}
                                        </div>
                                        {preset.document.description && (
                                            <p className="mt-1 text-[11px] text-slate-400 line-clamp-2">
                                                {preset.document.description}
                                            </p>
                                        )}
                                        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                                            <span className="px-2 py-0.5 rounded-lg bg-slate-100 font-medium">
                                                提示词 {stats.enabled}/{stats.total} 条
                                            </span>
                                            {regexCount > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={() => setRegexExpandedId(isRegexOpen ? null : preset.id)}
                                                    className="px-2 py-0.5 rounded-lg bg-violet-50 text-violet-600 font-bold"
                                                >
                                                    酒馆正则 {enabledRegexCount}/{regexCount} 条 {isRegexOpen ? '▴' : '▾'}
                                                </button>
                                            )}
                                            <span className="px-2 py-0.5 rounded-lg bg-slate-100 font-medium">
                                                约 {tokenEst.toLocaleString()} tokens
                                            </span>
                                            <span className="px-2 py-0.5 rounded-lg bg-slate-100 font-medium">
                                                Temp {preset.document.generation.temperature}
                                            </span>
                                        </div>
                                    </div>

                                    <button
                                        type="button"
                                        onClick={() => void handleActivateGlobal(preset.id)}
                                        className={`shrink-0 px-3.5 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 ${
                                            isActive
                                                ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-200'
                                                : 'bg-slate-900 text-white'
                                        }`}
                                    >
                                        {isActive ? '已启用' : '全局启用'}
                                    </button>
                                </div>

                                {/* Expanded Regex Rules Drawer */}
                                {isRegexOpen && preset.document.regexRules && preset.document.regexRules.length > 0 && (
                                    <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
                                        <div className="text-[10px] font-bold text-slate-400 mb-1">
                                            预设内置正则脚本（随本预设自动生效）
                                        </div>
                                        {preset.document.regexRules.map(rule => (
                                            <div
                                                key={rule.id}
                                                className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-50 text-xs"
                                            >
                                                <div className="min-w-0 flex-1">
                                                    <div className="font-semibold text-slate-700 truncate">
                                                        {rule.name}
                                                    </div>
                                                    <div className="text-[10px] text-slate-400 truncate font-mono">
                                                        /{rule.pattern}/{rule.flags} · {rule.applyOnPrompt ? '送AI前 ' : ''}{rule.applyOnDisplay ? '显示时' : ''}
                                                    </div>
                                                </div>
                                                <button
                                                    type="button"
                                                    disabled={preset.builtIn}
                                                    onClick={() => void handleToggleRegexRule(preset, rule.id)}
                                                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold ${
                                                        rule.enabled
                                                            ? 'bg-emerald-100 text-emerald-700'
                                                            : 'bg-slate-200 text-slate-500'
                                                    }`}
                                                >
                                                    {rule.enabled ? 'ON' : 'OFF'}
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Card Footer Actions */}
                                <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setEditingPreset(preset)}
                                        className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200/70 text-xs font-semibold text-slate-700 flex items-center gap-1.5"
                                    >
                                        <SlidersHorizontal size={13} />
                                        {preset.builtIn ? '查看板块与条目' : '编辑板块 / 开关条目'}
                                    </button>
                                    <div className="flex items-center gap-1.5">
                                        <button
                                            type="button"
                                            onClick={() => void handleCopyPreset(preset)}
                                            className="p-2 rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200/70"
                                            title="复制为可编辑副本"
                                        >
                                            <Copy size={14} />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void downloadStoryPreset(preset)}
                                            className="p-2 rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200/70"
                                            title="导出预设文件"
                                        >
                                            <DownloadSimple size={14} />
                                        </button>
                                        {!preset.builtIn && (
                                            <button
                                                type="button"
                                                onClick={() => void handleDeletePreset(preset)}
                                                className="p-2 rounded-xl bg-rose-50 text-rose-500 hover:bg-rose-100"
                                                title="删除预设"
                                            >
                                                <Trash size={14} />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </section>
            </main>
        </div>
    );
};

export default PresetApp;
