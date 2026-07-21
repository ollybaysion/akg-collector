// #6 — 배치 push. 이 레포가 지키려는 성질은 두 가지다: 테이블 수만큼 커밋을
// 만들지 않는다는 것, 그리고 적재가 주입에 닿지 않는다는 것.
import { test } from "node:test";
import assert from "node:assert/strict";

import { chunkBySize, pushDocs } from "../src/push.mjs";

function doc(i, padBytes = 0) {
  return {
    schema: "db-schema/v1",
    id: `t.tbl_${String(i).padStart(4, "0")}`,
    keywords: [{ kw: `tbl_${i}`, inject: "pointer" }],
    status: "inactive",
    body: { owner: "T", table: `TBL_${i}`, pad: "x".repeat(padBytes) },
  };
}

/** createDocs 호출을 기록하는 가짜 클라이언트. existing 에 든 id 는 409 를 만든다. */
function fakeClient({ existing = [] } = {}) {
  const calls = [];
  const have = new Set(existing);
  return {
    calls,
    async createDocs(type, docs, opts) {
      calls.push({ type, ids: docs.map((d) => d.id), opts });
      const clash = docs.filter((d) => have.has(d.id)).map((d) => d.id);
      if (clash.length) return { alreadyExists: clash };
      for (const d of docs) have.add(d.id);
      return { created: docs.map((d) => d.id), rev: `rev${calls.length}` };
    },
  };
}

test("크기로 자른다 — 개수가 아니라", () => {
  // 문서 하나가 약 10 KiB. 한도 50 KiB 면 청크당 4~5개여야지, 개수 고정이면
  // 컬럼이 많은 스키마에서 그대로 상한을 넘는다.
  const docs = Array.from({ length: 12 }, (_, i) => doc(i, 10 * 1024));
  const chunks = chunkBySize(docs, 50 * 1024);

  assert.ok(chunks.length >= 3, `청크 ${chunks.length}개`);
  for (const chunk of chunks) {
    assert.ok(
      Buffer.byteLength(JSON.stringify(chunk)) <= 50 * 1024,
      "청크가 한도를 넘었다",
    );
  }
  assert.equal(
    chunks.flat().length,
    docs.length,
    "잘라 놓고 문서를 흘리면 안 된다",
  );
});

test("혼자서도 한도를 넘는 문서는 자기 배치로 나간다", () => {
  const docs = [doc(0, 100), doc(1, 80 * 1024), doc(2, 100)];
  const chunks = chunkBySize(docs, 10 * 1024);

  const huge = chunks.find((c) => c.some((d) => d.id === "t.tbl_0001"));
  assert.equal(huge.length, 1, "큰 문서를 다른 문서와 묶으면 둘 다 못 올라간다");
  assert.equal(chunks.flat().length, 3);
});

test("여러 문서가 한 커밋으로 나간다", async () => {
  const client = fakeClient();
  const docs = Array.from({ length: 5 }, (_, i) => doc(i));

  const res = await pushDocs(client, docs, { runId: "import-1" });

  assert.equal(client.calls.length, 1, "테이블마다 요청하면 커밋이 그만큼 생긴다");
  assert.equal(res.commits, 1);
  assert.equal(res.created.length, 5);
  assert.equal(client.calls[0].opts.runId, "import-1");
});

test("이미 있는 id 는 빼고 다시 보낸다 — 배치가 전량 아니면 전무라서", async () => {
  const client = fakeClient({ existing: ["t.tbl_0002"] });
  const docs = Array.from({ length: 4 }, (_, i) => doc(i));

  const res = await pushDocs(client, docs);

  assert.equal(client.calls.length, 2, "409 를 받고 한 번 다시 보내야 한다");
  assert.deepEqual(res.skipped, ["t.tbl_0002"]);
  assert.deepEqual(res.created, ["t.tbl_0000", "t.tbl_0001", "t.tbl_0003"]);
  assert.equal(res.commits, 1);
  // 겹친 문서가 두 번째 요청에 남아 있으면 영원히 409 다.
  assert.ok(!client.calls[1].ids.includes("t.tbl_0002"));
});

test("두 번째도 409 면 무한 재시도 대신 스킵으로 접는다", async () => {
  // 매번 다른 id 를 문제 삼는 클라이언트 — 재시도를 늘려도 끝나지 않는 상황.
  let n = 0;
  const client = {
    calls: [],
    async createDocs(type, docs) {
      this.calls.push(docs.map((d) => d.id));
      return { alreadyExists: [docs[0].id], n: n++ };
    },
  };
  const docs = Array.from({ length: 3 }, (_, i) => doc(i));

  const res = await pushDocs(client, docs);

  assert.equal(client.calls.length, 2);
  assert.equal(res.created.length, 0);
  assert.equal(res.skipped.length, 3, "남은 문서도 스킵으로 보고해야 한다");
});

test("빈 목록은 요청을 만들지 않는다", async () => {
  const client = fakeClient();
  const res = await pushDocs(client, []);
  assert.equal(client.calls.length, 0);
  assert.deepEqual(res, { created: [], skipped: [], commits: 0 });
});
