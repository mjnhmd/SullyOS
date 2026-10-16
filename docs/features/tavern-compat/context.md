# 酒馆（SillyTavern）/ 糯叽机全量兼容改造 & 桌面预设 App & GitHub 备份修复

## 1. 用户目标
将 `SullyOS`（糯米机）改造为像糯叽机（nuojiji）一样原生完全兼容 SillyTavern（酒馆）生态，并修复安卓端 GitHub 云备份上传失败问题：
1. **独立桌面「预设」App**：提供统一的预设管理入口（放在桌面第一屏「见面」图标旁），**一次导入预设，正常聊天（Message）、见面陪伴、见面剧场全局同时生效**（同时支持按角色单独覆盖绑定）。
2. **直接导入酒馆预设（SillyTavern Preset `.json`）**、糯叽机预设（`.nuopreset.json`）与糯米机预设（`.sully.json`）。
3. **直接导入酒馆角色卡（`.png` / `.json`，支持 V2 `chara` 与 V3 `ccv3`）**，自动提取头像、拼接人设、初始化开场白、提取内嵌世界书与正则。
4. **直接导入酒馆世界书（`.json` / 角色卡内嵌世界书）**，补齐多步递归、Inclusion Group 权重组、sticky/cooldown/delay 高级触发逻辑。
5. **修复安卓端 GitHub 云备份上传 Release 资产报 `Failed to fetch`（`uploads.github.com` CORS 拦截）问题**。

## 2. 当前状态
- **已完成开发、单测验证、前端构建、Android APK 重新签名打包，并通过 POPO 发送给郝梦迪（`haomengdi@corp.netease.com`）确认送达。**
- 本地产物路径：`/Users/mengjingnan/Desktop/SullyOS-Android-v3.5.11-tavern-compat.apk`
- 代码保留在工作区 `/Users/mengjingnan/SullyOS`（遵循 Git 规则，未自动 commit / push）。

## 3. 关键改动与原因

### 3.1 独立桌面「预设」App（一次导入，全局生效）
- **新增文件**：`/Users/mengjingnan/SullyOS/apps/PresetApp.tsx`
- **桌面入口与位置**：
  - 在 `/Users/mengjingnan/SullyOS/types.ts` 新增 `AppID.Presets = 'presets'`，并在 `/Users/mengjingnan/SullyOS/constants.tsx`、`/Users/mengjingnan/SullyOS/components/PhoneShell.tsx`、`/Users/mengjingnan/SullyOS/components/os/appPreload.ts`、`/Users/mengjingnan/SullyOS/components/os/acnhIcons.tsx`、`/Users/mengjingnan/SullyOS/utils/safeAreaApps.ts` 注册。
  - 在 `/Users/mengjingnan/SullyOS/apps/Launcher.tsx` 中兼容老用户持久化的 `launcherAppOrder`，自动将 `presets` 插入桌面第一屏（紧跟 `date`「见面」之后），避免升级 APK 后新图标被挤到最后一页找不到。
- **全局生效机制**（`/Users/mengjingnan/SullyOS/utils/tavernPreset.ts`）：
  - 新增 `getGlobalActivePresetId` / `setGlobalActivePresetId` / `resolveEffectivePresetIdForChar(char)`。
  - 在「预设」App 导入预设后，自动设为**全局激活预设**。
  - **正常聊天**（`/Users/mengjingnan/SullyOS/utils/chatRequestPayload.ts`）、**见面·陪伴**（`/Users/mengjingnan/SullyOS/utils/datePrompts.ts`）、**见面·剧场**（`/Users/mengjingnan/SullyOS/utils/storyTheater.ts` & `/Users/mengjingnan/SullyOS/components/date/story/StoryTheater.tsx`）统一读取 `resolveEffectivePresetIdForChar(char)`（优先角色单独绑定预设，未绑定时自动使用全局激活预设），实现一次导入三处同时生效。

### 3.2 修复安卓端 GitHub 云备份上传 `uploads.github.com` 报 `Failed to fetch`
- **根因**：`/Users/mengjingnan/SullyOS/utils/githubClient.ts` 的 `uploadOneAsset()` 在 `isNative() && !shouldUseGithubProxy(config)` 分支下仍然使用了浏览器 `fetch('https://uploads.github.com/...')`。安卓 Capacitor WebView 来源为 `https://localhost`，跨域 POST 带 `Authorization` 和 `Content-Type: application/zip` 会触发 CORS 预检（`OPTIONS`），而 `uploads.github.com` 对 `OPTIONS` 返回 400 且无 `Access-Control-Allow-Origin` 头，导致 ~250ms 直接报 `TypeError: Failed to fetch`。
- **修复**：在 `/Users/mengjingnan/SullyOS/utils/githubClient.ts` 中，当 `isNative() && !shouldUseGithubProxy(config)` 时，改为调用 `ghRequest()`（底层走 `CapacitorHttp.request` 原生 HTTP 客户端 + Base64 `dataType: 'file'` 直传），彻底绕过 WebView CORS 限制。

### 3.3 酒馆预设 / 角色卡 / 世界书全兼容
- `/Users/mengjingnan/SullyOS/utils/tavernPreset.ts`：解析酒馆预设、糯叽机预设，支持 `{{setvar}}`/`{{getvar}}`/`{{addvar}}`/`{{incvar}}`/`{{decvar}}`/`{{random}}`、Prompt/Display 正则与思维链剥离。
- `/Users/mengjingnan/SullyOS/utils/tavernCard.ts` & `/Users/mengjingnan/SullyOS/apps/Character.tsx`：支持酒馆 `.png` / `.json` 角色卡批量导入，自动提取头像、人设、开场白、内嵌世界书与正则。
- `/Users/mengjingnan/SullyOS/utils/worldbook.ts` & `/Users/mengjingnan/SullyOS/apps/WorldbookApp.tsx`：支持酒馆世界书批量导入及递归、权重组、sticky/cooldown/delay 高级触发规则。

## 4. 验证证据
- 单元测试：`npx vitest run utils/tavernCompat.test.ts utils/safeAreaApps.test.ts`（2 个测试文件共 8 项测试全部通过）。
- 构建验证：`pnpm run build:chat-preview && pnpm run build:workers && npx vite build --mode capacitor` 通过。
- APK 签名校验：`apksigner verify --verbose /Users/mengjingnan/Desktop/SullyOS-Android-v3.5.11-tavern-compat.apk`（v1/v2/v3 签名校验通过）。
- POPO 发送回查：已发送至 `haomengdi@corp.netease.com` 且回查确认送达。
