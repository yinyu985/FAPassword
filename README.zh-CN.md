<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="FAPassword logo">
</p>

<h1 align="center">FAPassword</h1>

<p align="center">
  一个 Chrome/Edge 扩展，在 macOS 上与 Apple Passwords（iCloud 钥匙串）对话并自动填充你的登录信息，但没有官方扩展的那些毛病。
</p>

---

Apple 官方 iCloud Passwords 扩展在 Chrome 上只有 2.3/5 分（约 2,600 条评价）。它会忘记会话、每隔几小时就重新索要六位验证码，在一次性验证码输入框上弹出 "Enable AutoFill" 气泡，还和 Chrome 自带的密码管理器打架。这是一个替代客户端。

它使用与 Apple 扩展相同的原生消息协议（`com.apple.passwordmanager`）：一次 SRP-6a 握手，你 Mac 上显示的六位码就是共享密钥，随后通过 AES-GCM 加密通道进行密码查询。同一个保险库、同一次系统授权，但客户端行为合理得多。

它连接实时保险库，只提示一次 PIN，列出当前站点的登录信息并填充。

## 六位验证码：不用手敲，直接粘贴

六位验证码输入框支持**直接粘贴**。Mac 弹窗显示验证码后，用屏幕 OCR 识别一下，把识别结果整段贴进去就行——空格、破折号、换行、全角数字和各种杂字符都会被过滤掉，只留六位数字，凑满六位自动开始校验。不用手敲，也不用对着识别乱的字符串挨个删。

只要 OCR 拿到了正确的六位数字，粘贴 `123 456`、`1234 56` 或 `123.456` 都会按 `123456` 校验。

## 它修复了什么

| 对 Apple 扩展的抱怨 | 本扩展的做法 |
|---|---|
| 每次重启都要重新输六位码，有时每隔几小时一次 | 通过 keep-alive 定时器维持 MV3 worker 和会话存活，每个真实会话只输一次码（[background.js](src/background.js)） |
| 每个输入框（包括 OTP 框）都弹 "Enable AutoFill" 气泡 | 内联下拉框只出现在真正的登录字段上，从不出现一次性验证码框（[content.js](src/content.js)） |
| 100% CPU / 输入卡顿 | 内容脚本不做任何逐键操作，只在聚焦登录字段时才响应 |
| 悬停时重新下载每张图片扫描二维码 | 完全没有图片或二维码扫描 |
| 填充错误的字段或错误的源站 | 填充严格绑定页面源站，并跳过隐藏/被点击劫持的字段 |

两种填充方式：聚焦登录字段时的内联下拉框，或工具栏弹窗。两者都走同一条校验源站、经系统授权的路径。

## 你应该先知道的限制

这是一个从 GitHub 侧载（sideload）的工具。它上不了 Chrome Web Store，原因出在 macOS 本身。

macOS 14+ 自带原生助手 `PasswordManagerBrowserExtensionHelper`。macOS 15.4 及以后，该助手只接受两个硬编码的扩展 ID——Apple 自家 Chrome 和 Edge 扩展的 ID。这些 ID 被编译进已签名的系统二进制中，其他一律拒绝。

所以要连上它，本扩展的 `manifest.json` 必须携带 Apple 扩展的 public `key`，这让 Chrome 给它分配唯一被接受的 ID：`pejdijmoenmkgeppbflobdenhhabjlaj`。这是当前 macOS 上 Chrome 扩展到达该助手的唯一途径。

对你来说意味着：

- 未经打包加载、个人使用没问题
- 无法发布到 Web Store，因为那个 ID 和 key 属于 Apple
- 必须先禁用 Apple 官方 iCloud Passwords 扩展，因为同一 profile 里两个扩展不能共享一个 ID

要发布浏览器客户端的话，Firefox 是可行的路线，参见 [au2001/icloud-passwords-firefox](https://github.com/au2001/icloud-passwords-firefox)。Chrome 被锁死在 Apple 的 ID 上。

### 为什么无法使用自己的 ID

macOS 15.4+ 读取实时保险库，要么用 Apple 的原生助手（要求 Apple 两个 ID 之一），要么用仅限 Apple 的钥匙串 entitlement。其他路线全部走不通：

| 路线 | 结果 |
|---|---|
| 通过代理原生宿主唤起助手 | 被助手的父进程启动约束拦截，父进程必须是白名单浏览器 |
| 把自己的扩展 ID 交给助手 | 被拒，允许的 ID 硬编码在已签名二进制中 |
| `security` 命令行 / `Security.framework` | 同步项返回 0，看不到 iCloud 保险库 |
| 直接读 `keychain-2.db` | SQLite 可读，但密码数据是加密的，密钥被仅限 Apple 的 entitlement 把关 |
| Apple 的 [`password-manager-resources`](https://github.com/apple/password-manager-resources) 贡献流程 | 只通过系统更新按签名身份授权浏览器，第三方扩展没有通道 |

借用 Apple 的 key 是唯一入口。证据见 [VERIFICATION.md](VERIFICATION.md)。

## 系统要求

- macOS 14（Sonoma）或更新，已登录 iCloud 并开启 Passwords
- Chrome 或 Edge
- 已移除或禁用 Apple 官方 iCloud Passwords 扩展

## 安装

```bash
git clone https://github.com/yinyu985/FAPassword.git
```

1. 禁用 Apple 官方 iCloud Passwords 扩展（它占用同一个 ID）
2. 打开 `chrome://extensions`，开启右上角开发者模式
3. 点击“加载已解压的扩展程序”，选择 `FAPassword` 文件夹
4. 确认扩展 ID 是 `pejdijmoenmkgeppbflobdenhhabjlaj`
5. 点击工具栏图标，输入你 Mac 上显示的六位码，完成
6. 打开一个有已保存登录信息的网站，填充

### 可选：隐藏浏览器自带的密码管理器

弹窗可以自行抑制浏览器竞争性的保存气泡和自动填充下拉框（页脚开关）。要连同整个浏览器密码管理器一起移除——地址栏钥匙图标和内置自动填充——需要一个一次性助手的帮助，因为扩展无法自行写入 macOS 策略：

```bash
./native/install.sh   # 注册一个极小的原生助手，仅 macOS
```

然后完全退出并重新打开浏览器（`Cmd+Q`）。弹窗中的 **Hide browser password manager entirely** 开关现在生效了；它会为你拥有的每个 Chromium 浏览器设置 `PasswordManagerEnabled=false`。随时用 `./native/uninstall.sh` 撤销。该助手只运行三条固定的 `defaults` 命令，且只接受本扩展 ID 发来的消息。

## 工作原理

```
popup.js / content.js
        │  runtime 消息
        ▼
background.js  ──  keep-alive 定时器维持会话
        │
        ▼
protocol.js  ──  chrome.runtime.connectNative("com.apple.passwordmanager")
        │            GET_CAPABILITIES → m0（挑战/PIN）→ m2（校验）→ 查询
        ▼
srp.js + crypto.js   SRP-6a（RFC 5054，3072 位）+ AES-GCM 会话
        ▼
PasswordManagerBrowserExtensionHelper（macOS 原生，对接 iCloud 钥匙串）
```

## 无法修复的

- macOS 授权提示。助手读取密码时，macOS 会要求 Touch ID 或登录密码。这是保险库为每条凭据设置的 `RequiresUserAuthenticationToFill` 标志。Chrome 内置管理器能跳过它，只是因为密码存在自己的数据库而不是 iCloud 保险库里；去掉这个提示就意味着放弃实时保险库访问。
- 不支持 Linux。和 Apple 一样，原生助手只存在于 macOS 和 Windows。
- 不支持 passkey 或 TOTP 管理。超出范围，本扩展只读取密码和登录名。
- 仍依赖于 Apple 的助手。如果 Apple 修改或弄坏了它（过去几个 macOS 更新就是这样），本扩展也会跟着坏。

## 故障排查

### Mac 显示了验证码，但扩展提示不正确

一个验证码只属于一次握手。助手一校验完验证码（无论对错）就结束该次握手。新握手会在屏幕上放一个新验证码并作废旧的那个。旧提示可能在它的验证码失效后仍停留在屏幕上。

扩展只在没有有效验证码时才索要验证码。一次失败尝试后，消息会提示下一次要输入哪个码。如果 Mac 显示两个提示，使用最新那个的验证码。也可以在弹窗中选择 **Request a new code**。

验证码 3 分钟后过期。之后扩展会向 Mac 索要新验证码，而不是去校验旧码。

## 安全说明

- 会话密钥只存在 worker 内存中，从不写入磁盘
- 每次密码查询都通过 AES-GCM 与助手端到端加密
- PIN 只用于派生 SRP 共享密钥，不存储
- 读取密码可能触发 Touch ID 提示，那是助手的动作，不是本扩展

## 致谢

协议实现派生自 [au2001/icloud-passwords-firefox](https://github.com/au2001/icloud-passwords-firefox)（Apache-2.0）。参见 [`NOTICE`](./NOTICE)。

## 许可证

Apache-2.0。参见 [`LICENSE`](./LICENSE)。

与 Apple Inc. 无关联，亦未获得其背书。