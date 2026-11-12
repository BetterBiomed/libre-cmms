# Contributing to Libre

Thank you for helping improve Libre! Libre is owned and maintained by **CreativeMed LLC**.

## Contributor License Agreement

So that CreativeMed LLC can keep offering Libre under both the AGPL and commercial
licenses, contributors must agree that:

1. You wrote the contribution, or have the right to submit it.
2. You grant CreativeMed LLC a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable license to use, modify, sublicense and relicense your contribution
   under any terms, including proprietary terms.
3. Your contribution is also published to everyone under the AGPL-3.0-or-later.

Indicate agreement by adding this line to each commit message:

```
Signed-off-by: Your Name <you@example.com>  (I agree to the Libre CLA in CONTRIBUTING.md)
```

## Development

```bash
node server/server.js     # run on http://localhost:8080 (data in ./data)
node --test               # run the end-to-end API tests
```

* There are no npm dependencies. Please keep it that way: use Node.js built-in modules only.
* Every source file starts with `// Libre CMMS - Copyright (C) 2026 CreativeMed LLC` and `// SPDX-License-Identifier: AGPL-3.0-or-later`.
* Database tables come from `server/schema.js`. Add a field there and it appears in the database (migrated automatically), the API and the UI.
* Business rules live in `server/lib/logic.js`, reports in `server/lib/reports.js`.
* The web client is plain JavaScript in `public/js/app.js` (no build step).
