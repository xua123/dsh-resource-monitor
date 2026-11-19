# 插件市场索引

DSH 目前没有官方插件索引。本目录提供一份可直接使用的 **format 1** 索引：

```text
https://raw.githubusercontent.com/xua123/dsh-server-lens/main/market/index.json
```

## 用户如何安装

1. 打开 **插件 → 发现**（需要在实验性插件中启用自定义插件索引）；
2. 添加上述索引 URL；
3. 在列表中选择「服务器资源监控」并安装。

## 维护者如何更新

每次发布新版本后修改 `market/index.json`：

- `plugins[0].versions[0].version` 改成新版本号；
- `publishTimestamp` 改成发布时的 Unix 秒；
- 如果版本已发布到 npm，保持 `source.type: "npm"`；
- 如果只通过 Git 发布，改为：

```json
{
  "type": "git",
  "url": "https://github.com/xua123/dsh-server-lens.git",
  "commit": "<40 位 commit SHA>"
}
```

索引格式由 DSH 的 `@deepseek-ai/dsh-plugin-market-index` 校验；修改后建议用该包的 `parseMarketIndex` 验证。
