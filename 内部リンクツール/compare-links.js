#!/usr/bin/env node
/**
 * compare-links.js — 内部リンク差分比較ツール
 *
 * 使い方:
 *   node compare-links.js <before.json> <after.json> [options]
 *
 * オプション:
 *   --output, -o <file>       出力ファイル名（デフォルト: link-diff-report.md）
 *   --actions <file>          cluster-strategy の --export-json 出力と照合
 *   --export-json <file>      構造化差分データのJSON出力
 *
 * before.json / after.json は analyze-links.js --export-data で生成した crawl-data.json
 */

const fs = require("fs");
const path = require("path");

// ===== CLI引数パース =====
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { beforeFile: null, afterFile: null, output: "link-diff-report.md", actions: null, exportJson: null };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--output": case "-o":
        result.output = args[++i]; break;
      case "--actions":
        result.actions = args[++i]; break;
      case "--export-json":
        result.exportJson = args[++i]; break;
      case "--help": case "-h":
        printUsage(); process.exit(0);
      default:
        if (args[i].startsWith("-")) { console.error(`不明なオプション: ${args[i]}`); process.exit(1); }
        positional.push(args[i]);
    }
  }

  if (positional.length < 2) {
    console.error("エラー: before.json と after.json の2つのファイルを指定してください。");
    printUsage();
    process.exit(1);
  }
  result.beforeFile = positional[0];
  result.afterFile = positional[1];
  return result;
}

function printUsage() {
  console.log(`
使い方: node compare-links.js <before.json> <after.json> [options]

  <before.json>             改善前の crawl-data.json
  <after.json>              改善後の crawl-data.json

オプション:
  --output, -o <file>       出力ファイル名（デフォルト: link-diff-report.md）
  --actions <file>          cluster-strategy --export-json の出力と照合
  --export-json <file>      構造化差分データのJSON出力
  --help, -h                ヘルプ表示
`);
}

// ===== データ読み込み =====
function loadPair(beforePath, afterPath) {
  const loadOne = (filePath) => {
    if (!fs.existsSync(filePath)) {
      console.error(`エラー: ファイルが見つかりません: ${filePath}`);
      process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!raw.edges || !raw.nodes) {
      console.error(`エラー: ${filePath} は analyze-links.js --export-data の出力形式ではありません。`);
      process.exit(1);
    }
    return raw;
  };

  return { before: loadOne(beforePath), after: loadOne(afterPath) };
}

// ===== エッジ差分 =====
function diffEdges(before, after) {
  // エッジをキー化
  const edgeKey = (e) => `${e.source}→${e.target}`;

  const beforeMap = new Map();
  for (const e of before.edges) {
    beforeMap.set(edgeKey(e), e);
  }
  const afterMap = new Map();
  for (const e of after.edges) {
    afterMap.set(edgeKey(e), e);
  }

  const added = [];
  const removed = [];
  const unchanged = [];
  const anchorChanged = [];

  // afterにあってbeforeにないもの = 追加
  for (const [key, e] of afterMap) {
    if (!beforeMap.has(key)) {
      added.push(e);
    } else {
      unchanged.push(e);
      // アンカーテキスト変更チェック
      const bEdge = beforeMap.get(key);
      if (bEdge.anchorText !== e.anchorText) {
        anchorChanged.push({
          source: e.source,
          target: e.target,
          anchorBefore: bEdge.anchorText,
          anchorAfter: e.anchorText,
        });
      }
    }
  }

  // beforeにあってafterにないもの = 削除
  for (const [key, e] of beforeMap) {
    if (!afterMap.has(key)) {
      removed.push(e);
    }
  }

  return { added, removed, unchanged, anchorChanged };
}

// ===== ページ別カウント差分 =====
function diffCounts(before, after) {
  // ノードタイトルのマップ（after優先、なければbefore）
  const titleMap = new Map();
  for (const n of before.nodes) titleMap.set(n.id, n.label);
  for (const n of after.nodes) titleMap.set(n.id, n.label);

  // 全URLを収集
  const allUrls = new Set([
    ...Object.keys(before.inCount || {}),
    ...Object.keys(after.inCount || {}),
    ...Object.keys(before.outCount || {}),
    ...Object.keys(after.outCount || {}),
  ]);

  const changes = [];
  for (const url of allUrls) {
    const inB = (before.inCount || {})[url] || 0;
    const inA = (after.inCount || {})[url] || 0;
    const outB = (before.outCount || {})[url] || 0;
    const outA = (after.outCount || {})[url] || 0;

    changes.push({
      url,
      title: titleMap.get(url) || url,
      inBefore: inB,
      inAfter: inA,
      inDelta: inA - inB,
      outBefore: outB,
      outAfter: outA,
      outDelta: outA - outB,
    });
  }

  // 被リンク変化の絶対値でソート（大きい順）
  changes.sort((a, b) => Math.abs(b.inDelta) - Math.abs(a.inDelta));
  return changes;
}

// ===== ページ差分（新規・削除ページ） =====
function diffPages(before, after) {
  const beforeUrls = new Set(before.nodes.filter(n => n.crawled).map(n => n.id));
  const afterUrls = new Set(after.nodes.filter(n => n.crawled).map(n => n.id));

  const titleMap = new Map();
  for (const n of before.nodes) titleMap.set(n.id, n.label);
  for (const n of after.nodes) titleMap.set(n.id, n.label);

  const addedPages = [];
  const removedPages = [];

  for (const url of afterUrls) {
    if (!beforeUrls.has(url)) {
      addedPages.push({ url, title: titleMap.get(url) || url });
    }
  }
  for (const url of beforeUrls) {
    if (!afterUrls.has(url)) {
      removedPages.push({ url, title: titleMap.get(url) || url });
    }
  }

  return { addedPages, removedPages };
}

// ===== アクション照合 =====
function matchActions(addedEdges, actionsFile) {
  if (!actionsFile) return null;

  if (!fs.existsSync(actionsFile)) {
    console.warn(`警告: アクションファイルが見つかりません: ${actionsFile}`);
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(actionsFile, "utf-8"));

  // sortedActions から source→target ペアを取得
  const actions = (raw.sortedActions || []).map(a => ({
    type: a.type,
    source: a.source,
    target: a.target,
    cluster: a.cluster,
    priority: a.priority,
  }));

  if (actions.length === 0) {
    console.warn("警告: アクションファイルにアクションが含まれていません。");
    return null;
  }

  // 追加されたエッジをセット化
  const addedSet = new Set(addedEdges.map(e => `${e.source}→${e.target}`));

  // 重複アクション（同じsource→target）を統合
  const seen = new Set();
  const uniqueActions = [];
  for (const a of actions) {
    const key = `${a.source}→${a.target}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueActions.push(a);
    }
  }

  const completed = [];
  const pending = [];

  for (const a of uniqueActions) {
    const key = `${a.source}→${a.target}`;
    if (addedSet.has(key)) {
      completed.push(a);
    } else {
      pending.push(a);
    }
  }

  // 提案にない追加リンク
  const actionSet = new Set(uniqueActions.map(a => `${a.source}→${a.target}`));
  const extraAdded = addedEdges.filter(e => !actionSet.has(`${e.source}→${e.target}`));

  return {
    total: uniqueActions.length,
    completed,
    pending,
    extraAdded,
    completionRate: uniqueActions.length > 0
      ? Math.round(completed.length / uniqueActions.length * 100)
      : 0,
  };
}

// ===== サマリー計算 =====
function computeSummary(before, after, edgeDiff, countDiff) {
  const inIncreased = countDiff.filter(c => c.inDelta > 0).length;
  const inDecreased = countDiff.filter(c => c.inDelta < 0).length;

  const bestImproved = countDiff.find(c => c.inDelta > 0);

  return {
    pagesBefore: before.meta.totalPages,
    pagesAfter: after.meta.totalPages,
    edgesBefore: before.meta.totalEdges,
    edgesAfter: after.meta.totalEdges,
    added: edgeDiff.added.length,
    removed: edgeDiff.removed.length,
    netChange: edgeDiff.added.length - edgeDiff.removed.length,
    unchanged: edgeDiff.unchanged.length,
    anchorChanged: edgeDiff.anchorChanged.length,
    inIncreased,
    inDecreased,
    bestImproved,
    dateBefore: before.meta.exportedAt,
    dateAfter: after.meta.exportedAt,
  };
}

// ===== タイトル短縮 =====
function shorten(title, maxLen = 50) {
  if (!title) return "(不明)";
  return title.length > maxLen ? title.slice(0, maxLen) + "…" : title;
}

// ===== タイトル取得 =====
function getTitleForUrl(url, before, after) {
  const nodeB = before.nodes.find(n => n.id === url);
  const nodeA = after.nodes.find(n => n.id === url);
  return (nodeA && nodeA.label) || (nodeB && nodeB.label) || url;
}

// ===== Markdownレポート生成 =====
function generateReport(summary, edgeDiff, countDiff, pageDiff, actionMatch, before, after) {
  const lines = [];
  const L = (s) => lines.push(s);

  const fmtDate = (iso) => {
    if (!iso) return "(不明)";
    const d = new Date(iso);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  L("# 内部リンク差分レポート");
  L("");
  L(`**生成日時**: ${fmtDate(new Date().toISOString())}`);
  L(`**比較期間**: ${fmtDate(summary.dateBefore)} → ${fmtDate(summary.dateAfter)}`);
  L("");
  L("---");
  L("");

  // === 改善サマリー ===
  L("## 改善サマリー");
  L("");
  L("| 指標 | 改善前 | 改善後 | 増減 |");
  L("|---|---|---|---|");
  L(`| クロール済みページ数 | ${summary.pagesBefore} | ${summary.pagesAfter} | ${fmtDelta(summary.pagesAfter - summary.pagesBefore)} |`);
  L(`| 総リンク数 | ${summary.edgesBefore} | ${summary.edgesAfter} | ${fmtDelta(summary.netChange)} |`);
  L("");
  L("| 指標 | 件数 |");
  L("|---|---|");
  L(`| 追加されたリンク | **${summary.added}件** |`);
  L(`| 削除されたリンク | ${summary.removed}件 |`);
  L(`| 純増リンク数 | ${fmtDelta(summary.netChange)} |`);
  L(`| 変更なしリンク | ${summary.unchanged}件 |`);
  L(`| アンカーテキスト変更 | ${summary.anchorChanged}件 |`);
  L(`| 被リンク増加ページ | ${summary.inIncreased}ページ |`);
  L(`| 被リンク減少ページ | ${summary.inDecreased}ページ |`);
  L("");

  if (summary.bestImproved) {
    L(`**最大改善ページ**: ${shorten(summary.bestImproved.title, 60)}（被リンク ${fmtDelta(summary.bestImproved.inDelta)}）`);
    L("");
  }

  // === アクション消化状況 ===
  if (actionMatch) {
    L("---");
    L("");
    L("## アクション消化状況");
    L("");
    L(`戦略レポートで提案された改善アクションの対応状況です。`);
    L("");
    L(`| 指標 | 件数 |`);
    L(`|---|---|`);
    L(`| 提案アクション総数（重複除外） | ${actionMatch.total}件 |`);
    L(`| 対応済み | **${actionMatch.completed.length}件** |`);
    L(`| 未対応 | ${actionMatch.pending.length}件 |`);
    L(`| 消化率 | **${actionMatch.completionRate}%** |`);
    L(`| 提案外の追加リンク | ${actionMatch.extraAdded.length}件 |`);
    L("");

    if (actionMatch.completed.length > 0) {
      L("### 対応済みアクション");
      L("");
      L("| # | 種別 | リンク元 | → | リンク先 |");
      L("|---|---|---|---|---|");
      actionMatch.completed.forEach((a, i) => {
        L(`| ${i + 1} | ${a.type} | ${shorten(getTitleForUrl(a.source, before, after))} | → | ${shorten(getTitleForUrl(a.target, before, after))} |`);
      });
      L("");
    }

    if (actionMatch.pending.length > 0) {
      L("### 未対応アクション（残りの改善タスク）");
      L("");
      L("| # | 優先度 | 種別 | リンク元 | → | リンク先 |");
      L("|---|---|---|---|---|---|");
      actionMatch.pending.forEach((a, i) => {
        L(`| ${i + 1} | ${a.priority} | ${a.type} | ${shorten(getTitleForUrl(a.source, before, after))} | → | ${shorten(getTitleForUrl(a.target, before, after))} |`);
      });
      L("");
    }
  }

  L("---");
  L("");

  // === 追加されたリンク ===
  L("## 追加されたリンク一覧");
  L("");
  if (edgeDiff.added.length === 0) {
    L("追加されたリンクはありません。");
  } else {
    L(`${edgeDiff.added.length}件のリンクが新しく追加されました。`);
    L("");
    L("| # | リンク元 | → | リンク先 | アンカーテキスト |");
    L("|---|---|---|---|---|");
    edgeDiff.added.forEach((e, i) => {
      L(`| ${i + 1} | ${shorten(getTitleForUrl(e.source, before, after))} | → | ${shorten(getTitleForUrl(e.target, before, after))} | ${shorten(e.anchorText || "(なし)", 30)} |`);
    });
  }
  L("");
  L("---");
  L("");

  // === 削除されたリンク ===
  L("## 削除されたリンク一覧");
  L("");
  if (edgeDiff.removed.length === 0) {
    L("削除されたリンクはありません。");
  } else {
    L(`⚠ ${edgeDiff.removed.length}件のリンクが削除されています。意図しない削除がないか確認してください。`);
    L("");
    L("| # | リンク元 | → | リンク先 | アンカーテキスト |");
    L("|---|---|---|---|---|");
    edgeDiff.removed.forEach((e, i) => {
      L(`| ${i + 1} | ${shorten(getTitleForUrl(e.source, before, after))} | → | ${shorten(getTitleForUrl(e.target, before, after))} | ${shorten(e.anchorText || "(なし)", 30)} |`);
    });
  }
  L("");
  L("---");
  L("");

  // === ページ別被リンク変化 ===
  L("## ページ別 被リンク変化 (TOP 20)");
  L("");
  const topChanges = countDiff.filter(c => c.inDelta !== 0).slice(0, 20);
  if (topChanges.length === 0) {
    L("被リンク数に変化のあったページはありません。");
  } else {
    L("| # | ページ | 改善前 | 改善後 | 増減 |");
    L("|---|---|---|---|---|");
    topChanges.forEach((c, i) => {
      const mark = c.inDelta > 0 ? "↑" : "↓";
      L(`| ${i + 1} | ${shorten(c.title)} | ${c.inBefore} | ${c.inAfter} | ${mark} ${fmtDelta(c.inDelta)} |`);
    });
  }
  L("");
  L("---");
  L("");

  // === 新規・削除ページ ===
  if (pageDiff.addedPages.length > 0 || pageDiff.removedPages.length > 0) {
    L("## ページ増減");
    L("");
    if (pageDiff.addedPages.length > 0) {
      L("### 新規ページ");
      L("");
      pageDiff.addedPages.forEach((p, i) => {
        L(`${i + 1}. ${shorten(p.title, 60)}`);
        L(`   ${p.url}`);
      });
      L("");
    }
    if (pageDiff.removedPages.length > 0) {
      L("### 削除/未検出ページ");
      L("");
      L("⚠ 以下のページが改善後のクロールで見つかりませんでした。");
      L("");
      pageDiff.removedPages.forEach((p, i) => {
        L(`${i + 1}. ${shorten(p.title, 60)}`);
        L(`   ${p.url}`);
      });
      L("");
    }
    L("---");
    L("");
  }

  // === アンカーテキスト変更 ===
  if (edgeDiff.anchorChanged.length > 0) {
    L("## アンカーテキスト変更");
    L("");
    L(`同一リンクでアンカーテキストが変更された ${edgeDiff.anchorChanged.length}件です。`);
    L("");
    L("| # | リンク先 | 変更前 | → | 変更後 |");
    L("|---|---|---|---|---|");
    edgeDiff.anchorChanged.forEach((c, i) => {
      L(`| ${i + 1} | ${shorten(getTitleForUrl(c.target, before, after))} | ${shorten(c.anchorBefore, 25)} | → | ${shorten(c.anchorAfter, 25)} |`);
    });
    L("");
  }

  return lines.join("\n");
}

function fmtDelta(n) {
  if (n > 0) return `+${n}`;
  if (n < 0) return `${n}`;
  return "±0";
}

// ===== メイン =====
function main() {
  const args = parseArgs();

  console.log("内部リンク差分比較ツール v1.0");
  console.log(`  改善前: ${args.beforeFile}`);
  console.log(`  改善後: ${args.afterFile}`);
  if (args.actions) console.log(`  アクション照合: ${args.actions}`);
  console.log("");

  // データ読み込み
  console.log("データ読み込み中...");
  const { before, after } = loadPair(args.beforeFile, args.afterFile);
  console.log(`  改善前: ${before.meta.totalPages}ページ / ${before.meta.totalEdges}リンク (${before.meta.exportedAt})`);
  console.log(`  改善後: ${after.meta.totalPages}ページ / ${after.meta.totalEdges}リンク (${after.meta.exportedAt})`);

  // エッジ差分
  console.log("\nリンク差分を計算中...");
  const edgeDiff = diffEdges(before, after);
  console.log(`  追加: ${edgeDiff.added.length}件`);
  console.log(`  削除: ${edgeDiff.removed.length}件`);
  console.log(`  変更なし: ${edgeDiff.unchanged.length}件`);
  console.log(`  アンカー変更: ${edgeDiff.anchorChanged.length}件`);

  // ページ別カウント差分
  console.log("\nページ別変化を計算中...");
  const countDiff = diffCounts(before, after);

  // ページ差分
  const pageDiff = diffPages(before, after);
  if (pageDiff.addedPages.length > 0) console.log(`  新規ページ: ${pageDiff.addedPages.length}件`);
  if (pageDiff.removedPages.length > 0) console.log(`  削除ページ: ${pageDiff.removedPages.length}件`);

  // アクション照合
  let actionMatch = null;
  if (args.actions) {
    console.log("\nアクション照合中...");
    actionMatch = matchActions(edgeDiff.added, args.actions);
    if (actionMatch) {
      console.log(`  提案アクション: ${actionMatch.total}件`);
      console.log(`  対応済み: ${actionMatch.completed.length}件 (${actionMatch.completionRate}%)`);
      console.log(`  未対応: ${actionMatch.pending.length}件`);
    }
  }

  // サマリー
  const summary = computeSummary(before, after, edgeDiff, countDiff);

  // レポート生成
  console.log("\nレポート生成中...");
  const report = generateReport(summary, edgeDiff, countDiff, pageDiff, actionMatch, before, after);
  fs.writeFileSync(args.output, report, "utf-8");
  console.log(`\n✓ 差分レポート出力完了: ${args.output}`);

  // JSON出力（オプション）
  if (args.exportJson) {
    const jsonOut = {
      meta: {
        generatedAt: new Date().toISOString(),
        beforeFile: args.beforeFile,
        afterFile: args.afterFile,
        dateBefore: before.meta.exportedAt,
        dateAfter: after.meta.exportedAt,
      },
      summary: {
        pagesBefore: summary.pagesBefore,
        pagesAfter: summary.pagesAfter,
        edgesBefore: summary.edgesBefore,
        edgesAfter: summary.edgesAfter,
        added: summary.added,
        removed: summary.removed,
        netChange: summary.netChange,
      },
      addedEdges: edgeDiff.added,
      removedEdges: edgeDiff.removed,
      anchorChanged: edgeDiff.anchorChanged,
      countChanges: countDiff.filter(c => c.inDelta !== 0 || c.outDelta !== 0),
      actionMatch: actionMatch ? {
        total: actionMatch.total,
        completedCount: actionMatch.completed.length,
        pendingCount: actionMatch.pending.length,
        completionRate: actionMatch.completionRate,
        completedActions: actionMatch.completed,
        pendingActions: actionMatch.pending,
      } : null,
    };
    fs.writeFileSync(args.exportJson, JSON.stringify(jsonOut, null, 2), "utf-8");
    console.log(`✓ JSONデータ出力完了: ${args.exportJson}`);
  }

  // 最終サマリー
  console.log("\n--- 差分サマリー ---");
  console.log(`  リンク追加: ${summary.added}件`);
  console.log(`  リンク削除: ${summary.removed}件`);
  console.log(`  純増: ${fmtDelta(summary.netChange)}`);
  console.log(`  被リンク増加: ${summary.inIncreased}ページ`);
  console.log(`  被リンク減少: ${summary.inDecreased}ページ`);
  if (actionMatch) {
    console.log(`  アクション消化率: ${actionMatch.completionRate}% (${actionMatch.completed.length}/${actionMatch.total})`);
  }
  console.log("");
}

main();
