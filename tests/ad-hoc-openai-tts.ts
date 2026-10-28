import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL, responseEvent, runJob, synthesize, validateRequest, waveFile } from "../cmd/openai-tts";

const request = { text: "안녕하세요. Hello, reader!", voice: "marin", speed: 1 };
const pcm = Buffer.alloc(4800);

export async function testit(): Promise<void> {
  let calls = 0;
  let mode = "success";
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      assert.equal(req.headers.get("authorization"), "Bearer test-secret");
      if (server.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: "session.created" }));
      },
      message(socket, message) {
        const event = JSON.parse(String(message));
        if (event.type === "session.update") {
          assert.equal(event.session.audio.output.voice, request.voice);
          assert.equal(event.session.audio.input.turn_detection, null);
          socket.send(JSON.stringify({ type: "session.updated" }));
          return;
        }
        assert.deepEqual(event, responseEvent(request));
        calls++;
        if (mode === "wait") return;
        if (mode === "disconnect") return socket.close();
        if (mode === "error") {
          socket.send(JSON.stringify({ type: "error", error: { message: "test-secret private text" } }));
          return;
        }
        socket.send(JSON.stringify({ type: "response.output_audio.delta", delta: pcm.toString("base64") }));
        socket.send(
          JSON.stringify({
            type: "response.output_audio_transcript.done",
            transcript: mode === "mismatch" ? "Completely different words" : request.text,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "response.done",
            response: { status: mode === "incomplete" ? "incomplete" : "completed", usage: {} },
          }),
        );
      },
    },
  });
  const endpoint = `ws://127.0.0.1:${server.port}`;
  const generate = (options = {}) => synthesize(request, "test-secret", { endpoint, ...options });
  try {
    const { wav } = await generate();
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.readUInt32LE(40), pcm.length);
    assert.deepEqual(wav.subarray(44), pcm);
    for (const [scenario, code] of [
      ["error", "api_error"],
      ["mismatch", "transcript_mismatch"],
      ["incomplete", "generation_failed"],
      ["disconnect", "connection_closed"],
    ]) {
      mode = scenario;
      await assert.rejects(generate(), { message: code });
    }
    mode = "wait";
    await assert.rejects(generate({ timeoutMs: 30 }), { message: "timeout" });
    const abort = new AbortController();
    const cancelled = generate({ signal: abort.signal });
    setTimeout(() => abort.abort(), 30);
    await assert.rejects(cancelled, { message: "cancelled" });
    abort.abort();
    await assert.rejects(generate({ signal: abort.signal }), { message: "cancelled" });
    await assert.rejects(synthesize(request, ""), { message: "missing_api_key" });
    for (const invalid of [
      { ...request, text: "" },
      { ...request, text: "가".repeat(3000) },
      { ...request, voice: "bad" },
      { ...request, speed: NaN },
      { ...request, speed: 3 },
    ]) {
      assert.throws(() => validateRequest(invalid), { message: "invalid_request" });
    }
    assert.throws(() => waveFile(Buffer.alloc(1)), { message: "invalid_audio" });
    const helperIndex = process.argv.indexOf("--helper");
    if (helperIndex >= 0) {
      mode = "success";
      const scratch = mkdtempSync(join(import.meta.dir, "tmp-openai-ipc-"));
      try {
        const job = join(scratch, "job.json");
        writeFileSync(job, JSON.stringify({ ...request, testEndpoint: endpoint }));
        const child = Bun.spawn([process.argv[helperIndex + 1], job], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, OPENAI_API_KEY: "must-not-be-sent-to-mock" },
        });
        assert.equal(await child.exited, 0);
        assert.deepEqual(readFileSync(`${job}.wav`), waveFile(pcm));
        writeFileSync(job, JSON.stringify({ ...request, testEndpoint: "wss://example.com" }));
        const refused = Bun.spawn([process.argv[helperIndex + 1], job], { stdout: "pipe", stderr: "pipe" });
        assert.equal(await refused.exited, 1);
        assert.deepEqual(JSON.parse(readFileSync(`${job}.result`, "utf8")), { error: "invalid_test_endpoint" });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  } finally {
    server.stop(true);
  }

  const scratch = mkdtempSync(join(import.meta.dir, "tmp-openai-"));
  const oldLocal = process.env.LOCALAPPDATA;
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.LOCALAPPDATA = scratch;
  delete process.env.OPENAI_API_KEY;
  try {
    const envFile = join(scratch, ".env");
    const job = join(scratch, "job.json");
    writeFileSync(envFile, 'OPENAI_API_KEY="test-only-key"\n');
    writeFileSync(job, JSON.stringify({ ...request, envFile }));
    let generated = 0;
    const fake = async (_request: typeof request, key: string) => {
      assert.equal(key, "test-only-key");
      generated++;
      return { wav: waveFile(pcm), usage: { output_token_details: { audio_tokens: 2 } } };
    };
    await runJob(job, fake);
    assert.equal(JSON.parse(readFileSync(`${job}.result`, "utf8")).cached, false);
    await runJob(job, fake);
    assert.equal(JSON.parse(readFileSync(`${job}.result`, "utf8")).cached, true);
    assert.equal(generated, 1);
    assert.ok(!readFileSync(`${job}.result`, "utf8").includes("test-only-key"));
    assert.deepEqual(readFileSync(`${job}.wav`), waveFile(pcm));
    const helperIndex = process.argv.indexOf("--helper");
    if (helperIndex >= 0) {
      const child = Bun.spawn([process.argv[helperIndex + 1], job], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LOCALAPPDATA: scratch, OPENAI_API_KEY: "test-only-key" },
      });
      assert.equal(await child.exited, 0, "compiled helper reads the same cache");
      assert.equal(await new Response(child.stdout).text(), "");
      assert.equal(await new Response(child.stderr).text(), "");
      assert.deepEqual(readFileSync(`${job}.wav`), waveFile(pcm));
      writeFileSync(job, JSON.stringify({ ...request, text: "", envFile }));
      const invalid = Bun.spawn([process.argv[helperIndex + 1], job], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LOCALAPPDATA: scratch, OPENAI_API_KEY: "test-only-key" },
      });
      assert.equal(await invalid.exited, 1);
      assert.deepEqual(JSON.parse(readFileSync(`${job}.result`, "utf8")), { error: "invalid_request" });
    }
  } finally {
    if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocal;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(
    `PASS OpenAI speech: protocol, PCM, errors, transcript, timeout, cancellation, validation, cache (${calls} mock requests)`,
  );
}

async function liveTest(): Promise<void> {
  const scratch = mkdtempSync(join(import.meta.dir, "tmp-openai-live-"));
  try {
    const job = join(scratch, "job.json");
    writeFileSync(job, JSON.stringify({ ...request, envFile: join(import.meta.dir, "..", ".env") }));
    await runJob(job);
    const wav = readFileSync(`${job}.wav`);
    const result = JSON.parse(readFileSync(`${job}.result`, "utf8"));
    assert.ok(wav.length > 44);
    console.log(JSON.stringify({ model: MODEL, audioSeconds: (wav.length - 44) / 48000, ...result }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await testit();
  if (process.argv.includes("--live")) await liveTest();
}
