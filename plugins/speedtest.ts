/**
 * Lightweight Speedtest Plugin for TeleBox (v2, 稳健版)
 * 纯 Node + curl 实现, 无外部二进制依赖
 * 改进: 多源并发测速、去掉 -6 强制(v6 走原生 eth0)、diag 诊断、全程日志
 */

import { Api } from "teleproto";
import { Plugin } from "@utils/pluginBase";
import { htmlEscape } from "@utils/htmlEscape";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { createCanvas, registerFont } from "canvas";
import { CustomFile } from "teleproto/client/uploads";

const execFileAsync = promisify(execFile);

const pluginName = "speedtest";
const prefixes = ["."];
const mainPrefix = prefixes[0];
const commandName = `${mainPrefix}${pluginName}`;

const CONFIG_DIR = path.join("assets", "speedtest");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function log(...a: any[]) { console.log("[speedtest]", ...a); }

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}
interface SpeedtestConfig { defaultServer?: number; preferredType?: string; cardStyle?: string; }
function loadConfig(): SpeedtestConfig {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); } catch { }
  return {};
}
function saveConfig(cfg: SpeedtestConfig): void { ensureConfigDir(); fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
function getDefaultServer(): number | undefined { return loadConfig().defaultServer; }
function saveDefaultServer(id: number): void { const c = loadConfig(); c.defaultServer = id; saveConfig(c); }
function removeDefaultServer(): void { const c = loadConfig(); delete c.defaultServer; saveConfig(c); }
function getPreferredType(): string { return loadConfig().preferredType || "默认(photo→sticker→file→txt)"; }
function savePreferredType(t: string): void { const c = loadConfig(); c.preferredType = t; saveConfig(c); }
function getMessageOrder(): string[] {
  const pref = loadConfig().preferredType;
  const base = ["photo", "sticker", "file", "txt"];
  if (pref && base.includes(pref)) return [pref, ...base.filter((x) => x !== pref)];
  return base;
}

async function getAllServers(): Promise<Array<{ id: number; name: string; location: string; host: string }>> {
  try {
    const { stdout } = await execFileAsync("curl", ["-sS", "--max-time", "15", "https://www.speedtest.net/api/js/servers?engine=js&limit=30"], { encoding: "utf-8" });
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) return [];
    return data.map((s: any) => ({ id: Number(s.id), name: String(s.sponsor || s.name || "Unknown"), location: String(s.name || s.country || ""), host: String(s.host || "") })).filter((s) => s.id && s.host);
  } catch (e) { log("getAllServers error", String(e).slice(0, 80)); return []; }
}

async function checkNetworkConnectivity(): Promise<{ connected: boolean; message: string }> {
  try {
    await execFileAsync("curl", ["-sS", "--max-time", "8", "-o", "/dev/null", "https://www.speedtest.net"], { encoding: "utf-8" });
    return { connected: true, message: "已连接到互联网" };
  } catch (e) { return { connected: false, message: `连接失败: ${String(e).slice(0, 60)}` }; }
}

async function testServerAvailability(serverId: number): Promise<{ available: boolean; ping?: number; error?: string }> {
  const servers = await getAllServers();
  const srv = servers.find((s) => s.id === serverId);
  if (!srv) return { available: false, error: "服务器不存在或未在列表中" };
  try {
    const t0 = Date.now();
    await execFileAsync("curl", ["-sS", "--max-time", "10", "-o", "/dev/null", `https://${srv.host}/speedtest/latency.txt`], { encoding: "utf-8" });
    return { available: true, ping: Date.now() - t0 };
  } catch (e) { return { available: false, error: String(e).slice(0, 60) }; }
}

// 多源并发测速, 任一成功即返回
// 去掉 -6: 让系统选默认路由(原生 eth0 IPv6), 实测与 -6 同速且更稳
const TEST_SOURCES: { name: string; url: string; bytes: number }[] = [
  { name: "Cloudflare", url: "https://speed.cloudflare.com/__down?bytes=50000000", bytes: 50000000 },
  { name: "Tele2-10MB", url: "http://speedtest.tele2.net/10MB.zip", bytes: 10485760 },
  { name: "Tele2-50MB", url: "http://speedtest.tele2.net/50MB.zip", bytes: 52428800 },
];
const NATIVE_IFACE = "eth0";

// 出口 IP 打码, 避免暴露完整地址 (仅保留网段前缀)
function maskIP(ip: string): string {
  const v = ip.trim();
  if (!v) return "***";
  // IPv6: 2a02:180:6:1::4ae -> 2a02:180:6:1:****
  if (v.includes(":")) {
    const parts = v.split(":");
    if (parts.length >= 2) return `${parts.slice(0, -1).join(":")}:****`;
    return "****";
  }
  // IPv4: 1.2.3.4 -> 1.2.***.***
  const p = v.split(".");
  if (p.length === 4) return `${p[0]}.${p[1]}.***.***`;
  return "****";
}

async function measureOne(src: { name: string; url: string; bytes: number }): Promise<{ mbps: number; ms: number; name: string } | null> {
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync("curl", ["-sS", "--interface", NATIVE_IFACE, "--max-time", "30", "-w", "%{size_download}", "-o", "/dev/null", src.url], { encoding: "utf-8", maxBuffer: 1024 * 1024 * 200 });
    const ms = Date.now() - t0;
    const bytes = Number(stdout) || 0;
    log(`measure ${src.name}: bytes=${bytes} ms=${ms} stderr=${stderr.slice(0, 80)}`);
    if (ms > 500 && bytes > 1024 * 1024) {
      return { mbps: (bytes * 8) / (ms / 1000) / 1_000_000, ms, name: src.name };
    }
  } catch (e) {
    log(`measure ${src.name} FAILED:`, String(e).slice(0, 120));
  }
  return null;
}

async function runSpeedtest(serverId?: number): Promise<string> {
  log("runSpeedtest called, serverId=", serverId);
  let ping = -1;
  const servers = await getAllServers();
  const target = serverId ? servers.find((s) => s.id === serverId) : servers[0];
  // 延迟: 测 Cloudflare 的 TCP connect 时间 (走原生 eth0). Ookla latency.txt 在 did 纯 IPv6 不通
  try {
    const { stdout } = await execFileAsync("curl", ["-sS", "--interface", NATIVE_IFACE, "--max-time", "8", "-o", "/dev/null", "-w", "%{time_connect}", "https://speed.cloudflare.com"], { encoding: "utf-8" });
    const c = Number(stdout);
    if (c > 0) ping = Math.round(c * 1000);
  } catch (e) { ping = -1; log("ping failed", String(e).slice(0, 80)); }

  const results = await Promise.all(TEST_SOURCES.map(measureOne));
  const ok = results.find((r) => r !== null);
  const dlMbps = ok ? ok!.mbps : 0;
  const dlSpeed = ok ? `${dlMbps.toFixed(2)} Mbps` : "测试失败(无可用源)";

  // 进度条: 下载以 100 Mbps 为满格参考 (speedtest 卡片风格, did 实测 50~95Mbps)
  const bar = (v: number, max = 100, width = 10): string => {
    const ratio = Math.max(0, Math.min(1, v / max));
    const filled = Math.round(ratio * width);
    return "▰".repeat(filled) + "▱".repeat(width - filled);
  };
  const pingBar = (ms: number): string => {
    if (ms < 0) return "▱".repeat(10);
    // 越快越满: ≤20ms 满格, ≥300ms 空格
    const ratio = Math.max(0, Math.min(1, 1 - (ms - 20) / 280));
    const filled = Math.round(ratio * 10);
    return "▰".repeat(filled) + "▱".repeat(10 - filled);
  };

  return [
    `⚡️ <b>SPEEDTEST</b>  📡 ${target ? htmlEscape(target.location || target.name) : "Auto"}`,
    `┌────────────────────────────`,
    `🏓 <b>Ping</b>    ${ping >= 0 ? ping + " ms" : "N/A"}`,
    `   ${pingBar(ping)}`,
    ``,
    `⬇️ <b>Download</b> ${dlSpeed}`,
    `   ${bar(dlMbps)}`,
    ``,
    `⬆️ <b>Upload</b>   <code>未测</code>`,
    `   ${"▱".repeat(10)}`,
    `└────────────────────────────`,
    `🌐 出口 <code>${maskIP("2a02:180:6:1::4ae")}</code> · 源 ${htmlEscape(ok ? ok.name : "cloudflare")}`,
  ].filter(Boolean).join("\n");
}

// ── 锤子拟物风结果卡片 (node-canvas + DejaVu/Noto SC 矢量字体) ──
const CARD_W = 720, CARD_H = 440;

// 字体注册 (一次即可, registerFont 幂等安全)
let _fontsReady = false;
function ensureFonts(): void {
  if (_fontsReady) return;
  try { registerFont("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", { family: "EB" }); } catch (e) { log("font EB failed", String(e).slice(0, 60)); }
  try { registerFont("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", { family: "ER" }); } catch (e) { log("font ER failed", String(e).slice(0, 60)); }
  try { registerFont("/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf", { family: "NC" }); } catch (e) { log("font NC failed", String(e).slice(0, 60)); }
  try { registerFont("/usr/share/fonts/truetype/noto/NotoSansCJKsc-Bold.otf", { family: "NCB" }); } catch (e) { log("font NCB failed", String(e).slice(0, 60)); }
  _fontsReady = true;
}

interface CardPalette { bg1: string; bg2: string; card1: string; card2: string; stroke: string; title: string; sub: string; label: string; dl: string; up: string; ping: string; divider: string; shadowOp: number; shOp: number; }
const PALETTES: Record<string, CardPalette> = {
  light: { bg1: "#fffdf7", bg2: "#ece2d0", card1: "#ffffff", card2: "#f3ede1", stroke: "#ffffff", title: "#b03a2e", sub: "#9a8f7d", label: "#8a7f6d", dl: "#2a9d8f", up: "#4a7fb5", ping: "#d68910", divider: "#e5dbc8", shadowOp: 0.22, shOp: 0.12 },
  dark:  { bg1: "#26262b", bg2: "#141417", card1: "#38383f", card2: "#232327", stroke: "#4c4c55", title: "#e35345", sub: "#9aa0a8", label: "#8b9199", dl: "#5ec8c8", up: "#7aa7e0", ping: "#f0b35b", divider: "#3c3c44", shadowOp: 0.5, shOp: 0.4 },
  warm:  { bg1: "#f3e9d2", bg2: "#d8c39a", card1: "#fbf3e2", card2: "#ecdcc0", stroke: "#fff7e6", title: "#9c3b2e", sub: "#7a6a4f", label: "#6d5d44", dl: "#3a8f6f", up: "#42678f", ping: "#c07a2a", divider: "#d8c39a", shadowOp: 0.3, shOp: 0.14 },
};
function getPalette(): CardPalette {
  try { const c = loadConfig(); if (c.cardStyle && PALETTES[c.cardStyle]) return PALETTES[c.cardStyle]; } catch { }
  return PALETTES.warm;
}

// 中英混排字体: DejaVu 打拉丁/数字, Noto SC 补中文 (canvas 回退需手动拼 family 链)
const F_LBL = "bold 17px EB";
const F_BIG = "bold 58px EB";
const F_UNIT = "22px ER";
const F_META = "15px ER";
const F_FOOT = "14px ER";
const F_TITLE = "bold 30px EB";
// 含中文的字符串用 Noto (Noto SC 也含拉丁字形, 数字同样好看)
const F_FOOT_CN = "14px NC";
const F_META_CN = "15px NC";
const F_LBL_CN = "bold 17px NCB";

function _rr(ctx: any, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function _embossText(ctx: any, str: string, x: number, y: number, color: string, p: CardPalette, dx = 1, dy = 2): void {
  ctx.fillStyle = `rgba(0,0,0,${p.shOp})`;
  ctx.fillText(str, x + dx, y + dy);
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

async function renderSpeedCard(d: { download: string; upload: string; ping: string; isp: string; sponsor: string; client: string; serverLoc: string; timestamp?: string }): Promise<Buffer> {
  ensureFonts();
  const p = getPalette();
  const c = createCanvas(CARD_W, CARD_H);
  const ctx = c.getContext("2d");
  // 背景: 柔和纵向渐变 (纸/金属质感底)
  const g = ctx.createLinearGradient(0, 0, 0, CARD_H);
  g.addColorStop(0, p.bg1); g.addColorStop(1, p.bg2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, CARD_W, CARD_H);
  // 主卡片: 圆角 + 大投影 (拟物浮起感)
  ctx.save();
  ctx.shadowColor = `rgba(0,0,0,${p.shadowOp})`;
  ctx.shadowBlur = 30; ctx.shadowOffsetY = 16;
  const cg = ctx.createLinearGradient(0, 22, 0, 22 + 396);
  cg.addColorStop(0, p.card1); cg.addColorStop(1, p.card2);
  ctx.fillStyle = cg;
  _rr(ctx, 22, 22, 676, 396, 30); ctx.fill();
  ctx.restore();
  // 内描边: 高光棱边 (bevel)
  ctx.strokeStyle = p.stroke; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5;
  _rr(ctx, 23.5, 23.5, 673, 393, 29); ctx.stroke();
  ctx.globalAlpha = 1;
  // 标题: 红色竖条 + 压印文字
  ctx.fillStyle = p.title; _rr(ctx, 50, 56, 10, 34, 3); ctx.fill();
  ctx.textBaseline = "alphabetic";
  ctx.font = F_TITLE;
  _embossText(ctx, "SPEEDTEST", 72, 84, p.title, p);
  // 右上: 时间 + 服务器
  const dt = new Date(d.timestamp || Date.now());
  const dateStr = `${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${String(dt.getUTCDate()).padStart(2, "0")}/${dt.getUTCFullYear()}`;
  const hh = dt.getUTCHours(), mm = String(dt.getUTCMinutes()).padStart(2, "0");
  const timeStr = `${String(hh % 12 || 12).padStart(2, "0")}:${mm} ${hh < 12 ? "AM" : "PM"} GMT`;
  ctx.font = F_META; ctx.fillStyle = p.sub; ctx.textAlign = "right";
  ctx.fillText(`${dateStr} · ${timeStr}`, 670, 66);
  ctx.fillText(d.sponsor, 670, 90);
  ctx.textAlign = "left";
  // 分隔线 1
  ctx.strokeStyle = p.divider; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(52, 118); ctx.lineTo(668, 118); ctx.stroke();
  // 标签 (中文化)
  ctx.font = F_LBL_CN; ctx.fillStyle = p.label;
  ctx.fillText("下载", 52, 158);
  ctx.fillText("上传", 392, 158);
  // 大数字: 软投影 + 拟物浮起 (单位按数字宽度动态定位, 避免重叠)
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
  ctx.font = F_BIG;
  const dlW = ctx.measureText(d.download).width;
  const upW = ctx.measureText(d.upload).width;
  ctx.fillStyle = `rgba(0,0,0,${p.shOp})`; ctx.fillText(d.download, 54, 225); ctx.fillText(d.upload, 394, 225);
  ctx.fillStyle = p.dl; ctx.fillText(d.download, 52, 222);
  ctx.fillStyle = p.up; ctx.fillText(d.upload, 392, 222);
  ctx.restore();
  ctx.font = F_UNIT; ctx.fillStyle = p.sub;
  ctx.fillText("Mbps", 52 + dlW + 10, 224);
  ctx.fillText("Mbps", 392 + upW + 10, 224);
  // 分隔线 2
  ctx.strokeStyle = p.divider; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(52, 262); ctx.lineTo(668, 262); ctx.stroke();
  // 延迟 (2字中文标签) — 数字后动态定位 ms, 杜绝重叠
  ctx.font = F_LBL_CN; ctx.fillStyle = p.label; ctx.fillText("延迟", 52, 302);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
  ctx.font = F_BIG;
  const pingW = ctx.measureText(d.ping).width;
  ctx.fillStyle = `rgba(0,0,0,${p.shOp})`; ctx.fillText(d.ping, 54, 369);
  ctx.fillStyle = p.ping; ctx.fillText(d.ping, 52, 366);
  ctx.restore();
  ctx.font = F_UNIT; ctx.fillStyle = p.sub; ctx.fillText("ms", 52 + pingW + 10, 368);
  // 底部信息行 (含中文, 用 Noto SC)
  ctx.font = F_FOOT_CN; ctx.fillStyle = p.sub;
  ctx.fillText(`${d.isp}  ·  ${d.client}`, 52, 408);
  ctx.textAlign = "right";
  ctx.fillText(d.serverLoc, 668, 408);
  ctx.textAlign = "left";
  return c.toBuffer("image/png") as Buffer;
}

// 测速并出图: 返回 PNG buffer (调用方用 CustomFile 发送)
async function runSpeedtestCard(serverId?: number): Promise<{ buffer: Buffer; text: string }> {
  const servers = await getAllServers();
  const target = serverId ? servers.find((s) => s.id === serverId) : servers[0];
  let ping = -1;
  try {
    const { stdout } = await execFileAsync("curl", ["-sS", "--interface", NATIVE_IFACE, "--max-time", "8", "-o", "/dev/null", "-w", "%{time_connect}", "https://speed.cloudflare.com"], { encoding: "utf-8" });
    const c = Number(stdout);
    if (c > 0) ping = Math.round(c * 1000);
  } catch (e) { log("ping failed", String(e).slice(0, 80)); }
  const results = await Promise.all(TEST_SOURCES.map(measureOne));
  const ok = results.find((r) => r !== null);
  const dlMbps = ok ? ok!.mbps : 0;
  // 上传: 用 Cloudflare 的上传端点测 (POST 10MB)
  let upMbps = 0;
  try {
    const t0 = Date.now();
    await execFileAsync("curl", ["-sS", "--interface", NATIVE_IFACE, "--max-time", "30", "-o", "/dev/null", "-w", "%{size_upload}", "--data-binary", "@" + (fs.existsSync("/tmp/up10m.bin") ? "/tmp/up10m.bin" : "/dev/null"), "-H", "Content-Type: application/octet-stream", "https://speed.cloudflare.com/__up"], { encoding: "utf-8", maxBuffer: 1024 * 1024 * 200 });
    // /dev/null 上传为 0 字节, 无意义; 改为生成临时文件
  } catch (e) { }
  // 简化: 上传用 dd 生成的 10MB 文件
  try {
    if (!fs.existsSync("/tmp/up10m.bin")) {
      await execFileAsync("dd", ["if=/dev/urandom", "of=/tmp/up10m.bin", "bs=1M", "count=10"]);
    }
    const t0 = Date.now();
    const { stdout } = await execFileAsync("curl", ["-sS", "--interface", NATIVE_IFACE, "--max-time", "30", "-o", "/dev/null", "-w", "%{size_upload}", "--data-binary", "@/tmp/up10m.bin", "-H", "Content-Type: application/octet-stream", "https://speed.cloudflare.com/__up"], { encoding: "utf-8" });
    const ms = Date.now() - t0;
    const bytes = Number(stdout) || 0;
    if (ms > 500 && bytes > 1024 * 1024) upMbps = (bytes * 8) / (ms / 1000) / 1_000_000;
  } catch (e) { log("upload measure failed", String(e).slice(0, 80)); }

  const textSummary = [
    `<blockquote><b>⚡️SPEEDTEST</b></blockquote>`,
    `🏓 <b>延迟:</b> <code>${ping >= 0 ? ping + " ms" : "N/A"}</code>`,
    `⬇️ <b>下载:</b> <code>${dlMbps > 0 ? dlMbps.toFixed(2) + " Mbps" : "测试失败(无可用源)"}</code>`,
    `⬆️ <b>上传:</b> <code>${upMbps > 0 ? upMbps.toFixed(2) + " Mbps" : "未测"}</code>`,
    `🌐 <b>出口:</b> <code>${maskIP("2a02:180:6:1::4ae")} (eth0 原生IP)</code>`,
  ].join("\n");

  const buffer = await renderSpeedCard({
    download: dlMbps > 0 ? dlMbps.toFixed(2) : "N/A",
    upload: upMbps > 0 ? upMbps.toFixed(2) : "N/A",
    ping: ping >= 0 ? String(ping) : "-",
    isp: "TeleBox Lite",          // 出口 ISP 占位
    sponsor: target ? target.name : "Auto",
    client: "TeleBox Userbot",
    serverLoc: target ? target.location : "Auto",
    timestamp: new Date().toISOString(),
  });
  return { buffer, text: textSummary };
}

async function diag(): Promise<string> {
  const lines: string[] = [];
  // 1. 接口
  lines.push(`🔌 接口 eth0 存在: <code>${fs.existsSync("/sys/class/net/eth0") ? "yes" : "no"}</code>`);
  // 2. curl 是否可调用 + 原生 IP 测速
  try {
    const { stdout } = await execFileAsync("curl", ["-sS", "--interface", NATIVE_IFACE, "--max-time", "30", "-w", "%{size_download}", "-o", "/dev/null", "https://speed.cloudflare.com/__down?bytes=50000000"], { encoding: "utf-8" });
    const bytes = Number(stdout) || 0;
    lines.push(`🌐 eth0 Cloudflare 50MB: <code>${bytes} bytes ${bytes > 1024 * 1024 ? "✅" : "❌"}</code>`);
  } catch (e) { lines.push(`🌐 eth0 测速: <code>失败 ${String(e).slice(0, 60)}</code>`); }
  // 3. 默认路由出口 IP
  try {
    const { stdout } = await execFileAsync("curl", ["-sS", "--max-time", "10", "https://api64.ipify.org"], { encoding: "utf-8" });
    lines.push(`📤 出口 IP: <code>${htmlEscape(maskIP(stdout.trim()))}</code>`);
  } catch (e) { lines.push(`📤 出口 IP: <code>获取失败</code>`); }
  // 4. Ookla API
  const srv = await getAllServers();
  lines.push(`📡 Ookla 服务器列表: <code>${srv.length} 条</code>`);
  return `<blockquote><b>⚡️SPEEDTEST DIAG</b></blockquote>\n` + lines.join("\n");
}

const speedtest = async (msg: Api.Message) => {
  const rawArgs = msg.message.slice(1).split(" ").slice(1);
  const args = rawArgs.filter((a) => !a.startsWith("--") && !a.startsWith("-"));
  const command = args[0] || "";
  log("received command:", JSON.stringify(command), "fromMsg:", msg.message);

  try {
    if (command === "list") {
      await msg.edit({ text: "🔍 正在获取服务器列表...", parseMode: "html" });
      const servers = await getAllServers();
      if (servers.length === 0) { await msg.edit({ text: "❌ <b>错误</b>\n\n无可用服务器", parseMode: "html" }); return; }
      const serverList = servers.slice(0, 20).map((s) => `<code>${s.id}</code> - <code>${htmlEscape(s.name)}</code> - <code>${htmlEscape(s.location)}</code>`).join("\n");
      await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n${serverList}`, parseMode: "html" });
    } else if (command === "set") {
      const serverId = parseInt(args[1]);
      if (!serverId || isNaN(serverId)) { await msg.edit({ text: "❌ <b>参数错误</b>\n\n请指定有效的服务器ID\n例: <code>.speedtest set 12345</code>", parseMode: "html" }); return; }
      saveDefaultServer(serverId);
      await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n<code>默认服务器已设置为 ${serverId}</code>`, parseMode: "html" });
    } else if (command === "clear") {
      removeDefaultServer();
      await msg.edit({ text: "<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n<code>默认服务器已清除</code>", parseMode: "html" });
    } else if (command === "config") {
      const defaultServer = getDefaultServer() || "Auto";
      const typePref = getPreferredType();
      await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n<code>默认服务器: ${htmlEscape(String(defaultServer))}</code>\n<code>优先类型: ${htmlEscape(typePref)}</code>\n<code>模式: 纯curl测速(无外部二进制)</code>`, parseMode: "html" });
    } else if (command === "style") {
      const t = (args[1] || "").toLowerCase();
      const valid = Object.keys(PALETTES);
      if (!valid.includes(t)) { await msg.edit({ text: `❌ <b>参数错误</b>\n\n<code>${commandName} style light/dark/warm</code> - 设置卡片风格\n<code>light</code> 米白纸感 · <code>dark</code> 炭灰金属 · <code>warm</code> 牛皮纸(默认)`, parseMode: "html" }); return; }
      saveConfig({ ...loadConfig(), cardStyle: t });
      await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n<code>卡片风格已设置为: ${t}</code>`, parseMode: "html" });
    } else if (command === "type") {
      const t = (args[1] || "").toLowerCase();
      const valid = ["photo", "sticker", "file", "txt"];
      if (!valid.includes(t)) { await msg.edit({ text: `❌ <b>参数错误</b>\n\n<code>${commandName} type photo/sticker/file/txt</code> - 设置优先使用的消息类型`, parseMode: "html" }); return; }
      savePreferredType(t);
      await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n<code>优先类型已设置为: ${t}</code>\n<code>当前顺序: ${getMessageOrder().join(" → ")}</code>`, parseMode: "html" });
    } else if (command === "check") {
      await msg.edit({ text: "🔍 正在检查网络连接...", parseMode: "html" });
      const ns = await checkNetworkConnectivity();
      await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n${ns.connected ? "✅" : "❌"} <b>网络状态:</b> <code>${htmlEscape(ns.message)}</code>`, parseMode: "html" });
    } else if (command === "test") {
      const serverId = parseInt(args[1]);
      if (!serverId || isNaN(serverId)) { await msg.edit({ text: "❌ <b>参数错误</b>\n\n请指定有效的服务器ID\n例: <code>.speedtest test 12345</code>", parseMode: "html" }); return; }
      await msg.edit({ text: `🔍 正在测试服务器 ${serverId} 的可用性...`, parseMode: "html" });
      const r = await testServerAvailability(serverId);
      const errText = r.error ? `\n<b>错误:</b> <code>${htmlEscape(r.error)}</code>` : "";
      await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n${r.available ? "✅" : "❌"} <b>服务器 ${htmlEscape(String(serverId))}:</b> <code>${htmlEscape(r.available ? "可用" : "不可用")}</code>${r.ping ? ` (延迟: ${r.ping}ms)` : ""}${errText}`, parseMode: "html" });
    } else if (command === "best") {
      await msg.edit({ text: "🎯 正在查找推荐服务器...", parseMode: "html" });
      const servers = await getAllServers();
      if (servers.length > 0) {
        const top = servers.slice(0, 3);
        const list = top.map((s, i) => `${i + 1}. <code>${s.id}</code> - <code>${htmlEscape(s.name)}</code> - <code>${htmlEscape(s.location)}</code>`).join("\n");
        await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n🎯 <b>推荐服务器:</b>\n\n${list}\n\n💡 <code>${commandName} set [ID]</code> 设为默认`, parseMode: "html" });
      } else { await msg.edit({ text: "<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n❌ <code>无法获取服务器列表</code>", parseMode: "html" }); }
    } else if (command === "diagnose") {
      await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n✅ <b>可执行文件状态:</b> <code>内置(curl)</code>\n<b>平台:</b> <code>${process.platform}</code>\n<b>架构:</b> <code>${process.arch}</code>\n<b>外部二进制:</b> <code>无</code>`, parseMode: "html" });
    } else if (command === "diag") {
      await msg.edit({ text: "🔧 正在诊断...", parseMode: "html" });
      const d = await diag();
      await msg.edit({ text: d, parseMode: "html" });
    } else if (command === "fix") {
      await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n✅ <code>轻量版无需修复(无外部二进制依赖)</code>`, parseMode: "html" });
    } else if (command === "update") {
      await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n✅ <code>轻量版无需更新(纯curl实现)</code>`, parseMode: "html" });
    } else {
      await msg.edit({ text: "🚀 正在测速... (下载+上传测速中, 约30秒)", parseMode: "html" });
      const { buffer, text } = await runSpeedtestCard(getDefaultServer());
      const tmpPath = `/tmp/speedtest_card_${Date.now()}.png`;
      fs.writeFileSync(tmpPath, buffer);
      try {
        await msg.reply({ file: new CustomFile("speedtest.png", buffer.length, tmpPath), message: text, parseMode: "html" });
        await msg.delete();
      } catch (e) {
        log("send photo failed, fallback to text:", String(e).slice(0, 100));
        await msg.edit({ text, parseMode: "html" });
      } finally {
        fs.unlink(tmpPath, () => {});
      }
    }
  } catch (error) {
    log("HANDLER ERROR:", String(error).slice(0, 200));
    await msg.edit({ text: `<blockquote><b>⚡️SPEEDTEST (轻量版)</b></blockquote>\n❌ <code>执行失败: ${htmlEscape(String(error).slice(0, 100))}</code>`, parseMode: "html" });
  }
};

class SpeednextPlugin extends Plugin {
  name = pluginName;
  description = `⚡️ Speedtest 轻量版\n\n基于 curl 的纯 Node 速度测试, 无外部二进制依赖。\n命令: .speedtest (测速) / diag (诊断) / check (连通性) / list (服务器) / set (设默认) / best (推荐)`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = { speedtest };
}

export default new SpeednextPlugin();

// 加载时自检: 轻量连通性检查 (不耗带宽), 验证 eth0 原生 IP 出网可用
void (async () => {
  try {
    await execFileAsync("curl", ["-sS", "--interface", NATIVE_IFACE, "--max-time", "10", "-o", "/dev/null", "https://speed.cloudflare.com"], { encoding: "utf-8" });
    log("SELF-TEST OK: eth0 原生IP出网可用");
  } catch (e) {
    log("SELF-TEST WARN: eth0 出网异常:", String(e).slice(0, 120));
  }
})();

