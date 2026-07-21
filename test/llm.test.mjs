import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAiClient, LlmError } from "../src/llm/openai.mjs";

const noSleep = async () => {};

/** 호출을 기록하면서 미리 정한 응답을 순서대로 돌려주는 가짜 fetch. */
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (typeof next === "function") return next();
    return next;
  };
  impl.calls = calls;
  return impl;
}

const ok = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

const err = (status, body = { error: "nope" }) => ({
  ok: false,
  status,
  json: async () => body,
});

const client = (fetchImpl, extra = {}) =>
  createOpenAiClient({
    baseUrl: "http://llm.internal/v1/",
    apiKey: "secret-token",
    model: "inhouse-llm",
    fetchImpl,
    sleepImpl: noSleep,
    ...extra,
  });

test("정상 응답에서 본문 텍스트를 꺼낸다", async () => {
  const f = fakeFetch([ok("  hello  ")]);
  const out = await client(f).complete([{ role: "user", content: "hi" }]);
  assert.equal(out, "  hello  ");
});

test("요청 모양이 OpenAI 호환이다", async () => {
  const f = fakeFetch([ok("x")]);
  await client(f).complete([{ role: "user", content: "hi" }]);

  const [call] = f.calls;
  // baseUrl 의 뒤쪽 슬래시는 정리되어야 한다.
  assert.equal(call.url, "http://llm.internal/v1/chat/completions");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.authorization, "Bearer secret-token");
  assert.equal(call.body.model, "inhouse-llm");
  assert.equal(call.body.temperature, 0, "기본 temperature 는 0 이어야 한다");
  assert.deepEqual(call.body.messages, [{ role: "user", content: "hi" }]);
});

test("apiKey 가 없으면 Authorization 헤더를 붙이지 않는다", async () => {
  const f = fakeFetch([ok("x")]);
  await createOpenAiClient({
    baseUrl: "http://llm.internal/v1",
    model: "m",
    fetchImpl: f,
    sleepImpl: noSleep,
  }).complete([]);

  assert.equal(f.calls[0].init.headers.authorization, undefined);
});

test("429 는 다시 걸어보고, 성공하면 그 결과를 쓴다", async () => {
  const f = fakeFetch([err(429), err(503), ok("드디어")]);
  const out = await client(f).complete([]);

  assert.equal(out, "드디어");
  assert.equal(f.calls.length, 3);
});

test("400 은 다시 걸지 않는다 — 같은 답이 온다", async () => {
  const f = fakeFetch([err(400, { error: "bad model" })]);

  await assert.rejects(() => client(f).complete([]), {
    name: "LlmError",
    status: 400,
  });
  assert.equal(f.calls.length, 1, "재시도하면 안 된다");
});

test("재시도를 다 쓰면 마지막 오류를 던진다", async () => {
  const f = fakeFetch([err(500), err(500), err(500)]);
  await assert.rejects(() => client(f).complete([]), { status: 500 });
  assert.equal(f.calls.length, 3);
});

test("네트워크 예외도 재시도 대상이다", async () => {
  const boom = () => {
    throw new TypeError("fetch failed");
  };
  const f = fakeFetch([boom, ok("복구")]);
  assert.equal(await client(f).complete([]), "복구");
});

test("200 인데 content 가 없으면 조용히 넘기지 않는다", async () => {
  const f = fakeFetch([
    { ok: true, status: 200, json: async () => ({ choices: [] }) },
  ]);
  await assert.rejects(() => client(f).complete([]), {
    name: "LlmError",
    message: /content/,
  });
});

test("빈 문자열 응답도 실패로 본다", async () => {
  const f = fakeFetch([ok("   ")]);
  await assert.rejects(() => client(f).complete([]), LlmError);
});

test("baseUrl·model 이 없으면 만들 때 거부한다", () => {
  assert.throws(() => createOpenAiClient({ model: "m" }), LlmError);
  assert.throws(() => createOpenAiClient({ baseUrl: "http://x" }), LlmError);
});
