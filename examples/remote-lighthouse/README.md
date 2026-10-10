# Lighthouse remote plugin

Runs [Lighthouse](https://github.com/GoogleChrome/lighthouse) against the URL of each reading and
returns category scores, Core Web Vitals and failing audits as HAR-PLUS findings.

```sh
node examples/remote-lighthouse/server.mjs     # http://localhost:8787/
```

Then in the extension: **Options → Remote plugins** → Name `Lighthouse`, URL `http://localhost:8787/`,
Send `Target URL + readout`, timeout `180`. New readings include a Lighthouse panel; use
**Re-run analysis** to add it to old ones. From the CLI:

```sh
node cli/harplus.mjs analyze site.har --remote http://localhost:8787/
```

Lighthouse (13.5.0) is fetched with `npx` on first use. Environment variables: `PORT`,
`LIGHTHOUSE_BIN` (a local lighthouse binary), `CHROME_PATH`, `CHROME_FLAGS` (default
`--headless=new`; add `--no-sandbox` in containers).

Lighthouse loads the page in its own clean Chrome profile, so logged-in pages are audited in their
logged-out state. The mapping lives in `toPluginResult()` and is unit-tested in `test/cli.test.mjs`.
