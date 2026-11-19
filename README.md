# 服务器资源监控（dsh-server-resource-monitor）

在 DeepSeek Harness 左侧栏和会话工作区中查看本机与 SSH 服务器的实时资源：CPU、内存、磁盘、网络，以及 NVIDIA GPU / 华为昇腾 NPU / 海光 DCU 的利用率、显存、功耗和占用进程。

![服务器资源监控](docs/preview.png)

## 两种使用入口

### 全局服务器资源

点击左侧栏的服务器图标，打开全局监控面板。

- 展示本机 + `~/.ssh/config` + 面板手动添加的全部服务器；
- 顶部汇总在线数量、算力卡数量、显存总量和异常提醒；
- 支持搜索、按类型/标签筛选、卡片/列表视图；
- 默认按**剩余显存**从大到小排序，本机固定第一；
- 可切换 CPU、内存、显存平均利用率排序，选择会记住。

### 会话 / 工作区服务器资源

在会话标签栏打开「服务器资源」页签。

- 读取当前会话的 DSH 会话元数据（`cwd`），自动识别该会话链接的服务器；
- 远程工作区镜像路径会匹配 `~/.ssh/config` 的 `HostName`；
- 只显示当前会话对应的那一台服务器，不受全局筛选/隐藏/认证失败隐藏影响；
- 识别不到时可用右上角下拉手动选择；
- 不读取 dsh-remote 的 `machines.json` 或镜像元数据。

## 显示的资源

| 类别 | 内容 |
| --- | --- |
| CPU | 使用率、核心数、型号、1/5/15 分钟负载 |
| 内存 | 已用 / 总量、占用率、Swap |
| 磁盘 | 根分区及各挂载点容量、已用 / 总量、峰值分区 |
| 网络 | 实时收/发速率 |
| 系统 | 主机名、系统版本、内核、运行时间、SSH 延迟 |
| 容器 | 容器内 CPU / 内存 limit（检测到容器时） |
| NVIDIA GPU | 型号、利用率、显存、温度、功耗 / 上限、Compute Capability |
| 华为昇腾 NPU | 型号、AICore 利用率、显存、温度、功耗；兼容 310P3 / 910B |
| 海光 DCU | 型号、利用率、VRAM、温度、功耗；兼容 `hy-smi` JSON/表格 |
| 算力卡进程 | 每张卡的 PID、服务名、显存占用、占卡比例 |
| 进程 | 按需加载，支持搜索、排序、迷你进度条 |
| 镜像 / 容器详情 | 镜像列表、运行中容器、已停止容器；支持容器启停/重启、镜像删除 |

每张算力卡显示：

- **平均利用率**：默认按刷新间隔做滚动平均，避免推理服务 burst 导致长期显示 0%；
- **功耗**：实际 / 上限（W），例如 `59 W / 250 W`；
- **显存**：已用 / 总量 + 占卡比例进度条。

## 进程查看与终止

点击在线服务器卡片打开右侧「占用详情」：

- **进程详情**：按 CPU 排序的系统进程；
- **显存详情**：算力卡上占用显存的进程；
- 服务名优先取 systemd unit / 脚本名，例如 `llama-server`、`vllm`、`hexocr`，不显示裸 PID 占位；
- 每行提供「终止」按钮，弹出二次确认后发送 `SIGTERM`；
- 只允许终止当前详情列表中存在的 PID；
- 权限不足、进程已退出等失败原因会直接显示。

## 镜像与容器

「占用详情 → 镜像 / 容器详情」按三块展示；三块默认收起，点击分组标题展开：

1. **镜像列表**：镜像名:Tag、ID、大小、创建时间，支持删除；
2. **运行中容器**：名称、镜像、状态、端口，支持停止/重启；
3. **已停止容器**：名称、镜像、状态、端口，支持启动。

容器以卡片展示，操作按钮紧凑并右对齐；端口映射直接显示；使用 `host` 网络的容器会标注“使用宿主端口”，未映射也会提示。每张容器卡片右侧有「详情」文字按钮，点击展开启动参数（自动刷新时保持展开，不会自动收起）：完整 ID、镜像、Entrypoint/Cmd、环境变量（密码/Token 等敏感值自动隐藏）、工作目录/运行用户、特权模式、CapAdd、设备、Runtime、内存/CPU 限制、状态/退出码、创建/启动/结束时间、重启策略、网络模式与 IP、端口、挂载目录。启动（绿）、停止（橙）、重启（蓝）、删除（红）按钮颜色区分。

容器启停、重启和镜像删除都会弹出确认框，失败原因（权限不足、镜像被容器占用、容器不存在等）直接显示。Docker 不可用或无权限时显示提示，不影响其他资源。

## 安装

### 从 GitHub 安装

1. 打开 **设置 → 插件 → 安装**；
2. 填入仓库地址：

```text
https://github.com/xua123/dsh-resource-monitor
```

3. 安装后**完全退出 DSH**（托盘 Quit），再重新启动。

### 从 npm 安装

```bash
dsh plugin --profile desktop add dsh-server-resource-monitor
```

### 本地 tgz

```bash
dsh plugin --profile desktop add file:/absolute/path/to/dsh-server-resource-monitor-0.9.6.tgz
```

要求：DSH `>= 0.2.1-rc.1`，Node `>= 20`。

## 快速开始

1. 在 `~/.ssh/config` 配置服务器，推荐使用密钥：

```sshconfig
Host gpu-01
  HostName 192.0.2.20
  User ml
  IdentityFile ~/.ssh/id_ed25519
```

2. 重启 DSH，点击左侧栏服务器图标；
3. 需要密码认证的服务器，在面板「添加服务器」里手动添加；
4. 工作区页签会自动绑定当前会话的服务器，也可手动选择。

## 配置

在 profile 的 `cordis.yml` / `cordis.patch.yml` 中：

```yaml
- id: dsh-server-resource-monitor
  name: dsh-server-resource-monitor
  config:
    refreshMs: 60000       # 刷新间隔，同时作为平均利用率窗口
    cacheMs: 2500          # 服务端快照缓存
    waitMs: 800            # 首次请求最多等待时间
    maxConcurrent: 6       # 并发 SSH 数
    commandTimeoutMs: 12000
    connectTimeoutMs: 8000
    idleCloseMs: 120000
    hideAuthFailures: true
    includeSshConfig: true
    sshConfigFile: ''      # 默认 ~/.ssh/config
    ignoreHosts: []
    hostKeyPolicy: tofu    # tofu | off
    showLocal: true
```

## 服务器来源

| 来源 | 说明 |
| --- | --- |
| 本机 | Node `os` + `fs.statfs` |
| `~/.ssh/config` | `HostName`、`User`、`Port`、`IdentityFile`、`Host *`、`Include` |
| 手动添加 | 支持密码 / 私钥，优先于同名主机 |

同一 `host:port` 只显示一张卡片。插件**不依赖 dsh-remote**，不读取其注册表。

## 权限与安全

- 日常采集只执行只读命令（`/proc`、`df`、`nvidia-smi`、`npu-smi`、`hy-smi` 等），不写远程文件；
- 终止进程只允许当前详情列表中的 PID，需要页面 token，并二次确认；
- 只发送 `SIGTERM`，不执行 `kill -9`；
- 手动添加的密码以明文保存在 `~/.dsh/server-monitor/targets.json`（权限 `0600`）；介意明文请使用密钥；
- 隐藏列表、别名、选择范围保存在 `~/.dsh/server-monitor/`，权限 `0600`。

## 已知限制

- 远程采集面向 Linux；Windows 仅支持本机；
- `ProxyJump` / `ProxyCommand` 暂不生效；
- DCGM exporter / Prometheus 不是必需依赖；
- NPU / DCU 的功耗上限取决于厂商工具是否提供，没有上限时只显示实际功耗；
- 工作区自动识别依赖会话元数据中的 `cwd`，识别不到时请手动选择服务器。

## 插件市场

DSH 当前**没有官方插件索引**，因此没有集中“申请收录”的入口。收录方式是发布一份 **format 1 插件市场索引 JSON**，用户把索引 URL 加到「插件 → 发现」中。

本仓库自带索引：

```text
https://raw.githubusercontent.com/xua123/dsh-resource-monitor/main/market/index.json
```

使用方式：

1. 打开 **插件 → 发现**；
2. 添加上面的索引 URL；
3. 在列表中选择「服务器资源监控」安装。

索引条目使用 npm 版本 `0.9.6`；发布到 npm 后即可通过市场安装。若你维护第三方 DSH 插件索引，也可以把 `market/index.json` 里的条目合并进去。

## 开发

```bash
npm install
npm test
npm pack
```

发布新版本：

```bash
npm version patch
git push --follow-tags
```

GitHub 上发布 Release 后，`.github/workflows/publish.yml` 会自动发布到 npm（需要仓库 secret `NPM_TOKEN`）。

## License

MIT
