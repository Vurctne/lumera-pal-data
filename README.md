# Lumera PAL data publisher

This directory is copied into the public `Vurctne/lumera-pal-data` repository as `scripts/`. That repository publishes free, public JSON reference data used by Lumera 3.0.7 and later.

The dataset is an independent convenience copy of public Policy and Advisory Library material. It is not an official Department of Education mirror. The source links in each record point to the authoritative PAL pages; users should follow those links when accuracy or currency matters. Lumera application source code and user files are never included in this dataset or sent to the publisher.

The weekly job runs at 06:00 Monday in `Australia/Melbourne`. It reads the current release, requests public PAL pages over the network, validates a complete replacement package, and publishes it only after downloading the draft assets again and checking their checksum. `manifest.json` records `generatedAt`, the package version, payload size and SHA-256. If collection or validation fails, the existing latest release remains available.

Public release assets:

- `manifest.json` — version, update time, compatibility and checksum metadata
- `pal-dataset.json.gz` — gzip-compressed JSON reference dataset
- `report.json` — machine-readable refresh report

Stable latest-release URLs:

- `https://github.com/Vurctne/lumera-pal-data/releases/latest/download/manifest.json`
- `https://github.com/Vurctne/lumera-pal-data/releases/latest/download/pal-dataset.json.gz`
- `https://github.com/Vurctne/lumera-pal-data/releases/latest/download/report.json`

Run locally with Node.js 24 or later:

```bash
node --test scripts/*.node.mjs
node scripts/run.mjs --previous ./previous --out ./next
GITHUB_TOKEN=... node scripts/publish.mjs --dir ./next
```

`run.mjs` accepts only the two explicit directory arguments above. It validates the previous package before network work, rejects partial refreshes, validates the new encoded package, and exposes the output directory only after every file is complete. `publish.mjs` is fixed to `Vurctne/lumera-pal-data`; release versions are immutable and cannot be overwritten.
