# daytasks

极简 markdown 记事本（Tauri 2 + CodeMirror 6），Windows 便携应用，打开即写，像纸和笔。

## 这是什么

- markdown 语法高亮（VSCode 风格），行号、软换行、主题可选亮 / 暗 / 跟随系统
- 自动保存：停止输入 500ms 写盘，关闭窗口前兜底保存
- 全部数据 = exe 同目录的一个 `data.md`
- 无工具栏、无统计、无网络，单实例运行

## 开发者

环境要求：Node.js 20+、Rust stable。

```bash
npm install          # 安装依赖
npm run tauri dev    # 开发模式（前端热重载）
npm run tauri build  # 构建发布版 exe（内部先跑 tsc + vite）
npm run build        # 仅构建前端
npm run icon         # 重新生成应用图标
```

- 产物：`src-tauri/target/release/daytasks.exe`
- 开发模式的 `data.md` 在 `src-tauri/target/debug/` 下，与正式数据隔离

## 用户

- 首次启动自动创建空白 `data.md`；直接打字，无需手动保存
- 备份 / 迁移：拷走 exe 整个文件夹
- 设置（字号、主题）存 exe 旁 `settings.json`，删除该文件即恢复默认

### 快捷键

| 按键 | 行为 |
| --- | --- |
| `Tab` / `Shift+Tab` | 整行缩进 / 取消缩进（不插入 Tab 字符） |
| `Alt+↑` / `Alt+↓` | 上移 / 下移当前行（有选区则移动整个选区） |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+A` | 全选 |
| `Enter` | 列表行内回车自动延续 `- ` 前缀 |
| `Ctrl+,` | 打开字号设置 |
| `Ctrl+=` / `Ctrl+-` | 放大 / 缩小字号（10–32px） |
| `Ctrl+0` | 字号重置为 16px |
