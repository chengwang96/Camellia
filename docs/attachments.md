# Attach artifacts and conversations

Type `/attach` in the desktop composer and choose **/attach** from the slash
menu. The picker has two sources:

- **This conversation** lists files produced by completed turns in the current
  conversation. Search matches file names, paths, kinds and extensions. Deleted
  files are omitted, and selecting a result adds it as a normal attachment.
- **All conversations** lists active shared conversations across Camellia's
  engines, newest first. The current conversation is excluded. Selecting one
  creates the same bounded Markdown handoff used by cross-engine continuation
  and attaches both the overview and its full JSONL transcript.

The paperclip button opens the broader attachment menu: local files, current
artifacts, or another conversation. Conversation handoffs stay on disk after the
source conversation is deleted, and removing an unused handoff chip cleans up
its temporary files.

## Checks

```bash
node --test tests/shared-conversations.test.js
python tests/conversation-attachment-ui.py
```
