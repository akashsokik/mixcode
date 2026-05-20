import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

export function shortPath(p: string): string {
  if (!p) return "";
  if (p === HOME) return "~";
  if (p.startsWith(HOME + path.sep)) return "~" + p.slice(HOME.length);
  return p;
}

export function basename(p: string): string {
  if (!p) return "";
  return path.basename(p) || p;
}
