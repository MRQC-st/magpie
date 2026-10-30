#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校验 docs/ 下台账类文档的「主题索引 ⇄ 条目」一致性。

规范来源：knowledge-wiki `references/project-docs-spec.md` §3 硬规则 4
（台账 = 单文件 + append-only + **带覆盖标记的索引** + 校验脚本）
与 §4（`DEC-*` 编号永不重编）。

校验两件事：
  1. `99-变更日志.md`：每条条目有唯一的 `DEC-MAG-*` 编号；索引表与条目一一对应；
     覆盖标记 `<!-- TOPIC-INDEX-GENERATED-THROUGH: N -->` 等于最大编号。
  2. `03-踩坑与更正.md`：每条 `## <n>.` 小节在索引表里出现一次；覆盖标记等于最大小节号。

退出码：0 = 通过；1 = 发现问题；2 = 自检失败（**检查器本身坏了，任何结论都不可信**）。

自检（--self-test）：用**同一批生产函数**跑正反两组样本 ——
干净样本必须 PASS，注入缺陷的样本必须 FAIL（只跑正向 = 没验证）。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

CHANGELOG = DOCS / "99-变更日志.md"
PITFALLS = DOCS / "03-踩坑与更正.md"

DEC_RE = re.compile(r"<!--\s*(DEC-[A-Z]+-\d+)\s*-->")
COVERAGE_RE = re.compile(r"<!--\s*TOPIC-INDEX-GENERATED-THROUGH:\s*(\d+)\s*-->")
HEADING_RE = re.compile(r"^##\s+(.+?)\s*$", re.M)
INDEX_HEADING_RE = re.compile(r"^##\s+.*索引.*$", re.M)
PITFALL_HEADING_RE = re.compile(r"^##\s+(\d+)\.", re.M)


# ---------------------------------------------------------------- 切分

def split_index(text: str):
    """把「主题索引」小节与正文分开。

    返回 (索引段, 正文段)。找不到索引小节时，索引段为空串（= 没有索引）。
    """
    m = INDEX_HEADING_RE.search(text)
    if not m:
        return "", text
    nxt = HEADING_RE.search(text, m.end())
    body_start = nxt.start() if nxt else len(text)
    return text[m.start():body_start], text[body_start:]


def entries_of(body: str):
    """正文里的条目：[(标题, DEC 编号 or None)]，按出现顺序。"""
    out = []
    for m in HEADING_RE.finditer(body):
        title = m.group(1)
        dec = DEC_RE.search(title)
        out.append((title, dec.group(1) if dec else None))
    return out


def index_ids_of(index: str):
    """索引表里列出的 DEC 编号（按出现顺序，可重复以便检出重复）。"""
    return re.findall(r"`(DEC-[A-Z]+-\d+)`", index)


def coverage_of(text: str):
    m = COVERAGE_RE.search(text)
    return int(m.group(1)) if m else None


def pitfall_sections(body: str):
    return [int(m.group(1)) for m in PITFALL_HEADING_RE.finditer(body)]


# ---------------------------------------------------------------- 检查

def check_changelog(text: str):
    """返回问题列表；空列表 = 通过。"""
    problems = []
    index, body = split_index(text)
    if not index:
        return ["变更日志缺少「主题索引」小节（台账必须有导航）"]

    entries = entries_of(body)
    if not entries:
        return ["变更日志正文里没有任何 `## ` 条目"]

    missing = [t for t, d in entries if d is None]
    if missing:
        problems.append(
            "以下条目没有 DEC 编号（每条都要有，编号永不重编）：%s"
            % "；".join(missing[:5])
        )

    ids = [d for _, d in entries if d]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        problems.append("DEC 编号重复：%s" % "、".join(dup))

    indexed = index_ids_of(index)
    idup = sorted({i for i in indexed if indexed.count(i) > 1})
    if idup:
        problems.append("索引表里 DEC 编号重复：%s" % "、".join(idup))

    missing_in_index = [i for i in ids if i not in indexed]
    if missing_in_index:
        problems.append("这些条目没进索引表：%s" % "、".join(missing_in_index))
    ghost = [i for i in indexed if i not in ids]
    if ghost:
        problems.append("索引表里有不存在的条目：%s" % "、".join(ghost))

    cov = coverage_of(text)
    if cov is None:
        problems.append("缺少覆盖标记 <!-- TOPIC-INDEX-GENERATED-THROUGH: N -->")
    else:
        nums = [int(i.rsplit("-", 1)[1]) for i in ids]
        if nums and cov != max(nums):
            problems.append(
                "覆盖标记是 %d，但最大 DEC 编号是 %d（覆盖标记必须等于已覆盖到的最大编号）"
                % (cov, max(nums))
            )
    return problems


def check_pitfalls(text: str):
    problems = []
    index, body = split_index(text)
    if not index:
        return ["踩坑台账缺少「主题索引」小节（台账必须有导航）"]

    secs = pitfall_sections(body)
    if not secs:
        return ["踩坑台账正文里没有任何 `## <n>.` 小节"]

    listed = [int(m.group(1)) for m in re.finditer(r"^\|\s*(\d+)\s*\|", index, re.M)]
    missing = [n for n in secs if n not in listed]
    if missing:
        problems.append("这些小节没进索引表：%s" % "、".join(str(n) for n in missing))
    ghost = [n for n in listed if n not in secs]
    if ghost:
        problems.append("索引表里有不存在的小节：%s" % "、".join(str(n) for n in ghost))

    cov = coverage_of(text)
    if cov is None:
        problems.append("缺少覆盖标记 <!-- TOPIC-INDEX-GENERATED-THROUGH: N -->")
    elif cov != max(secs):
        problems.append("覆盖标记是 %d，但最大小节号是 %d" % (cov, max(secs)))
    return problems


# ---------------------------------------------------------------- 自检

def self_test():
    """正反两组样本，打在**生产函数**上。反向对照必须 FAIL，否则检查器是空转的。"""
    clean = """# 变更日志

## 主题索引

<!-- TOPIC-INDEX-GENERATED-THROUGH: 2 -->

| DEC | 主题 |
|---|---|
| `DEC-MAG-001` | 一 |
| `DEC-MAG-002` | 二 |

## 条目一 <!-- DEC-MAG-001 -->
正文

## 条目二 <!-- DEC-MAG-002 -->
正文
"""
    problems = check_changelog(clean)
    if problems:
        return False, "干净样本竟然报错：%s" % problems

    if not check_changelog(
        clean.replace("<!-- TOPIC-INDEX-GENERATED-THROUGH: 2 -->",
                      "<!-- TOPIC-INDEX-GENERATED-THROUGH: 5 -->")):
        return False, "覆盖标记错了却没报错（检查器空转）"

    if not check_changelog(clean.replace(" <!-- DEC-MAG-002 -->", "")):
        return False, "条目缺 DEC 编号却没报错"

    if not check_changelog(
        clean.replace("| `DEC-MAG-001` | 一 |",
                      "| `DEC-MAG-001` | 一 |\n| `DEC-MAG-009` | 幽灵 |")):
        return False, "索引里出现不存在的条目却没报错"

    if not check_changelog(clean.replace("| `DEC-MAG-002` | 二 |", "")):
        return False, "条目没进索引却没报错"

    pclean = """# 踩坑

## 主题索引

<!-- TOPIC-INDEX-GENERATED-THROUGH: 2 -->

| # | 坑 |
|---|---|
| 1 | 甲 |
| 2 | 乙 |

## 1. 甲
## 2. 乙
"""
    problems = check_pitfalls(pclean)
    if problems:
        return False, "坑台账干净样本竟然报错：%s" % problems
    if not check_pitfalls(pclean.replace("| 2 | 乙 |", "")):
        return False, "小节没进索引却没报错"
    return True, "自检通过：检查器会报错，且不误伤干净结构 ✅"


def main(argv):
    if "--self-test" in argv:
        ok, msg = self_test()
        print(msg)
        return 0 if ok else 2

    rc = 0
    for path, checker in ((CHANGELOG, check_changelog), (PITFALLS, check_pitfalls)):
        if not path.exists():
            print("找不到文件：%s" % path)
            rc = 1
            continue
        text = path.read_text(encoding="utf-8")
        problems = checker(text)
        if problems:
            rc = 1
            print("❌ %s" % path.name)
            for p in problems:
                print("   - %s" % p)
        else:
            print("✅ %s：索引与条目一致，覆盖标记正确" % path.name)
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
