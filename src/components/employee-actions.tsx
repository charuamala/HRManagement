"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert, Button, Field, Input, Modal } from "@/components/ui";

export type EmployeeAction = "deactivate" | "reactivate" | "delete";

/** Confirmation dialogs for deactivate (soft delete), reactivate and permanent delete. */
export function EmployeeActionDialog({
  action,
  employee,
  today,
  onClose,
  onDone,
}: {
  action: EmployeeAction | null;
  employee: { id: string; fullName: string; employeeCode: string } | null;
  today: string;
  onClose: () => void;
  onDone: (action: EmployeeAction) => void;
}) {
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!action || !employee) return null;

  const close = () => {
    setReason("");
    setError(null);
    onClose();
  };

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      if (action === "delete") await api("DELETE", `/api/employees/${employee!.id}`, { reason });
      else await api("POST", `/api/employees/${employee!.id}/status`, { active: action === "reactivate", date: action === "deactivate" ? date : undefined, reason: reason || undefined });
      setReason("");
      onDone(action!);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const titles = { deactivate: "Deactivate employee", reactivate: "Reactivate employee", delete: "Delete employee permanently" };
  return (
    <Modal
      open
      title={titles[action]}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant={action === "reactivate" ? "primary" : "danger"} onClick={confirm} loading={busy} disabled={action === "delete" && reason.trim().length < 3}>
            {action === "deactivate" ? "Deactivate" : action === "reactivate" ? "Reactivate" : "Delete permanently"}
          </Button>
        </>
      }
    >
      <p>
        <strong>{employee.fullName}</strong> ({employee.employeeCode})
      </p>
      {action === "deactivate" && (
        <>
          <p className="text-slate-600">Attendance history is kept. The login is disabled and the employee is excluded from attendance after the exit date.</p>
          <Field label="Exit date" htmlFor="exitDate">
            <Input id="exitDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </>
      )}
      {action === "reactivate" && <p className="text-slate-600">The employee becomes active again and their login (if any) is re-enabled.</p>}
      {action === "delete" && (
        <Alert tone="warn">Only use this for records created by mistake. Employees with any attendance history cannot be deleted — deactivate them instead.</Alert>
      )}
      <Field label={action === "delete" ? "Reason *" : "Reason (optional)"} htmlFor="reason">
        <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recorded in the audit log" />
      </Field>
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}
