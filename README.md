# daytasks

极简 markdown 记事本（Tauri 2 + CodeMirror 6），Windows 便携应用，打开即写，像纸和笔。

## 这是什么

- markdown 语法高亮（VSCode 风格），行号、软换行、主题可选亮 / 暗 / 跟随系统
- 自动保存：停止输入 500ms 写盘，关闭窗口前兜底保存
- 多标签页：每个 `.md` 笔记对应一个标签页，标签页各自保留光标 / 选区 / 撤销历史
- 全部数据 = exe 同目录下的一叠 `*.md` 笔记文件（会话状态存 `settings.json`）
- 无工具栏、无统计、无网络，单实例运行

## 开发者

环境要求：Node.js 20+、Rust stable。

```bash
npm install          # 安装依赖
npm run tauri dev    # 开发模式（前端热重载）
npm run tauri build  # 构建发布版 exe（内部先跑 tsc + vite）
npm run build        # 仅构建前端
npm test             # 单元测试（node --test tests/）
npm run icon         # 重新生成应用图标（light + dark 两套）
```

- 产物：`src-tauri/target/release/daytasks.exe`
- 开发模式的笔记在 `src-tauri/target/debug/` 下，与正式数据隔离
- 单实例限制按构建类型隔离（见 `single_instance.rs`）：`npm run tauri dev` 的调试版可与日常使用的 release 版同时运行，互不抢占；dev 窗口标题带 `- dev` 后缀便于区分

## 用户

- 多笔记：`Ctrl+O` 打开文件列表，`Ctrl+N` 新建笔记，`Ctrl+W` 关闭当前标签页
- 只认 exe 所在目录**顶层**的 `*.md`（大小写不敏感），隐藏文件与临时文件不算；上次打开的标签页会在下次启动时恢复，全部关闭则显示提示页（应用不退出）
- 标签页标题不带 `.md` 后缀；**右键标签页可重命名**（已落盘文件会真正改名，未落盘的新笔记则只改保留名；重名 / 非法字符会被拒绝）；文件被外部删除时标签页标红加删除线，自动保存会拒写（不会悄悄重建文件），文件重新出现后自动恢复保存
- 关闭标签页 / 窗口时会先兜底保存；若文件已被删除且有未保存内容，会询问「重建文件并保存 / 关闭并丢弃 / 取消」
- 备份 / 迁移：拷走 exe 整个文件夹
- 设置（字号、主题、上次会话）存 exe 旁 `settings.json`，删除该文件即恢复默认

### 快捷键

| 按键 | 行为 |
| --- | --- |
| `Ctrl+O` | 打开文件面板（列出全部可打开的 `.md`，可输入过滤；已打开项带圆点，选中即切换） |
| `Ctrl+N` | 新建笔记 `Untitled.md`（重名自动递增为 `Untitled-1.md`…；先占名、输入内容后才落盘） |
| `Ctrl+W` | 关闭当前标签页（关完最后一个显示提示页，不退出） |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 下一个 / 上一个标签页 |
| `Ctrl+1`…`Ctrl+8` | 跳到第 1…8 个标签页；`Ctrl+9` 跳到最后一个 |
| `Tab` / `Shift+Tab` | 整行缩进 / 取消缩进（不插入 Tab 字符） |
| `Alt+↑` / `Alt+↓` | 上移 / 下移当前行（有选区则移动整个选区） |
| `Ctrl+←` / `Ctrl+→` | 光标按词移动（中文按词分词；macOS 上用 `Option+←/→`） |
| `Ctrl+Shift+←` / `Ctrl+Shift+→` | 按词扩展选区（中文按词分词；macOS 上用 `Option+Shift+←/→`） |
| `Ctrl+Backspace` / `Ctrl+Delete` | 按词删除（中文按词分词；macOS 上用 `Option+Backspace/Delete`） |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+A` | 全选 |
| `Enter` | 列表行内回车自动延续 `- ` 前缀 |
| `Ctrl+,` | 打开字号 / 主题设置 |
| `Ctrl+=` / `Ctrl+-` | 放大 / 缩小字号（10–32px） |
| `Ctrl+0` | 字号重置为 16px |

macOS 上同一组快捷键用 `Cmd` 触发；上表中标注的按词移动 / 选区 / 删除除外，macOS 用 `Option` 触发。
