#include "base/Base.h"
#include "base/File.h"
#include "base/JsonParser.h"
#include "base/Win.h"

#include "SumatraConfig.h"
#include "OpenAiTts.h"

static HANDLE gOpenAiProcess = nullptr;
static Str gOpenAiRequestPath;

static TempStr OpenAiEnvPath() {
    TempStr configured = GetEnvVariableTemp(StrL("SUMATRA_OPENAI_ENV_FILE"));
    return configured ? configured : GetPathInExeDirTemp(StrL(".env"));
}

bool OpenAiTtsConfigured() {
    return len(GetEnvVariableTemp(StrL("OPENAI_API_KEY"))) > 0 || file::Exists(OpenAiEnvPath());
}

static void OpenAiRemoveJob() {
    if (len(gOpenAiRequestPath) == 0) {
        return;
    }
    file::Delete(gOpenAiRequestPath);
    file::Delete(fmt("%s.wav", gOpenAiRequestPath));
    file::Delete(fmt("%s.result", gOpenAiRequestPath));
    str::FreePtr(&gOpenAiRequestPath);
}

void OpenAiTtsStop() {
    if (gOpenAiProcess) {
        TerminateProcess(gOpenAiProcess, 1);
        WaitForSingleObject(gOpenAiProcess, INFINITE);
        CloseHandle(gOpenAiProcess);
        gOpenAiProcess = nullptr;
    }
    OpenAiRemoveJob();
}

bool OpenAiTtsPending() {
    return gOpenAiProcess != nullptr;
}

// Isolate network work and credentials from the UI; stopping kills the socket owner.
bool OpenAiTtsStart(Str text, Str voice, float speed) {
    if (gOpenAiProcess || len(text) == 0) {
        return false;
    }
    TempStr exe = GetPathInExeDirTemp(StrL("OpenAiTts.exe"));
    if (!file::Exists(exe)) {
        return false;
    }
    TempStr testEndpoint = gForTesting ? GetEnvVariableTemp(StrL("SUMATRA_OPENAI_TEST_ENDPOINT")) : TempStr{};
    TempStr request =
        fmt("{\"text\":\"%s\",\"voice\":\"%s\",\"speed\":%.2f,\"envFile\":\"%s\",\"testEndpoint\":\"%s\"}",
            json::EscapeStrTemp(text), json::EscapeStrTemp(voice), speed, json::EscapeStrTemp(OpenAiEnvPath()),
            json::EscapeStrTemp(testEndpoint));
    gOpenAiRequestPath = str::Dup(GetTempFilePathTemp(StrL("sumatra-openai")));
    if (!file::WriteFile(gOpenAiRequestPath, request)) {
        OpenAiRemoveJob();
        return false;
    }
    TempStr command = fmt("\"%s\" \"%s\"", exe, gOpenAiRequestPath);
    TempWStr commandW = ToWStrTemp(command);
    STARTUPINFOW startup = {};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process = {};
    if (!CreateProcessW(CWStrTemp(ToWStrTemp(exe)), commandW.s, nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                        CWStrTemp(ToWStrTemp(GetSelfExeDirTemp())), &startup, &process)) {
        OpenAiRemoveJob();
        return false;
    }
    CloseHandle(process.hThread);
    gOpenAiProcess = process.hProcess;
    return true;
}

OpenAiPoll OpenAiTtsPoll(Str* wavOut, Str* errorOut) {
    if (!gOpenAiProcess || WaitForSingleObject(gOpenAiProcess, 0) == WAIT_TIMEOUT) {
        return OpenAiPoll::Pending;
    }
    DWORD exitCode = 1;
    GetExitCodeProcess(gOpenAiProcess, &exitCode);
    CloseHandle(gOpenAiProcess);
    gOpenAiProcess = nullptr;
    if (exitCode == 0) {
        *wavOut = file::ReadFile(fmt("%s.wav", gOpenAiRequestPath));
    }
    Str result = file::ReadFile(fmt("%s.result", gOpenAiRequestPath));
    for (json::Value& value : json::Reader(result)) {
        if (json::PathMatch(value.path, StrL("/error"))) {
            *errorOut = str::Dup(value.value);
        }
    }
    str::Free(result);
    OpenAiRemoveJob();
    return exitCode == 0 && len(*wavOut) > 0 ? OpenAiPoll::Ready : OpenAiPoll::Failed;
}
