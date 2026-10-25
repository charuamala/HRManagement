"use client";
import { useRef, useState } from "react";
import clsx from "clsx";
import { Camera, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { Alert, Button } from "@/components/ui";

export function photoUrl(employeeId: string, photoId: string | null | undefined) {
  return photoId ? `/api/employees/${employeeId}/photo?v=${photoId}` : null;
}

function initials(name: string) {
  return name
    .replace(/^(mr|ms|mrs|dr)\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

/** Profile photo, falling back to initials. */
export function Avatar({ employeeId, photoId, name, size = 32, className }: { employeeId: string; photoId?: string | null; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = photoUrl(employeeId, photoId);
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.36) };
  if (src && !failed) {
    // eslint-disable-next-line @next/next/no-img-element -- authenticated API image, not a static asset
    return <img src={src} alt={`Photo of ${name}`} style={style} onError={() => setFailed(true)} className={clsx("shrink-0 rounded-full object-cover ring-1 ring-slate-200", className)} />;
  }
  return (
    <span aria-hidden style={style} className={clsx("inline-flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700", className)}>
      {initials(name) || "?"}
    </span>
  );
}

/** Downscale to at most `max` px on the long side and re-encode as JPEG (strips EXIF, keeps uploads small). */
export async function resizeImage(file: File, max = 512, quality = 0.85): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Choose a JPEG, PNG or WebP image");
  if (file.size > 15 * 1024 * 1024) throw new Error("Image is too large (max 15 MB before resizing)");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not process image"))), "image/jpeg", quality));
}

export async function uploadPhoto(employeeId: string, blob: Blob): Promise<string> {
  const fd = new FormData();
  fd.append("file", blob, "photo.jpg");
  const res = await fetch(`/api/employees/${employeeId}/photo`, { method: "POST", body: fd, credentials: "same-origin" });
  const json = await res.json().catch(() => null);
  if (!json?.ok) throw new ApiError(res.status, json?.error?.code ?? "ERROR", json?.error?.message ?? "Upload failed", null);
  return json.data.photoId as string;
}

/** Shows the current photo with Upload / Change / Remove controls. */
export function PhotoManager({ employeeId, photoId, name, canChange, onChange }: { employeeId: string; photoId: string | null; name: string; canChange: boolean; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadPhoto(employeeId, await resizeImage(file));
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/employees/${employeeId}/photo`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? "Could not remove photo");
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <Avatar employeeId={employeeId} photoId={photoId} name={name} size={72} />
      {canChange && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-2">
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => pick(e.target.files?.[0])} aria-label="Choose profile photo" />
            <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => input.current?.click()}>
              <Camera className="h-4 w-4" /> {photoId ? "Change photo" : "Upload photo"}
            </Button>
            {photoId && (
              <Button type="button" size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" disabled={busy} onClick={remove}>
                <Trash2 className="h-4 w-4" /> Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400">JPEG, PNG or WebP · resized to 512 px</p>
          {error && <Alert>{error}</Alert>}
        </div>
      )}
    </div>
  );
}

/** Photo chooser for the create form (uploaded after the employee is saved). */
export function PhotoPicker({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const preview = file ? URL.createObjectURL(file) : null;
  return (
    <div className="flex items-center gap-4">
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
        <img src={preview} alt="Selected photo preview" className="h-[72px] w-[72px] rounded-full object-cover ring-1 ring-slate-200" onLoad={() => URL.revokeObjectURL(preview)} />
      ) : (
        <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <Camera className="h-6 w-6" aria-hidden />
        </span>
      )}
      <div className="flex gap-2">
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} aria-label="Choose profile photo" />
        <Button type="button" size="sm" variant="secondary" onClick={() => input.current?.click()}>
          <Camera className="h-4 w-4" /> {file ? "Change" : "Choose photo"}
        </Button>
        {file && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onFile(null)}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
