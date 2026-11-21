# 抖音表情嗅探器

一个 Chrome 扩展（Manifest V3），用于抓取抖音网页版的**收藏表情包**与**对话表情包**，
并在下载时自动把它们统一转成可直接导入微信的 GIF。

打开抖音 → 拨开开关 → 勾选想要的表情（或点「全选」）→ 点「下载所选 · GIF」，剩下的交给后台。

---

## 功能特性

### 双通道独立捕获

| 通道 | 来源 | 图片域名 | 标识色 |
|------|------|----------|--------|
| 收藏表情包 | 表情面板（个人收藏） | `byteimg.com` | 红色 |
| 对话表情包 | 聊天消息中的表情 | `douyinpic.com` | 紫色 |

两个通道各有**独立开关、独立计数、独立预览、独立下载**，互不干扰。

### 核心能力

- **双路抓取互补**：`MutationObserver` 扫描 DOM + `webRequest` 拦截网络请求，
  面板里点过的、聊天里发过的，两条路都兜得住。
- **按对象 key 去重**：同一张图常从不同 CDN 节点下发，还带着不同的签名与尺寸参数，
  扩展只看「对象 key」，自动合并为一个条目，并保留签名最新的 URL。
- **自动绕过防盗链**：通过 `declarativeNetRequest` 注入 `Referer`，
  解决图片直连 403 的问题（预览与下载都依赖它）。
- **实时预览**：弹窗内 4 列网格，点击缩略图可放大，悬停有单张下载按钮。
- **下载即转 GIF**：没有任何额外的转换步骤，点下载时后台自动完成。
- **进度可见**：扩展图标角标显示剩余数量，失败显示 `!`，弹窗给出成功/失败数与原因。
- **导出与复制**：支持导出 JSON / TXT，复制全部链接或仅复制新增链接到剪贴板。

---

## 下载产物规则

这三条是硬约束，实现在 `lib/imgproc.js` 里：

| 约束 | 规则 |
|------|------|
| **格式** | 一律输出 `.gif`。WebP / PNG / JPG 全部重编码；输入本身是 GIF 时**原样透传**，不做无谓重编码 |
| **尺寸** | 等比缩放，长边 ≤ **1024px**；未超限则保持原尺寸，**绝不放大** |
| **体积** | 单文件 ≤ **3MB**；超限则按 80% 逐级缩小重编码（100% → 80% → 64% → …），直到达标 |
| **下限** | 缩小时最小边不得小于 **120px**；若已到 120px 仍超 3MB，直接输出当前结果，不再继续缩小 |

动画 WebP 会逐帧解码后重新编码，**动画与透明通道都会保留**；
帧延迟低于 20ms 时钳到 20ms（GIF 规范下更小的值会被多数渲染器当成 100ms）。

产物落盘位置：

| 通道 | 目录 |
|------|------|
| 收藏表情包 | `douyin-emoticons/` |
| 对话表情包 | `douyin-chat/` |

均位于浏览器默认下载路径下，Chrome 会自动创建子目录。

- **下载所选**：每批单独建一个以下载时间命名的子目录，例如 `douyin-emoticons/2026-11-21_121500/`，多次下载互不混杂
- **单张下载**（预览图上的 ⬇）：直接放在分区目录下

---

## 安装

1. 克隆或下载本项目：

   ```bash
   git clone https://github.com/Kyler404/douyin-snatcher.git
   ```

2. 打开 `chrome://extensions/`，开启右上角**开发者模式**
3. 点击**加载已解压的扩展程序**，选择包含 `manifest.json` 的项目根目录
4. 扩展图标出现在工具栏即安装成功

> 修改代码后，需回到 `chrome://extensions/` 点一次**刷新**按钮才会生效
> （改动 `manifest.json` 时尤其必要）。

## 使用

1. 打开 [抖音网页版](https://www.douyin.com/) 并登录
2. 点击工具栏中的扩展图标打开弹窗
3. 按需开启**收藏表情包** / **对话表情包**开关
4. 浏览表情面板或进行聊天，扩展会自动捕获表情资源
5. 在弹窗预览区点缩略图左上角的勾选框多选（Shift+点击可连选，或点**全选**），再点**下载所选 · GIF**；也可以点缩略图右下角按钮下载单张

下载在后台进行：点完就可以关掉弹窗，转码不会中断。
处理期间图标角标显示剩余数量，跑完后回到弹窗会看到结果提示。

---

## 工作原理

### 双通道抓取

```
┌──────────────────────────────────────────────────┐
│  content.js —— DOM 层                             │
│  MutationObserver 监听节点变化                     │
│  ├─ 面板表情：img[src*="byteimg"] + emoticon       │
│  └─ 对话表情：.MessageItemEmojiemojiBox img        │
│                    │                             │
│                    ▼ safeSend({type,url,source}) │
├──────────────────────────────────────────────────┤
│  background.js —— 网络层                          │
│  webRequest.onCompleted 拦截                      │
│  ├─ 模式：*://*.byteimg.com/*                     │
│  └─ 关键词：emoticon                              │
│                    │                             │
│                    ▼ storeURL() → keyOf() 去重    │
├──────────────────────────────────────────────────┤
│  rules.json —— declarativeNetRequest             │
│  注入 Referer: https://www.douyin.com/            │
│  ├─ byteimg.com                                   │
│  └─ douyinpic.com                                 │
└──────────────────────────────────────────────────┘
```

### 智能去重

同一张表情图每次加载可能来自不同 CDN 子域名（`p3-` / `p26-` …），
并携带不同的 `x-signature`、`x-expires`、`resize` 参数。这些只是同一张图的不同呈现：

```javascript
// 取路径中 ~ 之前的「对象 key」作为唯一标识
const keyOf = (url) => {
  const path = url.replace(/&amp;/g, "&").split("?")[0];
  const m = path.match(/\/[^/]+\/([^~?]+)/);
  return m ? m[1] : path;
};
```

主机名、签名、尺寸全部忽略，只留对象 key，并始终保存签名最新的完整 URL。

### 后台转换链路

转码要取图、解码、逐帧重编码，单张几百毫秒到数秒，批量就是几十秒的活。
这个时长决定了它**不能放在弹窗里跑** —— 弹窗在用户点击页面任何别处时就被销毁，
正在执行的 `await` 链会当场中断，而且不抛任何错误。

```
popup.js
   │  sendMessage({type:"convert_and_download", items, dir})
   ▼
background.js（Service Worker）
   │  1. 开后台标签页 worker.html（active:false，不抢焦点）
   │  2. 等 worker 的 worker_ready 握手
   │  3. sendMessage({type:"worker_convert", items, dir})
   │  4. 根据 worker 上报的 convert_status 更新图标角标
   ▼
worker.html / worker.js（后台标签页）
   │  逐张：fetch 取图 → 解码 → 编码 GIF → chrome.downloads 落盘
   │  进度/错误写进 chrome.storage.local
   └─ 队列排空后空闲 20 秒自行关闭
```

几个容易被忽略但必须处理的设计点：

- **握手不是可选项。** `tabs.create()` 返回时，页面里的模块脚本还没执行完，
  此时发消息会撞上「监听尚未注册」的窗口期，被**静默丢弃**。所以 worker 就绪后必须回一条消息。
- **后台页自杀定时器必须可取消。** 早期实现是队列跑空后 `setTimeout(closeSelf, 2000)`，
  用户若在这 2 秒内点了另一个通道，任务入了队列、页面却被关掉，第二批就静默丢失。
  现在改为空闲 20 秒关闭，新任务进来会撤销定时器。
- **页面自己关掉要通知对方。** `tabs.onRemoved` 里同步失效状态，
  否则下一批任务会先发给一个已死的页面。
- **Service Worker 会被回收。** 内存里的 `workerTabId` 随之丢失，
  所以 worker 启动时把 tabId 写进 storage，background 靠它 + 定向 ping 找回并复用同一页面，
  连续下载两个通道只会闪现一个后台标签页。
- **别让 Chrome 丢弃后台页。** 创建后立即 `autoDiscardable: false`，
  否则内存压力大时大批量任务会中途消失。

### 为什么不用 ffmpeg.wasm

最初的转换功能参考了一个基于 ffmpeg 的桌面工具，但把 ffmpeg.wasm 搬进扩展的代价是：
体积增加约 30MB、需要放宽 MV3 的 CSP、还要处理 wasm 与弹窗生命周期的冲突。

实测确认 Chrome 原生的 `ImageDecoder`（WebCodecs）可以直接逐帧解码**动画 WebP**
（240×240 / 4 帧耗时约 10ms），配合 9KB 的纯 JS GIF 编码器 `gifenc` 即可完成全部工作。
所以最终方案是**原生解码 + 纯 JS 编码**：零 wasm、零外部依赖、完全离线，
扩展体积只增加了约 20KB。

---

## 目录结构

```
douyin-snatcher/
├── manifest.json          # 扩展清单（Manifest V3）
├── background.js          # Service Worker：网络拦截、去重、存储、任务派发
├── content.js             # 内容脚本：DOM 扫描、MutationObserver
├── popup.html             # 弹窗 UI
├── popup.js               # 弹窗交互逻辑
├── worker.html            # 后台转换工作页（标签页形式）
├── worker.js              # 后台转换：取图 → 解码 → 编码 GIF → 落盘
├── rules.json             # declarativeNetRequest 规则（Referer 注入）
├── lib/
│   ├── imgproc.js         # 图片处理管线：任意格式 → GIF（尺寸/体积约束）
│   └── gifenc.esm.js      # GIF 编码器（约 9KB 纯 JS）
├── icons/                 # 扩展图标 16 / 48 / 128
├── README.md              # 项目文档
├── CHANGELOG.md           # 版本变更记录
├── LICENSE                # MIT 许可证
└── .gitignore             # Git 忽略规则
```

## 权限说明

| 权限 | 用途 |
|------|------|
| `webRequest` | 监听抖音页面的图片网络请求 |
| `storage` | 持久化捕获列表、开关状态与转换进度 |
| `downloads` | 将转换后的 GIF 保存到本地 |
| `declarativeNetRequest` | 注入 `Referer` 头，绕过防盗链 |
| `declarativeNetRequestWithHostAccess` | 让 DNR 规则对目标主机生效 |

**Host 权限**

- `*://*.douyin.com/*` —— 注入内容脚本
- `*://*.byteimg.com/*` —— 拦截并放行面板表情图片
- `*://*.douyinpic.com/*` —— 拦截并放行对话表情图片

---

## 常见问题

**Q：为什么开关默认是关闭的？**

A：避免在不需要时产生额外的网络监听与存储开销。打开弹窗手动开启即可。

**Q：关闭开关后已捕获的记录会怎样？**

A：关闭某通道时会自动清空该通道的捕获记录（内存 + 存储），另一个通道不受影响。

**Q：捕获数量有上限吗？**

A：最多保留 1000 条（两通道共用），超出后自动移除最早的记录。

**Q：下载的文件保存在哪里？**

A：收藏表情包 → `douyin-emoticons/`，对话表情包 → `douyin-chat/`，
位于浏览器默认下载路径下；「下载所选」时每批另建一个以时间命名的子目录。格式规则见[下载产物规则](#下载产物规则)。

**Q：下载的图为什么不是原始 WebP？**

A：为了能直接作为微信表情使用。扩展统一输出 GIF，并保证动画与透明通道不丢失。

**Q：我点了下载但没看到文件？**

A：按下面的排查顺序看：

1. **扩展图标是否出现数字角标** —— 有角标说明后台正在处理，等待即可
2. **角标是否显示 `!`** —— 表示全部失败，打开弹窗会看到具体原因
3. **打开弹窗看提示** —— 成功与失败数、首个错误原因都会显示
4. **确认保存位置** —— 进入下载目录，检查 `douyin-emoticons/` 与 `douyin-chat/` 子目录
5. **是否忘了刷新扩展** —— 改过代码或 `manifest.json` 后必须到 `chrome://extensions/` 点刷新

**Q：预览区图片显示警告图标？**

A：多半是 `declarativeNetRequest` 规则未生效，刷新抖音页面后重试；
若仍失败，确认扩展在管理页中没有报错。

**Q：单张图片下载失败，提示 HTTP 403 或 5xx？**

A：抖音图片 URL 带有效期签名，过期后会返回 403。
扩展已对这类失败自动重试一次，仍失败则说明链接已失效，重新捕获即可。

---

## 已知限制

- 图片 URL 携带有效期签名，**捕获后放置过久会失效**，建议及时下载。
- 大批量任务会短暂出现一个后台标签页（默认不抢焦点，跑完自动关闭）。
- 极长任务（超过约 5 分钟）理论上可能被 Chrome 冻结隐藏标签页；
  实测数百张规模未触发，若遇到可反馈。
- 仅适配抖音**网页版**（`www.douyin.com`），移动端与客户端不适用。

## 开发

无构建步骤，纯原生 JavaScript + ESM，改完直接在 `chrome://extensions/` 刷新即可。

新增第三方前端库请放入 `lib/`，使用 ESM 格式，页面以 `<script type="module">` 引入。

## 许可证

[MIT License](LICENSE)
