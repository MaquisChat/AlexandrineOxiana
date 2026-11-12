# Standard licence texts

The texts the builds use for a shipped package that carries no licence text of its own (Task 37j,
ADR 0015). Such a package is always named in the "no text shipped by the package" section of its
part's notices file, so a person can check it. A package whose declared licence has no text here
fails the build.

Each file is the SPDX License List's plain-text form of the identifier in its file name, copied
unmodified from <https://github.com/spdx/license-list-data>, tag `v3.27.0`, folder `text/`
(fetched 2026-11-12). Template placeholders such as `<year> <copyright holders>` are part of the
SPDX text and are left as they are: the package's own copyright line is unknown when it ships no text.

| File | SPDX identifier | sha256 |
| --- | --- | --- |
| 0BSD.txt | 0BSD | e3f18c71e10d673590eb9856c1d79dd3b4b0d65404efb5e8584dbede7edd608b |
| Apache-2.0.txt | Apache-2.0 | 074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff |
| BSD-2-Clause.txt | BSD-2-Clause | f32fb3b417a194167cfad068223fc975ba96c5960513a10f66a3c28720aec1df |
| BSD-3-Clause.txt | BSD-3-Clause | 5a93d5831e1297ab10fe643e1a631e83be392896da14ee2951285a79012df69d |
| CC0-1.0.txt | CC0-1.0 | a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499 |
| ISC.txt | ISC | f2ec607f67bb0dd3053b49835b02110d5cd0f8eb6da3aac4dc0b142a6b299be9 |
| LLVM-exception.txt | LLVM-exception (an exception, used as `Apache-2.0 WITH LLVM-exception`) | e34c58338bd89d43e709e226610d8f32b3e3c47f4ad9a99a8dc1d4ac7842488e |
| MIT-0.txt | MIT-0 | 59746d6285ffa44bfc7ecada352aa5d6a20dc8eab418a60ce091cc739012c135 |
| MIT.txt | MIT | b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5 |
| MPL-2.0.txt | MPL-2.0 | 66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172 |
| Unicode-3.0.txt | Unicode-3.0 | f7db81051789b729fea528a63ec4c938fdcb93d9d61d97dc8cc2e9df6d47f2a1 |
| Unlicense.txt | Unlicense | 0bdebfeda07d45dada625ae1317c6f833186e798b171d0db640bcf32e92a8240 |
| Zlib.txt | Zlib | bfb1112d49db5b1daecdfef24bd7e2f3ea0bafb33aa67aa0ab51e2bf8407c03d |

To add one: copy `text/<id>.txt` from the same tag unmodified, add its row here, and say in the commit
which package needed it. Never write a text by hand.
