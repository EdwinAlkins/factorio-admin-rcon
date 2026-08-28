import { createNavigation } from "next-intl/navigation";
import { routing } from "@/i18n/routing";

/**
 * Locale-aware replacements for `next/link` and `next/navigation`: they
 * preserve the language prefix, which Next's own helpers ignore.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
