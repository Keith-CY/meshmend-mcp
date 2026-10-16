<p align="center"><img src="assets/icon.png" width="96" alt="MeshMend"></p>

<h1 align="center">MeshMend — MCP 服务器</h1>

<p align="center"><a href="README.md">English</a> · <b>中文</b></p>

在能调用本机工具的 AI 助手里检查和修复 3D 打印网格（STL 和 3MF）：Claude Desktop、Claude Code、Cursor、VS Code、Windsurf、Codex CLI、Gemini CLI，以及其他能启动本地 MCP 服务器的客户端。

问一句「`~/prints/bracket.stl` 是不是封闭的？」「切片软件说这个模型有破洞，怎么回事？」或「把这个 3MF 转成 STL」：助手在你的电脑上读取文件，说清楚哪里有问题（破洞、面朝向反了、壳体里外翻转、非流形边、重复三角形），如实告诉你自动修复能不能解决，再把修好的副本存到原文件旁边。

**文件不会离开你的电脑。** 服务器在本机运行，只读写你指定的文件，不发任何网络请求，没有统计。原文件永远不会被覆盖。它用的网格代码和免费网页工具 [mesh-mend.pages.dev](https://mesh-mend.pages.dev/) 完全相同。

```sh
npx -y github:Keith-CY/meshmend-mcp
```

> **状态：** 0.1.0 版。npm 发布还在等待；在那之前，`npx -y github:Keith-CY/meshmend-mcp`（需要 Node.js 18 以上和 git）运行的是同一份构建。Claude Desktop 用户可以从 [Releases](https://github.com/Keith-CY/meshmend-mcp/releases) 下载一键安装包。

## 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `check_mesh` | `path`、`unit?`（`mm`/`cm`/`in`，只用于 STL）、`item?`（3MF 的构建项） | 报告毫米尺寸、三角形和壳体数量、每一类问题的数量，并先在内存里试修一遍，给出结论：`ok`、`repairable`（可修）、`partly_repairable`（能修一部分）或 `needs_manual_review`（需要人工处理）。只读。 |
| `repair_mesh` | `path`、`fill_holes?`（默认 false）、`max_hole_span_mm?`（默认 20）、`output_path?`、`unit?`、`item?`、`overwrite?` | 删除重复面和零面积面，统一面的朝向，把里外翻转的壳体翻回来；需要时补上平面破洞。写出毫米单位的二进制 STL，并报告修复前后。 |
| `convert_3mf_to_stl` | `path`、`item?`、`output_path?`、`overwrite?` | 3MF 转二进制 STL（毫米），应用构建变换和单位，几何不变。 |

每个结果都同时给出可读文字和结构化 JSON（`structuredContent`，附 `outputSchema`）。`check_mesh` 标为只读；另外两个只新建文件（`destructiveHint: false`）。

**结果存在哪里：** 默认存在输入文件旁边，名为 `<文件名>.repaired.stl`（转换则是 `<文件名>.stl`），重名时依次用 `-2`、`-3`……，不替换任何已有文件。指定 `output_path` 时，已有文件只有在 `overwrite: true` 时才会被替换，而且输出永远不能是输入文件本身。

## 接入

### Claude Desktop

**一键安装：** 从 [Releases](https://github.com/Keith-CY/meshmend-mcp/releases) 下载 `meshmend-mcp-0.1.0.mcpb` 并打开（或 **设置 → 扩展 → 高级设置 → 安装扩展…**）。Claude Desktop 用自带的 Node.js 运行它。

**手动配置：** **设置 → 开发者 → 编辑配置**，在 `claude_desktop_config.json` 里加入：

```json
{
  "mcpServers": {
    "meshmend": {
      "command": "npx",
      "args": ["-y", "github:Keith-CY/meshmend-mcp"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add meshmend -- npx -y github:Keith-CY/meshmend-mcp
```

### Cursor

`~/.cursor/mcp.json`（或项目里的 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "meshmend": { "command": "npx", "args": ["-y", "github:Keith-CY/meshmend-mcp"] }
  }
}
```

### VS Code（GitHub Copilot）

`.vscode/mcp.json`：

```json
{
  "servers": {
    "meshmend": { "type": "stdio", "command": "npx", "args": ["-y", "github:Keith-CY/meshmend-mcp"] }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`：与 Cursor 相同的 `mcpServers` 配置。

### Codex CLI

`~/.codex/config.toml`：

```toml
[mcp_servers.meshmend]
command = "npx"
args = ["-y", "github:Keith-CY/meshmend-mcp"]
```

### Gemini CLI

`~/.gemini/settings.json`：

```json
{ "mcpServers": { "meshmend": { "command": "npx", "args": ["-y", "github:Keith-CY/meshmend-mcp"] } } }
```

### 其他客户端

任何能启动本地（stdio）服务器的 MCP 客户端都可以运行 `npx -y github:Keith-CY/meshmend-mcp`，或在克隆下来的仓库里运行 `node /path/to/meshmend-mcp/dist/meshmend-mcp.js`（这个文件没有任何依赖）。现成的配置文件在 [`examples/clients/`](examples/clients/)。

请给助手**绝对路径**（`~` 会被展开）。相对路径按服务器的工作目录解析，而桌面应用的工作目录往往不是你的项目文件夹。

## 真实文件：修复前后

来自本仓库的测试和一次本地运行（`npm test` 会重做除兔子和球体以外的全部例子）：

| 文件 | `check_mesh` 发现 | 结论 | `repair_mesh` 之后 |
|---|---|---|---|
| MeshMend 的示例方块，30 × 24 × 24 mm，19 个三角形（[`missing-patch.stl`](tests/fixtures/missing-patch.stl)） | 1 个破洞（4 条开放边）、3 处朝向冲突、1 个重复面 | 可修（需 `fill_holes`） | 封闭：删去重复面、统一朝向、用 2 个三角形补上 10 × 8 mm 的洞；共 20 个三角形 |
| trimesh 的 [`multibody.stl`](tests/fixtures/trimesh/)，32 个三角形 | 2 个里外翻转的壳体、12 处朝向冲突 | 可修 | 封闭且朝外 |
| 犹他茶壶（[`teapot.stl`](tests/fixtures/trimesh/)），894 个三角形 | 6 处开口（64 条开放边）、1 个非流形顶点 | 需要人工处理 | 不变，并说明原因：洞是曲面的，非流形顶点需要人来判断 |
| 一个 CAD 导出文件（[`featuretype.STL`](tests/fixtures/trimesh/)），3,476 个三角形 | 16 条开放接缝（576 条开放边） | 需要人工处理 | 不变：曲面之间的顶点没有完全重合，而 MeshMend 从不合并相近顶点 |
| 斯坦福兔子（`bun_zipper.ply` 转 STL，放大到 156 mm；未收入仓库） | 底部 5 处开口（223 条开放边），69,451 个三角形 | 需要人工处理 | 即使跨度放宽到 200 mm 也不变：扫描留下的洞不是平的 |
| 生成的 100 mm 球体，247,499 个三角形，3 个洞、249 个翻转面 | 3 处开口（13 条开放边）、744 处朝向冲突 | 能修一部分 | 朝向修正，补上 1 个平面洞；2 个曲面洞留待处理。约 10 秒 |

## 能修什么，不能修什么

能修：

- 重复面和零面积（退化）面；
- 普通共享边上不一致的面朝向（法线反了）；
- 里外翻转的封闭壳体（与其他壳体不重叠时）；
- 设 `fill_holes: true` 时：简单的平面破洞（3–128 个边界顶点），且包围盒对角线不超过 `max_hole_span_mm`。

**不能：**

- 合并相近顶点（只合并坐标完全相同的点），所以无法闭合曲面之间的接缝；
- 拆分非流形边或顶点、重新网格化或重建实体；
- 修复自相交、合并重叠零件，或检查壁厚、悬垂和支撑；
- 补曲面洞、嵌套开口或超过跨度的洞；
- 保证模型一定能打印。请在切片软件里检查结果。

有些开口是故意设计的，所以除非你要求，否则不补洞。`check_mesh` 会先在内存里试修一遍，所以在写出任何文件之前，它的结论就能说明 `repair_mesh` 到底有没有用。

**限制：** 每个文件 30 MiB、25 万个三角形（与网页版相同）。3MF 支持主构建、组件、变换、生产扩展的部件引用和单位；ZIP64、不支持的必需扩展、各部件单位不一致、只有 G-code 的文件会被拒绝并说明原因。颜色、材料和打印设置不会带进 STL。

## 隐私

MeshMend 的 MCP 服务器只在你的电脑上工作。它读取你或助手指定的文件，写出新的 STL 文件；不向任何地方发送数据，没有统计或遥测，也不留日志。你的 AI 助手会像看到其他工具的输出一样看到结果（数量、尺寸、文件路径和提示），适用该助手自己的隐私条款。

## 开发

```sh
npm install
npm test            # 构建 dist/，运行核心、文件和端到端测试（需要 Bun）
npm run pack:mcpb   # 把 Claude Desktop 安装包构建到 build/
node scripts/call.mjs check_mesh '{"path":"tests/fixtures/missing-patch.stl"}'
```

`src/core/` 是 MeshMend 的网格代码，原样复制自网站，所以两者给出的结果相同。`dist/meshmend-mcp.js` 是打包好的单个文件（已提交，所以 `npx github:` 不需要构建）；[`NOTICE`](NOTICE) 列出了打包进去的软件包及其许可证。

## 许可证

[MIT](LICENSE)。三个 trimesh 测试文件由其作者以 MIT 许可证发布（[详情](tests/fixtures/trimesh/README.md)）。

带 3D 预览和前后对比的网页版：**[mesh-mend.pages.dev](https://mesh-mend.pages.dev/)**。
