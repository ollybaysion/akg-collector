import { test } from "node:test";
import assert from "node:assert/strict";
import { formatType } from "../src/oracle/types.mjs";

test("VARCHAR2 는 CHAR_LENGTH 를 쓴다", () => {
  assert.equal(
    formatType({ DATA_TYPE: "VARCHAR2", CHAR_LENGTH: 20, DATA_LENGTH: 20 }),
    "VARCHAR2(20)",
  );
});

test("CHAR_LENGTH 가 없으면 DATA_LENGTH 로 대체한다", () => {
  assert.equal(
    formatType({ DATA_TYPE: "RAW", CHAR_LENGTH: null, DATA_LENGTH: 16 }),
    "RAW(16)",
  );
});

test("NUMBER 는 precision·scale 이 있을 때만 붙는다", () => {
  assert.equal(
    formatType({ DATA_TYPE: "NUMBER", DATA_PRECISION: 18, DATA_SCALE: 6 }),
    "NUMBER(18,6)",
  );
  assert.equal(
    formatType({ DATA_TYPE: "NUMBER", DATA_PRECISION: 10, DATA_SCALE: 0 }),
    "NUMBER(10)",
  );
  assert.equal(
    formatType({ DATA_TYPE: "NUMBER", DATA_PRECISION: null, DATA_SCALE: null }),
    "NUMBER",
  );
});

test("그 외 타입은 DATA_TYPE 을 그대로 쓴다 (TIMESTAMP(6) 등은 이미 완성형)", () => {
  assert.equal(formatType({ DATA_TYPE: "DATE" }), "DATE");
  assert.equal(formatType({ DATA_TYPE: "TIMESTAMP(6)" }), "TIMESTAMP(6)");
  assert.equal(formatType({ DATA_TYPE: "CLOB" }), "CLOB");
});
