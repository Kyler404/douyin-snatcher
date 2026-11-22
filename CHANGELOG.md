# Changelog

本文件记录项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 预览网格支持多选：缩略图左上角勾选框，Shift+点击连选，分区内「全选 / 取消全选」；原「下载全部」改为「下载所选」
- 「下载所选」每批单独建一个以时间命名的子目录（如 `douyin-emoticons/2026-11-21_121500/`），多次下载不再混在一起；单张下载仍直接放在分区目录下

### 修复

- 下载的 GIF 直接落到默认下载目录、文件名变成 UUID（如 `3d59637b-….gif`），子目录和序号文件名不生效：浏览器中装有其他监听 `downloads.onDeterminingFilename` 的扩展时，Chromium 会把 `downloads.download({ filename })` 传入的子目录和文件名冲掉；现由后台在 `onDeterminingFilename` 中显式指定目标子目录与文件名
- 单张下载的文件名序号比预览位置多 1（如第 1 张存成 `002_…`）
- 转出的 GIF 发到微信后出现白色噪点：透明色此前固定指向调色板第 0 号颜色（不透明图里通常是最暗的颜色），导致这些像素被当成透明；现改为指向调色板中真正透明的颜色，无透明像素时不再声明透明色

## [1.1.0] - 2026-09-12

### 新增

- 下载即转 GIF：不再有单独的转换入口，点下载就在后台自动完成
- 统一输出 `.gif`（WebP/PNG/JPG 全部重编码，输入本身是 GIF 则原样透传）
- 下载结果与失败原因可见：图标角标显示剩余数量，全部失败显示 `!`，弹窗展示成功/失败数与错误原因
- 后台转换工作页 `worker.html`：以后台标签页形式运行，处理完自动关闭
- 图片处理管线 `lib/imgproc.js`：任意受支持格式 → GIF

### 修改

- 去除 `offscreen` 依赖与相应权限，改用后台标签页承载转换任务
- 下载产物统一走「长边 ≤1024px、单文件 ≤3MB、最小边不低于 120px」约束
- 抓图请求显式携带 Referer，403/5xx 自动重试一次

## [1.0.0] - 2026-08-15

### 新增

- 双通道独立捕获：收藏表情包（`byteimg.com`）与对话表情包（`douyinpic.com`）
- DOM 扫描 + 网络请求拦截双通道互补抓取
- 按对象 key 智能去重（忽略 CDN 节点、签名参数、尺寸变化）
- `declarativeNetRequest` 注入 Referer 绕过 403 防盗链
- 弹窗内实时预览网格（4 列，支持点击放大、单张下载）
- 分区批量下载（收藏 → `douyin-emoticons/`，对话 → `douyin-chat/`）
- 导出 JSON/TXT 文件
- 复制全部/仅新增链接到剪贴板
- 深色潮流风格 UI（抖音品牌色渐变）
- 独立开关控制，默认关闭，关闭时自动清空对应记录
- `safeSend()` 包裹同步异常，处理 Extension context invalidated
- Service Worker `ready` 屏障防止重启覆盖已存记录
- Promise 串行锁防写入竞态
