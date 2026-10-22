import test from "node:test";
import assert from "node:assert/strict";
import {
  extractVideoId, extractListId, isMixListId,
  mixUrl, watchUrl, searchUrl, withTime, thumbUrl,
} from "../lib/urlutil.mjs";

test("extractVideoId: URL各形と生ID", () => {
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=drIcTb-gwPs"), "drIcTb-gwPs");
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=drIcTb-gwPs&list=RDdrIcTb-gwPs&start_radio=1"), "drIcTb-gwPs");
  assert.equal(extractVideoId("https://youtu.be/drIcTb-gwPs?t=30"), "drIcTb-gwPs");
  assert.equal(extractVideoId("https://www.youtube.com/shorts/drIcTb-gwPs"), "drIcTb-gwPs");
  assert.equal(extractVideoId("https://www.youtube.com/live/drIcTb-gwPs?feature=share"), "drIcTb-gwPs");
  assert.equal(extractVideoId("drIcTb-gwPs"), "drIcTb-gwPs");
  assert.equal(extractVideoId(" https://www.youtube.com/watch?v=drIcTb-gwPs "), "drIcTb-gwPs");
});

test("extractVideoId: 非対応入力はnull", () => {
  assert.equal(extractVideoId(""), null);
  assert.equal(extractVideoId(null), null);
  assert.equal(extractVideoId("https://example.com/watch?v=short"), null);
  assert.equal(extractVideoId("夜しか歌わない"), null);
});

test("extractListId と isMixListId", () => {
  assert.equal(extractListId("https://www.youtube.com/watch?v=drIcTb-gwPs&list=RDdrIcTb-gwPs&start_radio=1"), "RDdrIcTb-gwPs");
  assert.equal(extractListId("https://www.youtube.com/playlist?list=PL1234abcd_-"), "PL1234abcd_-");
  assert.equal(extractListId("https://www.youtube.com/watch?v=x"), null);
  assert.ok(isMixListId("RDdrIcTb-gwPs"));
  assert.ok(isMixListId("RDMMdrIcTb-gwPs"));
  assert.equal(isMixListId("PL1234abcd"), false);
  assert.equal(isMixListId(null), false);
});

test("mixUrl / watchUrl / searchUrl", () => {
  assert.equal(mixUrl("drIcTb-gwPs"), "https://www.youtube.com/watch?v=drIcTb-gwPs&list=RDdrIcTb-gwPs&start_radio=1");
  assert.equal(watchUrl("drIcTb-gwPs"), "https://www.youtube.com/watch?v=drIcTb-gwPs");
  assert.ok(searchUrl("ヨルシカ 夜に駆ける").includes("search_query=%E3%83%A8%E3%83%AB%E3%82%B7%E3%82%AB"));
});

test("withTime: t を設定・更新し他パラメータを温存する", () => {
  assert.equal(
    withTime("https://www.youtube.com/watch?v=drIcTb-gwPs&list=RDdrIcTb-gwPs", 90),
    "https://www.youtube.com/watch?v=drIcTb-gwPs&list=RDdrIcTb-gwPs&t=90s",
  );
  assert.equal(
    withTime("https://www.youtube.com/watch?v=drIcTb-gwPs&t=5s", 130.7),
    "https://www.youtube.com/watch?v=drIcTb-gwPs&t=130s",
  );
  // v 無しのURLは手を付けない
  assert.equal(withTime("https://www.youtube.com/", 10), "https://www.youtube.com/");
});

test("thumbUrl: 品質の未知値は hq に落ちる", () => {
  assert.equal(thumbUrl("drIcTb-gwPs", "maxres"), "https://i.ytimg.com/vi/drIcTb-gwPs/maxresdefault.jpg");
  assert.equal(thumbUrl("drIcTb-gwPs", "bogus"), "https://i.ytimg.com/vi/drIcTb-gwPs/hqdefault.jpg");
});
