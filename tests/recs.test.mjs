import test from "node:test";
import assert from "node:assert/strict";
import { parseLen, parseRecResults, parseSearchResults, parseQueueItems } from "../lib/recs.mjs";

test("parseLen: 時刻文字列を秒へ", () => {
  assert.equal(parseLen("3:04"), 184);
  assert.equal(parseLen("1:02:03"), 3723);
  assert.equal(parseLen("0:59"), 59);
  assert.equal(parseLen("配信中"), null);
  assert.equal(parseLen(""), null);
  assert.equal(parseLen(null), null);
});

// compactVideoRenderer(旧形)の実データ風フィクスチャ
const COMPACT_FIXTURE = [
  {
    compactVideoRenderer: {
      videoId: "abc123",
      title: { runs: [{ text: "夜に駆ける" }] },
      longBylineText: { runs: [{ text: "Yorushika" }, { text: "  •  " }, { text: "1億回視聴" }] },
      lengthText: { simpleText: "4:24" },
    },
  },
  { continuationItemRenderer: { trigger: "CONTINUATION_TRIGGER_ON_ITEM_SHOWN" } }, // 「もっと見る」等は無視
  {
    lockupViewModel: {
      contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
      contentId: "def456",
      metadata: {
        lockupMetadataViewModel: {
          title: { content: "だから僕は音楽を辞めた" },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [
                { metadataParts: [{ text: { content: "Yorushika" } }] },
                { metadataParts: [{ text: { content: "5:11" } }, { text: { content: "HD" } }] },
              ],
            },
          },
        },
      },
    },
  },
];

test("parseRecResults: compact と lockup の混在を受ける", () => {
  const out = parseRecResults(COMPACT_FIXTURE);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: "abc123", title: "夜に駆ける", author: "Yorushika  •  1億回視聴", len: 264 });
  assert.deepEqual(out[1], { id: "def456", title: "だから僕は音楽を辞めた", author: "Yorushika", len: 311 });
});

test("parseRecResults: 重複IDは1件に潰す", () => {
  const dup = [
    { compactVideoRenderer: { videoId: "abc123", title: { runs: [{ text: "A" }] } } },
    { lockupViewModel: { contentId: "abc123", metadata: { lockupMetadataViewModel: { title: { content: "B" } } } } },
  ];
  assert.equal(parseRecResults(dup).length, 1);
});

test("parseRecResults: 変な入力で壊れない", () => {
  assert.deepEqual(parseRecResults(null), []);
  assert.deepEqual(parseRecResults("x"), []);
  assert.deepEqual(parseRecResults([{}, { lockupViewModel: {} }, 7]), []);
});

test("parseSearchResults: videoRenderer を拾う", () => {
  const data = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    { videoRenderer: { videoId: "s1", title: { runs: [{ text: "曲1" }] }, ownerText: { runs: [{ text: "歌手" }] }, lengthText: { simpleText: "3:33" } } },
                    { videoRenderer: { videoId: "s2", title: { runs: [{ text: "曲2" }] } } },
                    { compactVideoRenderer: { videoId: "zzz" } }, // 検索結果に混ざらない形は拾わない
                  ],
                },
              },
              { itemSectionRenderer: { contents: [{ videoRenderer: { videoId: "s3", title: { runs: [{ text: "曲3" }] } } }] } },
            ],
          },
        },
      },
    },
  };
  const out = parseSearchResults(data);
  assert.deepEqual(out.map(r => r.id), ["s1", "s2", "s3"]);
  assert.equal(out[0].len, 213);
  assert.deepEqual(parseSearchResults(null), []);
});

test("parseQueueItems: キューのIDと曲名を順序通りに返す", () => {
  const out = parseQueueItems([
    { videoId: "q1aaaaaaaaa", title: { simpleText: "曲A" }, lengthText: { simpleText: "3:00" } },
    { videoId: "q2bbbbbbbbb", title: { runs: [{ text: "曲B" }] } },
    { videoId: "bad" }, // 11文字未満は落とす
    { videoId: "q1aaaaaaaaa" }, // 重複は落とす
  ]);
  assert.deepEqual(out, [
    { id: "q1aaaaaaaaa", title: "曲A", author: "", len: 180 },
    { id: "q2bbbbbbbbb", title: "曲B", author: "", len: null },
  ]);
  assert.deepEqual(parseQueueItems(null), []);
});
