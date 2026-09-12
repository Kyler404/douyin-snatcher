// imgproc.js — 图片处理管线：任何输入格式 → 统一输出 GIF
//
// 三条硬约束：
//   1. 尺寸：等比缩放，长边 ≤ 1024px；未超过则保持原尺寸，绝不放大
//   2. 体积：单文件 ≤ 3MB；超出则按 80% 逐级缩小重编码
//   3. 体积缩小的下限：最小边不得 < 120px；触底后无论是否达标都直接输出
//
// 解码靠 Chrome 原生 ImageDecoder（WebCodecs，可逐帧解动画 WebP），
// 编码靠 gifenc。全程无 wasm、无外部依赖、不联网。

import { GIFEncoder, quantize, applyPalette } from "./gifenc.esm.js";

export const MAX_SIDE = 1024; // 长边上限
export const MAX_BYTES = 3 * 1024 * 1024; // 单文件体积上限
export const MIN_SIDE = 120; // 缩小下限（最小边不得小于此值）

const SHRINK = 0.8; // 每级缩小到当前的 80%
const MAX_FRAMES = 120; // 防御性上限，避免超长动画吃爆内存
const MIN_DELAY_MS = 20; // GIF 下低于 2cs 的延迟会被多数渲染器当成 100ms
const QUANT_PIXEL_BUDGET = 2_000_000; // 生成调色板时的采样像素预算

// ── 格式嗅探（靠 magic bytes，不信扩展名）──
export function sniffType(buf) {
  if (buf.byteLength < 12) return null;
  const b = new Uint8Array(buf, 0, 12);
  const tag = (o, n) => String.fromCharCode(...b.slice(o, o + n));
  if (tag(0, 4) === "RIFF" && tag(8, 4) === "WEBP") return "webp";
  if (b[0] === 0x89 && tag(1, 3) === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (tag(0, 3) === "GIF") return "gif";
  return null;
}

// ── 等比适配：只缩不放 ──
export function fitSize(w, h, max = MAX_SIDE) {
  const m = Math.max(w, h);
  if (m <= max) return { width: w, height: h };
  const r = max / m;
  return {
    width: Math.max(1, Math.round(w * r)),
    height: Math.max(1, Math.round(h * r)),
  };
}

// ── 抓取远端图片 ──
// 请求由扩展的后台工作页发出，跟网页里的请求不是同一个来源，
// 防盗链只认 Referer，所以这里显式带上（DNR 规则不保证覆盖扩展自身的请求）。
export async function fetchImage(url, attempt = 0) {
  let res;
  try {
    res = await fetch(url, {
      credentials: "omit",
      mode: "cors",
      referrer: "https://www.douyin.com/",
      referrerPolicy: "unsafe-url",
    });
  } catch (e) {
    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 400));
      return fetchImage(url, attempt + 1);
    }
    throw new Error("网络请求失败：" + ((e && e.message) || e));
  }
  if (!res.ok) {
    if ((res.status === 403 || res.status >= 500) && attempt < 1) {
      await new Promise((r) => setTimeout(r, 400));
      return fetchImage(url, attempt + 1);
    }
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.arrayBuffer();
}

// ── 把可绘制源画到目标尺寸，返回 RGBA ──
function rasterize(source, sw, sh, tw, th) {
  const cv = new OffscreenCanvas(tw, th);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, tw, th);
  ctx.drawImage(source, 0, 0, sw, sh, 0, 0, tw, th);
  return ctx.getImageData(0, 0, tw, th).data;
}

// ── 已解码的 RGBA 再缩放（用于体积降级，避免重复解码）──
function rescaleRgba(rgba, sw, sh, tw, th) {
  const src = new OffscreenCanvas(sw, sh);
  const sctx = src.getContext("2d");
  sctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), sw, sh), 0, 0);
  return rasterize(src, sw, sh, tw, th);
}

// ── 解码：动画走 ImageDecoder 逐帧，静态走 createImageBitmap ──
// 返回的 w/h 已应用长边约束
async function decodeFrames(buf, type, maxSide) {
  if (type === "webp" && typeof ImageDecoder !== "undefined") {
    const dec = new ImageDecoder({ data: buf, type: "image/webp" });
    await dec.tracks.ready;
    const track = dec.tracks.selectedTrack;
    const total = Math.min(track.frameCount, MAX_FRAMES);
    if (total === 0) throw new Error("WebP 无有效帧");

    const first = await dec.decode({ frameIndex: 0 });
    const base = fitSize(first.image.displayWidth, first.image.displayHeight, maxSide);

    const frames = [];
    for (let i = 0; i < total; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const us = image.duration; // 微秒
      let ms = Number.isFinite(us) && us > 0 ? Math.round(us / 1000) : 100;
      if (ms < MIN_DELAY_MS) ms = MIN_DELAY_MS;
      frames.push({
        rgba: rasterize(image, image.displayWidth, image.displayHeight, base.width, base.height),
        delay: ms,
      });
      image.close();
    }
    try { first.image.close(); } catch {}
    return { frames, w: base.width, h: base.height };
  }

  // 静态图（PNG / JPEG，或 WebCodecs 不可用时的 WebP 降级：只有首帧）
  const mime = type === "webp" ? "image/webp" : `image/${type}`;
  const bmp = await createImageBitmap(new Blob([buf], { type: mime }));
  const base = fitSize(bmp.width, bmp.height, maxSide);
  const rgba = rasterize(bmp, bmp.width, bmp.height, base.width, base.height);
  bmp.close?.();
  return { frames: [{ rgba, delay: 100 }], w: base.width, h: base.height };
}

// ── 编码 GIF ──
function encodeGif(frames, w, h) {
  // 帧太多时按间隔采样出调色板，避免量化耗时失控
  let sample = frames;
  const pxPerFrame = w * h;
  if (frames.length * pxPerFrame > QUANT_PIXEL_BUDGET) {
    const keep = Math.max(1, Math.floor(QUANT_PIXEL_BUDGET / pxPerFrame));
    const step = Math.ceil(frames.length / keep);
    sample = frames.filter((_, i) => i % step === 0);
  }

  const opts = { format: "rgba4444", oneBitAlpha: true };
  let palette;
  try {
    palette = quantize(sample.map((f) => f.rgba), 256, opts);
  } catch {
    palette = quantize(frames[0].rgba, 256, opts);
  }

  const gif = GIFEncoder();
  for (const f of frames) {
    const index = applyPalette(f.rgba, palette, "rgba4444");
    gif.writeFrame(index, w, h, {
      palette,
      delay: f.delay,
      repeat: 0, // 无限循环
      transparent: true,
    });
  }
  gif.finish();
  return gif.bytes();
}

/**
 * 任意受支持的图片 → GIF
 * @param {ArrayBuffer} buf
 * @param {{maxSide?: number, maxBytes?: number}} [opts]
 * @returns {Promise<{data: Uint8Array, ext: string, mime: string, width: number,
 *                    height: number, frames: number, scale: number, passthrough?: boolean}>}
 */
export async function processToGif(buf, opts = {}) {
  const maxSide = opts.maxSide || MAX_SIDE;
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const type = sniffType(buf);
  if (!type) throw new Error("不是受支持的图片格式");

  // 输入本身已是 GIF：直接透传，保留原有动画，不做任何重编码
  if (type === "gif") {
    return {
      data: new Uint8Array(buf),
      ext: "gif",
      mime: "image/gif",
      width: 0,
      height: 0,
      frames: 0,
      scale: 1,
      passthrough: true,
    };
  }

  const { frames, w, h } = await decodeFrames(buf, type, maxSide);

  let scale = 1;
  let data = encodeGif(frames, w, h);
  let tw = w;
  let th = h;
  const minSide = Math.min(w, h);

  // 体积超标 → 逐级缩到 80%，直到达标或触到最小边底线
  while (data.length > maxBytes) {
    let next = scale * SHRINK;
    if (minSide * next < MIN_SIDE) {
      // 再降就会让最小边 < 120px：把最小边钉在 120px 试最后一次
      const clamped = MIN_SIDE / minSide;
      if (clamped >= scale) break; // 已无法再降（原图本就这么小），直接输出
      next = clamped;
    }
    scale = next;
    tw = Math.max(1, Math.round(w * scale));
    th = Math.max(1, Math.round(h * scale));
    const scaled = frames.map((f) => ({
      rgba: rescaleRgba(f.rgba, w, h, tw, th),
      delay: f.delay,
    }));
    data = encodeGif(scaled, tw, th);
    if (minSide * scale <= MIN_SIDE) break; // 已经到底，不再尝试
  }

  return {
    data,
    ext: "gif",
    mime: "image/gif",
    width: tw,
    height: th,
    frames: frames.length,
    scale,
  };
}
