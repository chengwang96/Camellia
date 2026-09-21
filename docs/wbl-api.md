# WBL API 调用记录

记录日期：2026-09-22（Asia/Hong_Kong）。以下是本机实测结果，不代表平台对所有模型、参数或客户端的支持承诺。

## 已验证的调用方式

- 平台地址：`https://wbl.dpdns.org`
- Responses 接口：`POST https://wbl.dpdns.org/responses`
- 鉴权：`Authorization: Bearer <API_KEY>`
- 请求类型：`Content-Type: application/json`
- 已测试模型：`gpt-5.6-sol`
- 使用 Windows `curl.exe`，显式禁用代理：`--noproxy "*" --proxy ""`。
- 本机密钥文件：`%USERPROFILE%\Downloads\token.txt`。只在运行时读取，不将内容写入文档、源码或日志。
- 已验证的是根路径 `/responses`，没有验证 `/v1/responses`；不要擅自给 base URL 增加 `/v1`。

## 最小复现

在 PowerShell 中运行以下代码，需要 Python 和 `curl.exe`。示例假定 `token.txt` 只包含一条纯文本密钥；密钥通过标准输入交给 curl，不放入进程命令行参数，也不创建临时密钥文件。

```powershell
@'
import json
import os
import pathlib
import subprocess

key_path = pathlib.Path(os.environ['USERPROFILE']) / 'Downloads' / 'token.txt'
key = key_path.read_text(encoding='utf-8-sig').strip()
if not key or any(character.isspace() for character in key):
    raise SystemExit('token.txt must contain one plain-text API key')

def quoted(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'

payload = json.dumps({
    'model': 'gpt-5.6-sol',
    'input': 'Reply with exactly: OK',
    'store': False,
    'max_output_tokens': 64,
})
config = '\n'.join([
    'header = ' + quoted('Authorization: Bearer ' + key),
    'header = "Content-Type: application/json"',
    'data = ' + quoted(payload),
])
result = subprocess.run(
    ['curl.exe', '-q', '--noproxy', '*', '--proxy', '',
     '--silent', '--show-error', '--connect-timeout', '20',
     '--max-time', '90', '--config', '-',
     '--write-out', '\nHTTP_STATUS:%{http_code}\n',
     'https://wbl.dpdns.org/responses'],
    input=config, capture_output=True, text=True, encoding='utf-8',
)
print(result.stdout.replace(key, '[REDACTED]'))
print(result.stderr.replace(key, '[REDACTED]'))
raise SystemExit(result.returncode)
'@ | python -
```

`-q` 禁止加载默认 curl 配置；上述代理参数只影响此次 curl 请求，不修改系统代理。此命令会产生一次实际 API 调用，可能计费。curl 退出码为零不等于 API 成功，还需要检查 HTTP 状态和响应事件。

## 响应与兼容性注意事项

实测 HTTP `200`，耗时约 6.9 秒，模型返回 `OK`；最终事件为 `response.completed`，响应状态为 `completed`。平台报告模型为 `gpt-5.6-sol`，输入 11 tokens、输出 5 tokens，总计 16 tokens。

- 本次请求没有指定 `stream`，但平台仍返回 SSE（`event:` / `data:`），不能将整个响应直接当作单个 JSON 解析。
- 文本出现在 `response.output_text.delta` 和 `response.output_text.done` 事件中。本次最终 `response.completed.response.output` 是空数组，不能只从该数组提取答案。
- 请求发送 `store: false`，响应也返回 `store: false`；这不构成对第三方平台实际数据保留策略的独立验证。
- 请求发送 `max_output_tokens: 64`，但响应字段为 `null`；本次短回复不能证明平台执行了输出上限。
- 返回的模型名是平台报告值，本次连通性测试不能独立验证其底层模型身份。

## 代理与 Cloudflare 排查

本机测试环境存在 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 环境变量，普通客户端可能自动使用代理。按用户要求，该平台后续测试应优先使用上述明确禁用代理的 curl 调用。

Python `urllib` 在默认网络设置下返回过 HTTP `403` / Cloudflare `1010`（`browser_signature_banned`）；使用 `ProxyHandler({})` 禁用代理后仍返回相同错误。换用 `curl.exe` 并禁用代理后成功。

因此，本次结果不能简单归因于代理，也不能据此认定密钥无效、模型不可用或必须修改站点规则。浏览器能打开网站与某个程序客户端能调用 API 不是同一项验证。后续若 curl 也被拦截，保留脱敏后的错误码与 Ray ID，请平台管理员排查，不反复重试。

## Codex 配置参考

以下是基于用户已有配置整理的相关片段，不是完整配置；本次只测试了 HTTP 接口，没有修改本机 Codex 配置，也没有验证 Codex 客户端的端到端调用。

```toml
model_provider = "OpenAI"
model = "gpt-5.6-sol"
review_model = "gpt-5.6-sol"
disable_response_storage = true

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://wbl.dpdns.org"
wire_api = "responses"
requires_openai_auth = true
```

这里的 `OpenAI` 是用户配置的 provider 标识，实际请求地址是第三方平台。配置片段不会自动读取下载目录的密钥，也不会自动禁用代理；认证和进程代理设置需另行配置。原有模型目录等无关配置保持不变。
