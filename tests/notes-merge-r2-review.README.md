# Merge r2 independent review

`notes-merge-r2-review.test.ts` runs real Bun SQLite repositories. RVM2-11 and
RVM2-13 intentionally fail on b16983e8. The third test compares the actual watch and
mini v2 receive functions across Unicode alias vectors and six repeated rounds.

Set NOTES_MINI_V2_ROOT to the separate mini v2 review checkout. With locally
installed dependencies, run under the worktree flock and capmem 8G:
`bun test ./tests/notes-merge-review.test.ts ./tests/notes-merge-r2-review.test.ts`.
No server is used. Original assertions are unchanged.
