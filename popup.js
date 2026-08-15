// popup.js — 弹窗交互逻辑（双分区：收藏表情包 / 对话表情包）

const STORAGE_KEY = "snatched_urls";
const LAST_EXPORT_KEY = "last_export_time";
const PANEL_KEY = "panel_enabled"; // 收藏（面板）表情开关，默认关
const CHAT_KEY = "chat_enabled";   // 对话表情开关，默认关

// ── 元素引用 ──
const pageStatus = document.getElementById("pageStatus");
const togglePanel = document.getElementById("togglePanel");
const toggleChat = document.getElementById("toggleChat");
const badgePanel = document.getElementById("badgePanel");
const badgeChat = document.getElementById("badgeChat");
const prevGridPanel = document.getElementById("prevGridPanel");
const prevGridChat = document.getElementById("prevGridChat");
const emptyPanel = document.getElementById("emptyPanel");
const emptyChat = document.getElementById("emptyChat");
const btnPanelLabel = document.getElementById("btnPanelLabel");
const btnChatLabel = document.getElementById("btnChatLabel");
const btnDownloadPanel = document.getElementById("btnDownloadPanel");
const btnDownloadChat = document.getElementById("btnDownloadChat");
const urlList = document.getElementById("urlList");
const toast = document.getElementById("toast");

// 预览网格的渲染签名（避免每 2s 重渲染打断悬停/下载）
let lastPanelSig = "";
let lastChatSig = "";

// ── 轻量 toast 提示（替代原生 alert）──
let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

// 把存储里的 &amp; 还原成真实请求用的 &
function realUrl(url) {
  return url.replace(/&amp;/g, "&");
}

// 从 URL 生成合法文件名（去掉 Windows 不允许的 : 和 ~），dir 为下载子目录
function cleanFilename(url, index, dir) {
  const path = url.split("?")[0].split("/").pop();
  let hash = path.split("~")[0] || path;
  hash = hash.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "emoji";
  const ext = /\.awebp/i.test(path) ? "awebp" : /\.webp/i.test(path) ? "webp" : "img";
  return `${dir}/${String(index).padStart(3, "0")}_${hash}.${ext}`;
}

// ── 加载数据并渲染 ──
async function refresh() {
  const result = await chrome.storage.local.get([
    STORAGE_KEY,
    LAST_EXPORT_KEY,
    PANEL_KEY,
    CHAT_KEY,
  ]);
  const urls = result[STORAGE_KEY] || [];
  const lastExport = result[LAST_EXPORT_KEY] || 0;

  // 开关状态（默认关闭：显式 true 才开启）
  const panelEnabled = result[PANEL_KEY] === true;
  const chatEnabled = result[CHAT_KEY] === true;

  // 按来源分类：面板 = network/dom，对话 = chat
  const panelUrls = urls.filter((u) => u.source !== "chat");
  const chatUrls = urls.filter((u) => u.source === "chat");

  // 分区计数
  badgePanel.textContent = panelUrls.length;
  badgeChat.textContent = chatUrls.length;

  // 下载按钮标签带数量
  btnPanelLabel.textContent = panelUrls.length ? `下载全部 (${panelUrls.length})` : "下载全部";
  btnChatLabel.textContent = chatUrls.length ? `下载全部 (${chatUrls.length})` : "下载全部";
  btnDownloadPanel.disabled = panelUrls.length === 0;
  btnDownloadChat.disabled = chatUrls.length === 0;

  // 开关状态同步到 UI
  togglePanel.checked = panelEnabled;
  toggleChat.checked = chatEnabled;

  // 页面状态（胶囊 + 状态色点）
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!panelEnabled && !chatEnabled) {
    pageStatus.textContent = "抓取已全部关闭";
    pageStatus.dataset.state = "off";
  } else if (tab && tab.url && tab.url.includes("douyin.com")) {
    pageStatus.textContent = "正在监听";
    pageStatus.dataset.state = "on";
  } else {
    pageStatus.textContent = "等待打开抖音";
    pageStatus.dataset.state = "wait";
  }

  // 分区空态
  emptyPanel.classList.toggle("show", panelUrls.length === 0);
  emptyChat.classList.toggle("show", chatUrls.length === 0);

  // 分区预览（仅在内容变化时重渲染）
  const panelSig = panelUrls.length + "|" + (panelUrls[panelUrls.length - 1]?.url || "");
  if (panelSig !== lastPanelSig) {
    lastPanelSig = panelSig;
    renderGrid(prevGridPanel, panelUrls);
  }
  const chatSig = chatUrls.length + "|" + (chatUrls[chatUrls.length - 1]?.url || "");
  if (chatSig !== lastChatSig) {
    lastChatSig = chatSig;
    renderGrid(prevGridChat, chatUrls);
  }

  return { urls, lastExport, panelUrls, chatUrls };
}

// ── 渲染预览网格（图片加载依赖 DNR 注入的 Referer 绕过 403）──
function renderGrid(container, items) {
  container.innerHTML = "";
  items.forEach((item, i) => {
    const idx = i + 1;
    const cell = document.createElement("div");
    cell.className = "thumb";

    const img = document.createElement("img");
    img.src = realUrl(item.url); // 真实 & 分隔的 URL
    img.loading = "lazy";
    img.addEventListener("error", () => cell.classList.add("broken"));

    // 下载按钮（悬停显示）
    const dl = document.createElement("div");
    dl.className = "dl";
    dl.title = "下载这张";
    dl.textContent = "⬇";
    dl.addEventListener("click", (e) => {
      e.stopPropagation();
      const dir = item.source === "chat" ? "douyin-chat" : "douyin-emoticons";
      downloadOne(item.url, idx, dir);
    });

    // 点击放大（新标签打开）
    cell.addEventListener("click", () => {
      chrome.tabs.create({ url: realUrl(item.url) });
    });

    // 加载失败占位
    const fail = document.createElement("div");
    fail.className = "fail";
    fail.textContent = "⚠️";

    cell.appendChild(img);
    cell.appendChild(dl);
    cell.appendChild(fail);
    container.appendChild(cell);
  });
}

// ── 单张下载（DNR 自动带上 Referer，绕过防盗链）──
async function downloadOne(url, index, dir) {
  const rurl = realUrl(url);
  const filename = cleanFilename(rurl, index, dir);
  await chrome.downloads.download({ url: rurl, filename, saveAs: false });
}

// ── 分区批量下载 ──
async function downloadAll(items, dir, label) {
  if (items.length === 0) {
    showToast("该分区暂无捕获的资源");
    return;
  }
  showToast(`正在下载 ${items.length} 张...`);
  for (let i = 0; i < items.length; i++) {
    try {
      await downloadOne(items[i].url, i + 1, dir);
    } catch (e) {
      console.warn("下载失败:", items[i].url, e);
    }
  }
  showToast(`已发起 ${items.length} 个下载，保存至 ${dir}/`);
}

// ── 开关切换（panel / chat 独立）──
// 从开→关时清空该模式的捕捉记录；从关→开只开启抓取，保留已有记录
async function setCapture(key, enabled) {
  await chrome.storage.local.set({ [key]: enabled });

  // 从开启→关闭：清空该模式的捕捉记录（内存 + storage 同步）
  if (!enabled) {
    const src = key === PANEL_KEY ? "panel" : "chat";
    try {
      await chrome.runtime.sendMessage({ type: "clear_source", source: src });
    } catch (e) {
      /* background 未就绪时忽略 */
    }
    // 强制重渲染（清空后数量为 0，但保险起见重置签名）
    if (src === "panel") lastPanelSig = "";
    else lastChatSig = "";
  }

  // 通知当前页面的 content script 立即生效（携带两个开关最新值）
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    chrome.tabs
      .sendMessage(tab.id, {
        type: "set_enabled",
        panel: togglePanel.checked,
        chat: toggleChat.checked,
      })
      .catch(() => {});
  }
  await refresh();
}

// ── 查看列表 ──
async function showList(urls) {
  if (urls.length === 0) {
    urlList.classList.remove("show");
    return;
  }

  urlList.innerHTML = urls
    .slice(-30) // 只显示最近 30 条
    .reverse()
    .map(
      (item, i) => `
    <div class="url-item">
      <span class="idx">${urls.length - i}</span>
      <span class="src-tag ${item.source}">${item.source}</span>
      ${escapeHTML(item.url.slice(0, 100))}${item.url.length > 100 ? "..." : ""}
    </div>`
    )
    .join("");

  urlList.classList.add("show");
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── 导出为文件并下载 ──
async function exportAndDownload(urls) {
  if (urls.length === 0) {
    showToast("暂无捕获的资源链接，请先打开抖音网页版");
    return;
  }

  // 生成 JSON 文件（供 Python 脚本使用）
  const exportData = {
    export_time: new Date().toISOString(),
    total: urls.length,
    urls: urls.map((u) => u.url),
  };

  const jsonStr = JSON.stringify(exportData, null, 2);

  // 方案 A：通过 Blob URL 下载（适用于扩展弹窗）
  const blob = new Blob([jsonStr], { type: "application/json" });
  const blobUrl = URL.createObjectURL(blob);

  // 生成纯文本 URL 列表（每行一个）
  const txtContent = urls.map((u) => u.url).join("\n");
  const txtBlob = new Blob([txtContent], { type: "text/plain" });
  const txtUrl = URL.createObjectURL(txtBlob);

  // 下载 JSON
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await chrome.downloads.download({
    url: blobUrl,
    filename: `douyin-resources-${timestamp}.json`,
    saveAs: true,
  });

  // 同时下载 TXT
  setTimeout(async () => {
    await chrome.downloads.download({
      url: txtUrl,
      filename: `douyin-resources-${timestamp}.txt`,
      saveAs: true,
    });
  }, 500);

  // 记录导出时间
  await chrome.storage.local.set({ [LAST_EXPORT_KEY]: Date.now() });

  // 清理
  setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
    URL.revokeObjectURL(txtUrl);
  }, 2000);
}

// ── 复制到剪贴板 ──
async function copyToClipboard(urls, onlyNew = false) {
  if (urls.length === 0) {
    showToast("暂无捕获的资源链接");
    return;
  }

  let targetUrls = urls;
  if (onlyNew) {
    const result = await chrome.storage.local.get([LAST_EXPORT_KEY]);
    const lastExport = result[LAST_EXPORT_KEY] || 0;
    targetUrls = urls.filter((u) => u.time > lastExport);
    if (targetUrls.length === 0) {
      showToast("没有新捕获的链接");
      return;
    }
  }

  const text = targetUrls.map((u) => u.url).join("\n");
  await navigator.clipboard.writeText(text);

  const label = onlyNew ? "新链接" : "全部链接";
  showToast(`已复制 ${targetUrls.length} 条${label}到剪贴板`);
}

// ── 清空 ──
async function clearAll() {
  if (!confirm("确定清空所有捕获记录？此操作不可撤销。")) return;
  await chrome.storage.local.remove([STORAGE_KEY, LAST_EXPORT_KEY]);
  // 同时重置 background 的内存去重集合
  chrome.runtime.sendMessage({ type: "clear_all" }).catch(() => {});
  urlList.classList.remove("show");
  lastPanelSig = "";
  lastChatSig = "";
  await refresh();
}

// ── 按钮绑定 ──
document.addEventListener("DOMContentLoaded", async () => {
  const { urls } = await refresh();
  showList(urls);

  // 两个独立开关
  togglePanel.addEventListener("change", (e) => setCapture(PANEL_KEY, e.target.checked));
  toggleChat.addEventListener("change", (e) => setCapture(CHAT_KEY, e.target.checked));

  // 分区下载
  btnDownloadPanel.addEventListener("click", async () => {
    const { panelUrls } = await refresh();
    await downloadAll(panelUrls, "douyin-emoticons", "收藏表情包");
  });
  btnDownloadChat.addEventListener("click", async () => {
    const { chatUrls } = await refresh();
    await downloadAll(chatUrls, "douyin-chat", "对话表情包");
  });

  document.getElementById("btnExport").addEventListener("click", async () => {
    const { urls } = await refresh();
    await exportAndDownload(urls);
  });

  document.getElementById("btnCopy").addEventListener("click", async () => {
    const { urls } = await refresh();
    await copyToClipboard(urls, false);
  });

  document.getElementById("btnCopyNew").addEventListener("click", async () => {
    const { urls } = await refresh();
    await copyToClipboard(urls, true);
  });

  document.getElementById("btnView").addEventListener("click", async () => {
    const { urls } = await refresh();
    showList(urls);
  });

  document.getElementById("btnClearIcon").addEventListener("click", clearAll);
});

// 定期刷新（弹窗打开时）
setInterval(refresh, 2000);
