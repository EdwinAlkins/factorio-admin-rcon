import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import LoginForm from "@/components/LoginForm";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { readSession } from "@/server/http/context";

export const dynamic = "force-dynamic";

export default async function LoginPage({ params }: PageProps<"/[locale]/login">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  if (await readSession()) redirect({ href: "/", locale });

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <LoginForm />
    </main>
  );
}
