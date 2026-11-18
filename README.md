# dsh-resource-monitor

在 DeepSeek Harness 的**左侧栏**打开「服务器资源」面板，实时查看本机与所有 SSH 服务器的 CPU、内存、磁盘及 **GPU / NPU / DCU** 算力卡占用，并支持点击卡片查看只读 **Top 进程**与**显存 / HBM 占用进程**。

- 左侧栏新增服务器图标，点击在全局主面板打开监控页；**不占用会话标签页**。
- 服务器来源自动合并：面板里手动添加的 SSH 主机 + `dsh-remote` 已保存主机 + `~/.ssh/config`。
- 手动添加支持**密码**或**私钥**（粘贴私钥内容或选择私钥文件），保存后立即开始采集。
- 每台服务器一张卡片：CPU、内存、磁盘（显示**已用 / 总容量**与峰值挂载点）、负载、运行时间、SSH 延迟，以及最近 40 次 CPU 采样的迷你曲线。
- **异构算力卡（GPU / NPU / DCU）**：支持 NVIDIA GPU（`nvidia-smi`）、华为昇腾 NPU（`npu-smi`）、海光 DCU / AMD GPU（`hy-smi` / `rocm-smi`），逐卡展示**算力利用率**与**显存 / HBM 占用**双进度条、温度与功耗。
- **只读进程与显存进程抽屉**：点击任意在线卡片打开右侧详情抽屉，查看类似 `top` 的系统进程（支持搜索、多列排序与迷你进度条）、各算力卡的显存 / HBM 占用进程明细以及完整磁盘分区列表；日常轮询不采集进程列表，对服务器几乎无额外负载。
- **自定义名称与刷新间隔**：支持为本机和任意服务器设置自定义显示名称（IP / 连接地址固定附带且不可调整）；右上角支持 `10 秒 / 30 秒 / 60 秒 / 手动 / 自定义秒数` 刷新，页面隐藏时自动暂停轮询。
- **卡片右上角可直接删除 / 移除服务器**：手动添加的会真正删除记录和私钥；来自 `dsh-remote` / `~/.ssh/config` 的只从监控列表隐藏，不会改动原配置，可在“添加服务器”弹窗里恢复。
- **认证失败的主机默认隐藏**，避免刷屏；可在“添加服务器”弹窗里修改或删除。

![服务器资源监控预览](docs/preview.png)

## 安装

### 方式一：从 GitHub 安装（推荐）

在 DSH 里打开 **设置 → 插件 → 安装**，输入仓库地址：

```
https://github.com/xua123/dsh-resource-monitor
```

或者从 [Releases](https://github.com/xua123/dsh-resource-monitor/releases) 下载 `dsh-resource-monitor-0.2.2.tgz`，用“本地文件”安装。

### 方式二：本地打包

```powershell
cd path\to\dsh-resource-monitor
npm run pack
```

产物：`dist/dsh-resource-monitor-0.2.2.tgz`。在 **设置 → 插件 → 安装 → 本地文件** 选择它即可。

命令行安装（CLI 只做 `pnpm add`，不会自动加入 `dsh.profile.bundles`）：

```powershell
dsh plugin --profile desktop add file:/absolute/path/to/dist/dsh-resource-monitor-0.2.2.tgz --prefer-offline --ignore-scripts
```

然后把 `dsh-resource-monitor` 追加到 profile `package.json` 的 `dsh.profile.bundles` 数组，重启 DSH。

> 不要用目录联接（junction）把 `node_modules` 指向源码目录。pnpm 替换 `link:` 依赖时可能跟随联接删除目标目录内容；请始终用 `.tgz` 或插件页安装。

## 添加与管理服务器

1. 点左侧栏的「服务器资源」图标。
2. 点右上角 **添加服务器**。
3. 填写名称（可选）、地址、端口、用户名，选择 **密码** 或 **私钥**：
   - 密码：直接填 SSH 密码。
   - 私钥：粘贴私钥内容，或点“选择私钥文件”；有口令时填入口令。
4. 保存后插件会立即建立 SSH 连接并开始采集；同一弹窗下方可以查看和删除已添加的服务器。
5. **自定义服务器名称**：点击卡片右上角铅笔图标，可修改显示名称（留空恢复默认）；原有 IP / 连接地址以只读形式展示并附在卡片下方，不可修改。

存储位置：

| 内容 | 路径 | 权限 |
| --- | --- | --- |
| 手动服务器清单 | `~/.dsh/server-monitor/targets.json` | `0600` |
| 粘贴的私钥 | `~/.dsh/server-monitor/keys/<id>.key` | `0600` |
| 隐藏服务器列表 | `~/.dsh/server-monitor/hidden.json` | `0600` |
| 自定义服务器名称 | `~/.dsh/server-monitor/aliases.json` | `0600` |
| 主机密钥指纹（TOFU） | `~/.dsh/server-monitor/known-hosts.json` | 默认 |

密码和私钥只保存在 Host 进程与上述本地文件中，**不会返回给浏览器**；写入接口还需要页面内注入的一次性令牌。

## 删除 / 隐藏服务器

卡片右上角的垃圾桶按钮：

- **手动添加的服务器**：真正删除 `targets.json` 里的记录，粘贴的私钥文件一并删除。
- **dsh-remote / `~/.ssh/config` 的服务器**：只写入 `~/.dsh/server-monitor/hidden.json`，从监控列表隐藏，不会修改这些原始配置。
- 打开“添加服务器”弹窗，底部“已隐藏的服务器”可以随时恢复。

## 异构算力卡（GPU / NPU / DCU）与进程监控

- **NVIDIA GPU**：通过 `nvidia-smi` 读取算力利用率、显存已用/总量、温度、功耗、CUDA Compute Capability 及 `--query-compute-apps` 显存进程。
- **华为昇腾 NPU**：通过 `npu-smi info` 读取芯片型号、AICore 利用率、HBM/内存占用、温度、功耗及底部进程占用表。
- **海光 DCU / AMD GPU**：通过 `hy-smi` / `rocm-smi`（兼容 `--json` 与标准表格输出）读取利用率、显存、温度、功耗及 `--showpids` 显存进程。
- **系统 Top 进程**：点击在线服务器卡片打开右侧详情抽屉时按需执行（远程 Linux 使用 `ps`，本机 Linux/macOS 使用 `ps`，Windows 使用轻量 `Get-Process`），纯只读展示。

## 服务器从哪来

| 来源 | 路径 | 说明 |
| --- | --- | --- |
| 手动添加 | 插件弹窗 | 支持密码 / 私钥，优先于同名主机 |
| 本机 | — | Node `os` + `fs.statfs`，Windows/Linux/macOS |
| dsh-remote 已保存主机 | `~/.dsh/remote-workspaces/machines.json` | 复用已保存的密码 / 密钥 / 端口 |
| OpenSSH 配置 | `~/.ssh/config` | 只读取具体的 `Host` 块；不使用 `Host *` 默认值，也不处理 `ProxyJump` |

同一台机器（host + port 相同）只显示一张卡片；手动添加的记录优先。`machines.json` 里 `host` 字段被误写成显示名的坏记录会被跳过。

## 配置

在 profile 的 `cordis.yml` / `cordis.patch.yml` 里给这一行加 `config`：

```yaml
- id: dsh-resource-monitor
  name: dsh-resource-monitor
  config:
    refreshMs: 10000         # 建议的浏览器刷新间隔（毫秒）
    cacheMs: 2500            # 服务端复用一次采集结果的时长
    errorCacheMs: 15000      # 失败主机的重试间隔
    waitMs: 2500             # 单次请求最多等多久，超时先返回“采集中”
    maxConcurrent: 6         # 同时拨号的 SSH 主机数
    commandTimeoutMs: 12000  # 单条远程命令超时
    connectTimeoutMs: 8000   # SSH 握手超时
    idleCloseMs: 120000      # 空闲连接回收时间
    hideAuthFailures: true   # 隐藏认证失败的主机
    includeSavedMachines: true
    includeSshConfig: true
    machinesFile: ''         # 覆盖 machines.json 路径
    sshConfigFile: ''        # 覆盖 ~/.ssh/config 路径
    ignoreHosts: ['192.0.2.99', 'old-*']  # 支持 * 和 ?
    hostKeyPolicy: tofu      # tofu | off
    showLocal: true
```

## 数据与安全

- 远程只执行**只读** POSIX 命令（`hostname`、`/proc/stat`、`/proc/meminfo`、`df` 及只读硬件查询命令；点击详情抽屉时按需执行 `ps`），不写文件、不调用 sudo、不提供进程终止操作。
- 手动添加的密码以明文保存在 `targets.json`（权限 `0600`）；私钥单独存文件（`0600`）。如果介意明文密码，请改用私钥认证。
- 隐藏列表与别名分别保存在 `hidden.json`、`aliases.json`（权限 `0600`），删除手动目标时会同时删除其私钥文件。
- 浏览器只能拿到 `id / name / host / port / username / auth / hasPassword / hasKey`，没有密码、口令或私钥路径。
- 写入接口（添加/删除目标、隐藏/恢复、修改别名）需要页面加载时注入的一次性令牌，并校验 `x-monitor-token`。
- 主机密钥采用 **首次信任（TOFU）**：第一次连接时把 SHA-256 指纹写到 `~/.dsh/server-monitor/known-hosts.json`，之后指纹变化会拒绝连接。
- 页面不引入外部脚本、字体或 CDN。

## 目前不支持

- 远程 **Windows / macOS** 主机（Linux 之外会返回「暂不支持」）；本机支持三个平台。
- `~/.ssh/config` 里的 `ProxyJump` / `ProxyCommand`、Kerberos/GSSAPI 主机。
- 磁盘只统计真实文件系统；`tmpfs`、`overlay`、`squashfs` 等会被过滤掉。

## 测试与打包

```powershell
npm test
npm run pack
```

`npm run pack` 只把 `lib/`、`assets/`、`cordis.patch.yml`、`icon.svg`、`README.md`、`LICENSE` 和 `package.json` 打进 `.tgz`，`node_modules`、`test/` 与源码外的文件不会进入包。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 左侧栏没有图标 | 确认插件已启用；重启 DSH 让客户端重新组合 |
| 添加后卡片没出现 | 认证失败的主机会被隐藏；打开“添加服务器”检查记录，或看 `~/.dsh/server-monitor/targets.json` |
| 卡片显示「认证失败」 | 默认已隐藏；在“添加服务器”里修正密码/私钥后重新采集 |
| 一直「采集中」 | 主机在 `connectTimeoutMs` 内没完成 SSH 握手；首次连接多等一轮刷新即可 |
| 「主机密钥已变化」 | 服务器重装或换钥；确认安全后删除 `~/.dsh/server-monitor/known-hosts.json` 里对应条目 |
| 页面 404 | Host 插件没加载成功；检查插件页里是否启用，或重启 DSH |
| 依赖 `dist/*.tgz` 丢失 | 重新 `npm run pack`，再用插件页或 `dsh plugin add` 安装新包 |

## 目录

```
lib/index.js            Host 插件：快照缓存、并发拨号、HTTP 路由（快照/详情/目标/别名）
lib/manual-targets.js   手动 SSH 目标、私钥、隐藏列表与自定义别名存储
lib/machines.js         合并手动目标、dsh-remote 注册表与 ~/.ssh/config
lib/ssh.js              SSH 连接池、主机密钥 TOFU、错误分类
lib/collect-local.js    本机 CPU / 内存 / 磁盘 / 算力卡及按需详情采集
lib/collect-remote.js   Linux 远程采集脚本与按需进程/显存解析
lib/gpu.js              NVIDIA GPU / 华为昇腾 NPU / 海光 DCU 及显存进程解析
lib/processes.js        系统 Top 进程解析与本机进程采集
lib/client.js           浏览器半侧：左侧栏入口 + 全局主面板
assets/dashboard.html   仪表盘页面（零依赖 HTML/CSS/JS，含详情抽屉与管理弹窗）
test/parsers.test.js    解析器、快照与别名持久化单元测试
icon.svg                插件页图标
cordis.patch.yml        标准 DSH bundle patch
```
