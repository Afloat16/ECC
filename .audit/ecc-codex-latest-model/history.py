import json
import subprocess

def git(*args):
    return subprocess.check_output(["git", *args], text=True)

subprocess.run(["git", "fetch", "--no-tags", "https://github.com/Afloat16/ECC.git",
                "+refs/heads/*:refs/remotes/history-fork/*"], check=True)
subprocess.run(["git", "fetch", "--no-tags", "https://github.com/affaan-m/ECC.git",
                "+refs/heads/*:refs/remotes/history-upstream/*",
                "+refs/pull/*/head:refs/remotes/history-pr/*"], check=True)
paths = {"scripts/lib/session-adapters/codex-worktree.js"}
renames = []
for line in git("log", "--all", "--format=", "--name-status", "--find-renames").splitlines():
    fields = line.split("\t")
    if len(fields) == 3 and fields[0].startswith("R"):
        renames.append(fields[1:])
changed = True
while changed:
    changed = False
    for left, right in renames:
        if left in paths or right in paths:
            for name in (left, right):
                if name not in paths:
                    paths.add(name)
                    changed = True
objects = {}
for line in git("rev-list", "--objects", "--all", "--", *sorted(paths)).splitlines():
    fields = line.split(" ", 1)
    if len(fields) == 2 and fields[1] in paths:
        objects.setdefault(fields[0], []).append(fields[1])
blobs = []
for sha, names in objects.items():
    if git("cat-file", "-t", sha).strip() != "blob":
        continue
    source = git("cat-file", "blob", sha)
    start = source.find("function deriveModel(")
    end = source.find("\nfunction ", start + 1) if start >= 0 else -1
    evidence = source[start:end if end >= 0 else len(source)] if start >= 0 else source
    blobs.append({"sha": sha, "paths": sorted(names), "derive_model_source": evidence})
refs = git("for-each-ref", "--format=%(refname)").splitlines()
report = {
    "base": "d4b97e60dd7d8cdf01962881776a758769c0ba85",
    "refs": refs, "ref_count": len(refs),
    "fork_branch_count": sum(ref.startswith("refs/remotes/history-fork/") for ref in refs),
    "upstream_pr_head_count": sum(ref.startswith("refs/remotes/history-pr/") for ref in refs),
    "reachable_commit_count": int(git("rev-list", "--count", "--all")),
    "paths": sorted(paths), "rename_edges": [r for r in renames if r[0] in paths or r[1] in paths],
    "blob_count": len(blobs), "blobs": blobs,
}
print("ECC_CODEX_MODEL_HISTORY_BEGIN")
print(json.dumps(report, ensure_ascii=False))
print("ECC_CODEX_MODEL_HISTORY_END")
