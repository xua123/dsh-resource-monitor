# dsh-resource-monitor

在 DeepSeek Harness 的**左侧栏**打开「服务器资源」面板，实时查看本机与所有 SSH 服务器的 CPU、内存、磁盘及 **GPU / NPU / DCU** 算力卡占用，并支持点击卡片查看只读 **Top 进程**与**显存 / HBM 占用进程**。

- 左侧栏新增服务器图标，点击在全局主面板打开监控页；**不占用会话标签页**。
- 服务器来源：面板里手动添加的 SSH 主机 + 本地 `~/.ssh/config`。**不依赖 dsh-remote**，不需要安装或配置它。
- 手动添加支持**密码**或**私钥**（粘贴私钥内容或选择私钥文件），保存后立即开始采集。
- `~/.ssh/config` 支持 `Host` 别名、`HostName`、`User`、`Port`、`IdentityFile`、`Host *` 默认值和 `Include`；认证走你本机已有的密钥 / ssh-agent。
- 每台服务器一张卡片：CPU、内存、磁盘（显示**已用 / 总容量**与峰值挂载点）、负载、运行时间、SSH 延迟，以及最近 40 次 CPU 采样的迷你曲线。
- **异构算力卡（GPU / NPU / DCU）**：支持 NVIDIA GPU（`nvidia-smi`）、华为昇腾 NPU（`npu-smi`）、海光 DCU / AMD GPU（`hy-smi` / `rocm-smi`），逐卡展示**平均利用率**、**功耗实际 / 上限（W）**与显存 / HBM 占用进度条。
- **只读进程与显存进程抽屉**：点击任意在线卡片打开右侧详情抽屉，查看类似 `top` 的系统进程（支持搜索、多列排序与迷你进度条）、各算力卡的显存 / HBM 占用进程明细以及完整磁盘分区列表；日常轮询不采集进程列表，对服务器几乎无额外负载。
- **自定义名称与刷新间隔**：支持为本机和任意服务器设置自定义显示名称（IP / 连接地址固定附带且不可调整）；右上角支持 `10 秒 / 30 秒 / 60 秒 / 手动 / 自定义秒数` 刷新，页面隐藏时自动暂停轮询。
- **卡片右上角可直接删除 / 移除服务器**：手动添加的会真正删除记录和私钥；来自 `~/.ssh/config` 的只从监控列表隐藏，不会改动原配置，可在“添加服务器”弹窗里恢复。
- **认证失败的主机默认隐藏**，避免刷屏；可在“添加服务器”弹窗里修改或删除。

![服务器资源监控预览](docs/preview.png)

## 安装

### 方式一：从 GitHub 安装（推荐）

在 DSH 里打开 **设置 → 插件 → 安装**，输入仓库地址：

```
https://github.com/xua123/dsh-resource-monitor
```

或者从 [Releases](https://github.com/xua123/dsh-resource-monitor/releases) 下载 `dsh-resource-monitor-0.6.0.tgz`，用“本地文件”安装。

### 方式二：本地打包

```powershell
cd path\to\dsh-resource-monitor
npm run pack
```

产物：`dist/dsh-resource-monitor-0.6.0.tgz`。在 **设置 → 插件 → 安装 → 本地文件** 选择它即可。

命令行安装（CLI 只做 `pnpm add`，不会自动加入 `dsh.profile.bundles`）：

```powershell
dsh plugin --profile desktop add file:/absolute/path/to/dist/dsh-resource-monitor-0.6.0.tgz --prefer-offline --ignore-scripts
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
| 显示范围选择 | `~/.dsh/server-monitor/selection.json` | `0600` |
| 主机密钥指纹（TOFU） | `~/.dsh/server-monitor/known-hosts.json` | 默认 |

密码和私钥只保存在 Host 进程与上述本地文件中，**不会返回给浏览器**；写入接口还需要页面内注入的一次性令牌。

## 只显示部分工作区服务器

`~/.ssh/config` 里的服务器默认全部显示。如果配置里有很多主机，但只想监控其中几台：

1. 打开 **添加服务器** 弹窗，拉到最下面的 **显示范围**。
2. 选择 **仅显示选中的服务器**。
3. 勾选需要监控的主机（可先点“全选/全不选”）。
4. 点 **保存显示范围**。

保存后，全局面板和工作区标签都只显示选中的工作区服务器；**手动添加的服务器始终显示**，不受这个开关影响。选择保存在 `~/.dsh/server-monitor/selection.json`。

## 采集速度

- 快照采用 **stale-while-revalidate**：页面先拿到上一份数据并立即渲染，服务端在后台刷新；慢的 `npu-smi` / `hy-smi` 主机不会把整个页面卡住几秒。
- 默认刷新间隔 **60 秒**（平均利用率使用同一个间隔作为窗口），首次加载约 1 秒返回（慢主机先显示“采集中”，下一次轮询补全）。
- 只有手动点“刷新”时才等待一次完整采集。

## 工作区标签只显示选中的服务器

工作区标签默认不显示全部主机，而是使用右上角的下拉框选择该工作区对应的 SSH 服务器：

- 选中后会按该主机单独请求快照，**不受全局“仅显示选中”白名单、隐藏列表或认证失败隐藏的影响**；认证失败时也会显示错误原因，而不是空白；
- 选择结果按工作区保存在浏览器 localStorage，下次打开仍然生效；
- 未选择时提示“当前工作区还没有绑定服务器”，不会回退显示全部；
- 只有点“查看全部”时才显示全部服务器。

> 本插件不再读取 dsh-remote 的镜像元数据，因此工作区与服务器的对应关系需要你在下拉框里手动选一次。

## 删除 / 隐藏服务器

卡片右上角的垃圾桶按钮：

- **手动添加的服务器**：真正删除 `targets.json` 里的记录，粘贴的私钥文件一并删除。
- **`~/.ssh/config` 的服务器**：只写入 `~/.dsh/server-monitor/hidden.json`，从监控列表隐藏，不会修改 `~/.ssh/config`。
- 打开“添加服务器”弹窗，底部“已隐藏的服务器”可以随时恢复。

## 异构算力卡（GPU / NPU / DCU）与进程监控

- **NVIDIA GPU**：通过 `nvidia-smi` 读取算力利用率、显存已用/总量、温度、功耗、CUDA Compute Capability 及 `--query-compute-apps` 显存进程。
- **华为昇腾 NPU**：通过 `npu-smi info` 读取芯片型号、AICore 利用率、每张卡的显存/HBM 已用与占卡比例、温度及底部进程占用表；兼容 310P3 与 910B 两种三行输出格式。
- **海光 DCU / AMD GPU**：通过 `hy-smi` / `rocm-smi` 读取每张 DCU 的利用率、VRAM 已用/总量与占卡比例；兼容带 ANSI 错误行和空字段的 `hy-smi --json` 输出，以及标准表格输出。
- 每张算力卡都会显示 **平均利用率**（不再画进度条）、**功耗 实际 / 上限 W** 和 **显存占卡比例**。
- **系统 Top 进程**：点击在线服务器卡片打开右侧详情抽屉时按需执行（远程 Linux 使用 `ps`，本机 Linux/macOS 使用 `ps`，Windows 使用轻量 `Get-Process`），纯只读展示。

### 平均利用率

`nvidia-smi` / `npu-smi` / `hy-smi` 返回的是**瞬时利用率**。推理服务在请求间隙没有 kernel 在执行时，利用率就是 0%，但显存仍被模型进程占用——所以会出现“显存 88%、利用率 0%”的现象，不是统计错误。

插件按页面刷新间隔采样，并保留最近 **一个刷新间隔** 的样本做滚动平均：

- 默认刷新间隔 **60 秒**，平均计算也使用这 60 秒；
- 顶部刷新间隔支持 `5 秒 / 10 秒 / 30 秒 / 60 秒 / 手动 / 自定义秒数`，改一次即同时改变刷新和平均窗口；
- 点击“刷新”或到达刷新间隔都会重新采样并更新平均值；
- 初次加载立即采样，窗口未填满时按已有样本计算平均。

窗口内确实没有任何计算活动时，平均利用率仍会接近 0%。

## 服务器从哪来

| 来源 | 路径 | 说明 |
| --- | --- | --- |
| 手动添加 | 插件弹窗 | 支持密码 / 私钥，优先于同名主机 |
| 本机 | — | Node `os` + `fs.statfs`，Windows/Linux/macOS |
| OpenSSH 配置 | `~/.ssh/config` | 支持 `HostName` / `User` / `Port` / `IdentityFile` / `Host *` 默认值 / `Include`；`ProxyJump`、`ProxyCommand` 暂不实现 |

同一台机器（host + port 相同）只显示一张卡片；手动添加的记录优先。插件不读取 `~/.dsh/remote-workspaces/machines.json`，也不需要安装 dsh-remote。

### 为什么只看到几台服务器

`~/.ssh/config` 只提供地址、用户名、端口和密钥路径，**不保存密码**。如果某些主机没有配置 `IdentityFile`，也没有把公钥放进 ssh-agent / authorized_keys，认证就会失败；认证失败的主机默认被隐藏，所以看起来“只剩几台”。

排查：

1. 打开“添加服务器”弹窗，看“显示范围”里能列出多少台，以及哪些失败；
2. 在 `~/.ssh/config` 给主机加 `IdentityFile ~/.ssh/xxx`，或把密码主机在面板里手动添加；
3. 或者把配置里的 `hideAuthFailures` 设为 `false`，先把失败原因显示出来。

## 配置

在 profile 的 `cordis.yml` / `cordis.patch.yml` 里给这一行加 `config`：

```yaml
- id: dsh-resource-monitor
  name: dsh-resource-monitor
  config:
    refreshMs: 60000         # 建议的浏览器刷新间隔（毫秒），同时作为平均窗口
    cacheMs: 2500            # 服务端复用一次采集结果的时长
    errorCacheMs: 15000      # 失败主机的重试间隔
    waitMs: 1200             # 单次请求最多等多久，超时先返回“采集中”
    maxConcurrent: 6         # 同时拨号的 SSH 主机数
    commandTimeoutMs: 12000  # 单条远程命令超时
    connectTimeoutMs: 8000   # SSH 握手超时
    idleCloseMs: 120000      # 空闲连接回收时间
    hideAuthFailures: true   # 隐藏认证失败的主机
    includeSshConfig: true
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
lib/machines.js         解析本地 ~/.ssh/config（含 Host * 默认值与 Include）
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
