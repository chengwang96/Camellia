# External benchmark sources

DS-1000 data and official test code are downloaded unchanged from
https://github.com/xlang-ai/DS-1000 at revision
`b39aab71da6d23ef8d3cac59a7c5f834516ab334`, under CC BY-SA 4.0.
Authors: Yuhang Lai, Chengxi Li, Yiming Wang, Tianyi Zhang, Ruiqi Zhong,
Luke Zettlemoyer, Scott Wen-tau Yih, Daniel Fried, Sida Wang, and Tao Yu.
Paper: https://arxiv.org/abs/2211.11501. License: `DS-1000.txt`.
Camellia evaluates individual iterations of the original execution test and
the original code-constraint test separately to report partial credit.

SciCode problems are downloaded unchanged from
https://huggingface.co/datasets/SciCode1/SciCode at revision
`4510f6a6aa27c43fad7b43da2c59602a86e88480`. The numerical test data are from
the Google Drive file linked by the official repository. Both downloads
are pinned by SHA-256. Source and authors: https://github.com/scicode-bench/SciCode.
Paper: https://arxiv.org/abs/2407.13168. License: `SciCode.txt` (Apache 2.0).
`python/scicode_targets.py` retains the HDF5 reader functions from that
repository at revision `e3158ea011d4235245a547460d3688d7ccbf9900`, without
the model SDK and dataset-loader imports. Files in `python/provided/` are
the three helper steps supplied by the official evaluator at that revision.
`python/scicode/compare/cmp.py` is the unchanged official comparison helper
from the same revision (SHA-256
`8b3e790cc29dc87ef1f0f1b9bfd68c877728c78c40b541a69d10015221e9e235`).
The local package initializers only expose these helpers to the checker.

The Camellia adapter uses file-editing agents, fixed samples, independent
per-case processes, a pinned execution environment and check completion
as its primary metric. Its scores are not official DS-1000 or SciCode
leaderboard submissions. Source revisions, ordered task IDs, data hashes
and adapter/environment versions accompany each saved report.
