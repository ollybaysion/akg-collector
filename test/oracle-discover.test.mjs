import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoverTables,
  DiscoverError,
  DISCOVER_SQL,
  DISCOVER_SQL_LIKE,
} from "../src/oracle/discover.mjs";

test("owner 없이는 던진다", async () => {
  await assert.rejects(() => discoverTables(async () => [], {}), DiscoverError);
});

test("테이블명 배열로 매핑한다", async () => {
  const run = async () => [{ TABLE_NAME: "FDC_SENSOR" }, { TABLE_NAME: "FDC_EQUIPMENT" }];
  const tables = await discoverTables(run, { owner: "TESTUSER" });
  assert.deepEqual(tables, ["FDC_SENSOR", "FDC_EQUIPMENT"]);
});

test("like 없으면 기본 SQL, owner 바인드만 넘긴다", async () => {
  let seen = null;
  await discoverTables(
    async (sql, binds) => {
      seen = { sql, binds };
      return [];
    },
    { owner: "TESTUSER" },
  );
  assert.equal(seen.sql, DISCOVER_SQL);
  assert.deepEqual(seen.binds, { owner: "TESTUSER" });
});

test("like 가 있으면 like SQL, 두 바인드 모두 넘긴다", async () => {
  let seen = null;
  await discoverTables(
    async (sql, binds) => {
      seen = { sql, binds };
      return [];
    },
    { owner: "TESTUSER", like: "FDC\\_%" },
  );
  assert.equal(seen.sql, DISCOVER_SQL_LIKE);
  assert.deepEqual(seen.binds, { owner: "TESTUSER", like: "FDC\\_%" });
});
