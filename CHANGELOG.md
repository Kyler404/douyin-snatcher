# Changelog

本文件记录项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
