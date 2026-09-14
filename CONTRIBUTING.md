# Contributing

- Keep measurements honest: a number on the page must come from a timestamp taken in code, and every report states what
  is excluded (errored, never committed) and what a timestamp means.
- Run `npm test` in `lab-server` against a fresh stack before changing the engine; run `npm run render-check` in `lab-ui`
  after touching the page.
- Never commit `run/*.addr`, logs, or the `gear` checkout.
- Node behaviour claims should cite gear source (`file:line`); see `.prism/project-model.md` for the ones already verified.
