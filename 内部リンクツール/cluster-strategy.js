#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

// ===== 定数 =====
const DEFAULT_OUTPUT = "cluster-strategy-report.md";
const DEFAULT_MIN_CLUSTER = 3;
const DEFAULT_TOP_ACTIONS = 30;
const MERGE_THRESHOLD = 0.25;

// SEO用語の正規化マップ（類義語を同一キーワードに統合）
const KEYWORD_NORMALIZE = {
  "seo": "SEO", "seo対策": "SEO", "seo施策": "SEO", "検索エンジン最適化": "SEO",
  "オウンドメディア": "オウンドメディア", "ownedmedia": "オウンドメディア", "owned": "オウンドメディア",
  "内部リンク": "内部対策", "内部対策": "内部対策", "内部施策": "内部対策",
  "外部リンク": "外部対策", "被リンク": "外部対策", "バックリンク": "外部対策", "backlink": "外部対策",
  "キーワード": "キーワード", "keyword": "キーワード",
  "コンテンツ": "コンテンツ", "content": "コンテンツ", "記事": "コンテンツ",
  "集客": "集客", "attracting": "集客", "customer": "集客",
  "対策": "対策", "measures": "対策", "施策": "対策",
  "会社": "会社", "業者": "会社", "company": "会社",
  "メディア": "メディア", "media": "メディア",
  "サイト": "サイト", "site": "サイト", "ホームページ": "サイト",
  "ドメイン": "ドメイン", "domain": "ドメイン",
  "順位": "順位", "ranking": "順位", "ランキング": "順位",
  "検索": "検索", "search": "検索",
  "不動産": "不動産", "real": "不動産", "estate": "不動産",
};

// ===== 引数パース =====
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
トピッククラスター戦略ツール

使い方:
  node cluster-strategy.js <crawl-data.json> [options]

入力:
  crawl-data.json   analyze-links.js --export-data で出力したJSONファイル

オプション:
  --killer-pages, -k <file>   キラーページ設定ファイル（省略時: 自動検出）
  --output, -o <file>         出力レポートファイル名 (デフォルト: ${DEFAULT_OUTPUT})
  --export-json <file>        構造化データのJSON出力
  --min-cluster-size <n>      最小クラスターサイズ (デフォルト: ${DEFAULT_MIN_CLUSTER})
  --top-actions <n>           優先アクション表示数 (デフォルト: ${DEFAULT_TOP_ACTIONS})
  --help, -h                  ヘルプ表示

使用例:
  # Step 1: クロールデータをエクスポート
  node analyze-links.js urls-extage.txt -o map.html --export-data crawl-data.json

  # Step 2: 戦略レポート生成（自動検出モード）
  node cluster-strategy.js crawl-data.json

  # Step 2b: キラーページを指定して生成
  node cluster-strategy.js crawl-data.json -k killer-pages.txt -o report.md
`);
    process.exit(0);
  }

  let inputFile = null;
  let killerPagesFile = null;
  let output = DEFAULT_OUTPUT;
  let exportJson = null;
  let minClusterSize = DEFAULT_MIN_CLUSTER;
  let topActions = DEFAULT_TOP_ACTIONS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" || args[i] === "-o") output = args[++i];
    else if (args[i] === "--killer-pages" || args[i] === "-k") killerPagesFile = args[++i];
    else if (args[i] === "--export-json") exportJson = args[++i];
    else if (args[i] === "--min-cluster-size") minClusterSize = parseInt(args[++i], 10);
    else if (args[i] === "--top-actions") topActions = parseInt(args[++i], 10);
    else if (!args[i].startsWith("-")) inputFile = args[i];
  }

  if (!inputFile) { console.error("エラー: crawl-data.json を指定してください"); process.exit(1); }
  return { inputFile, killerPagesFile, output, exportJson, minClusterSize, topActions };
}

// ===== データ読み込み =====
function loadData(filePath) {
  if (!fs.existsSync(filePath)) { console.error(`エラー: ファイルが見つかりません: ${filePath}`); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (!raw.nodes || !raw.edges) { console.error("エラー: 不正なデータ形式です。analyze-links.js --export-data で生成してください"); process.exit(1); }
  return raw;
}

function loadKillerPages(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  const killerPages = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(.+?):\s*(https?:\/\/.+)$/);
    if (match) {
      killerPages[match[1].trim()] = match[2].trim();
    }
  }
  return killerPages;
}

// ===== ユーティリティ =====
function getLabel(url, data) {
  const node = data.nodes.find(n => n.id === url);
  if (!node) return url;
  return node.label.replace(/\s*[|｜\-–—].*$/, "").slice(0, 40);
}

function getSlugTokens(url) {
  try {
    const slug = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    return slug.split("-").filter(t => t.length >= 2);
  } catch { return []; }
}

function jaccardSimilarity(arrA, arrB) {
  const a = new Set(arrA), b = new Set(arrB);
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

// ===== キーワードインデックス構築 =====
function extractKeywords(text) {
  if (!text) return [];
  return text
    .replace(/[「」『』【】（）()\[\]、。・!！?？]/g, " ")
    .split(/[\s,\-_/|｜]+/)
    .map(w => w.toLowerCase().trim())
    .filter(w => w.length >= 2)
    .map(w => KEYWORD_NORMALIZE[w] || w);
}

function buildKeywordIndex(data) {
  const pageKeywords = {};
  const keywordPages = {};

  // エッジセットを事前構築（高速化）
  const incomingAnchors = {};
  for (const e of data.edges) {
    if (!incomingAnchors[e.target]) incomingAnchors[e.target] = [];
    incomingAnchors[e.target].push(e.anchorText);
  }

  for (const node of data.nodes) {
    if (!node.crawled) continue;
    const url = node.id;
    const keywords = new Set();

    // タイトルからキーワード抽出
    const titleClean = node.label.replace(/\s*[|｜\-–—].*$/, "").trim();
    for (const kw of extractKeywords(titleClean)) keywords.add(kw);

    // URLスラッグからキーワード抽出
    for (const token of getSlugTokens(url)) {
      const normalized = KEYWORD_NORMALIZE[token] || token;
      keywords.add(normalized);
    }

    // 被リンクのアンカーテキストからキーワード抽出
    if (incomingAnchors[url]) {
      for (const anchor of incomingAnchors[url]) {
        for (const kw of extractKeywords(anchor)) keywords.add(kw);
      }
    }

    pageKeywords[url] = keywords;
    for (const kw of keywords) {
      if (!keywordPages[kw]) keywordPages[kw] = new Set();
      keywordPages[kw].add(url);
    }
  }

  return { pageKeywords, keywordPages };
}

// ===== クラスタリング =====
function computeSimilarity(a, b, data, keywordIndex, edgeSet, targetsOf, sourcesOf) {
  // Signal 1: URLスラッグ類似度 (0.3)
  const slugA = getSlugTokens(a);
  const slugB = getSlugTokens(b);
  const slugSim = jaccardSimilarity(slugA, slugB);

  // Signal 2: キーワード類似度 (0.4)
  const kwA = keywordIndex.pageKeywords[a] || new Set();
  const kwB = keywordIndex.pageKeywords[b] || new Set();
  const kwSim = jaccardSimilarity([...kwA], [...kwB]);

  // Signal 3: リンク接続度 (0.3)
  const directLink = (edgeSet.has(`${a}→${b}`) || edgeSet.has(`${b}→${a}`)) ? 1.0 : 0;
  const tA = targetsOf[a] || new Set();
  const tB = targetsOf[b] || new Set();
  const commonTargets = [...tA].filter(x => tB.has(x)).length;
  const sA = sourcesOf[a] || new Set();
  const sB = sourcesOf[b] || new Set();
  const commonSources = [...sA].filter(x => sB.has(x)).length;
  const linkSim = Math.min(1.0, directLink * 0.5 + (commonTargets + commonSources) * 0.05);

  return 0.3 * slugSim + 0.4 * kwSim + 0.3 * linkSim;
}

function clusterPages(data, keywordIndex, minClusterSize) {
  const crawledPages = data.nodes.filter(n => n.crawled).map(n => n.id);
  const N = crawledPages.length;

  // 事前にエッジ情報を構築
  const edgeSet = new Set(data.edges.map(e => `${e.source}→${e.target}`));
  const targetsOf = {};
  const sourcesOf = {};
  for (const e of data.edges) {
    if (!targetsOf[e.source]) targetsOf[e.source] = new Set();
    targetsOf[e.source].add(e.target);
    if (!sourcesOf[e.target]) sourcesOf[e.target] = new Set();
    sourcesOf[e.target].add(e.source);
  }

  // 類似度マトリクス構築
  const simMatrix = {};
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const a = crawledPages[i], b = crawledPages[j];
      const sim = computeSimilarity(a, b, data, keywordIndex, edgeSet, targetsOf, sourcesOf);
      if (sim > 0.15) {
        simMatrix[`${a}|||${b}`] = sim;
        simMatrix[`${b}|||${a}`] = sim;
      }
    }
  }

  // 凝集型階層クラスタリング（平均連結法）
  let clusters = crawledPages.map(url => ({ members: [url] }));

  while (true) {
    let bestSim = 0, bestI = -1, bestJ = -1;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        // 平均連結の類似度
        let totalSim = 0, count = 0;
        for (const a of clusters[i].members) {
          for (const b of clusters[j].members) {
            const key = `${a}|||${b}`;
            totalSim += simMatrix[key] || 0;
            count++;
          }
        }
        const avgSim = count > 0 ? totalSim / count : 0;
        if (avgSim > bestSim) {
          bestSim = avgSim; bestI = i; bestJ = j;
        }
      }
    }

    if (bestSim < MERGE_THRESHOLD || bestI === -1) break;

    // マージ
    clusters[bestI].members.push(...clusters[bestJ].members);
    clusters.splice(bestJ, 1);
  }

  // クラスターサイズでフィルタリング
  const validClusters = [];
  const unclustered = [];
  for (const c of clusters) {
    if (c.members.length >= minClusterSize) {
      validClusters.push(c);
    } else {
      unclustered.push(...c.members);
    }
  }

  // クラスター命名
  for (const c of validClusters) {
    c.name = generateClusterName(c.members, keywordIndex);
  }

  // ページ数降順でソート
  validClusters.sort((a, b) => b.members.length - a.members.length);

  return { clusters: validClusters, unclustered };
}

function generateClusterName(members, keywordIndex) {
  const kwFreq = {};
  for (const url of members) {
    const kws = keywordIndex.pageKeywords[url] || new Set();
    for (const kw of kws) {
      kwFreq[kw] = (kwFreq[kw] || 0) + 1;
    }
  }
  // 汎用すぎるキーワード（全クラスターに出現しうるもの）を除外
  const genericWords = new Set(["SEO", "対策", "サイト", "コンテンツ", "web", "school", "extage"]);

  const sorted = Object.entries(kwFreq)
    .filter(([kw, count]) => count >= members.length * 0.4 && !genericWords.has(kw))
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length >= 2) return `${sorted[0][0]}・${sorted[1][0]}`;
  if (sorted.length === 1) return sorted[0][0];

  // フォールバック: 汎用ワードも許可
  const fallback = Object.entries(kwFreq)
    .filter(([, count]) => count >= members.length * 0.5)
    .sort((a, b) => b[1] - a[1]);
  return fallback.length > 0 ? fallback[0][0] : `クラスター(${members.length}ページ)`;
}

// ===== キラーページ特定 =====
function identifyKillerPages(clusters, data, userKillerPages) {
  for (const cluster of clusters) {
    // ユーザー指定のキラーページをチェック
    const userUrl = userKillerPages[cluster.name];
    if (userUrl && cluster.members.includes(userUrl)) {
      cluster.killerPage = userUrl;
      cluster.killerPageSource = "ユーザー指定";
      continue;
    }
    if (userUrl) {
      console.warn(`  ⚠ 「${cluster.name}」: 指定URL ${userUrl} がクラスター内に見つかりません → 自動検出`);
    }

    // 自動検出
    let bestScore = -1, bestUrl = null;
    for (const url of cluster.members) {
      const score = computeKillerScore(url, cluster, data);
      if (score > bestScore) { bestScore = score; bestUrl = url; }
    }
    cluster.killerPage = bestUrl;
    cluster.killerPageScore = bestScore;
    cluster.killerPageSource = "自動検出";
  }
}

function computeKillerScore(url, cluster, data) {
  const inCount = data.inCount[url] || 0;
  const outCount = data.outCount[url] || 0;
  const node = data.nodes.find(n => n.id === url);
  const title = node ? node.label : "";

  // クラスター内で正規化
  const clusterInCounts = cluster.members.map(u => data.inCount[u] || 0);
  const maxIn = Math.max(...clusterInCounts, 1);
  const clusterOutCounts = cluster.members.map(u => data.outCount[u] || 0);
  const maxOut = Math.max(...clusterOutCounts, 1);

  // Score 1: 被リンク数 (0.35)
  const inScore = inCount / maxIn;

  // Score 2: タイトル汎用性 (0.25) — 短いほどピラー的
  const titleClean = title.replace(/\s*[|｜\-–—].*$/, "").trim();
  const titleBreadthScore = Math.max(0, 1 - (titleClean.length - 5) / 40);

  // Score 3: 発リンク数 (0.20) — ハブ性
  const outScore = outCount / maxOut;

  // Score 4: クラスター内接続 (0.10)
  const clusterSet = new Set(cluster.members);
  const internalLinks = data.edges.filter(e =>
    (e.source === url && clusterSet.has(e.target)) ||
    (e.target === url && clusterSet.has(e.source))
  ).length;
  const maxInternal = cluster.members.length * 2;
  const internalScore = internalLinks / maxInternal;

  // Score 5: スラッグ汎用性 (0.10) — 短いスラッグほど包括的
  const slugParts = getSlugTokens(url).length;
  const slugBreadthScore = Math.max(0, 1 - (slugParts - 1) / 6);

  return 0.35 * inScore + 0.25 * titleBreadthScore + 0.20 * outScore
       + 0.10 * internalScore + 0.10 * slugBreadthScore;
}

// ===== クラスター健全度 =====
function computeClusterHealth(cluster, data) {
  const killerUrl = cluster.killerPage;
  const clusterSet = new Set(cluster.members);
  const edgeSet = new Set(data.edges.map(e => `${e.source}→${e.target}`));
  const spokes = cluster.members.filter(u => u !== killerUrl);

  if (spokes.length === 0) return 100;

  let spokesToKiller = 0;
  let pagesWithClusterInbound = 0;
  let totalClusterInbound = 0;

  for (const url of spokes) {
    if (edgeSet.has(`${url}→${killerUrl}`)) spokesToKiller++;
    const clusterIn = data.edges.filter(e => e.target === url && clusterSet.has(e.source)).length;
    if (clusterIn > 0) pagesWithClusterInbound++;
    totalClusterInbound += clusterIn;
  }

  const spokeToKillerRatio = spokesToKiller / spokes.length;
  const clusterInboundRatio = pagesWithClusterInbound / spokes.length;
  const avgClusterInbound = totalClusterInbound / spokes.length;
  const avgInboundScore = Math.min(1, avgClusterInbound / 3);

  return Math.round(spokeToKillerRatio * 40 + clusterInboundRatio * 35 + avgInboundScore * 25);
}

// ===== ギャップ分析 =====
function analyzeGaps(clusters, data, keywordIndex) {
  const edgeSet = new Set(data.edges.map(e => `${e.source}→${e.target}`));
  const allGaps = [];

  for (const cluster of clusters) {
    const killerUrl = cluster.killerPage;

    // Gap A: spoke→killer 不足
    for (const url of cluster.members) {
      if (url === killerUrl) continue;
      if (!edgeSet.has(`${url}→${killerUrl}`)) {
        allGaps.push({
          type: "spoke→killer不足",
          source: url,
          target: killerUrl,
          cluster: cluster.name,
        });
      }
    }

    // Gap B: killer→spoke 不足
    for (const url of cluster.members) {
      if (url === killerUrl) continue;
      if (!edgeSet.has(`${killerUrl}→${url}`)) {
        allGaps.push({
          type: "killer→spoke不足",
          source: killerUrl,
          target: url,
          cluster: cluster.name,
        });
      }
    }

    // Gap D: クラスター内孤立
    const clusterSet = new Set(cluster.members);
    for (const url of cluster.members) {
      if (url === killerUrl) continue;
      const clusterInbound = data.edges.filter(e => e.target === url && clusterSet.has(e.source)).length;
      if (clusterInbound === 0) {
        allGaps.push({
          type: "クラスター内孤立",
          source: killerUrl,
          target: url,
          cluster: cluster.name,
        });
      }
    }
  }

  // Gap C: クロスクラスター
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const cA = clusters[i], cB = clusters[j];
      const kwOverlap = computeClusterKeywordOverlap(cA, cB, keywordIndex);

      if (kwOverlap > 0.15) {
        if (!edgeSet.has(`${cA.killerPage}→${cB.killerPage}`)) {
          allGaps.push({
            type: "クロスクラスター",
            source: cA.killerPage,
            target: cB.killerPage,
            cluster: `${cA.name} → ${cB.name}`,
            kwOverlap,
          });
        }
        if (!edgeSet.has(`${cB.killerPage}→${cA.killerPage}`)) {
          allGaps.push({
            type: "クロスクラスター",
            source: cB.killerPage,
            target: cA.killerPage,
            cluster: `${cB.name} → ${cA.name}`,
            kwOverlap,
          });
        }
      }
    }
  }

  return allGaps;
}

function computeClusterKeywordOverlap(cA, cB, keywordIndex) {
  const kwsA = new Set();
  for (const url of cA.members) {
    const kws = keywordIndex.pageKeywords[url] || new Set();
    for (const kw of kws) kwsA.add(kw);
  }
  const kwsB = new Set();
  for (const url of cB.members) {
    const kws = keywordIndex.pageKeywords[url] || new Set();
    for (const kw of kws) kwsB.add(kw);
  }
  return jaccardSimilarity([...kwsA], [...kwsB]);
}

// ===== 優先度スコアリング =====
function scorePriority(gap, clusters, data) {
  const cluster = clusters.find(c => c.name === gap.cluster || c.members.includes(gap.source) || c.members.includes(gap.target));

  // Impact: リンク先の被リンク数が少ないほど高い
  const targetIn = data.inCount[gap.target] || 0;
  let impactScore = Math.max(0, 100 - targetIn * 8);

  // キラーページ宛はボーナス
  if (cluster && gap.target === cluster.killerPage) impactScore = Math.min(100, impactScore + 20);

  // spoke→killer型は全体的に優先度高め
  if (gap.type === "spoke→killer不足") impactScore = Math.min(100, impactScore + 10);

  // Effort: 既存コンテンツへのリンク追加は一律70
  const effortScore = 70;

  // Health: クラスター健全度が低いほど優先度高い
  const healthScore = cluster ? (100 - (cluster.healthScore || 50)) : 50;

  return Math.round(Math.min(100, 0.50 * impactScore + 0.20 * effortScore + 0.30 * healthScore));
}

// ===== レポート生成 =====
function healthToStars(score) {
  if (score >= 80) return "\u2605\u2605\u2605\u2605\u2605";
  if (score >= 60) return "\u2605\u2605\u2605\u2605\u2606";
  if (score >= 40) return "\u2605\u2605\u2605\u2606\u2606";
  if (score >= 20) return "\u2605\u2605\u2606\u2606\u2606";
  return "\u2605\u2606\u2606\u2606\u2606";
}

function generateReport(clusters, unclustered, allGaps, sortedActions, data) {
  let md = "";

  // ヘッダー
  md += "# トピッククラスター戦略レポート\n\n";
  md += `**生成日時**: ${new Date().toLocaleString("ja-JP")}\n`;
  md += `**データソース**: ${data.meta.urlFile} (${data.meta.totalPages}ページ / ${data.meta.totalEdges}リンク)\n`;
  md += `**クラスター数**: ${clusters.length} + 未分類 ${unclustered.length}ページ\n\n`;
  md += "---\n\n";

  // ===== 全体サマリー =====
  md += "## 全体サマリー\n\n";
  md += "| クラスター | ページ数 | キラーページ | 健全度 | 不足リンク数 |\n";
  md += "|---|---|---|---|---|\n";
  for (const c of clusters) {
    const stars = healthToStars(c.healthScore);
    const label = getLabel(c.killerPage, data);
    const gapCount = allGaps.filter(g => g.cluster === c.name || c.members.includes(g.source) || c.members.includes(g.target)).length;
    md += `| ${c.name} | ${c.members.length} | ${label} | ${stars} (${c.healthScore}/100) | ${gapCount} |\n`;
  }
  md += "\n";

  // 健全度の基準
  md += "### 健全度の基準\n\n";
  md += "- \u2605\u2605\u2605\u2605\u2605 (80-100): クラスター内リンクが充実。キラーページへの集約も十分\n";
  md += "- \u2605\u2605\u2605\u2605\u2606 (60-79): 概ね良好。一部の不足リンクを追加すれば完成\n";
  md += "- \u2605\u2605\u2605\u2606\u2606 (40-59): 改善の余地あり。キラーページへの導線が不足\n";
  md += "- \u2605\u2605\u2606\u2606\u2606 (20-39): 要改善。クラスター内の相互リンクが弱い\n";
  md += "- \u2605\u2606\u2606\u2606\u2606 (0-19): 危険。ほぼリンクが存在しない\n\n";
  md += "---\n\n";

  // ===== 優先アクションリスト =====
  md += `## 優先アクションリスト (TOP ${sortedActions.length})\n\n`;
  md += "内部リンクの追加効果が高い順に並べた改善アクションです。\n\n";
  md += "| # | 優先度 | 種別 | リンク元 | → | リンク先 | クラスター |\n";
  md += "|---|---|---|---|---|---|---|\n";
  sortedActions.forEach((action, i) => {
    const srcLabel = getLabel(action.source, data);
    const tgtLabel = getLabel(action.target, data);
    md += `| ${i + 1} | ${action.priority} | ${action.type} | ${srcLabel} | → | ${tgtLabel} | ${action.cluster} |\n`;
  });
  md += "\n---\n\n";

  // ===== クラスター詳細 =====
  md += "## クラスター詳細\n\n";
  clusters.forEach((c, idx) => {
    const edgeSet = new Set(data.edges.map(e => `${e.source}→${e.target}`));
    const clusterSet = new Set(c.members);

    md += `### ${idx + 1}. ${c.name} (${c.members.length}ページ)\n\n`;

    // キラーページ情報
    const killerLabel = getLabel(c.killerPage, data);
    const killerIn = data.inCount[c.killerPage] || 0;
    const killerOut = data.outCount[c.killerPage] || 0;
    md += `**キラーページ**: ${killerLabel}\n`;
    md += `- URL: ${c.killerPage}\n`;
    md += `- 被リンク: ${killerIn}件 / 発リンク: ${killerOut}件\n`;
    md += `- 選定理由: ${c.killerPageSource}${c.killerPageScore ? ` (スコア: ${(c.killerPageScore * 100).toFixed(0)})` : ""}\n\n`;

    // 健全度
    const stars = healthToStars(c.healthScore);
    const spokes = c.members.filter(u => u !== c.killerPage);
    const spokesToKiller = spokes.filter(u => edgeSet.has(`${u}→${c.killerPage}`)).length;
    const clusterInboundPages = spokes.filter(u => data.edges.some(e => e.target === u && clusterSet.has(e.source))).length;
    md += `**健全度**: ${stars} (${c.healthScore}/100)\n`;
    md += `- spoke→killer接続率: ${spokes.length > 0 ? Math.round(spokesToKiller / spokes.length * 100) : 100}% (${spokesToKiller}/${spokes.length}ページ)\n`;
    md += `- クラスター内被リンク率: ${spokes.length > 0 ? Math.round(clusterInboundPages / spokes.length * 100) : 100}%\n\n`;

    // ページ一覧テーブル
    md += "#### クラスター内ページ一覧\n\n";
    md += "| ページ | 被リンク | 発リンク | →killer | killer→ |\n";
    md += "|---|---|---|---|---|\n";

    // キラーページを先頭に、残りは被リンク降順
    const sorted = [...c.members].sort((a, b) => {
      if (a === c.killerPage) return -1;
      if (b === c.killerPage) return 1;
      return (data.inCount[b] || 0) - (data.inCount[a] || 0);
    });

    for (const url of sorted) {
      const label = url === c.killerPage ? `**★ ${getLabel(url, data)}**` : getLabel(url, data);
      const inC = data.inCount[url] || 0;
      const outC = data.outCount[url] || 0;
      const toKiller = url === c.killerPage ? "-" : (edgeSet.has(`${url}→${c.killerPage}`) ? "✓" : "✗");
      const fromKiller = url === c.killerPage ? "-" : (edgeSet.has(`${c.killerPage}→${url}`) ? "✓" : "✗");
      md += `| ${label} | ${inC} | ${outC} | ${toKiller} | ${fromKiller} |\n`;
    }
    md += "\n";

    // このクラスターのギャップ
    const clusterGaps = allGaps.filter(g =>
      g.cluster === c.name && (g.type === "spoke→killer不足" || g.type === "killer→spoke不足" || g.type === "クラスター内孤立")
    );
    if (clusterGaps.length > 0) {
      md += "#### 不足リンク（要追加）\n\n";
      clusterGaps.forEach((g, gi) => {
        const srcLabel = getLabel(g.source, data);
        const tgtLabel = getLabel(g.target, data);
        md += `${gi + 1}. **「${srcLabel}」→「${tgtLabel}」** (${g.type})\n`;
      });
      md += "\n";
    }

    md += "---\n\n";
  });

  // ===== 未分類ページ =====
  if (unclustered.length > 0) {
    md += `## 未分類ページ (${unclustered.length}ページ)\n\n`;
    md += "以下のページはどのクラスターにも十分な関連性がありませんでした。\n";
    md += "新しいクラスターの作成、または既存クラスターへの統合を検討してください。\n\n";
    md += "| ページ | 被リンク | 発リンク | URL |\n";
    md += "|---|---|---|---|\n";
    for (const url of unclustered) {
      const label = getLabel(url, data);
      const inC = data.inCount[url] || 0;
      const outC = data.outCount[url] || 0;
      const shortUrl = new URL(url).pathname;
      md += `| ${label} | ${inC} | ${outC} | ${shortUrl} |\n`;
    }
    md += "\n---\n\n";
  }

  // ===== クロスクラスター接続マップ =====
  const crossGaps = allGaps.filter(g => g.type === "クロスクラスター");
  if (crossGaps.length > 0 || clusters.length > 1) {
    md += "## クロスクラスター接続マップ\n\n";
    md += "関連するクラスター間のキラーページ同士の接続状況です。\n\n";
    md += "| クラスターA | → | クラスターB | 接続 | KW類似度 |\n";
    md += "|---|---|---|---|---|\n";

    const edgeSet = new Set(data.edges.map(e => `${e.source}→${e.target}`));
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const cA = clusters[i], cB = clusters[j];
        const kwOverlap = computeClusterKeywordOverlap(cA, cB, keywordIndex);
        if (kwOverlap > 0.1) {
          const aToB = edgeSet.has(`${cA.killerPage}→${cB.killerPage}`);
          const bToA = edgeSet.has(`${cB.killerPage}→${cA.killerPage}`);
          let status;
          if (aToB && bToA) status = "✓ 双方向";
          else if (aToB) status = "→ 片方向";
          else if (bToA) status = "← 片方向";
          else status = "✗ 未接続";
          md += `| ${cA.name} | ⇔ | ${cB.name} | ${status} | ${kwOverlap.toFixed(2)} |\n`;
        }
      }
    }
    md += "\n";
  }

  return md;
}

// ===== メイン処理 =====
// keywordIndex をレポート生成でも使うためモジュールスコープに退避
let keywordIndex;

async function main() {
  const args = parseArgs();

  console.log("\n===== トピッククラスター戦略ツール =====\n");

  // データ読み込み
  const data = loadData(args.inputFile);
  const crawledCount = data.nodes.filter(n => n.crawled).length;
  console.log(`データ読み込み完了: ${crawledCount}ページ / ${data.edges.length}リンク`);

  const userKillerPages = loadKillerPages(args.killerPagesFile);
  if (Object.keys(userKillerPages).length > 0) {
    console.log(`キラーページ設定: ${Object.keys(userKillerPages).length}件読み込み`);
  }

  // キーワードインデックス構築
  console.log("キーワードインデックス構築中...");
  keywordIndex = buildKeywordIndex(data);
  const kwCount = Object.keys(keywordIndex.keywordPages).length;
  console.log(`→ ${kwCount}種類のキーワードを抽出`);

  // クラスタリング
  console.log("トピッククラスタリング実行中...");
  const { clusters, unclustered } = clusterPages(data, keywordIndex, args.minClusterSize);
  console.log(`→ ${clusters.length}クラスター検出 + 未分類${unclustered.length}ページ`);

  // キラーページ特定
  console.log("キラーページ特定中...");
  identifyKillerPages(clusters, data, userKillerPages);
  for (const c of clusters) {
    console.log(`  ${c.name}: ${getLabel(c.killerPage, data)} (${c.killerPageSource})`);
  }

  // クラスター健全度計算
  for (const c of clusters) {
    c.healthScore = computeClusterHealth(c, data);
  }

  // ギャップ分析
  console.log("ギャップ分析中...");
  const allGaps = analyzeGaps(clusters, data, keywordIndex);
  console.log(`→ ${allGaps.length}件のギャップを検出`);

  // 優先度スコアリング
  console.log("優先度スコアリング中...");
  for (const gap of allGaps) {
    gap.priority = scorePriority(gap, clusters, data);
  }
  const sortedActions = [...allGaps].sort((a, b) => b.priority - a.priority).slice(0, args.topActions);

  // レポート生成
  console.log("レポート生成中...");
  const report = generateReport(clusters, unclustered, allGaps, sortedActions, data);
  fs.writeFileSync(args.output, report, "utf-8");
  console.log(`\n✓ レポート出力完了: ${args.output}`);

  // JSON出力（オプション）
  if (args.exportJson) {
    const jsonOut = {
      meta: { ...data.meta, generatedAt: new Date().toISOString() },
      clusters: clusters.map(c => ({
        name: c.name,
        killerPage: c.killerPage,
        killerPageSource: c.killerPageSource,
        healthScore: c.healthScore,
        members: c.members,
      })),
      unclustered,
      gaps: allGaps,
      sortedActions,
    };
    fs.writeFileSync(args.exportJson, JSON.stringify(jsonOut, null, 2), "utf-8");
    console.log(`✓ JSONデータ出力完了: ${args.exportJson}`);
  }

  // サマリー
  console.log("\n--- サマリー ---");
  const totalGapSpToK = allGaps.filter(g => g.type === "spoke→killer不足").length;
  const totalGapKToS = allGaps.filter(g => g.type === "killer→spoke不足").length;
  const totalGapOrphan = allGaps.filter(g => g.type === "クラスター内孤立").length;
  const totalGapCross = allGaps.filter(g => g.type === "クロスクラスター").length;
  console.log(`  spoke→killer不足: ${totalGapSpToK}件`);
  console.log(`  killer→spoke不足: ${totalGapKToS}件`);
  console.log(`  クラスター内孤立: ${totalGapOrphan}件`);
  console.log(`  クロスクラスター: ${totalGapCross}件`);
  console.log(`  合計: ${allGaps.length}件\n`);
}

main().catch(err => { console.error("エラー:", err); process.exit(1); });
