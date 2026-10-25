import { col, transaction } from "../db";
import type { EmployeePhoto, ID } from "@/lib/types";
import { badRequest, forbidden, notFound } from "../errors";
import { actorOf, assertCanView, can, canManage, type AuthContext } from "../auth/context";
import { audit } from "./audit";
import { nowIso, stamp } from "../util";

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Identify the real image type from magic bytes — the client's MIME type is not trusted. SVG is never accepted. */
export function sniffImage(b: Buffer): EmployeePhoto["contentType"] | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function assertCanChange(ctx: AuthContext, employeeId: ID) {
  const self = ctx.scope.selfId === employeeId;
  if (!self && !(can(ctx, "employees.edit") && canManage(ctx, employeeId))) throw forbidden("You cannot change this employee's photo");
}

export async function setPhoto(ctx: AuthContext, employeeId: ID, bytes: Buffer) {
  assertCanChange(ctx, employeeId);
  if (!bytes.length) throw badRequest("The file is empty");
  if (bytes.length > MAX_PHOTO_BYTES) throw badRequest("Photo must be 2 MB or smaller");
  const contentType = sniffImage(bytes);
  if (!contentType) throw badRequest("Upload a JPEG, PNG or WebP image");
  const employees = await col("employees");
  const emp = await employees.findById(employeeId);
  if (!emp) throw notFound("Employee");
  const photos = await col("employee_photos");
  return transaction(async () => {
    const photo = await photos.insertOne({ ...stamp(), employeeId, contentType, size: bytes.length, data: bytes.toString("base64"), uploadedBy: ctx.user.id });
    await photos.deleteMany({ employeeId, id: { $ne: photo.id } });
    await employees.updateById(employeeId, { photoId: photo.id, updatedAt: nowIso() });
    await audit(actorOf(ctx), { action: emp.photoId ? "photo_replaced" : "photo_added", module: "employees", recordId: employeeId, newValues: { photoId: photo.id, contentType, size: bytes.length } });
    return { photoId: photo.id };
  });
}

export async function removePhoto(ctx: AuthContext, employeeId: ID) {
  assertCanChange(ctx, employeeId);
  const employees = await col("employees");
  const emp = await employees.findById(employeeId);
  if (!emp) throw notFound("Employee");
  if (!emp.photoId) return { photoId: null };
  await transaction(async () => {
    await (await col("employee_photos")).deleteMany({ employeeId });
    await employees.updateById(employeeId, { photoId: null, updatedAt: nowIso() });
    await audit(actorOf(ctx), { action: "photo_removed", module: "employees", recordId: employeeId });
  });
  return { photoId: null };
}

export async function getPhoto(ctx: AuthContext, employeeId: ID): Promise<EmployeePhoto> {
  if (ctx.scope.selfId !== employeeId) assertCanView(ctx, employeeId);
  const emp = await (await col("employees")).findById(employeeId);
  if (!emp?.photoId) throw notFound("Photo");
  const photo = await (await col("employee_photos")).findById(emp.photoId);
  if (!photo) throw notFound("Photo");
  return photo;
}
