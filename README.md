# everhall.ca — Double Cross

A daily word puzzle: each card carries two clues and two answers, and nothing tells you which goes where.
A new puzzle every calendar day, computed in the browser — no server, no tracking, no accounts.

**Play:** https://everhall.ca

## How it's hosted
This repo is served by GitHub Pages. The whole site is the single self-contained
`index.html` (the game, fonts, and puzzle bank are all inlined). `CNAME` binds it to
`everhall.ca`; `404.html` bounces stray paths back to the puzzle.

To update the game, replace `index.html` and push — GitHub Pages redeploys automatically.
