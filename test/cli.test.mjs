import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, CliError } from "../src/cli.mjs";
import {
  COLUMNS_SQL,
  STATS_SQL,
  PK_SQL,
  FK_SQL,
  INDEXES_SQL,
} from "../src/oracle/describe.mjs";
import { DISCOVER_SQL } from "../src/oracle/discover.mjs";

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

function fakeDeps({ tables = ["T1"], existing = {} } = {}) {
  const logs = [];
  const createCalls = [];
  const batchCalls = [];
  const putFactsCalls = [];
  return {
    logs,
    createCalls,
    batchCalls,
    putFactsCalls,
    log: (line) => logs.push(line),
    fetchedAt: () => "2026-07-21T15:00:00Z",
    oracle: {
      run: async (sql) => {
        if (sql === DISCOVER_SQL) return tables.map((t) => ({ TABLE_NAME: t }));
        if (sql === COLUMNS_SQL) return COLUMN_ROWS;
        if (sql === STATS_SQL)
          return [{ NUM_ROWS: 1, LAST_ANALYZED: null, TABLE_COMMENT: null }];
        if (sql === PK_SQL || sql === FK_SQL || sql === INDEXES_SQL) return [];
        throw new Error(`fakeDeps.oracle: 모르는 SQL — ${sql}`);
      },
    },
    llm: {
      model: "inhouse-llm",
      async complete() {
        return JSON.stringify({ purpose: "p", columns: { ID: "id" } });
      },
    },
    akg: {
      async getDoc(type, id) {
        return existing[id] ?? null;
      },
      async createDoc(type, doc) {
        createCalls.push(doc);
        return { alreadyExists: false, rev: "r1" };
      },
      async createDocs(type, docs) {
        batchCalls.push(docs);
        return { created: docs.map((d) => d.id), rev: "rb" };
      },
      async putFacts(type, id, doc) {
        putFactsCalls.push({ id, doc });
        return { created: false, rev: "rf", orphans: [] };
      },
    },
  };
}

test("모르는 커맨드는 CliError", async () => {
  await assert.rejects(() => runCli(["nope"], fakeDeps()), CliError);
});

test("커맨드가 안 쓰는 클라이언트가 없어도 되지만, 쓰는 클라이언트가 없으면 거부한다", async () => {
  const deps = fakeDeps();
  delete deps.akg;
  await assert.rejects(() => runCli(["push", "--owner", "T", "--table", "T1"], deps), {
    name: "CliError",
    message: /akg/,
  });
});

test("discover: --owner 필요, 테이블 목록을 돌려준다", async () => {
  const deps = fakeDeps({ tables: ["T1", "T2"] });
  const out = await runCli(["discover", "--owner", "TESTUSER"], deps);
  assert.deepEqual(out.tables, ["T1", "T2"]);
  assert.deepEqual(deps.logs, ["T1", "T2"]);
});

test("discover: --owner 없으면 거부", async () => {
  await assert.rejects(() => runCli(["discover"], fakeDeps()), CliError);
});

test("describe: 카탈로그를 돌려준다", async () => {
  const deps = fakeDeps();
  const out = await runCli(["describe", "--owner", "TESTUSER", "--table", "T1"], deps);
  assert.equal(out.describe.table, "T1");
});

test("infer: compose·push 없이 추론 결과만 돌려준다", async () => {
  const deps = fakeDeps();
  const out = await runCli(["infer", "--owner", "TESTUSER", "--table", "T1"], deps);
  assert.equal(out.inference.purpose, "p");
  assert.equal(deps.createCalls.length, 0);
});

test("push: --push 없으면 dry-run — akg 에 생성 요청을 안 보낸다", async () => {
  const deps = fakeDeps();
  const out = await runCli(["push", "--owner", "TESTUSER", "--table", "T1"], deps);
  assert.equal(out.result.action, "would_create");
  assert.equal(deps.createCalls.length, 0);
});

test("push: --push 주면 실제로 생성한다", async () => {
  const deps = fakeDeps();
  const out = await runCli(["push", "--owner", "TESTUSER", "--table", "T1", "--push"], deps);
  assert.equal(out.result.action, "create");
  assert.equal(deps.createCalls.length, 1);
});

test("run: --owner 만 주면 discover 로 스키마 전체를 훑는다", async () => {
  const deps = fakeDeps({
    tables: ["T1", "T2"],
    existing: { "t2": { id: "t2" } },
  });
  const out = await runCli(["run", "--owner", "TESTUSER"], deps);

  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].action, "would_create");
  assert.equal(out.results[1].action, "skip");
  assert.match(deps.logs.at(-1), /--push/);
});

test("run --refresh-facts: dry-run 은 기존 문서를 would_refresh 로 센다", async () => {
  const deps = fakeDeps({
    tables: ["T1", "T2"],
    existing: { "t2": { id: "t2" } },
  });
  const out = await runCli(["run", "--owner", "TESTUSER", "--refresh-facts"], deps);

  assert.deepEqual(
    out.results.map((r) => r.action),
    ["would_create", "would_refresh"],
  );
  assert.equal(deps.putFactsCalls.length, 0, "dry-run 은 PUT 을 안 보낸다");
  assert.match(deps.logs.at(-1), /1개 팩트 갱신될 예정/);
});

test("run --refresh-facts --push: 신규는 배치, 기존은 문서별 putFacts", async () => {
  const deps = fakeDeps({
    tables: ["T1", "T2"],
    existing: { "t2": { id: "t2" } },
  });
  const out = await runCli(
    ["run", "--owner", "TESTUSER", "--refresh-facts", "--push"],
    deps,
  );

  assert.deepEqual(
    out.results.map((r) => r.action),
    ["create", "refresh"],
  );
  assert.equal(deps.batchCalls.length, 1, "신규는 배치 1커밋");
  assert.deepEqual(deps.batchCalls[0].map((d) => d.id), ["t1"]);
  assert.deepEqual(
    deps.putFactsCalls.map((c) => c.id),
    ["t2"],
    "기존 문서만 putFacts",
  );
  assert.match(deps.logs.join("\n"), /1개 팩트 갱신/);
});

test("run: --refresh-facts 없으면 기존처럼 스킵한다 — putFacts 를 안 부른다", async () => {
  const deps = fakeDeps({
    tables: ["T1", "T2"],
    existing: { "t2": { id: "t2" } },
  });
  const out = await runCli(["run", "--owner", "TESTUSER", "--push"], deps);

  assert.deepEqual(
    out.results.map((r) => r.action),
    ["create", "skip"],
  );
  assert.equal(deps.putFactsCalls.length, 0);
});

test("run: --tables 를 주면 discover 를 건너뛰고 그 테이블만 돈다", async () => {
  const deps = fakeDeps({ tables: ["T1", "T2", "T3"] }); // discover 가 불리면 3개가 나올 것
  const out = await runCli(["run", "--owner", "TESTUSER", "--tables", "T1, T2"], deps);

  assert.deepEqual(
    out.results.map((r) => r.id),
    ["t1", "t2"],
  );
});

test("run: --tables-file 로 파일에서 테이블 목록을 읽는다 (# 주석·빈 줄 무시)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "akg-collector-test-"));
  const file = join(dir, "tables.txt");
  writeFileSync(file, "T1\n# 주석\n\nT2\n");

  try {
    const deps = fakeDeps({ tables: ["T1", "T2"] });
    const out = await runCli(["run", "--owner", "TESTUSER", "--tables-file", file], deps);
    assert.deepEqual(
      out.results.map((r) => r.id),
      ["t1", "t2"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: --tables·--tables-file 동시 지정은 거부한다", async () => {
  const deps = fakeDeps();
  await assert.rejects(
    () => runCli(["run", "--owner", "TESTUSER", "--tables", "T1", "--tables-file", "x.txt"], deps),
    { name: "CliError", message: /같이 쓸 수 없습니다/ },
  );
});

test("run: --tables-file 이 없는 파일이면 CliError", async () => {
  const deps = fakeDeps();
  await assert.rejects(
    () => runCli(["run", "--owner", "TESTUSER", "--tables-file", "/nope/nope.txt"], deps),
    CliError,
  );
});
