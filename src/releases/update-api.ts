/**
 * update-api.ts — 1C's update service (https://update-api.1c.ru/update-platform),
 * the one typical configurations ask through the internet-support library (БИП).
 * The reference methods need no ITS account: the next version with its chain
 * (file UINs), the minimum platform, patches. File links do (not used here).
 * Worked out in github.com/iMironRU/1CExchenge (UPDATE-API.md).
 *
 * A program is addressed by its internet-support identifier (programName), not
 * by the portal nick: «Accounting» for Accounting30, «HRMBase» for the whole
 * ЗУП family. programNameFor() knows the rule and the exceptions.
 */

const API = "https://update-api.1c.ru/update-platform";

// template name (the folder in tmplts) → programName, where the rule «folder name» fails
const EXCEPTIONS: Record<string, string> = {
  HRM: "HRMBase", HRMCorp: "HRMBase", HRMBase: "HRMBase", StateHRM: "HRMBase", StateHRMCorp: "HRMBase",
};
// Products the service does not serve (no internet-support identifier in the configuration).
const UNSERVED = new Set(["BMO", "ClientEDOBase", "ClientEDO", "Enterprise", "Contracts"]);

/** The internet-support identifier of a 1C typical configuration, or null. */
export function programNameFor(templateCode: string | null | undefined): string | null {
  const m = (templateCode ?? "").match(/^1c\/([A-Za-z0-9_]+)$/);
  if (!m) return null;
  const name = m[1];
  if (UNSERVED.has(name)) return null;
  return EXCEPTIONS[name] ?? name;
}

export interface ProgramInfo {
  known: boolean;                    // the service recognised program + version
  next: string | null;               // next configuration version (null: current)
  files: number | null;              // files in the service's chain
  size: number | null;
  platformMin: string | null;        // for the next version
  newsUrl: string | null;
  supportEnd: string | null;
  platformRecommended: string | null;
  error?: string;
}

function params(configName: string, version: string, platform: string) {
  return Object.entries({
    ClientPlatformType: "Windows_x86_64", ClientOSVersion: "Windows 10", PlatformVersion: platform,
    ConfigName: configName, ConfigVersion: version, Vendor: 'Фирма "1С"', ConfigLanguage: "ru", ConfigMainLanguage: "ru",
    CurLocalizationCode: "ru_RU", SystemLanguage: "ru", ClientTimeOffsetGMT: "10800", countryId: "", IBIsSeparated: "false", platform64Supported: "true",
  }).map(([key, value]) => ({ key, value }));
}

export async function programInfo(programName: string, version: string, configName = "", platform = "8.3.27.1859"): Promise<ProgramInfo> {
  const body = {
    programName, versionNumber: version, platformVersion: platform, programNewName: "", redactionNumber: "",
    updateType: "NewConfigurationAndOrPlatform", additionalParameters: params(configName, version, platform),
  };
  const r = await fetch(`${API}/programs/update/info`, {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "1C+Enterprise/8.3" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) return { known: false, next: null, files: null, size: null, platformMin: null, newsUrl: null, supportEnd: null, platformRecommended: null, error: `HTTP ${r.status}` };
  const j = await r.json() as any;
  const cu = j.configurationUpdateResponse ?? null, pu = j.platformUpdateResponse ?? null;
  if (j.errorMessage) return { known: false, next: null, files: null, size: null, platformMin: null, newsUrl: null, supportEnd: null, platformRecommended: null, error: String(j.errorMessage) };
  // An unknown program/version answers with every field null — a known current one still
  // carries the platform part.
  const known = !!(cu && (cu.configurationVersion || cu.programVersionUin)) || !!(pu && pu.platformVersion);
  return {
    known,
    next: cu?.configurationVersion ?? null,
    files: Array.isArray(cu?.upgradeSequence) ? cu.upgradeSequence.length : null,
    size: cu?.size ?? null,
    platformMin: cu?.platformVersion ?? null,
    newsUrl: cu?.updateInfoUrl ?? null,
    supportEnd: j.currentReleaseSupportEndDate ?? cu?.supportEndDate ?? null,
    platformRecommended: pu?.recommended ? pu.platformVersion ?? null : null,
  };
}
