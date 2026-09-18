import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { THEME_COOKIE, isTheme } from "@/lib/theme";
import type { Metadata } from "next";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "meta" });
  return { title: t("title"), description: t("description") };
}

export default async function RootLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;

  // An unknown locale in the URL must give a 404, not an empty dictionary.
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  // The theme is rendered server-side from its cookie so the first paint is
  // already correct. The pages are `force-dynamic` anyway: no extra cost.
  const requestedTheme = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isTheme(requestedTheme) ? requestedTheme : "dark";

  return (
    <html lang={locale} data-theme={theme} className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        {/* Sans enfant explicite, le provider transmet tous les messages : le
            panneau est presque entièrement composé de composants clients. */}
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
