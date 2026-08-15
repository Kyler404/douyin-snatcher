// background.js — 网络请求拦截 & 资源嗅探
// 运行在 Service Worker 中，无 DOM 访问权限

const STORAGE_KEY = "snatched_urls";
const PANEL_KEY = "panel_enabled"; // 面板（收藏）表情开关
const MAX_URLS = 1000; // 面板表情 + 对话表情共用容量
const KEYWORD = "emoticon"; // 面板表情关键词

// 缓存开关状态（网络层只负责面板表情；对话表情由 content.js 的 DOM 通道处理）
// 默认关闭：只有显式设置为 true 才开启
let PANEL_ENABLED = false;
chrome.storage.local.get([PANEL_KEY], (r) => {
  PANEL_ENABLED = r[PANEL_KEY] === true;
});

// ── 去重核心：按「对象 key」去重 ──
// 抖音同一张图每次打开可能：
//   1) 从不同 CDN 子域名下发 (p3- / p26-im-emoticon-sign)
//   2) 重新生成 x-signature / x-expires 签名参数
//   3) 使用不同 resize:W:H 尺寸
// 这些只是「同一张图」的不同呈现，必须合并，否则会产生“重复”。
// 真正的身份是 URL 路径里的「对象 key」：host/bucket/OBJKEY~tplv... 中 ~ 之前那段。
// 因此去重键只取对象 key，忽略主机名、签名、resize 等所有可变部分，
// 并始终保存最新（签名最新的）完整 URL。
const keyOf = (url) => {
  const path = url.replace(/&amp;/g, "&").split("?")[0];
  const m = path.match(/\/[^/]+\/([^~?]+)/); // host/bucket/OBJKEY~...
  return m ? m[1] : path;
};

let keyOrder = [];               // 已捕获的去重键，按出现/文档顺序
const itemByKey = new Map();     // key -> { url, time, source }
let writeChain = Promise.resolve();

// 落盘：把内部 Map 还原成 popup 期望的数组格式 [{url,time,source}]
function persist() {
  return new Promise((resolve) => {
    const arr = keyOrder.map((k) => itemByKey.get(k));
    chrome.storage.local.set({ [STORAGE_KEY]: arr }, resolve);
  });
}

// 初始化屏障：先从 storage 恢复，再处理任何捕获消息。
// Service Worker 重启后内存清空，若先收到捕获会把已存记录覆盖/丢失。
const ready = new Promise((resolve) => {
  chrome.storage.local.get([STORAGE_KEY], (r) => {
    (r[STORAGE_KEY] || []).forEach((it) => {
      const k = keyOf(it.url);
      if (!itemByKey.has(k)) keyOrder.push(k);
      itemByKey.set(k, it);
    });
    resolve();
  });
});

// ── URL 匹配规则 ──
const URL_PATTERNS = [
  // 表情贴图（最常见的）
  "*://*.byteimg.com/tos-cn-o-0812/*",
  "*://*.byteimg.com/tos-cn-i-3jr8j4ixpe/*",
  "*://*.byteimg.com/douyin-user-image-file/*",
  "*://*.byteimg.com/ies.fe.effect/*",
  // 通配：byteimg 所有资源
  "*://*.byteimg.com/*",
];

// 开关变化时实时更新（网络层只关心面板开关）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[PANEL_KEY]) {
    PANEL_ENABLED = changes[PANEL_KEY].newValue === true;
  }
});

// ── 监听网络请求 ──
chrome.webRequest.onCompleted.addListener(
  function (details) {
    // 开关关闭则跳过
    if (!PANEL_ENABLED) return;

    // 只收集图片/媒体类型
    const resType = details.type;
    if (!["image", "media", "xmlhttprequest"].includes(resType)) return;

    const url = details.url;
    // 过滤掉太短的 URL（可能是信标）
    if (url.length < 60) return;

    // 关键词过滤：只抓 emoticon
    if (KEYWORD && !url.includes(KEYWORD)) return;

    // 还原为 HTML 源码中的 &amp; 形式（与用户要求一致），下载时再转回 &
    const rawUrl = url.replace(/&/g, "&amp;");
    storeURL(rawUrl);
  },
  { urls: URL_PATTERNS }
);

// ── 存储单条 URL（按图片路径去重 + 记录时间）──
function storeURL(url, source = "network") {
  const k = keyOf(url);
  writeChain = writeChain.then(() => ready).then(
    () =>
      new Promise((resolve) => {
        if (itemByKey.has(k)) {
          // 已存在（同一张图）：刷新为最新完整 URL（签名最新的），位置不变
          const it = itemByKey.get(k);
          it.url = url;
          it.time = Date.now();
          persist().then(resolve);
        } else {
          keyOrder.push(k);
          itemByKey.set(k, { url, time: Date.now(), source });
          // 上限保护
          if (keyOrder.length > MAX_URLS) keyOrder.shift();
          persist().then(resolve);
        }
      })
  );
}

// ── 按 DOM 文档顺序重排（让预览顺序 = 网页源码顺序）──
// 同时按图片路径去重：同图不同签名 → 合并，保存最新 URL
// items: [{ url, source }]，source 由 content script 提供（dom=面板 / chat=对话），
// 避免对话表情被误标为 dom 而混入「收藏表情包」分区。
function storeOrdered(items) {
  writeChain = writeChain.then(() => ready).then(
    () =>
      new Promise((resolve) => {
        const newOrder = [];
        const placed = new Set();

        items.forEach((item) => {
          const u = typeof item === "string" ? item : item.url; // 兼容旧格式
          const src = typeof item === "string" ? "dom" : item.source || "dom";
          const k = keyOf(u);
          if (itemByKey.has(k)) {
            itemByKey.get(k).url = u; // 刷新为最新 URL
          } else {
            itemByKey.set(k, { url: u, time: Date.now(), source: src });
          }
          if (!placed.has(k)) {
            newOrder.push(k);
            placed.add(k);
          }
        });

        // 快照之外的已有键（仅网络层抓到、不在面板 DOM 里的）保持原有相对顺序排最后
        keyOrder.forEach((k) => {
          if (!placed.has(k)) newOrder.push(k);
        });
        keyOrder = newOrder;
        if (keyOrder.length > MAX_URLS) keyOrder.splice(0, keyOrder.length - MAX_URLS);

        persist().then(resolve);
      })
  );
}

// ── 按来源清空（开关从开→关时调用）：source="panel" 清收藏，source="chat" 清对话 ──
function clearBySource(source, respond) {
  writeChain = writeChain.then(() => ready).then(
    () =>
      new Promise((resolve) => {
        const keep = (it) => (source === "chat" ? it.source !== "chat" : it.source === "chat");
        // 先计算保留/删除集合，再删除，避免 filter 时已删 key 的 get(k) 返回 undefined
        const keptKeys = keyOrder.filter((k) => keep(itemByKey.get(k)));
        const removedKeys = keyOrder.filter((k) => !keep(itemByKey.get(k)));
        removedKeys.forEach((k) => itemByKey.delete(k));
        keyOrder = keptKeys;
        persist().then(() => {
          if (respond) respond({ ok: true, removed: removedKeys.length });
          resolve();
        });
      })
  );
}

// ── 监听来自 content script 的消息 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "store_url") {
    storeURL(msg.url, msg.source || "dom");
    sendResponse({ ok: true });
  } else if (msg.type === "store_ordered") {
    storeOrdered(msg.items || msg.urls || []);
    sendResponse({ ok: true });
  } else if (msg.type === "clear_source") {
    clearBySource(msg.source, sendResponse);
    return true; // 异步 sendResponse（等 persist 完成），popup 需 await
  } else if (msg.type === "clear_all") {
    keyOrder = [];
    itemByKey.clear();
    sendResponse({ ok: true });
  }
  return true; // 保持消息通道开放
});

console.log("🎯 抖音表情嗅探器已启动 — 等待抓取...");
