# daytasks

一个极简 markdown 记事本，基于 Tauri 2 + CodeMirror 6。纯文本编辑 + markdown 语法高亮，数据就是一个 `data.md` 文件，与 exe 同目录存放——整个应用文件夹就是你的全部数据，拷走即备份。

## 开发

```bash
npm install
npm run tauri dev
```

## 构建便携版

```bash
npm run tauri build
```

产物：`src-tauri/target/release/daytasks.exe`，绿色便携，拷到任何 Windows 10/11 机器（已带 WebView2）即可运行。首次启动会在 exe 同目录创建空白 `data.md`。

## 快捷键

| 按键 | 行为 |
| --- | --- |
| `Tab` / `Shift+Tab` | 整行缩进 / 取消缩进（有选区则作用于所有选中行，不插入 Tab 字符） |
| `Alt+↑` / `Alt+↓` | 上移 / 下移当前行（有选区则移动整个选区） |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+A` | 全选 |
| `Enter` | 列表行内回车自动延续 `- ` 前缀 |

## 数据与保存

- 文件位置：exe 同目录 `data.md`；不存在则创建空白文件，绝不覆盖已有内容
- 保存策略：停止输入 500ms 后自动写盘（原子写入：先写临时文件再 rename），关闭窗口前兜底保存
- 编码：UTF-8（加载时自动剥离 BOM）
- 单实例：重复启动只会唤起已打开的窗口，避免两个进程互相覆盖

## 技术要点

- 编辑器：CodeMirror 6（`@codemirror/lang-markdown` + GFM 扩展，软换行、行号、高亮当前行）
- 主题：跟随系统亮/暗模式
- Rust 侧仅两个 command：`load_file` / `save_file`，通过 `current_exe` 定位数据文件
