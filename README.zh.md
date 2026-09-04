<p align="center">
  <img src="docs/brand/mark.png" width="88" alt="">
</p>

<h1 align="center">proxybox</h1>

<p align="center">一个只有一条贯通孔道的实心壳体：流量只有一条出路，而它归我们所有。</p>

<p align="center"><a href="https://gerrux.github.io/proxybox/">网站</a> · <a href="https://github.com/Gerrux/proxybox/releases">下载</a> · <a href="docs/">文档</a> · <a href="docs/brand.md">品牌规范</a></p>

<p align="center"><a href="README.md">Русский</a> · <a href="README.en.md">English</a> · <a href="README.fa.md">فارسی</a> · <b>简体中文</b> · <a href="README.tr.md">Türkçe</a> · <a href="README.id.md">Bahasa Indonesia</a></p>
<p align="center">
  <a href="https://github.com/Gerrux/proxybox/releases/latest"><img alt="" src="https://img.shields.io/github/v/release/Gerrux/proxybox?style=flat-square&labelColor=14161A&color=2E4BD8"></a>
  <a href="https://github.com/Gerrux/proxybox/actions/workflows/ci.yml"><img alt="" src="https://img.shields.io/github/actions/workflow/status/Gerrux/proxybox/ci.yml?branch=master&style=flat-square&labelColor=14161A&label=ci"></a>
  <a href="LICENSE"><img alt="" src="https://img.shields.io/github/license/Gerrux/proxybox?style=flat-square&labelColor=14161A&color=1E9E5A"></a>
  <img alt="" src="https://img.shields.io/badge/Windows-10%20%7C%2011-14161A?style=flat-square">
  <img alt="" src="https://img.shields.io/badge/i18n-ru%20en%20fa%20zh%20tr%20id-14161A?style=flat-square">
</p>

**按 fail-closed 原则控制出站流量。** 你选中的程序只能经由你自己的隧道访问网络；
没有隧道，就没有网络。其他应用的流量完全不受干预。

Windows 10/11。工作区 crate 中的 Rust 内核，其上是一个服务，Tauri 2.x 桌面外壳，
前端为 Vite + React + TS + Tailwind。界面、服务和安装程序都支持六种语言。

原始技术说明（俄文）——[proxybox-prompt.md](proxybox-prompt.md)。

![proxybox 窗口](docs/interface.png)

窗口首先要显示的就是状态，所以它占据顶部。标题下方画的是通路本身：从所选应用到网络。
隧道处于开启状态时，短划会沿着它移动；没有隧道时，管道被切断并静止。

![没有隧道 — 访问已关闭](docs/interface-failclosed.png)

关闭的访问是琥珀色而不是红色，这不是审美偏好：fail-closed **正常工作**时就该是这个
样子——用红色会被读成应用出错。红色只留给一件事：服务没有响应，或者规则没有生效，也
就是真的坏了、需要人来处理。应用列表的行使用同样的颜色——每个应用此刻的处境，就在列
表所在的地方看得到。

共有六种语言：俄语、英语、波斯语、中文、土耳其语和印尼语。切换开关在设置里，位于标
题栏按钮之后；语言由服务保存，因此日志会随窗口一起切换。

![英文界面](docs/interface-en.png)

## 不变式

隐私模式已开启 + 隧道未确认 = 所选应用没有网络。不存在带直连的中间状态，也没有任何
绕行规则。架构中其余的一切都由此推出。

范围有两种，在窗口顶栏管道的左端选择。**白名单**——只有所选应用有网络，并且只能经由
隧道。**整台计算机**——完全不做筛选，连背后没有进程的流量也会进入隧道：服务、驱动、
DNS。不变式是同一个，改变的只是它作用于谁。

筛选并不住在隧道配置里，而住在 Windows 防火墙里，并且发生在 `connect` 时刻，早于任何
TUN。两种范围下的 sing-box 配置逐字节相同，其中根本没有绕过隧道的路由——所以切换范围
和编辑应用列表都不会重启隧道：已打开的 SSH 会话可以安然度过。

```
                 是 ─────────────► 已放行，流量进入隧道
SOCKS5 探测 ─────┤
                 否 ─────────────► 没有放行：所选应用同样没有网络
```

内部如何运作——[docs/how-it-works.md](docs/how-it-works.md)。

## 安装

现成的安装程序在[发布页](https://github.com/Gerrux/proxybox/releases)。NSIS，
per-machine，六种语言：它把窗口、服务、CLI 和 sing-box 放进同一个目录，并以
LocalSystem 身份注册自启动的 `proxybox` 服务。本产品没有自己的网络——隧道是你自己的
服务器。

细节、更新以及与他人的 VPN 共存——[docs/install.md](docs/install.md)。

## 在 Windows 上快速开始

双击 `run.bat` — 它会检查环境，必要时下载 sing-box，安装依赖，然后给出选项：带应用
窗口启动服务、在浏览器中打开界面并启动服务、构建安装程序、跑测试，或者检查环境
（`doctor`）。

服务需要管理员权限——否则无法建立 TUN 和防火墙规则；若在没有权限的情况下启动，
`run.bat` 会提醒。

## 原则

- **Fail-closed：** 不存在带直连的中间状态。没有隧道就 DROP。没有任何绕行规则。
- **特权只存在于服务中。** GUI 和 CLI 是以普通用户身份运行的 `core-ipc` 瘦客户端，
  自身没有状态。在 Windows 上，连接走带访问列表的命名管道：SYSTEM 和管理员完全放行，
  交互式用户可读写，低完整性进程（浏览器沙箱）完全不放行。状态目录也用同样的方式上锁：
  `state.json` 里存放着所有配置的密码和密钥。
- **对外只有一个地址，而且它也能关掉：** 没有遥测，没有流量日志。探测只发往用户自己
  的服务器。唯一的第三方是 `ip-api.com`，用来询问出口位置，而且询问是**经由隧道**进
  行的：该服务看到的是你服务器的地址，不是你的。可用「询问国家」设置或 `PG_GEO=0` 关
  闭。窗口只有在按下按钮时才会访问 `api.github.com` 检查更新——绝不自作主张，绝不在
  后台进行。
- **前端使用 TS strict。**

## 文档

| | |
| --- | --- |
| [第一步](docs/quickstart.md) | 从空窗口到可用的隧道，以及没成功时怎么办 |
| [工作原理](docs/how-it-works.md) | 隧道、sing-box 配置、防火墙、DNS，以及完整的原则 |
| [在 Windows 上安装](docs/install.md) | 安装程序、更新、服务记住了什么、旁边有别的 VPN |
| [配置、订阅与测速](docs/profiles.md) | 导入链接与订阅、Clash YAML、测量节点 |
| [浏览器配置](docs/browser-profiles.md) | 独立的浏览器会话，以及网站能看到它们的什么 |
| [窗口](docs/interface.md) | 连接、语言、托盘与浮窗、设置 |
| [开发](docs/development.md) | crate 结构、命令、环境变量、出问题时怎么办 |
| [还缺什么](docs/limitations.md) | 已知的漏洞，按代价排序 |
| [品牌规范](docs/brand.md) | 标志、填充、安全空间、禁止事项 |
| [WFP：算过，但没有采用](docs/wfp.md) | 为什么没有自己的过滤驱动 |

文档用俄语书写：俄语是本项目的源语言，也是翻译查表所用的键。只有 README 有译本。

构建与发布安装程序——[src-tauri/BUILD-WINDOWS.md](src-tauri/BUILD-WINDOWS.md)。

## 参与贡献

本项目在 Linux 上构建，却只在 Windows 上运行。因此眼下最有用的是两件事：在真实机器上
装好之后究竟发生了什么的报告，以及校读译文——除英文外，没有任何一种语言经过母语者过目。
其余见 [CONTRIBUTING.md](CONTRIBUTING.md)。隐私或权限方面的漏洞请勿写成公开 issue：
见 [SECURITY.md](SECURITY.md)。

## 许可证

[GPL-3.0-or-later](LICENSE)。
