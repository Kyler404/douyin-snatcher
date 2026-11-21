// popup.js — 弹窗交互逻辑（双分区：收藏表情包 / 对话表情包）

const STORAGE_KEY = "snatched_urls";
const LAST_EXPORT_KEY = "last_export_time";
const PANEL_KEY = "panel_enabled"; // 收藏（面板）表情开关，默认关
const CHAT_KEY = "chat_enabled";   // 对话表情开关，默认关
const STATUS_KEY = "convert_status"; // 后台转换进度（后台工作页写入）
const ACK_KEY = "convert_ack";       // 已提示过的转换结果时间戳

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
const btnSelectPanel = document.getElementById("btnSelectPanel");
const btnSelectChat = document.getElementById("btnSelectChat");
const urlList = document.getElementById("urlList");
const toast = document.getElementById("toast");

// ── 分区状态：当前条目 + 多选集合 ──
// 选中项按 URL 记，网格因新抓到图而重渲染时勾选不会丢；
// anchor 是上一次点选的位置，Shift+点击时从它连选到当前。
const zones = {
  panel: {
    grid: prevGridPanel,
    btn: btnDownloadPanel,
    label: btnPanelLabel,
    selBtn: btnSelectPanel,
    dir: "douyin-emoticons",
    items: [],
    selected: new Set(),
    anchor: -1,
  },
  chat: {
    grid: prevGridChat,
    btn: btnDownloadChat,
    label: btnChatLabel,
    selBtn: btnSelectChat,
    dir: "douyin-chat",
    items: [],
    selected: new Set(),
    anchor: -1,
  },
};
let lastStatus = null; // 最近一次读到的后台转换进度

// 预览网格的渲染签名（避免每 2s 重渲染打断悬停/下载）
let lastPanelSig = "";
let lastChatSig = "";
let lastAck = 0; // 已经提示过的转换结果，避免每次刷新重复弹

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

// ── 加载数据并渲染 ──
async function refresh() {
  const result = await chrome.storage.local.get([
    STORAGE_KEY,
    LAST_EXPORT_KEY,
    PANEL_KEY,
    CHAT_KEY,
    STATUS_KEY,
    ACK_KEY,
  ]);
  const urls = result[STORAGE_KEY] || [];
  const lastExport = result[LAST_EXPORT_KEY] || 0;

  // 后台转换进度（后台工作页写入，弹窗负责展示结果）
  const st = result[STATUS_KEY] || null;
  lastAck = result[ACK_KEY] || 0;
  const busy = !!(st && st.running);

  // 开关状态（默认关闭：显式 true 才开启）
  const panelEnabled = result[PANEL_KEY] === true;
  const chatEnabled = result[CHAT_KEY] === true;

  // 按来源分类：面板 = network/dom，对话 = chat
  const panelUrls = urls.filter((u) => u.source !== "chat");
  const chatUrls = urls.filter((u) => u.source === "chat");

  // 分区计数
  badgePanel.textContent = panelUrls.length;
  badgeChat.textContent = chatUrls.length;

  // 同步分区条目，剔除已不存在的勾选（例如关开关清空了记录）
  lastStatus = st;
  setZoneItems(zones.panel, panelUrls);
  setZoneItems(zones.chat, chatUrls);

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
    renderGrid(zones.panel);
  }
  const chatSig = chatUrls.length + "|" + (chatUrls[chatUrls.length - 1]?.url || "");
  if (chatSig !== lastChatSig) {
    lastChatSig = chatSig;
    renderGrid(zones.chat);
  }

  updateZoneControls(zones.panel);
  updateZoneControls(zones.chat);

  reportConvert(st, busy);
  return { urls, lastExport, panelUrls, chatUrls };
}

// ── 后台转换结果反馈 ──
// 转换在后台工作页里跑，弹窗关掉也不中断，所以结果只能回来再看：
// 进行中 → 按钮显示进度；刚结束 → toast 报成功/失败数；失败时清角标并提示原因。
function reportConvert(st, busy) {
  if (!st) return;
  if (busy) return;

  const clearBadge = () => {
    try {
      chrome.action.setBadgeText({ text: "" });
    } catch {}
  };

  if (st.fatal && st.finishedAt > lastAck) {
    showToast("转换失败：" + st.fatal);
    clearBadge();
    lastAck = st.finishedAt;
    chrome.storage.local.set({ [ACK_KEY]: lastAck });
    return;
  }

  if (st.finishedAt && st.finishedAt > lastAck) {
    const ok = Math.max(0, (st.total || 0) - (st.failed || 0));
    if (st.failed > 0) {
      const first = (st.errors && st.errors[0] && st.errors[0].error) || "未知错误";
      showToast(`成功 ${ok} 张，失败 ${st.failed} 张：${first}`);
    } else if (st.total) {
      showToast(`已下载 ${ok} 张 GIF → ${st.dir}/`);
    }
    clearBadge();
    lastAck = st.finishedAt;
    chrome.storage.local.set({ [ACK_KEY]: lastAck });
  }
}

// ── 渲染预览网格（图片加载依赖 DNR 注入的 Referer 绕过 403）──
// 左上角勾选框：点一下选/取消，Shift+点击连选；点图本身仍是新标签放大。
function renderGrid(zone) {
  const container = zone.grid;
  container.innerHTML = "";
  zone.items.forEach((item, i) => {
    const cell = document.createElement("div");
    cell.className = "thumb";
    cell.classList.toggle("selected", zone.selected.has(item.url));

    const img = document.createElement("img");
    img.src = realUrl(item.url); // 真实 & 分隔的 URL
    img.loading = "lazy";
    img.addEventListener("error", () => cell.classList.add("broken"));

    // 勾选框
    const pick = document.createElement("div");
    pick.className = "pick";
    pick.title = "选择（Shift+点击可连选）";
    pick.setAttribute("role", "checkbox");
    pick.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePick(zone, i, e.shiftKey);
    });

    // 下载按钮（悬停显示）
    const dl = document.createElement("div");
    dl.className = "dl";
    dl.title = "下载这张（自动转 GIF）";
    dl.textContent = "⬇";
    dl.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadOne(item.url, i, zone.dir);
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
    cell.appendChild(pick);
    cell.appendChild(dl);
    cell.appendChild(fail);
    container.appendChild(cell);
  });
  syncPickState(zone);
}

// ── 多选 ──
function setZoneItems(zone, items) {
  zone.items = items;
  const alive = new Set(items.map((u) => u.url));
  for (const url of zone.selected) if (!alive.has(url)) zone.selected.delete(url);
  if (zone.anchor >= items.length) zone.anchor = -1;
}

function togglePick(zone, i, range) {
  const url = zone.items[i]?.url;
  if (!url) return;
  const on = !zone.selected.has(url);
  if (range && zone.anchor >= 0 && zone.anchor < zone.items.length) {
    // Shift 连选：从上次点选的位置到这里，统一设成这次点击后的状态
    const [a, b] = zone.anchor < i ? [zone.anchor, i] : [i, zone.anchor];
    for (let k = a; k <= b; k++) {
      const u = zone.items[k].url;
      if (on) zone.selected.add(u);
      else zone.selected.delete(u);
    }
  } else if (on) {
    zone.selected.add(url);
  } else {
    zone.selected.delete(url);
  }
  zone.anchor = i;
  syncPickState(zone);
  updateZoneControls(zone);
}

function toggleSelectAll(zone) {
  const all = zone.items.length > 0 && zone.selected.size === zone.items.length;
  zone.selected.clear();
  if (!all) zone.items.forEach((u) => zone.selected.add(u.url));
  zone.anchor = -1;
  syncPickState(zone);
  updateZoneControls(zone);
}

// 只改勾选样式，不重建 DOM（避免图片重新加载闪烁）
function syncPickState(zone) {
  const cells = zone.grid.children;
  for (let i = 0; i < cells.length; i++) {
    const on = !!zone.items[i] && zone.selected.has(zone.items[i].url);
    cells[i].classList.toggle("selected", on);
    const pick = cells[i].querySelector(".pick");
    if (pick) pick.setAttribute("aria-checked", String(on));
  }
}

// 按钮文案与可用状态：后台转换中显示进度；否则显示已选数量
function updateZoneControls(zone) {
  const st = lastStatus;
  const busy = !!(st && st.running);
  const n = zone.items.length;
  const k = zone.selected.size;
  if (busy) {
    zone.label.textContent = `处理中 ${st.done}/${st.total}`;
  } else {
    zone.label.textContent = k ? `下载所选 · GIF (${k})` : "下载所选 · GIF";
  }
  zone.btn.disabled = busy || k === 0;
  zone.selBtn.textContent = n > 0 && k === n ? "取消全选" : "全选";
  zone.selBtn.disabled = n === 0;
}

// ── 交给后台工作页转换并下载 ──
// 转码要取图、解码、编码 GIF，耗时不短；放后台标签页跑，弹窗关掉也不中断。
function requestConvert(items, dir) {
  chrome.runtime.sendMessage({ type: "convert_and_download", items, dir }).catch(() => {});
}

// ── 单张下载（DNR 自动带上 Referer，绕过防盗链）──
function downloadOne(url, index, dir) {
  requestConvert([{ url: realUrl(url), index }], dir);
  showToast("已开始处理，完成后自动下载");
}

// ── 本地时间戳，作批次子目录名：2026-11-21_121500 ──
function batchStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// ── 下载所选 ──
// 每批单独建一个带时间的子目录，避免多次下载混在一起、序号文件名互相冲突。
// 文件名序号沿用预览网格里的位置，方便对照。
function downloadSelected(zone) {
  const picked = [];
  zone.items.forEach((u, i) => {
    if (zone.selected.has(u.url)) picked.push({ url: realUrl(u.url), index: i });
  });
  if (picked.length === 0) {
    showToast("请先勾选要下载的表情，或点「全选」");
    return;
  }
  const batchDir = `${zone.dir}/${batchStamp()}`;
  requestConvert(picked, batchDir);
  // 已提交的勾选清掉，免得下次误把同一批再下一遍
  zone.selected.clear();
  zone.anchor = -1;
  syncPickState(zone);
  updateZoneControls(zone);
  showToast(`已开始处理 ${picked.length} 张，可关闭弹窗，完成后自动下载到 ${batchDir}/`);
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

  // 分区：下载所选 / 全选
  btnDownloadPanel.addEventListener("click", async () => {
    await refresh(); // 先同步最新条目，剔除已失效的勾选
    downloadSelected(zones.panel);
  });
  btnDownloadChat.addEventListener("click", async () => {
    await refresh();
    downloadSelected(zones.chat);
  });
  btnSelectPanel.addEventListener("click", () => toggleSelectAll(zones.panel));
  btnSelectChat.addEventListener("click", () => toggleSelectAll(zones.chat));

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
