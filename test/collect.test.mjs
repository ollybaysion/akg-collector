import { test } from "node:test";
import assert from "node:assert/strict";
import { collectTable } from "../src/collect.mjs";
import {
  COLUMNS_SQL,
  STATS_SQL,
  PK_SQL,
  FK_SQL,
  INDEXES_SQL,
} from "../src/oracle/describe.mjs";

const COLUMN_ROWS = [
  {
    COLUMN_NAME: "ID",
    DATA_TYPE: "NUMBER",
    DATA_PRECISION: null,
    DATA_SCALE: null,
    CHAR_LENGTH: null,
    DATA_LENGTH: 22,
    NULLABLE: "N",
    DATA_DEFAULT: null,
    COMMENT: null,
  },
];

function fakeOracle() {
  const calls = [];
  return {
    calls,
    run: async (sql) => {
      calls.push(sql);
      if (sql === COLUMNS_SQL) return COLUMN_ROWS;
      if (sql === STATS_SQL)
        return [{ NUM_ROWS: 1, LAST_ANALYZED: null, TABLE_COMMENT: null }];
      if (sql === PK_SQL || sql === FK_SQL || sql === INDEXES_SQL) return [];
      throw new Error(`fakeOracle: 모르는 SQL — ${sql}`);
    },
  };
}

function fakeLlm() {
  return {
    model: "inhouse-llm",
    calls: 0,
    async complete() {
      this.calls++;
      return JSON.stringify({ purpose: "테스트 테이블", columns: { ID: "식별자" } });
    },
  };
}

function fakeAkg({ existing = null, createResult, putFactsResult } = {}) {
  const calls = [];
  return {
    calls,
    async getDoc(type, id) {
      calls.push({ op: "getDoc", type, id });
      return existing;
    },
    async createDoc(type, doc) {
      calls.push({ op: "createDoc", type, doc });
      return createResult ?? { alreadyExists: false, rev: "r1" };
    },
    async putFacts(type, id, doc) {
      calls.push({ op: "putFacts", type, id, doc });
      return putFactsResult ?? { created: false, rev: "r2", orphans: [] };
    },
  };
}

const fetchedAt = () => "2026-07-21T15:00:00Z";

test("이미 있으면 describe·infer 까지 건너뛰고 스킵한다", async () => {
  const oracle = fakeOracle();
  const llm = fakeLlm();
  const akg = fakeAkg({ existing: { id: "t" } });

  const out = await collectTable(
    { oracle, llm, akg, fetchedAt },
    { owner: "TESTUSER", table: "T", apply: true },
  );

  assert.deepEqual(out, { id: "t", action: "skip" });
  assert.equal(oracle.calls.length, 0, "describe 를 아예 안 불러야 한다");
  assert.equal(llm.calls, 0, "infer 도 안 불러야 한다");
});

test("apply=false 면 문서를 조립만 하고 push 하지 않는다", async () => {
  const oracle = fakeOracle();
  const llm = fakeLlm();
  const akg = fakeAkg({ existing: null });

  const out = await collectTable(
    { oracle, llm, akg, fetchedAt },
    { owner: "TESTUSER", table: "T", apply: false },
  );

  assert.equal(out.action, "would_create");
  assert.equal(out.doc.id, "t");
  assert.equal(out.doc.body.columnDescs.ID.text, "식별자");
  assert.deepEqual(
    akg.calls.map((c) => c.op),
    ["getDoc"],
    "createDoc 은 불리면 안 된다",
  );
});

test("refreshFacts: 기존 문서면 describe 만 돌려 putFacts — infer 는 안 부른다", async () => {
  const oracle = fakeOracle();
  const llm = fakeLlm();
  const akg = fakeAkg({
    existing: { id: "t" },
    putFactsResult: {
      created: false,
      rev: "r9",
      orphans: [{ address: "columnDescs.OLD", outcome: "deprecated" }],
    },
  });

  const out = await collectTable(
    { oracle, llm, akg, fetchedAt },
    { owner: "TESTUSER", table: "T", apply: true, refreshFacts: true },
  );

  assert.deepEqual(out, {
    id: "t",
    action: "refresh",
    rev: "r9",
    orphans: [{ address: "columnDescs.OLD", outcome: "deprecated" }],
  });
  assert.ok(oracle.calls.length > 0, "describe 는 다시 돌아야 한다");
  assert.equal(llm.calls, 0, "infer 는 안 불러야 한다 — 슬롯은 이 경로로 못 쓴다");
  const put = akg.calls.find((c) => c.op === "putFacts");
  assert.equal(put.id, "t");
  assert.equal(put.doc.body.table, "T");
});

test("refreshFacts + apply=false: would_refresh 로 문서만 돌려준다", async () => {
  const oracle = fakeOracle();
  const llm = fakeLlm();
  const akg = fakeAkg({ existing: { id: "t" } });

  const out = await collectTable(
    { oracle, llm, akg, fetchedAt },
    { owner: "TESTUSER", table: "T", apply: false, refreshFacts: true },
  );

  assert.equal(out.action, "would_refresh");
  assert.equal(out.doc.id, "t");
  // 팩트만 있고 슬롯은 전부 빈칸 — 서버가 리셋할 값을 만들지도 않는다.
  assert.deepEqual(out.doc.body.columnDescs.ID, { text: null, tier: "scaffold" });
  assert.deepEqual(
    akg.calls.map((c) => c.op),
    ["getDoc"],
    "putFacts 는 불리면 안 된다",
  );
  assert.equal(llm.calls, 0);
});

test("refreshFacts: 문서가 없으면 평소처럼 생성 경로를 탄다", async () => {
  const oracle = fakeOracle();
  const llm = fakeLlm();
  const akg = fakeAkg({ existing: null, createResult: { alreadyExists: false, rev: "r7" } });

  const out = await collectTable(
    { oracle, llm, akg, fetchedAt },
    { owner: "TESTUSER", table: "T", apply: true, refreshFacts: true },
  );

  assert.deepEqual(out, { id: "t", action: "create", rev: "r7" });
  assert.equal(llm.calls, 1, "신규 생성이면 infer 를 탄다");
  assert.equal(
    akg.calls.filter((c) => c.op === "putFacts").length,
    0,
    "신규는 putFacts 가 아니라 createDoc 경로다",
  );
});

test("apply=true 면 push 까지 한다", async () => {
  const oracle = fakeOracle();
  const llm = fakeLlm();
  const akg = fakeAkg({ existing: null, createResult: { alreadyExists: false, rev: "r7" } });

  const out = await collectTable(
    { oracle, llm, akg, fetchedAt },
    { owner: "TESTUSER", table: "T", apply: true },
  );

  assert.deepEqual(out, { id: "t", action: "create", rev: "r7" });
});
