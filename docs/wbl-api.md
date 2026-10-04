# WBL API call record

This is a **dated local connectivity record**, not a guarantee about current WBL availability, model identity, parameters, or client compatibility. The observed request used `https://wbl.dpdns.org/responses` (the root `/responses` path), the `gpt-5.6-sol` model name, an `Authorization: Bearer` header, and `Content-Type: application/json`. `/v1/responses` was not tested. No key value is stored in this repository.

## Reproduce the request

The original Windows test used `curl.exe` with `-q --noproxy "*" --proxy ""` to avoid local curl configuration and proxy environment settings for this request only. In PowerShell, keep a single plaintext key in `%USERPROFILE%\Downloads\token.txt`, then pass curl's configuration through stdin so the key does not appear on the command line:

```powershell
@'
import json
import os
from pathlib import Path
import subprocess

key = (Path(os.environ['USERPROFILE']) / 'Downloads' / 'token.txt').read_text(encoding='utf-8-sig').strip()
if not key or any(char.isspace() for char in key):
    raise SystemExit('token.txt must contain one plain-text API key')

def quoted(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'

payload = json.dumps({'model':'gpt-5.6-sol', 'input':'Reply with exactly: OK',
                      'store':False, 'max_output_tokens':64})
config = '\n'.join([
    'header = ' + quoted('Authorization: Bearer ' + key),
    'header = "Content-Type: application/json"',
    'data = ' + quoted(payload),
])
result = subprocess.run(
    ['curl.exe', '-q', '--noproxy', '*', '--proxy', '', '--silent',
     '--show-error', '--connect-timeout', '20', '--max-time', '90',
     '--config', '-', '--write-out', '\nHTTP_STATUS:%{http_code}\n',
     'https://wbl.dpdns.org/responses'],
    input=config, capture_output=True, text=True, encoding='utf-8',
)
print(result.stdout.replace(key, '[REDACTED]'))
print(result.stderr.replace(key, '[REDACTED]'))
raise SystemExit(result.returncode)
'@ | python -
```

This sends a real API request and may incur a charge. A zero curl exit code does not prove API success: inspect the HTTP status and response events.

## Observed response and limits

The local request returned HTTP 200 in about 6.9 seconds and the text `OK`. The stream ended with `response.completed`; it reported 11 input and 5 output tokens. Although the request omitted `stream`, the service returned server-sent events. Text appeared in `response.output_text.delta` and `response.output_text.done`; the final `response.output` array was empty in this sample. A client that only parses one final JSON body or the final output array would miss the answer.

The response echoed `store: false` but that does not verify the third-party service's retention policy. It returned `max_output_tokens: null` despite the requested limit, and the short test does not establish enforcement. The returned model name is the service's report, not independent proof of underlying model identity.

In the original environment, Python `urllib` received Cloudflare 403/1010 both with the default proxy and with `ProxyHandler({})`, while the direct curl request succeeded. The result alone cannot identify the cause or prove a key or model is invalid. Preserve redacted status and Ray ID for the service administrator if this recurs.

For Codex configuration, the historical example used `base_url = "https://wbl.dpdns.org"`, `wire_api = "responses"`, and the provider model ID above. The HTTP test did not validate an end-to-end Codex session; provider authentication and process proxy settings must be configured separately.
