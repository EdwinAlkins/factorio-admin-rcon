import { useTranslations } from "next-intl";
import logo from "@/assets/logo.png";

/** The panel's name with its emblem: the header and the sign-in form. */
export default function Brand() {
  const t = useTranslations("app");
  return (
    <h1 className="flex items-center gap-2 text-base font-semibold">
      {/* eslint-disable-next-line @next/next/no-img-element -- a 128 px file shown at 32 px: nothing to optimise */}
      <img src={logo.src} alt="" width={32} height={32} className="size-8 shrink-0" />
      <span>
        {t("brand")} <span className="text-accent">{t("brandSuffix")}</span>
      </span>
    </h1>
  );
}
