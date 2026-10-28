import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runLogged } from "../util";

export async function buildOpenAiTts(outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await runLogged(process.execPath, [
    "--no-env-file",
    "build",
    "cmd/openai-tts.ts",
    "--compile",
    "--env=disable",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--windows-hide-console",
    "--outfile",
    join(outDir, "OpenAiTts.exe"),
  ]);
}
