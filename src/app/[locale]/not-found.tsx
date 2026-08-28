import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function NotFound() {
  const t = await getTranslations("notFound");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-3 p-6">
      <h1 className="text-sm font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted">{t("description")}</p>
      <Link href="/" className="btn self-start">
        {t("back")}
      </Link>
    </main>
  );
}
