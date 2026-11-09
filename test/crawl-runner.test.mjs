import { test } from "node:test";
import assert from "node:assert/strict";
import { runCrawl, TEXT_MAX_BYTES, REF_MAX, TITLE_MAX } from "../src/crawl/runner.mjs";
import { runCrawlCli } from "../src/crawl/cli.mjs";

const ITEM_KEYS = new Set(["ref", "title", "mime", "text", "updatedAt", "createdAt", "keywords", "sourceUrl"]);

function fakeCrawler({ refs, texts = {}, fail = new Set(), listFailAfter = Infinity, extra = {} }) {
  return {
    name: "fake",
    async *list() {
      let n = 0;
      for (const r of refs) {
        if (n++ >= listFailAfter) throw new Error("list 끊김");
        yield typeof r === "string" ? { ref: r, title: `t-${r}` } : r;
      }
    },
    async fetch(listed) {
      if (fail.has(listed.ref)) throw new Error(`fetch 끊김 ${listed.ref}`);
      return { ...listed, text: texts[listed.ref] ?? `# ${listed.ref}`, ...extra };
    },
  };
}

async function capture(crawler, opts = {}) {
  const lines = [];
  const warns = [];
  const done = await runCrawl(crawler, {
    write: (line) => lines.push(line),
    warn: (msg) => warns.push(msg),
    ...opts,
  });
  return { lines: lines.map((l) => JSON.parse(l)), done, warns };
}

async function captureCli(argv, crawlers) {
  const lines = [];
  const warns = [];
  const code = await runCrawlCli(argv, {
    write: (line) => lines.push(line),
    warn: (msg) => warns.push(msg),
    crawlers,
  });
  return { code, lines: lines.map((l) => JSON.parse(l)), warns };
}

test("가짜 구현 둘을 레지스트리에 끼우면 러너가 같은 꼴로 낸다", async () => {
  const crawlers = {
    wiki: () => fakeCrawler({ refs: ["wiki@1", "wiki@2"] }),
    voc: () =>
      fakeCrawler({
        refs: [{ ref: "voc@T-9", title: "티켓", sourceUrl: "https://voc/T-9", createdAt: "2026-11-01T09:00:00+09:00" }],
        extra: { keywords: ["fdc_sensor"] },
      }),
  };
  const wiki = await captureCli(["wiki"], crawlers);
  const voc = await captureCli(["voc"], crawlers);

  assert.equal(wiki.code, 0);
  assert.equal(voc.code, 0);
  for (const out of [wiki, voc]) {
    const items = out.lines.slice(0, -1);
    for (const item of items) {
      assert.equal(item.mime, "text/markdown");
      assert.equal(typeof item.text, "string");
      for (const key of Object.keys(item)) assert.ok(ITEM_KEYS.has(key), key);
    }
    assert.deepEqual(Object.keys(out.lines.at(-1)), ["done"]);
  }
  assert.deepEqual(wiki.lines.at(-1).done, { listed: 2, emitted: 2, oversize: [], failed: [], duplicate: [] });
  assert.deepEqual(voc.lines[0], {
    ref: "voc@T-9",
    title: "티켓",
    mime: "text/markdown",
    text: "# voc@T-9",
    createdAt: "2026-11-01T00:00:00.000Z",
    keywords: ["fdc_sensor"],
    sourceUrl: "https://voc/T-9",
  });
});

test("모르는 이름은 마커 없이 사용법을 알리고 exit 2", async () => {
  const out = await captureCli(["nope"], { wiki: () => fakeCrawler({ refs: [] }) });
  assert.equal(out.code, 2);
  assert.deepEqual(out.lines, []);
  assert.match(out.warns[0], /wiki/);
});

test("fetch 하나가 실패해도 나머지는 나가고 마커 failed 에 그 ref, exit 0", async () => {
  const crawlers = { x: () => fakeCrawler({ refs: ["a", "b", "c"], fail: new Set(["b"]) }) };
  const out = await captureCli(["x"], crawlers);
  assert.equal(out.code, 0);
  assert.deepEqual(out.lines.slice(0, -1).map((l) => l.ref), ["a", "c"]);
  assert.deepEqual(out.lines.at(-1).done.failed, ["b"]);
  assert.equal(out.lines.at(-1).done.emitted, 2);
  assert.match(out.warns.join("\n"), /fetch 실패: b/);
});

test("list 가 중간에 실패하면 마커가 없고 exit 가 0 이 아니다", async () => {
  const crawlers = { x: () => fakeCrawler({ refs: ["a", "b", "c"], listFailAfter: 2 }) };
  const out = await captureCli(["x"], crawlers);
  assert.notEqual(out.code, 0);
  assert.ok(out.lines.every((l) => !("done" in l)));
  assert.match(out.warns.join("\n"), /list 실패/);
});

test("text 가 256 KB 를 넘으면 내지 않고 oversize 로 센다", async () => {
  const big = "가".repeat(Math.floor(TEXT_MAX_BYTES / 3) + 1);
  const { lines, done } = await capture(fakeCrawler({ refs: ["small", "big"], texts: { big } }));
  assert.deepEqual(lines.slice(0, -1).map((l) => l.ref), ["small"]);
  assert.deepEqual(done.oversize, ["big"]);
});

test("ref · title 의 제어문자를 지우고 길이를 자른다", async () => {
  const crawler = fakeCrawler({
    refs: [{ ref: "w@a\u0000b\u001fc", title: `제목\x1e\x1f\n끝${"x".repeat(TITLE_MAX)}` }],
  });
  const { lines } = await capture(crawler);
  assert.equal(lines[0].ref, "w@abc");
  assert.ok(lines[0].title.startsWith("제목끝"));
  assert.equal(Array.from(lines[0].title).length, TITLE_MAX);

  const long = await capture(fakeCrawler({ refs: ["r".repeat(REF_MAX + 10)] }));
  assert.equal(long.lines[0].ref.length, REF_MAX);
});

test("ref 가 겹치면 뒤 것을 duplicate 로 센다", async () => {
  let fetched = 0;
  const crawler = fakeCrawler({ refs: ["a", "b", "a"] });
  const fetch = crawler.fetch;
  crawler.fetch = (r) => (fetched++, fetch(r));
  const { lines, done } = await capture(crawler);
  assert.deepEqual(lines.slice(0, -1).map((l) => l.ref), ["a", "b"]);
  assert.deepEqual(done.duplicate, ["a"]);
  assert.equal(done.listed, 3);
  assert.equal(fetched, 2);
});

test("모르는 키 · 틀린 값은 출력에 없다", async () => {
  const crawler = fakeCrawler({
    refs: ["a"],
    extra: { secret: "x", mime: "text/html", updatedAt: "어제", sourceUrl: "not a url", keywords: [] },
  });
  const { lines } = await capture(crawler);
  assert.deepEqual(lines[0], { ref: "a", title: "t-a", mime: "text/markdown", text: "# a" });
});

test("동시 fetch 는 concurrency 를 넘지 않고 출력은 list 순서다", async () => {
  let running = 0;
  let peak = 0;
  const refs = Array.from({ length: 10 }, (_, i) => `r${i}`);
  const crawler = fakeCrawler({ refs });
  crawler.fetch = async (listed) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 10 - Number(listed.ref.slice(1))));
    running--;
    return { ...listed, text: "x" };
  };
  const { lines } = await capture(crawler, { concurrency: 3 });
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.deepEqual(lines.slice(0, -1).map((l) => l.ref), refs);
});
