# Malleaf · 随形

**软件，随你而形。**

[English](README.md)

Malleaf 是一个正在开发中的开源本地 Agent 应用：告诉 Agent 你希望软件怎样工作，让它为你构建自己的版本。

## 当前状态

仓库目前已导入上游源码。Malleaf 的定制、版本切换和恢复流程尚在开发中，还没有发布可安装版本。导入的应用仍保留上游品牌和更新配置。

## 我们要做什么

- 通过对话定制产品，包括界面、后端、Agent 编排和桌面端行为。
- 复用已安装的 Claude Code、Codex 等 Agent harness。
- 在本地独立分支中修改、构建和测试，试用个人版本，并能回到可用版本。
- 保留个人定制，同时跟进 Malleaf 新版；遇到产品取舍时，用文字选项让用户决定。
- 分享单项定制或整个版本，也能将通用改进贡献给公共版本。

定制修改的是 Malleaf 自己的代码，不修改 Claude Code、Codex 等依赖工具的源代码。

## 开发

参见[产品说明](docs/malleaf.md)和[开发文档](docs/development.md)。在分发 Malleaf 构建前，需要完成应用标识、本地数据和更新源的隔离。现有上游安装命令和下载链接对应 Paseo，不代表 Malleaf 已发布。

## 基于 Paseo

Malleaf 基于 Mohamed Boudra 及贡献者创建的 [Paseo](https://github.com/getpaseo/paseo) 独立开发，保留原始 Git 历史、版权声明和 [Apache-2.0 许可证](LICENSE)。第三方组件保留各自许可证。

初始化基线为北京时间 2026 年 10 月 28 日核验的上游 `main` 提交 [`de50243885ff47e0dc9c26233327fe066befa684`](https://github.com/getpaseo/paseo/commit/de50243885ff47e0dc9c26233327fe066befa684)。另见保留的[上游 README](README.paseo.zh-CN.md)和[上游同步说明](UPSTREAM.md)。

本文于 2026 年 10 月 28 日为 Malleaf 改写。Malleaf 独立维护，并非 Paseo 官方发行版。
