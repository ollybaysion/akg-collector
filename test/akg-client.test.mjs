import { test } from "node:test";
import assert from "node:assert/strict";
import { createAkgClient, AkgApiError } from "../src/akg/client.mjs";

const noSleep = async () => {};

/** 호출을 기록하면서 미리 정한 응답을 순서대로 돌려주는 가짜 fetch. */
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (typeof next === "function") return next();
    return next;
  };
  impl.calls = calls;
  return impl;
}

const ok = (status, body) => ({ ok: status < 400, status, json: async () => body });

const client = (fetchImpl, extra = {}) =>
  createAkgClient({
    baseUrl: "http://akg.internal/",
    token: "editor-token",
    fetchImpl,
    sleepImpl: noSleep,
    ...extra,
  });

test("baseUrl·token 이 없으면 만들 때 거부한다", () => {
  assert.throws(() => createAkgClient({ token: "t" }), AkgApiError);
  assert.throws(() => createAkgClient({ baseUrl: "http://x" }), AkgApiError);
});

test("getDoc: 200 이면 json 을 꺼낸다", async () => {
  const f = fakeFetch([ok(200, { json: { id: "x.y" }, rev: "r1" })]);
  const doc = await client(f).getDoc("db-schema", "x.y");

  assert.deepEqual(doc, { id: "x.y" });
  const [call] = f.calls;
  assert.equal(call.url, "http://akg.internal/api/docs/db-schema/x.y");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.headers.authorization, "Bearer editor-token");
});

test("getDoc: 404 면 null — 재시도하지 않는다", async () => {
  const f = fakeFetch([ok(404, { error: "not_found" })]);
  const doc = await client(f).getDoc("db-schema", "nope.nope");

  assert.equal(doc, null);
  assert.equal(f.calls.length, 1);
});

test("createDoc: 201 이면 rev·json 을 돌려준다", async () => {
  const f = fakeFetch([ok(201, { rev: "r1", json: { id: "x.y" } })]);
  const out = await client(f).createDoc("db-schema", { id: "x.y" });

  assert.deepEqual(out, { alreadyExists: false, rev: "r1", json: { id: "x.y" } });
  const [call] = f.calls;
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(call.init.body), { id: "x.y" });
});

test("createDoc: 409 면 alreadyExists — 재시도하지 않는다", async () => {
  const f = fakeFetch([ok(409, { error: "already_exists" })]);
  const out = await client(f).createDoc("db-schema", { id: "x.y" });

  assert.deepEqual(out, { alreadyExists: true });
  assert.equal(f.calls.length, 1);
});

test("putFacts: 200 이면 rev·orphans 를 돌려준다 — body 만 보낸다", async () => {
  const f = fakeFetch([
    ok(200, { rev: "r2", orphans: [{ address: "columnDescs.OLD", outcome: "deprecated" }] }),
  ]);
  const doc = { schema: "db-schema/v1", id: "t1", body: { table: "T1" } };
  const out = await client(f).putFacts("db-schema", "t1", doc);

  assert.deepEqual(out, {
    created: false,
    rev: "r2",
    orphans: [{ address: "columnDescs.OLD", outcome: "deprecated" }],
  });
  const [call] = f.calls;
  assert.equal(call.url, "http://akg.internal/api/docs/db-schema/t1/facts");
  assert.equal(call.init.method, "PUT");
  // 서버는 body 만 본다 — envelope(schema/id/status)를 통째로 보내지 않는다.
  assert.deepEqual(JSON.parse(call.init.body), { body: { table: "T1" } });
});

test("putFacts: 201 이면 created — 문서가 없어서 새로 생겼다(서버가 비활성 착지)", async () => {
  const f = fakeFetch([ok(201, { rev: "r1", orphans: [] })]);
  const out = await client(f).putFacts("db-schema", "t1", { body: {} });

  assert.deepEqual(out, { created: true, rev: "r1", orphans: [] });
});

test("putFacts: 400(validation) 은 재시도 없이 던진다", async () => {
  const f = fakeFetch([ok(400, { error: "validation_failed" })]);
  await assert.rejects(
    () => client(f).putFacts("db-schema", "t1", { body: {} }),
    { name: "AkgApiError", status: 400 },
  );
  assert.equal(f.calls.length, 1);
});

test("500 은 다시 걸어보고, 성공하면 그 결과를 쓴다", async () => {
  const f = fakeFetch([ok(500, {}), ok(200, { json: { id: "x.y" } })]);
  const doc = await client(f).getDoc("db-schema", "x.y");

  assert.deepEqual(doc, { id: "x.y" });
  assert.equal(f.calls.length, 2);
});

test("401 같은 그 외 4xx 는 다시 걸지 않고 던진다", async () => {
  const f = fakeFetch([ok(401, { error: "unauthorized" })]);
  await assert.rejects(() => client(f).getDoc("db-schema", "x.y"), {
    name: "AkgApiError",
    status: 401,
  });
  assert.equal(f.calls.length, 1);
});

test("재시도를 다 쓰면 마지막 오류를 던진다", async () => {
  const f = fakeFetch([ok(503, {}), ok(503, {}), ok(503, {})]);
  await assert.rejects(() => client(f).getDoc("db-schema", "x.y"), { status: 503 });
  assert.equal(f.calls.length, 3);
});
