// content.js — DOM 监听，扫描页面中已渲染的资源
// 运行在 douyin.com 页面上下文中

(function () {
  "use strict";

  const SEEN = new Set();
  const KEYWORD = "emoticon"; // 面板表情关键词

  // 两个独立开关：面板（收藏）表情 / 对话表情（默认都关闭，显式开启才抓）
  let PANEL_ENABLED = false;
  let CHAT_ENABLED = false;
  chrome.storage.local.get(["panel_enabled", "chat_enabled"], (r) => {
    PANEL_ENABLED = r.panel_enabled === true;
    CHAT_ENABLED = r.chat_enabled === true;
  });

  // 安全发送消息：扩展被重新加载/更新后，旧 content script 的上下文会失效，
  // 此时 chrome.runtime.sendMessage() 会【同步抛出】"Extension context invalidated"，
  // 单纯的 .catch() 接不住同步异常，必须用 try/catch 包裹。
  let observer = null; // 提前声明，失效时断开监听
  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      // 上下文已失效（扩展重载/卸载）：断开 DOM 监听，停止旧实例空转
      if (observer) observer.disconnect();
    }
  }

  // ── 提取 img/src 并上报 ──
  function scanElement(el) {
    // <img> 的 src（currentSrc 优先，兼容响应式/懒加载填充后的地址）
    if (el.tagName === "IMG") {
      const src = el.currentSrc || el.src;
      if (src) collect(src, el);
    }
    // <video>/<source> 的 src
    if ((el.tagName === "VIDEO" || el.tagName === "SOURCE") && el.src) {
      collect(el.src, el);
    }
    // 任意元素的 style.backgroundImage
    if (el.style && el.style.backgroundImage) {
      const m = el.style.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) collect(m[1], el);
    }
  }

  // 判断元素是否位于「对话表情包」容器内
  function isChatEmoji(el) {
    return !!(el && el.closest && el.closest(".MessageItemEmojiemojiBox"));
  }

  function collect(url, el) {
    let source;
    if (isChatEmoji(el)) {
      // 对话表情包：受 CHAT_ENABLED 控制，只收 douyinpic 表情资源
      if (!CHAT_ENABLED) return;
      if (!url.startsWith("http")) return;
      if (!url.includes("douyinpic.com")) return;
      source = "chat";
    } else {
      // 面板（收藏）表情：受 PANEL_ENABLED 控制，原有 byteimg + emoticon 规则
      if (!PANEL_ENABLED) return;
      if (!url.startsWith("http")) return;
      if (!url.includes("byteimg.com")) return;
      if (KEYWORD && !url.includes(KEYWORD)) return;
      source = "dom";
    }
    if (SEEN.has(url)) return;
    SEEN.add(url);

    // 还原为 HTML 源码中的 &amp; 形式（与用户要求一致），下载时再转回 &
    const rawUrl = url.replace(/&/g, "&amp;");
    safeSend({ type: "store_url", url: rawUrl, source });
    console.debug(`🖼️ DOM 捕获[${source}]:`, rawUrl.slice(0, 80) + "...");
  }

  // ── 按 DOM 顺序发送整面板快照（保证预览顺序 = 网页源码顺序）──
  let snapshotTimer = null;
  function sendOrderedSnapshot() {
    const items = [];

    // 1) 面板（收藏）表情（byteimg + emoticon），querySelectorAll 返回文档顺序
    if (PANEL_ENABLED) {
      document.querySelectorAll('img[src*="byteimg"]').forEach((img) => {
        const u = img.currentSrc || img.src || "";
        if (!u.includes(KEYWORD)) return; // 关键词过滤
        const raw = u.replace(/&/g, "&amp;");
        if (!items.some((x) => x.url === raw)) items.push({ url: raw, source: "dom" });
      });
    }

    // 2) 对话表情包（emojiBox 容器内的 img），文档顺序
    if (CHAT_ENABLED) {
      document.querySelectorAll(".MessageItemEmojiemojiBox img").forEach((img) => {
        const u = img.currentSrc || img.src || "";
        if (!u.startsWith("http") || !u.includes("douyinpic.com")) return;
        const raw = u.replace(/&/g, "&amp;");
        if (!items.some((x) => x.url === raw)) items.push({ url: raw, source: "chat" });
      });
    }

    if (items.length) {
      safeSend({ type: "store_ordered", items });
    }
  }
  function scheduleSnapshot() {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(sendOrderedSnapshot, 400);
  }

  // ── 初始扫描 ──
  document.querySelectorAll("img, video, source").forEach(scanElement);
  // 也扫描 inline style
  document.querySelectorAll("[style]").forEach(scanElement);
  scheduleSnapshot(); // 初始即按 DOM 顺序排好

  // ── MutationObserver: 实时监听新增节点 ──
  observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      // 新增节点
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue; // 只处理元素节点
        if (node.tagName === "IMG" || node.tagName === "VIDEO" || node.tagName === "SOURCE") {
          scanElement(node);
        }
        // 扫描新增节点的子节点
        if (node.querySelectorAll) {
          node.querySelectorAll("img, video, source, [style]").forEach(scanElement);
        }
      }
      // 属性变化（如 lazy-load 的 src 被填充）
      if (mut.type === "attributes" && mut.attributeName === "src") {
        scanElement(mut.target);
      }
    }
    scheduleSnapshot(); // 每次变动后，重新按文档顺序排好预览
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "style"],
  });

  // ── 响应弹窗开关切换（panel: 面板表情, chat: 对话表情）──
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "set_enabled") {
      if (typeof msg.panel === "boolean") PANEL_ENABLED = msg.panel;
      if (typeof msg.chat === "boolean") CHAT_ENABLED = msg.chat;
      console.log(
        `🔘 抓取开关: 面板=${PANEL_ENABLED ? "开" : "关"} 对话=${CHAT_ENABLED ? "开" : "关"}`
      );
    }
  });

  console.log("👁️ DOM 嗅探器已激活 (MutationObserver)");
})();
