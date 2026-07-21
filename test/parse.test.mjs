import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseInference, InferParseError } from "../src/infer/parse.mjs";

const describe = JSON.parse(
  readFileSync(new URL("../fixtures/describe/fdc_sensor.json", import.meta.url)),
);
const rawResponse = readFileSync(
  new URL("../fixtures/infer/fdc_sensor.txt", import.meta.url),
  "utf8",
);

test("코드펜스로 감싼 응답에서 JSON 을 꺼낸다", () => {
  const out = parseInference(rawResponse, describe);
  assert.equal(
    out.purpose,
    "설비에 부착된 센서의 계측값을 시각과 함께 적재하는 이력 테이블.",
  );
});

test("모델이 흔든 대소문자를 실제 컬럼명으로 되돌린다", () => {
  const out = parseInference(rawResponse, describe);
  assert.ok(out.columns.SNSR_ID, "snsr_id -> SNSR_ID 로 정규화되어야 한다");
  assert.equal(out.columns.snsr_id, undefined);
});

test("카탈로그에 없는 컬럼은 버리고 센다", () => {
  const out = parseInference(rawResponse, describe);
  // MEAS_VALUE 는 실제 컬럼(MEAS_VAL)과 비슷하지만 다른 이름 — 통과시키면 안 된다.
  assert.deepEqual(out.dropped.sort(), ["CREATED_BY", "MEAS_VALUE"]);
  assert.equal(out.columns.MEAS_VALUE, undefined);
  assert.equal(out.columns.CREATED_BY, undefined);
});

test("모델이 빠뜨린 컬럼은 missing 으로 보고한다", () => {
  const out = parseInference(rawResponse, describe);
  assert.deepEqual(out.missing, ["MEAS_VAL"]);
});

test("이미 파싱된 객체도 받는다", () => {
  const out = parseInference(
    { purpose: "x", columns: { EQP_ID: "설비 식별자" } },
    describe,
  );
  assert.equal(out.purpose, "x");
  assert.equal(out.columns.EQP_ID, "설비 식별자");
});

test("빈 문자열 값은 채우지 않는다", () => {
  const out = parseInference(
    { purpose: "   ", columns: { EQP_ID: "  " } },
    describe,
  );
  assert.equal(out.purpose, null);
  assert.deepEqual(out.columns, {});
});

test("JSON 이 아니면 InferParseError", () => {
  assert.throws(
    () => parseInference("죄송합니다, 답변할 수 없습니다.", describe),
    InferParseError,
  );
});

test("깨진 JSON 이면 InferParseError", () => {
  assert.throws(() => parseInference('{"purpose": ', describe), InferParseError);
});

test("카탈로그 컬럼이 없으면 거부한다", () => {
  assert.throws(() => parseInference("{}", { columns: [] }), InferParseError);
});
