# 抖音表情嗅探器

一个 Chrome 浏览器扩展，用于自动抓取抖音网页版的表情/贴图资源链接，支持**收藏表情包**与**对话表情包**双通道独立捕获，内置实时预览、一键下载、导出等功能。

## 功能概览

### 双通道独立捕获

| 通道 | 数据来源 | 域名 | 颜色标识 |
|------|---------|------|---------|
| 收藏表情包 | 表情面板（个人收藏） | `byteimg.com` | 红色 |
| 对话表情包 | 聊天消息中的表情 | `douyinpic.com` | 紫色 |

两个通道各自拥有**独立开关**、**独立计数**、**独立预览**、**独立下载**，互不干扰。

### 核心特性

- **双通道抓取**：DOM 扫描 + 网络请求拦截（`webRequest`），互补覆盖
- **智能去重**：按「对象 key」去重，自动合并同一张图在不同 CDN 节点、不同签名参数下的多个 URL
- **防盗链绕过**：通过 `declarativeNetRequest` 注入 Referer 头，突破 403 防盗链限制
- **实时预览**：弹窗内 4 列网格预览缩略图，支持点击放大、单张下载
- **一键下载**：分区批量下载，自动按来源分目录保存
- **导出 & 复制**：支持导出 JSON/TXT 文件，复制全部或仅新增链接到剪贴板
- **深色潮流 UI**：抖音品牌色渐变设计，Toast 提示，开关动画

## 安装方法

### 从源码安装（开发者模式）

1. 下载或克隆本项目到本地

   ```bash
   git clone https://github.com/Kyler404/douyin-snatcher.git
   ```

2. 打开 Chrome 浏览器，进入 `chrome://extensions/`
3. 开启右上角的**「开发者模式」**
4. 点击**「加载已解压的扩展程序」**
5. 选择项目根目录（包含 `manifest.json` 的文件夹）
6. 扩展图标将出现在工具栏中

### 使用步骤

1. 打开 [抖音网页版](https://www.douyin.com/) 并登录
2. 点击工具栏中的扩展图标，打开弹窗
3. 根据需要开启**「收藏表情包」**和/或**「对话表情包」**开关
4. 在抖音页面中浏览表情面板或进行聊天对话，扩展将自动捕获表情资源
5. 在弹窗预览区查看捕获结果，点击**「下载全部」**批量下载

## 技术架构

### 双通道抓取

```
┌─────────────────────────────────────────────┐
│              content.js (DOM 层)              │
│  MutationObserver 监听 DOM 变化              │
│  ├─ 面板表情: img[src*="byteimg"] + emoticon  │
│  └─ 对话表情: .MessageItemEmojiemojiBox img  │
│         │                                    │
│         ▼ safeSend({type, url, source})       │
├─────────────────────────────────────────────┤
│            background.js (网络层)             │
│  webRequest.onCompleted 拦截                  │
│  ├─ URL 模式: *://*.byteimg.com/*            │
│  └─ 关键词: emoticon                          │
│         │                                    │
│         ▼ storeURL() → keyOf() 去重           │
├─────────────────────────────────────────────┤
│          declarativeNetRequest               │
│  rules.json: 注入 Referer 头                 │
│  ├─ byteimg.com → Referer: douyin.com         │
│  └─ douyinpic.com → Referer: douyin.com       │
└─────────────────────────────────────────────┘
```

### 智能去重机制

抖音同一张表情图每次加载可能从不同的 CDN 子域名（如 `p3-` / `p26-`）下发，并携带不同的签名参数（`x-signature`、`x-expires`）和尺寸参数（`resize`）。这些只是「同一张图」的不同呈现。

去重键提取逻辑：

```javascript
// 取 URL 路径中 ~ 之前的「对象 key」部分
const keyOf = (url) => {
  const path = url.replace(/&amp;/g, "&").split("?")[0];
  const m = path.match(/\/[^/]+\/([^~?]+)/);
  return m ? m[1] : path;
};
```

忽略主机名、签名、尺寸等所有可变部分，仅以对象 key 作为唯一标识，并始终保存签名最新的完整 URL。

### 防盗链绕过

抖音图片资源（`byteimg.com`、`douyinpic.com`）启用了 Referer 防盗链，直接请求会返回 403。本扩展通过 `declarativeNetRequest` 静态规则，将所有发往这两个域名的请求注入 `Referer: https://www.douyin.com/` 头，从而绕过防盗链限制，使预览和下载均可正常工作。

## 目录结构

```
douyin-snatcher/
├── manifest.json          # 扩展清单（Manifest V3）
├── background.js          # Service Worker：网络拦截、去重、存储
├── content.js             # 内容脚本：DOM 扫描、MutationObserver
├── popup.html             # 弹窗 UI
├── popup.js              # 弹窗交互逻辑
├── rules.json            # declarativeNetRequest 规则（Referer 注入）
├── icons/
│   ├── icon16.png         # 工具栏图标 16x16
│   ├── icon48.png         # 管理页图标 48x48
│   └── icon128.png        # 商店图标 128x128
├── README.md             # 项目文档
├── LICENSE               # MIT 许可证
├── CHANGELOG.md          # 版本变更记录
└── .gitignore            # Git 忽略规则
```

## 权限说明

| 权限 | 用途 |
|------|------|
| `webRequest` | 监听抖音页面的图片网络请求 |
| `declarativeNetRequest` | 注入 Referer 头绕过防盗链 |
| `declarativeNetRequestWithHostAccess` | 对指定主机生效的 DNR 规则 |
| `storage` | 持久化捕获的 URL 列表和开关状态 |
| `downloads` | 下载表情图片到本地 |

**Host 权限**：
- `*://*.douyin.com/*` — 注入 content script
- `*://*.byteimg.com/*` — 拦截/注入图片请求

## FAQ

**Q: 为什么开关默认是关闭的？**

A: 为了避免在用户不需要时产生不必要的网络监听和存储开销。打开扩展弹窗后手动开启即可。

**Q: 关闭开关后已捕获的记录会怎样？**

A: 关闭某个开关时，会自动清空该通道的捕获记录（内存 + 存储），另一个通道的记录不受影响。

**Q: 预览区图片加载失败（显示警告图标）怎么办？**

A: 确保扩展已正确加载且 `declarativeNetRequest` 规则生效。如果刚安装扩展，刷新抖音页面后重试。

**Q: 捕获数量上限是多少？**

A: 最多保留 1000 条记录（两个通道共用），超出后自动移除最早的记录。

**Q: 下载的图片保存在哪里？**

A: 收藏表情包保存到 `douyin-emoticons/` 目录，对话表情包保存到 `douyin-chat/` 目录，位于浏览器默认下载路径下。

## 技术栈

- Chrome Extension Manifest V3
- Vanilla JavaScript（无框架依赖）
- Chrome Extensions API（`webRequest`、`declarativeNetRequest`、`storage`、`downloads`、`tabs`）
- MutationObserver DOM 监听

## 许可证

[MIT License](LICENSE)
