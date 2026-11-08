import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const s = readFileSync(join(root, "apps/wt-desktop/ui/main.js"), "utf8");
const a = s.indexOf("const STATUS_TPL_EN = [");
const b = s.indexOf("];", a);
const code = s.slice(a, b + 2) + "; return STATUS_TPL_EN;";
const T = new Function(code)();

// 每条骨架给一个「中文样例 → 期望英文」，覆盖全部变量位置
const cases = [
  ["标签已改名为：新名", "Tab renamed: 新名"],
  ["标签顺序：A → B", "Tab order: A → B"],
  ["已填入 mock-ssh 的密码（本次运行记住的）", "Filled password for mock-ssh (this run only)"],
  ["已从保险库填入 mock-ssh 的密码", "Filled password for mock-ssh from vault"],
  ["sftp-1 是 sftp 会话，暂不支持", "sftp-1 is a sftp session, not supported yet"],
  ["已重命名：ok.txt", "Renamed: ok.txt"],
  ["已复制：ok.txt", "Copied: ok.txt"],
  ["已导出：C:/x.ini", "Exported: C:/x.ini"],
  ["已选 3 个会话（Ctrl+点击增减，右键可批量移动）", "3 sessions selected (Ctrl+click to toggle, right-click for bulk move)"],
  ["已移动 2 个会话", "Moved 2 sessions"],
  ["已删除 2 个会话", "Deleted 2 sessions"],
  ["已新建文件夹：logs", "Folder created: logs"],
  ["已重命名文件夹：logs2", "Folder renamed: logs2"],
  ["已保存会话 prod-db", "Session saved: prod-db"],
  ["已删除会话 old", "Session deleted: old"],
  ["已删除保险库条目 entry1", "Vault entry deleted: entry1"],
  ["已复制 18 字符", "Copied 18 chars"],
  ["已粘贴 17 字符", "Pasted 17 chars"],
  ["已下载到本地：C:/tmp/a.txt", "Downloaded to: C:/tmp/a.txt"],
  ["已打开 a.js（340 字节）", "Opened a.js (340 bytes)"],
  ["已保存 a.js（350 字节）", "Saved a.js (350 bytes)"],
  ['匹配 "abc"', 'Match: "abc"'],
  ["已按 gb18030 重新读取 gbk.txt", "Re-read gbk.txt as gb18030"],
  ["换行符已经是 CRLF", "Line endings already CRLF"],
  ["换行符已改成 LF（记得保存）", "Line endings changed to LF (remember to save)"],
  ["已生成 ed25519 密钥", "Generated ed25519 key"],
  ["键位冲突：Ctrl+K 已被「清屏」占用", "Key conflict: Ctrl+K is already used by 清屏"],
  ["已绑定 Ctrl+Alt+Q", "Bound: Ctrl+Alt+Q"],
  ["键位方案已导出：C:/km.json", "Keymap exported: C:/km.json"],
  ["自动刷新目录（窗口获得焦点）", "Auto-refreshed directory (窗口获得焦点)"],
  ["文件列表按 名称 排序", "File list sorted by 名称"],
  ["权限位要 0~777 的八进制数，收到「999」", "Permission must be octal 0-777, got 999"],
  ["已把 notes.txt 的权限改成 600", "Changed notes.txt permissions to 600"],
  ["已在当前终端切到 /var/log", "Changed to /var/log in current terminal"],
  ["已复制路径：/etc/hosts", "Path copied: /etc/hosts"],
  ["复制失败，路径是：/etc/hosts", "Copy failed, path is: /etc/hosts"],
  ["已下载到 C:/dl/a.txt", "Downloaded to C:/dl/a.txt"],
  ["已广播到 2 个会话", "Broadcast to 2 sessions"],
  ["已导出广播结果：C:/r.csv", "Broadcast results exported: C:/r.csv"],
  ["右侧显示：mock-ssh", "Right pane: mock-ssh"],
  ["自定义危险规则：3 条", "Custom danger rules: 3"],
  ["密钥已轮换（3 条，保险库仍解锁）", "Key rotated (3 entries, vault still unlocked)"],
  ["已忘掉 [127.0.0.1]:22", "Forgot: [127.0.0.1]:22"],
  ["已导入 2 套配色", "Imported 2 color schemes"],
  ["本地终端 shell：cmd（新建终端生效）", "Local shell: cmd (applies to new terminals)"],
  ["显示列：大小开", "Columns: size 开"],
  ["显示列：权限关", "Columns: permissions 关"],
  ["连接超时：30 秒（下一次建连生效）", "Connect timeout: 30 s (applies to next connection)"],
  ["keepalive 最多丢失：3 次", "keepalive max missed: 3"],
  ["已跳到「终端编码」", "Jumped to 终端编码"],
  ["终端编码：GBK", "Terminal encoding: GBK"],
  ["正在打开 2 个会话…", "Opening 2 sessions…"],
  ["广播目标 2 台", "Broadcast targets: 2"],
  ["广播目标 2 台（跳过 1 个非 SSH 会话）", "Broadcast targets: 2 (skipped 1 non-SSH session(s))"],
  ["已保存终端输出：C:/dl/a.txt", "Terminal output saved: C:/dl/a.txt"],
  ["保存终端输出失败：磁盘满", "Failed to save terminal output: 磁盘满"],
  ["已选中「prod-web」：填好密码后点「连接」", "Selected prod-web: fill in the password, then click Connect"],
  ["「关闭查找栏」现在没有可作用的对象", "Nothing for 关闭查找栏 to act on right now"],
  ["已生成打印内容：42 行", "Print content ready: 42 lines"],
];

let bad = 0;
for (const [zh, want] of cases) {
  let got = "(no match)";
  for (const [re, tpl] of T) {
    const m = re.exec(zh);
    if (m) {
      got = tpl.replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? "");
      break;
    }
  }
  if (got !== want) {
    bad += 1;
    console.log("FAIL", JSON.stringify(zh), "=>", JSON.stringify(got), "want", JSON.stringify(want));
  }
}
// 每条骨架都必须有一条对照：加了骨架却忘了给样例，等于这条没验过
if (cases.length !== T.length) {
  console.log("FAIL 骨架 " + T.length + " 条，但对照只有 " + cases.length + " 条——每条都要有中文样例");
  bad += 1;
}
console.log("skeletons=" + T.length + " tested=" + cases.length + " bad=" + bad);
process.exit(bad ? 1 : 0);
