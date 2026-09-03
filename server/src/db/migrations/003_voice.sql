-- 003: 语音助手调用审计(voice_call_log)。Voice Copilot P0。
-- 刻意**不存任何文本与音频**:音频只在内存里过一手转发给上游,转写结果与待合成文本
-- 都是论文正文的衍生物,落库等于把用户的阅读内容抄一份。这张表只留计费与排障要的标量。
-- 每次上游尝试一行(含轮换中失败的那次),与 llm_call_log 同语义。

CREATE TABLE voice_call_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('asr', 'tts')),
  provider TEXT NOT NULL,
  model TEXT,
  bytes_in INTEGER,                       -- asr:上传音频字节(≈时长,ASR 按分钟计费);tts 为 NULL
  chars_in INTEGER,                       -- tts:请求文本字符数(TTS 按千字符计费);asr 为 NULL
  status INTEGER,                         -- 上游 HTTP 状态;网络失败/超时为 NULL
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
-- 日字符上限查询按 (user_id, created_at) 扫当日区间,再筛 kind
CREATE INDEX idx_voice_call_log_user ON voice_call_log(user_id, created_at);
