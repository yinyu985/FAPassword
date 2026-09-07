<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="FAPassword logo">
</p>

<h1 align="center">FAPassword</h1>

<p align="center">
  一个 Chromium 扩展，在 macOS 上与 Apple Passwords（iCloud 钥匙串）通信并自动填充登录信息。
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
| 每次重启都要重新输六位码，有时每隔几小时一次 | 活跃的原生消息端口会维持 MV3 worker 和会话；真正断连时会立即清理并允许重连（[protocol.js](src/protocol.js)） |
| 每个输入框（包括 OTP 框）都弹 "Enable AutoFill" 气泡 | OTP 语义优先于密码类型；已覆盖已知验证码、搜索和联系信息测试页，未标注的自定义控件仍依赖启发式识别（[field-policy.js](src/field-policy.js)） |
| 100% CPU / 输入卡顿 | 聚焦时分类；输入时只关闭过时建议并取消待填充请求，不扫描整页或查询原生助手 |
| 悬停时重新下载每张图片扫描二维码 | 完全没有图片或二维码扫描 |
| 填充错误的字段或错误的源站 | 填充严格绑定页面源站，并跳过隐藏/被点击劫持的字段 |

两种填充方式：聚焦登录字段时的内联下拉框，或工具栏弹窗。两者都走同一条校验源站、经系统授权的路径。

工具栏弹窗底部还提供两个独立操作：打开 Apple 密码，方便你直接维护凭据；生成强密码，可指定 8—64 位长度及是否包含特殊字符，结果只在当前弹窗内暂存，点击“复制”后才写入剪贴板。安装或更新可选原生助手（`./native/install.sh`）后，打开按钮会优先启动独立的“密码”App，启动失败时自动回退到密码设置。未安装兼容助手时，仍使用系统设置链接；无法识别系统版本时提供 Apple 的打开说明。在新密码字段上聚焦时，内联菜单也会提供直接填入强密码和确认密码的选项。

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
- Chrome、Edge、Chromium、Brave 或 Helium（Apple 原生助手是否接受取决于 macOS 与浏览器版本）
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

弹窗通过 `passwordSavingEnabled` 控制浏览器的密码保存功能，该 API 不保证关闭全部密码自动填充界面。独立的地址开关控制 `autofillAddressEnabled`，不控制付款信息。参见 [Chrome privacy API](https://developer.chrome.com/docs/extensions/reference/api/privacy)。若要用 macOS 管理策略禁用当前浏览器的密码管理器，需要安装可选助手：

```bash
./native/install.sh   # 注册一个极小的原生助手，仅 macOS
```

然后完全退出并重新打开浏览器（`Cmd+Q`）。弹窗中的 **Hide browser password manager entirely** 开关会生成 macOS 配置描述文件并打开，等待你批准。助手只接受本扩展 ID 的消息，打开目标限定为“密码”App、密码设置、该描述文件或系统设置中的描述文件页面。`./native/uninstall.sh` 只移除助手注册；已安装的描述文件必须由你在系统设置中移除。

助手的新版本仅为**启动它的当前浏览器**生成配置，界面会写明浏览器名称；只有被强制的实际布尔值为 false 时才显示禁用。更新后需重新运行安装脚本。旧版本生成的跨浏览器配置不会自动删除，迁移前请在系统设置中移除旧配置。

## 工作原理

```
popup.js / content.js
        │  runtime 消息
        ▼
background.js  ──  管理原生端口，及时拒绝断连后的旧请求
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

点击网页内的解锁条目会主动请求新验证码，即使之前的系统验证码窗口已被关闭。随后打开的扩展弹窗会复用这次挑战，避免再发一个码。一次失败尝试后，消息会提示下一次要输入哪个码；所有验证码状态都在同一位置显示。也可以在弹窗中选择 **Request a new code**。

验证码 3 分钟后过期。之后扩展会向 Mac 索要新验证码，而不是去校验旧码。

### Touch ID 提示后，填充一直没有响应

密码读取最长等待 2 分钟。如果 Apple 助手既不回复也不断开，FAPassword 会关闭这条无法
确认响应归属的原生连接，避免迟到的响应被错配给下一次请求。再次选择账号即可重连；若反复
发生，请完全退出浏览器后重新打开。

### 同时启用 Apple 官方扩展后行为异常

不要同时启用两个扩展。原生助手要求 Apple 接受的扩展身份，两者会在集成边界发生冲突，
并可能争抢系统提示和页面字段。

## 安全说明

- 会话密钥只存在 worker 内存中，从不写入磁盘
- 每次密码查询都通过 AES-GCM 与助手端到端加密
- PIN 只用于派生 SRP 共享密钥，不存储
- PIN 只在扩展弹窗中输入；账号建议放在网页不可读取的 closed Shadow DOM 中
- 密码填充绑定精确文档、请求与字段；HTTP 仅允许明确回环地址（`localhost`、`.localhost` 子域、`127.0.0.1`、`[::1]`），`.test` 和私网 HTTP 地址不再默认放行
- closed Shadow DOM 保护建议内容；顶层弹出层、命中测试和真实交互检查覆盖已复现的界面劫持场景，不代表能证明抵御所有恶意网页渲染技巧
- 密码仅在内存中缓存最多两分钟，读取时检查过期；会话变化或保存请求发出后会使相关缓存失效
- 读取密码可能触发 Touch ID 提示，那是助手的动作，不是本扩展

## 保存与刷新

刷新只更新账号列表并使账号和密码缓存失效；“再次填充”是独立操作，并保留原登录框所在的 frame。生成密码只作用于识别出的新密码及确认字段。

真实提交事件会立即把最小快照交给后台。已有账号也会进入 Apple 的 `maybeAdd` 流程，以处理密码更新。延迟保存的三分钟有效期约束交接前的排队和加密阶段；弹窗提供待解锁、失败、结果不确定、过期和请求已发出等状态，以及重试和取消入口。与 Apple 官方客户端一致，保存单向投递，不等待保存回复、不阻塞后续查询。请求发出不等于用户批准或密码已经存入保险库。结果不确定时，应先检查 Apple Passwords 再重试。取消本地任务无法撤销 macOS 已收到的操作。

自动测试只模拟原生传输，不能证明真实 Touch ID、保险库保存或所有系统／浏览器组合可用。已验证范围和人工验收清单见 [VERIFICATION.md](VERIFICATION.md)。

## 开发与验证

项目的产品行为、UI 层级、无滚动条要求、刷新交互和安全约束统一记录在 [SPEC.md](SPEC.md)。修改功能前先对照该规范，实际验证结果记录在 [VERIFICATION.md](VERIFICATION.md)。

`npm run check` 检查 JavaScript、Shell/Python 语法、本地化和 manifest 资源；
`npm test` 使用已安装的开发依赖运行协议、密码学及构建安全回归。根目录加载已生成的
`src/background.bundle.js`；修改后台源码后运行 `npm run bundle:background` 或 `npm run build`，
`check` 会拒绝过期的生成文件。构建在 `dist/` 的对应版本目录中原子替换文件，保留其他已安装版本；
根目录与产物使用相同的单文件后台内容。可选浏览器自动化见
[`test-harness/automation/README.md`](test-harness/automation/README.md)，它不会自动下载浏览器。

## 致谢

协议实现派生自 [au2001/icloud-passwords-firefox](https://github.com/au2001/icloud-passwords-firefox)（Apache-2.0）。参见 [`NOTICE`](./NOTICE)。

## 许可证

Apache-2.0。参见 [`LICENSE`](./LICENSE)。

与 Apple Inc. 无关联，亦未获得其背书。
