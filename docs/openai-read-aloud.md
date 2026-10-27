# OpenAI Read Aloud (Windows)

When `OPENAI_API_KEY` or an `.env` file beside SumatraPDF is configured, the
default Read Aloud voice uses OpenAI `gpt-realtime-2.1-mini`. The voice menu
also offers **OpenAI marin (AI)**, **OpenAI cedar (AI)** and **OpenAI coral (AI)**.
Select a Windows voice to use local speech instead. OpenAI voices are generated
by AI and require separately billed OpenAI API access.

Keep `OpenAiTts.exe` beside `SumatraPDF.exe` (or `SumatraPDF-static.exe`).
`bun cmd/build.ts -rel` builds both. The fork's Windows artifact contains the
helper; the SumatraPDF installer does not install this companion file yet.
For a portable build, keep the extracted files together. Windows ng shares
the backend but currently needs the helper copied beside its executable.

Configure the local `.env` file as:

```dotenv
OPENAI_API_KEY=your-own-key
```

For development, set `SUMATRA_OPENAI_ENV_FILE` to an absolute `.env` path
before launching the app. The helper reads it internally. Keys are never
passed on command lines, embedded in builds, or written to logs or settings.
`.env` and `.env.*` are ignored by Git. OAuth is not implemented.

Read Aloud sends each text chunk to OpenAI for synthesis. It verifies the
returned transcript before playing the audio. A mismatch or API error stops
reading rather than silently skipping text or changing voices. Stop and pause
terminate pending synthesis. The next chunk may be generated ahead of playback;
audio already generated can be charged even if playback is stopped.

Audio is cached under `%LOCALAPPDATA%\SumatraPDF\openai-speech-cache`, up to
256 MiB, evicting the oldest audio first. Replaying an identical chunk with the
same voice and speed uses the cache. Delete this directory to remove cached
book audio. Request text exists in temporary job files until completion or stop;
an application or machine crash may leave those temporary files behind.

Speed is limited to 0.5–1.5 for OpenAI voices and applies to subsequently
generated chunks. The backend waits for a chunk to finish generating before
playing it. Highlight and resume positions are estimates based on elapsed audio;
Realtime does not provide the Windows engines' word boundary timestamps.

## Verification

```powershell
bun --no-env-file tests/ad-hoc-openai-tts.ts
bun --no-env-file tests/ad-hoc-openai-tts.ts --live
```

The first command uses a local mock server and a fake key. The second also
generates a short real sample using the repository `.env`, without printing
its contents. Live usage is billed; replay can use the cache.

Official references:

- [Realtime WebSocket](https://developers.openai.com/api/docs/guides/realtime-websocket)
- [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [API pricing](https://developers.openai.com/api/docs/pricing)
