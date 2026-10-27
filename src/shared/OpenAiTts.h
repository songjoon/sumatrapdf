enum class OpenAiPoll {
    Pending,
    Ready,
    Failed,
};

bool OpenAiTtsConfigured();
bool OpenAiTtsStart(Str text, Str voice, float speed);
OpenAiPoll OpenAiTtsPoll(Str* wavOut, Str* errorOut);
bool OpenAiTtsPending();
void OpenAiTtsStop();
