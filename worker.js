// worker.js — 后台转换工作页（由 background 以后台标签页形式打开）
//
// 转换要逐张 fetch → 解码 → 编码 GIF → 落盘，耗时从几百毫秒到几十秒不等。
// 弹窗一点别处就被销毁，任务会当场中断且不留痕迹，所以这块必须放到独立页面里跑。
// 页面处理完队列后自己关闭，不给用户留下空白页。
//
// 进度与错误写进 chrome.storage.local 的 convert_status，
// background 据此更新图标角标，弹窗据此提示结果 —— 任何环节失败都要让人看得见。

import { processToGif, fetchImage } from "./lib/imgproc.js";

const STATUS_KEY = "convert_status";

// 队列排空后不立刻关：留一段空闲期，连续下载两个分区可以复用同一页面，
// 少闪一次标签页；真没人派活了再自行关闭。
const IDLE_CLOSE_MS = 20000;
// 页面开了却始终没收到任务（握手后派发失败等异常）时的兜底关闭
const BOOT_CLOSE_MS = 60000;

const queue = [];
let pumping = false;
let closeTimer = null;

// 输出文件名：序号_对象key.gif
function gifName(url, index) {
  const path = url.split("?")[0].split("/").pop() || "emoji";
  const head = path.split("~")[0] || path;
  const hash = head.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20) || "emoji";
  return `${String(index + 1).padStart(3, "0")}_${hash}.gif`;
}

// 写状态 + 通知 background 更新角标
async function setStatus(patch) {
  const cur = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STATUS_KEY]: next });
  chrome.runtime.sendMessage({ type: "convert_progress", status: next }).catch(() => {});
  return next;
}

async function runJob(job) {
  const items = job.items || [];
  const dir = job.dir || "douyin-emoticons";
  const total = items.length;

  let done = 0;
  let failed = 0;
  const errors = [];

  await setStatus({
    running: true,
    total,
    done: 0,
    failed: 0,
    errors: [],
    dir,
    fatal: null,
    startedAt: Date.now(),
    finishedAt: null,
  });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let blobUrl = null;
    try {
      const buf = await fetchImage(item.url);
      const out = await processToGif(buf);
      const blob = new Blob([out.data], { type: "image/gif" });
      blobUrl = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url: blobUrl,
        filename: `${dir}/${gifName(item.url, item.index ?? i)}`,
        saveAs: false,
      });
    } catch (e) {
      failed++;
      if (errors.length < 5) {
        errors.push({
          url: String(item.url || "").slice(0, 90),
          error: String((e && e.message) || e),
        });
      }
    } finally {
      done++;
      if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      await setStatus({ running: true, total, done, failed, errors });
    }
  }

  await setStatus({ running: false, finishedAt: Date.now() });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  cancelClose(); // 有活干就取消关页面的定时，任务跑完再重新计时
  try {
    while (queue.length) await runJob(queue.shift());
  } finally {
    pumping = false;
    scheduleClose();
  }
}

// 关闭前留一点余量，确保最后一次 setStatus / 消息已发出
function closeSelf() {
  clearTimeout(closeTimer);
  closeTimer = null;
  try {
    chrome.tabs.getCurrent((t) => {
      if (t && t.id) chrome.tabs.remove(t.id);
    });
  } catch {}
}

function scheduleClose(delay = IDLE_CLOSE_MS) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(closeSelf, delay);
}
function cancelClose() {
  clearTimeout(closeTimer);
  closeTimer = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "worker_convert") {
    queue.push({ items: msg.items || [], dir: msg.dir || "douyin-emoticons" });
    pump();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "worker_ping") {
    // background 用定向消息探测本页是否还活着（用于复用，避免重复开标签页）
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// 启动即握手：background 收到这条才会派活。
// 否则标签页刚开、模块还没执行完消息就到了，会被静默丢弃。
(async () => {
  // 加超时：万一 getCurrent 不回调，也不能卡住握手（否则整页一直不就绪）
  const self = await Promise.race([
    new Promise((res) => {
      try {
        chrome.tabs.getCurrent(res);
      } catch {
        res(null);
      }
    }),
    new Promise((res) => setTimeout(() => res(null), 2000)),
  ]);
  // 记下 tabId，background 即使被回收重启也能找到并复用本页
  await setStatus({ ready: true, tabId: (self && self.id) ?? null });
  for (let i = 0; i < 20; i++) {
    try {
      await chrome.runtime.sendMessage({ type: "worker_ready" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300)); // SW 未唤醒，稍后重试
    }
  }
  scheduleClose(BOOT_CLOSE_MS);
})();
