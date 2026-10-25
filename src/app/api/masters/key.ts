import { notFound } from "@/server/errors";
import { isMasterKey, type MasterKey } from "@/lib/masters";

export function masterKey(k: string): MasterKey {
  if (!isMasterKey(k)) throw notFound("Master");
  return k;
}
