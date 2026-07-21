import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inferTable } from "../src/infer/run.mjs";

const describe = JSON.parse(
  readFileSync(new URL("../fixtures/describe/fdc_sensor.json", import.meta.url)),
);

const GOOD = JSON.stringify({
  purpose: "설비 센서 계측 이력.",
  columns: { SNSR_ID: "센서 식별자", MEAS_VAL: "계측값" },
});

/** 미리 정한 응답을 순서대로 내면서 받은 대화를 기록하는 가짜 클라이언트. */
function fakeClient(replies) {
  const seen = [];
  return {
    model: "inhouse-llm",
    seen,
    async complete(messages) {
      seen.push(structuredClone(messages));
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("첫 시도에 형식을 지키면 그대로 쓴다", async () => {
  const client = fakeClient([GOOD]);
  const out = await inferTable(describe, { client });

  assert.equal(out.attempts, 1);
  assert.equal(out.error, null);
  assert.equal(out.inference.purpose, "설비 센서 계측 이력.");
  assert.equal(out.inference.columns.SNSR_ID, "센서 식별자");
});

test("형식을 어기면 무엇이 틀렸는지 알려주고 다시 시킨다", async () => {
  const client = fakeClient(["죄송합니다, 표로 정리해 드릴게요…", GOOD]);
  const out = await inferTable(describe, { client });

  assert.equal(out.attempts, 2);
  assert.equal(out.error, null);
  assert.ok(out.inference, "교정 후에는 추론 결과가 나와야 한다");

  // 두 번째 호출에는 모델의 실패 응답과 교정 지시가 대화에 들어가 있어야 한다.
  const second = client.seen[1];
  assert.equal(second.at(-2).role, "assistant");
  assert.equal(second.at(-1).role, "user");
  assert.match(second.at(-1).content, /JSON 객체 하나만/);
});

test("끝까지 형식을 못 지키면 추론 없이 넘어간다", async () => {
  const client = fakeClient(["산문", "또 산문"]);
  const out = await inferTable(describe, { client });

  assert.equal(out.inference, null, "팩트만으로 문서를 만들게 된다");
  assert.equal(out.attempts, 2);
  assert.equal(out.error?.name, "InferParseError");
});

test("호출 자체가 실패하면 교정하지 않고 바로 끝낸다", async () => {
  const client = fakeClient([new Error("연결 끊김"), GOOD]);
  const out = await inferTable(describe, { client });

  assert.equal(out.inference, null);
  assert.equal(out.attempts, 1, "재시도는 클라이언트 몫 — 여기서 또 걸지 않는다");
  assert.match(out.error.message, /연결 끊김/);
});

test("환각 컬럼은 여기서도 걸러진 채로 나온다", async () => {
  const client = fakeClient([
    JSON.stringify({
      purpose: "x",
      columns: { SNSR_ID: "센서", NOPE: "없는 컬럼" },
    }),
  ]);
  const out = await inferTable(describe, { client });

  assert.equal(out.inference.columns.NOPE, undefined);
  assert.deepEqual(out.inference.dropped, ["NOPE"]);
});

test("샘플 데이터는 명시할 때만 프롬프트에 들어간다", async () => {
  const withoutSamples = fakeClient([GOOD]);
  await inferTable(describe, { client: withoutSamples });
  assert.doesNotMatch(withoutSamples.seen[0][1].content, /샘플 데이터/);

  const withSamples = fakeClient([GOOD]);
  await inferTable(describe, {
    client: withSamples,
    sampleRows: [{ SNSR_ID: "S-0004" }],
  });
  assert.match(withSamples.seen[0][1].content, /샘플 데이터/);
  assert.match(withSamples.seen[0][1].content, /S-0004/);
});
