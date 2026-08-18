/**
 * Sprawl - software version-sprawl and end-of-life analysis over an inventory export.
 *
 * Ported from RFF's own SoftwareLifecycle engine, deliberately kept behaviour-identical: the same
 * family normalization, the same side-by-side suppression, the same curated EOL facts. This tool IS
 * the product's Software report, run on the reader's own export instead of on RFF-collected data.
 *
 * Framework-agnostic and dependency-free, like perfAnalyzer.ts and the other tool cores. Everything
 * runs on the caller's machine: nothing here uploads, fetches, or phones home, and that privacy
 * claim is the whole pitch - keep this file free of network calls forever.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV parsing
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** RFC4180-ish: handles quoted fields, embedded commas, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  // Strip a UTF-8 BOM: Intune and ConfigMgr exports both ship one, and it corrupts the first
  // header cell so column detection silently misses.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c === '\r') { /* handled by the \n */ }
    else field += c
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim() !== ''))
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Source detection + column mapping
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type SourceKind = 'intune' | 'configmgr' | 'generic' | 'unknown'

export interface ColumnMap {
  source: SourceKind
  /** Index of the application-name column. -1 when not found. */
  name: number
  /** Index of the version column, or -1. */
  version: number
  /** Index of a per-row device NAME, or -1. */
  device: number
  /** Index of a device COUNT column (Intune's discovered-apps export aggregates), or -1. */
  deviceCount: number
  headers: string[]
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Work out which columns matter. Every source names them differently, and this is the part that
 * actually decides whether the tool works on a stranger's file - the analysis below is easy by
 * comparison. Unknown layouts fall through to the manual mapper in the UI rather than guessing.
 */
export function detectColumns(headers: string[]): ColumnMap {
  const h = headers.map(norm)
  const find = (...cands: string[]) => {
    for (const c of cands) { const i = h.indexOf(c); if (i >= 0) return i }
    // Substring fallback for exports that prefix or suffix the header.
    for (const c of cands) { const i = h.findIndex(x => x.includes(c)); if (i >= 0) return i }
    return -1
  }

  const name = find('applicationname', 'appname', 'displayname', 'productname', 'software',
                    'softwarename', 'name', 'product', 'title')
  const version = find('applicationversion', 'appversion', 'displayversion', 'version',
                       'productversion', 'softwareversion')
  const device = find('devicename', 'computername', 'machinename', 'hostname', 'device',
                      'netbiosname0', 'name0', 'computer')
  const deviceCount = find('devicecount', 'installcount', 'devices', 'count', 'installs',
                           'numberofdevices')

  // The substring fallback above makes "Device count" match a search for a device NAME column, so
  // an aggregated Intune export was reporting "across 24 devices" - which was really the number of
  // distinct COUNT VALUES. A fabricated number in a report whose whole job is counting is worse
  // than an absent one, so a column can never be both.
  const deviceName = device === deviceCount ? -1 : device

  let source: SourceKind = 'unknown'
  if (h.includes('applicationname') && (h.includes('devicecount') || h.includes('applicationversion')))
    source = 'intune'
  else if (h.some(x => x.endsWith('0')) || h.includes('productname0') || h.includes('displayname0'))
    source = 'configmgr'   // ConfigMgr views suffix columns with the resource-index 0
  else if (name >= 0) source = 'generic'

  return { source, name, version, device: deviceName, deviceCount, headers }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Normalization + suppression (behaviour-identical to SoftwareLifecycle.cs)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Software where MANY CONCURRENT VERSIONS ARE CORRECT, so counting them as sprawl is noise. Apps
 * bind to a specific major, so one machine legitimately carries six VC++ redistributables. Without
 * this the report is dominated by exactly the rows nobody can act on - which is what a naive count
 * of a real 28k-endpoint export produces.
 */
const SIDE_BY_SIDE: RegExp[] = [
  /^microsoft visual c\+\+/,
  /^microsoft \.net (runtime|host|windows desktop runtime)/,
  /^microsoft windows desktop runtime/,
  /^windows driver package/,
  /\bmui\b/,
  /^microsoft office (shared|proofing|proof|osm|components|access setup|dcf)/,
  /^microsoft (word|excel|powerpoint|outlook|onenote|publisher|access|groove|infopath|skype for business) /,
  /^microsoft windows (10|11|7|8) /,
  /^update for windows/,
  /^security update for/,
  /^msxml \d/,
]

export const isSideBySideByDesign = (productName: string): boolean =>
  SIDE_BY_SIDE.some(r => r.test(productName.trim().toLowerCase()))

/**
 * Collapse a raw DisplayName to the FAMILY an operator thinks in. "Java 8 Update 491 (64-bit)" and
 * "Java 8 Update 481" are one product at two versions, not two products - without this the report
 * shows a hundred one-device rows and proves nothing. Bitness is preserved where it is genuinely a
 * separate install on disk.
 */
export function normalizeFamily(displayName: string): string {
  const n = displayName.trim()

  const java = n.match(/^Java (\d+)\s+Update\s+[\d._]+\s*(\(64-bit\))?/i)
  if (java) return `Java ${java[1]}${java[2] ? ' (64-bit)' : ''}`

  const citrix = n.match(/^(Citrix (?:Workspace|Receiver))\s+[\d.]+$/i)
  if (citrix) return citrix[1]

  // Agents that stamp their build into the name: "Tanium Client 7.8.4.1333".
  const trailing = n.match(/^(.*?)[ \-v.]*\d+(\.\d+){2,}\s*$/)
  if (trailing && trailing[1].trim().length > 3) return trailing[1].replace(/[ \-v.]+$/, '').trim()

  // "PowerShell 7.4.14.0-x64" / "OktaVerify-x64-6.12.2.0"
  const dashed = n.match(/^(.*?)[-\s]+\d+(\.\d+)+[-\s]*(x64|x86)?$/i)
  if (dashed && dashed[1].trim().length > 3) return dashed[1].replace(/[-\s]+$/, '').trim()

  // "7-Zip 24.09 (x64 edition)" / "Snagit 2025"
  const simple = n.match(/^(.*?)\s+\d[\d.]*\s*(\(.*\))?$/)
  if (simple && simple[1].trim().length > 3) return simple[1].trim()

  return n
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// End-of-life facts
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface EolEntry {
  match: RegExp
  product: string
  endOfSupport: string   // ISO date
  note: string
  severity: 'critical' | 'high' | 'medium'
}

/**
 * Every entry is a VERIFIABLE published vendor date. Where a date is genuinely unclear it is left
 * out rather than guessed: a false "this is EOL" costs an admin a pointless migration project,
 * which is worse than saying nothing.
 */
export const EOL: EolEntry[] = [
  { match: /^Adobe Flash Player/i, product: 'Adobe Flash Player', endOfSupport: '2020-12-31', severity: 'critical',
    note: 'Adobe ended support and shipped a kill-switch that blocks Flash content. Any remaining install is pure attack surface with no upside - uninstall.' },
  { match: /^Microsoft Silverlight/i, product: 'Microsoft Silverlight', endOfSupport: '2021-10-12', severity: 'critical',
    note: 'End of support October 2021, and no modern browser can run it. Nothing depends on it that still works - uninstall.' },
  { match: /^Java 6\b|^J2SE Runtime Environment 5/i, product: 'Oracle Java 6', endOfSupport: '2013-04-30', severity: 'critical',
    note: 'Public updates ended in 2013. Twelve-plus years of unpatched RCEs. If an app still requires it, that app needs a vendor conversation, not a Java install.' },
  { match: /^Java 7\b/i, product: 'Oracle Java 7', endOfSupport: '2015-04-30', severity: 'critical',
    note: 'Public updates ended April 2015. Same reasoning as Java 6.' },
  { match: /^Windows 10 Upgrade Assistant|^Windows 10 Update Assistant/i, product: 'Windows 10 Upgrade Assistant', endOfSupport: '2025-10-14', severity: 'medium',
    note: 'A one-shot upgrade helper that lingers after it has done its job. Harmless but it runs at logon and confuses upgrade reporting - remove it.' },
  { match: /^MSXML 4/i, product: 'MSXML 4.0', endOfSupport: '2014-04-12', severity: 'high',
    note: 'Out of support since 2014 and superseded by MSXML 6. Usually left behind by an uninstalled app.' },
  { match: /^Microsoft \.NET Framework 4 Client Profile/i, product: '.NET Framework 4 Client Profile', endOfSupport: '2016-01-12', severity: 'high',
    note: 'Support ended January 2016; superseded by 4.6.2+. Modern apps do not target it.' },
  // Adobe shipped this under three different Add/Remove names across its life ("Adobe Reader XI",
  // "Adobe Acrobat XI Pro", and the later "Adobe Acrobat Reader XI"), so match all three rather
  // than the two the original rule covered.
  { match: /^Adobe (?:Acrobat )?Reader XI|^Adobe Acrobat XI/i, product: 'Adobe Acrobat/Reader XI', endOfSupport: '2017-10-15', severity: 'critical',
    note: 'End of support October 2017. Acrobat is a top-three exploited client app - an unpatched one is a real risk, not a hygiene item.' },
  { match: /^Adobe Acrobat.*\b2020\b|^Adobe Acrobat 2020/i, product: 'Adobe Acrobat 2020', endOfSupport: '2025-06-01', severity: 'high',
    note: 'Classic-track 2020 reached end of support. Move to the continuous track or Acrobat 2024.' },
  { match: /^Microsoft Office (Professional|Standard).*2010|^Microsoft Office 2010/i, product: 'Microsoft Office 2010', endOfSupport: '2020-10-13', severity: 'critical',
    note: 'End of support October 2020. No security updates for a document-parsing application.' },
  { match: /^Microsoft Office (Professional|Standard).*2013|^Microsoft Office 2013/i, product: 'Microsoft Office 2013', endOfSupport: '2023-04-11', severity: 'high',
    note: 'End of support April 2023.' },
  { match: /^Microsoft Office (Professional|Standard).*2016|^Microsoft Office 2016/i, product: 'Microsoft Office 2016', endOfSupport: '2025-10-14', severity: 'high',
    note: 'End of support October 2025, alongside Windows 10. Plan the move to Microsoft 365 Apps.' },
  { match: /^Microsoft SQL Server 2012|^Microsoft SQL Server 2008/i, product: 'SQL Server 2008/2012 client components', endOfSupport: '2022-07-12', severity: 'medium',
    note: 'Native Client and tooling from these releases are out of support. Usually dragged in by an old line-of-business app.' },
  { match: /^Internet Explorer/i, product: 'Internet Explorer', endOfSupport: '2022-06-15', severity: 'high',
    note: 'Retired June 2022 and permanently disabled on current Windows. Any remaining shortcut or dependency should be retargeted to Edge IE mode.' },
  { match: /^Citrix Receiver\b/i, product: 'Citrix Receiver', endOfSupport: '2020-08-31', severity: 'high',
    note: 'Superseded by Citrix Workspace app. Receiver stopped receiving fixes; upgrading is also the fix for a long tail of session bugs.' },
  { match: /^Microsoft Windows 7|^Microsoft Windows 8/i, product: 'Windows 7 / 8', endOfSupport: '2023-01-10', severity: 'critical',
    note: 'Out of support including ESU. Anything still running it needs a hardware plan, not a patch.' },
  // Tight regexes anchored on the real Add/Remove shapes, not a loose version match - a loose one
  // catches ".NET Framework 4.7.2" and invents a migration project. EOL runs BEFORE side-by-side
  // suppression, so these surface even though .NET runtimes are excluded from sprawl.
  { match: /^Microsoft (?:\.NET|Windows Desktop) Runtime - 7\.|^Microsoft ASP\.NET Core 7\./i, product: '.NET 7', endOfSupport: '2024-05-14', severity: 'high',
    note: 'Out of support since May 2024 (18-month STS release). Applications keep running but get no security fixes. .NET 8 is the current LTS.' },
  { match: /^Microsoft (?:\.NET|Windows Desktop) Runtime - 6\.|^Microsoft ASP\.NET Core 6\./i, product: '.NET 6', endOfSupport: '2024-11-12', severity: 'high',
    note: 'Out of support since November 2024. Was the LTS before 8, so it is the most common straggler on a managed fleet.' },

  { match: /^Sophos Anti-Virus 10\b/i, product: 'Sophos Anti-Virus 10', endOfSupport: '2023-07-20', severity: 'high',
    note: 'Legacy Sophos Endpoint (SESC) is retired; superseded by Sophos Intercept X. An AV that no longer updates is worse than none, because dashboards still show the machine as covered.' },
]

export const findEol = (displayName: string): EolEntry | null =>
  EOL.find(e => e.match.test(displayName.trim())) ?? null

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface VersionRow { version: string; devices: number; sampleDevices: string[] }
export interface SprawlRow {
  family: string
  versions: VersionRow[]
  totalInstalls: number
  distinctVersions: number
  rawNames: string[]
}
export interface EolRow {
  product: string
  endOfSupport: string
  severity: 'critical' | 'high' | 'medium'
  note: string
  installs: number
  rawNames: string[]
  sampleDevices: string[]
}
export interface SprawlReport {
  source: SourceKind
  rowsParsed: number
  distinctApps: number
  distinctDevices: number
  /** Families with 2+ concurrent versions, worst first. */
  sprawl: SprawlRow[]
  eol: EolRow[]
  suppressed: number
  /** Set when the file parsed but no application-name column could be identified. */
  needsMapping: boolean
  headers: string[]
}

const cmpVersion = (a: string, b: string) => {
  const pa = a.split(/[._-]/).map(x => parseInt(x, 10))
  const pb = b.split(/[._-]/).map(x => parseInt(x, 10))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = isNaN(pa[i]) ? -1 : pa[i], y = isNaN(pb[i]) ? -1 : pb[i]
    if (x !== y) return x - y
  }
  return a.localeCompare(b)
}

/**
 * Does row 0 look like HEADERS, or is it already data?
 *
 * Real exports frequently have no header row - a hand-written SQL query piped to CSV, or a report
 * exported with headers switched off. Brian's 3.7M-row SCCM export starts straight in on
 * "100MCAOCAMPOLT,3M Coding and Reimbursement System WinAppLink,1.2.8", so assuming a header would
 * name a column after his first device AND silently discard that machine's first application.
 *
 * The test is deliberately about SHAPE, not a keyword list: if the first row looks statistically
 * like the rows beneath it (same width, and its cells resemble the column's other values), it is
 * data. A header row stands out because its cells do not look like their own column's contents.
 */
export function looksHeaderless(rows: string[][]): boolean {
  if (rows.length < 3) return false
  const first = rows[0]
  const body = rows.slice(1, 200)
  if (body.some(r => r.length !== first.length)) return false

  // A version-shaped cell in row 0 is the strongest single signal: no vendor calls a column "1.2.8".
  const versionish = (v: string) => /^\d[\d.]*$/.test(v.trim())
  if (first.some(versionish)) return true

  // Otherwise: a header cell is usually NOT repeated anywhere in its own column.
  let dataLike = 0
  for (let c = 0; c < first.length; c++) {
    const val = (first[c] ?? '').trim().toLowerCase()
    if (!val) continue
    const col = body.map(r => (r[c] ?? '').trim().toLowerCase())
    if (col.includes(val)) dataLike++
  }
  return dataLike > 0
}

/**
 * Guess which positional column is which when there are no headers to read. Returns indexes only;
 * the UI still shows the guess with a sample value so a human confirms rather than trusts it.
 */
export function guessColumnsByContent(rows: string[][]): { name: number; version: number; device: number } {
  const sample = rows.slice(0, 400)
  const width = Math.max(...sample.map(r => r.length))
  const frac = (c: number, test: (v: string) => boolean) => {
    const vals = sample.map(r => (r[c] ?? '').trim()).filter(Boolean)
    return vals.length ? vals.filter(test).length / vals.length : 0
  }
  const cols = Array.from({ length: width }, (_, c) => ({
    c,
    version: frac(c, v => /^\d[\d.]*$/.test(v)),
    // Application names carry spaces and punctuation; hostnames almost never do.
    spacey: frac(c, v => /\s/.test(v)),
    avgLen: (() => {
      const vals = sample.map(r => (r[c] ?? '').trim()).filter(Boolean)
      return vals.length ? vals.reduce((s, v) => s + v.length, 0) / vals.length : 0
    })(),
  }))

  const version = cols.slice().sort((a, b) => b.version - a.version)[0]
  const rest = cols.filter(x => x.c !== version.c)
  const name = rest.slice().sort((a, b) => b.spacey - a.spacey || b.avgLen - a.avgLen)[0]
  const device = rest.find(x => x.c !== name?.c)
  return { name: name?.c ?? 0, version: version?.version > 0.5 ? version.c : -1, device: device?.c ?? -1 }
}

export function analyze(rows: string[][], map?: ColumnMap): SprawlReport {
  const headers = rows[0] ?? []
  const cols = map ?? detectColumns(headers)
  if (cols.name < 0)
    return { source: cols.source, rowsParsed: 0, distinctApps: 0, distinctDevices: 0,
             sprawl: [], eol: [], suppressed: 0, needsMapping: true, headers }

  // A headerless file's first row is DATA. Skipping it would quietly lose one application from the
  // first device in the file - the sort of error nobody ever notices.
  const body = (map as ColumnMap & { headerless?: boolean })?.headerless ? rows : rows.slice(1)
  const devices = new Set<string>()
  let suppressed = 0

  // family -> version -> { count, devices }
  const fam = new Map<string, Map<string, { n: number; devs: Set<string> }>>()
  const famRaw = new Map<string, Set<string>>()
  const eolHits = new Map<string, { entry: EolEntry; n: number; raw: Set<string>; devs: Set<string> }>()

  for (const r of body) {
    const rawName = (r[cols.name] ?? '').trim()
    if (!rawName) continue
    const version = cols.version >= 0 ? (r[cols.version] ?? '').trim() : ''
    const device = cols.device >= 0 ? (r[cols.device] ?? '').trim() : ''
    // Intune's discovered-apps export is pre-aggregated: one row per app+version with a count.
    const count = cols.deviceCount >= 0 ? Math.max(1, parseInt(r[cols.deviceCount] ?? '1', 10) || 1) : 1
    if (device) devices.add(device.toLowerCase())

    // EOL is evaluated BEFORE suppression: unsupported software still matters even when several
    // concurrent versions of it are normal.
    const e = findEol(rawName)
    if (e) {
      const hit = eolHits.get(e.product) ?? { entry: e, n: 0, raw: new Set(), devs: new Set() }
      hit.n += count; hit.raw.add(rawName); if (device) hit.devs.add(device)
      eolHits.set(e.product, hit)
    }

    if (isSideBySideByDesign(rawName)) { suppressed++; continue }

    const family = normalizeFamily(rawName)
    const vkey = version || (rawName === family ? '(no version)' : rawName.slice(family.length).trim() || '(no version)')
    const byVer = fam.get(family) ?? new Map()
    const cell = byVer.get(vkey) ?? { n: 0, devs: new Set<string>() }
    cell.n += count
    if (device) cell.devs.add(device)
    byVer.set(vkey, cell)
    fam.set(family, byVer)
    const raws = famRaw.get(family) ?? new Set<string>()
    raws.add(rawName); famRaw.set(family, raws)
  }

  const sprawl: SprawlRow[] = []
  for (const [family, byVer] of fam) {
    if (byVer.size < 2) continue        // one version is not sprawl
    const versions: VersionRow[] = [...byVer.entries()]
      .map(([version, c]) => ({ version, devices: c.n, sampleDevices: [...c.devs].slice(0, 8) }))
      .sort((a, b) => cmpVersion(a.version, b.version))
    sprawl.push({
      family,
      versions,
      totalInstalls: versions.reduce((s, v) => s + v.devices, 0),
      distinctVersions: versions.length,
      rawNames: [...(famRaw.get(family) ?? [])].slice(0, 12),
    })
  }
  // Worst sprawl first: most versions, then most installs.
  sprawl.sort((a, b) => b.distinctVersions - a.distinctVersions || b.totalInstalls - a.totalInstalls)

  const sevRank = { critical: 0, high: 1, medium: 2 }
  const eol: EolRow[] = [...eolHits.values()].map(h => ({
    product: h.entry.product, endOfSupport: h.entry.endOfSupport, severity: h.entry.severity,
    note: h.entry.note, installs: h.n, rawNames: [...h.raw].slice(0, 12),
    sampleDevices: [...h.devs].slice(0, 8),
  })).sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.installs - a.installs)

  return {
    source: cols.source,
    rowsParsed: body.length,
    distinctApps: fam.size,
    distinctDevices: devices.size,
    sprawl, eol, suppressed,
    needsMapping: false,
    headers,
  }
}
