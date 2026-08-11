import { redirect } from "next/navigation";
import LoginForm from "@/components/LoginForm";
import { readSession } from "@/server/http/context";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await readSession()) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <LoginForm />
    </main>
  );
}
