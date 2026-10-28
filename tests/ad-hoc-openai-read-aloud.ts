import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ControlCommand } from "./control";
import { assemblePdf, cmdId, runStandalone, tmpPath, writeAppdata } from "./util";
import { killAndWait, launchControlled, sendCommand } from "./win-automation";

async function until(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(message);
}

export async function testit(): Promise<void> {
  let requests = 0;
  let waiting = false;
  let closed = 0;
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
      close() {
        closed++;
      },
      message(socket, data) {
        const event = JSON.parse(String(data));
        if (event.type === "session.update") {
          assert.equal(event.session.audio.output.voice, "marin");
          socket.send(JSON.stringify({ type: "session.updated" }));
          return;
        }
        assert.equal(event.type, "response.create");
        assert.equal(event.response.conversation, "none");
        requests++;
        if (waiting) return;
        const text = event.response.input[0].content[0].text;
        socket.send(
          JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(48000 * 3).toString("base64") }),
        );
        socket.send(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: text }));
        socket.send(JSON.stringify({ type: "response.done", response: { status: "completed", usage: {} } }));
      },
    },
  });
  const text = "BT /F1 18 Tf 72 720 Td (Hello reader. This is the OpenAI speech integration test.) Tj ET";
  const pdf = tmpPath("openai-read-aloud.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    ]),
    "latin1",
  );
  const appdata = writeAppdata(
    "openai-read-aloud",
    "RestoreSession = false\nCheckForUpdates = false\nReadAloudVoiceId = openai:marin\nReadAloudSpeed = 1\nUiLanguage = en\n",
  );
  const log = tmpPath("openai-read-aloud.log");
  const session = await launchControlled(["-appdata", appdata, "-log-to-file", log, pdf], {
    env: { SUMATRA_OPENAI_TEST_ENDPOINT: `ws://127.0.0.1:${server.port}`, OPENAI_API_KEY: "test-secret" },
  });
  const state = async () => String((await session.client.request(ControlCommand.TestReadAloudPlaybackBar, []))[1]);
  try {
    await session.client.waitForRenderIdle();
    sendCommand(session.frame, cmdId("CmdReadAloudFromTopPage"));
    await until(() => requests > 0, "native app did not invoke the speech helper");
    await until(async () => /speaking=1/.test(await state()), "native playback never became active");
    await until(async () => /speaking=0/.test(await state()), "native playback did not finish");

    waiting = true;
    const before = requests;
    sendCommand(session.frame, cmdId("CmdReadAloudFromTopPage"));
    await until(() => requests > before, "second speech job did not start");
    const beforeClose = closed;
    sendCommand(session.frame, cmdId("CmdStopReadAloud"));
    await until(() => closed > beforeClose, "stop did not disconnect pending synthesis");
    assert.match(await state(), /speaking=0/);
    console.log("PASS native OpenAI Read Aloud: helper, playback completion, stop during synthesis");
  } catch (error) {
    console.error(await state());
    if (existsSync(log)) {
      console.error(
        readFileSync(log, "utf8")
          .split(/\r?\n/)
          .filter((line) => /tts:|ApplyReadAloudVoice|OpenAI/.test(line))
          .join("\n"),
      );
    }
    throw error;
  } finally {
    session.client.close();
    await killAndWait(session.proc);
    server.stop(true);
  }
}

if (import.meta.main) await runStandalone(testit);
