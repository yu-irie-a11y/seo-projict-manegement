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
  --export-data <file>  クロールデータをJSONエクスポート（cluster-strategy.js連携用）
  --cluster, -c <file>  クラスターJSON（cluster-strategy.js --export-json出力）でクラスター表示
  --help, -h            ヘルプ表示
`);
    process.exit(0);
  }

  let inputFile = null;
  let output = DEFAULT_OUTPUT;
  let delay = DEFAULT_DELAY;
  let allLinks = false;
  let exportData = null;
  let clusterFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" || args[i] === "-o") output = args[++i];
    else if (args[i] === "--delay" || args[i] === "-d") delay = parseInt(args[++i], 10);
    else if (args[i] === "--all-links") allLinks = true;
    else if (args[i] === "--export-data") exportData = args[++i];
    else if (args[i] === "--cluster" || args[i] === "-c") clusterFile = args[++i];
    else if (!args[i].startsWith("-")) inputFile = args[i];
  }

  if (!inputFile) { console.error("エラー: URLファイルを指定してください"); process.exit(1); }
  return { inputFile, output, delay, allLinks, exportData, clusterFile };
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
    // WordPress テーマ共通: 関連記事・人気記事・おすすめ記事セクション
    $(".p-relatedPosts, .related-posts, .related_posts, .relatedPosts").remove();
    $(".p-fixBnr, .c-shareBtns, .p-authorBox").remove();
    $("#swell_plus_floating_button, .p-fixBtnWrap").remove();
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
  const { inputFile, output, delay, allLinks, exportData, clusterFile } = parseArgs();

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

  // ===== データエクスポート（cluster-strategy.js 連携用）=====
  if (exportData) {
    const exportObj = {
      meta: {
        exportedAt: new Date().toISOString(),
        urlFile: inputFile,
        domains: [...targetDomains],
        totalPages: crawledUrlSet.size,
        totalEdges: edges.length,
      },
      pageData,
      nodes: nodeList.map(n => ({ id: n.id, label: n.label, path: n.path, crawled: n.crawled, group: n.group })),
      edges: edges.map(e => ({ source: e.source, target: e.target, anchorText: e.anchorText })),
      inCount,
      outCount,
    };
    fs.writeFileSync(exportData, JSON.stringify(exportObj, null, 2), "utf-8");
    console.log(`\n✓ データエクスポート完了: ${exportData}`);
  }

  // ===== クラスターデータ読み込み =====
  let clusterData = null;
  if (clusterFile) {
    if (!fs.existsSync(clusterFile)) {
      console.error(`エラー: クラスターファイルが見つかりません: ${clusterFile}`);
      process.exit(1);
    }
    clusterData = JSON.parse(fs.readFileSync(clusterFile, "utf-8"));
    console.log(`\nクラスターデータ読み込み: ${clusterData.clusters.length} クラスター`);
    const urlToCluster = {};
    clusterData.clusters.forEach((c, idx) => {
      c.members.forEach(url => { urlToCluster[url] = idx; });
    });
    nodeList.forEach(n => {
      n.cluster = urlToCluster[n.id] !== undefined ? urlToCluster[n.id] : -1;
    });
  }

  // ===== HTML生成 =====
  const nodesJson = JSON.stringify(nodeList.map(n => ({
    id: n.id, label: n.label.slice(0, 60), path: n.path, group: n.group, crawled: n.crawled,
    cluster: n.cluster !== undefined ? n.cluster : -1,
  })));
  const edgesJson = JSON.stringify(edges.map(e => ({ source: e.source, target: e.target, anchorText: e.anchorText })));
  const groupColorsJson = JSON.stringify(groupColors);
  const clusterInfoJson = clusterData
    ? JSON.stringify(clusterData.clusters.map(c => ({
        name: c.name, killerPage: c.killerPage, healthScore: c.healthScore, members: c.members,
      })))
    : "null";
  const clusterEnabled = clusterData ? "true" : "false";
  const timestamp = new Date().toLocaleString("ja-JP");
  const domainLabel = [...targetDomains].join(", ");

  const html = generateHtml({
    nodesJson, edgesJson, groupColorsJson, clusterInfoJson, clusterEnabled, timestamp, domainLabel,
    totalNodes: nodeList.length, totalEdges: edges.length, crawledCount: crawledUrlSet.size,
  });

  fs.writeFileSync(output, html, "utf-8");
  console.log(`\n✓ 出力完了: ${output}\n`);
}

// ===== HTML テンプレート v2 =====
function generateHtml({ nodesJson, edgesJson, groupColorsJson, clusterInfoJson, clusterEnabled, timestamp, domainLabel, totalNodes, totalEdges, crawledCount }) {
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

/* リンク方向フィルタ */
.link-filter-group{display:flex;gap:0;margin-left:6px;border:1px solid rgba(255,255,255,0.1);border-radius:6px;overflow:hidden}
.link-filter-btn{background:rgba(255,255,255,0.04);border:none;border-right:1px solid rgba(255,255,255,0.08);padding:5px 10px;color:#666;font-size:10px;cursor:pointer;transition:all 0.2s;white-space:nowrap}
.link-filter-btn:last-child{border-right:none}
.link-filter-btn:hover{background:rgba(255,255,255,0.08);color:#aaa}
.link-filter-btn.active{background:rgba(74,158,255,0.15);color:#4a9eff;font-weight:600}
.link-filter-btn.active-in{background:rgba(38,222,129,0.15);color:#26de81;font-weight:600}
.link-filter-btn.active-out{background:rgba(74,158,255,0.15);color:#4a9eff;font-weight:600}
.link-filter-btn.active-none{background:rgba(255,71,87,0.15);color:#ff4757;font-weight:600}

/* クラスター凸包 */
.cluster-hull{transition:fill-opacity 0.3s,stroke-opacity 0.3s}
.cluster-hull:hover{fill-opacity:0.12!important;stroke-opacity:0.4!important}
.cluster-label{text-shadow:0 0 8px rgba(15,17,41,0.9),0 0 16px rgba(15,17,41,0.7);pointer-events:none}
@keyframes killer-pulse{0%,100%{stroke-opacity:0.8}50%{stroke-opacity:0.3}}
.killer-ring{animation:killer-pulse 3s ease-in-out infinite}

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

/* クラスターアコーディオン */
.cluster-item{border-bottom:1px solid rgba(255,255,255,0.04);padding-bottom:2px;margin-bottom:2px}
.cluster-header{display:flex;align-items:center;gap:7px;padding:5px 0;cursor:pointer;font-size:11px;transition:all 0.2s}
.cluster-header:hover{color:#fff}
.cluster-arrow{font-size:8px;transition:transform 0.2s;color:#666;width:10px;flex-shrink:0}
.cluster-header.expanded .cluster-arrow{transform:rotate(90deg);color:#aaa}
.cluster-eye{margin-left:auto;font-size:10px;color:#555;padding:2px 4px;border-radius:3px;flex-shrink:0}
.cluster-eye:hover{color:#fff;background:rgba(255,255,255,0.1)}
.cluster-eye.hidden-eye{color:#333}
.cluster-members{display:none;padding:2px 0 6px 17px;font-size:10px;max-height:200px;overflow-y:auto}
.cluster-members.open{display:block}
.cluster-member{padding:3px 4px;color:#888;cursor:pointer;border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cluster-member:hover{color:#fff;background:rgba(255,255,255,0.06)}
.cluster-member .km{color:#ffd700;font-size:8px;margin-right:3px}

/* コンテキストメニュー */
#ctx-menu{position:fixed;display:none;background:rgba(15,17,41,0.97);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:6px 0;min-width:210px;z-index:50;box-shadow:0 8px 32px rgba(0,0,0,0.6);font-size:11px;max-height:60vh;overflow-y:auto}
#ctx-menu .ctx-header{padding:8px 14px 6px;color:#aaa;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
#ctx-menu .ctx-section{padding:6px 14px 2px;color:#555;font-size:9px;text-transform:uppercase;letter-spacing:0.5px}
#ctx-menu .ctx-item{padding:5px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:background 0.1s;color:#ccc}
#ctx-menu .ctx-item:hover{background:rgba(74,158,255,0.15);color:#fff}
#ctx-menu .ctx-item .ctx-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
#ctx-menu .ctx-item.ctx-current{color:#4a9eff;font-weight:600}
#ctx-menu .ctx-divider{height:1px;background:rgba(255,255,255,0.06);margin:4px 0}
#ctx-menu .ctx-killer{padding:6px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:background 0.1s;color:#ffd700}
#ctx-menu .ctx-killer:hover{background:rgba(255,215,0,0.1)}
#ctx-menu .ctx-uncluster{color:#636e72}
.export-btn{width:100%;padding:7px 0;margin-top:4px;background:rgba(74,158,255,0.1);border:1px solid rgba(74,158,255,0.25);border-radius:6px;color:#4a9eff;font-size:10px;cursor:pointer;transition:all 0.2s}
.export-btn:hover{background:rgba(74,158,255,0.2);color:#fff}

/* クラスター健全度 */
.cluster-health-bar{height:3px;background:rgba(255,255,255,0.06);border-radius:2px;margin:2px 0 4px 17px;overflow:hidden}
.cluster-health-bar .fill{height:100%;border-radius:2px;transition:width 0.3s}
.ch-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:10px 12px;margin-bottom:10px;cursor:pointer;transition:border-color 0.2s}
.ch-card:hover{border-color:rgba(255,255,255,0.15)}
.ch-card .ch-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.ch-card .ch-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.ch-card .ch-name{font-size:12px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ch-card .ch-score{font-size:14px;font-weight:700;flex-shrink:0}
.ch-metrics{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:10px}
.ch-metric{display:flex;justify-content:space-between;color:#888}
.ch-metric .val{color:#ccc;font-weight:600}
.ch-metric .val.good{color:#26de81}
.ch-metric .val.warn{color:#ff9f43}
.ch-metric .val.bad{color:#ff4757}
.ch-recs{margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.04);font-size:9px}
.ch-rec{padding:2px 0;color:#888;display:flex;gap:4px;align-items:baseline}
.ch-rec .rec-icon{flex-shrink:0}
.ch-rec.rec-danger .rec-icon{color:#ff4757}
.ch-rec.rec-warning .rec-icon{color:#ff9f43}
.ch-rec.rec-info .rec-icon{color:#4a9eff}
.ch-summary{display:flex;gap:8px;margin-bottom:12px}
.ch-summary-item{flex:1;text-align:center;padding:8px 4px;background:rgba(255,255,255,0.03);border-radius:6px;border:1px solid rgba(255,255,255,0.04)}
.ch-summary-item .num{font-size:20px;font-weight:700}
.ch-summary-item .lbl{font-size:9px;color:#888;margin-top:2px}

/* リンク提案 */
.ls-section{margin-top:8px;border-top:1px solid rgba(255,255,255,0.04);padding-top:6px}
.ls-header{font-size:10px;color:#4a9eff;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:4px}
.ls-count{background:rgba(74,158,255,0.15);color:#4a9eff;padding:1px 6px;border-radius:8px;font-size:9px}
.ls-item{padding:4px 6px;font-size:9px;color:#999;cursor:pointer;border-radius:4px;transition:background 0.15s;display:flex;gap:4px;align-items:center;line-height:1.3}
.ls-item:hover{background:rgba(74,158,255,0.1);color:#fff}
.ls-item .ls-arrow{color:#555;flex-shrink:0}
.ls-item .ls-src,.ls-item .ls-tgt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px}
.ls-item.ls-high{border-left:2px solid #ff4757}
.ls-item.ls-medium{border-left:2px solid #ff9f43}
.ls-item .ls-type{font-size:8px;padding:1px 4px;border-radius:3px;flex-shrink:0;white-space:nowrap}
.ls-item .ls-type.t-ktm{background:rgba(255,71,87,0.15);color:#ff4757}
.ls-item .ls-type.t-mtk{background:rgba(255,215,0,0.15);color:#ffd700}
.ls-item .ls-type.t-orph{background:rgba(38,222,129,0.15);color:#26de81}
.ls-item .ls-type.t-dens{background:rgba(74,158,255,0.15);color:#4a9eff}

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
    <div class="link-filter-group">
      <button class="link-filter-btn active" data-filter="all">全て</button>
      <button class="link-filter-btn" data-filter="in">被リンク(IN)</button>
      <button class="link-filter-btn" data-filter="out">発リンク(OUT)</button>
      <button class="link-filter-btn" data-filter="none">非表示</button>
    </div>
    <div class="stats">${domainLabel} | ${crawledCount} ページ解析 / ${totalEdges} 本文内リンク | ${timestamp}</div>
  </div>

  <div id="left-panel">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <h3 id="left-panel-title">セクション</h3>
      ${clusterEnabled === "true" ? '<button class="view-btn" id="btn-toggle-panel-mode" style="font-size:9px;padding:3px 8px">クラスター</button>' : ''}
    </div>
    <div id="group-filters"></div>
    <div id="cluster-filters" style="display:none"></div>
    <div id="cluster-export-wrap" style="display:none;margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06)">
      <button class="export-btn" id="btn-export-clusters">clusters.json をエクスポート</button>
      <button class="export-btn" id="btn-export-checklist" style="margin-top:6px;background:rgba(74,158,255,0.12);border-color:rgba(74,158,255,0.3);color:#4a9eff">チェックリスト出力 (CSV)</button>
      <div id="export-status" style="font-size:9px;color:#555;margin-top:4px;text-align:center"></div>
    </div>
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

  <div id="ctx-menu">
    <div class="ctx-header" id="ctx-title"></div>
    <div id="ctx-body"></div>
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
const clusterInfo = ${clusterInfoJson};
const clusterMode = ${clusterEnabled};

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
  .on("zoom",e=>{container.attr("transform",e.transform);updateLabelsForZoom(e.transform.k);});
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

// ===== クラスター設定 =====
let clusterCenters={};
let clusterColorMap={};
const clusterNodeMap={};
const clusterPalette=["#4a9eff","#26de81","#ff9f43","#a55eea","#fd79a8","#00cec9","#e17055","#6c5ce7","#ffd700","#00d2ff","#fab1a0","#55efc4","#74b9ff","#e84393","#0984e3","#ee5a24"];

if(clusterMode&&clusterInfo){
  const cCount=clusterInfo.length;
  const radius=Math.min(width,height)*0.4;
  const cx=width/2,cy=height/2;
  clusterInfo.forEach((c,i)=>{
    const angle=(2*Math.PI*i/cCount)-Math.PI/2;
    clusterCenters[i]={x:cx+radius*Math.cos(angle),y:cy+radius*Math.sin(angle)};
    clusterColorMap[i]=clusterPalette[i%clusterPalette.length];
  });
  clusterCenters[-1]={x:cx,y:cy};
  clusterColorMap[-1]="#636e72";
  nodes.forEach(n=>{
    const ci=n.cluster!==undefined?n.cluster:-1;
    if(!clusterNodeMap[ci]) clusterNodeMap[ci]=[];
    clusterNodeMap[ci].push(n);
  });
}

// ===== クラスター健全度指標 =====
let clusterMetrics=[];
function computeClusterMetrics(){
  if(!clusterMode||!clusterInfo) return;
  clusterMetrics=clusterInfo.map((c,i)=>{
    const members=clusterNodeMap[i]||[];
    const memberIds=new Set(members.map(n=>n.id));
    const n=members.length;
    if(n===0) return {idx:i,name:c.name,size:0,score:0,density:0,killerReach:0,orphans:[],avgInbound:0,crossRatio:0,recs:[]};

    // 1. 内部リンク密度
    let internalEdges=0;
    links.forEach(l=>{
      const s=typeof l.source==="object"?l.source.id:l.source;
      const t=typeof l.target==="object"?l.target.id:l.target;
      if(memberIds.has(s)&&memberIds.has(t)) internalEdges++;
    });
    const maxEdges=n*(n-1);
    const density=maxEdges>0?internalEdges/maxEdges:0;

    // 2. キラーページ到達率（メンバー→キラーへのリンク割合）
    let killerConnected=0;
    const killerUrl=c.killerPage;
    const notLinkedFromKiller=[];
    const notLinkingToKiller=[];
    if(killerUrl&&memberIds.has(killerUrl)){
      members.forEach(m=>{
        if(m.id===killerUrl) return;
        let fromKiller=false,toKiller=false;
        links.forEach(l=>{
          const s=typeof l.source==="object"?l.source.id:l.source;
          const t=typeof l.target==="object"?l.target.id:l.target;
          if(s===killerUrl&&t===m.id) fromKiller=true;
          if(s===m.id&&t===killerUrl) toKiller=true;
        });
        if(toKiller) killerConnected++;
        if(!fromKiller) notLinkedFromKiller.push(m);
        if(!toKiller) notLinkingToKiller.push(m);
      });
    }
    const killerReach=n>1&&killerUrl?killerConnected/(n-1):0;

    // 3. 孤立ページ（クラスター内リンク0）
    const orphans=members.filter(m=>{
      return !links.some(l=>{
        const s=typeof l.source==="object"?l.source.id:l.source;
        const t=typeof l.target==="object"?l.target.id:l.target;
        return (s===m.id&&memberIds.has(t)&&t!==m.id)||(t===m.id&&memberIds.has(s)&&s!==m.id);
      });
    });

    // 4. 被リンク平均
    let totalIn=0;
    members.forEach(m=>{totalIn+=(inCount[m.id]||0)});
    const avgInbound=n>0?totalIn/n:0;

    // 5. 外部流出率
    let outInternal=0,outExternal=0;
    links.forEach(l=>{
      const s=typeof l.source==="object"?l.source.id:l.source;
      const t=typeof l.target==="object"?l.target.id:l.target;
      if(memberIds.has(s)){
        if(memberIds.has(t)) outInternal++;
        else outExternal++;
      }
    });
    const crossRatio=(outInternal+outExternal)>0?outExternal/(outInternal+outExternal):0;

    // 6. 総合スコア (0-100) — キラー到達率35/密度30/孤立25/被リンク5/流出5
    const killerScore=killerReach*35;
    const densityScore=Math.min(density/0.15,1)*30;
    const orphanScore=(n>0?1-orphans.length/n:1)*25;
    const inboundScore=Math.min(avgInbound/10,1)*5;
    const crossScore=(1-Math.abs(crossRatio-0.5)*2)*5;
    const score=Math.round(densityScore+killerScore+orphanScore+inboundScore+crossScore);

    // 7. 改善推奨
    const recs=[];
    if(orphans.length>0) recs.push({level:"danger",text:"孤立ページ "+orphans.length+"件: "+orphans.slice(0,3).map(o=>(o.label||o.path).replace(/\\s*[|｜\\-–—].*$/,"").slice(0,15)).join(", ")+(orphans.length>3?"…":"")});
    if(killerUrl&&notLinkedFromKiller.length>0&&notLinkedFromKiller.length<=n*0.7) recs.push({level:"warning",text:"キラーページからリンク未設置 "+notLinkedFromKiller.length+"件"});
    if(!killerUrl) recs.push({level:"warning",text:"キラーページが未設定"});
    if(density<0.05&&n>=4) recs.push({level:"danger",text:"内部リンク密度が非常に低い ("+Math.round(density*100)+"%)"});
    else if(density<0.1&&n>=4) recs.push({level:"warning",text:"内部リンク密度が低い ("+Math.round(density*100)+"%)"});
    if(n<3) recs.push({level:"info",text:"記事数が少ない — トピック権威性の向上に追加記事を検討"});
    if(crossRatio>0.8) recs.push({level:"warning",text:"外部流出率が高い ("+Math.round(crossRatio*100)+"%) — クラスター内リンクを強化"});

    return {idx:i,name:c.name,size:n,score,density,killerReach,orphans,avgInbound,crossRatio,internalEdges,recs,notLinkedFromKiller,notLinkingToKiller};
  });
}
computeClusterMetrics();

// ===== リンク最適化提案 =====
let linkSuggestions=[];
function generateLinkSuggestions(){
  if(!clusterMode||!clusterInfo||!clusterMetrics.length) return;
  const nodeMap={};
  nodes.forEach(n=>{nodeMap[n.id]=n});
  const lbl=id=>{const n=nodeMap[id];return n?(n.label||n.path||n.id).replace(/\\s*[|｜\\-–—].*$/,"").slice(0,35):id.replace(/.*\\/([^\\/]+)\\/?$/,"$1")};
  const existingEdgeSet=new Set();
  links.forEach(l=>{
    const s=typeof l.source==="object"?l.source.id:l.source;
    const t=typeof l.target==="object"?l.target.id:l.target;
    existingEdgeSet.add(s+"->"+t);
  });

  linkSuggestions=clusterMetrics.map((cm,i)=>{
    const c=clusterInfo[i];
    const members=clusterNodeMap[i]||[];
    const memberIds=new Set(members.map(n=>n.id));
    const killerUrl=c.killerPage;
    const suggestions=[];

    // タイプA: キラーページ → メンバー (キラーからのリンク未設置)
    if(killerUrl&&cm.notLinkedFromKiller){
      cm.notLinkedFromKiller.forEach(m=>{
        if(!existingEdgeSet.has(killerUrl+"->"+m.id)){
          suggestions.push({type:"killer-to-member",priority:"high",source:killerUrl,sourceLabel:lbl(killerUrl),target:m.id,targetLabel:lbl(m.id),reason:"キラーページからリンク未設置"});
        }
      });
    }

    // タイプB: メンバー → キラーページ (キラーへのリンク未設置)
    if(killerUrl&&cm.notLinkingToKiller){
      cm.notLinkingToKiller.forEach(m=>{
        if(!existingEdgeSet.has(m.id+"->"+killerUrl)){
          suggestions.push({type:"member-to-killer",priority:"high",source:m.id,sourceLabel:lbl(m.id),target:killerUrl,targetLabel:lbl(killerUrl),reason:"キラーページへのリンク未設置"});
        }
      });
    }

    // タイプC: 孤立ページ解消
    if(cm.orphans){
      cm.orphans.forEach(orphan=>{
        const bestSource=members.filter(m=>m.id!==orphan.id).sort((a,b)=>(inCount[b.id]||0)-(inCount[a.id]||0))[0];
        if(bestSource&&!existingEdgeSet.has(bestSource.id+"->"+orphan.id)){
          suggestions.push({type:"orphan-rescue",priority:"high",source:bestSource.id,sourceLabel:lbl(bestSource.id),target:orphan.id,targetLabel:lbl(orphan.id),reason:"孤立ページの解消 (被リンク最多ページから)"});
        }
      });
    }

    // タイプD: 密度向上（未接続ペア、被リンク上位同士を優先）
    const sortedMembers=[...members].sort((a,b)=>(inCount[b.id]||0)-(inCount[a.id]||0));
    let densityCount=0;
    for(let a=0;a<sortedMembers.length&&densityCount<5;a++){
      for(let b=a+1;b<sortedMembers.length&&densityCount<5;b++){
        const sa=sortedMembers[a].id,sb=sortedMembers[b].id;
        if(!existingEdgeSet.has(sa+"->"+sb)&&!existingEdgeSet.has(sb+"->"+sa)){
          suggestions.push({type:"density-boost",priority:"medium",source:sa,sourceLabel:lbl(sa),target:sb,targetLabel:lbl(sb),reason:"クラスター内リンク密度の向上"});
          densityCount++;
        }
      }
    }

    return {clusterId:i,clusterName:c.name,suggestions};
  });
}
generateLinkSuggestions();

// クラスター凸包レイヤー（リンクの下に描画）
const hullG=container.append("g");

// リンク描画（曲線）
const linkG=container.append("g");
const linkElements=linkG.selectAll("path").data(links).join("path")
  .attr("fill","none")
  .attr("stroke",d=>{
    if(!clusterMode) return "#4a9eff";
    const sc=d.source.cluster!==undefined?d.source.cluster:-1;
    const tc=d.target.cluster!==undefined?d.target.cluster:-1;
    if(sc>=0&&sc===tc) return clusterColorMap[sc]||"#4a9eff";
    return "#555";
  })
  .attr("stroke-opacity",d=>{
    if(!clusterMode) return 0.18;
    const sc=d.source.cluster!==undefined?d.source.cluster:-1;
    const tc=d.target.cluster!==undefined?d.target.cluster:-1;
    if(sc>=0&&sc===tc) return 0.3;
    return 0.04;
  })
  .attr("stroke-width",d=>{
    if(!clusterMode) return 0.9;
    const sc=d.source.cluster!==undefined?d.source.cluster:-1;
    const tc=d.target.cluster!==undefined?d.target.cluster:-1;
    if(sc>=0&&sc===tc) return 1.2;
    return 0.5;
  })
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

// キラーページリング
if(clusterMode&&clusterInfo){
  nodeElements.append("circle").attr("class","killer-ring")
    .attr("r",d=>{
      const ci=d.cluster;
      if(ci>=0&&clusterInfo[ci]&&d.id===clusterInfo[ci].killerPage) return nodeRadius(d)+4;
      return 0;
    })
    .attr("fill","none").attr("stroke","#ffd700").attr("stroke-width",2)
    .attr("stroke-dasharray","4,2").attr("opacity",0.8).attr("pointer-events","none");
}

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
  .attr("pointer-events","none")
  .attr("opacity", 0);

function nodeRadius(d){
  const inc=inCount[d.id]||0;
  if(!d.crawled) return 3;
  return Math.max(5, Math.min(4+Math.sqrt(inc)*3.5, 28));
}

let currentZoomK=1;
function updateLabelsForZoom(k){
  currentZoomK=k;
  labels.attr("opacity",d=>{
    const inc=inCount[d.id]||0;
    if(k<0.4) return 0;
    if(k<0.8) return inc>=10?0.8:0;
    if(k<1.2) return inc>=3?0.7:0;
    return 0.9;
  }).attr("font-size",d=>{
    const base=(inCount[d.id]||0)>=5?10:9;
    return Math.max(7,base/Math.max(k,0.5))+"px";
  });
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
const sim_charge = N>150 ? -500 : N>60 ? -600 : -700;
const sim_dist = N>150 ? 120 : N>60 ? 150 : 180;
const sim_collision = N>150 ? 26 : N>60 ? 34 : 44;

const simulation=d3.forceSimulation(nodes)
  .force("link",d3.forceLink(links).id(d=>d.id)
    .distance(d=>{
      if(!clusterMode) return sim_dist;
      const sc=typeof d.source==="object"?d.source.cluster:-1;
      const tc=typeof d.target==="object"?d.target.cluster:-1;
      if(sc>=0&&sc===tc) return sim_dist*0.35;
      return sim_dist*3.0;
    })
    .strength(d=>{
      if(!clusterMode) return 0.15;
      const sc=typeof d.source==="object"?d.source.cluster:-1;
      const tc=typeof d.target==="object"?d.target.cluster:-1;
      return (sc>=0&&sc===tc)?0.3:0.02;
    })
  )
  .force("charge",d3.forceManyBody().strength(sim_charge).distanceMax(1200))
  .force("center",d3.forceCenter(width/2,height/2).strength(0.05))
  .force("collision",d3.forceCollide().radius(d=>nodeRadius(d)+sim_collision))
  .alphaDecay(0.012);

if(clusterMode){
  simulation
    .force("x",d3.forceX(d=>{
      const ci=d.cluster!==undefined?d.cluster:-1;
      return (clusterCenters[ci]||clusterCenters[-1]).x;
    }).strength(d=>d.cluster>=0?0.15:0.01))
    .force("y",d3.forceY(d=>{
      const ci=d.cluster!==undefined?d.cluster:-1;
      return (clusterCenters[ci]||clusterCenters[-1]).y;
    }).strength(d=>d.cluster>=0?0.15:0.01));
} else {
  simulation
    .force("x",d3.forceX(width/2).strength(0.02))
    .force("y",d3.forceY(height/2).strength(0.02));
}

// 凸包パス生成（パディング付き）
function hullPath(hull){
  if(!hull||hull.length<3) return "";
  const pad=50;
  const cx=d3.polygonCentroid(hull);
  const exp=hull.map(p=>{
    const dx=p[0]-cx[0],dy=p[1]-cx[1];
    const dist=Math.sqrt(dx*dx+dy*dy)||1;
    return [p[0]+dx/dist*pad,p[1]+dy/dist*pad];
  });
  return "M"+exp.map(p=>p.join(",")).join("L")+"Z";
}

simulation.on("tick",()=>{
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

  // クラスター凸包＋ラベル更新
  if(clusterMode&&clusterInfo&&simulation.alpha()>0.005){
    const hullData=[];
    clusterInfo.forEach((c,i)=>{
      const cn=clusterNodeMap[i];
      if(!cn||cn.length<2) return;
      const pts=cn.map(n=>[n.x,n.y]);
      if(cn.length===2){
        // 2ノードの場合は楕円代替用の4点追加
        const mx=(pts[0][0]+pts[1][0])/2, my=(pts[0][1]+pts[1][1])/2;
        const dx=pts[1][0]-pts[0][0], dy=pts[1][1]-pts[0][1];
        const len=Math.sqrt(dx*dx+dy*dy)||1;
        const nx=-dy/len*20, ny=dx/len*20;
        pts.push([mx+nx,my+ny],[mx-nx,my-ny]);
      }
      const hull=d3.polygonHull(pts);
      if(hull) hullData.push({idx:i,name:c.name,hull:hull,color:clusterColorMap[i]});
    });
    const hulls=hullG.selectAll("path.cluster-hull").data(hullData,d=>d.idx);
    hulls.enter().append("path").attr("class","cluster-hull")
      .merge(hulls)
      .attr("d",d=>hullPath(d.hull))
      .attr("fill",d=>d.color).attr("fill-opacity",0.08)
      .attr("stroke",d=>d.color).attr("stroke-opacity",0.35)
      .attr("stroke-width",2).attr("stroke-dasharray","8,4");
    hulls.exit().remove();

    // クラスターラベル
    const lblData=clusterInfo.map((c,i)=>{
      const cn=clusterNodeMap[i];
      if(!cn||cn.length===0) return null;
      const cx=d3.mean(cn,n=>n.x);
      const minY=d3.min(cn,n=>n.y);
      return {idx:i,name:c.name,x:cx,y:minY-40};
    }).filter(Boolean);
    const clLabels=hullG.selectAll("text.cluster-label").data(lblData,d=>d.idx);
    clLabels.enter().append("text").attr("class","cluster-label")
      .merge(clLabels)
      .attr("x",d=>d.x).attr("y",d=>d.y)
      .text(d=>d.name)
      .attr("text-anchor","middle")
      .attr("fill",d=>clusterColorMap[d.idx])
      .attr("fill-opacity",0.85)
      .attr("font-size",d=>{const sz=clusterNodeMap[d.idx]?clusterNodeMap[d.idx].length:0;return Math.max(16,13+Math.sqrt(sz)*1.5)+"px"})
      .attr("font-weight","700");
    clLabels.exit().remove();
  }
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
    if(clusterMode&&clusterInfo){
      const ci=d.cluster;
      if(ci>=0&&clusterInfo[ci]){
        statHtml+='<span style="color:'+clusterColorMap[ci]+'">'+clusterInfo[ci].name+'</span>';
        if(d.id===clusterInfo[ci].killerPage) statHtml+='<span style="color:#ffd700">★ キラー</span>';
      } else { statHtml+='<span style="color:#636e72">未分類</span>'; }
    }
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
    }).attr("opacity",n=>{
      if(n.id===d.id) return 1;
      const isConnected = links.some(l=>{
        const s=typeof l.source==="object"?l.source.id:l.source;
        const t=typeof l.target==="object"?l.target.id:l.target;
        return (s===d.id&&t===n.id)||(t===d.id&&s===n.id);
      });
      return isConnected ? 1 : 0;
    });
    if(linkFilter!=="none"){
      linkElements.transition().duration(150)
        .attr("stroke-opacity",l=>{
          const s=typeof l.source==="object"?l.source.id:l.source;
          const t=typeof l.target==="object"?l.target.id:l.target;
          const isConn=(s===d.id||t===d.id);
          if(linkFilter==="in") return t===d.id?0.6:0.02;
          if(linkFilter==="out") return s===d.id?0.6:0.02;
          return isConn ? 0.5 : 0.03;
        })
        .attr("stroke-width",l=>{
          const s=typeof l.source==="object"?l.source.id:l.source;
          const t=typeof l.target==="object"?l.target.id:l.target;
          if(linkFilter==="in") return t===d.id?2.5:0.5;
          if(linkFilter==="out") return s===d.id?2.5:0.5;
          return (s===d.id||t===d.id) ? 2 : 0.9;
        })
        .attr("stroke",l=>{
          if(linkFilter==="in") return "#26de81";
          if(linkFilter==="out") return "#4a9eff";
          const s=typeof l.source==="object"?l.source.id:l.source;
          return s===d.id ? "#4a9eff" : "#26de81";
        });
    }
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
let linkFilter="all";

function applyLinkFilter(){
  linkElements.transition().duration(200)
    .attr("stroke-opacity",d=>{
      if(linkFilter==="none") return 0;
      const s=typeof d.source==="object"?d.source.id:d.source;
      const t=typeof d.target==="object"?d.target.id:d.target;
      if(linkFilter==="all"){
        if(selectedNode){
          return (s===selectedNode.id||t===selectedNode.id)?0.5:0.03;
        }
        return 0.18;
      }
      if(linkFilter==="in"){
        if(selectedNode) return t===selectedNode.id?0.6:0.02;
        return 0.18;
      }
      if(linkFilter==="out"){
        if(selectedNode) return s===selectedNode.id?0.6:0.02;
        return 0.18;
      }
      return 0.18;
    })
    .attr("stroke-width",d=>{
      if(linkFilter==="none") return 0;
      const s=typeof d.source==="object"?d.source.id:d.source;
      const t=typeof d.target==="object"?d.target.id:d.target;
      if(selectedNode){
        if(linkFilter==="in") return t===selectedNode.id?2.5:0.5;
        if(linkFilter==="out") return s===selectedNode.id?2.5:0.5;
        return (s===selectedNode.id||t===selectedNode.id)?2:0.9;
      }
      return 0.9;
    })
    .attr("stroke",d=>{
      if(linkFilter==="in") return "#26de81";
      if(linkFilter==="out") return "#4a9eff";
      const s=typeof d.source==="object"?d.source.id:d.source;
      if(selectedNode) return s===selectedNode.id?"#4a9eff":"#26de81";
      return "#4a9eff";
    });
  // 矢印マーカーも非表示/表示切り替え
  d3.select("#arrowhead").attr("opacity", linkFilter==="none"?0:1);
}

// リンクフィルタタブ
document.querySelectorAll(".link-filter-btn").forEach(btn=>{
  btn.addEventListener("click",()=>{
    document.querySelectorAll(".link-filter-btn").forEach(b=>{
      b.classList.remove("active","active-in","active-out","active-none");
    });
    const f=btn.dataset.filter;
    linkFilter=f;
    if(f==="all") btn.classList.add("active");
    else if(f==="in") btn.classList.add("active-in");
    else if(f==="none") btn.classList.add("active-none");
    else btn.classList.add("active-out");
    applyLinkFilter();
  });
});

nodeElements.on("click",(e,d)=>{
  e.stopPropagation();
  selectedNode=d;
  document.getElementById("analysis-panel").style.display="none";
  showDetail(d);
  applyLinkFilter();
});

svg.on("click",()=>{ selectedNode=null; resetView(); hideDetail(); showAnalysis(); hideCtxMenu(); });

// ===== コンテキストメニュー（クラスター切替・キラー切替） =====
const ctxMenu=document.getElementById("ctx-menu");
const ctxTitle=document.getElementById("ctx-title");
const ctxBody=document.getElementById("ctx-body");
let ctxNode=null;
let editCount=0;

function hideCtxMenu(){ctxMenu.style.display="none";ctxNode=null}

function showCtxMenu(d,x,y){
  ctxNode=d;
  const label=(d.label||d.path||d.id).replace(/\\s*[|｜\\-–—].*$/,"").slice(0,25);
  ctxTitle.textContent=label;
  ctxBody.innerHTML="";

  if(clusterMode&&clusterInfo){
    const sec=document.createElement("div");
    sec.className="ctx-section";sec.textContent="クラスター変更";
    ctxBody.appendChild(sec);

    clusterInfo.forEach((c,i)=>{
      const item=document.createElement("div");
      item.className="ctx-item"+(d.cluster===i?" ctx-current":"");
      const dot=document.createElement("span");dot.className="ctx-dot";dot.style.background=clusterColorMap[i];
      item.appendChild(dot);
      const txt=document.createElement("span");txt.textContent=c.name;item.appendChild(txt);
      if(d.cluster===i){const ck=document.createElement("span");ck.textContent="✓";ck.style.cssText="margin-left:auto;color:#4a9eff";item.appendChild(ck)}
      item.addEventListener("click",()=>{reassignCluster(d,i);hideCtxMenu()});
      ctxBody.appendChild(item);
    });

    // 未分類オプション
    const ui=document.createElement("div");ui.className="ctx-item ctx-uncluster"+(d.cluster===-1?" ctx-current":"");
    const ud=document.createElement("span");ud.className="ctx-dot";ud.style.background="#636e72";ui.appendChild(ud);
    const ut=document.createElement("span");ut.textContent="未分類";ui.appendChild(ut);
    if(d.cluster===-1){const ck=document.createElement("span");ck.textContent="✓";ck.style.cssText="margin-left:auto;color:#4a9eff";ui.appendChild(ck)}
    ui.addEventListener("click",()=>{reassignCluster(d,-1);hideCtxMenu()});
    ctxBody.appendChild(ui);

    // キラーページ切替（クラスター所属時のみ）
    if(d.cluster>=0&&clusterInfo[d.cluster]){
      const dv=document.createElement("div");dv.className="ctx-divider";ctxBody.appendChild(dv);
      const isK=d.id===clusterInfo[d.cluster].killerPage;
      const ki=document.createElement("div");ki.className="ctx-killer";
      ki.textContent=isK?"★ キラーページ解除":"★ キラーページに設定";
      ki.addEventListener("click",()=>{toggleKiller(d);hideCtxMenu()});
      ctxBody.appendChild(ki);
    }
  }

  ctxMenu.style.display="block";
  const mw=ctxMenu.offsetWidth,mh=ctxMenu.offsetHeight;
  ctxMenu.style.left=Math.min(x,window.innerWidth-mw-8)+"px";
  ctxMenu.style.top=Math.min(y,window.innerHeight-mh-8)+"px";
}

nodeElements.on("contextmenu",(e,d)=>{
  e.preventDefault();e.stopPropagation();
  showCtxMenu(d,e.clientX,e.clientY);
});

document.addEventListener("click",e=>{if(!e.target.closest("#ctx-menu"))hideCtxMenu()});

function reassignCluster(d,newCluster){
  const oldCluster=d.cluster!==undefined?d.cluster:-1;
  if(oldCluster===newCluster) return;

  // clusterNodeMapから移動
  if(clusterNodeMap[oldCluster]) clusterNodeMap[oldCluster]=clusterNodeMap[oldCluster].filter(n=>n.id!==d.id);
  if(!clusterNodeMap[newCluster]) clusterNodeMap[newCluster]=[];
  clusterNodeMap[newCluster].push(d);

  // clusterInfo membersを更新
  if(oldCluster>=0&&clusterInfo[oldCluster]){
    clusterInfo[oldCluster].members=clusterInfo[oldCluster].members.filter(url=>url!==d.id);
    if(clusterInfo[oldCluster].killerPage===d.id) clusterInfo[oldCluster].killerPage=null;
  }
  if(newCluster>=0&&clusterInfo[newCluster]) clusterInfo[newCluster].members.push(d.id);

  d.cluster=newCluster;
  computeClusterMetrics();
  updateNodeVisuals();
  rebuildClusterPanel();
  simulation.alpha(0.15).restart();
  editCount++;
  updateExportStatus();
}

function toggleKiller(d){
  const ci=d.cluster;
  if(ci<0||!clusterInfo[ci]) return;
  clusterInfo[ci].killerPage=(clusterInfo[ci].killerPage===d.id)?null:d.id;

  nodeElements.selectAll(".killer-ring").transition().duration(200)
    .attr("r",n=>{const nc=n.cluster;if(nc>=0&&clusterInfo[nc]&&n.id===clusterInfo[nc].killerPage) return nodeRadius(n)+4;return 0});

  rebuildClusterPanel();
  editCount++;
  updateExportStatus();
}

function updateNodeVisuals(){
  if(panelMode==="cluster"){
    circles.transition().duration(300).attr("fill",d=>clusterColorMap[d.cluster!==undefined?d.cluster:-1]||"#636e72");
  }
  nodeElements.selectAll(".killer-ring").transition().duration(200)
    .attr("r",n=>{const nc=n.cluster;if(nc>=0&&clusterInfo[nc]&&n.id===clusterInfo[nc].killerPage) return nodeRadius(n)+4;return 0});
  linkElements.transition().duration(300)
    .attr("stroke",d=>{if(!clusterMode)return"#4a9eff";const sc=d.source.cluster!==undefined?d.source.cluster:-1;const tc=d.target.cluster!==undefined?d.target.cluster:-1;if(sc>=0&&sc===tc)return clusterColorMap[sc]||"#4a9eff";return"#555"})
    .attr("stroke-opacity",d=>{if(!clusterMode)return 0.18;const sc=d.source.cluster!==undefined?d.source.cluster:-1;const tc=d.target.cluster!==undefined?d.target.cluster:-1;if(sc>=0&&sc===tc)return 0.3;return 0.04})
    .attr("stroke-width",d=>{if(!clusterMode)return 0.9;const sc=d.source.cluster!==undefined?d.source.cluster:-1;const tc=d.target.cluster!==undefined?d.target.cluster:-1;if(sc>=0&&sc===tc)return 1.2;return 0.5});
}

function updateExportStatus(){
  const st=document.getElementById("export-status");
  if(st) st.textContent=editCount+"件の変更あり";
}

function resetView(){
  circles.transition().duration(200).attr("opacity",0.85);
  labels.transition().duration(200).attr("fill-opacity",1);
  // リンクフィルタモードに応じた色でリセット
  if(linkFilter==="none"){
    linkElements.transition().duration(200).attr("stroke-opacity",0).attr("stroke-width",0);
  } else {
    const baseColor=linkFilter==="in"?"#26de81":linkFilter==="out"?"#4a9eff":"#4a9eff";
    linkElements.transition().duration(200).attr("stroke-opacity",0.18).attr("stroke-width",0.9).attr("stroke",baseColor);
  }
  updateLabelsForZoom(currentZoomK);
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

  if(clusterMode&&clusterInfo){
    const ci=d.cluster;
    if(ci>=0&&clusterInfo[ci]){
      const cc=clusterColorMap[ci];
      h+='<div style="margin-bottom:10px;padding:6px 10px;background:rgba(255,255,255,0.03);border-left:3px solid '+cc+';border-radius:4px;font-size:11px">';
      h+='<span style="color:'+cc+';font-weight:600">'+clusterInfo[ci].name+'</span>';
      if(d.id===clusterInfo[ci].killerPage) h+=' <span style="color:#ffd700">★ キラーページ</span>';
      h+='<span style="color:#666;margin-left:8px">健全度: '+clusterInfo[ci].healthScore+'/100</span>';
      h+='</div>';
    } else {
      h+='<div style="margin-bottom:10px;padding:6px 10px;font-size:11px;color:#636e72">未分類ページ</div>';
    }
  }

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

  // ===== クラスター健全度セクション =====
  if(clusterMode&&clusterInfo&&clusterMetrics.length>0){
    computeClusterMetrics();
    const sorted_cm=[...clusterMetrics].sort((a,b)=>a.score-b.score);
    const avgScore=clusterMetrics.length>0?Math.round(clusterMetrics.reduce((s,m)=>s+m.score,0)/clusterMetrics.length):0;
    const dangerCount=clusterMetrics.filter(m=>m.score<40).length;
    const warnCount=clusterMetrics.filter(m=>m.score>=40&&m.score<65).length;
    const goodCount=clusterMetrics.filter(m=>m.score>=65).length;

    h+='<div style="margin-bottom:14px">';
    h+='<h4 style="font-size:12px;color:#888;margin-bottom:8px;display:flex;align-items:center;gap:6px">クラスター健全度</h4>';

    // サマリー
    h+='<div class="ch-summary">';
    h+='<div class="ch-summary-item"><div class="num" style="color:#ff4757">'+dangerCount+'</div><div class="lbl">要改善</div></div>';
    h+='<div class="ch-summary-item"><div class="num" style="color:#ff9f43">'+warnCount+'</div><div class="lbl">注意</div></div>';
    h+='<div class="ch-summary-item"><div class="num" style="color:#26de81">'+goodCount+'</div><div class="lbl">良好</div></div>';
    h+='<div class="ch-summary-item"><div class="num" style="color:#4a9eff">'+avgScore+'</div><div class="lbl">平均点</div></div>';
    h+='</div>';

    // 各クラスターカード（スコア低い順）
    sorted_cm.forEach(m=>{
      const scoreColor=m.score<40?"#ff4757":m.score<65?"#ff9f43":"#26de81";
      const cc=clusterColorMap[m.idx]||"#888";
      h+='<div class="ch-card" data-cluster-focus="'+m.idx+'">';
      h+='<div class="ch-head">';
      h+='<div class="ch-dot" style="background:'+cc+'"></div>';
      h+='<div class="ch-name" style="color:'+cc+'">'+m.name+'</div>';
      h+='<div class="ch-score" style="color:'+scoreColor+'">'+m.score+'</div>';
      h+='</div>';

      // メトリクス
      h+='<div class="ch-metrics">';
      const dVal=Math.round(m.density*100);
      h+='<div class="ch-metric"><span>内部リンク密度</span><span class="val '+(dVal<5?"bad":dVal<10?"warn":"good")+'">'+dVal+'%</span></div>';
      const kVal=Math.round(m.killerReach*100);
      h+='<div class="ch-metric"><span>キラー到達率</span><span class="val '+(kVal<30?"bad":kVal<60?"warn":"good")+'">'+kVal+'%</span></div>';
      h+='<div class="ch-metric"><span>孤立ページ</span><span class="val '+(m.orphans.length>0?"bad":"good")+'">'+m.orphans.length+'件</span></div>';
      h+='<div class="ch-metric"><span>被リンク平均</span><span class="val '+(m.avgInbound<3?"bad":m.avgInbound<7?"warn":"good")+'">'+m.avgInbound.toFixed(1)+'</span></div>';
      h+='<div class="ch-metric"><span>記事数</span><span class="val '+(m.size<3?"warn":"good")+'">'+m.size+'</span></div>';
      h+='<div class="ch-metric"><span>内部リンク数</span><span class="val">'+(m.internalEdges||0)+'</span></div>';
      h+='</div>';

      // 改善推奨
      if(m.recs.length>0){
        h+='<div class="ch-recs">';
        m.recs.forEach(r=>{
          const icon=r.level==="danger"?"⚠":r.level==="warning"?"△":"ℹ";
          h+='<div class="ch-rec rec-'+r.level+'"><span class="rec-icon">'+icon+'</span><span>'+r.text+'</span></div>';
        });
        h+='</div>';
      }

      // リンク提案
      const ls=linkSuggestions[m.idx];
      if(ls&&ls.suggestions.length>0){
        const typeLabel={"killer-to-member":"KP→","member-to-killer":"→KP","orphan-rescue":"孤立","density-boost":"密度"};
        const typeClass={"killer-to-member":"t-ktm","member-to-killer":"t-mtk","orphan-rescue":"t-orph","density-boost":"t-dens"};
        h+='<div class="ls-section">';
        h+='<div class="ls-header">提案リンク <span class="ls-count">'+ls.suggestions.length+'件</span></div>';
        ls.suggestions.slice(0,8).forEach((s,si)=>{
          const pCls=s.priority==="high"?"ls-high":"ls-medium";
          h+='<div class="ls-item '+pCls+'" data-ls-src="'+s.source+'" data-ls-tgt="'+s.target+'">';
          h+='<span class="ls-type '+typeClass[s.type]+'">'+(typeLabel[s.type]||s.type)+'</span>';
          h+='<span class="ls-src">'+s.sourceLabel+'</span>';
          h+='<span class="ls-arrow">→</span>';
          h+='<span class="ls-tgt">'+s.targetLabel+'</span>';
          h+='</div>';
        });
        if(ls.suggestions.length>8) h+='<div style="font-size:8px;color:#555;padding:2px 6px">他 '+(ls.suggestions.length-8)+'件…</div>';
        h+='</div>';
      }

      h+='</div>';
    });
    h+='</div>';
  }

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

  // クラスターカードクリック → そのクラスターのノード群にフォーカス
  panel.querySelectorAll(".ch-card[data-cluster-focus]").forEach(el=>{
    el.addEventListener("click",()=>{
      const ci=parseInt(el.dataset.clusterFocus);
      const cn=clusterNodeMap[ci];
      if(!cn||cn.length===0) return;
      const xs=cn.map(n=>n.x),ys=cn.map(n=>n.y);
      const x0=Math.min(...xs)-80,x1=Math.max(...xs)+80,y0=Math.min(...ys)-80,y1=Math.max(...ys)+80;
      const bw=x1-x0,bh=y1-y0;
      const scale=Math.min(width/bw,height/bh)*0.8;
      const tx=width/2-(x0+bw/2)*scale,ty=height/2-(y0+bh/2)*scale;
      svg.transition().duration(600).call(zoomBehavior.transform,d3.zoomIdentity.translate(tx,ty).scale(scale));
      // クラスターメンバーのみハイライト
      const ids=new Set(cn.map(n=>n.id));
      circles.transition().duration(200).attr("opacity",n=>ids.has(n.id)?1:0.06);
      labels.transition().duration(200).attr("fill-opacity",n=>ids.has(n.id)?1:0.06);
    });
  });

  // リンク提案クリック → source/targetの2ノードをハイライト
  panel.querySelectorAll(".ls-item[data-ls-src]").forEach(el=>{
    el.addEventListener("click",e=>{
      e.stopPropagation();
      const srcId=el.dataset.lsSrc;
      const tgtId=el.dataset.lsTgt;
      const pair=new Set([srcId,tgtId]);
      const sn=nodes.find(n=>n.id===srcId);
      const tn=nodes.find(n=>n.id===tgtId);
      if(!sn||!tn) return;
      const cx=(sn.x+tn.x)/2,cy=(sn.y+tn.y)/2;
      const dx=Math.abs(sn.x-tn.x)+120,dy=Math.abs(sn.y-tn.y)+120;
      const scale=Math.min(width/dx,height/dy)*0.7;
      const tx=width/2-cx*scale,ty=height/2-cy*scale;
      svg.transition().duration(600).call(zoomBehavior.transform,d3.zoomIdentity.translate(tx,ty).scale(scale));
      circles.transition().duration(200).attr("opacity",n=>pair.has(n.id)?1:0.06);
      labels.transition().duration(200).attr("fill-opacity",n=>pair.has(n.id)?1:0.06);
      linkElements.transition().duration(200).attr("stroke-opacity",l=>{
        const s=typeof l.source==="object"?l.source.id:l.source;
        const t=typeof l.target==="object"?l.target.id:l.target;
        return (pair.has(s)&&pair.has(t))?0.8:0.02;
      });
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
  // ハイライト（接続ノードも表示 + リンクフィルタ考慮）
  const connectedIds=new Set([nd.id]);
  links.forEach(l=>{
    const s=typeof l.source==="object"?l.source.id:l.source;
    const t=typeof l.target==="object"?l.target.id:l.target;
    if(linkFilter==="in"){
      if(t===nd.id) connectedIds.add(s);
    } else if(linkFilter==="out"){
      if(s===nd.id) connectedIds.add(t);
    } else {
      if(s===nd.id) connectedIds.add(t);
      if(t===nd.id) connectedIds.add(s);
    }
  });
  circles.transition().duration(200).attr("opacity",n=>connectedIds.has(n.id)?1:0.08);
  labels.transition().duration(200).attr("fill-opacity",n=>connectedIds.has(n.id)?1:0.08);
  applyLinkFilter();
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

// ===== クラスターフィルター（アコーディオン） =====
let panelMode="section";

function rebuildClusterPanel(){
  if(!clusterMode||!clusterInfo) return;
  const clusterContainer=d3.select("#cluster-filters");
  clusterContainer.selectAll(".cluster-item").remove();

  function buildClusterItem(container,ci,name,color,memberNodes,killerUrl){
    const wrapper=container.append("div").attr("class","cluster-item").attr("data-cluster",ci);
    const header=wrapper.append("div").attr("class","cluster-header");
    header.append("span").attr("class","cluster-arrow").text("▶");
    header.append("div").attr("class","filter-dot").style("background",color);
    header.append("span").text(name+" ("+memberNodes.length+")");
    header.append("span").attr("class","cluster-eye").attr("title","表示/非表示").text("👁")
      .on("click",function(e){e.stopPropagation();this.classList.toggle("hidden-eye");applyClusterFilters()});

    header.on("click",function(){
      this.classList.toggle("expanded");
      const members=this.parentNode.querySelector(".cluster-members");
      if(members) members.classList.toggle("open");
    });

    // ヘルスバー
    if(ci>=0&&clusterMetrics[ci]){
      const sc=clusterMetrics[ci].score;
      const barColor=sc<40?"#ff4757":sc<65?"#ff9f43":"#26de81";
      const bar=wrapper.append("div").attr("class","cluster-health-bar");
      bar.append("div").attr("class","fill").style("width",sc+"%").style("background",barColor);
    }

    const membersDiv=wrapper.append("div").attr("class","cluster-members");
    memberNodes.forEach(mn=>{
      const label=(mn.label||mn.path||mn.id).replace(/\\s*[|｜\\-–—].*$/,"").slice(0,30);
      const row=membersDiv.append("div").attr("class","cluster-member").attr("data-url",mn.id);
      if(killerUrl&&mn.id===killerUrl) row.append("span").attr("class","km").text("★");
      row.append("span").text(label);
      row.on("click",function(){focusNode(mn.id)});
    });
  }

  clusterInfo.forEach((c,i)=>{
    const color=clusterColorMap[i];
    const memberNodes=(clusterNodeMap[i]||[]).slice().sort((a,b)=>(inCount[b.id]||0)-(inCount[a.id]||0));
    buildClusterItem(clusterContainer,i,c.name,color,memberNodes,c.killerPage);
  });

  const unclNodes=(clusterNodeMap[-1]||[]).slice().sort((a,b)=>(inCount[b.id]||0)-(inCount[a.id]||0));
  if(unclNodes.length>0){
    buildClusterItem(clusterContainer,-1,"未分類","#636e72",unclNodes,null);
  }
}

if(clusterMode&&clusterInfo){
  rebuildClusterPanel();

  const toggleBtn=document.getElementById("btn-toggle-panel-mode");
  if(toggleBtn){
    toggleBtn.addEventListener("click",function(){
      if(panelMode==="section"){
        panelMode="cluster";
        this.textContent="セクション";
        this.classList.add("active");
        document.getElementById("group-filters").style.display="none";
        document.getElementById("cluster-filters").style.display="block";
        document.getElementById("cluster-export-wrap").style.display="block";
        document.getElementById("left-panel-title").textContent="クラスター";
        circles.transition().duration(300).attr("fill",d=>clusterColorMap[d.cluster!==undefined?d.cluster:-1]||"#636e72");
      } else {
        panelMode="section";
        this.textContent="クラスター";
        this.classList.remove("active");
        document.getElementById("group-filters").style.display="block";
        document.getElementById("cluster-filters").style.display="none";
        document.getElementById("cluster-export-wrap").style.display="none";
        document.getElementById("left-panel-title").textContent="セクション";
        circles.transition().duration(300).attr("fill",d=>groupColors[d.group]||"#888");
      }
    });
    // 初期状態: クラスターモードをON
    toggleBtn.click();
  }

  // エクスポートボタン
  document.getElementById("btn-export-clusters").addEventListener("click",function(){
    const exported={clusters:[],unclustered:[]};
    clusterInfo.forEach((c,i)=>{
      exported.clusters.push({
        name:c.name,
        killerPage:c.killerPage||null,
        healthScore:c.healthScore||0,
        members:(clusterNodeMap[i]||[]).map(n=>n.id)
      });
    });
    exported.unclustered=(clusterNodeMap[-1]||[]).map(n=>n.id);
    const blob=new Blob([JSON.stringify(exported,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download="clusters.json";
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const st=document.getElementById("export-status");
    if(st){st.textContent="エクスポート完了!";st.style.color="#26de81";setTimeout(()=>{st.style.color="#555";updateExportStatus()},2000)}
  });

  // チェックリストCSVエクスポート
  document.getElementById("btn-export-checklist").addEventListener("click",function(){
    generateLinkSuggestions();
    const BOM="\\uFEFF";
    const header=["クラスター名","優先度","提案タイプ","ソースURL","ソースタイトル","ターゲットURL","ターゲットタイトル","理由","完了"].join(",");
    const rows=[header];
    const typeNames={"killer-to-member":"KP→メンバー","member-to-killer":"メンバー→KP","orphan-rescue":"孤立ページ解消","density-boost":"密度向上"};
    const prioNames={"high":"高","medium":"中","low":"低"};
    linkSuggestions.forEach(ls=>{
      ls.suggestions.forEach(s=>{
        const esc=v=>'"'+String(v||"").replace(/"/g,'""')+'"';
        rows.push([
          esc(ls.clusterName),
          esc(prioNames[s.priority]||s.priority),
          esc(typeNames[s.type]||s.type),
          esc(s.source),
          esc(s.sourceLabel),
          esc(s.target),
          esc(s.targetLabel),
          esc(s.reason),
          ""
        ].join(","));
      });
    });
    const csvContent=BOM+rows.join("\\n");
    const blob=new Blob([csvContent],{type:"text/csv;charset=utf-8;"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download="link-checklist.csv";
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const st2=document.getElementById("export-status");
    if(st2){st2.textContent="チェックリスト出力完了!";st2.style.color="#4a9eff";setTimeout(()=>{st2.style.color="#555";updateExportStatus()},2000)}
  });
}

function applyClusterFilters(){
  const hidden=new Set();
  document.querySelectorAll("#cluster-filters .cluster-eye.hidden-eye")
    .forEach(el=>hidden.add(parseInt(el.closest(".cluster-item").dataset.cluster)));
  nodeElements.style("display",d=>hidden.has(d.cluster)?"none":null);
  linkElements.style("display",l=>{
    const s=typeof l.source==="object"?l.source:nodes.find(n=>n.id===l.source);
    const t=typeof l.target==="object"?l.target:nodes.find(n=>n.id===l.target);
    return (hidden.has(s?.cluster)||hidden.has(t?.cluster))?"none":null;
  });
  if(hullG){
    hullG.selectAll("path.cluster-hull").style("display",d=>hidden.has(d.idx)?"none":null);
    hullG.selectAll("text.cluster-label").style("display",d=>hidden.has(d.idx)?"none":null);
  }
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
setTimeout(()=>{document.getElementById("zoom-fit").click()},3500);
<\/script>
</body>
</html>`;
}

main().catch(err=>{console.error("エラー:",err);process.exit(1)});
