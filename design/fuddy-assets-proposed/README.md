# Fuddy 候选品牌素材

状态：仅供视觉确认，尚未替换 Mac 或 iOS 的现有资源与代码。

## 候选文件

- `iphone-app-icon-1024.png`：iPhone App Icon 候选，1024 × 1024，不预切圆角。
- `iphone-splash-preview-390x844.png`：iPhone 开屏确认稿，390 × 844。
- `iphone-splash-source.png`：iPhone 开屏高分辨率生成源。
- `mac-splash-1440x1024.png`：Mac App 开屏确认稿，1440 × 1024。
- `mac-splash-source.png`：Mac 开屏高分辨率生成源。
- `sidebar-wordmark-transparent-cropped.png`：Mac / iPhone 侧边栏候选文字 Logo，透明背景，只含 `Fuddy`。
- `sidebar-wordmark-transparent.png`：透明文字 Logo 的带留白生成版本。

## 视觉约束

- 主背景为纯白。
- iPhone Icon 使用朱红色文件夹 `F` 与勾号，不包含文字。
- iPhone / Mac 开屏使用朱红图形、黑色 `Fuddy` 字标、细蓝色文件标签线和小号“已阅”章。
- Mac 与 iPhone 侧边栏顶部只使用 `Fuddy` 文字 Logo，不显示 `F` 图形。
- 盖章与文件标签只作为少量品牌元素，不扩展为整页复古表单。

## 后续确认后处理

确认视觉后，再根据 iOS Asset Catalog、Launch Screen 与 Electron 窗口实现的实际规格生成最终切图并替换；当前目录不被应用代码引用。
