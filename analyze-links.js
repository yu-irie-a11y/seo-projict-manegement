#!/usr/bin/env node

/**
 * 内部リンク構造 可視化ツール v2
 *
 * 改善点:
 *   - メインコンテンツ内のリンクのみ抽出（header/footer/nav/sidebar除外）
 *   - 孤立ページ・被リンク不足の自動検出
 *   - 視認性・操作性の大幅向上
 *
 * 使い方:
 *   node analyze-links.js urls.txt
 *   node analyze-links.js urls.txt --output report.html --delay 2000
 */

const fs = require("fs");
const path = require("path");
const { load } = require("cheerio");

const DEFAULT_OUTPUT = "link-map.html";
const DEFAULT_DELAY = 1000;
const REQUEST_TIMEOUT = 15000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ===== 引数パース =====
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
内部リンク構造 可視化ツール v2

使い方:
  node analyze-links.js <urls.txt> [options]

オプション:
  --output, -o <file>   出力HTMLファイル名 (デフォルト: link-map.html)
  --delay, -d <ms>      リクエスト間隔ミリ秒 (デフォルト: 1000)
  --all-links           ヘッダー・フッター含む全リンクを抽出（デフォルト: メインコンテンツのみ）
  --help, -h            ヘルプ表示
`);
    process.exit(0);
  }

  let inputFile = null;
  let output = DEFAULT_OUTPUT;
  let delay = DEFAULT_DELAY;
  let allLinks = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" || args[i] === "-o") output = args[++i];
    else if (args[i] === "--delay" || args[i] === "-d") delay = parseInt(args[++i], 10);
    else if (args[i] === "--all-links") allLinks = true;
    else if (!args[i].startsWith("-")) inputFile = args[i];
  }

  if (!inputFile) { console.error("エラー: URLファイルを指定してください"); process.exit(1); }
  return { inputFile, output, delay, allLinks };
}

// ===== URL操作 =====
function normalizeUrl(href, baseUrl) {
  try {
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:") ||
        href.startsWith("tel:") || href.startsWith("#")) return null;
    const resolved = new URL(href, baseUrl);
    resolved.hash = "";
    let pathname = resolved.pathname;
    if (pathname !== "/" && !path.extname(pathname) && !pathname.endsWith("/")) pathname += "/";
    resolved.pathname = pathname;
    return resolved.href;
  } catch { return null; }
}

function getDomain(url) { try { return new URL(url).hostname; } catch { return null; } }
function getPathname(url) { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } }

// ===== HTMLフェッチ =====
async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal, redirect: "follow" });
    clearTimeout(timeout);
    if (!res.ok) return { url, status: res.status, html: null, finalUrl: res.url };
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return { url, status: res.status, html: null, finalUrl: res.url };
    const html = await res.text();
    return { url, status: res.status, html, finalUrl: res.url };
  } catch (err) {
    clearTimeout(timeout);
    return { url, status: 0, html: null, error: err.message, finalUrl: url };
  }
}

// ===== メインコンテンツ領域のリンク抽出 =====
function extractLinks(html, pageUrl, targetDomains, allLinks) {
  const $ = load(html);
  const links = [];
  const seen = new Set();

  // ── ヘッダー・フッター・ナビ・サイドバーを除外 ──
  if (!allLinks) {
    $("header, footer, nav, aside").remove();
    $(".header, .footer, .sidebar, .side-bar, .widget, .widget-area").remove();
    $(".global-nav, .global-navigation, .footer-nav, .footer-navigation").remove();
    $(".breadcrumb, .breadcrumbs, .pankuzu").remove();
    $(".menu, .nav-menu, .mega-menu, .drawer-menu").remove();
    $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();
    $(".l-header, .l-footer, .l-sidebar, .c-header, .c-footer").remove();
    $(".site-header, .site-footer, .site-nav").remove();
    $("#header, #footer, #sidebar, #side, #nav, #navigation").remove();
  }

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const anchorText = $(el).text().trim().slice(0, 100);
    const normalized = normalizeUrl(href, pageUrl);
    if (!normalized) return;
    const domain = getDomain(normalized);
    if (!targetDomains.has(domain)) return;
    if (normalized === normalizeUrl(pageUrl, pageUrl)) return;
    const ext = path.extname(new URL(normalized).pathname).toLowerCase();
    if ([".pdf", ".jpg", ".png", ".gif", ".svg", ".zip", ".doc", ".xlsx"].includes(ext)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    links.push({ target: normalized, anchorText: anchorText || "(テキストなし)" });
  });

  return links;
}

// ===== メイン処理 =====
async function main() {
  const { inputFile, output, delay, allLinks } = parseArgs();

  if (!fs.existsSync(inputFile)) { console.error(`エラー: ファイルが見つかりません: ${inputFile}`); process.exit(1); }

  const urls = fs.readFileSync(inputFile, "utf-8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (urls.length === 0) { console.error("エラー: URLが1件もありません"); process.exit(1); }

  console.log(`\n===== 内部リンク構造 解析ツール v2 =====\n`);
  console.log(`対象URL: ${urls.length} 件`);
  console.log(`抽出モード: ${allLinks ? "全リンク" : "メインコンテンツのみ（header/footer/nav/sidebar除外）"}`);
  console.log(`リクエスト間隔: ${delay}ms`);
  console.log(`出力先: ${output}\n`);

  const targetDomains = new Set();
  urls.forEach(url => { const d = getDomain(url); if (d) targetDomains.add(d); });
  console.log(`対象ドメイン: ${[...targetDomains].join(", ")}\n`);

  const pageData = [];
  const allTargetUrls = new Set(urls.map(u => normalizeUrl(u, u)));

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    process.stdout.write(`[${i + 1}/${urls.length}] ${url.slice(0, 80)}... `);

    const result = await fetchPage(url);
    if (!result.html) {
      console.log(`✗ (${result.status}${result.error ? " " + result.error : ""})`);
      pageData.push({ url, title: "(取得失敗)", links: [] });
    } else {
      const $ = load(result.html);
      const title = $("title").text().trim() || getPathname(url);
      const links = extractLinks(result.html, result.finalUrl, targetDomains, allLinks);
      console.log(`✓ ${links.length} リンク`);
      pageData.push({ url: result.finalUrl, title, links });
      links.forEach(l => allTargetUrls.add(l.target));
    }

    if (i < urls.length - 1) await new Promise(r => setTimeout(r, delay));
  }

  // ===== グラフデータ構築 =====
  const nodeMap = new Map();
  pageData.forEach(p => {
    const n = normalizeUrl(p.url, p.url);
    if (!nodeMap.has(n)) nodeMap.set(n, { id: n, label: p.title, path: getPathname(p.url), crawled: true });
  });

  // クロール対象URLリストのSet
  const crawledUrlSet = new Set(pageData.map(p => normalizeUrl(p.url, p.url)));

  // リンク先のうちクロール対象に含まれるもののみノード追加（ノイズ削減）
  allTargetUrls.forEach(url => {
    if (url && !nodeMap.has(url)) {
      nodeMap.set(url, { id: url, label: getPathname(url), path: getPathname(url), crawled: false });
    }
  });

  const edges = [];
  const edgeSet = new Set();
  pageData.forEach(p => {
    const sourceUrl = normalizeUrl(p.url, p.url);
    p.links.forEach(l => {
      const key = `${sourceUrl} -> ${l.target}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({ source: sourceUrl, target: l.target, anchorText: l.anchorText });
      }
    });
  });

  const nodeList = [...nodeMap.values()];

  // 被リンク・発リンク集計
  const inCount = {}, outCount = {};
  nodeList.forEach(n => { inCount[n.id] = 0; outCount[n.id] = 0; });
  edges.forEach(e => { inCount[e.target] = (inCount[e.target] || 0) + 1; outCount[e.source] = (outCount[e.source] || 0) + 1; });

  console.log(`\n--- 解析結果 ---`);
  console.log(`ノード数: ${nodeList.length}（クロール済み: ${crawledUrlSet.size}）`);
  console.log(`エッジ数: ${edges.length}`);

  // 孤立ページ検出
  const isolatedPages = nodeList.filter(n => n.crawled && (inCount[n.id] || 0) === 0 && (outCount[n.id] || 0) === 0);
  const lowInPages = nodeList.filter(n => n.crawled && (inCount[n.id] || 0) <= 1 && (outCount[n.id] || 0) > 0);

  if (isolatedPages.length > 0) {
    console.log(`\n⚠ 孤立ページ（内部リンクなし）: ${isolatedPages.length} 件`);
    isolatedPages.slice(0, 10).forEach(n => console.log(`  - ${n.label.slice(0, 50)}`));
  }

  if (lowInPages.length > 0) {
    console.log(`\n⚠ 被リンク不足（0〜1件）: ${lowInPages.length} 件`);
    lowInPages.slice(0, 10).forEach(n => console.log(`  - (${inCount[n.id]}件) ${n.label.slice(0, 50)}`));
  }

  const top10 = Object.entries(inCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`\n被リンク TOP10:`);
  top10.forEach(([url, count], i) => {
    const node = nodeMap.get(url);
    console.log(`  ${i + 1}. (${count}件) ${node ? node.label.slice(0, 50) : url}`);
  });

  // グループ推定
  function guessGroup(url) {
    const p = getPathname(url).toLowerCase();
    const segments = p.split("/").filter(Boolean);
    if (segments.length === 0) return "top";
    const first = segments[0];
    const patterns = {
      top: /^\/$/, blog: /blog|news|column|magazine|journal|article/,
      service: /service|product|solution/, about: /about|company|corporate|overview/,
      contact: /contact|inquiry|form/, recruit: /recruit|career|jobs|hiring/,
      faq: /faq|help|support|question/, privacy: /privacy|policy|terms|legal/,
      case: /case|works|portfolio|achievement/,
    };
    for (const [group, regex] of Object.entries(patterns)) { if (regex.test(first)) return group; }
    return first.replace(/[^a-z0-9]/gi, "").slice(0, 15) || "other";
  }

  const groupSet = new Set();
  nodeList.forEach(n => { n.group = guessGroup(n.id); groupSet.add(n.group); });

  const palette = [
    "#4a9eff", "#26de81", "#ff9f43", "#a55eea", "#fd79a8",
    "#00cec9", "#e17055", "#6c5ce7", "#ffd700", "#00d2ff",
    "#fab1a0", "#55efc4", "#74b9ff", "#636e72", "#b2bec3",
    "#fdcb6e", "#e84393", "#0984e3", "#ee5a24", "#dfe6e9",
  ];
  const groupColors = {};
  let ci = 0;
  [...groupSet].sort().forEach(g => { groupColors[g] = palette[ci % palette.length]; ci++; });

  // ===== HTML生成 =====
  const nodesJson = JSON.stringify(nodeList.map(n => ({
    id: n.id, label: n.label.slice(0, 60), path: n.path, group: n.group, crawled: n.crawled,
  })));
  const edgesJson = JSON.stringify(edges.map(e => ({ source: e.source, target: e.target, anchorText: e.anchorText })));
  const groupColorsJson = JSON.stringify(groupColors);
  const timestamp = new Date().toLocaleString("ja-JP");
  const domainLabel = [...targetDomains].join(", ");

  const html = generateHtml({
    nodesJson, edgesJson, groupColorsJson, timestamp, domainLabel,
    totalNodes: nodeList.length, totalEdges: edges.length, crawledCount: crawledUrlSet.size,
  });

  fs.writeFileSync(output, html, "utf-8");
  console.log(`\n✓ 出力完了: ${output}\n`);
}

// ===== HTML テンプレート v2 =====
function generateHtml({ nodesJson, edgesJson, groupColorsJson, timestamp, domainLabel, totalNodes, totalEdges, crawledCount }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>内部リンク構造図 - ${domainLabel}</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Meiryo',sans-serif;background:#0f1129;color:#e0e0e0;overflow:hidden}
#app{width:100vw;height:100vh;position:relative}
svg{width:100%;height:100%;display:block}

/* ヘッダー */
#header{position:absolute;top:0;left:0;right:0;background:rgba(15,17,41,0.95);backdrop-filter:blur(10px);padding:10px 20px;display:flex;align-items:center;gap:14px;border-bottom:1px solid rgba(255,255,255,0.08);z-index:10;flex-wrap:wrap}
#header h1{font-size:14px;font-weight:600;white-space:nowrap}
.stats{font-size:11px;color:#666;white-space:nowrap}
#search-box{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:5px 10px;color:#e0e0e0;font-size:12px;width:200px;outline:none}
#search-box:focus{border-color:rgba(255,255,255,0.25)}
#search-box::placeholder{color:#444}
#search-results{position:absolute;top:42px;left:0;background:rgba(15,17,41,0.98);border:1px solid rgba(255,255,255,0.12);border-radius:8px;width:380px;max-height:360px;overflow-y:auto;display:none;z-index:100;box-shadow:0 12px 40px rgba(0,0,0,0.6)}
#search-wrap{position:relative}
.sr-item{padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;display:flex;align-items:center;gap:8px;transition:background 0.15s}
.sr-item:hover,.sr-item.selected{background:rgba(74,158,255,0.12)}
.sr-item .sr-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.sr-item .sr-label{font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sr-item .sr-path{font-size:9px;color:#555;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px}
.sr-item .sr-stats{font-size:9px;color:#666;flex-shrink:0;white-space:nowrap}
.sr-count{font-size:10px;padding:4px 12px;color:#555;border-bottom:1px solid rgba(255,255,255,0.04)}

/* ビューモード切替 */
.view-btn{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:5px 12px;color:#aaa;font-size:11px;cursor:pointer;transition:all 0.2s}
.view-btn:hover,.view-btn.active{background:rgba(74,158,255,0.15);border-color:rgba(74,158,255,0.4);color:#4a9eff}

/* ズームコントロール */
#zoom-controls{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);display:flex;gap:6px;z-index:10}
#zoom-controls button{width:36px;height:36px;border-radius:50%;background:rgba(15,17,41,0.9);border:1px solid rgba(255,255,255,0.12);color:#aaa;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.2s}
#zoom-controls button:hover{background:rgba(74,158,255,0.15);border-color:rgba(74,158,255,0.4);color:#fff}

/* 左パネル：フィルター */
#left-panel{position:absolute;top:52px;left:12px;background:rgba(15,17,41,0.95);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px;width:200px;z-index:10;max-height:calc(100vh - 70px);overflow-y:auto}
#left-panel h3{font-size:12px;color:#888;margin-bottom:8px}
.filter-item{display:flex;align-items:center;gap:7px;padding:3px 0;cursor:pointer;font-size:11px;transition:opacity 0.2s}
.filter-item:hover{color:#fff}
.filter-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.filter-item.unchecked{opacity:0.25}

/* 右パネル：分析 */
#right-panel{position:absolute;top:52px;right:12px;background:rgba(15,17,41,0.95);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px;width:320px;z-index:10;max-height:calc(100vh - 70px);overflow-y:auto;display:none}
#right-panel h3{font-size:13px;font-weight:600;margin-bottom:6px;word-break:break-all}
#right-panel .rp-path{font-size:10px;color:#555;margin-bottom:10px;word-break:break-all}
.rp-section{margin-bottom:14px}
.rp-section h4{font-size:11px;color:#555;margin-bottom:4px;padding-bottom:3px;border-bottom:1px solid rgba(255,255,255,0.06)}
.rp-link{font-size:10px;padding:4px 6px;margin:1px 0;display:flex;gap:6px;align-items:baseline;cursor:pointer;border-radius:4px;transition:background 0.15s}
.rp-link:hover{background:rgba(255,255,255,0.06)}
.rp-link .anchor{color:#4a9eff;flex-shrink:0;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-link .target{color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.rp-link .go-arrow{color:#555;flex-shrink:0;font-size:9px;transition:color 0.15s}
.rp-link:hover .go-arrow{color:#4a9eff}
.rp-link:hover .target{color:#ccc}
.rp-link .open-url{color:#444;flex-shrink:0;font-size:10px;padding:2px 4px;border-radius:3px;transition:all 0.15s;text-decoration:none;line-height:1}
.rp-link .open-url:hover{color:#4a9eff;background:rgba(74,158,255,0.15)}
.close-btn{position:absolute;top:10px;right:12px;cursor:pointer;color:#555;font-size:18px;line-height:1}
.close-btn:hover{color:#fff}

/* 分析パネル */
#analysis-panel{position:absolute;top:52px;right:12px;background:rgba(15,17,41,0.95);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px;width:320px;z-index:10;max-height:calc(100vh - 70px);overflow-y:auto}
.analysis-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:10px 12px;margin-bottom:10px}
.analysis-card h4{font-size:11px;color:#888;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.analysis-card .badge{font-size:10px;padding:1px 6px;border-radius:10px;font-weight:600}
.badge-danger{background:rgba(255,71,87,0.15);color:#ff4757}
.badge-warning{background:rgba(255,159,67,0.15);color:#ff9f43}
.badge-success{background:rgba(38,222,129,0.15);color:#26de81}
.analysis-item{font-size:10px;padding:3px 0;color:#aaa;display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.03)}
.analysis-item:last-child{border-bottom:none}
.analysis-item .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px}
.analysis-item .count{color:#fff;font-weight:600;flex-shrink:0}
.analysis-item.clickable{cursor:pointer}
.analysis-item.clickable:hover{color:#fff}

/* ツールチップ */
#tooltip{position:absolute;display:none;pointer-events:none;background:rgba(15,17,41,0.97);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:12px 16px;font-size:11px;max-width:360px;z-index:30;box-shadow:0 12px 40px rgba(0,0,0,0.6)}
.tt-title{font-size:13px;font-weight:600;margin-bottom:2px;word-break:break-all}
.tt-path{font-size:10px;color:#555;margin-bottom:6px;word-break:break-all}
.tt-stat{display:flex;gap:12px}
.tt-stat span{color:#888}
.tt-stat strong{color:#fff}
</style>
</head>
<body>
<div id="app">
  <div id="header">
    <h1>内部リンク構造図 v2</h1>
    <div id="search-wrap">
      <input type="text" id="search-box" placeholder="ページ名・URLで検索..." autocomplete="off">
      <div id="search-results"></div>
    </div>
    <button class="view-btn active" id="btn-graph">グラフ</button>
    <button class="view-btn" id="btn-heatmap">被リンク ヒートマップ</button>
    <div class="stats">${domainLabel} | ${crawledCount} ページ解析 / ${totalEdges} 本文内リンク | ${timestamp}</div>
  </div>

  <div id="left-panel">
    <h3>セクション</h3>
    <div id="group-filters"></div>
  </div>

  <div id="analysis-panel"></div>

  <div id="right-panel">
    <span class="close-btn" id="rp-close">&times;</span>
    <h3 id="rp-title"></h3>
    <div class="rp-path" id="rp-path"></div>
    <a id="rp-open-url" href="#" target="_blank" rel="noopener" style="display:inline-block;margin-bottom:10px;font-size:10px;color:#4a9eff;text-decoration:none;padding:3px 10px;border:1px solid rgba(74,158,255,0.3);border-radius:4px;transition:all 0.15s" onmouseover="this.style.background='rgba(74,158,255,0.12)'" onmouseout="this.style.background='none'">このページを開く ↗</a>
    <div id="rp-content"></div>
  </div>

  <div id="tooltip">
    <div class="tt-title"></div>
    <div class="tt-path"></div>
    <div class="tt-stat"></div>
  </div>

  <div id="zoom-controls">
    <button id="zoom-out" title="ズームアウト">−</button>
    <button id="zoom-fit" title="全体表示">⊙</button>
    <button id="zoom-in" title="ズームイン">+</button>
  </div>

  <svg id="graph"></svg>
</div>

<script>
const nodes = ${nodesJson};
const links = ${edgesJson};
const groupColors = ${groupColorsJson};

const inCount={},outCount={};
nodes.forEach(n=>{inCount[n.id]=0;outCount[n.id]=0});
links.forEach(l=>{inCount[l.target]=(inCount[l.target]||0)+1;outCount[l.source]=(outCount[l.source]||0)+1});

const maxIn = Math.max(...Object.values(inCount),1);
const width=window.innerWidth, height=window.innerHeight;
const svg=d3.select("#graph").attr("width",width).attr("height",height);

// 矢印マーカー
const defs=svg.append("defs");
defs.append("marker").attr("id","arr").attr("viewBox","0 -3 6 6").attr("refX",6).attr("refY",0)
  .attr("markerWidth",4).attr("markerHeight",4).attr("orient","auto")
  .append("path").attr("d","M0,-2.5L6,0L0,2.5").attr("fill","#4a9eff").attr("opacity",0.4);

const container=svg.append("g");

// ===== ズーム＆パン（トラックパッド対応） =====
// D3のデフォルトwheelはズーム専用。トラックパッドの2本指スクロール = パンに変えるため
// D3のwheel処理を無効化し、自前で処理する。
const zoomBehavior=d3.zoom().scaleExtent([0.08,6])
  .filter(e=>{
    // wheelイベントはD3のデフォルトから除外（自前で処理）
    if(e.type==="wheel") return false;
    // タッチ・マウスドラッグ等はそのまま許可
    return !e.ctrlKey && !e.button;
  })
  .on("zoom",e=>container.attr("transform",e.transform));
svg.call(zoomBehavior);
// ダブルクリックズーム無効化（誤操作防止）
svg.on("dblclick.zoom",null);

// トラックパッド対応: wheelイベントを自前で処理
// - 通常スクロール（2本指）→ パン移動
// - Ctrl/Cmd + スクロール（ピンチ）→ ズーム
svg.node().addEventListener("wheel",e=>{
  e.preventDefault();
  const currentTransform=d3.zoomTransform(svg.node());

  if(e.ctrlKey||e.metaKey){
    // ピンチズーム（ctrlKey はトラックパッドのピンチで自動付与される）
    const scaleFactor=Math.pow(2,-e.deltaY*0.01);
    const newScale=Math.max(0.08,Math.min(6,currentTransform.k*scaleFactor));
    // マウス位置を中心にズーム
    const rect=svg.node().getBoundingClientRect();
    const mx=e.clientX-rect.left, my=e.clientY-rect.top;
    const newX=mx-(mx-currentTransform.x)*(newScale/currentTransform.k);
    const newY=my-(my-currentTransform.y)*(newScale/currentTransform.k);
    const t=d3.zoomIdentity.translate(newX,newY).scale(newScale);
    svg.call(zoomBehavior.transform,t);
  } else {
    // 2本指スクロール → パン移動
    const t=d3.zoomIdentity
      .translate(currentTransform.x-e.deltaX, currentTransform.y-e.deltaY)
      .scale(currentTransform.k);
    svg.call(zoomBehavior.transform,t);
  }
},{passive:false});

// リンク描画（曲線）
const linkG=container.append("g");
const linkElements=linkG.selectAll("path").data(links).join("path")
  .attr("fill","none").attr("stroke","#4a9eff").attr("stroke-opacity",0.12).attr("stroke-width",0.7)
  .attr("marker-end","url(#arr)");

// ノード描画
const nodeG=container.append("g");
const nodeElements=nodeG.selectAll("g").data(nodes).join("g").attr("cursor","grab");

// ノード円
const circles = nodeElements.append("circle")
  .attr("r", d => nodeRadius(d))
  .attr("fill", d => groupColors[d.group]||"#888")
  .attr("stroke", d => d.crawled ? "#fff" : "#444")
  .attr("stroke-width", d => d.crawled ? 0.5 : 0.5)
  .attr("stroke-dasharray", d => d.crawled ? "none" : "2,2")
  .attr("opacity", 0.85);

// ラベル
const labels = nodeElements.append("text")
  .text(d => {
    const maxLen = (inCount[d.id]||0) >= 5 ? 20 : 15;
    const t = d.label.replace(/\\s*[|｜\\-–—].*$/, "").trim();
    return t.length > maxLen ? t.slice(0,maxLen-1)+"…" : t;
  })
  .attr("x", d => nodeRadius(d)+4)
  .attr("y", 3)
  .attr("font-size", d => (inCount[d.id]||0)>=5 ? "10px" : "9px")
  .attr("fill", d => d.crawled ? "#999" : "#444")
  .attr("font-weight", d => (inCount[d.id]||0)>=5 ? "600" : "400")
  .attr("pointer-events","none");

function nodeRadius(d){
  const inc=inCount[d.id]||0;
  if(!d.crawled) return 3;
  return Math.max(4, Math.min(3+Math.sqrt(inc)*2.8, 20));
}

// ドラッグ（スムーズ）
nodeElements.call(d3.drag()
  .on("start",(e,d)=>{
    if(!e.active) simulation.alphaTarget(0.15).restart();
    d.fx=d.x;d.fy=d.y;
    d3.select(e.sourceEvent.target.closest("g")).attr("cursor","grabbing");
  })
  .on("drag",(e,d)=>{d.fx=e.x;d.fy=e.y})
  .on("end",(e,d)=>{
    if(!e.active) simulation.alphaTarget(0);
    d.fx=null;d.fy=null;
    d3.select(e.sourceEvent.target.closest("g")).attr("cursor","grab");
  })
);

// シミュレーション（ノード数に応じた適応的パラメータ）
const N=nodes.length;
const sim_charge = N>150 ? -120 : N>60 ? -200 : -350;
const sim_dist = N>150 ? 50 : N>60 ? 70 : 90;
const sim_collision = N>150 ? 18 : N>60 ? 25 : 35;

const simulation=d3.forceSimulation(nodes)
  .force("link",d3.forceLink(links).id(d=>d.id).distance(sim_dist).strength(0.15))
  .force("charge",d3.forceManyBody().strength(sim_charge).distanceMax(500))
  .force("center",d3.forceCenter(width/2,height/2).strength(0.05))
  .force("collision",d3.forceCollide().radius(d=>nodeRadius(d)+sim_collision))
  .force("x",d3.forceX(width/2).strength(0.02))
  .force("y",d3.forceY(height/2).strength(0.02))
  .alphaDecay(0.015)
  .on("tick",()=>{
    // 曲線リンク
    linkElements.attr("d",d=>{
      const dx=d.target.x-d.source.x, dy=d.target.y-d.source.y;
      const dr=Math.sqrt(dx*dx+dy*dy)*1.5;
      const r=nodeRadius(d.target);
      const dist=Math.sqrt(dx*dx+dy*dy)||1;
      const tx=d.target.x-dx/dist*r, ty=d.target.y-dy/dist*r;
      return "M"+d.source.x+","+d.source.y+"A"+dr+","+dr+" 0 0,1 "+tx+","+ty;
    });
    nodeElements.attr("transform",d=>"translate("+d.x+","+d.y+")");
  });

// ===== ツールチップ =====
const tooltip=d3.select("#tooltip");
nodeElements
  .on("mouseover",(e,d)=>{
    tooltip.style("display","block");
    tooltip.select(".tt-title").text(d.label);
    tooltip.select(".tt-path").text(d.path);
    let statHtml = '<span>被リンク: <strong>'+(inCount[d.id]||0)+'</strong></span>';
    statHtml += '<span>発リンク: <strong>'+(outCount[d.id]||0)+'</strong></span>';
    if(!d.crawled) statHtml += '<span style="color:#ff6b6b">未クロール</span>';
    tooltip.select(".tt-stat").html(statHtml);
    // ホバー時のハイライト
    circles.transition().duration(150).attr("opacity",n=>{
      if(n.id===d.id) return 1;
      const isConnected = links.some(l=>{
        const s=typeof l.source==="object"?l.source.id:l.source;
        const t=typeof l.target==="object"?l.target.id:l.target;
        return (s===d.id&&t===n.id)||(t===d.id&&s===n.id);
      });
      return isConnected ? 0.9 : 0.15;
    });
    labels.transition().duration(150).attr("fill-opacity",n=>{
      if(n.id===d.id) return 1;
      const isConnected = links.some(l=>{
        const s=typeof l.source==="object"?l.source.id:l.source;
        const t=typeof l.target==="object"?l.target.id:l.target;
        return (s===d.id&&t===n.id)||(t===d.id&&s===n.id);
      });
      return isConnected ? 1 : 0.15;
    });
    linkElements.transition().duration(150)
      .attr("stroke-opacity",l=>{
        const s=typeof l.source==="object"?l.source.id:l.source;
        const t=typeof l.target==="object"?l.target.id:l.target;
        return (s===d.id||t===d.id) ? 0.5 : 0.03;
      })
      .attr("stroke-width",l=>{
        const s=typeof l.source==="object"?l.source.id:l.source;
        const t=typeof l.target==="object"?l.target.id:l.target;
        return (s===d.id||t===d.id) ? 2 : 0.7;
      })
      .attr("stroke",l=>{
        const s=typeof l.source==="object"?l.source.id:l.source;
        return s===d.id ? "#4a9eff" : "#26de81";
      });
  })
  .on("mousemove",e=>{
    const tx=Math.min(e.pageX+14,width-370), ty=Math.min(e.pageY-10,height-100);
    tooltip.style("left",tx+"px").style("top",ty+"px");
  })
  .on("mouseout",()=>{
    tooltip.style("display","none");
    if(!selectedNode) resetView();
  });

// ===== クリック → 詳細パネル =====
let selectedNode=null;
nodeElements.on("click",(e,d)=>{
  e.stopPropagation();
  selectedNode=d;
  document.getElementById("analysis-panel").style.display="none";
  showDetail(d);
});

svg.on("click",()=>{ selectedNode=null; resetView(); hideDetail(); showAnalysis(); });

function resetView(){
  circles.transition().duration(200).attr("opacity",0.85);
  labels.transition().duration(200).attr("fill-opacity",1);
  linkElements.transition().duration(200).attr("stroke-opacity",0.12).attr("stroke-width",0.7).attr("stroke","#4a9eff");
}

function showDetail(d){
  const panel=document.getElementById("right-panel");
  panel.style.display="block";
  document.getElementById("rp-title").textContent=d.label;
  document.getElementById("rp-path").textContent=d.path;

  // 「このページを開く」ボタンのURL設定
  const openBtn=document.getElementById("rp-open-url");
  openBtn.href=d.id;

  const out=links.filter(l=>(typeof l.source==="object"?l.source.id:l.source)===d.id);
  const inc=links.filter(l=>(typeof l.target==="object"?l.target.id:l.target)===d.id);

  let h='<div style="display:flex;gap:16px;margin-bottom:12px;font-size:12px">';
  h+='<div>被リンク <strong style="color:#26de81;font-size:16px">'+inc.length+'</strong></div>';
  h+='<div>発リンク <strong style="color:#4a9eff;font-size:16px">'+out.length+'</strong></div></div>';

  if(out.length>0){
    h+='<div class="rp-section"><h4 style="color:#4a9eff">発リンク（'+out.length+'件） <span style="font-size:9px;color:#555;font-weight:400">クリック=グラフ移動 / ↗=ページを開く</span></h4>';
    out.forEach(l=>{
      const tid=typeof l.target==="object"?l.target.id:l.target;
      const tn=nodes.find(n=>n.id===tid);
      const label=(tn?tn.label:tid).replace(/\\s*[|｜\\-–—].*$/,"").slice(0,30);
      h+='<div class="rp-link" data-node-id="'+tid+'">';
      h+='<span class="anchor">"'+(l.anchorText||"").slice(0,16)+'"</span>';
      h+='<span class="target">→ '+label+'</span>';
      h+='<a class="open-url" href="'+tid+'" target="_blank" rel="noopener" title="別タブで開く">↗</a>';
      h+='<span class="go-arrow">▶</span>';
      h+='</div>';
    });
    h+='</div>';
  }
  if(inc.length>0){
    h+='<div class="rp-section"><h4 style="color:#26de81">被リンク（'+inc.length+'件） <span style="font-size:9px;color:#555;font-weight:400">クリック=グラフ移動 / ↗=ページを開く</span></h4>';
    inc.forEach(l=>{
      const sid=typeof l.source==="object"?l.source.id:l.source;
      const sn=nodes.find(n=>n.id===sid);
      const label=(sn?sn.label:sid).replace(/\\s*[|｜\\-–—].*$/,"").slice(0,30);
      h+='<div class="rp-link" data-node-id="'+sid+'">';
      h+='<span class="anchor">"'+(l.anchorText||"").slice(0,16)+'"</span>';
      h+='<span class="target">← '+label+'</span>';
      h+='<a class="open-url" href="'+sid+'" target="_blank" rel="noopener" title="別タブで開く">↗</a>';
      h+='<span class="go-arrow">▶</span>';
      h+='</div>';
    });
    h+='</div>';
  }
  document.getElementById("rp-content").innerHTML=h;

  // ↗ リンク（別タブで開く）のクリック伝播を止める
  document.querySelectorAll("#rp-content .open-url").forEach(el=>{
    el.addEventListener("click",e=>e.stopPropagation());
  });

  // 行クリック → グラフ内でそのノードへ遷移
  document.querySelectorAll("#rp-content .rp-link[data-node-id]").forEach(el=>{
    el.addEventListener("click",e=>{
      e.stopPropagation();
      focusNode(el.dataset.nodeId);
    });
  });
}
function hideDetail(){document.getElementById("right-panel").style.display="none"}
document.getElementById("rp-close").addEventListener("click",e=>{e.stopPropagation();hideDetail();selectedNode=null;resetView();showAnalysis()});

// ===== 分析パネル =====
function showAnalysis(){
  const panel=document.getElementById("analysis-panel");
  panel.style.display="block";

  const crawled=nodes.filter(n=>n.crawled);
  // 被リンク数でソート（昇順）
  const sorted=[...crawled].sort((a,b)=>(inCount[a.id]||0)-(inCount[b.id]||0));

  // 被リンク数ごとにグループ化
  const byCount={};
  sorted.forEach(n=>{
    const c=inCount[n.id]||0;
    if(!byCount[c]) byCount[c]=[];
    byCount[c].push(n);
  });
  const counts=Object.keys(byCount).map(Number).sort((a,b)=>a-b);
  const maxCount=counts[counts.length-1]||0;

  // サマリー
  const zeroCount=(byCount[0]||[]).length;
  const lowCount=sorted.filter(n=>(inCount[n.id]||0)>=1&&(inCount[n.id]||0)<=3).length;

  let h='';

  // サマリーカード
  h+='<div class="analysis-card"><h4>被リンク分布サマリー</h4>';
  h+='<div style="display:flex;gap:10px;margin:6px 0">';
  h+='<div style="flex:1;text-align:center;padding:6px;background:rgba(255,71,87,0.08);border-radius:6px"><div style="font-size:18px;font-weight:700;color:#ff4757">'+zeroCount+'</div><div style="font-size:9px;color:#888">0件</div></div>';
  h+='<div style="flex:1;text-align:center;padding:6px;background:rgba(255,159,67,0.08);border-radius:6px"><div style="font-size:18px;font-weight:700;color:#ff9f43">'+lowCount+'</div><div style="font-size:9px;color:#888">1〜3件</div></div>';
  const midCount=sorted.filter(n=>{const c=inCount[n.id]||0;return c>=4&&c<=10}).length;
  const highCount=sorted.filter(n=>(inCount[n.id]||0)>10).length;
  h+='<div style="flex:1;text-align:center;padding:6px;background:rgba(74,158,255,0.08);border-radius:6px"><div style="font-size:18px;font-weight:700;color:#4a9eff">'+midCount+'</div><div style="font-size:9px;color:#888">4〜10件</div></div>';
  h+='<div style="flex:1;text-align:center;padding:6px;background:rgba(38,222,129,0.08);border-radius:6px"><div style="font-size:18px;font-weight:700;color:#26de81">'+highCount+'</div><div style="font-size:9px;color:#888">11件+</div></div>';
  h+='</div></div>';

  // 被リンク数ごとの全ページリスト（昇順）
  h+='<div class="analysis-card" style="padding-bottom:4px"><h4>全ページ 被リンク数順 <span class="badge badge-warning">'+crawled.length+'ページ</span></h4>';
  h+='<div style="font-size:9px;color:#555;margin-bottom:8px">被リンク少ない順 / クリックでグラフ移動 / ↗で別タブ</div>';

  counts.forEach(count=>{
    const pages=byCount[count];
    // 被リンク数ごとのヘッダー色
    let headerColor,badgeClass;
    if(count===0){headerColor="#ff4757";badgeClass="badge-danger";}
    else if(count<=3){headerColor="#ff9f43";badgeClass="badge-warning";}
    else if(count<=10){headerColor="#4a9eff";badgeClass="badge-success";}
    else{headerColor="#26de81";badgeClass="badge-success";}

    h+='<div style="margin:8px 0 4px;display:flex;align-items:center;gap:6px;border-top:1px solid rgba(255,255,255,0.04);padding-top:6px">';
    h+='<span style="font-size:11px;font-weight:700;color:'+headerColor+'">'+count+'件</span>';
    h+='<span style="font-size:9px;color:#555">('+pages.length+'ページ)</span>';
    // バー表示
    const barW=Math.max(2,Math.min((pages.length/crawled.length)*120,120));
    h+='<div style="flex:1;height:4px;background:rgba(255,255,255,0.04);border-radius:2px;overflow:hidden"><div style="width:'+barW+'px;height:100%;background:'+headerColor+';border-radius:2px;opacity:0.6"></div></div>';
    h+='</div>';

    pages.forEach(n=>{
      const label=n.label.replace(/\\s*[|｜\\-–—].*$/,"").slice(0,32);
      h+='<div class="analysis-item clickable" data-id="'+n.id+'" style="display:flex;align-items:center;gap:4px">';
      h+='<span class="name" style="flex:1">'+label+'</span>';
      h+='<a href="'+n.id+'" target="_blank" rel="noopener" class="open-url" style="color:#444;font-size:10px;padding:1px 3px;border-radius:3px;text-decoration:none;transition:all 0.15s" onmouseover="this.style.color=&#39;#4a9eff&#39;;this.style.background=&#39;rgba(74,158,255,0.15)&#39;" onmouseout="this.style.color=&#39;#444&#39;;this.style.background=&#39;none&#39;">↗</a>';
      h+='<span class="count" style="color:'+headerColor+'">'+count+'</span>';
      h+='</div>';
    });
  });
  h+='</div>';

  panel.innerHTML=h;

  // ↗ リンクのクリック伝播を止める
  panel.querySelectorAll(".open-url").forEach(el=>{
    el.addEventListener("click",e=>e.stopPropagation());
  });

  // クリックでノードにフォーカス
  panel.querySelectorAll(".clickable").forEach(el=>{
    el.addEventListener("click",()=>{
      const nodeId=el.dataset.id;
      focusNode(nodeId);
    });
  });
}
showAnalysis();

// ===== 検索（強化版） =====
const searchBox=document.getElementById("search-box");
const searchResults=document.getElementById("search-results");
let searchSelectedIdx=-1;

function doSearch(q){
  if(!q){searchResults.style.display="none";resetView();return[];}
  const matches=[];
  nodes.forEach(n=>{
    if(n.label.toLowerCase().includes(q)||n.path.toLowerCase().includes(q)){
      matches.push(n);
    }
  });
  // 被リンク数で降順ソート
  matches.sort((a,b)=>(inCount[b.id]||0)-(inCount[a.id]||0));
  return matches;
}

function renderSearchResults(matches,q){
  if(matches.length===0 && q){
    searchResults.innerHTML='<div class="sr-count">該当なし</div>';
    searchResults.style.display="block";
    return;
  }
  if(!q){searchResults.style.display="none";return;}

  let h='<div class="sr-count">'+matches.length+'件ヒット（↑↓で選択、Enterで移動）</div>';
  matches.slice(0,20).forEach((n,i)=>{
    const lbl=n.label.replace(/\\s*[|｜\\-–—].*$/,"").slice(0,40);
    const color=groupColors[n.group]||"#888";
    h+='<div class="sr-item'+(i===searchSelectedIdx?" selected":"")+'" data-idx="'+i+'" data-id="'+n.id+'">';
    h+='<div class="sr-dot" style="background:'+color+'"></div>';
    h+='<span class="sr-label">'+lbl+'</span>';
    h+='<span class="sr-path">'+n.path.slice(0,30)+'</span>';
    h+='<span class="sr-stats">IN:'+(inCount[n.id]||0)+' OUT:'+(outCount[n.id]||0)+'</span>';
    h+='</div>';
  });
  if(matches.length>20) h+='<div class="sr-count">...他 '+(matches.length-20)+'件</div>';
  searchResults.innerHTML=h;
  searchResults.style.display="block";

  // クリックイベント
  searchResults.querySelectorAll(".sr-item").forEach(el=>{
    el.addEventListener("click",()=>{
      const nodeId=el.dataset.id;
      focusNode(nodeId);
      searchResults.style.display="none";
    });
  });
}

function focusNode(nodeId){
  const nd=nodes.find(n=>n.id===nodeId);
  if(!nd) return;
  selectedNode=nd;
  document.getElementById("analysis-panel").style.display="none";
  showDetail(nd);
  // ズーム
  const scale=2;
  svg.transition().duration(600).call(
    zoomBehavior.transform,
    d3.zoomIdentity.translate(width/2-nd.x*scale, height/2-nd.y*scale).scale(scale)
  );
  // ハイライト（接続ノードも表示）
  const connectedIds=new Set([nd.id]);
  links.forEach(l=>{
    const s=typeof l.source==="object"?l.source.id:l.source;
    const t=typeof l.target==="object"?l.target.id:l.target;
    if(s===nd.id) connectedIds.add(t);
    if(t===nd.id) connectedIds.add(s);
  });
  circles.transition().duration(200).attr("opacity",n=>connectedIds.has(n.id)?1:0.08);
  labels.transition().duration(200).attr("fill-opacity",n=>connectedIds.has(n.id)?1:0.08);
  linkElements.transition().duration(200)
    .attr("stroke-opacity",l=>{
      const s=typeof l.source==="object"?l.source.id:l.source;
      const t=typeof l.target==="object"?l.target.id:l.target;
      return (s===nd.id||t===nd.id)?0.5:0.02;
    })
    .attr("stroke-width",l=>{
      const s=typeof l.source==="object"?l.source.id:l.source;
      const t=typeof l.target==="object"?l.target.id:l.target;
      return (s===nd.id||t===nd.id)?2:0.7;
    })
    .attr("stroke",l=>{
      const s=typeof l.source==="object"?l.source.id:l.source;
      return s===nd.id?"#4a9eff":"#26de81";
    });
}

let searchMatches=[];
searchBox.addEventListener("input",function(){
  const q=this.value.toLowerCase().trim();
  searchSelectedIdx=-1;
  searchMatches=doSearch(q);
  renderSearchResults(searchMatches,q);
  // グラフ上のハイライト
  if(q){
    const matchIds=new Set(searchMatches.map(n=>n.id));
    circles.transition().duration(150).attr("opacity",n=>matchIds.has(n.id)?1:0.06);
    labels.transition().duration(150).attr("fill-opacity",n=>matchIds.has(n.id)?1:0.06);
    linkElements.transition().duration(150).attr("stroke-opacity",0.02);
  }
});

searchBox.addEventListener("keydown",function(e){
  if(!searchMatches.length) return;
  const maxIdx=Math.min(searchMatches.length,20)-1;
  if(e.key==="ArrowDown"){
    e.preventDefault();
    searchSelectedIdx=Math.min(searchSelectedIdx+1,maxIdx);
    renderSearchResults(searchMatches,this.value.toLowerCase().trim());
  } else if(e.key==="ArrowUp"){
    e.preventDefault();
    searchSelectedIdx=Math.max(searchSelectedIdx-1,0);
    renderSearchResults(searchMatches,this.value.toLowerCase().trim());
  } else if(e.key==="Enter"){
    e.preventDefault();
    const idx=searchSelectedIdx>=0?searchSelectedIdx:0;
    if(searchMatches[idx]){
      focusNode(searchMatches[idx].id);
      searchResults.style.display="none";
    }
  } else if(e.key==="Escape"){
    searchResults.style.display="none";
    this.blur();
    resetView();
  }
});

// 外部クリックで検索結果を閉じる
document.addEventListener("click",e=>{
  if(!e.target.closest("#search-wrap")) searchResults.style.display="none";
});

// ===== ヒートマップモード =====
let heatmapMode=false;
document.getElementById("btn-graph").addEventListener("click",()=>{
  heatmapMode=false;
  document.getElementById("btn-graph").classList.add("active");
  document.getElementById("btn-heatmap").classList.remove("active");
  circles.transition().duration(300)
    .attr("fill",d=>groupColors[d.group]||"#888")
    .attr("r",d=>nodeRadius(d));
  labels.transition().duration(300).attr("fill",d=>d.crawled?"#999":"#444");
});

document.getElementById("btn-heatmap").addEventListener("click",()=>{
  heatmapMode=true;
  document.getElementById("btn-heatmap").classList.add("active");
  document.getElementById("btn-graph").classList.remove("active");
  // 被リンク数でグラデーション: 赤(少)→黄→緑(多)
  const colorScale=d3.scaleSequential(d3.interpolateRdYlGn).domain([0,Math.min(maxIn,20)]);
  circles.transition().duration(300)
    .attr("fill",d=>{
      if(!d.crawled) return "#333";
      return colorScale(Math.min(inCount[d.id]||0,20));
    })
    .attr("r",d=>{
      if(!d.crawled) return 3;
      return Math.max(5, Math.min(4+Math.sqrt((inCount[d.id]||0))*3, 22));
    });
  labels.transition().duration(300).attr("fill",d=>{
    if(!d.crawled) return "#333";
    return (inCount[d.id]||0)<=2?"#ff6b6b":"#ccc";
  });
});

// ===== フィルター =====
const filterContainer=d3.select("#group-filters");
const groupCounts={};
nodes.forEach(n=>{groupCounts[n.group]=(groupCounts[n.group]||0)+1});
Object.entries(groupColors).sort((a,b)=>(groupCounts[b[0]]||0)-(groupCounts[a[0]]||0)).forEach(([g,color])=>{
  const item=filterContainer.append("div").attr("class","filter-item").attr("data-group",g)
    .on("click",function(){this.classList.toggle("unchecked");applyFilters()});
  item.append("div").attr("class","filter-dot").style("background",color);
  item.append("span").text(g+" ("+(groupCounts[g]||0)+")");
});

function applyFilters(){
  const hidden=new Set();
  document.querySelectorAll("#group-filters .filter-item.unchecked").forEach(el=>hidden.add(el.dataset.group));
  nodeElements.style("display",d=>hidden.has(d.group)?"none":null);
  linkElements.style("display",l=>{
    const s=typeof l.source==="object"?l.source.id:l.source;
    const t=typeof l.target==="object"?l.target.id:l.target;
    const sn=nodes.find(n=>n.id===s),tn=nodes.find(n=>n.id===t);
    return (hidden.has(sn?.group)||hidden.has(tn?.group))?"none":null;
  });
}

// ===== ズームボタン =====
document.getElementById("zoom-in").addEventListener("click",()=>{
  svg.transition().duration(300).call(zoomBehavior.scaleBy,1.5);
});
document.getElementById("zoom-out").addEventListener("click",()=>{
  svg.transition().duration(300).call(zoomBehavior.scaleBy,0.67);
});
document.getElementById("zoom-fit").addEventListener("click",()=>{
  // 全ノードが収まるようにフィット
  const xs=nodes.map(n=>n.x),ys=nodes.map(n=>n.y);
  const x0=Math.min(...xs)-50,x1=Math.max(...xs)+50,y0=Math.min(...ys)-50,y1=Math.max(...ys)+50;
  const bw=x1-x0,bh=y1-y0;
  const scale=Math.min(width/bw,height/bh)*0.85;
  const tx=width/2-(x0+bw/2)*scale, ty=height/2-(y0+bh/2)*scale;
  svg.transition().duration(600).call(zoomBehavior.transform,d3.zoomIdentity.translate(tx,ty).scale(scale));
});

// 初期ズーム（フィット）
setTimeout(()=>{document.getElementById("zoom-fit").click()},2000);
<\/script>
</body>
</html>`;
}

main().catch(err=>{console.error("エラー:",err);process.exit(1)});
