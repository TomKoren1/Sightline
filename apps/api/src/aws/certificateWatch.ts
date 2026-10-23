/**
 * A Roles Anywhere certificate that expires stops every scan at once, with an
 * error from AWS that does not say why. So both processes say so in their own
 * log, at startup and twice a day, from thirty days out.
 */

import { cfg } from "../config.js";
import { certificateDaysLeft } from "./rolesAnywhere.js";

const WARN_DAYS = 30;

export function certificateWarning(path: string | undefined, now = new Date()): string | null {
  if (!path) return null;
  let days: number;
  try {
    days = certificateDaysLeft(path, now);
  } catch (err) {
    return `ROLES_ANYWHERE_CERTIFICATE (${path}) could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (days < 0)
    return `The Roles Anywhere certificate expired ${-days} days ago; AWS will refuse every session until it is renewed.`;
  if (days <= WARN_DAYS)
    return `The Roles Anywhere certificate expires in ${days} days. Renew it with scripts/roles-anywhere-ca.sh.`;
  return null;
}

export function watchCertificate(log: { warn: (msg: string) => void }): void {
  const check = () => {
    const warning = certificateWarning(cfg.ROLES_ANYWHERE_CERTIFICATE);
    if (warning) log.warn(warning);
  };
  check();
  setInterval(check, 12 * 60 * 60 * 1000).unref();
}
