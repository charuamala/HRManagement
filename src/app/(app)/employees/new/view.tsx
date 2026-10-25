"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { EmployeeForm, emptyEmployee } from "@/components/employee-form";
import { Alert, Button, Card, PageHeader } from "@/components/ui";

export function NewEmployee({ today, isAdmin }: { today: string; isAdmin: boolean }) {
  const router = useRouter();
  const [created, setCreated] = useState<{ id: string; inviteLink?: string | null } | null>(null);
  const [formKey, setFormKey] = useState(0);

  return (
    <div>
      <Link href="/employees" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Employees
      </Link>
      <PageHeader title="Add Employee" subtitle="Fields marked * are required" />
      {created ? (
        <Card>
          <div className="space-y-3">
            <Alert tone="success">Employee created.</Alert>
            {created.inviteLink && (
              <div className="text-sm">
                <p className="text-slate-600">Login invitation link (valid 72 hours) — share it with the employee so they can set a password:</p>
                <code className="mt-1 block break-all rounded bg-slate-100 p-2 text-xs">{created.inviteLink}</code>
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={() => router.push(`/employees/${created.id}`)}>View employee</Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setCreated(null);
                  setFormKey((k) => k + 1);
                }}
              >
                Add another
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <EmployeeForm key={formKey} mode="create" initial={emptyEmployee(today)} isAdmin={isAdmin} onCancel={() => router.push("/employees")} onSaved={setCreated} />
      )}
    </div>
  );
}
