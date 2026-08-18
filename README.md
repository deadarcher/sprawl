# Sprawl

**How many versions of everything are you actually running?**

Export the software inventory you already have — SCCM / MECM / Configuration Manager, Intune, or
your RMM — drop the CSV in, and get every application that exists at more than one version across
your fleet, plus anything the vendor has stopped patching.

Runs **entirely in your browser**. The file never leaves your machine: no upload, no account, no
server. You can verify that by opening devtools and watching the network tab, or by disconnecting
from the network before dropping the file — it still works.

Live at **https://getrff.com/sprawl/**

## What it does

- **Version sprawl** — collapses raw Add/Remove Programs names into the product an operator
  actually thinks in (`Java 8 Update 491 (64-bit)` and `Java 8 Update 451` are one product at two
  versions), then shows every product running more than one version, sortable by install count or
  by how fragmented it is.
- **End of life** — flags software past its published vendor end-of-support date, with the date,
  how long ago, and what to do about it.
- **Suppresses the noise** — Visual C++ redistributables, .NET runtimes, MUI language packs,
  driver packages and Office shared components are designed to run side by side. Many concurrent
  versions of those is *correct*, not sprawl, so counting them buries the real signal under the
  only rows nobody can act on. The report says how many rows it suppressed.

Tested against a real 3.7M-row, 37,000-device hospital export.

## Getting your export

The tool gives you a ready-to-paste command for each source. In short:

| Source | How |
|---|---|
| **Intune** | `Get-MgDeviceManagementDetectedApp -All` via Microsoft Graph |
| **SCCM / MECM** | A read-only `SELECT` against `v_Add_Remove_Programs` joined to `v_R_System` |
| **RMM** | Any CSV with an application-name column |
| **No inventory system** | A local registry query (never `Win32_Product` — that class reconfigures every installed MSI) |

Any CSV with an application-name column works. Headers are optional; if the columns are not
recognised you map them by hand.

## Run it yourself

```bash
docker compose up -d       # then open http://localhost:8080
```

or without compose:

```bash
docker build -t sprawl .
docker run --rm -p 8080:80 sprawl
```

Local development:

```bash
npm install
npm run dev
```

## Accuracy notes

Every end-of-life entry is a **published vendor date**, curated by hand. Where a date is genuinely
unclear it is left out rather than guessed — a false "this is end of life" costs an admin a
pointless migration project, which is worse than saying nothing. If a vendor's naming defeats the
family matcher, or an end-of-life fact is wrong or missing,
[open an issue](https://github.com/deadarcher/sprawl/issues) — that part always needs real-world
data.

## Why it exists

It is the software report from [RFF](https://getrff.com), run on your own export instead of on data
RFF collects. Same normalization, same suppression rules, same curated end-of-support list. If you
want it running continuously against your fleet rather than against a CSV you exported by hand,
that is the product.

`src/lib/sprawlAnalyzer.ts` is the whole engine and is kept byte-identical with the hosted copy
(`npm run check:parity`).

## Licence

MIT — see [LICENSE](LICENSE).
